//! Decodes the background music file for the exporter's mixer (crate::music).
use super::{reader, Step};
use crate::music::{Source, RATE};
use std::path::Path;
use windows::Win32::Media::MediaFoundation::*;

pub struct File {
    reader: IMFSourceReader,
    rate: u32,
}

impl File {
    /// Opens `path` decoding to 16-bit stereo PCM; the file keeps its own sample rate, which
    /// the mixer converts, since Media Foundation's reader does not resample audio.
    pub fn open(path: &Path) -> Result<Self, String> {
        let unreadable = |_| "This music file could not be read. Try an MP3, M4A or WAV file.".to_string();
        let reader = reader::open(path, false).map_err(unreadable)?;
        reader::select(&reader, reader::AUDIO).map_err(unreadable)?;
        let rate = unsafe {
            let wanted = MFCreateMediaType().step("Describing the music")?;
            wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).step("Describing the music")?;
            wanted.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).step("Describing the music")?;
            wanted.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).step("Describing the music")?;
            wanted.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).step("Describing the music")?;
            reader
                .SetCurrentMediaType(reader::AUDIO, None, &wanted)
                .map_err(|error| format!("This music file could not be decoded: {} (0x{:08X})", error.message(), error.code().0 as u32))?;
            let current = reader.GetCurrentMediaType(reader::AUDIO).step("Reading the music's format")?;
            current.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(RATE)
        };
        Ok(Self { reader, rate })
    }
}

impl Source for File {
    fn rate(&self) -> u32 {
        self.rate
    }

    fn read(&mut self) -> Result<Option<Vec<i16>>, String> {
        let Some((sample, _)) = reader::next(&self.reader, reader::AUDIO)? else { return Ok(None) };
        let bytes = reader::bytes(&sample)?;
        Ok(Some(bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect()))
    }

    fn restart(&mut self) -> Result<(), String> {
        reader::seek(&self.reader, 0)
    }
}
