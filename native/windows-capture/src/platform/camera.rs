use crate::model::Camera;
use std::path::Path;
use windows::core::HSTRING;
use windows::Devices::Enumeration::{DeviceClass, DeviceInformation};
use windows::Media::Capture::{LowLagMediaRecording, MediaCapture, MediaCaptureInitializationSettings, StreamingCaptureMode};
use windows::Media::Devices::MediaCapturePauseBehavior;
use windows::Media::MediaProperties::{MediaEncodingProfile, VideoEncodingQuality};
use windows::Storage::StorageFile;

pub fn list() -> Result<Vec<Camera>, String> {
    let devices = DeviceInformation::FindAllAsyncDeviceClass(DeviceClass::VideoCapture)
        .map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for index in 0..devices.Size().map_err(|e| e.to_string())? {
        let device = devices.GetAt(index).map_err(|e| e.to_string())?;
        result.push(Camera {
            id: device.Id().map_err(|e| e.to_string())?.to_string(),
            name: device.Name().map_err(|e| e.to_string())?.to_string(),
            is_default: index == 0,
        });
    }
    Ok(result)
}

pub struct Session {
    capture: MediaCapture,
    recording: LowLagMediaRecording,
}

impl Session {
    /// Opens the camera and its encoder; this is the slow part, so it runs before the screen starts.
    pub fn prepare(path: &Path, device_id: Option<&str>) -> Result<Self, String> {
        std::fs::File::create(path).map_err(|e| e.to_string())?;
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.to_string_lossy().as_ref()))
            .map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())?;
        let settings = MediaCaptureInitializationSettings::new().map_err(|e| e.to_string())?;
        settings.SetStreamingCaptureMode(StreamingCaptureMode::Video).map_err(|e| e.to_string())?;
        if let Some(id) = device_id.filter(|id| *id != "default") {
            settings.SetVideoDeviceId(&HSTRING::from(id)).map_err(|e| e.to_string())?;
        }
        let capture = MediaCapture::new().map_err(|e| e.to_string())?;
        // Windows refuses with "access denied" when camera access is off for desktop apps.
        let denied = |e: windows::core::Error| if e.code() == windows::Win32::Foundation::E_ACCESSDENIED {
            "SCREENSWAY_CAMERA_DENIED".to_string()
        } else {
            e.to_string()
        };
        capture.InitializeWithSettingsAsync(&settings).map_err(denied)?.join().map_err(denied)?;
        let profile = MediaEncodingProfile::CreateMp4(VideoEncodingQuality::HD720p).map_err(|e| e.to_string())?;
        // Video only: the microphone is recorded with the screen.
        profile.SetAudio(None).map_err(|e| e.to_string())?;
        let recording = capture.PrepareLowLagRecordToStorageFileAsync(&profile, &file)
            .map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())?;
        Ok(Self { capture, recording })
    }

    /// Starts writing frames; returns when the first frame is being recorded.
    pub fn start(&self) -> Result<(), String> {
        self.recording.StartAsync().map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())
    }

    pub fn pause(&self, paused: bool) -> Result<(), String> {
        let action = if paused {
            self.recording.PauseAsync(MediaCapturePauseBehavior::RetainHardwareResources)
        } else { self.recording.ResumeAsync() };
        action.map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())
    }

    pub fn finish(self) -> Result<(), String> {
        self.recording.StopAsync().map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())?;
        self.recording.FinishAsync().map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())?;
        self.capture.Close().map_err(|e| e.to_string())
    }
}
