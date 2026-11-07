#[cfg(target_os = "windows")]
#[path = "update_caption_windows.rs"]
mod implementation;

#[cfg(not(target_os = "windows"))]
mod implementation {
    #[allow(dead_code)]
    pub fn inherit_capture<T>(_owner: T) -> Result<(), String> {
        Ok(())
    }

    #[allow(dead_code)]
    pub fn refresh(_raw: *mut std::ffi::c_void, _caption: u32, _text: u32) {}

    #[tauri::command]
    pub async fn set_update_caption(
        _window: tauri::WebviewWindow,
        _app: tauri::AppHandle,
        _visible: bool,
        _enabled: bool,
        _mode: Option<String>,
        _progress: Option<u32>,
        _version: Option<String>,
        _english: Option<bool>,
    ) -> Result<(), String> {
        Ok(())
    }
}

pub use implementation::*;
