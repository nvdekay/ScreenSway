//! The JSON the desktop shell reads. Field names match the macOS helper exactly, so the
//! shell and the UI do not need to know which platform recorded a project.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub kind: String,
    pub name: String,
    /// Size in logical pixels (the Windows equivalent of macOS points).
    pub width: u32,
    pub height: u32,
    /// Physical pixels per logical pixel: 1.5 at 150 % scaling. Recordings of 100 % displays
    /// hold less detail, which shows once the preview zooms in.
    pub pixel_scale: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microphone {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerSample {
    pub time_ms: u64,
    pub r#type: &'static str,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSummary {
    pub project_path: String,
    pub video_path: String,
    pub pointer_events_path: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub pointer_events: Vec<PointerSample>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub schema_version: u32,
    pub title: String,
    pub created_at: String,
    pub duration_ms: u64,
    pub canvas: Canvas,
    pub media: Media,
    pub pointer_events: String,
}

#[derive(Debug, Serialize)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct Media {
    pub screen: String,
}

/// The H.264 encoders on Windows, like VideoToolbox, top out around 4K.
pub const MAXIMUM_ENCODED_DIMENSION: f64 = 3_840.0;

/// The encoded size for a capture of `width` × `height` physical pixels: scaled down so the
/// long side fits the encoder, and rounded to even numbers as NV12 requires.
/// Returns the size and the scale applied to the source.
pub fn encoded_size(width: u32, height: u32) -> (u32, u32, f64) {
    let long_side = f64::from(width.max(height)).max(1.0);
    let scale = (MAXIMUM_ENCODED_DIMENSION / long_side).min(1.0);
    let even = |value: u32| ((f64::from(value) * scale).round() as u32 / 2 * 2).max(2);
    (even(width), even(height), scale)
}

/// About 0.15 bits per pixel per frame at 60 fps, the same budget as the macOS recorder:
/// ~18 Mbps for 1080p, ~75 Mbps for 4K.
pub fn video_bitrate(width: u32, height: u32) -> u32 {
    (f64::from(width) * f64::from(height) * 60.0 * 0.15).clamp(10_000_000.0, 80_000_000.0) as u32
}

/// `2026-10-11T08:30:00Z` for a Unix time in seconds, like `ISO8601DateFormatter` on macOS.
pub fn iso8601(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let seconds = unix_seconds % 86_400;
    // Howard Hinnant's days-to-civil algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3_600,
        seconds / 60 % 60,
        seconds % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_dates_like_the_macos_helper() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_791_707_400), "2026-10-11T08:30:00Z");
    }

    #[test]
    fn caps_the_encoded_size_and_keeps_it_even() {
        assert_eq!(encoded_size(1920, 1080), (1920, 1080, 1.0));
        assert_eq!(encoded_size(1365, 767), (1364, 766, 1.0));
        let (width, height, scale) = encoded_size(5120, 2880);
        assert_eq!((width, height), (3840, 2160));
        assert!((scale - 0.75).abs() < 1e-9);
    }

    #[test]
    fn bitrate_follows_the_frame_size_within_limits() {
        assert_eq!(video_bitrate(1920, 1080), 18_662_400);
        assert_eq!(video_bitrate(640, 400), 10_000_000);
        assert_eq!(video_bitrate(3840, 2160), 74_649_600);
    }
}
