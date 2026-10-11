//! The library's preview image, written with the Windows Imaging Component.

use super::capture::Gpu;
use windows::core::{Result, HSTRING};
use windows::Win32::Foundation::GENERIC_WRITE;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};

/// The same bounds as the macOS helper's thumbnails.
const MAXIMUM_SIZE: (f64, f64) = (960.0, 600.0);

/// Saves the `content` area of a BGRA texture as a JPEG no larger than 960 × 600.
pub fn write(gpu: &Gpu, texture: &ID3D11Texture2D, content: (u32, u32), path: &std::path::Path) -> Result<()> {
    let (staging, mapped) = gpu.read_back(texture)?;
    let result = encode(&mapped, content, path);
    gpu.unmap(&staging);
    result
}

fn encode(
    mapped: &windows::Win32::Graphics::Direct3D11::D3D11_MAPPED_SUBRESOURCE,
    (width, height): (u32, u32),
    path: &std::path::Path,
) -> Result<()> {
    let scale = (MAXIMUM_SIZE.0 / f64::from(width.max(1))).min(MAXIMUM_SIZE.1 / f64::from(height.max(1))).min(1.0);
    let target = (
        ((f64::from(width) * scale).round() as u32).max(1),
        ((f64::from(height) * scale).round() as u32).max(1),
    );
    let stride = mapped.RowPitch;
    let length = (stride * (height - 1) + width * 4) as usize;
    let pixels = unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, length) };

    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let bitmap = factory.CreateBitmapFromMemory(width, height, &GUID_WICPixelFormat32bppBGRA, stride, pixels)?;
        let scaler = factory.CreateBitmapScaler()?;
        scaler.Initialize(&bitmap, target.0, target.1, WICBitmapInterpolationModeFant)?;
        let converter = factory.CreateFormatConverter()?;
        converter.Initialize(
            &scaler,
            &GUID_WICPixelFormat24bppBGR,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;

        let stream = factory.CreateStream()?;
        stream.InitializeFromFilename(&HSTRING::from(path.as_os_str()), GENERIC_WRITE.0)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        encoder.CreateNewFrame(&mut frame, std::ptr::null_mut())?;
        let frame = frame.expect("CreateNewFrame returned no frame");
        frame.Initialize(None)?;
        frame.SetSize(target.0, target.1)?;
        let mut format = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut format)?;
        frame.WriteSource(&converter, std::ptr::null())?;
        frame.Commit()?;
        encoder.Commit()?;
    }
    Ok(())
}
