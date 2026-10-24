use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::Manager;

#[derive(Default)]
pub struct AnswerLifecycle {
    ready_handle: AtomicUsize,
    ready: tokio::sync::Notify,
    closing: AtomicBool,
    retiring_handle: AtomicUsize,
}

pub async fn on_ui<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce(tauri::AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || { let _ = tx.send(work(handle)); })
        .map_err(|error| error.to_string())?;
    rx.await.map_err(|_| "窗口操作未完成".to_string())?
}

// HWND visibility and WebView2 controller visibility are independent. Preserve the page
// and drafts instead of reloading. All checked show/hide callers run on the native UI thread.
pub fn content_visible_on_ui(window: &tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        window.with_webview(move |view| {
            let result = (|| -> Result<(), String> {
                let controller = view.controller();
                let mut current = Default::default();
                unsafe { controller.IsVisible(&mut current) }.map_err(|error| error.to_string())?;
                if current.as_bool() != visible {
                    unsafe { controller.SetIsVisible(visible) }.map_err(|error| error.to_string())?;
                }
                unsafe { controller.IsVisible(&mut current) }.map_err(|error| error.to_string())?;
                if current.as_bool() != visible { return Err("界面显隐同步核验失败".into()); }
                Ok(())
            })();
            let _ = tx.send(result);
        }).map_err(|error| error.to_string())?;
        // Tauri dispatches with_webview synchronously on its UI thread. Never wait here:
        // an accidental off-thread caller must fail rather than block the window thread.
        rx.try_recv().map_err(|_| "界面显隐操作必须在窗口线程执行".to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (window, visible); Ok(()) }
}

pub fn hide_checked(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())?;
    if !force_hidden(native_handle(window)?) { return Err("窗口尚未收起，请重试".into()); }
    content_visible_on_ui(window, false)
}

fn native_handle(window: &tauri::WebviewWindow) -> Result<usize, String> {
    #[cfg(target_os = "windows")]
    { window.hwnd().map(|handle| handle.0 as usize).map_err(|error| error.to_string()) }
    #[cfg(not(target_os = "windows"))]
    { let _ = window; Ok(1) }
}

pub fn begin_answer(app: &tauri::AppHandle) {
    app.state::<AnswerLifecycle>().ready_handle.store(0, Ordering::SeqCst);
}
pub fn answer_ready(window: &tauri::WebviewWindow) {
    if window.label() != "answer" { return; }
    let app = window.app_handle();
    let Some(current) = app.get_webview_window("answer") else { return; };
    if let (Ok(handle), Ok(expected)) = (native_handle(window), native_handle(&current)) {
        if handle != expected { return; }
        let lifecycle = app.state::<AnswerLifecycle>();
        lifecycle.ready_handle.store(handle, Ordering::SeqCst);
        lifecycle.ready.notify_one();
    }
}
pub async fn wait_answer_ready(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("answer").ok_or("答案窗口不存在")?;
    let handle = native_handle(&window)?;
    let lifecycle = app.state::<AnswerLifecycle>();
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if lifecycle.ready_handle.load(Ordering::SeqCst) == handle { return; }
            lifecycle.ready.notified().await;
        }
    }).await.map_err(|_| "答案界面加载超时，请重试开始面试".to_string())
}
pub fn closing(app: &tauri::AppHandle) -> bool {
    app.state::<AnswerLifecycle>().closing.load(Ordering::SeqCst)
}

fn force_hidden(handle: usize) -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, IsWindowVisible, ShowWindow, SW_HIDE};
        let hwnd = HWND(handle as *mut _);
        if IsWindow(Some(hwnd)).as_bool() { let _ = ShowWindow(hwnd, SW_HIDE); }
        !IsWindowVisible(hwnd).as_bool()
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = handle; true }
}
fn native_closed(handle: usize) -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::HWND;
        !windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(HWND(handle as *mut _))).as_bool()
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = handle; true }
}

// A destroy request is queued, even on the UI thread. Await registry and HWND removal off that thread.
// It bypasses CloseRequested, so retiring a successfully saved interview cannot trigger End again.
pub async fn retire_answer(app: &tauri::AppHandle) -> Result<(), String> {
    crate::window_memory::capture(app);
    let lifecycle = app.state::<AnswerLifecycle>();
    lifecycle.closing.store(true, Ordering::SeqCst);
    let handle = on_ui(app, |app| {
        let lifecycle = app.state::<AnswerLifecycle>();
        if let Some(window) = app.get_webview_window("answer") {
            let handle = native_handle(&window)?;
            lifecycle.retiring_handle.store(handle, Ordering::SeqCst);
            let _ = window.hide();
            force_hidden(handle);
            window.destroy().map_err(|error| format!("答案窗口释放失败：{error}"))?;
            Ok(Some(handle))
        } else {
            // Keep checking a timed-out HWND even if Tauri already removed its registry entry.
            let handle = lifecycle.retiring_handle.load(Ordering::SeqCst);
            if handle != 0 { force_hidden(handle); }
            Ok((handle != 0).then_some(handle))
        }
    }).await?;
    let Some(handle) = handle else {
        lifecycle.ready_handle.store(0, Ordering::SeqCst);
        lifecycle.closing.store(false, Ordering::SeqCst);
        return Ok(());
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if app.get_webview_window("answer").is_none() && native_closed(handle) {
            lifecycle.retiring_handle.store(0, Ordering::SeqCst);
            lifecycle.ready_handle.store(0, Ordering::SeqCst);
            lifecycle.closing.store(false, Ordering::SeqCst);
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            force_hidden(handle);
            return Err("面试已保存，但答案窗口释放超时，请稍后重试".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

