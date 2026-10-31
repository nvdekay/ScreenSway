//! Background music mixed under an export: the file's sound resampled to the export's
//! 48 kHz, looped or ended, at the level `gain` gives it. Platform independent, so it is
//! tested on any computer; platform/music.rs decodes the file.

/// The export's sound: 16-bit stereo at this rate.
pub const RATE: u32 = 48_000;

/// The music's level at `time_ms` of a video `total_ms` long; the same as `musicGain` in
/// packages/core, so the export sounds like the preview.
pub fn gain(volume: f64, time_ms: f64, total_ms: f64) -> f64 {
    if !(time_ms >= 0.0) || time_ms >= total_ms {
        return 0.0;
    }
    let fade_in = (time_ms / 300.0).min(1.0);
    let fade_out = ((total_ms - time_ms) / 2_000f64.min(total_ms / 2.0)).min(1.0);
    volume.clamp(0.0, 1.0) * fade_in * fade_out
}

/// Where the decoded music comes from: interleaved stereo 16-bit samples at `rate`.
pub trait Source {
    fn rate(&self) -> u32;
    /// The next decoded samples, or None at the end of the file.
    fn read(&mut self) -> Result<Option<Vec<i16>>, String>;
    /// Back to the start of the file, for looping.
    fn restart(&mut self) -> Result<(), String>;
}

pub struct Mixer<S: Source> {
    source: S,
    volume: f64,
    looped: bool,
    /// Decoded samples not used yet, and the position in them in source frames.
    pending: Vec<i16>,
    position: f64,
    ended: bool,
    read_this_pass: bool,
}

impl<S: Source> Mixer<S> {
    pub fn new(source: S, volume: f64, looped: bool) -> Self {
        Self { source, volume, looped, pending: Vec::new(), position: 0.0, ended: false, read_this_pass: false }
    }

    /// Adds the music to `samples` (interleaved stereo at RATE), which start `first_frame`
    /// frames into a video `total_frames` long.
    pub fn mix(&mut self, samples: &mut [i16], first_frame: i64, total_frames: i64) -> Result<(), String> {
        let step = f64::from(self.source.rate()) / f64::from(RATE);
        let total_ms = total_frames as f64 * 1_000.0 / f64::from(RATE);
        for (index, frame) in samples.chunks_exact_mut(2).enumerate() {
            // Linear interpolation between the two source frames around the position.
            let base = self.position.floor() as usize;
            if !self.fill(base + 2)? {
                break;
            }
            let fraction = self.position - base as f64;
            let time_ms = (first_frame + index as i64) as f64 * 1_000.0 / f64::from(RATE);
            let level = gain(self.volume, time_ms, total_ms);
            for channel in 0..2 {
                let a = f64::from(self.pending[base * 2 + channel]);
                let b = f64::from(self.pending[(base + 1) * 2 + channel]);
                let music = a + (b - a) * fraction;
                frame[channel] = (f64::from(frame[channel]) + music * level).round().clamp(-32_768.0, 32_767.0) as i16;
            }
            self.position += step;
        }
        // Drop what has been played, keeping the frame the position still reads from.
        let used = (self.position.floor() as usize).min(self.pending.len() / 2);
        self.pending.drain(..used * 2);
        self.position -= used as f64;
        Ok(())
    }

    /// Decodes until `frames` source frames are pending; false once the music has ended.
    fn fill(&mut self, frames: usize) -> Result<bool, String> {
        while self.pending.len() < frames * 2 {
            if self.ended {
                return Ok(false);
            }
            match self.source.read()? {
                Some(samples) => {
                    self.read_this_pass |= !samples.is_empty();
                    self.pending.extend_from_slice(&samples[..samples.len() / 2 * 2]);
                }
                // A file with no sound at all would otherwise be read again forever.
                None if self.looped && self.read_this_pass => {
                    self.source.restart()?;
                    self.read_this_pass = false;
                }
                None => self.ended = true,
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tone of `frames` frames at `rate`, each frame holding its own index.
    struct Ramp {
        rate: u32,
        frames: usize,
        next: usize,
        restarts: usize,
    }

    impl Source for Ramp {
        fn rate(&self) -> u32 {
            self.rate
        }
        fn read(&mut self) -> Result<Option<Vec<i16>>, String> {
            if self.next >= self.frames {
                return Ok(None);
            }
            let end = (self.next + 7).min(self.frames);
            let samples = (self.next..end).flat_map(|frame| [frame as i16, frame as i16]).collect();
            self.next = end;
            Ok(Some(samples))
        }
        fn restart(&mut self) -> Result<(), String> {
            self.next = 0;
            self.restarts += 1;
            Ok(())
        }
    }

    const LONG: i64 = RATE as i64 * 100;

    #[test]
    fn the_level_fades_in_and_out_like_the_preview() {
        assert_eq!(gain(0.5, 0.0, 10_000.0), 0.0);
        assert!((gain(0.5, 150.0, 10_000.0) - 0.25).abs() < 1e-9);
        assert_eq!(gain(0.5, 5_000.0, 10_000.0), 0.5);
        assert!((gain(0.5, 9_000.0, 10_000.0) - 0.25).abs() < 1e-9);
        assert_eq!(gain(0.5, 10_000.0, 10_000.0), 0.0);
    }

    #[test]
    fn music_at_the_export_rate_is_added_frame_by_frame() {
        let mut mixer = Mixer::new(Ramp { rate: RATE, frames: 100, next: 0, restarts: 0 }, 1.0, false);
        // Past the fade-in, so the level is 1.
        let start = RATE as i64;
        let mut samples = vec![10i16; 40];
        mixer.mix(&mut samples[..20], start, LONG).unwrap();
        mixer.mix(&mut samples[20..], start + 10, LONG).unwrap();
        let expected: Vec<i16> = (0..20).flat_map(|frame| [10 + frame, 10 + frame]).collect();
        assert_eq!(samples, expected);
    }

    #[test]
    fn music_at_another_rate_is_resampled() {
        // 24 kHz music: every export frame moves half a source frame.
        let mut mixer = Mixer::new(Ramp { rate: RATE / 2, frames: 100, next: 0, restarts: 0 }, 1.0, false);
        let mut samples = vec![0i16; 8];
        mixer.mix(&mut samples, RATE as i64, LONG).unwrap();
        assert_eq!(samples, [0, 0, 1, 1, 1, 1, 2, 2]);
    }

    #[test]
    fn music_ends_or_starts_over() {
        let mut once = Mixer::new(Ramp { rate: RATE, frames: 3, next: 0, restarts: 0 }, 1.0, false);
        let mut samples = vec![0i16; 12];
        once.mix(&mut samples, RATE as i64, LONG).unwrap();
        // Interpolation needs the next frame, so the last frame of the file is where it stops.
        assert_eq!(samples, [0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);

        let mut looped = Mixer::new(Ramp { rate: RATE, frames: 3, next: 0, restarts: 0 }, 1.0, true);
        let mut samples = vec![0i16; 12];
        looped.mix(&mut samples, RATE as i64, LONG).unwrap();
        assert_eq!(samples, [0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2]);
        assert!(looped.source.restarts >= 1);
    }

    #[test]
    fn silent_music_that_loops_does_not_hang() {
        let mut mixer = Mixer::new(Ramp { rate: RATE, frames: 0, next: 0, restarts: 0 }, 1.0, true);
        let mut samples = vec![5i16; 4];
        mixer.mix(&mut samples, 0, LONG).unwrap();
        assert_eq!(samples, [5, 5, 5, 5]);
    }
}
