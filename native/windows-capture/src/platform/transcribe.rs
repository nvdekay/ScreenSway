//! Offline EN/VI transcription. The bundled multilingual Whisper model never uses a network.
use super::{mux, reader, Step};
use crate::argument;
use serde::Serialize;
use std::path::{Path, PathBuf};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Word {
    text: String,
    start_ms: i64,
    end_ms: i64,
}
#[derive(Serialize)]
pub struct Transcript {
    locale: String,
    words: Vec<Word>,
}

fn model_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("SCREENSWAY_WHISPER_MODEL") {
        return Ok(path.into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = exe.parent().ok_or("Cannot locate the speech model")?;
    let candidates = [
        directory.join("models/ggml-large-v3-turbo-q5_0.bin"),
        directory.join("../resources/models/ggml-large-v3-turbo-q5_0.bin"),
        directory.join(
            "../../../../apps/desktop/src-tauri/resources/models/ggml-large-v3-turbo-q5_0.bin",
        ),
    ];
    candidates.into_iter().find(|p|p.is_file()).ok_or_else(||"The bundled speech model is missing. Reinstall ScreenSway or run pnpm setup:windows-speech for a development build.".into())
}

pub fn run(arguments: &[String]) -> Result<Transcript, String> {
    #[cfg(target_arch = "x86_64")]
    if !(std::is_x86_feature_detected!("avx2")
        && std::is_x86_feature_detected!("fma")
        && std::is_x86_feature_detected!("f16c")
        && std::is_x86_feature_detected!("bmi2"))
    {
        return Err("This processor does not support the AVX2 offline speech backend.".into());
    }
    let video = Path::new(argument(arguments, "--transcribe").ok_or("Missing recording")?);
    let output = Path::new(argument(arguments, "--output").ok_or("Missing transcript output")?);
    let locale = argument(arguments, "--locale").unwrap_or("en-US");
    let language = match locale {
        "en" | "en-US" | "en-GB" => "en",
        "vi" | "vi-VN" => "vi",
        _ => return Err("Captions support Vietnamese and English.".into()),
    };
    let reader = reader::open(video, false)?;
    reader::select(&reader, reader::AUDIO)
        .map_err(|_| "This recording has no audio to transcribe.")?;
    let ty = mux::pcm_type(16_000, 1, 32, true)?;
    unsafe {
        reader
            .SetCurrentMediaType(reader::AUDIO, None, &ty)
            .step("Decoding speech audio")?;
    }
    let mut params = WhisperContextParameters::default();
    params.use_gpu(false);
    // Fused attention avoids materializing the full attention matrix. Ordinary
    // token timestamps remain available (we do not enable DTW alignment).
    params.flash_attn(true);
    let ctx = WhisperContext::new_with_params(
        model_path()?
            .to_str()
            .ok_or("Speech model path is invalid")?,
        params,
    )
    .map_err(|e| e.to_string())?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let duration = unsafe {
        reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
    }
    .ok()
    .and_then(|v| u64::try_from(&v).ok())
    .unwrap_or(0)
        / 10_000;
    let mut result = Transcript {
        locale: locale.into(),
        words: Vec::new(),
    };
    let mut pending = Vec::<f32>::new();
    let mut origin = None;
    let mut pending_start = 0i64;
    let mut consumed = 0usize;
    eprintln!("SCREENSWAY_PROGRESS 0");
    while let Some((sample, time)) = reader::next(&reader, reader::AUDIO)? {
        let start = *origin.get_or_insert(time / 10_000);
        if pending.is_empty() {
            pending_start = start + consumed as i64 * 1000 / 16_000;
        }
        let bytes = reader::bytes(&sample)?;
        pending.extend(
            bytes
                .chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap())),
        );
        // Chunks are bounded at 30 s; choose a quiet 100 ms boundary between 20 and 30 s.
        while pending.len() >= 480_000 {
            let cut = quiet_cut(&pending);
            recognize(
                &ctx,
                &mut state,
                &pending[..cut],
                pending_start,
                language,
                &mut result.words,
            )?;
            pending.drain(..cut);
            consumed += cut;
            pending_start = start + consumed as i64 * 1000 / 16_000;
            if duration > 0 {
                eprintln!(
                    "SCREENSWAY_PROGRESS {}",
                    (pending_start.max(0) as u64 * 95 / duration).min(95)
                );
            }
        }
    }
    if !pending.is_empty() {
        recognize(
            &ctx,
            &mut state,
            &pending,
            pending_start,
            language,
            &mut result.words,
        )?;
    }
    result.words.sort_by_key(|w| w.start_ms);
    let temporary = output.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, output).map_err(|e| e.to_string())?;
    eprintln!("SCREENSWAY_PROGRESS 100");
    Ok(result)
}

use windows::Win32::Media::MediaFoundation::{MF_PD_DURATION, MF_SOURCE_READER_MEDIASOURCE};

fn quiet_cut(samples: &[f32]) -> usize {
    (320_000..480_000)
        .step_by(1600)
        .min_by(|&a, &b| {
            let energy = |start: usize| {
                samples[start..start + 1600]
                    .iter()
                    .map(|s| s * s)
                    .sum::<f32>()
            };
            energy(a).total_cmp(&energy(b))
        })
        .unwrap_or(480_000)
}

fn recognize(
    ctx: &WhisperContext,
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    offset: i64,
    language: &str,
    words: &mut Vec<Word>,
) -> Result<(), String> {
    let energy = samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32;
    if energy < 1e-5 {
        return Ok(());
    }
    let mut p = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: -1.0,
    });
    p.set_language(Some(language));
    p.set_translate(false);
    p.set_no_context(true);
    p.set_n_threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8)) as i32);
    p.set_token_timestamps(true);
    p.set_split_on_word(true);
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    // Quiet laptop microphones and imported recordings need comparable input levels.
    // Limit both the boost and the peak; leave silent chunks out before normalization.
    let peak = samples.iter().copied().map(f32::abs).fold(0.0, f32::max);
    let gain = (0.1 / energy.sqrt())
        .min(0.95 / peak.max(1e-9))
        .clamp(0.25, 4.0);
    let normalized: Vec<f32> = samples.iter().map(|s| s * gain).collect();
    state.full(p, &normalized).map_err(|e| e.to_string())?;
    let end = offset + samples.len() as i64 * 1000 / 16_000;
    for segment in state.as_iter() {
        if segment.no_speech_probability() > 0.6 {
            continue;
        }
        // Merge bytes before decoding UTF-8: Vietnamese characters can span BPE tokens.
        let mut text = Vec::<u8>::new();
        let mut first = None;
        let mut last = 0;
        let flush =
            |text: &mut Vec<u8>, first: &mut Option<i64>, last: i64, words: &mut Vec<Word>| {
                if text.is_empty() {
                    return;
                }
                let value = String::from_utf8_lossy(text).trim().to_owned();
                text.clear();
                let start = offset + first.take().unwrap_or(0) * 10;
                if !value.is_empty() {
                    let finish = (offset + last * 10).max(start + 10).min(end);
                    if start < finish {
                        words.push(Word {
                            text: value,
                            start_ms: start.max(offset),
                            end_ms: finish,
                        });
                    }
                }
            };
        for i in 0..segment.n_tokens() {
            let token = segment.get_token(i).unwrap();
            if token.token_id() >= ctx.token_eot() {
                continue;
            }
            let bytes = token.to_bytes().map_err(|e| e.to_string())?;
            let data = token.token_data();
            if bytes.first().is_some_and(u8::is_ascii_whitespace) {
                flush(&mut text, &mut first, last, words);
            }
            first.get_or_insert(data.t0.max(segment.start_timestamp()));
            last = data.t1.max(data.t0).min(segment.end_timestamp());
            text.extend_from_slice(bytes);
        }
        flush(&mut text, &mut first, last, words);
    }
    Ok(())
}
