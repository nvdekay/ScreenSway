//! Local Windows export: shared camera plan -> compositor -> GPU NV12 -> H.264 MP4.
use super::{
    capture::{Converter, Gpu, CAPTURE_FORMAT},
    encoder::Encoder,
    reader, Step,
};
use crate::render::{self, ExportJob, ExportResult};
use std::path::Path;
use windows::Win32::Graphics::Direct3D11::{D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE};

pub fn run(path: &Path) -> Result<ExportResult, String> {
    let mut job: ExportJob = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    job.validate()?;
    let output = Path::new(&job.output);
    if Path::new(&job.source) == output {
        return Err("The export cannot overwrite its source recording.".into());
    }
    let base = image::open(&job.base_layer)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let cursor = image::open(&job.cursor)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    if base.dimensions() != (job.width, job.height) {
        return Err("Export background size does not match the video.".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = output.with_extension("video.mp4");
    let start = (job.start_ms * 10_000.0).round() as i64;
    let mut source = reader::VideoReader::new(Path::new(&job.source), start)?;
    if job.source_width == 0 || job.source_height == 0 {
        (job.source_width, job.source_height) = (source.width, source.height);
    }
    let mut camera = match &job.camera {
        Some(camera) => Some(reader::VideoReader::new(Path::new(&camera.path), 0)?),
        None => None,
    };
    let gpu = Gpu::new()?;
    let converter = Converter::new(&gpu, (job.width, job.height), (job.width, job.height))?;
    let mut encoder = Encoder::new(&temporary, &gpu, job.width, job.height)?;
    let texture = gpu
        .texture(
            job.width,
            job.height,
            CAPTURE_FORMAT,
            D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE,
        )
        .step("Creating export texture")?;
    let mut loaded_captions = std::collections::HashMap::<usize, image::RgbaImage>::new();
    let mut reported = usize::MAX;
    for (index, plan) in job.frames.iter().enumerate() {
        let time = index as i64 * 10_000_000 / job.fps as i64;
        let source_time = job.source_times_ms.get(index).map(|ms| (ms * 10_000.0).round() as i64).unwrap_or(start + time);
        let frame = source.frame(source_time)?;
        let mut composed = render::compose(&job, plan, frame, &base, &cursor);
        if let (Some(reader), Some(placement)) = (camera.as_mut(), job.camera.as_ref()) {
            let camera_time = source_time - (placement.offset_ms * 10_000.0).round() as i64;
            render::overlay_camera(&mut composed, reader.frame(camera_time)?, placement);
        }
        let ms = time as f64 / 10_000.0;
        for (ci, c) in job
            .captions
            .iter()
            .enumerate()
            .filter(|(_, c)| c.start_ms <= ms && ms < c.end_ms)
        {
            if !loaded_captions.contains_key(&ci) { loaded_captions.insert(ci, image::open(&c.image).map_err(|e| e.to_string())?.to_rgba8()); }
            render::overlay(&mut composed, loaded_captions.get(&ci).unwrap(), c.x, c.y);
        }
        // Only the overlays still to come stay in memory.
        loaded_captions.retain(|ci, _| job.captions[*ci].end_ms > ms);
        // Media Foundation RGB textures use BGRA byte order.
        for p in composed.pixels_mut() {
            p.0.swap(0, 2);
        }
        unsafe {
            gpu.context.UpdateSubresource(
                &texture,
                0,
                None,
                composed.as_ptr() as _,
                job.width * 4,
                0,
            );
        }
        let nv12 = converter
            .convert(&gpu, &texture, (job.width, job.height))
            .step("Converting export frame")?;
        encoder.write(&nv12, time).step("Encoding export frame")?;
        let percent = (index + 1) * 95 / job.frames.len();
        if percent != reported {
            reported = percent;
            eprintln!("SCREENSWAY_PROGRESS {percent}");
        }
    }
    let duration = job.frames.len() as i64 * 10_000_000 / job.fps as i64;
    encoder.finish(duration).step("Finishing exported video")?;
    let audio_ranges = if job.source_ranges.is_empty() {
        vec![(start, start + duration)]
    } else {
        job.source_ranges.iter().map(|range| ((range.start_ms * 10_000.0).round() as i64, (range.end_ms * 10_000.0).round() as i64)).collect()
    };
    super::mux::with_source_audio(&temporary, Path::new(&job.source), output, &audio_ranges, (job.lead_in_ms * 10_000.0).round() as i64, &mut || {})?;
    std::fs::remove_file(&temporary).map_err(|e| e.to_string())?;
    eprintln!("SCREENSWAY_PROGRESS 100");
    Ok(ExportResult {
        output_path: job.output,
        duration_ms: ((duration + 5_000) / 10_000) as u64,
        width: job.width,
        height: job.height,
    })
}
