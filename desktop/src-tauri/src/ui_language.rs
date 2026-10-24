use std::sync::Arc;
use tauri::{menu::MenuItem, Manager};

pub struct TrayLabels { pub show: MenuItem<tauri::Wry>, pub quit: MenuItem<tauri::Wry> }
pub fn system_language() -> &'static str {
    let language = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    if language & 0x03ff == 0x04 { "zh-CN" } else { "en" }
}
pub fn english(preference: &str) -> bool {
    preference == "en" || (preference == "system" && system_language() == "en")
}
pub fn app_english(app: &tauri::AppHandle) -> bool {
    app.try_state::<Arc<crate::core::Core>>()
        .map(|core| english(&core.settings.lock().unwrap().language)).unwrap_or(false)
}
pub fn refresh_menus(app: &tauri::AppHandle) {
    let en = app_english(app);
    if let Some(answer)=app.get_webview_window("answer"){let _=answer.set_title(if en {"Cuvilo · Live answers"} else {"Cuvilo · 实时答案"});}
    if let Some(labels) = app.try_state::<TrayLabels>() {
        let _ = labels.show.set_text(if en { "Open Cuvilo" } else { "打开 Cuvilo" });
        let _ = labels.quit.set_text(if en { "Quit" } else { "退出" });
    }
    if let Some(tray) = app.try_state::<crate::tray_update::TrayUpdate>() {
        if let Ok(text) = tray.0.text() {
            let version = text.strip_prefix("版本 ").or_else(|| text.strip_prefix("Version ")).unwrap_or(&text);
            let _ = tray.0.set_text(format!("{} {version}", if en { "Version" } else { "版本" }));
        }
    }
}
#[tauri::command]
pub fn system_language_name() -> String { system_language().into() }
#[cfg(test)]
mod tests {
    #[test]
    fn explicit_language_does_not_depend_on_the_operating_system() {
        assert!(super::english("en"));
        assert!(!super::english("zh-CN"));
    }
}
