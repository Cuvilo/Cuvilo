use crate::{
    capture_protection,
    core::Core,
    taskbar,
    types::{now_ms, Session, StartOptions},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

#[derive(Default)]
pub struct Mode {
    immersive: AtomicBool,
}

pub fn active(app: &tauri::AppHandle) -> bool {
    app.state::<Mode>().immersive.load(Ordering::SeqCst)
}
fn set_active(app: &tauri::AppHandle, value: bool) {
    app.state::<Mode>().immersive.store(value, Ordering::SeqCst);
}
pub fn sync_shell(app: &tauri::AppHandle) -> Result<(), String> {
    let immersive = active(app);
    taskbar::apply_visible(app, immersive)?;
    app.tray_by_id("main")
        .ok_or("托盘入口不存在")?
        .set_visible(!immersive)
        .map_err(|error| error.to_string())?;
    let settings=app.state::<Arc<Core>>().settings.lock().unwrap().clone();
    crate::shortcuts(app,&settings)
}
pub fn restore_labels(app: &tauri::AppHandle, labels: &[String]) -> Vec<String> {
    if active(app) {
        vec!["answer".into()]
    } else if labels.is_empty() {
        vec![]
    } else {
        vec!["main".into()]
    }
}
fn capture_ready(
    events: &std::collections::VecDeque<serde_json::Value>,
    id: &str,
    microphone: bool,
) -> Result<bool, String> {
    let mut meeting = false;
    let mut mic = !microphone;
    for event in events.iter().filter(|event| event["sessionId"] == id) {
        let message = event["message"].as_str().unwrap_or("");
        if event["error"] == true && message.starts_with("采音停止：") {
            return Err(message.into());
        }
        if message == "音频采集已启动" {
            match event["source"].as_str() {
                Some("meeting") => meeting = true,
                Some("microphone") => mic = true,
                _ => {}
            }
        }
    }
    Ok(meeting && mic)
}
async fn wait_for_capture(core: &Core, id: &str, microphone: bool) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if capture_ready(&core.status_events.lock().unwrap(), id, microphone)? {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("音频采集启动超时，请检查音源后重试".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    }
}
pub(crate) async fn restore_preparation(app: &tauri::AppHandle) -> Result<(), String> {
    let retired = crate::window_lifecycle::retire_answer(app).await;
    let restored = capture_protection::on_ui(app, |app| {
        set_active(&app, false);
        let shell = sync_shell(&app);
        let show = capture_protection::show_checked(&app, "main");
        shell.and(show)
    }).await;
    retired.and(restored)
}

pub async fn start(app: tauri::AppHandle, options: StartOptions) -> Result<Session, String> {
    let service = app.state::<capture_protection::Protection>();
    let _guard = service.gate.lock().await;
    let core = app.state::<Arc<Core>>().inner().clone();
    if core.runtime.lock().unwrap().is_some() {
        return Err("已有面试尚未结束，请返回答案窗口".into());
    }
    let microphone = options.microphone;
    let session = core
        .start(options)
        .await
        .map_err(|error| error.to_string())?;
    let entered = async {
        wait_for_capture(&core, &session.id, microphone).await?;
        // Build on the async worker; WebView2 creation must not block the UI command thread.
        capture_protection::present_locked(&app, "answer").await?;
        capture_protection::on_ui(&app, |app| {
            set_active(&app, true);
            sync_shell(&app)?;
            app.get_webview_window("main")
                .ok_or("主窗口不存在")?
                .hide()
                .map_err(|error| error.to_string())
        })
        .await
    }
    .await;
    if let Err(error) = entered {
        let stop = core.stop().map_err(|error| error.to_string());
        let restore = if stop.is_ok() {
            restore_preparation(&app).await
        } else {
            // A failed save keeps the cancelled runtime and any answer view available to retry End.
            capture_protection::on_ui(&app, |app| {
                set_active(&app, false);
                let shell = sync_shell(&app);
                let show = capture_protection::show_checked(&app, "main");
                shell.and(show)
            }).await
        };
        return Err(match (stop, restore) {
            (Ok(_), Ok(_)) => error,
            (stop, restore) => format!(
                "{error}；恢复时发生错误：{}",
                stop.err().or_else(|| restore.err()).unwrap_or_default()
            ),
        });
    }
    Ok(session)
}

pub async fn finish(app: tauri::AppHandle) -> Result<(), String> {
    let service = app.state::<capture_protection::Protection>();
    let _guard = service.gate.lock().await;
    let core = app.state::<Arc<Core>>().inner().clone();
    let mut session = core
        .runtime
        .lock()
        .unwrap()
        .as_ref()
        .map(|runtime| runtime.session.clone());
    core.stop()
        .map_err(|error| format!("结束保存失败，请重试结束：{error}"))?;
    if let Some(ended) = session.as_mut() {
        ended.ended_at = Some(now_ms());
    }
    // Keep the answer view intact if saving failed. After success, remove its HWND/WebView2
    // before restoring the main window, so shell/protection updates cannot revive an empty shell.
    let retired = crate::window_lifecycle::retire_answer(&app).await;
    let restored = capture_protection::on_ui(&app, move |app| {
        set_active(&app, false);
        if let Some(session) = session {
            core.emit(serde_json::json!({"type":"reviewRequested","sessionId":session.id,"session":session}));
        }
        let shell = sync_shell(&app);
        let show = capture_protection::show_checked(&app, "main");
        shell.and(show)
    }).await;
    retired.and(restored)
}
pub fn request_finish(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(message) = finish(app.clone()).await {
            app.state::<Arc<Core>>()
                .emit(serde_json::json!({"type":"workflowError","sessionId":"","message":message}));
        }
    });
}
pub fn request_restore(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let service = app.state::<capture_protection::Protection>();
        let _guard = service.gate.lock().await;
        let label = if active(&app) { "answer" } else { "main" };
        let _ = capture_protection::present_locked(&app, label).await;
    });
}
pub async fn restore_answer(app: tauri::AppHandle) -> Result<(), String> {
    let service = app.state::<capture_protection::Protection>();
    let _guard = service.gate.lock().await;
    if app.state::<Arc<Core>>().runtime.lock().unwrap().is_none() {
        return Err("请先开始面试".into());
    }
    capture_protection::present_locked(&app, "answer").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn audio_readiness_waits_for_required_tracks_and_ignores_other_sessions() {
        let mut events = std::collections::VecDeque::from([
            json!({"sessionId":"old","source":"meeting","message":"音频采集已启动"}),
        ]);
        assert!(!capture_ready(&events, "new", false).unwrap());
        events.push_back(json!({"sessionId":"new","source":"meeting","message":"音频采集已启动"}));
        assert!(capture_ready(&events, "new", false).unwrap());
        assert!(!capture_ready(&events, "new", true).unwrap());
        events
            .push_back(json!({"sessionId":"new","source":"microphone","message":"音频采集已启动"}));
        assert!(capture_ready(&events, "new", true).unwrap());
        events.push_back(json!({"sessionId":"new","source":"meeting","message":"采音停止：fixture failure","error":true}));
        assert!(capture_ready(&events, "new", true).is_err());
    }
}

#[cfg(test)] pub(crate) fn fixture_mode()->Mode {Mode{immersive:AtomicBool::new(true)}}
