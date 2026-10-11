//! H.264 High in MP4 through Media Foundation's sink writer, fed with NV12 textures so a
//! hardware encoder (NVENC, Quick Sync, AMF) can read frames straight from the GPU.

use super::capture::Gpu;
use crate::model::video_bitrate;
use crate::timeline::TICKS_PER_MILLISECOND;
use windows::core::{Interface, Result, GUID, HSTRING};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Variant::VARIANT;

/// Keyframes every two seconds, like the macOS recorder, so export can seek quickly.
const KEYFRAME_INTERVAL: u32 = 120;

pub struct Encoder {
    writer: IMFSinkWriter,
    stream: u32,
    _devices: IMFDXGIDeviceManager,
    /// The last frame is written once the next one arrives, so it can carry its real
    /// duration: frames come only when the screen changes.
    pending: Option<(IMFSample, i64)>,
}

// The sink writer is free-threaded; it is only used behind the recorder's lock.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new(path: &std::path::Path, gpu: &Gpu, width: u32, height: u32) -> Result<Self> {
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;

            let mut reset_token = 0;
            let mut devices = None;
            MFCreateDXGIDeviceManager(&mut reset_token, &mut devices)?;
            let devices = devices.expect("MFCreateDXGIDeviceManager returned no manager");
            devices.ResetDevice(&gpu.device, reset_token)?;

            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 3)?;
            let attributes = attributes.expect("MFCreateAttributes returned no store");
            attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
            attributes.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &devices)?;

            let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path.as_os_str()), None, &attributes)?;

            let output = video_type(width, height, &MFVideoFormat_H264)?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, video_bitrate(width, height))?;
            output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            let stream = writer.AddStream(&output)?;

            let input = video_type(width, height, &MFVideoFormat_NV12)?;
            writer.SetInputMediaType(stream, &input, None)?;

            // Not every encoder takes every setting; the defaults are still a valid video.
            let mut codec: *mut core::ffi::c_void = core::ptr::null_mut();
            if writer
                .GetServiceForStream(stream, &GUID::zeroed(), &ICodecAPI::IID, &mut codec)
                .is_ok()
                && !codec.is_null()
            {
                let codec = ICodecAPI::from_raw(codec);
                let _ = codec.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(KEYFRAME_INTERVAL));
            }

            writer.BeginWriting()?;
            Ok(Self { writer, stream, _devices: devices, pending: None })
        }
    }

    /// Queues `texture` at `time` (100 ns ticks on the video timeline).
    pub fn write(&mut self, texture: &ID3D11Texture2D, time: i64) -> Result<()> {
        let sample = unsafe {
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)?;
            let length = buffer.cast::<IMF2DBuffer>()?.GetContiguousLength()?;
            buffer.SetCurrentLength(length)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(time)?;
            sample
        };
        if let Some((previous, previous_time)) = self.pending.replace((sample, time)) {
            self.write_sample(&previous, previous_time, time)?;
        }
        Ok(())
    }

    /// Writes the last frame so it lasts until `end`, and closes the file.
    pub fn finish(mut self, end: i64) -> Result<()> {
        if let Some((sample, time)) = self.pending.take() {
            self.write_sample(&sample, time, end)?;
        }
        unsafe {
            self.writer.Finalize()?;
            let _ = MFShutdown();
        }
        Ok(())
    }

    fn write_sample(&self, sample: &IMFSample, time: i64, next: i64) -> Result<()> {
        unsafe {
            sample.SetSampleDuration((next - time).max(TICKS_PER_MILLISECOND))?;
            self.writer.WriteSample(self.stream, sample)
        }
    }
}

fn video_type(width: u32, height: u32, subtype: &GUID) -> Result<IMFMediaType> {
    unsafe {
        let media_type = MFCreateMediaType()?;
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, (u64::from(width) << 32) | u64::from(height))?;
        // The nominal rate; frames are only written when the screen changes.
        media_type.SetUINT64(&MF_MT_FRAME_RATE, (60u64 << 32) | 1)?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        Ok(media_type)
    }
}
