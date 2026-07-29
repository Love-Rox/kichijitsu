fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            // ここに列挙した名前から allow-*/deny-* の permission が生成される
            // (capabilities/remote.json が参照する allow-gh-api 等)。#[tauri::command] を
            // 足したらこの配列にも足すこと ―― 足し忘れると capability 側が
            // 「Permission allow-… not found」でビルドを落とす。
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "gh_api",
                "app_version",
                "validate_gh_path",
            ])),
    )
    .expect("failed to run tauri-build");
}
