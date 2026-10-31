//! H.264 passthrough and sample-accurate trimmed AAC audio in a single playable MP4.
use super::{reader, Step};
use std::path::Path;
use windows::Win32::Media::MediaFoundation::*;

pub fn pcm_type(rate: u32, channels: u32, bits: u32, float: bool) -> Result<IMFMediaType, String> {
    unsafe {
        let t = MFCreateMediaType().step("Creating audio format")?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .step("Creating audio format")?;
        t.SetGUID(
            &MF_MT_SUBTYPE,
            if float {
                &MFAudioFormat_Float
            } else {
                &MFAudioFormat_PCM
            },
        )
        .step("Creating audio format")?;
        t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)
            .step("Creating audio format")?;
        t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)
            .step("Creating audio format")?;
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, bits)
            .step("Creating audio format")?;
        t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, channels * bits / 8)
            .step("Creating audio format")?;
        t.SetUINT32(
            &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
            rate * channels * bits / 8,
        )
        .step("Creating audio format")?;
        Ok(t)
    }
}

pub fn sample(data: &[u8], time: i64, duration: i64) -> Result<IMFSample, String> {
    unsafe {
        let b = MFCreateMemoryBuffer(data.len() as u32).step("Allocating audio sample")?;
        let mut ptr = std::ptr::null_mut();
        b.Lock(&mut ptr, None, None).step("Writing audio sample")?;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        b.Unlock().step("Writing audio sample")?;
        b.SetCurrentLength(data.len() as u32)
            .step("Writing audio sample")?;
        let s = MFCreateSample().step("Creating audio sample")?;
        s.AddBuffer(&b).step("Creating audio sample")?;
        s.SetSampleTime(time).step("Setting audio time")?;
        s.SetSampleDuration(duration)
            .step("Setting audio duration")?;
        Ok(s)
    }
}

/// A kept part of the recording's sound, in 100 ns ticks. A part played faster or slower
/// (`rate` other than 1) becomes silence as long as it lasts in the finished video.
pub struct AudioRange {
    pub start: i64,
    pub end: i64,
    pub rate: f64,
    /// Silence instead of the recording's sound, for a recording without any.
    pub mute: bool,
}

/// Music to mix under the whole video (from the export job).
pub struct Music<'a> {
    pub path: &'a Path,
    pub volume: f64,
    pub looped: bool,
}

/// Decoded 16-bit stereo sound at 48 kHz and where it goes, in 100 ns ticks.
struct Chunk {
    data: Vec<u8>,
    time: i64,
    duration: i64,
}

impl AudioRange {
    fn silent(&self) -> bool {
        self.mute || self.rate != 1.0
    }

    fn output_length(&self) -> i64 {
        ((self.end - self.start) as f64 / self.rate).round() as i64
    }
}

pub fn with_source_audio(
    video: &Path,
    source: &Path,
    output: &Path,
    ranges: &[AudioRange],
    lead_in: i64,
    music: Option<Music>,
    progress: &mut dyn FnMut(),
) -> Result<(), String> {
    let audio = reader::open(source, false)?;
    // A recording made with both audio switches off is a normal silent export, unless music
    // plays under it.
    let has_audio = unsafe { audio.GetNativeMediaType(reader::AUDIO, 0) }.is_ok();
    if !has_audio && music.is_none() {
        std::fs::copy(video, output).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let pcm = pcm_type(48_000, 2, 16, false)?;
    if has_audio {
        reader::select(&audio, reader::AUDIO)?;
        unsafe {
            audio
                .SetCurrentMediaType(reader::AUDIO, None, &pcm)
                .step("Decoding audio for export")?;
        }
    }
    // Without sound of its own, every kept part is silence under the music.
    let silent_ranges: Vec<AudioRange>;
    let ranges = if has_audio {
        ranges
    } else {
        silent_ranges = ranges.iter().map(|range| AudioRange { mute: true, ..*range }).collect();
        &silent_ranges
    };
    let mut mixer = match &music {
        Some(music) => Some(crate::music::Mixer::new(super::music::File::open(music.path)?, music.volume, music.looped)),
        None => None,
    };
    let v = reader::open(video, false)?;
    reader::select(&v, reader::VIDEO)?;
    let video_length = reader::duration(&v)?;
    let total_frames = video_length as i128 * 48_000 / 10_000_000;
    // Adds the music to a chunk and makes the sample the AAC encoder takes.
    let mut finish = |chunk: Chunk| -> Result<IMFSample, String> {
        let mut data = chunk.data;
        if let Some(mixer) = mixer.as_mut() {
            let mut samples: Vec<i16> = data.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect();
            mixer.mix(&mut samples, (chunk.time as i128 * 48_000 / 10_000_000) as i64, total_frames as i64)?;
            data = samples.iter().flat_map(|sample| sample.to_le_bytes()).collect();
        }
        sample(&data, chunk.time, chunk.duration)
    };
    unsafe {
        let vt = v
            .GetNativeMediaType(reader::VIDEO, 0)
            .step("Reading encoded video format")?;
        let writer = MFCreateSinkWriterFromURL(&super::media_path(output), None, None)
            .step("Creating MP4 with audio")?;
        let vs = writer.AddStream(&vt).step("Adding exported video")?;
        writer
            .SetInputMediaType(vs, &vt, None)
            .step("Copying encoded video")?;
        let aac = MFCreateMediaType().step("Creating AAC format")?;
        aac.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .step("Creating AAC format")?;
        aac.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
            .step("Creating AAC format")?;
        aac.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)
            .step("Creating AAC format")?;
        aac.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48_000)
            .step("Creating AAC format")?;
        aac.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .step("Creating AAC format")?;
        aac.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)
            .step("Creating AAC format")?;
        let aus = writer.AddStream(&aac).step("Adding AAC audio")?;
        writer
            .SetInputMediaType(aus, &pcm, None)
            .step("Encoding AAC audio")?;
        writer.BeginWriting().step("Starting MP4 muxer")?;
        // Real silence under an intro card: a track whose first sample is late may be
        // played from zero by some players.
        let mut silent = 0i64;
        while silent < lead_in {
            let length = (lead_in - silent).min(1_000_000);
            let frames = (length as i128 * 48_000 / 10_000_000) as usize;
            if frames == 0 {
                break;
            }
            let duration = frames as i64 * 10_000_000 / 48_000;
            writer.WriteSample(aus, &finish(Chunk { data: vec![0u8; frames * 4], time: silent, duration })?).step("Writing silence")?;
            silent += duration;
        }
        let mut vp = reader::next(&v, reader::VIDEO)?;
        let mut range_index = 0usize;
        let mut range_started = false;
        let mut audio_offset = lead_in;
        let mut silence_written = 0i64;
        let mut ap = next_audio_ranges(&audio, ranges, &mut range_index, &mut range_started, &mut audio_offset, &mut silence_written)?;
        // The music plays to the end of the video, past the recording's own sound.
        let mut tail = if music.is_some() { audio_offset } else { video_length };
        while vp.is_some() || ap.is_some() {
            progress();
            if ap.is_none() && tail < video_length {
                let length = (video_length - tail).min(1_000_000);
                let frames = (length as i128 * 48_000 / 10_000_000) as usize;
                if frames > 0 {
                    let duration = frames as i64 * 10_000_000 / 48_000;
                    ap = Some(Chunk { data: vec![0u8; frames * 4], time: tail, duration });
                    tail += duration;
                } else {
                    tail = video_length;
                }
            }
            if vp
                .as_ref()
                .is_some_and(|(_, t)| ap.as_ref().is_none_or(|chunk| *t <= chunk.time))
            {
                let (s, _) = vp.take().unwrap();
                writer.WriteSample(vs, &s).step("Writing exported video")?;
                vp = reader::next(&v, reader::VIDEO)?;
            } else if let Some(chunk) = ap.take() {
                tail = tail.max(chunk.time + chunk.duration);
                writer.WriteSample(aus, &finish(chunk)?).step("Writing exported audio")?;
                ap = next_audio_ranges(&audio, ranges, &mut range_index, &mut range_started, &mut audio_offset, &mut silence_written)?;
            }
        }
        writer.Finalize().step("Finalizing MP4 with audio")?;
    }
    Ok(())
}

fn next_audio_ranges(
    reader: &IMFSourceReader,
    ranges: &[AudioRange],
    index: &mut usize,
    started: &mut bool,
    output_offset: &mut i64,
    silence_written: &mut i64,
) -> Result<Option<Chunk>, String> {
    loop {
        let Some(range) = ranges.get(*index) else { return Ok(None) };
        let (start, end) = (range.start, range.end);
        if range.silent() {
            // Silence in chunks of at most 0.1 s, so the muxer interleaves it with the video.
            let length = (range.output_length() - *silence_written).min(1_000_000);
            let frames = (length as i128 * 48_000 / 10_000_000) as usize;
            if frames > 0 {
                let time = *output_offset + *silence_written;
                let duration = frames as i64 * 10_000_000 / 48_000;
                *silence_written += duration;
                return Ok(Some(Chunk { data: vec![0u8; frames * 4], time, duration }));
            }
            *output_offset += range.output_length();
            *silence_written = 0;
            *index += 1;
            continue;
        }
        if !*started {
            reader::seek(reader, start)?;
            *started = true;
        }
        if let Some(mut chunk) = next_audio(reader, start, end - start)? {
            chunk.time += *output_offset;
            return Ok(Some(chunk));
        }
        *output_offset += end - start;
        *index += 1;
        *started = false;
    }
}

fn next_audio(
    reader: &IMFSourceReader,
    start: i64,
    duration: i64,
) -> Result<Option<Chunk>, String> {
    while let Some((s, t)) = reader::next(reader, reader::AUDIO)? {
        let raw = reader::bytes(&s)?;
        let count = raw.len() / 4;
        let first = (((start - t).max(0) as i128 * 48_000 + 9_999_999) / 10_000_000) as usize;
        if t >= start + duration {
            return Ok(None);
        }
        let last = ((((start + duration - t).max(0) as i128) * 48_000) / 10_000_000) as usize;
        let end = count.min(last);
        if first >= end {
            continue;
        }
        let time = (t + first as i64 * 10_000_000 / 48_000 - start).max(0);
        let len = (end - first) as i64 * 10_000_000 / 48_000;
        return Ok(Some(Chunk { data: raw[first * 4..end * 4].to_vec(), time, duration: len }));
    }
    Ok(None)
}
