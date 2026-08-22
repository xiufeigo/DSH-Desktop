fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&[
            "startup_interactive",
            "show_desktop_notification",
        ]));
    tauri_build::try_build(attributes).expect("failed to build Tauri application manifest")
}
