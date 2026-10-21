//! Direct3D 11 resources shared by capture and encoding, and the GPU color conversion from
//! the captured BGRA frames to the NV12 the H.264 encoders take.

use super::Step;
use windows::core::{Interface, Result};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT,
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;

pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    /// The same device for Windows.Graphics.Capture.
    pub capture_device: IDirect3DDevice,
}

// Direct3D 11 devices are free-threaded and the immediate context is protected by
// ID3D11Multithread below, so the frame callback and the main thread can share them.
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

impl Gpu {
    pub fn new() -> std::result::Result<Self, String> {
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .step("Creating the Direct3D 11 device")?;
        }
        let device: ID3D11Device = device.expect("D3D11CreateDevice returned no device");
        let context = context.expect("D3D11CreateDevice returned no context");
        // Media Foundation's encoder uses the device from its own threads.
        unsafe {
            let _ = device.cast::<ID3D11Multithread>().step("Enabling Direct3D multithreading")?.SetMultithreadProtected(true);
        }
        let dxgi_device = device.cast::<IDXGIDevice>().step("Getting the DXGI device")?;
        let capture_device = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }
            .and_then(|device| device.cast())
            .step("Sharing the Direct3D device with Windows.Graphics.Capture")?;
        Ok(Self { device, context, capture_device })
    }

    pub fn texture(&self, width: u32, height: u32, format: DXGI_FORMAT, bind: D3D11_BIND_FLAG) -> Result<ID3D11Texture2D> {
        let description = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { self.device.CreateTexture2D(&description, None, Some(&mut texture))? };
        Ok(texture.expect("CreateTexture2D returned no texture"))
    }

    /// A copy the CPU can read, for the thumbnail.
    pub fn read_back(&self, texture: &ID3D11Texture2D) -> Result<(ID3D11Texture2D, D3D11_MAPPED_SUBRESOURCE)> {
        let mut description = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut description) };
        description.Usage = D3D11_USAGE_STAGING;
        description.BindFlags = 0;
        description.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        description.MiscFlags = 0;
        let mut staging = None;
        unsafe { self.device.CreateTexture2D(&description, None, Some(&mut staging))? };
        let staging = staging.expect("CreateTexture2D returned no texture");
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context.CopyResource(&staging, texture);
            self.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }
        Ok((staging, mapped))
    }

    pub fn unmap(&self, staging: &ID3D11Texture2D) {
        unsafe { self.context.Unmap(staging, 0) };
    }
}

pub fn texture_size(texture: &ID3D11Texture2D) -> (u32, u32) {
    let mut description = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut description) };
    (description.Width, description.Height)
}

/// Scales and converts BGRA frames to NV12 (BT.709, studio range) with the GPU's video
/// processor, the same color setup as the macOS recorder.
pub struct Converter {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    output: (u32, u32),
    source_rect: RECT,
}

impl Converter {
    pub fn new(gpu: &Gpu, input: (u32, u32), output: (u32, u32)) -> std::result::Result<Self, String> {
        Self::new_cropped(gpu, input, RECT { left: 0, top: 0, right: input.0 as i32, bottom: input.1 as i32 }, output)
    }

    pub fn new_cropped(gpu: &Gpu, input: (u32, u32), source_rect: RECT, output: (u32, u32)) -> std::result::Result<Self, String> {
        // Missing on GPUs without video support, such as Microsoft's basic display driver.
        let video_device: ID3D11VideoDevice = gpu.device.cast().step("Opening the GPU video processor (ID3D11VideoDevice)")?;
        let video_context: ID3D11VideoContext =
            gpu.context.cast().step("Opening the GPU video processor (ID3D11VideoContext)")?;
        let rate = DXGI_RATIONAL { Numerator: 60, Denominator: 1 };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: input.0,
            InputHeight: input.1,
            OutputFrameRate: rate,
            OutputWidth: output.0,
            OutputHeight: output.1,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&content) }
            .step(&format!("Creating the GPU color converter ({}×{} → {}×{})", input.0, input.1, output.0, output.1))?;
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }.step("Creating the GPU color converter")?;
        unsafe {
            if let Ok(context) = video_context.cast::<ID3D11VideoContext1>() {
                context.VideoProcessorSetStreamColorSpace1(&processor, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
                context.VideoProcessorSetOutputColorSpace1(&processor, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
            } else {
                // Usage 0, full-range RGB in; BT.709 matrix and 16–235 range out.
                video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 });
                video_context
                    .VideoProcessorSetOutputColorSpace(&processor, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: (1 << 2) | (1 << 4) });
            }
            // Studio-range black around a window that no longer fills the frame.
            let black = D3D11_VIDEO_COLOR {
                Anonymous: D3D11_VIDEO_COLOR_0 { YCbCr: D3D11_VIDEO_COLOR_YCbCrA { Y: 0.0625, Cb: 0.5, Cr: 0.5, A: 1.0 } },
            };
            video_context.VideoProcessorSetOutputBackgroundColor(&processor, true, &black);
            video_context.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            // Captured frames are opaque; never let the processor blend or auto-enhance them.
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
        }
        Ok(Self { video_device, video_context, enumerator, processor, output, source_rect })
    }

    /// Draws the `content` area of `source` into a new NV12 texture, scaled to fit while
    /// keeping its aspect ratio. A new texture per frame: the encoder may still be reading
    /// the previous one.
    pub fn convert(&self, gpu: &Gpu, source: &ID3D11Texture2D, content: (u32, u32)) -> Result<ID3D11Texture2D> {
        let target = gpu.texture(self.output.0, self.output.1, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET)?;
        let input_description = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
            },
        };
        let output_description = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
        };
        let mut input = None;
        let mut output = None;
        unsafe {
            self.video_device
                .CreateVideoProcessorInputView(source, &self.enumerator, &input_description, Some(&mut input))?;
            self.video_device
                .CreateVideoProcessorOutputView(&target, &self.enumerator, &output_description, Some(&mut output))?;
        }
        let output = output.expect("CreateVideoProcessorOutputView returned no view");

        let source_rect = RECT {
            left: self.source_rect.left.min(content.0.saturating_sub(1) as i32),
            top: self.source_rect.top.min(content.1.saturating_sub(1) as i32),
            right: self.source_rect.right.min(content.0 as i32),
            bottom: self.source_rect.bottom.min(content.1 as i32),
        };
        let cropped = ((source_rect.right - source_rect.left).max(1) as u32, (source_rect.bottom - source_rect.top).max(1) as u32);
        let destination = fit(cropped, self.output);
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: std::mem::ManuallyDrop::new(input),
            ..Default::default()
        };
        let result = unsafe {
            self.video_context.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&source_rect));
            self.video_context.VideoProcessorSetStreamDestRect(&self.processor, 0, true, Some(&destination));
            self.video_context.VideoProcessorBlt(&self.processor, &output, 0, std::slice::from_ref(&stream))
        };
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        result?;
        Ok(target)
    }
}

/// The largest rectangle with the content's aspect ratio, centered in the output.
fn fit(content: (u32, u32), output: (u32, u32)) -> RECT {
    let (content_width, content_height) = (f64::from(content.0.max(1)), f64::from(content.1.max(1)));
    let (output_width, output_height) = (f64::from(output.0), f64::from(output.1));
    let scale = (output_width / content_width).min(output_height / content_height);
    let (width, height) = (content_width * scale, content_height * scale);
    let left = ((output_width - width) / 2.0).round() as i32;
    let top = ((output_height - height) / 2.0).round() as i32;
    RECT { left, top, right: left + width.round() as i32, bottom: top + height.round() as i32 }
}

pub const CAPTURE_FORMAT: DXGI_FORMAT = DXGI_FORMAT_B8G8R8A8_UNORM;
