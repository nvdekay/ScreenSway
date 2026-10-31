//! Synchronous Media Foundation decoding. VFR frames retain their original timestamps.
use super::Step;
use crate::model::row_pitch;
use windows::core::Interface;
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
    /// The picture size, without the rows and columns H.264 pads it to (1366 × 768 is
    /// decoded as 1376 × 768): the frame size can include them, the display aperture does not.
    pub width: u32,
    pub height: u32,
    /// Where the picture starts inside the decoded frame.
    offset: (u32, u32),
    /// The decoded frame's own height, for a buffer that cannot report its row pitch.
    coded_height: u32,
    /// The media type's row pitch, when it states one.
    stride: Option<i32>,
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
            let (coded_width, coded_height) = ((size >> 32) as u32, size as u32);
            let (offset, (width, height)) = aperture(&ty)
                .filter(|&((x, y), (w, h))| w > 0 && h > 0 && x + w <= coded_width && y + h <= coded_height)
                .unwrap_or(((0, 0), (coded_width, coded_height)));
            let stride = ty.GetUINT32(&MF_MT_DEFAULT_STRIDE).ok().map(|v| v as i32);
            if start > 30_000_000 {
                seek(&reader, start - 30_000_000)?;
            }
            let pending = next(&reader, VIDEO)?;
            Ok(Self {
                reader,
                width,
                height,
                offset,
                coded_height,
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
            let frame = self.read(&sample)?;
            self.current = Some(frame);
            self.pending = next(&self.reader, VIDEO)?;
        }
        self.current
            .as_ref()
            .ok_or_else(|| "The recording contains no video frames.".into())
    }

    /// Copies the picture out of a decoded RGB32 frame. The buffer's own row pitch is used
    /// when it reports one: decoders pad rows, and reading them with the wrong pitch shears
    /// the picture into diagonal stripes.
    fn read(&self, sample: &IMFSample) -> Result<image::RgbaImage, String> {
        unsafe {
            let buffer = sample.ConvertToContiguousBuffer().step("Reading decoded samples")?;
            if let Ok(buffer) = buffer.cast::<IMF2DBuffer>() {
                let mut scanline = std::ptr::null_mut();
                let mut pitch = 0;
                if buffer.Lock2D(&mut scanline, &mut pitch).is_ok() {
                    let rows = self.offset.1 + self.height;
                    let span = pitch.unsigned_abs() as usize;
                    // Lock2D points at the top row; a negative pitch walks a bottom-up image.
                    let first = if pitch < 0 { scanline.offset(pitch as isize * (rows as isize - 1)) } else { scanline };
                    let length = span * rows as usize;
                    let frame = if span >= (self.offset.0 + self.width) as usize * 4 {
                        let raw = std::slice::from_raw_parts(first, length);
                        Ok(self.copy(raw, pitch as i64, if pitch < 0 { span * (rows as usize - 1) } else { 0 }))
                    } else {
                        Err("Decoded frame is truncated.".to_string())
                    };
                    let _ = buffer.Unlock2D();
                    return frame;
                }
            }
            let raw = bytes(sample)?;
            let pitch = row_pitch(raw.len(), self.stride, self.width + self.offset.0, self.coded_height);
            let span = pitch.unsigned_abs() as usize;
            // A bottom-up frame starts at its last decoded row.
            let (top, rows) = if pitch < 0 {
                (span * (self.coded_height.max(1) as usize - 1), self.coded_height.max(1) as usize)
            } else {
                (0, (self.offset.1 + self.height) as usize)
            };
            if raw.len() < span * (rows - 1) + (self.offset.0 + self.width) as usize * 4 {
                return Err("Decoded frame is truncated.".into());
            }
            Ok(self.copy(&raw, pitch, top))
        }
    }

    /// `top` is where the frame's first line starts in `raw`; `pitch` steps down one line.
    fn copy(&self, raw: &[u8], pitch: i64, top: usize) -> image::RgbaImage {
        let mut frame = image::RgbaImage::new(self.width, self.height);
        for y in 0..self.height {
            let row = (top as i64 + i64::from(self.offset.1 + y) * pitch) as usize;
            for x in 0..self.width {
                let i = row + (self.offset.0 + x) as usize * 4;
                frame.put_pixel(x, y, image::Rgba([raw[i + 2], raw[i + 1], raw[i], 255]));
            }
        }
        frame
    }
}

/// The part of the decoded frame that is the picture, from the display aperture.
fn aperture(media_type: &IMFMediaType) -> Option<((u32, u32), (u32, u32))> {
    let mut area = MFVideoArea::default();
    let mut size = 0;
    let bytes = unsafe {
        std::slice::from_raw_parts_mut(&mut area as *mut MFVideoArea as *mut u8, std::mem::size_of::<MFVideoArea>())
    };
    unsafe { media_type.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, bytes, Some(&mut size)) }.ok()?;
    if size as usize != std::mem::size_of::<MFVideoArea>() || area.OffsetX.value < 0 || area.OffsetY.value < 0 {
        return None;
    }
    Some((
        (area.OffsetX.value as u32, area.OffsetY.value as u32),
        (area.Area.cx.max(0) as u32, area.Area.cy.max(0) as u32),
    ))
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
