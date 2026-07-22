fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["gh_api", "app_version"])),
    )
    .expect("failed to run tauri-build");
}
