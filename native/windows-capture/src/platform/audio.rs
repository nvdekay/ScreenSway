//! WASAPI endpoint loopback + microphone, clocked against Windows.Graphics.Capture.
use super::{now, Step};
use crate::{
    audio::{AudioClock, Mix, Voice, RATE, TICKS},
    model::Microphone,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use windows::{
    core::{Interface, HSTRING},
    Win32::{
        Media::Audio::*,
        System::Com::{CoCreateInstance, CLSCTX_ALL},
    },
};

pub fn microphones() -> Result<Vec<Microphone>, String> {
    let enumerator = wasapi::DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let default = enumerator
        .get_default_device(&wasapi::Direction::Capture)
        .ok()
        .and_then(|d| d.get_id().ok());
    let devices = enumerator
        .get_device_collection(&wasapi::Direction::Capture)
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for device in &devices {
        let device = device.map_err(|e| e.to_string())?;
        let id = device.get_id().map_err(|e| e.to_string())?;
        result.push(Microphone {
            is_default: default.as_ref() == Some(&id),
            id,
            name: device.get_friendlyname().map_err(|e| e.to_string())?,
        });
    }
    Ok(result)
}

struct Endpoint {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    mic: bool,
    voice: Voice,
    expected: Option<i64>,
}
impl Endpoint {
    fn new(mic: bool, id: Option<&str>, echo_cancellation: bool) -> Result<Self, String> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .step("Opening audio devices")?;
            let device = if let Some(id) = id.filter(|id| *id != "default") {
                enumerator
                    .GetDevice(&HSTRING::from(id))
                    .step("Opening the selected microphone")?
            } else {
                enumerator
                    .GetDefaultAudioEndpoint(if mic { eCapture } else { eRender }, eConsole)
                    .step("Opening the default audio device")?
            };
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).step("Opening WASAPI")?;
            let format = WAVEFORMATEX {
                wFormatTag: 3,
                nChannels: 2,
                nSamplesPerSec: 48_000,
                nAvgBytesPerSec: 384_000,
                nBlockAlign: 8,
                wBitsPerSample: 32,
                cbSize: 0,
            };
            let flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
                | if mic { 0 } else { AUDCLNT_STREAMFLAGS_LOOPBACK };
            if mic && echo_cancellation {
                // The communications category turns on the device's voice processing, which
                // includes echo cancellation where the driver or Windows provides it.
                if let Ok(client2) = client.cast::<IAudioClient2>() {
                    let properties = AudioClientProperties {
                        cbSize: std::mem::size_of::<AudioClientProperties>() as u32,
                        bIsOffload: false.into(),
                        eCategory: AudioCategory_Communications,
                        Options: AUDCLNT_STREAMOPTIONS_NONE,
                    };
                    let _ = client2.SetClientProperties(&properties);
                }
            }
            client
                .Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1_000_000, 0, &format, None)
                .step("Starting 48 kHz stereo audio capture")?;
            let capture = client
                .GetService::<IAudioCaptureClient>()
                .step("Opening captured audio")?;
            client.Start().step("Starting the audio stream")?;
            Ok(Self {
                client,
                capture,
                mic,
                voice: Voice::default(),
                expected: None,
            })
        }
    }
    fn drain(&mut self, clock: &Mutex<AudioClock>, mix: &mut Mix) -> Result<(), String> {
        unsafe {
            while self
                .capture
                .GetNextPacketSize()
                .step("Checking captured audio")?
                > 0
            {
                let mut pointer = std::ptr::null_mut();
                let mut count = 0;
                let mut flags = 0;
                let mut stamp = 0;
                self.capture
                    .GetBuffer(&mut pointer, &mut count, &mut flags, None, Some(&mut stamp))
                    .step("Reading captured audio")?;
                // WASAPI permits a null data pointer for silent packets; never dereference it.
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || pointer.is_null();
                let mut samples = vec![0.0_f32; count as usize * 2];
                if !silent {
                    let bytes = std::slice::from_raw_parts(pointer, count as usize * 8);
                    for (out, bytes) in samples.iter_mut().zip(bytes.chunks_exact(4)) {
                        *out = f32::from_le_bytes(bytes.try_into().unwrap());
                    }
                }
                self.capture
                    .ReleaseBuffer(count)
                    .step("Releasing captured audio")?;
                let timestamp = if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0 {
                    now() - count as i64 * TICKS / RATE
                } else {
                    stamp as i64
                };
                if self.mic {
                    let mono: Vec<_> = samples
                        .chunks_exact(2)
                        .map(|v| (v[0] + v[1]) * 0.5)
                        .collect();
                    let processed = self.voice.process(&mono);
                    for (i, x) in processed.into_iter().enumerate() {
                        samples[i * 2] = x;
                        samples[i * 2 + 1] = x;
                    }
                }
                let clock = clock.lock().map_err(|_| "Audio clock unavailable")?;
                let first = clock.sample_at(timestamp);
                let adjustment = match (first, self.expected) {
                    (Some(at), Some(expected)) if (at - expected).abs() <= RATE / 50 => {
                        expected - at
                    }
                    _ => 0,
                };
                let mut last = None;
                for (i, s) in samples.chunks_exact(2).enumerate() {
                    if let Some(at) = clock.sample_at(timestamp + i as i64 * TICKS / RATE) {
                        let at = at + adjustment;
                        mix.add(at, [s[0], s[1]]);
                        last = Some(at);
                    }
                }
                self.expected = last.map(|at| at + 1);
            }
        }
        Ok(())
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

pub struct Session {
    pub clock: Arc<Mutex<AudioClock>>,
    running: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<Result<(), String>>>,
    failure: Arc<Mutex<Option<String>>>,
    path: PathBuf,
}
impl Session {
    pub fn new(
        path: PathBuf,
        system: bool,
        microphone: Option<String>,
        echo_cancellation: bool,
    ) -> Result<Option<Self>, String> {
        if !system && microphone.is_none() {
            return Ok(None);
        }
        let clock = Arc::new(Mutex::new(AudioClock::default()));
        let running = Arc::new(AtomicBool::new(true));
        let failure = Arc::new(Mutex::new(None));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (c, r, f, p) = (
            clock.clone(),
            running.clone(),
            failure.clone(),
            path.clone(),
        );
        let worker = thread::spawn(move || {
            let result: Result<(), String> = (|| {
                super::initialize().map_err(|e| e.to_string())?;
                let mut endpoints = Vec::new();
                if system {
                    endpoints.push(Endpoint::new(false, None, false)?);
                }
                if let Some(id) = microphone {
                    endpoints.push(Endpoint::new(true, Some(&id), echo_cancellation).map_err(|e| {
                        if e.contains("80070005") {
                            format!("SCREENSWAY_MICROPHONE_DENIED: {e}")
                        } else {
                            e
                        }
                    })?);
                }
                let spec = hound::WavSpec {
                    channels: 2,
                    sample_rate: 48_000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let mut writer = hound::WavWriter::create(&p, spec).map_err(|e| e.to_string())?;
                let _ = ready_tx.send(Ok(()));
                let mut mix = Mix::default();
                loop {
                    for endpoint in &mut endpoints {
                        endpoint.drain(&c, &mut mix)?;
                    }
                    let stopped = !r.load(Ordering::SeqCst);
                    let end = c
                        .lock()
                        .map_err(|_| "Audio clock unavailable")?
                        .length(now());
                    let until = if stopped {
                        end
                    } else {
                        (end - RATE / 2).max(0)
                    };
                    mix.flush(until, |frame| {
                        for x in frame {
                            writer
                                .write_sample((x * 32767.0).round() as i16)
                                .map_err(|e| e.to_string())?;
                        }
                        Ok(())
                    })?;
                    if stopped {
                        break;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                writer.finalize().map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Err(e) = &result {
                let _ = ready_tx.send(Err(e.clone()));
                if let Ok(mut f) = f.lock() {
                    *f = Some(e.clone());
                }
            }
            result
        });
        match ready_rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(())) => Ok(Some(Self {
                clock,
                running,
                worker: Some(worker),
                failure,
                path,
            })),
            result => {
                running.store(false, Ordering::SeqCst);
                let _ = worker.join();
                Err(match result {
                    Ok(Err(e)) => e,
                    _ => "Audio capture did not initialize.".into(),
                })
            }
        }
    }
    pub fn start(&self, time: i64) {
        if let Ok(mut c) = self.clock.lock() {
            c.start = Some(time);
        }
    }
    pub fn pause(&self, paused: bool, time: i64) {
        if let Ok(mut c) = self.clock.lock() {
            c.pause(paused, time);
        }
    }
    pub fn stop(&self, time: i64) {
        if let Ok(mut c) = self.clock.lock() {
            c.end = Some(time);
        }
        self.running.store(false, Ordering::SeqCst);
    }
    pub fn failure(&self) -> Option<String> {
        self.failure.lock().ok().and_then(|f| f.clone())
    }
    pub fn finish(
        mut self,
        end: i64,
        video: &std::path::Path,
        duration: i64,
    ) -> Result<(), String> {
        self.stop(end);
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| "Audio capture thread failed")??;
        }
        let temp = video.with_extension("audio.mp4");
        let mut reported = std::time::Instant::now();
        super::mux::with_source_audio(video, &self.path, &temp, &[super::mux::AudioRange { start: 0, end: duration, rate: 1.0 }], 0, &mut || {
            if reported.elapsed() >= Duration::from_secs(1) {
                reported = std::time::Instant::now();
                super::saving("audio");
            }
        })?;
        std::fs::rename(&temp, video).map_err(|e| e.to_string())?;
        std::fs::remove_file(&self.path).map_err(|e| e.to_string())?;
        Ok(())
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
