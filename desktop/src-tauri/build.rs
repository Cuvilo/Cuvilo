fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/macos_audio.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-mmacosx-version-min=13.0")
            .compile("cuvilo_macos_audio");
        for framework in [
            "Foundation",
            "AppKit",
            "Vision",
            "AVFoundation",
            "CoreMedia",
            "ScreenCaptureKit",
            "CoreGraphics",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rerun-if-changed=native/macos_audio.m");
    }
    tauri_build::build();
}
