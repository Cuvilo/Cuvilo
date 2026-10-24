use crate::{capture_protection, core::Core, types::Network};
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct PendingUpdate(Mutex<Pending>);
#[derive(Default)]
struct Pending {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}
fn authorize(label: &str) -> Result<(), String> {
    if label == "main" { Ok(()) } else { Err("请在主窗口管理软件更新".into()) }
}
fn idle(running: bool) -> Result<(), String> {
    if running { Err("请先结束面试，再更新软件".into()) } else { Ok(()) }
}
fn info(update: &Update) -> UpdateInfo {
    UpdateInfo { version: update.version.clone(), notes: update.body.clone().unwrap_or_default() }
}
fn proxy(network: &Network) -> Result<Option<url::Url>, String> {
    let address = match network.mode.as_str() {
        "direct" => None,
        "manual" => Some(network.url.clone()),
        _ => crate::network::system_proxy(),
    };
    address.map(|address| {
        let url = url::Url::parse(&address).map_err(|_| "更新代理地址无效".to_string())?;
        if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() {
            return Err("更新代理地址无效".into());
        }
        Ok(url)
    }).transpose()
}

#[tauri::command]
pub async fn check_app_update(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    authorize(window.label())?;
    let state = app.state::<PendingUpdate>();
    let mut pending = state.0.lock().await;
    // Keep verified bytes paired with the metadata/signature that authenticated them.
    if pending.bytes.is_some() { return Ok(pending.update.as_ref().map(info)); }
    let network = app.state::<Arc<Core>>().settings.lock().unwrap().network.clone();
    let builder = app.updater_builder().timeout(Duration::from_secs(20));
    let builder = if let Some(proxy) = proxy(&network)? { builder.proxy(proxy) } else { builder.no_proxy() };
    let update = builder.build().map_err(|_| "更新配置不可用".to_string())?
        .check().await.map_err(|error| match error {
            tauri_plugin_updater::Error::ReleaseNotFound => "尚未发布可用更新，请稍后再试".to_string(),
            _ => "检查更新失败，请检查网络后重试".to_string(),
        })?;
    let update = update.map(|mut update| { update.timeout = Some(Duration::from_secs(600)); update });
    let result = update.as_ref().map(info);
    pending.update = update;
    Ok(result)
}

#[tauri::command]
pub async fn download_app_update(window: tauri::WebviewWindow, app: tauri::AppHandle, progress: Channel<Progress>) -> Result<(), String> {
    authorize(window.label())?;
    let core = app.state::<Arc<Core>>().inner().clone();
    idle(core.runtime.lock().unwrap().is_some())?;
    let state = app.state::<PendingUpdate>();
    let mut pending = state.0.lock().await;
    if pending.bytes.is_some() { return Ok(()); }
    let update = pending.update.as_ref().ok_or("请先检查更新")?;
    let mut downloaded = 0_u64;
    let download = update.download(|chunk, total| {
        downloaded = downloaded.saturating_add(chunk as u64);
        let _ = progress.send(Progress { downloaded, total });
    }, || {});
    let interrupted = async {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if core.runtime.lock().unwrap().is_some() { break; }
        }
    };
    let bytes = tokio::select! {
        result = download => result.map_err(|_| "更新下载或签名校验失败，请重试".to_string())?,
        _ = interrupted => return Err("面试开始，更新下载已暂停".into()),
    };
    // The plugin verifies the signature before download() returns. Installation has no URL/bytes IPC input.
    pending.bytes = Some(bytes);
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    authorize(window.label())?;
    let service = app.state::<capture_protection::Protection>();
    // Same gate as start_session and settings/data mutations: no interview can start after this check.
    let _guard = service.gate.lock().await;
    let state = app.state::<PendingUpdate>();
    let pending = state.0.lock().await;
    let core = app.state::<Arc<Core>>().inner().clone();
    idle(core.runtime.lock().unwrap().is_some())?;
    let update = pending.update.as_ref().ok_or("请先检查更新")?;
    let bytes = pending.bytes.as_ref().ok_or("请先下载更新")?;
    // A failed checkpoint leaves the app running and the verified download available for retry.
    core.db.lock().unwrap().checkpoint().map_err(|_| "数据备份失败，未安装更新".to_string())?;
    crate::window_lifecycle::on_ui(&app, |app| {
        crate::window_memory::flush(&app);
        crate::window_memory::flush_main(&app);
        Ok(())
    }).await?;
    update.install(bytes).map_err(|_| "无法启动更新安装，请重试".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_main_window_can_install_and_interviews_must_finish_first() {
        assert!(authorize("main").is_ok());
        assert!(authorize("answer").is_err());
        assert!(authorize("capture").is_err());
        assert!(idle(true).is_err());
        assert!(idle(false).is_ok());
    }
    #[test]
    fn updater_respects_direct_and_manual_proxy_without_leaking_credentials() {
        assert!(proxy(&Network { mode: "direct".into(), url: "http://ignored".into() }).unwrap().is_none());
        assert_eq!(proxy(&Network { mode: "manual".into(), url: "http://localhost:7890".into() }).unwrap().unwrap().port(), Some(7890));
        let error=proxy(&Network { mode: "manual".into(), url: "socks5://private:secret@localhost:7890".into() }).unwrap_err();
        assert!(!error.contains("secret"));
    }
}

#[cfg(test)]
mod signed_download_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn signed_loopback_download_accepts_fixture_and_rejects_tampering_before_install() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
            "pubkey":include_str!("../test-fixtures/updater-test.pub").trim(),"dangerousInsecureTransportProtocol":true
        }));
        let app = tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap();
        for tamper in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let manifest = serde_json::json!({"version":"99.0.0","notes":"Synthetic fixture","platforms":{"fixture":{
                "url":format!("{origin}/fixture"),"signature":include_str!("../test-fixtures/updater-payload.txt.sig").trim()
            }}}).to_string();
            let server = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        let mut byte = [0_u8];
                        if stream.read(&mut byte).await.unwrap() == 0 { break; }
                        request.push(byte[0]); assert!(request.len() < 8192);
                    }
                    let body: &[u8] = if request.starts_with(b"GET /latest.json ") { manifest.as_bytes() }
                        else if tamper { b"tampered fixture bytes" }
                        else { include_bytes!("../test-fixtures/updater-payload.txt") };
                    let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    stream.write_all(header.as_bytes()).await.unwrap(); stream.write_all(body).await.unwrap();
                }
            });
            let update = app.updater_builder()
                .target("fixture").endpoints(vec![format!("{origin}/latest.json").parse().unwrap()]).unwrap()
                .no_proxy().timeout(Duration::from_secs(5)).build().unwrap().check().await.unwrap().unwrap();
            let downloaded = update.download(|_, _| {}, || {}).await;
            if tamper { assert!(downloaded.is_err()); }
            else {
                assert_eq!(downloaded.unwrap(), include_bytes!("../test-fixtures/updater-payload.txt"));
                assert!(update.install(b"tampered after download").is_err());
            }
            server.abort();
        }
    }
}
