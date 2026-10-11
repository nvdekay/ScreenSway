fn main() {
    // `capture`: platforms with a native capture helper (macOS and Windows).
    println!("cargo::rustc-check-cfg=cfg(capture)");
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target == "macos" || target == "windows" {
        println!("cargo:rustc-cfg=capture");
    }
    tauri_build::build()
}
