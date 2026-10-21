//! Synchronous Media Foundation decoding. VFR frames retain their original timestamps.
use super::Step;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

pub const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
pub const AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

pub fn open(path: &std::path::Path, processing: bool) -> Result<IMFSourceReader, String> {
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).step("Starting the media decoder")?;
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 1).step("Creating decoder attributes")?;
        let attrs = attrs.unwrap();
        if processing {
            attrs
                .SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)
                .step("Enabling video decoding")?;
        }
        MFCreateSourceReaderFromURL(&super::media_path(path), &attrs)
            .step("Opening the recorded media")
    }
}

pub fn select(reader: &IMFSourceReader, stream: u32) -> Result<(), String> {
    unsafe {
        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .step("Selecting media stream")?;
        reader
            .SetStreamSelection(stream, true)
            .step("Selecting media stream")
    }
}

pub fn seek(reader: &IMFSourceReader, ticks: i64) -> Result<(), String> {
    unsafe {
        reader
            .SetCurrentPosition(&windows::core::GUID::zeroed(), &PROPVARIANT::from(ticks))
            .step("Seeking the recorded media")
    }
}

pub fn next(reader: &IMFSourceReader, stream: u32) -> Result<Option<(IMFSample, i64)>, String> {
    loop {
        let mut flags = 0;
        let mut time = 0;
        let mut sample = None;
        unsafe {
            reader
                .ReadSample(
                    stream,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut time),
                    Some(&mut sample),
                )
                .step("Decoding the recorded media")?;
        }
        if let Some(sample) = sample {
            return Ok(Some((sample, time)));
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            return Ok(None);
        }
        if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
            return Err("The media decoder reported an error.".into());
        }
    }
}

pub fn bytes(sample: &IMFSample) -> Result<Vec<u8>, String> {
    unsafe {
        let buffer = sample
            .ConvertToContiguousBuffer()
            .step("Reading decoded samples")?;
        let mut pointer = std::ptr::null_mut();
        let mut length = 0;
        buffer
            .Lock(&mut pointer, None, Some(&mut length))
            .step("Reading decoded samples")?;
        let result = std::slice::from_raw_parts(pointer, length as usize).to_vec();
        buffer.Unlock().step("Releasing decoded samples")?;
        Ok(result)
    }
}

pub struct VideoReader {
    reader: IMFSourceReader,
    pub width: u32,
    pub height: u32,
    stride: i32,
    current: Option<image::RgbaImage>,
    pending: Option<(IMFSample, i64)>,
}

impl VideoReader {
    pub fn new(path: &std::path::Path, start: i64) -> Result<Self, String> {
        let reader = open(path, true)?;
        select(&reader, VIDEO)?;
        unsafe {
            let ty = MFCreateMediaType().step("Describing decoded frames")?;
            ty.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .step("Describing decoded frames")?;
            ty.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
                .step("Describing decoded frames")?;
            reader
                .SetCurrentMediaType(VIDEO, None, &ty)
                .step("Decoding frames as RGB")?;
            let ty = reader
                .GetCurrentMediaType(VIDEO)
                .step("Reading decoded video size")?;
            let size = ty
                .GetUINT64(&MF_MT_FRAME_SIZE)
                .step("Reading decoded video size")?;
            let (width, height) = ((size >> 32) as u32, size as u32);
            let stride = ty
                .GetUINT32(&MF_MT_DEFAULT_STRIDE)
                .map(|v| v as i32)
                .unwrap_or((width * 4) as i32);
            if start > 30_000_000 {
                seek(&reader, start - 30_000_000)?;
            }
            let pending = next(&reader, VIDEO)?;
            Ok(Self {
                reader,
                width,
                height,
                stride,
                current: None,
                pending,
            })
        }
    }
    pub fn frame(&mut self, time: i64) -> Result<&image::RgbaImage, String> {
        while self
            .pending
            .as_ref()
            .is_some_and(|(_, t)| *t <= time + 10_000)
            || self.current.is_none() && self.pending.is_some()
        {
            let (sample, _) = self.pending.take().unwrap();
            let raw = bytes(&sample)?;
            let stride = self.stride.unsigned_abs() as usize;
            if raw.len()
                < stride * (self.height.saturating_sub(1)) as usize + self.width as usize * 4
            {
                return Err("Decoded frame is truncated.".into());
            }
            let mut frame = image::RgbaImage::new(self.width, self.height);
            for y in 0..self.height {
                let row = if self.stride < 0 {
                    self.height - 1 - y
                } else {
                    y
                } as usize
                    * stride;
                for x in 0..self.width {
                    let i = row + x as usize * 4;
                    frame.put_pixel(x, y, image::Rgba([raw[i + 2], raw[i + 1], raw[i], 255]));
                }
            }
            self.current = Some(frame);
            self.pending = next(&self.reader, VIDEO)?;
        }
        self.current
            .as_ref()
            .ok_or_else(|| "The recording contains no video frames.".into())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
}

/// The picture size and length of a video to import.
pub fn probe(path: &std::path::Path) -> Result<Probe, String> {
    let video = VideoReader::new(path, 0)?;
    // The exporter crops the stored picture; a rotated one (a phone held upright) would come out sideways.
    let rotation = unsafe { video.reader.GetNativeMediaType(VIDEO, 0) }
        .ok()
        .and_then(|native| unsafe { native.GetUINT32(&MF_MT_VIDEO_ROTATION) }.ok())
        .unwrap_or(0);
    if rotation != 0 {
        return Err("Rotated videos can't be imported yet.".into());
    }
    let duration = unsafe {
        video
            .reader
            .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
            .step("Reading the video's length")?
    };
    let ticks = u64::try_from(&duration).map_err(|_| "The video's length is unknown.".to_string())?;
    Ok(Probe { width: video.width, height: video.height, duration_ms: ticks / 10_000 })
}
