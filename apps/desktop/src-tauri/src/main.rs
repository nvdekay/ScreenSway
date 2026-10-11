// A GUI app on Windows: without this, release builds open a console window that closes
// the app when it is closed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    screensway_lib::run();
}
