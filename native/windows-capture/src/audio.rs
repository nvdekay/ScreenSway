//! Shared-clock audio mixing and microphone processing, independent of Windows APIs.
use std::collections::VecDeque;

pub const RATE: i64 = 48_000;
pub const TICKS: i64 = 10_000_000;

#[derive(Default)]
pub struct AudioClock {
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub pauses: Vec<(i64, Option<i64>)>,
}
impl AudioClock {
    pub fn pause(&mut self, paused: bool, time: i64) {
        if paused {
            if self.pauses.last().is_none_or(|(_, end)| end.is_some()) {
                self.pauses.push((time, None));
            }
        } else if let Some((_, end)) = self.pauses.last_mut() {
            if end.is_none() {
                *end = Some(time);
            }
        }
    }
    pub fn sample_at(&self, time: i64) -> Option<i64> {
        let start = self.start?;
        if time < start || self.end.is_some_and(|end| time >= end) {
            return None;
        }
        let mut elapsed = time - start;
        for (p, end) in &self.pauses {
            if time < *p {
                break;
            }
            if end.is_none_or(|end| time < end) {
                return None;
            }
            elapsed -= end.unwrap() - p;
        }
        // QPC ticks cannot represent 1/48000 s exactly. Round instead of flooring a
        // second time, which would duplicate/drop samples at fractional tick boundaries.
        Some(((elapsed as i128 * RATE as i128 + TICKS as i128 / 2) / TICKS as i128) as i64)
    }
    pub fn length(&self, time: i64) -> i64 {
        let Some(start) = self.start else {
            return 0;
        };
        let end = self.end.unwrap_or(time);
        let pauses: i64 = self
            .pauses
            .iter()
            .map(|(p, e)| (e.unwrap_or(end).min(end) - p).max(0))
            .sum();
        ((end - start - pauses).max(0) as i128 * RATE as i128 / TICKS as i128) as i64
    }
}

#[derive(Default)]
pub struct Mix {
    pub written: i64,
    pending: VecDeque<[f32; 2]>,
}
impl Mix {
    pub fn add(&mut self, at: i64, value: [f32; 2]) {
        if at < self.written {
            return;
        }
        let offset = (at - self.written) as usize;
        // Bound memory even if a device returns a corrupt clock.
        if offset > RATE as usize * 4 {
            return;
        }
        self.pending
            .resize(self.pending.len().max(offset + 1), [0.0; 2]);
        self.pending[offset][0] += value[0];
        self.pending[offset][1] += value[1];
    }
    pub fn flush(
        &mut self,
        until: i64,
        mut write: impl FnMut([f32; 2]) -> Result<(), String>,
    ) -> Result<(), String> {
        while self.written < until {
            let frame = self.pending.pop_front().unwrap_or([0.0; 2]);
            write([soft_clip(frame[0]), soft_clip(frame[1])])?;
            self.written += 1;
        }
        Ok(())
    }
}

pub fn soft_clip(x: f32) -> f32 {
    if !x.is_finite() {
        return 0.0;
    }
    if x.abs() <= 0.8 {
        x
    } else {
        x.signum() * (0.8 + 0.14 * ((x.abs() - 0.8) / 0.14).tanh())
    }
}

pub struct Voice {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
    history: VecDeque<f32>,
    startup: u32,
    energy: f32,
    detector: f32,
    speech: f32,
    gain: f32,
    gate: f32,
    hold: u32,
    applied: f32,
    carry: Vec<f32>,
    ready: VecDeque<f32>,
}
impl Default for Voice {
    fn default() -> Self {
        let omega = 2.0 * std::f32::consts::PI * 90.0 / RATE as f32;
        let alpha = omega.sin() / (2.0 * 0.7071);
        let c = omega.cos();
        let a0 = 1.0 + alpha;
        Self {
            b: [(1.0 + c) / 2.0 / a0, -(1.0 + c) / a0, (1.0 + c) / 2.0 / a0],
            a: [-2.0 * c / a0, (1.0 - alpha) / a0],
            x: [0.0; 2],
            y: [0.0; 2],
            history: VecDeque::new(),
            startup: 0,
            energy: -1.0,
            detector: -100.0,
            speech: -30.0,
            gain: 0.0,
            gate: 0.0,
            hold: 0,
            applied: 1.0,
            carry: Vec::new(),
            ready: VecDeque::new(),
        }
    }
}
impl Voice {
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        for &x in input {
            let x = if x.is_finite() { x } else { 0.0 };
            let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1]
                - self.a[0] * self.y[0]
                - self.a[1] * self.y[1];
            self.x = [x, self.x[0]];
            self.y = [y, self.y[0]];
            self.carry.push(y);
        }
        while self.carry.len() >= 480 {
            let block: Vec<_> = self.carry.drain(..480).collect();
            let energy = block.iter().map(|x| x * x).sum::<f32>() / 480.0;
            let peak = block.iter().copied().map(f32::abs).fold(0.0, f32::max);
            let db = 10.0 * (energy + 1e-12).log10();
            let peak_db = 20.0 * (peak + 1e-9).log10();
            self.energy = if self.energy < 0.0 {
                energy
            } else {
                self.energy + (energy - self.energy) * 0.3
            };
            let smoothed = 10.0 * (self.energy + 1e-12).log10();
            self.startup += 1;
            if self.startup > 30 && smoothed > -67.0 {
                self.history.push_back(smoothed);
                if self.history.len() > 300 {
                    self.history.pop_front();
                }
            }
            let listening = self.history.len() >= 50;
            let floor = if listening {
                let mut h: Vec<_> = self.history.iter().copied().collect();
                h.sort_by(f32::total_cmp);
                h[h.len() / 10]
            } else {
                -60.0
            };
            self.detector = smoothed.max(self.detector - 1.0);
            let threshold = (floor + 12.0).max(-55.0);
            if listening && db > threshold {
                self.speech += (db - self.speech) * if db > self.speech { 0.05 } else { 0.01 };
            }
            self.hold = if self.detector > threshold || !listening {
                25
            } else {
                self.hold.saturating_sub(1)
            };
            let wanted = if listening {
                (-20.0 - self.speech).clamp(-12.0, 12.0)
            } else {
                self.gain
            };
            let step = if wanted > self.gain { 0.05 } else { 0.5 };
            self.gain += (wanted - self.gain).clamp(-step, step);
            let gate = if self.hold > 0 { 0.0 } else { -12.0 };
            self.gate += (gate - self.gate).clamp(-0.3, 3.0);
            let ceiling = -3.0 - peak_db;
            self.gain = self.gain.min(ceiling - self.gate);
            let target = 10.0_f32.powf((self.gain + self.gate).min(ceiling) / 20.0);
            let begin = self.applied.min(target);
            for (i, x) in block.into_iter().enumerate() {
                self.ready.push_back(soft_clip(
                    x * (begin + (target - begin) * (i + 1) as f32 / 480.0),
                ));
            }
            self.applied = target;
        }
        // The processing delay stays below one 10 ms block.
        let mut out = Vec::with_capacity(input.len());
        for _ in 0..input.len() {
            out.push(self.ready.pop_front().unwrap_or(0.0));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fractional_qpc_ticks_do_not_duplicate_or_drop_audio_samples() {
        let clock = AudioClock {
            start: Some(100),
            ..Default::default()
        };
        for i in 0..4800 {
            assert_eq!(clock.sample_at(100 + i * TICKS / RATE), Some(i));
        }
    }

    #[test]
    fn pauses_cut_audio_on_the_video_clock() {
        let mut clock = AudioClock {
            start: Some(100),
            ..Default::default()
        };
        clock.pause(true, 100 + TICKS);
        clock.pause(false, 100 + 2 * TICKS);
        assert_eq!(clock.sample_at(100 + TICKS + 1), None);
        assert_eq!(clock.sample_at(100 + 2 * TICKS), Some(RATE));
        assert_eq!(clock.length(100 + 3 * TICKS), 2 * RATE);
    }
    #[test]
    fn mix_fills_silence_and_combines_sources() {
        let mut mix = Mix::default();
        mix.add(1, [0.2, 0.3]);
        mix.add(1, [0.4, 0.1]);
        let mut out = vec![];
        mix.flush(3, |x| {
            out.push(x);
            Ok(())
        })
        .unwrap();
        assert_eq!(out[0], [0.0; 2]);
        assert!((out[1][0] - 0.6).abs() < 1e-6);
        assert_eq!(out[2], [0.0; 2]);
    }
    #[test]
    fn voice_rejects_dc_and_limits_peaks() {
        let mut v = Voice::default();
        let out = v.process(&vec![10.0; 48_000]);
        assert!(out.iter().all(|x| x.is_finite() && x.abs() < 0.95));
        assert!(out[47_000..].iter().all(|x| x.abs() < 0.001));
    }
}
