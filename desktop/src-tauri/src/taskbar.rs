use tauri::Manager;

pub fn configure(window: &tauri::WebviewWindow, hidden: bool) -> Result<(), String> {
    window
        .set_skip_taskbar(hidden || window.label() == "answer")
        .map_err(|error| format!("无法更新任务栏图标：{error}"))
}

pub fn apply_visible(app: &tauri::AppHandle, hidden: bool) -> Result<(), String> {
    for label in ["main", "answer"] {
        if let Some(window) = app.get_webview_window(label) {
            // Hidden windows receive their phase before show, avoiding an empty AddTab entry.
            if window.is_visible().map_err(|error| error.to_string())? {
                configure(&window, hidden)?;
            }
        }
    }
    Ok(())
}
