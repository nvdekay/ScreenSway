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

pub fn with_source_audio(
    video: &Path,
    source: &Path,
    output: &Path,
    ranges: &[(i64, i64)],
    lead_in: i64,
) -> Result<(), String> {
    let audio = reader::open(source, false)?;
    // A recording made with both audio switches off is a normal silent export.
    let has_audio = unsafe { audio.GetNativeMediaType(reader::AUDIO, 0) }.is_ok();
    if !has_audio {
        std::fs::copy(video, output).map_err(|e| e.to_string())?;
        return Ok(());
    }
    reader::select(&audio, reader::AUDIO)?;
    let pcm = pcm_type(48_000, 2, 16, false)?;
    unsafe {
        audio
            .SetCurrentMediaType(reader::AUDIO, None, &pcm)
            .step("Decoding audio for export")?;
    }
    let v = reader::open(video, false)?;
    reader::select(&v, reader::VIDEO)?;
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
            writer.WriteSample(aus, &sample(&vec![0u8; frames * 4], silent, length)?).step("Writing silence")?;
            silent += length;
        }
        let mut vp = reader::next(&v, reader::VIDEO)?;
        let mut range_index = 0usize;
        let mut range_started = false;
        let mut audio_offset = lead_in;
        let mut ap = next_audio_ranges(&audio, ranges, &mut range_index, &mut range_started, &mut audio_offset)?;
        while vp.is_some() || ap.is_some() {
            if vp
                .as_ref()
                .is_some_and(|(_, t)| ap.as_ref().is_none_or(|(_, at)| t <= at))
            {
                let (s, _) = vp.take().unwrap();
                writer.WriteSample(vs, &s).step("Writing exported video")?;
                vp = reader::next(&v, reader::VIDEO)?;
            } else {
                let (s, _) = ap.take().unwrap();
                writer.WriteSample(aus, &s).step("Writing exported audio")?;
                ap = next_audio_ranges(&audio, ranges, &mut range_index, &mut range_started, &mut audio_offset)?;
            }
        }
        writer.Finalize().step("Finalizing MP4 with audio")?;
    }
    Ok(())
}

fn next_audio_ranges(
    reader: &IMFSourceReader,
    ranges: &[(i64, i64)],
    index: &mut usize,
    started: &mut bool,
    output_offset: &mut i64,
) -> Result<Option<(IMFSample, i64)>, String> {
    loop {
        let Some(&(start, end)) = ranges.get(*index) else { return Ok(None) };
        if !*started {
            reader::seek(reader, start)?;
            *started = true;
        }
        if let Some((sample, relative_time)) = next_audio(reader, start, end - start)? {
            let output_time = *output_offset + relative_time;
            unsafe { sample.SetSampleTime(output_time).step("Retiming edited audio")?; }
            return Ok(Some((sample, output_time)));
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
) -> Result<Option<(IMFSample, i64)>, String> {
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
        return Ok(Some((sample(&raw[first * 4..end * 4], time, len)?, time)));
    }
    Ok(None)
}
