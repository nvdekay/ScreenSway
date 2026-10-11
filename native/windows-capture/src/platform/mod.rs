//! Windows implementation: Windows.Graphics.Capture for frames, Direct3D 11 for color
//! conversion, Media Foundation for H.264.

mod capture;
mod encoder;
pub mod recorder;
pub mod sources;
mod thumbnail;

use windows::core::Result;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

/// Physical pixels everywhere (cursor, monitors, windows), and COM/WinRT for the capture APIs.
pub fn initialize() -> Result<()> {
    unsafe {
        // Fails harmlessly when a manifest already set it.
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        RoInitialize(RO_INIT_MULTITHREADED)
    }
}

/// The performance counter in 100 ns ticks: the clock of Windows.Graphics.Capture frame times.
pub fn now() -> i64 {
    let mut counter = 0;
    let mut frequency = 1;
    unsafe {
        let _ = QueryPerformanceCounter(&mut counter);
        let _ = QueryPerformanceFrequency(&mut frequency);
    }
    (i128::from(counter) * 10_000_000 / i128::from(frequency.max(1))) as i64
}

pub fn parent_process_id() -> Option<u32> {
    let own = unsafe { GetCurrentProcessId() };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut parent = None;
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while found {
        if entry.th32ProcessID == own {
            parent = Some(entry.th32ParentProcessID);
            break;
        }
        found = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    parent
}

/// Watches the process that started the helper, so a recording ends when ScreenSway quits.
pub struct ParentWatch(Option<HANDLE>);

impl ParentWatch {
    pub fn new() -> Self {
        Self(parent_process_id().and_then(|id| unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, id) }.ok()))
    }

    pub fn has_exited(&self) -> bool {
        self.0.is_some_and(|handle| unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0)
    }
}

impl Drop for ParentWatch {
    fn drop(&mut self) {
        if let Some(handle) = self.0 {
            unsafe {
                let _ = CloseHandle(handle);
            }
        }
    }
}
