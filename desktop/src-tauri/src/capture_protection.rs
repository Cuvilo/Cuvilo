use crate::{core::Core, types::Settings};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

#[derive(Clone, Serialize)]
pub struct Status {
    requested: bool,
    state: String,
    windows: BTreeMap<String, u32>,
    message: Option<String>,
}
pub struct Protection {
    pub gate: tokio::sync::Mutex<()>,
    status: Mutex<Status>,
    resume: Mutex<Vec<String>>,
    dialog_open: AtomicBool,
}
impl Protection {
    pub fn new(enabled: bool) -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
            status: Mutex::new(Status {
                requested: enabled,
                state: "pending".into(),
                windows: BTreeMap::new(),
                message: None,
            }),
            resume: Mutex::new(Vec::new()),
            dialog_open: AtomicBool::new(false),
        }
    }
}
pub fn status(app: &tauri::AppHandle) -> Status {
    app.state::<Protection>().status.lock().unwrap().clone()
}
fn emit(app: &tauri::AppHandle) {
    app.state::<Arc<Core>>()
        .emit(serde_json::json!({"type":"captureProtectionChanged","sessionId":""}));
}
trait Affinity {
    fn set(&mut self, value: u32) -> Result<(), String>;
    fn get(&mut self) -> Result<u32, String>;
}
fn verify(api: &mut impl Affinity, enabled: bool) -> Result<u32, String> {
    let expected = if enabled { 0x11 } else { 0 };
    api.set(expected)?;
    let actual = api.get()?;
    if actual != expected {
        return Err(format!(
            "窗口保护核验不符（期望 {expected:#x}，实际 {actual:#x}）"
        ));
    }
    Ok(actual)
}
#[cfg(target_os = "windows")]
struct NativeAffinity(windows::Win32::Foundation::HWND);
#[cfg(target_os = "windows")]
impl Affinity for NativeAffinity {
    fn set(&mut self, value: u32) -> Result<(), String> {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WINDOW_DISPLAY_AFFINITY,
        };
        unsafe { SetWindowDisplayAffinity(self.0, WINDOW_DISPLAY_AFFINITY(value)) }
            .map_err(|e| format!("Windows 无法设置窗口保护：{e}"))
    }
    fn get(&mut self) -> Result<u32, String> {
        let mut value = 0;
        unsafe {
            windows::Win32::UI::WindowsAndMessaging::GetWindowDisplayAffinity(self.0, &mut value)
        }
        .map_err(|e| format!("Windows 无法核验窗口保护：{e}"))?;
        Ok(value)
    }
}
fn native(window: &tauri::WebviewWindow, enabled: bool) -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        if enabled && crate::audio::windows_build().is_none_or(|build| build < 19041) {
            return Err("共享隐藏需要 Windows 10 2004 或更新版本".into());
        }
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let native=windows::Win32::Foundation::HWND(hwnd.0);
        let affinity=verify(&mut NativeAffinity(native),enabled)?;
        if window.label()=="main"{crate::update_caption::inherit_capture(native)?;}
        Ok(affinity)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        if enabled {
            Err("当前系统不支持此共享隐藏方式".into())
        } else {
            Ok(0)
        }
    }
}
fn windows(app: &tauri::AppHandle) -> Vec<tauri::WebviewWindow> {
    ["main", "answer"]
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .collect()
}
pub fn visible(app: &tauri::AppHandle) -> Vec<String> {
    windows(app)
        .into_iter()
        .filter(|w| w.is_visible().unwrap_or(false))
        .map(|w| w.label().to_string())
        .collect()
}
fn hide_all(app: &tauri::AppHandle) {
    for window in windows(app) {
        let _ = window.hide();
        #[cfg(target_os = "windows")]
        if let Ok(hwnd) = window.hwnd() {
            use windows::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};
            let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
                if IsWindowVisible(hwnd).as_bool() {
                    let _ = window.destroy();
                }
                if IsWindowVisible(hwnd).as_bool() {
                    app.exit(1);
                }
            }
        }
    }
}
// All callers hold the async operation gate, or run during setup before the event loop starts.
pub fn apply(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut verified = BTreeMap::new();
    for window in windows(app) {
        verified.insert(window.label().to_string(), native(&window, enabled)?);
    }
    *app.state::<Protection>().status.lock().unwrap() = Status {
        requested: enabled,
        state: if enabled { "enabled" } else { "disabled" }.into(),
        windows: verified,
        message: None,
    };
    emit(app);
    Ok(())
}
pub fn block(app: &tauri::AppHandle, error: &str, requested: bool, mut resume: Vec<String>) {
    let service = app.state::<Protection>();
    resume.extend(visible(app));
    let mut remembered = service.resume.lock().unwrap();
    remembered.extend(resume);
    remembered.sort();
    remembered.dedup();
    drop(remembered);
    hide_all(app);
    *service.status.lock().unwrap() = Status {
        requested,
        state: "blocked".into(),
        windows: BTreeMap::new(),
        message: Some(error.into()),
    };
    emit(app);
    if service.dialog_open.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_copy = app.clone();
    app.dialog().message(format!("共享隐藏未能完成，Cuvilo 内容窗口已收起。\n{error}\n\n重试会重新启用并核验保护；关闭保护后，窗口可能出现在共享或录屏中。"))
        .title("Cuvilo · 共享保护未启用")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::YesNoCancelCustom("重试".into(),"关闭保护并继续".into(),"保持收起".into()))
        .show_with_result(move |result| {
            app_copy.state::<Protection>().dialog_open.store(false,Ordering::SeqCst);
            let enabled=recovery_choice(result);
            if let Some(enabled)=enabled { tauri::async_runtime::spawn(async move { let _=recover(app_copy,enabled).await; }); }
        });
}
fn recovery_choice(result: MessageDialogResult) -> Option<bool> {
    match result {
        MessageDialogResult::Yes => Some(true),
        MessageDialogResult::No => Some(false),
        MessageDialogResult::Custom(text) if text == "重试" => Some(true),
        MessageDialogResult::Custom(text) if text == "关闭保护并继续" => Some(false),
        _ => None,
    }
}
pub fn begin_change(app: &tauri::AppHandle, enabled: bool) -> Result<Vec<String>, String> {
    let before = visible(app);
    let previous = status(app).requested;
    if enabled && (previous != enabled || status(app).state != "enabled") {
        hide_all(app);
    }
    if let Err(error) = apply(app, enabled) {
        if enabled {
            block(app, &error, true, before);
        } else if let Err(rollback) = apply(app, previous) {
            block(app, &rollback, previous, before);
        }
        return Err(error);
    }
    Ok(before)
}
pub fn restore_visible(app: &tauri::AppHandle, labels: &[String]) -> Result<(), String> {
    let labels = crate::interview_windows::restore_labels(app, labels);
    crate::interview_windows::sync_shell(app)?;
    let hidden = crate::interview_windows::active(app);
    for label in &labels {
        if let Some(window) = app.get_webview_window(label) {
            crate::taskbar::configure(&window, hidden)?;
        }
    }
    // Recheck after persistence, before any business content can reappear.
    let requested = status(app).requested;
    if let Err(error) = apply(app, requested) {
        block(app, &error, requested, labels.to_vec());
        return Err(error);
    }
    for label in &labels {
        if app.get_webview_window(label).is_some() { show_checked(app, label)?; }
    }
    Ok(())
}
pub fn save_failed(
    app: &tauri::AppHandle,
    old: bool,
    attempted: bool,
    before: &[String],
    error: &str,
) {
    if attempted && !old {
        block(app, error, true, before.to_vec());
    } else if let Err(rollback) = apply(app, old) {
        block(app, &rollback, old, before.to_vec());
    } else {
        let _ = restore_visible(app, before);
    }
}
pub use crate::window_lifecycle::on_ui;
pub fn show_checked(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or("窗口不存在")?;
    if status(app).state == "blocked" { return Err("请先在共享保护提示中恢复保护或选择关闭保护".into()); }
    let hidden = label == "answer" || crate::interview_windows::active(app);
    crate::taskbar::configure(&window, hidden)?;
    if label == "answer" && crate::interview_windows::active(app) {
        if let Some(main) = app.get_webview_window("main") { crate::window_lifecycle::hide_checked(&main)?; }
    }
    let theme=app.state::<Arc<Core>>().settings.lock().unwrap().theme.clone();crate::window_theme::apply_window(&window,&theme)?;
    if label=="answer"{let opacity=app.state::<Arc<Core>>().settings.lock().unwrap().answer_opacity;crate::answer_appearance::apply(&window,opacity)?;}
    let requested = status(app).requested;
    // Restoring one existing window must not reconfigure the hidden main HWND.
    // Explicit protection preference changes still apply and verify every window via apply().
    let affinity = match native(&window, requested) {
        Ok(value) => value,
        Err(error) => { block(app, &error, requested, vec![label.into()]); return Err(error); }
    };
    {
        let service = app.state::<Protection>();
        let mut current = service.status.lock().unwrap();
        current.windows.insert(label.into(), affinity);
        if current.state != "blocked" {
            current.state = if requested { "enabled" } else { "disabled" }.into();
            current.message = None;
        }
    }
    emit(app);
    crate::window_lifecycle::content_visible_on_ui(&window, true)?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
pub(crate) async fn present_locked(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    if label == "answer" && crate::window_lifecycle::closing(app) {
        crate::window_lifecycle::retire_answer(app).await?;
    }
    if label == "answer" && app.get_webview_window(label).is_none() {
        crate::window_lifecycle::begin_answer(app);
        let theme=app.state::<Arc<Core>>().settings.lock().unwrap().theme.clone();
        let created = tauri::WebviewWindowBuilder::new(
            app,
            "answer",
            tauri::WebviewUrl::App("index.html?window=answer".into()),
        )
        .title("Cuvilo · 实时答案")
        .theme(crate::window_theme::requested(&theme))
        .inner_size(360.0, 400.0)
        .transparent(true)
        .background_color(tauri::window::Color(0,0,0,0))
        .min_inner_size(360.0, 400.0)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .visible(false)
        .content_protected(status(app).requested)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
        on_ui(app,move|app|crate::window_memory::restore(&app,&created)).await?;
    }
    if label == "answer" { crate::window_lifecycle::wait_answer_ready(app).await?; }
    let label = label.to_string();
    on_ui(app, move |app| show_checked(&app, &label)).await
}
pub async fn toggle_answer(app: tauri::AppHandle) -> Result<(), String> {
    let service = app.state::<Protection>();
    let _guard = service.gate.lock().await;
    if !crate::interview_windows::active(&app) {
        return present_locked(&app, "main").await;
    }
    if let Some(window) = app.get_webview_window("answer") {
        if window.is_visible().unwrap_or(false) {
            return window.hide().map_err(|e| e.to_string());
        }
    }
    present_locked(&app, "answer").await
}
async fn recover(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let service = app.state::<Protection>();
    let _guard = service.gate.lock().await;
    on_ui(&app,move |app| {
        let remembered=app.state::<Protection>().resume.lock().unwrap().clone();
        let previous=status(&app).requested;
        let before=match begin_change(&app,enabled) {
            Ok(before)=>before,
            Err(error)=>{block(&app,&error,previous,remembered);return Err(error)}
        };
        let core=app.state::<Arc<Core>>();
        let mut settings:Settings=core.settings.lock().unwrap().clone(); settings.capture_protection=enabled;
        if let Err(error)=core.db.lock().unwrap().save_settings(&settings) {
            block(&app,&error.to_string(),enabled,before); return Err(error.to_string());
        }
        *core.settings.lock().unwrap()=settings;
        core.emit(serde_json::json!({"type":"captureProtectionRecovered","sessionId":"","enabled":enabled}));
        restore_visible(&app,&remembered)?;
        app.state::<Protection>().resume.lock().unwrap().clear();
        Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        value: u32,
        set_error: bool,
        get_error: bool,
        mismatch: bool,
    }
    impl Affinity for Fake {
        fn set(&mut self, value: u32) -> Result<(), String> {
            if self.set_error {
                return Err("set failed".into());
            }
            self.value = value;
            Ok(())
        }
        fn get(&mut self) -> Result<u32, String> {
            if self.get_error {
                Err("query failed".into())
            } else {
                Ok(if self.mismatch { 1 } else { self.value })
            }
        }
    }
    #[test]
    fn native_result_and_readback_must_both_succeed() {
        for (set_error, get_error, mismatch) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            assert!(verify(
                &mut Fake {
                    value: 0,
                    set_error,
                    get_error,
                    mismatch
                },
                true
            )
            .is_err());
        }
        let mut api = Fake {
            value: 0,
            set_error: false,
            get_error: false,
            mismatch: false,
        };
        assert_eq!(verify(&mut api, true).unwrap(), 0x11);
        assert_eq!(verify(&mut api, false).unwrap(), 0);
    }
    #[test]
    fn dismissing_or_keeping_hidden_never_disables_protection() {
        assert_eq!(recovery_choice(MessageDialogResult::Cancel), None);
        assert_eq!(
            recovery_choice(MessageDialogResult::Custom("保持收起".into())),
            None
        );
        assert_eq!(
            recovery_choice(MessageDialogResult::Custom("重试".into())),
            Some(true)
        );
        assert_eq!(
            recovery_choice(MessageDialogResult::Custom("关闭保护并继续".into())),
            Some(false)
        );
    }
    #[test]
    fn legacy_settings_default_to_protection_and_explicit_off_survives() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("captureProtection");
        assert!(
            serde_json::from_value::<Settings>(value.clone())
                .unwrap()
                .capture_protection
        );
        value["captureProtection"] = serde_json::json!(false);
        assert!(
            !serde_json::from_value::<Settings>(value)
                .unwrap()
                .capture_protection
        );
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_accepts_and_reads_exclusion_for_our_own_window() {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::*;
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Cuvilo protection test"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                200,
                100,
                None,
                None,
                None,
                None,
            )
        }
        .unwrap();
        let mut native = NativeAffinity(hwnd);
        let enabled = verify(&mut native, true);
        let disabled = verify(&mut native, false);
        unsafe { DestroyWindow(hwnd) }.unwrap();
        assert_eq!(enabled.unwrap(), 0x11);
        assert_eq!(disabled.unwrap(), 0);
    }
}
