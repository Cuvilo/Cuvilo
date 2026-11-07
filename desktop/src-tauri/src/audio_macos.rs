use super::*;
use crate::types::{now_ms, AudioSource};
use anyhow::Result;
use std::time::Duration;
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

mod mac_native {
    use std::ffi::{c_char, c_void};

    pub type MacAudioDataCallback = extern "C" fn(
        pcm: *const u8,
        length: usize,
        level: f32,
        context: *mut c_void,
    );

    pub type MacAudioErrorCallback = extern "C" fn(
        error_msg: *const c_char,
        context: *mut c_void,
    );

    unsafe extern "C" {
        pub fn mac_start_system_audio_capture(
            data_cb: MacAudioDataCallback,
            error_cb: MacAudioErrorCallback,
            context: *mut c_void,
            error_out: *mut *mut c_char,
        ) -> *mut c_void;
        pub fn mac_stop_system_audio_capture(handle: *mut c_void);
        pub fn mac_start_mic_audio_capture(
            data_cb: MacAudioDataCallback,
            error_cb: MacAudioErrorCallback,
            context: *mut c_void,
            error_out: *mut *mut c_char,
        ) -> *mut c_void;
        pub fn mac_stop_mic_audio_capture(handle: *mut c_void);
        pub fn mac_audio_free_string(s: *mut c_char);
    }
}

struct AudioBridgeContext {
    frames: mpsc::Sender<Frame>,
    notices: mpsc::UnboundedSender<Notice>,
    source: String,
}

extern "C" fn on_audio_data(
    pcm: *const u8,
    length: usize,
    level: f32,
    context: *mut std::ffi::c_void,
) {
    if context.is_null() || pcm.is_null() || length == 0 {
        return;
    }
    let ctx = unsafe { &*(context as *const AudioBridgeContext) };
    let slice = unsafe { std::slice::from_raw_parts(pcm, length) };
    let _ = ctx.frames.try_send(Frame {
        pcm: slice.to_vec(),
        source: ctx.source.clone(),
        level,
        at: now_ms(),
    });
}

extern "C" fn on_audio_error(
    error_msg: *const std::ffi::c_char,
    context: *mut std::ffi::c_void,
) {
    if context.is_null() || error_msg.is_null() {
        return;
    }
    let ctx = unsafe { &*(context as *const AudioBridgeContext) };
    let msg = unsafe { std::ffi::CStr::from_ptr(error_msg) }
        .to_string_lossy()
        .into_owned();
    let _ = ctx.notices.send(Notice {
        source: ctx.source.clone(),
        message: msg,
        error: true,
    });
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

        let context = Box::new(AudioBridgeContext {
            frames,
            notices: notices.clone(),
            source: label.into(),
        });
        let context_ptr = Box::into_raw(context);

        let mut error_ptr: *mut std::ffi::c_char = std::ptr::null_mut();
        let handle = if is_mic {
            unsafe {
                mac_native::mac_start_mic_audio_capture(
                    on_audio_data,
                    on_audio_error,
                    context_ptr as *mut std::ffi::c_void,
                    &mut error_ptr,
                )
            }
        } else {
            unsafe {
                mac_native::mac_start_system_audio_capture(
                    on_audio_data,
                    on_audio_error,
                    context_ptr as *mut std::ffi::c_void,
                    &mut error_ptr,
                )
            }
        };

        if handle.is_null() {
            let err_msg = if !error_ptr.is_null() {
                let s = unsafe { std::ffi::CStr::from_ptr(error_ptr) }.to_string_lossy().into_owned();
                unsafe { mac_native::mac_audio_free_string(error_ptr) };
                if s == "permission_denied" {
                    "macOS 需要屏幕与系统音频录制权限：请在【系统设置】->【隐私与安全性】->【录屏与系统录音】中允许 Cuvilo。若已显示在列表中，请先选中并点击底部的减号（-）移除后重新勾选，开启后请完全退出（Cmd+Q）并重启软件。".to_string()
                } else {
                    format!("启动系统音频采集失败：{}", s)
                }
            } else {
                "启动系统音频采集失败".to_string()
            };
            let _ = notices.send(Notice {
                source: label.into(),
                message: err_msg,
                error: true,
            });
            unsafe { drop(Box::from_raw(context_ptr)) };
            return;
        }

        let _ = notices.send(Notice {
            source: label.into(),
            message: "音频采集已启动".into(),
            error: false,
        });

        while !cancel.is_cancelled() {
            std::thread::sleep(Duration::from_millis(50));
        }

        if is_mic {
            unsafe { mac_native::mac_stop_mic_audio_capture(handle) };
        } else {
            unsafe { mac_native::mac_stop_system_audio_capture(handle) };
        }

        unsafe { drop(Box::from_raw(context_ptr)) };
    });
}
