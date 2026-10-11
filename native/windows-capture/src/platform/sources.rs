//! Displays and windows that can be recorded. Displays are identified by their device name
//! (`\\.\DISPLAY1`), windows by their handle; both stay valid across processes.

use crate::model::CaptureSource;
use windows::core::{BOOL, Result};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GA_ROOT, GWL_EXSTYLE, MONITORINFOF_PRIMARY,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

pub struct Display {
    pub id: String,
    pub monitor: HMONITOR,
    /// Physical pixels on the virtual screen.
    pub bounds: RECT,
    pub scale: f64,
    pub primary: bool,
}

pub struct Window {
    pub hwnd: HWND,
    pub title: String,
    /// The visible frame in physical pixels, without the invisible resize borders.
    pub bounds: RECT,
    pub scale: f64,
}

/// Windows smaller than this (in logical pixels) are toolbars and popups, not recordable apps.
const MINIMUM_WINDOW_SIZE: (f64, f64) = (240.0, 160.0);

pub fn list() -> Result<Vec<CaptureSource>> {
    let displays = displays()?.into_iter().enumerate().map(|(index, display)| {
        let (width, height) = size(&display.bounds);
        CaptureSource {
            id: display.id,
            kind: "display".into(),
            name: format!("Display {}", index + 1),
            width: (f64::from(width) / display.scale).round() as u32,
            height: (f64::from(height) / display.scale).round() as u32,
            pixel_scale: display.scale,
        }
    });
    let windows = windows().into_iter().map(|window| {
        let (width, height) = size(&window.bounds);
        CaptureSource {
            id: (window.hwnd.0 as usize).to_string(),
            kind: "window".into(),
            name: window.title,
            width: (f64::from(width) / window.scale).round() as u32,
            height: (f64::from(height) / window.scale).round() as u32,
            pixel_scale: window.scale,
        }
    });
    Ok(displays.chain(windows).collect())
}

pub fn size(rect: &RECT) -> (u32, u32) {
    ((rect.right - rect.left).max(0) as u32, (rect.bottom - rect.top).max(0) as u32)
}

/// The primary display comes first, so it is the default choice.
pub fn displays() -> Result<Vec<Display>> {
    unsafe extern "system" fn visit(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let displays = unsafe { &mut *(data.0 as *mut Vec<Display>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo as *mut MONITORINFO) }.as_bool() {
            let (mut dpi_x, mut dpi_y) = (96, 96);
            let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
            displays.push(Display {
                id: wide_to_string(&info.szDevice),
                monitor,
                bounds: info.monitorInfo.rcMonitor,
                scale: f64::from(dpi_x.max(96)) / 96.0,
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        true.into()
    }

    let mut displays: Vec<Display> = Vec::new();
    unsafe { EnumDisplayMonitors(None, None, Some(visit), LPARAM(&mut displays as *mut _ as isize)) }.ok()?;
    displays.sort_by_key(|display| !display.primary);
    Ok(displays)
}

pub fn find_display(id: Option<&str>) -> Result<Option<Display>> {
    let mut displays = displays()?;
    let index = id
        .and_then(|id| displays.iter().position(|display| display.id == id))
        .unwrap_or(0);
    Ok((index < displays.len()).then(|| displays.swap_remove(index)))
}

/// Top-level windows a person would recognize as an app, front to back.
pub fn windows() -> Vec<Window> {
    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        let state = unsafe { &mut *(data.0 as *mut (Vec<Window>, Option<u32>)) };
        if let Some(window) = recordable_window(hwnd, state.1) {
            state.0.push(window);
        }
        true.into()
    }

    // ScreenSway's own windows are never offered.
    let mut state: (Vec<Window>, Option<u32>) = (Vec::new(), super::parent_process_id());
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut state as *mut _ as isize)) };
    state.0
}

pub fn window(hwnd: HWND) -> Option<Window> {
    recordable_window(hwnd, None)
}

fn recordable_window(hwnd: HWND, excluded_process: Option<u32>) -> Option<Window> {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || GetAncestor(hwnd, GA_ROOT) != hwnd {
            return None;
        }
        let extended_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if extended_style & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) != 0 {
            return None;
        }
        // Suspended UWP apps and windows on other virtual desktops are "cloaked": present but invisible.
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as _, size_of::<u32>() as u32);
        if cloaked != 0 {
            return None;
        }
        let mut class = [0u16; 64];
        let class_length = GetClassNameW(hwnd, &mut class) as usize;
        let class = wide_to_string(&class[..class_length]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            return None;
        }
        if let Some(excluded) = excluded_process {
            let mut process = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut process));
            if process == excluded {
                return None;
            }
        }
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return None;
        }
        let mut title = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut title) as usize;
        let title = wide_to_string(&title[..copied]);
        if title.trim().is_empty() {
            return None;
        }

        let mut bounds = RECT::default();
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut bounds as *mut _ as _,
            size_of::<RECT>() as u32,
        )
        .ok()?;
        let scale = f64::from(GetDpiForWindow(hwnd).max(96)) / 96.0;
        let (width, height) = size(&bounds);
        if f64::from(width) / scale < MINIMUM_WINDOW_SIZE.0 || f64::from(height) / scale < MINIMUM_WINDOW_SIZE.1 {
            return None;
        }
        Some(Window { hwnd, title, bounds, scale })
    }
}

pub fn wide_to_string(wide: &[u16]) -> String {
    let end = wide.iter().position(|&unit| unit == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end])
}
