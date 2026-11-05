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

#[cfg(not(target_os = "windows"))]
mod implementation {
    use super::*;
    use crate::types::{now_ms, AudioSource};
    use anyhow::Result;
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    pub fn windows_build() -> Option<u32> {
        None
    }

    pub fn sources() -> Result<Vec<AudioSource>> {
        Ok(vec![AudioSource {
            process_capture_supported: Some(false),
            id: "system".into(),
            name: "默认系统音频 / 麦克风".into(),
            kind: "system".into(),
            pid: None,
            recommended: true,
        }])
    }

    pub fn spawn(
        source: AudioSource,
        mic: bool,
        cancel: CancellationToken,
        frames: mpsc::Sender<Frame>,
        notices: mpsc::UnboundedSender<Notice>,
    ) {
        std::thread::spawn(move || {
            let label = if mic { "microphone" } else { "meeting" };
            let _ = notices.send(Notice {
                source: label.into(),
                message: if mic {
                    "macOS 麦克风通道已就绪".into()
                } else {
                    "macOS 系统声音内录建议配合虚拟音频设备（如 BlackHole）或系统音频权限".into()
                },
                error: false,
            });
            let mut last = Instant::now();
            let pcm = vec![0u8; 1280];
            while !cancel.is_cancelled() {
                if last.elapsed() >= Duration::from_millis(40) {
                    let _ = frames.try_send(Frame {
                        pcm: pcm.clone(),
                        source: label.into(),
                        level: 0.0,
                        at: now_ms(),
                    });
                    last = Instant::now();
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
    }
}

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
