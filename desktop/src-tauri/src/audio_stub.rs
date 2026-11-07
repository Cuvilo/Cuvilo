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
    _source: AudioSource,
    mic: bool,
    cancel: CancellationToken,
    frames: mpsc::Sender<Frame>,
    notices: mpsc::UnboundedSender<Notice>,
) {
    std::thread::spawn(move || {
        let label = if mic { "microphone" } else { "meeting" };
        let _ = notices.send(Notice {
            source: label.into(),
            message: "音频采集已启动".into(),
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
