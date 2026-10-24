use tauri::{menu::MenuItem, Manager};

pub struct TrayUpdate(pub MenuItem<tauri::Wry>);

fn presentation(
    current: &str,
    stage: &str,
    version: Option<&str>,
    blocked: bool,
) -> Result<(String, bool), String> {
    if version.is_some_and(|value| {
        value.is_empty() || value.len() > 64 || value.chars().any(char::is_control)
    }) {
        return Err("无效的更新版本".into());
    }
    match stage {
        "idle" | "current" | "checking" | "error" => {}
        "available" | "downloading" | "ready" | "installing" if version.is_some() => {}
        _ => return Err("无效的托盘更新状态".into()),
    }
    let target = if matches!(stage, "idle" | "current" | "checking") {
        current
    } else {
        version.unwrap_or(current)
    };
    let enabled = version.is_some() && !blocked && matches!(stage, "available" | "ready" | "error");
    Ok((format!("版本 {target}"), enabled))
}

#[tauri::command]
pub async fn set_tray_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    stage: String,
    version: Option<String>,
    blocked: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在主窗口管理软件更新".into());
    }
    let (text, enabled) = presentation(
        &app.package_info().version.to_string(),
        &stage,
        version.as_deref(),
        blocked,
    )?;
    crate::window_lifecycle::on_ui(&app, move |app| {
        let tray = app.state::<TrayUpdate>();
        tray.0
            .set_text(text)
            .map_err(|_| "无法刷新托盘版本".to_string())?;
        tray.0
            .set_enabled(enabled)
            .map_err(|_| "无法刷新托盘更新状态".to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_row_shows_only_the_current_or_available_version() {
        assert_eq!(
            presentation("0.1.50", "current", None, false).unwrap(),
            ("版本 0.1.50".into(), false)
        );
        for stage in ["available", "downloading", "ready", "installing", "error"] {
            let (text, enabled) = presentation("0.1.50", stage, Some("0.1.51"), false).unwrap();
            assert_eq!(text, "版本 0.1.51");
            assert_eq!(enabled, matches!(stage, "available" | "ready" | "error"));
            assert!(
                !presentation("0.1.50", stage, Some("0.1.51"), true)
                    .unwrap()
                    .1
            );
        }
        assert_eq!(
            presentation("0.1.50", "error", None, false).unwrap(),
            ("版本 0.1.50".into(), false)
        );
        assert!(presentation("0.1.50", "unknown", Some("0.1.51"), false).is_err());
        assert!(presentation("0.1.50", "ready", None, false).is_err());
        assert!(presentation("0.1.50", "available", Some("bad\nversion"), false).is_err());
    }
}
