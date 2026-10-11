//! Platform-independent recording clocks, kept apart from the Windows APIs so they can be
//! unit tested anywhere. All times are in 100 ns ticks (the unit of QueryPerformanceCounter
//! after conversion, Windows.Graphics.Capture frame times and Media Foundation samples).

use crate::model::PointerSample;

pub const TICKS_PER_MILLISECOND: i64 = 10_000;
pub const TICKS_PER_SECOND: i64 = 10_000_000;
/// One frame at 60 fps.
pub const FRAME_TICKS: i64 = TICKS_PER_SECOND / 60;

/// The click that pressed Pause or Stop in ScreenSway's own controls is not part of the
/// recorded content and must not trigger a zoom toward controls that are not in the video.
const CONTROL_CLICK_WINDOW_MS: u64 = 600;
/// Moves are logged at most this often, like on macOS.
const MOVE_INTERVAL_MS: u64 = 16;

/// Converts global screen positions into video pixels and keeps the pointer log on the same
/// clock as the video: paused time is cut out of both.
pub struct PointerLog {
    samples: Vec<PointerSample>,
    started_at: i64,
    paused_at: Option<i64>,
    paused_total: i64,
    stopped_at: Option<i64>,
    /// Top-left of the captured area, in physical screen pixels.
    origin: (f64, f64),
    /// Video pixels per physical screen pixel (below 1 when the capture is scaled down).
    scale: (f64, f64),
    previous_point: Option<(f64, f64)>,
    previous_left: bool,
    previous_right: bool,
    last_move_ms: Option<u64>,
}

impl PointerLog {
    pub fn new(started_at: i64, origin: (f64, f64), scale: f64) -> Self {
        Self {
            samples: Vec::new(),
            started_at,
            paused_at: None,
            paused_total: 0,
            stopped_at: None,
            origin,
            scale: (scale, scale),
            previous_point: None,
            previous_left: false,
            previous_right: false,
            last_move_ms: None,
        }
    }

    /// A window may move or resize while the encoded canvas keeps its initial size.
    pub fn set_capture_area(&mut self, origin: (f64, f64), scale: (f64, f64)) {
        if self.origin != origin || self.scale != scale {
            self.origin = origin;
            self.scale = scale;
            self.previous_point = None;
        }
    }

    /// Records one poll of the pointer: a click when a button goes down, otherwise a move.
    pub fn observe(&mut self, now: i64, point: (f64, f64), left: bool, right: bool) {
        if self.paused_at.is_some() || self.stopped_at.is_some() {
            return;
        }
        let time_ms = self.elapsed_ms(now);
        let x = (point.0 - self.origin.0) * self.scale.0;
        let y = (point.1 - self.origin.1) * self.scale.1;
        if left && !self.previous_left {
            self.samples.push(PointerSample { time_ms, r#type: "leftClick", x, y });
        } else if right && !self.previous_right {
            self.samples.push(PointerSample { time_ms, r#type: "rightClick", x, y });
        } else if self.previous_point != Some(point)
            && self.last_move_ms.is_none_or(|last| time_ms >= last + MOVE_INTERVAL_MS)
        {
            self.samples.push(PointerSample { time_ms, r#type: "move", x, y });
            self.previous_point = Some(point);
            self.last_move_ms = Some(time_ms);
        }
        self.previous_left = left;
        self.previous_right = right;
    }

    pub fn set_paused(&mut self, paused: bool, now: i64) {
        let now = self.stopped_at.unwrap_or(now);
        if paused && self.paused_at.is_none() {
            self.drop_control_clicks(now);
            self.paused_at = Some(now);
        } else if !paused {
            self.finish_pause(now);
        }
    }

    pub fn stop(&mut self, now: i64) {
        if self.stopped_at.is_some() {
            return;
        }
        self.drop_control_clicks(now);
        self.finish_pause(now);
        self.stopped_at = Some(now);
    }

    /// Recorded time up to the stop command, without pauses.
    pub fn duration_ms(&self, now: i64) -> u64 {
        let now = self.stopped_at.unwrap_or(now);
        let current_pause = self.paused_at.map_or(0, |at| now - at);
        ticks_to_ms(now - self.started_at - self.paused_total - current_pause)
    }

    pub fn samples(&self) -> &[PointerSample] {
        &self.samples
    }

    fn elapsed_ms(&self, now: i64) -> u64 {
        ticks_to_ms(now - self.started_at - self.paused_total)
    }

    fn drop_control_clicks(&mut self, now: i64) {
        if self.paused_at.is_some() {
            return;
        }
        let cutoff = self.elapsed_ms(now).saturating_sub(CONTROL_CLICK_WINDOW_MS);
        self.samples.retain(|sample| sample.r#type == "move" || sample.time_ms < cutoff);
    }

    fn finish_pause(&mut self, now: i64) {
        if let Some(paused_at) = self.paused_at.take() {
            self.paused_total += now - paused_at;
        }
    }
}

fn ticks_to_ms(ticks: i64) -> u64 {
    (ticks.max(0) / TICKS_PER_MILLISECOND) as u64
}

/// Decides where each captured frame goes on the video timeline. Windows.Graphics.Capture,
/// like ScreenCaptureKit, only sends a frame when the screen changes, so the caller keeps the
/// most recent frame and this timeline says when to write it again.
#[derive(Debug, Default)]
pub struct VideoTimeline {
    session_start: Option<i64>,
    paused_at: Option<i64>,
    paused_total: i64,
    last_appended: Option<i64>,
    frame_arrived_while_paused: bool,
    finished: bool,
}

impl VideoTimeline {
    /// Starts the video at `now`. Returns `Some(0)` when a frame that arrived earlier should
    /// open the video (a static screen may never send another).
    pub fn start(&mut self, now: i64, has_frame: bool) -> Option<i64> {
        self.session_start = Some(now);
        has_frame.then(|| self.place(0)).flatten()
    }

    /// A new frame arrived at `frame_time`; returns its media time, or None to skip it.
    pub fn frame(&mut self, frame_time: i64) -> Option<i64> {
        if self.finished || self.session_start.is_none() {
            return None;
        }
        if self.paused_at.is_some() {
            self.frame_arrived_while_paused = true;
            return None;
        }
        let time = self.media_time(frame_time);
        self.place(time)
    }

    /// Pauses or resumes. On resume, returns a media time when the latest frame should be
    /// written again: the screen may have changed while paused.
    pub fn set_paused(&mut self, paused: bool, now: i64) -> Option<i64> {
        if paused {
            self.paused_at.get_or_insert(now);
            return None;
        }
        let paused_at = self.paused_at.take()?;
        self.paused_total += now - paused_at;
        let refresh = std::mem::take(&mut self.frame_arrived_while_paused);
        if refresh {
            let time = self.media_time(now);
            self.place(time)
        } else {
            None
        }
    }

    /// Ends the video at `now`. Returns the end time and, when the screen stood still at the
    /// end, a time just before it at which to repeat the last frame so the video lasts until
    /// the stop and matches the pointer timeline.
    pub fn finish(&mut self, now: i64) -> (i64, Option<i64>) {
        self.finished = true;
        if let Some(paused_at) = self.paused_at.take() {
            self.paused_total += now - paused_at;
        }
        let end = self.media_time(now);
        let closing = end - FRAME_TICKS;
        let closing = match self.last_appended {
            Some(last) if closing > last => self.place(closing),
            _ => None,
        };
        let end = self.last_appended.map_or(end, |last| end.max(last + FRAME_TICKS));
        (end, closing)
    }

    pub fn has_frames(&self) -> bool {
        self.last_appended.is_some()
    }

    /// Media time for a host time, in 100 ns ticks.
    pub fn media_time(&self, host_time: i64) -> i64 {
        self.session_start.map_or(0, |start| host_time - start - self.paused_total)
    }

    fn place(&mut self, requested: i64) -> Option<i64> {
        // The first frame starts the video at zero; later frames must keep moving forward.
        let time = match self.last_appended {
            None => 0,
            Some(last) if requested <= last => last + TICKS_PER_MILLISECOND,
            Some(_) => requested,
        };
        if time < 0 {
            return None;
        }
        self.last_appended = Some(time);
        Some(time)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: i64 = TICKS_PER_MILLISECOND;

    #[test]
    fn pointer_positions_are_in_video_pixels() {
        let mut log = PointerLog::new(1_000 * MS, (1920.0, 0.0), 0.5);
        log.observe(1_100 * MS, (2020.0, 300.0), false, false);
        assert_eq!(log.samples(), &[PointerSample { time_ms: 100, r#type: "move", x: 50.0, y: 150.0 }]);
    }

    #[test]
    fn moves_are_throttled_and_clicks_are_not() {
        let mut log = PointerLog::new(0, (0.0, 0.0), 1.0);
        log.observe(0, (1.0, 1.0), false, false);
        log.observe(5 * MS, (2.0, 1.0), false, false);
        log.observe(8 * MS, (2.0, 1.0), true, false);
        log.observe(12 * MS, (2.0, 1.0), true, false);
        log.observe(20 * MS, (3.0, 1.0), false, false);
        log.observe(25 * MS, (3.0, 1.0), false, true);
        let types: Vec<_> = log.samples().iter().map(|sample| (sample.time_ms, sample.r#type)).collect();
        assert_eq!(types, [(0, "move"), (8, "leftClick"), (20, "move"), (25, "rightClick")]);
    }

    #[test]
    fn paused_time_is_cut_from_the_pointer_log() {
        let mut log = PointerLog::new(0, (0.0, 0.0), 1.0);
        log.observe(1_000 * MS, (1.0, 1.0), false, false);
        log.set_paused(true, 2_000 * MS);
        log.observe(2_500 * MS, (5.0, 5.0), false, false);
        log.set_paused(false, 4_000 * MS);
        log.observe(4_100 * MS, (9.0, 9.0), false, false);
        log.stop(5_000 * MS);
        let times: Vec<_> = log.samples().iter().map(|sample| sample.time_ms).collect();
        assert_eq!(times, [1_000, 2_100]);
        assert_eq!(log.duration_ms(9_000 * MS), 3_000);
    }

    #[test]
    fn clicks_on_the_recording_controls_are_dropped() {
        let mut log = PointerLog::new(0, (0.0, 0.0), 1.0);
        log.observe(1_000 * MS, (1.0, 1.0), true, false);
        log.observe(1_100 * MS, (1.0, 1.0), false, false);
        log.observe(4_700 * MS, (8.0, 8.0), true, false);
        log.stop(5_000 * MS);
        let kinds: Vec<_> = log.samples().iter().map(|sample| sample.r#type).collect();
        assert_eq!(kinds, ["leftClick", "move"]);
    }

    #[test]
    fn video_starts_at_zero_with_an_earlier_frame() {
        let mut timeline = VideoTimeline::default();
        assert_eq!(timeline.frame(5 * MS), None, "frames before the start are only kept");
        assert_eq!(timeline.start(10 * MS, true), Some(0));
        assert_eq!(timeline.frame(30 * MS), Some(20 * MS));
        assert_eq!(timeline.frame(30 * MS), Some(21 * MS), "times keep moving forward");
    }

    #[test]
    fn pointer_follows_a_moved_and_resized_window() {
        let mut log = PointerLog::new(0, (100.0, 200.0), 1.0);
        log.observe(100 * MS, (300.0, 300.0), false, false);
        log.set_capture_area((200.0, 250.0), (0.5, 2.0));
        // The screen cursor did not move, but its position in the captured video did.
        log.observe(200 * MS, (300.0, 300.0), false, false);
        log.observe(300 * MS, (400.0, 350.0), true, false);
        let samples = log.samples();
        assert_eq!((samples[0].x, samples[0].y), (200.0, 100.0));
        assert_eq!((samples[1].x, samples[1].y), (50.0, 100.0));
        assert_eq!((samples[2].x, samples[2].y), (100.0, 200.0));
        assert_eq!(samples[2].r#type, "leftClick");
    }

    #[test]
    fn pauses_are_cut_and_refresh_the_frame_on_resume() {
        let mut timeline = VideoTimeline::default();
        timeline.start(0, false);
        assert_eq!(timeline.frame(100 * MS), Some(0));
        assert_eq!(timeline.frame(200 * MS), Some(200 * MS));
        timeline.set_paused(true, 300 * MS);
        assert_eq!(timeline.frame(400 * MS), None);
        assert_eq!(timeline.set_paused(false, 1_300 * MS), Some(300 * MS));
        assert_eq!(timeline.frame(1_400 * MS), Some(400 * MS));
        // A pause with no screen change does not repeat the frame.
        timeline.set_paused(true, 1_500 * MS);
        assert_eq!(timeline.set_paused(false, 2_000 * MS), None);
    }

    #[test]
    fn a_still_screen_is_held_until_the_stop() {
        let mut timeline = VideoTimeline::default();
        timeline.start(0, true);
        let (end, closing) = timeline.finish(3_000 * MS);
        assert_eq!(end, 3_000 * MS);
        assert_eq!(closing, Some(3_000 * MS - FRAME_TICKS));
        assert_eq!(timeline.frame(3_100 * MS), None);
    }

    #[test]
    fn finishing_while_paused_ends_at_the_pause() {
        let mut timeline = VideoTimeline::default();
        timeline.start(0, true);
        timeline.set_paused(true, 1_000 * MS);
        let (end, _) = timeline.finish(4_000 * MS);
        assert_eq!(end, 1_000 * MS);
    }
}
