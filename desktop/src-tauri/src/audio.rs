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
        let mut list = vec![
            AudioSource {
                process_capture_supported: Some(true),
                id: "system".into(),
                name: "全部系统声音 (ScreenCaptureKit 免驱动)".into(),
                kind: "system".into(),
                pid: None,
                recommended: true,
            },
            AudioSource {
                process_capture_supported: Some(false),
                id: "mic".into(),
                name: "内置麦克风 (环境与外放拾音)".into(),
                kind: "process".into(),
                pid: None,
                recommended: false,
            },
        ];
        if std::path::Path::new("/Library/Audio/Plug-Ins/HAL/BlackHole.driver").exists()
            || std::path::Path::new("/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver").exists()
        {
            list.push(AudioSource {
                process_capture_supported: Some(false),
                id: "blackhole".into(),
                name: "BlackHole 虚拟音频通道".into(),
                kind: "process".into(),
                pid: None,
                recommended: false,
            });
        }
        Ok(list)
    }

    fn helper_binary() -> Option<std::path::PathBuf> {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let candidates = [
                    dir.join("cuvilo-audio-capture"),
                    dir.join("../Resources/bin/cuvilo-audio-capture"),
                    dir.join("../Resources/cuvilo-audio-capture"),
                ];
                for candidate in candidates {
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
        let dev = std::path::PathBuf::from("src-tauri/bin/cuvilo-audio-capture");
        if dev.exists() {
            return Some(dev);
        }
        let dev_alt = std::path::PathBuf::from("bin/cuvilo-audio-capture");
        if dev_alt.exists() {
            return Some(dev_alt);
        }
        None
    }

    pub fn spawn(
        _source: AudioSource,
        mic: bool,
        cancel: CancellationToken,
        frames: mpsc::Sender<Frame>,
        notices: mpsc::UnboundedSender<Notice>,
    ) {
        std::thread::spawn(move || {
            let is_mic = mic || _source.id == "mic";
            let label = if mic { "microphone" } else { "meeting" };
            let _ = notices.send(Notice {
                source: label.into(),
                message: "音频采集已启动".into(),
                error: false,
            });
            let bin = helper_binary();
            let mode = if is_mic { "mic" } else { "system" };
            if let Some(path) = bin {
                if let Ok(mut child) = std::process::Command::new(&path)
                    .args(["--mode", mode])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                {
                    if let Some(mut stdout) = child.stdout.take() {
                        let mut buf = [0u8; 1280];
                        use std::io::Read;
                        while !cancel.is_cancelled() {
                            match stdout.read_exact(&mut buf) {
                                Ok(()) => {
                                    let level = buf
                                        .chunks_exact(2)
                                        .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs() as f32 / 32768.0)
                                        .fold(0.0, f32::max);
                                    let _ = frames.try_send(Frame {
                                        pcm: buf.to_vec(),
                                        source: label.into(),
                                        level,
                                        at: now_ms(),
                                    });
                                }
                                Err(_) => break,
                            }
                        }
                    }
                    let mut stderr_output = String::new();
                    if let Some(mut stderr) = child.stderr.take() {
                        use std::io::Read;
                        let _ = stderr.read_to_string(&mut stderr_output);
                    }
                    let _ = child.kill();
                    if !cancel.is_cancelled() && !stderr_output.is_empty() {
                        let msg = if stderr_output.contains("ScreenCaptureKit") {
                            "macOS 需要屏幕与系统音频录制权限，请在【系统设置】->【隐私与安全性】->【屏幕与系统音频录制】中允许 Cuvilo"
                        } else if stderr_output.contains("Microphone") {
                            "macOS 需要麦克风权限，请在【系统设置】->【隐私与安全性】->【麦克风】中允许 Cuvilo"
                        } else {
                            "音频采集异常退出，请检查系统音频权限"
                        };
                        let _ = notices.send(Notice {
                            source: label.into(),
                            message: msg.into(),
                            error: true,
                        });
                    }
                    return;
                }
            }
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
