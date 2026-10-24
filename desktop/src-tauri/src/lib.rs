mod provider_help;
mod manual_question;
mod asr;
mod openai_asr;
mod volcengine_asr;
mod data_backup;
mod screen_capture;
mod remote_ocr;
mod cloud_ocr;
mod window_memory;
mod audio;
mod core;
mod diagnostics;
mod documents;
mod llm;
mod vision_answer;
mod network;
mod provider_check;
mod model_catalog;
mod question;
mod secrets;
mod settings_copies;
mod settings_actions;
mod answer_appearance;
mod storage;
mod types;
mod window_style;
mod window_theme;
mod ui_language;
mod autostart;
mod app_behavior;
mod app_updater;
mod update_caption;
mod tray_update;
mod window_lifecycle;
mod transcript_text;
mod capture_protection;
mod taskbar;
mod interview_windows;
use crate::{core::Core, types::*};
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::Arc;
use tauri::{ipc::Channel, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
type State<'a> = tauri::State<'a, Arc<Core>>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[tauri::command]
fn snapshot(app: tauri::AppHandle, core: State) -> Result<Value, String> {
    let mut value=core.snapshot().map_err(err)?;
    value["screenCapture"]=serde_json::to_value(&*core.screen.lock().unwrap()).map_err(err)?;
    value["captureProtection"]=serde_json::to_value(capture_protection::status(&app)).map_err(err)?;
    Ok(value)
}
#[tauri::command]
fn subscribe(core: State, events: Channel<Value>) {
    core.channels.lock().unwrap().push(events);
}
#[tauri::command]
async fn audio_sources() -> Result<Vec<AudioSource>, String> {
    tauri::async_runtime::spawn_blocking(audio::sources)
        .await
        .map_err(err)?
        .map_err(err)
}
#[tauri::command]
async fn start_session(app: tauri::AppHandle, options: StartOptions) -> Result<Session, String> {
    interview_windows::start(app, options).await
}
#[tauri::command]
async fn stop_session(app: tauri::AppHandle) -> Result<(), String> {
    interview_windows::finish(app).await
}
#[tauri::command]
fn request_answer(
    core: State,
    text: Option<String>,
    mode: Option<String>,
    question_id: Option<String>,
) -> Result<(), String> {
    core.inner()
        .trigger(text, mode.as_deref().unwrap_or("short"), question_id)
        .map_err(err)
}
#[tauri::command]
fn cancel_answer(core: State) {
    screen_capture::clear(&core);
    core.cancel_answer();
}
fn shortcuts(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
    let values=[(&s.shortcuts.answer,"立即回答"),(&s.shortcuts.cancel,"停止生成"),(&s.shortcuts.toggle,"显示或收起答案窗口"),(&s.shortcuts.screen,"截图提问"),(&s.shortcuts.manual,"手动提问")];
    let mut ids=std::collections::HashSet::new();let mut parsed=Vec::new();
    for (i,(value,label)) in values.iter().enumerate(){
        if value.trim().is_empty(){continue;}
        let key=Shortcut::from_str(value).map_err(|e|format!("{label}的快捷键格式不正确：{e}"))?;
        if !ids.insert(key.id()){return Err("快捷键不能重复".into());}
        parsed.push((i,key));
    }
    app.global_shortcut().unregister_all().map_err(err)?;
    for(i,key)in parsed {
        if let Err(e)=app.global_shortcut().register(key){let _=app.global_shortcut().unregister_all();return Err(format!("{}的快捷键 {} 已被占用或无法注册，请换一个组合（{e}）",values[i].1,values[i].0));}
        if i!=2 && !interview_windows::active(app){app.global_shortcut().unregister(key).map_err(err)?;}
    }
    Ok(())
}
#[tauri::command]
fn open_provider_help(window:tauri::WebviewWindow,help:String)->Result<(),String>{
 if window.label()!="main"{return Err("请在主窗口打开服务帮助".into());}
 provider_help::open(&help)
}
fn screen_window(window:&tauri::WebviewWindow)->Result<(),String>{if window.label()=="answer"{Ok(())}else{Err("请在答案窗口操作截图提问".into())}}
#[tauri::command] fn begin_screen_capture(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<(),String>{screen_window(&window)?;screen_capture::start(app).map_err(err)}
#[tauri::command] fn cancel_screen_capture(window:tauri::WebviewWindow,core:State)->Result<(),String>{screen_window(&window)?;core.cancel_screen_capture();Ok(())}
#[tauri::command] fn submit_screen_question(window:tauri::WebviewWindow,core:State,job_id:String,text:String)->Result<(),String>{screen_window(&window)?;screen_capture::submit(core.inner(),&job_id,text).map_err(err)}
#[tauri::command] fn correct_screen_question(window:tauri::WebviewWindow,core:State,question_id:String,text:String)->Result<(),String>{screen_window(&window)?;screen_capture::correct(core.inner(),question_id,text).map_err(err)}
#[tauri::command] fn screen_capture_image(window:tauri::WebviewWindow,core:State,job_id:String)->Result<String,String>{screen_window(&window)?;screen_capture::image(&core,&job_id).map_err(err)}
#[tauri::command] async fn screen_ocr_status()->Result<screen_capture::OcrStatus,String>{tauri::async_runtime::spawn_blocking(screen_capture::availability).await.map_err(err)}
fn validate_settings(settings: &Settings, updates: &[SecretUpdate]) -> Result<(), String> {
    if !(300..=2000).contains(&settings.silence_ms) {
        return Err("停顿时间应在300–2000ms之间".into());
    }
    if !(14..=30).contains(&settings.font_size) {return Err("答案字号应在14–30px之间".into());}
    answer_appearance::alpha(settings.answer_opacity)?;
    if !(50..=2000).contains(&settings.answer_words){return Err("生成字数应在50–2000之间".into());}
    if !["system","zh-CN","en"].contains(&settings.language.as_str())||!["light","dark","system"].contains(&settings.theme.as_str())||!["tray","quit"].contains(&settings.close_action.as_str()){return Err("未知应用偏好".into());}
    if !["system","direct","manual"].contains(&settings.network.mode.as_str()){return Err("未知网络模式".into());}
    if settings.network.mode=="manual"{let url=url::Url::parse(&settings.network.url).map_err(|_|"代理地址格式不正确")?;if !["http","https"].contains(&url.scheme())||url.host_str().is_none(){return Err("代理地址格式不正确".into());}}

    let mut ids = std::collections::HashSet::new();
    for p in &settings.providers {
        if p.id.is_empty() || !ids.insert(p.id.clone()) {
            return Err("服务 ID 不能为空或重复".into());
        }
        if p.kind=="openai-asr" {openai_asr::endpoint(p).map_err(err)?;}
        else if crate::cloud_ocr::supports(p){crate::cloud_ocr::validate(p).map_err(err)?;}
        else if p.kind == "llm" || p.kind == "ocr" {
            llm::endpoint(&p.base_url).map_err(err)?;
            if p.model.trim().is_empty() {
                return Err("模型名称不能为空".into());
            }
        }
    }
    if !(settings.active_model.is_empty()&&!settings.providers.iter().any(|p|p.kind=="llm")) && !settings
        .providers
        .iter()
        .any(|p| p.id == settings.active_model && p.kind == "llm")
    {
        return Err("请选择存在的回答模型".into());
    }
    if !(settings.asr_provider.is_empty()&&!settings.providers.iter().any(|p|settings_actions::belongs(p,"asr"))) && !settings.providers.iter().any(|p|p.id==settings.asr_provider&&["xfyun","tencent","dashscope","volcengine","openai-asr"].contains(&p.kind.as_str())){return Err("请选择存在的语音服务".into());}
    if !settings.screenshot_model.is_empty()&&!settings.providers.iter().any(|p|p.id==settings.screenshot_model&&p.kind=="llm"){return Err("请选择存在的截图模型".into());}
    if settings.ocr_provider!="local"&&settings.ocr_provider!=cloud_ocr::YOUDAO_FREE_ID&&!settings.providers.iter().any(|p|p.id==settings.ocr_provider&&settings_actions::belongs(p,"ocr")){return Err("请选择存在的截图识别服务".into());}
    if updates.iter().any(|update| !settings.providers.iter().any(|p| p.id == update.id)) { return Err("密钥所属服务不存在".into()); }
    Ok(())
}
fn save_settings_inner(app: tauri::AppHandle, core: Arc<Core>, settings: Settings, updates: Vec<SecretUpdate>) -> Result<(),String> {
    let old = core.settings.lock().unwrap().clone();
    if serde_json::to_string(&old.shortcuts).map_err(err)?
        != serde_json::to_string(&settings.shortcuts).map_err(err)?
    {
        if let Err(e) = shortcuts(&app, &settings) {
            let _ = shortcuts(&app, &old);
            return Err(e);
        }
        core.warnings.lock().unwrap().clear();
    }
    for update in updates {
        if !settings.providers.iter().any(|p| p.id == update.id) {
            return Err("密钥所属服务不存在".into());
        }
        secrets::save(&update.id, &update.secret).map_err(err)?;
    }
    core.db
        .lock()
        .unwrap()
        .save_settings(&settings)
        .map_err(err)?;
    *core.settings.lock().unwrap() = settings;
    core.emit(json!({"type":"settingsChanged","sessionId":""}));
    Ok(())
}
fn persist_settings(app:&tauri::AppHandle,core:&Arc<Core>,settings:Settings,updates:Vec<SecretUpdate>)->Result<(),String>{
 validate_settings(&settings,&updates)?;let old=core.settings.lock().unwrap().clone();
 let protection_changed=old.capture_protection!=settings.capture_protection;
 let before=if protection_changed{Some(capture_protection::begin_change(app,settings.capture_protection)?)}else{None};
 let enabled=settings.capture_protection;
 if old.theme!=settings.theme{if let Err(error)=window_theme::apply(app,&settings.theme){let _=window_theme::apply(app,&old.theme);if let Some(before)=&before{capture_protection::save_failed(app,old.capture_protection,enabled,before,&error);}return Err(error);}}
 if old.answer_opacity!=settings.answer_opacity{if let Err(e)=answer_appearance::existing(app,settings.answer_opacity){let _=window_theme::apply(app,&old.theme);if let Some(before)=&before{capture_protection::save_failed(app,old.capture_protection,enabled,before,&e);}return Err(e);}}
 if let Err(error)=save_settings_inner(app.clone(),core.clone(),settings,updates){
  let _=window_theme::apply(app,&old.theme);let _=shortcuts(app,&old);let _=answer_appearance::existing(app,old.answer_opacity);
  let _=core.db.lock().unwrap().save_settings(&old);*core.settings.lock().unwrap()=old.clone();
  if let Some(before)=&before{capture_protection::save_failed(app,old.capture_protection,enabled,before,&error);}return Err(error);
 }
 let language_changed=old.language!=core.settings.lock().unwrap().language;
 if language_changed{ui_language::refresh_menus(app);}
 if let Some(before)=&before{capture_protection::restore_visible(app,before)?;}Ok(())
}
async fn modify_settings(app:tauri::AppHandle,core:Arc<Core>,build:impl FnOnce(Settings)->Result<(Settings,Vec<SecretUpdate>),String>+Send+'static)->Result<(),String>{
 let protection=app.state::<capture_protection::Protection>();let _guard=protection.gate.lock().await;
 capture_protection::on_ui(&app,move|app|{let saved=core.settings.lock().unwrap().clone();let(settings,updates)=build(saved)?;persist_settings(&app,&core,settings,updates)}).await
}
#[tauri::command]
async fn save_settings(app:tauri::AppHandle,core:State<'_>,settings:Settings,updates:Vec<SecretUpdate>)->Result<(),String>{modify_settings(app,core.inner().clone(),move|_|Ok((settings,updates))).await}
#[tauri::command]
fn system_theme_dark(window:tauri::WebviewWindow)->Result<bool,String>{if !["main","answer"].contains(&window.label()){return Err("未知窗口".into());}Ok(window_theme::system_dark())}
#[tauri::command]
async fn prepare_theme_transition(app:tauri::AppHandle,window:tauri::WebviewWindow,theme:String,resolved_dark:bool)->Result<f64,String>{
 if window.label()!="main"{return Err("请在主窗口切换外观".into());}if !["light","dark","system"].contains(&theme.as_str()){return Err("未知外观".into());}
 let(start,_job)=window_theme::schedule(&app,theme,resolved_dark).await?;Ok(start)
}
#[tauri::command]
async fn preview_theme(app:tauri::AppHandle,window:tauri::WebviewWindow,theme:String,resolved_dark:Option<bool>,started_at_ms:Option<f64>)->Result<(),String>{
 if window.label()!="main"{return Err("请在主窗口切换外观".into());}
 if !["light","dark","system"].contains(&theme.as_str()){return Err("未知外观".into());}
 window_theme::preview(&app,theme,resolved_dark,started_at_ms).await
}
#[tauri::command]
fn preview_answer_opacity(window:tauri::WebviewWindow,core:State,opacity:u32)->Result<(),String>{
 if !["main","answer"].contains(&window.label()){return Err("未知窗口".into());}
 answer_appearance::alpha(opacity)?;
 core.emit(json!({"type":"answerOpacityPreview","sessionId":"","opacity":opacity}));Ok(())
}
#[tauri::command] fn get_autostart(window:tauri::WebviewWindow)->Result<bool,String>{if window.label()!="main"{return Err("请在主窗口调整开机启动".into());}autostart::get()}
#[tauri::command] fn set_autostart(window:tauri::WebviewWindow,enabled:bool)->Result<bool,String>{if window.label()!="main"{return Err("请在主窗口调整开机启动".into());}autostart::set(enabled)}
#[tauri::command]
async fn save_preferences(app:tauri::AppHandle,window:tauri::WebviewWindow,core:State<'_>,patch:settings_actions::PreferencesPatch)->Result<(),String>{
 settings_actions::authorize_preferences(window.label(),&patch)?;
 modify_settings(app,core.inner().clone(),move|saved|Ok((patch.apply(saved),vec![]))).await
}
#[tauri::command]
async fn save_services(app:tauri::AppHandle,window:tauri::WebviewWindow,core:State<'_>,services:settings_actions::ServicesPatch,updates:Vec<SecretUpdate>)->Result<(),String>{
 if window.label()!="main"{return Err("请在主窗口配置服务".into());}
 modify_settings(app,core.inner().clone(),move|saved|{if updates.iter().any(|u|!services.providers.iter().any(|p|p.id==u.id)){return Err("密钥与服务分类不一致".into());}Ok((services.apply(saved).map_err(err)?,updates))}).await
}
#[tauri::command]
async fn remove_provider(app:tauri::AppHandle,window:tauri::WebviewWindow,core:State<'_>,id:String)->Result<(),String>{
 if window.label()!="main"{return Err("请在主窗口管理服务".into());}
 let core=core.inner().clone();let protection=app.state::<capture_protection::Protection>();let _guard=protection.gate.lock().await;
 capture_protection::on_ui(&app,move|app|{
  if core.runtime.lock().unwrap().is_some(){return Err("请先结束面试".into());}
  let old=core.settings.lock().unwrap().clone();let next=settings_actions::remove(old,&id).map_err(err)?;
  let secret=secrets::read_optional(&id).map_err(err)?;secrets::remove(&id).map_err(err)?;
  if let Err(error)=persist_settings(&app,&core,next,vec![]){if let Some(secret)=secret{secrets::save(&id,&secret).map_err(|_|format!("{error}；服务密钥恢复失败"))?;}return Err(error);}Ok(())
 }).await
}
#[tauri::command]
fn read_provider_secret(
    window: tauri::WebviewWindow,
    core: State,
    provider_id: String,
) -> Result<Secret, String> {
    if window.label() != "main" {
        return Err("请在主窗口设置页查看密钥".into());
    }
    if !core
        .settings
        .lock()
        .unwrap()
        .providers
        .iter()
        .any(|p| p.id == provider_id)
    {
        return Err("服务不存在".into());
    }
    secrets::read_optional(&provider_id)
        .map(|secret| secret.unwrap_or_default())
        .map_err(err)
}
#[tauri::command]
async fn test_provider(
    window: tauri::WebviewWindow,
    core: State<'_>,
    provider_id: String,
    provider: Option<Provider>,
    secret: Option<Secret>,
    network: Option<Network>,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("请在主窗口设置页检测服务".into());
    }
    let saved = core.settings.lock().unwrap().clone();
    let config =
        provider_check::resolve(&saved, &provider_id, provider, secret, network).map_err(err)?;
    provider_check::test(&config).await.map_err(err)
}
#[tauri::command]
async fn list_provider_models(window: tauri::WebviewWindow, core: State<'_>, provider: Provider,
    secret: Secret, network: Network) -> Result<Vec<model_catalog::Model>, String> {
    if window.label() != "main" { return Err("请在主窗口设置页获取模型".into()); }
    let saved = core.settings.lock().unwrap().clone();
    let id = provider.id.clone();
    let config = provider_check::resolve(&saved, &id, Some(provider), Some(secret), Some(network)).map_err(err)?;
    model_catalog::fetch(&config).await.map_err(err)
}
#[tauri::command]
async fn test_audio(core: State<'_>, source: AudioSource) -> Result<(), String> {
    let cancel = tokio_util::sync::CancellationToken::new();
    let (tx, mut rx) = tokio::sync::mpsc::channel(150);
    let (ntx, mut nrx) = tokio::sync::mpsc::unbounded_channel();
    audio::spawn(source, false, cancel.clone(), tx, ntx);
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(5));
    tokio::pin!(deadline);
    let mut max = 0.0f32;
    let result = loop {
        tokio::select! {_=&mut deadline=>break Ok(()),Some(frame)=rx.recv()=>{max=max.max(frame.level);core.emit(json!({"type":"level","sessionId":"test","source":"meeting","level":frame.level}));},Some(notice)=nrx.recv()=>{if notice.error{break Err(notice.message)}}}
    };
    cancel.cancel();
    result?;
    if max < 0.005 {
        return Err("未检测到声音，请播放会议声音并检查所选音源".into());
    }
    Ok(())
}
#[tauri::command]
async fn import_document(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || documents::extract(&path))
        .await
        .map_err(err)?
        .map_err(err)
}
#[tauri::command]
fn save_material(core: State, mut material: Material) -> Result<(), String> {
    if material.title.trim().is_empty() || material.text.trim().is_empty() {
        return Err("请填写标题和材料内容".into());
    }
    if material.text.chars().count() > 100_000 {
        return Err("材料超过10万字，请精简后保存".into());
    }
    material.updated_at = now_ms();
    core.db
        .lock()
        .unwrap()
        .save_material(&material)
        .map_err(err)?;
    core.emit(json!({"type":"materialsChanged","sessionId":""}));
    Ok(())
}
#[tauri::command]
fn delete_material(core: State, id: String) -> Result<(), String> {
    core.db.lock().unwrap().delete_material(&id).map_err(err)?;
    core.emit(json!({"type":"materialsChanged","sessionId":""}));
    Ok(())
}
#[tauri::command]
fn delete_materials(core: State, ids: Vec<String>) -> Result<(), String> {
    core.db.lock().unwrap().delete_materials(&ids).map_err(err)?;
    core.emit(json!({"type":"materialsChanged","sessionId":""}));
    Ok(())
}
#[tauri::command]
fn delete_session(core: State, id: String) -> Result<(), String> {
    core.delete_session(&id).map_err(err)
}
#[tauri::command]
fn delete_sessions(core: State, ids: Vec<String>) -> Result<(), String> {
    core.delete_sessions(&ids).map_err(err)
}
#[tauri::command]
fn session_detail(core: State, id: String) -> Result<Value, String> {
    let db = core.db.lock().unwrap();
    Ok(
        json!({"transcripts":db.transcripts(&id).map_err(err)?,"answers":db.answers(&id).map_err(err)?}),
    )
}
#[tauri::command]
fn export_session(core: State, id: String, path: String) -> Result<(), String> {
    if !path.to_lowercase().ends_with(".md") {
        return Err("请保存为 .md 文件".into());
    }
    let text = core.db.lock().unwrap().export(&id).map_err(err)?;
    std::fs::write(path, text).map_err(err)
}
fn restore_main(app: &tauri::AppHandle) {
    interview_windows::request_restore(app);
}
#[tauri::command]
async fn show_answer(app: tauri::AppHandle) -> Result<(), String> {
    interview_windows::restore_answer(app).await
}
#[tauri::command]
fn app_data_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(err)?
        .to_string_lossy()
        .into())
}
#[tauri::command]
async fn create_data_backup(window: tauri::WebviewWindow, core: State<'_>, path: String) -> Result<(),String> {
    if window.label()!="main" {return Err("请在主窗口管理数据备份".into());}
    let core=core.inner().clone();
    tauri::async_runtime::spawn_blocking(move||core.create_data_backup(std::path::Path::new(&path)).map_err(err)).await.map_err(err)?
}
#[tauri::command]
async fn preview_data_restore(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> Result<data_backup::Preview,String> {
    if window.label()!="main" {return Err("请在主窗口管理数据备份".into());}
    let data=tauri::async_runtime::spawn_blocking(move||data_backup::DataBackup::read(std::path::Path::new(&path)).map_err(err)).await.map_err(err)??;
    let token=new_id();let preview=data.preview(token.clone());
    *app.state::<data_backup::PendingRestore>().0.lock().unwrap()=Some((token,data));
    Ok(preview)
}
#[tauri::command]
async fn restore_data_backup(app: tauri::AppHandle, window: tauri::WebviewWindow, core: State<'_>, token: String) -> Result<(),String> {
    if window.label()!="main" {return Err("请在主窗口管理数据备份".into());}
    let core=core.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let pending=app.state::<data_backup::PendingRestore>();
        let mut guard=pending.0.lock().unwrap();
        let (expected,data)=guard.as_ref().ok_or("请重新选择备份文件")?;
        if expected!=&token {return Err("备份预览已过期，请重新选择".into());}
        let directory=app.path().app_data_dir().map_err(err)?.join("data-backups");std::fs::create_dir_all(&directory).map_err(err)?;
        let rollback=directory.join(format!("before-restore-{}-{}.cuvilo-backup",now_ms(),new_id()));
        core.restore_data_backup(data,&rollback).map_err(err)?;
        *guard=None; Ok(())
    }).await.map_err(err)?
}
#[tauri::command]
fn get_answer_memory(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<window_memory::View,String> {
    if window.label()!="main" {return Err("请在主窗口管理窗口偏好".into());}
    Ok(app.state::<window_memory::Memory>().view())
}
#[tauri::command]
async fn set_answer_memory(app: tauri::AppHandle, window: tauri::WebviewWindow, remember: bool) -> Result<(),String> {
    if window.label()!="main" {return Err("请在主窗口管理窗口偏好".into());}
    tauri::async_runtime::spawn_blocking(move||app.state::<window_memory::Memory>().set(remember)).await.map_err(err)?
}
#[tauri::command]
fn discard_data_restore(app: tauri::AppHandle, window: tauri::WebviewWindow, token: String) -> Result<(),String> {
    if window.label()!="main" {return Err("请在主窗口管理数据备份".into());}
    let state=app.state::<data_backup::PendingRestore>();let mut pending=state.0.lock().unwrap();
    if pending.as_ref().is_some_and(|(id,_)|id==&token){*pending=None;}
    Ok(())
}
#[tauri::command]
fn report_ready(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    window_lifecycle::answer_ready(&window);
    use std::io::Write;
    let path = app.path().app_data_dir().map_err(err)?.join("runtime.log");
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(err)?;
    writeln!(log, "{} window={} ready", now_ms(), window.label()).map_err(err)
}
pub fn run() {
    match diagnostics::run() {
        Ok(true) => return,
        Ok(false) => {}
        Err(e) => {
            eprintln!("{e:#}");
            std::process::exit(1)
        }
    }
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let state = app.state::<Arc<Core>>();
            let settings = state.settings.lock().unwrap().clone();
            let matches=|value:&str| !value.trim().is_empty() && Shortcut::from_str(value).ok().as_ref()==Some(shortcut);
            if matches(&settings.shortcuts.toggle) {
                let app=app.clone();tauri::async_runtime::spawn(async move{let _=capture_protection::toggle_answer(app).await;});return;
            }
            if !interview_windows::active(app){return;}
            if matches(&settings.shortcuts.manual){let app=app.clone();tauri::async_runtime::spawn(async move{if let Err(error)=manual_question::open(app.clone()).await{app.state::<Arc<Core>>().emit(json!({"type":"workflowError","message":error}));}});return;}
            if matches(&settings.shortcuts.screen){if let Err(error)=screen_capture::start(app.clone()){state.emit(json!({"type":"workflowError","sessionId":screen_capture::session(&state).unwrap_or_default(),"message":error.to_string()}));}}
            else if matches(&settings.shortcuts.answer){if let Err(error)=state.inner().trigger(None,"short",None){state.emit(json!({"type":"workflowError","sessionId":screen_capture::session(&state).unwrap_or_default(),"message":error.to_string()}));}}
            else if matches(&settings.shortcuts.cancel){state.cancel_answer();screen_capture::clear(&state);}

        })
        .build();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| restore_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(plugin)
        .setup(|app| {
            if let Some(main) = app.get_webview_window("main") {
                if let Ok(hwnd) = main.hwnd() { window_style::apply(hwnd.0); }
            }
            let path = app.path().app_data_dir()?;
            std::fs::create_dir_all(&path)?;
            let core = Core::open(&path.join("interview.sqlite3"))?;
            app.manage(core.clone());
            app.manage(app_behavior::QuitState::default());
            app.manage(app_updater::PendingUpdate::default());
            app.manage(data_backup::PendingRestore::default());
            app.manage(window_memory::Memory::load(path.join("answer-window.json")));
            app.manage(window_lifecycle::AnswerLifecycle::default());
            let settings = core.settings.lock().unwrap().clone();
            window_theme::apply(app.handle(),&settings.theme).map_err(anyhow::Error::msg)?;
            app.manage(capture_protection::Protection::new(settings.capture_protection));
            app.manage(interview_windows::Mode::default());
            app.manage(window_memory::MainMemory::load(path.join("main-window.json")));
            if let Some(main)=app.get_webview_window("main"){window_memory::restore_main(app.handle(),&main).map_err(anyhow::Error::msg)?;}
            if let Err(e) = shortcuts(app.handle(), &settings) {
                core.warnings
                    .lock()
                    .unwrap()
                    .push(format!("{e}。可在设置中修改；服务配置仍可正常保存。"));
            }
            use tauri::menu::{Menu, MenuItem};
            let english=ui_language::english(&settings.language);
            let show = MenuItem::with_id(app, "show", if english {"Open Cuvilo"} else {"打开 Cuvilo"}, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", if english {"Quit"} else {"退出"}, true, None::<&str>)?;
            let version = MenuItem::with_id(app, "app-update", format!("{} {}", if english {"Version"} else {"版本"}, app.package_info().version), false, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &version, &quit])?;
            app.manage(tray_update::TrayUpdate(version));
            app.manage(ui_language::TrayLabels{show,quit});
            let mut tray = tauri::tray::TrayIconBuilder::with_id("main")
                .tooltip("Cuvilo")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        restore_main(app);
                    }
                    "app-update" => {
                        use tauri::Emitter;
                        restore_main(app);
                        let _ = app.emit_to("main", "app-update-tray-requested", ());
                    }
                    "quit" => {
                        app_behavior::request_quit(app);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let _=capture_protection::show_checked(app.handle(),"main");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label()=="main" && matches!(event,tauri::WindowEvent::Resized(_)){window_memory::capture_main(window.app_handle());}
            if window.label()=="answer" && matches!(event,tauri::WindowEvent::Moved(_)|tauri::WindowEvent::Resized(_)) {window_memory::capture(window.app_handle());}
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(_)) {
                if let Some(view)=window.app_handle().get_webview_window("main"){window_theme::refresh_caption(&view);}
            }
            if matches!(event,tauri::WindowEvent::ThemeChanged(_)){if let Some(view)=window.app_handle().get_webview_window(window.label()){let _=window_theme::sync_colors(&view);}}
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let preference=window.app_handle().try_state::<Arc<Core>>().map(|core|core.settings.lock().unwrap().close_action.clone()).unwrap_or_else(||"tray".into());
                match app_behavior::close_intent(window.label(),&preference){app_behavior::CloseIntent::Finish=>interview_windows::request_finish(window.app_handle()),app_behavior::CloseIntent::Quit=>app_behavior::request_quit(window.app_handle()),app_behavior::CloseIntent::Hide=>{let _=window.hide();}}

            }
        })
        .invoke_handler(tauri::generate_handler![
            update_caption::set_update_caption,
            tray_update::set_tray_update,
            app_updater::check_app_update,
            app_updater::download_app_update,
            app_updater::install_app_update,
            open_provider_help,
            report_ready,
            snapshot,
            subscribe,
            audio_sources,
            start_session,
            stop_session,
            request_answer,
            cancel_answer,
            save_settings,
            save_services,
            ui_language::system_language_name, save_preferences, system_theme_dark, prepare_theme_transition, preview_theme, preview_answer_opacity,
            get_autostart,
            set_autostart,
            remove_provider,
            test_provider,
            list_provider_models,
            read_provider_secret,
            test_audio,
            import_document,
            save_material,
            delete_material,
            delete_materials,
            session_detail,
            delete_session,
            delete_sessions,
            export_session,
            show_answer,
            app_data_path,
            create_data_backup,
            preview_data_restore,
            restore_data_backup,
            discard_data_restore,
            get_answer_memory,
            set_answer_memory,
            begin_screen_capture, cancel_screen_capture, submit_screen_question, correct_screen_question, screen_capture_image, screen_ocr_status
        ])
        .run(tauri::generate_context!())
        .expect("desktop application failed");
}

#[cfg(test)] mod reading_validation_tests {
 use super::*;
 #[test]fn theme_and_close_preferences_validate_without_changing_legacy_defaults(){let mut value=serde_json::to_value(Settings::default()).unwrap();value.as_object_mut().unwrap().remove("theme");value.as_object_mut().unwrap().remove("closeAction");let mut s:Settings=serde_json::from_value(value).unwrap();assert_eq!((&s.theme[..],&s.close_action[..]),("light","tray"));s.theme="dark".into();s.close_action="quit".into();assert!(validate_settings(&s,&[]).is_ok());s.theme="invalid".into();assert!(validate_settings(&s,&[]).is_err());s.theme="system".into();s.close_action="invalid".into();assert!(validate_settings(&s,&[]).is_err());}
 #[test] fn saved_reading_size_is_validated_at_the_native_boundary(){let mut s=Settings::default();s.font_size=31;assert!(validate_settings(&s,&[]).is_err());s.font_size=13;assert!(validate_settings(&s,&[]).is_err());s.font_size=30;assert!(validate_settings(&s,&[]).is_ok());}
}

#[cfg(test)]mod theme_sync_regression;

#[cfg(test)]mod builtin_ocr_tests{
 use super::*;
 #[test]fn free_ocr_selection_needs_no_saved_provider_or_key_and_keeps_other_settings(){let old=Settings::default();let mut next=old.clone();next.ocr_provider=cloud_ocr::YOUDAO_FREE_ID.into();assert!(validate_settings(&next,&[]).is_ok());assert_eq!(serde_json::to_value(next.providers).unwrap(),serde_json::to_value(old.providers).unwrap());assert_eq!(next.active_model,old.active_model);assert_eq!(next.asr_provider,old.asr_provider);}
}
