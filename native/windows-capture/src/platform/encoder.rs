//! H.264 High in MP4 through Media Foundation's sink writer, fed with NV12 textures so a
//! hardware encoder (NVENC, Quick Sync, AMF) can read frames straight from the GPU.

use super::capture::Gpu;
use super::Step;
use crate::model::video_bitrate;
use crate::timeline::TICKS_PER_MILLISECOND;
use windows::core::{Interface, Result, GUID};
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
    /// The encoder Media Foundation picked, for the capture stats.
    pub name: String,
}

// The sink writer is free-threaded; it is only used behind the recorder's lock.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new(path: &std::path::Path, gpu: &Gpu, width: u32, height: u32) -> std::result::Result<Self, String> {
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL).step("Starting Media Foundation")?;

            let mut reset_token = 0;
            let mut devices = None;
            MFCreateDXGIDeviceManager(&mut reset_token, &mut devices).step("Creating the encoder's device manager")?;
            let devices = devices.expect("MFCreateDXGIDeviceManager returned no manager");
            devices.ResetDevice(&gpu.device, reset_token).step("Sharing the GPU with the encoder")?;

            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 3).step("Creating the encoder settings")?;
            let attributes = attributes.expect("MFCreateAttributes returned no store");
            attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1).step("Enabling hardware encoding")?;
            attributes.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &devices).step("Enabling hardware encoding")?;

            let writer = MFCreateSinkWriterFromURL(&super::media_path(path), None, &attributes)
                .step("Creating the video file")?;

            let bitrate = video_bitrate(width, height);
            let output = video_type(width, height, &MFVideoFormat_H264).step("Describing the H.264 video")?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).step("Describing the H.264 video")?;
            output
                .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                .step("Describing the H.264 video")?;
            let stream = writer.AddStream(&output).step(&format!("Adding a {width}×{height} H.264 stream"))?;

            let input = video_type(width, height, &MFVideoFormat_NV12).step("Describing the NV12 frames")?;
            writer
                .SetInputMediaType(stream, &input, None)
                .step(&format!("Finding an H.264 encoder for {width}×{height} NV12 frames"))?;

            // Some encoders ignore the media type's bitrate and only honor these; not every
            // encoder takes every setting, and the defaults are still a valid video.
            let mut codec: *mut core::ffi::c_void = core::ptr::null_mut();
            if writer
                .GetServiceForStream(stream, &GUID::zeroed(), &ICodecAPI::IID, &mut codec)
                .is_ok()
                && !codec.is_null()
            {
                let codec = ICodecAPI::from_raw(codec);
                let _ = codec.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(KEYFRAME_INTERVAL));
                let _ = codec.SetValue(
                    &CODECAPI_AVEncCommonRateControlMode,
                    &VARIANT::from(eAVEncCommonRateControlMode_UnconstrainedVBR.0 as u32),
                );
                let _ = codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate));
            }

            let name = encoder_name(&writer, stream);
            writer.BeginWriting().step("Starting the video encoder")?;
            Ok(Self { writer, stream, _devices: devices, pending: None, name })
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

/// "NVIDIA H.264 Encoder MFT (hardware)" or "H264 Encoder MFT (software)": a software encoder
/// copies every frame back from the GPU and is much slower.
fn encoder_name(writer: &IMFSinkWriter, stream: u32) -> String {
    let Ok(writer) = writer.cast::<IMFSinkWriterEx>() else { return "unknown".into() };
    for index in 0..8 {
        let mut category = GUID::zeroed();
        let mut transform = None;
        if unsafe { writer.GetTransformForStream(stream, index, Some(&mut category), &mut transform) }.is_err() {
            break;
        }
        let Some(attributes) = transform.and_then(|transform| unsafe { transform.GetAttributes() }.ok()) else {
            continue;
        };
        if category != MFT_CATEGORY_VIDEO_ENCODER {
            continue;
        }
        let hardware = unsafe { attributes.GetStringLength(&MFT_ENUM_HARDWARE_URL_Attribute) }.is_ok();
        let mut name = windows::core::PWSTR::null();
        let mut length = 0;
        let label = if unsafe { attributes.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut length) }.is_ok() {
            let label = unsafe { name.to_string() }.unwrap_or_default();
            unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(name.0 as _)) };
            label
        } else {
            "H.264 encoder".into()
        };
        return format!("{label} ({})", if hardware { "hardware" } else { "software" });
    }
    "unknown".into()
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
