pub struct Frame {
    pub pcm: Vec<u8>,
    pub source: String,
    pub level: f32,
    pub at: i64,
}

#[derive(Clone)]
pub struct Notice {
    pub source: String,
    pub message: String,
    pub error: bool,
}

// The process-loopback API also works on updated Windows 10 2004+ builds.
// Do not reject 19041-19045 based only on the SDK documentation's 20348 label.
pub fn process_capture_candidate(build: Option<u32>) -> bool {
    build.map_or(true, |value| value >= 19041)
}

#[cfg(target_os = "windows")]
#[path = "audio_windows.rs"]
mod implementation;

#[cfg(target_os = "macos")]
#[path = "audio_macos.rs"]
mod implementation;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[path = "audio_stub.rs"]
mod implementation;

pub use implementation::*;

#[cfg(test)]
mod process_support_tests {
    use super::*;
    #[test]
    fn updated_windows_10_is_not_rejected_by_the_sdk_version_label() {
        for build in [19041, 19044, 19045, 20348, 22000, 26100] {
            assert!(process_capture_candidate(Some(build)), "build {build} must reach runtime activation");
        }
        for build in [17763, 18363] {
            assert!(!process_capture_candidate(Some(build)));
        }
        assert!(process_capture_candidate(None), "an unknown version must be determined by runtime activation");
    }
}
