//! Portable export contract and compositor. Coordinates follow the shared Studio render plan.
use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub source: String,
    pub output: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub base_layer: String,
    pub cursor: String,
    pub cursor_hotspot_x: f64,
    pub cursor_hotspot_y: f64,
    pub video: Rect,
    pub radius: f64,
    pub round_top_corners: bool,
    pub frames: Vec<Vec<f64>>,
    #[serde(default)]
    pub start_ms: f64,
    #[serde(default)]
    pub captions: Vec<Caption>,
}

#[derive(Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub start_ms: f64,
    pub end_ms: f64,
    pub image: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
}

impl ExportJob {
    pub fn validate(&self) -> Result<(), String> {
        let finite = |v: f64| v.is_finite();
        if self.width < 2
            || self.height < 2
            || self.width > 7680
            || self.height > 7680
            || self.width % 2 != 0
            || self.height % 2 != 0
            || self.fps != 60
            || self.frames.is_empty()
        {
            return Err(
                "Export requires an even output size and a nonempty 60 fps render plan.".into(),
            );
        }
        let v = &self.video;
        if ![
            v.x,
            v.y,
            v.width,
            v.height,
            self.radius,
            self.start_ms,
            self.cursor_hotspot_x,
            self.cursor_hotspot_y,
        ]
        .into_iter()
        .all(finite)
            || v.width <= 0.0
            || v.height <= 0.0
            || self.radius < 0.0
            || self.start_ms < 0.0
            || v.x < 0.0
            || v.y < 0.0
            || v.x + v.width > self.width as f64 + 1.0
            || v.y + v.height > self.height as f64 + 1.0
            || self.frames.iter().any(|f| {
                f.len() != 11 || !f.iter().copied().all(finite) || f[2] <= 0.0 || f[3] <= 0.0
            })
            || self.captions.iter().any(|c| {
                ![c.start_ms, c.end_ms, c.x, c.y].into_iter().all(finite) || c.end_ms <= c.start_ms
            })
        {
            return Err("The export plan has invalid coordinates or timing.".into());
        }
        Ok(())
    }
}

/// Straight-alpha source-over; frame PNGs from the browser use straight alpha.
fn over(dst: &mut Rgba<u8>, src: Rgba<u8>, coverage: f64) {
    let a = src[3] as f64 / 255.0 * coverage.clamp(0.0, 1.0);
    let da = dst[3] as f64 / 255.0;
    let out = a + da * (1.0 - a);
    if out <= 0.0 {
        return;
    }
    for c in 0..3 {
        dst[c] = ((src[c] as f64 * a + dst[c] as f64 * da * (1.0 - a)) / out).round() as u8;
    }
    dst[3] = (out * 255.0).round() as u8;
}

fn sample(image: &RgbaImage, x: f64, y: f64) -> Rgba<u8> {
    // Bilinear interpolation in premultiplied alpha avoids dark fringes on the cursor.
    let x = x.clamp(0.0, image.width().saturating_sub(1) as f64);
    let y = y.clamp(0.0, image.height().saturating_sub(1) as f64);
    let (x0, y0) = (x.floor() as u32, y.floor() as u32);
    let (dx, dy) = (x - x.floor(), y - y.floor());
    let points = [
        (x0, y0, (1.0 - dx) * (1.0 - dy)),
        ((x0 + 1).min(image.width() - 1), y0, dx * (1.0 - dy)),
        (x0, (y0 + 1).min(image.height() - 1), (1.0 - dx) * dy),
        (
            (x0 + 1).min(image.width() - 1),
            (y0 + 1).min(image.height() - 1),
            dx * dy,
        ),
    ];
    let mut rgba = [0.0; 4];
    for (px, py, w) in points {
        let p = image.get_pixel(px, py);
        let a = p[3] as f64 / 255.0;
        for c in 0..3 {
            rgba[c] += p[c] as f64 * a * w;
        }
        rgba[3] += a * w;
    }
    let mut result = Rgba([0; 4]);
    if rgba[3] > 0.0 {
        for c in 0..3 {
            result[c] = (rgba[c] / rgba[3]).round() as u8;
        }
    }
    result[3] = (rgba[3] * 255.0).round() as u8;
    result
}

fn rounded_coverage(job: &ExportJob, x: f64, y: f64) -> f64 {
    let v = &job.video;
    let r = job.radius.min(v.width / 2.0).min(v.height / 2.0);
    if r <= 0.0 || (!job.round_top_corners && y < v.y + v.height / 2.0) {
        return 1.0;
    }
    let cx = x.clamp(v.x + r, v.x + v.width - r);
    let cy = y.clamp(v.y + r, v.y + v.height - r);
    (r + 0.5 - (x - cx).hypot(y - cy)).clamp(0.0, 1.0)
}

/// Separable, edge-extended Lanczos3 at fractional crop coordinates, matching the
/// macOS exporter's reconstruction filter. Widen the kernel when downsampling.
fn resample(
    source: &RgbaImage,
    job: &ExportJob,
    frame: &[f64],
    bounds: (u32, u32, u32, u32),
) -> RgbaImage {
    let (left, top, right, bottom) = bounds;
    let weights = |count: u32,
                   first: u32,
                   origin: f64,
                   extent: f64,
                   crop: f64,
                   crop_size: f64,
                   limit: u32| {
        let scale = (crop_size / extent).max(1.0);
        (0..count)
            .map(|i| {
                let position =
                    crop + (f64::from(first + i) + 0.5 - origin) * crop_size / extent - 0.5;
                let begin = (position - 3.0 * scale).ceil() as i64;
                let end = (position + 3.0 * scale).floor() as i64;
                let mut taps = Vec::new();
                let mut total = 0.0;
                for index in begin..=end {
                    let x = (position - index as f64) / scale;
                    let sinc = |x: f64| {
                        if x.abs() < 1e-9 {
                            1.0
                        } else {
                            let p = std::f64::consts::PI * x;
                            p.sin() / p
                        }
                    };
                    let w = if x.abs() < 3.0 {
                        sinc(x) * sinc(x / 3.0)
                    } else {
                        0.0
                    };
                    taps.push((index.clamp(0, limit as i64 - 1) as u32, w as f32));
                    total += w;
                }
                for (_, w) in &mut taps {
                    *w /= total as f32;
                }
                taps
            })
            .collect::<Vec<_>>()
    };
    let v = &job.video;
    let width = right - left;
    let height = bottom - top;
    let horizontal = weights(
        width,
        left,
        v.x,
        v.width,
        frame[0],
        frame[2],
        source.width(),
    );
    let vertical = weights(
        height,
        top,
        v.y,
        v.height,
        frame[1],
        frame[3],
        source.height(),
    );
    let min_y = vertical
        .iter()
        .flatten()
        .map(|(y, _)| *y)
        .min()
        .unwrap_or(0);
    let max_y = vertical
        .iter()
        .flatten()
        .map(|(y, _)| *y)
        .max()
        .unwrap_or(0);
    let mut intermediate = vec![[0.0_f32; 3]; width as usize * (max_y - min_y + 1) as usize];
    for y in min_y..=max_y {
        for (x, taps) in horizontal.iter().enumerate() {
            let out = &mut intermediate[(y - min_y) as usize * width as usize + x];
            for &(sx, w) in taps {
                let p = source.get_pixel(sx, y);
                for c in 0..3 {
                    out[c] += p[c] as f32 * w;
                }
            }
        }
    }
    let mut image = RgbaImage::new(width, height);
    for (y, taps) in vertical.iter().enumerate() {
        for x in 0..width {
            let mut rgb = [0.0; 3];
            for &(sy, w) in taps {
                let p = intermediate[(sy - min_y) as usize * width as usize + x as usize];
                for c in 0..3 {
                    rgb[c] += p[c] * w;
                }
            }
            image.put_pixel(
                x,
                y as u32,
                Rgba([
                    rgb[0].round().clamp(0.0, 255.0) as u8,
                    rgb[1].round().clamp(0.0, 255.0) as u8,
                    rgb[2].round().clamp(0.0, 255.0) as u8,
                    255,
                ]),
            );
        }
    }
    image
}

pub fn compose(
    job: &ExportJob,
    frame: &[f64],
    source: &RgbaImage,
    base: &RgbaImage,
    cursor: &RgbaImage,
) -> RgbaImage {
    let mut output = base.clone();
    let v = &job.video;
    let cw = frame[6];
    let ch = cw * cursor.height() as f64 / cursor.width() as f64;
    let left = frame[4] - job.cursor_hotspot_x * cw;
    let top = frame[5] - job.cursor_hotspot_y * ch;
    let xmin = (v.x.floor().max(0.0) as u32).min(job.width);
    let ymin = (v.y.floor().max(0.0) as u32).min(job.height);
    let xmax = ((v.x + v.width).ceil() as u32).min(job.width);
    let ymax = ((v.y + v.height).ceil() as u32).min(job.height);
    let resized = resample(source, job, frame, (xmin, ymin, xmax, ymax));
    for y in ymin..ymax {
        for x in xmin..xmax {
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            let mut pixel = *resized.get_pixel(x - xmin, y - ymin);
            if frame[9] > 0.0 && frame[10] > 0.0 {
                let line = frame[9] * 0.045;
                let radius = (frame[9] - line) / 2.0;
                let distance = (px - frame[7]).hypot(py - frame[8]);
                over(
                    &mut pixel,
                    Rgba([129, 140, 248, 64]),
                    (radius + 0.5 - distance).clamp(0.0, 1.0) * frame[10],
                );
                let coverage =
                    (line / 2.0 + 0.5 - (radius - distance).abs()).clamp(0.0, 1.0) * frame[10];
                over(&mut pixel, Rgba([255, 255, 255, 217]), coverage);
            }
            if cw > 0.0 && ch > 0.0 && px >= left && px < left + cw && py >= top && py < top + ch {
                over(
                    &mut pixel,
                    sample(
                        cursor,
                        (px - left) * cursor.width() as f64 / cw - 0.5,
                        (py - top) * cursor.height() as f64 / ch - 0.5,
                    ),
                    1.0,
                );
            }
            over(
                output.get_pixel_mut(x, y),
                pixel,
                rounded_coverage(job, px, py),
            );
        }
    }
    output
}

pub fn overlay(output: &mut RgbaImage, image: &RgbaImage, x: f64, y: f64) {
    for (sx, sy, p) in image.enumerate_pixels() {
        let (dx, dy) = (x.round() as i64 + sx as i64, y.round() as i64 + sy as i64);
        if dx >= 0 && dy >= 0 && dx < output.width() as i64 && dy < output.height() as i64 {
            over(output.get_pixel_mut(dx as u32, dy as u32), *p, 1.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> ExportJob {
        serde_json::from_value(serde_json::json!({"source":"s","output":"o","width":4,"height":4,"fps":60,
        "baseLayer":"b","cursor":"c","cursorHotspotX":0,"cursorHotspotY":0,"video":{"x":1,"y":1,"width":2,"height":2},
        "radius":0,"roundTopCorners":true,"frames":[[0,0,2,2,0,0,0,0,0,0,0]]})).unwrap()
    }
    #[test]
    fn crop_and_background_follow_plan() {
        let j = job();
        let src = RgbaImage::from_pixel(2, 2, Rgba([200, 100, 50, 255]));
        let base = RgbaImage::from_pixel(4, 4, Rgba([10, 20, 30, 255]));
        let out = compose(&j, &j.frames[0], &src, &base, &src);
        assert_eq!(*out.get_pixel(0, 0), Rgba([10, 20, 30, 255]));
        assert_eq!(*out.get_pixel(1, 1), Rgba([200, 100, 50, 255]));
    }
    #[test]
    fn caption_alpha_and_negative_placement_are_clipped() {
        let mut out = RgbaImage::from_pixel(2, 2, Rgba([0, 0, 0, 255]));
        overlay(
            &mut out,
            &RgbaImage::from_pixel(2, 2, Rgba([200, 0, 0, 128])),
            -1.0,
            -1.0,
        );
        assert_eq!(*out.get_pixel(0, 0), Rgba([100, 0, 0, 255]));
        assert_eq!(*out.get_pixel(1, 1), Rgba([0, 0, 0, 255]));
    }
    #[test]
    fn rejects_broken_render_plans() {
        let mut j = job();
        assert!(j.validate().is_ok());
        j.frames[0][2] = 0.0;
        assert!(j.validate().is_err());
        j.frames[0][2] = 2.0;
        j.start_ms = f64::NAN;
        assert!(j.validate().is_err());
    }
}
