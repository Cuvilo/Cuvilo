//! Screen questions. Pixels leave the device only for explicitly selected screenshot/OCR services.
use crate::{core::Core, types::{new_id, now_ms, Answer}, capture_protection};
use anyhow::{ensure, Context, Result};
use serde::Serialize;
use std::sync::{Arc, atomic::{AtomicBool,Ordering}};
use tauri::Manager;
#[path="screen_native.rs"] mod native;

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct CaptureState {
    pub version:u64, pub job_id:String, pub session_id:String, pub stage:String,
    pub text:String, pub error:String, pub question_id:String,
    pub fallback:bool,
    #[serde(skip)] pub vision_image:Option<Arc<VisionImage>>,
    #[serde(skip)] pub cancel:Arc<AtomicBool>,
    #[serde(skip)] pub image:Option<Arc<Vec<u8>>>,
}
impl Default for CaptureState {
 fn default()->Self {Self{version:0,job_id:String::new(),session_id:String::new(),stage:"idle".into(),text:String::new(),error:String::new(),question_id:String::new(),fallback:false,vision_image:None,cancel:Arc::new(AtomicBool::new(false)),image:None}}
}
pub struct VisionImage {pub png:Vec<u8>,width:i32,height:i32,pixels:Vec<u8>}
impl VisionImage {
 pub fn new(width:i32,height:i32,pixels:Vec<u8>)->Result<Self>{let png=crate::remote_ocr::png_image(width,height,&pixels)?;Ok(Self{png,width,height,pixels})}
}
fn vision_change(core:&Core,answer:&Answer,generation:u64,change:impl FnOnce(&mut CaptureState))->bool{
 let _guard=core.lifecycle.lock().unwrap();
 if core.generation.load(Ordering::SeqCst)!=generation||session(core).as_deref()!=Some(&answer.session_id){return false;}
 let mut state=core.screen.lock().unwrap();
 if state.session_id!=answer.session_id||state.question_id!=answer.question_id||state.cancel.load(Ordering::Acquire){return false;}
 change(&mut state);state.version+=1;let snapshot=state.clone();drop(state);publish(core,&snapshot);true
}
pub(crate) fn vision_progress(core:&Core,answer:&Answer,generation:u64,stage:&str,text:&str,fallback:bool)->bool{
 vision_change(core,answer,generation,|state|{state.stage=stage.into();state.text=text.into();state.fallback=fallback;state.error.clear();})
}
pub(crate) fn vision_error(core:&Core,answer:&Answer,generation:u64,message:&str){
 vision_change(core,answer,generation,|state|{state.stage="error".into();state.text=answer.question.clone();state.error=message.into();core.screen_priority.store(false,Ordering::Release);});
}
pub(crate) async fn recognize_image(image:Arc<VisionImage>,settings:crate::types::Settings,cancel:Arc<AtomicBool>)->Result<String>{
 ensure!(!cancel.load(Ordering::Acquire),"识别已取消");
 if settings.ocr_provider=="local" {
  let crop=native::Crop{width:image.width,height:image.height,pixels:image.pixels.clone()};
  let (text,_)=tauri::async_runtime::spawn_blocking(move||native::recognize(crop,cancel)).await??;Ok(text)
 }else{
  let (p,secret)=crate::remote_ocr::service(&settings).await?;
  crate::remote_ocr::recognize(&p,&secret,&settings.network,image.width,image.height,image.pixels.clone(),cancel).await
 }
}
// Never use the configured remote OCR for auxiliary knowledge retrieval.
pub(crate) async fn knowledge_text(image:Arc<VisionImage>,cancel:tokio_util::sync::CancellationToken)->Option<String>{
 let flag=Arc::new(AtomicBool::new(false));let worker_flag=flag.clone();
 let crop=native::Crop{width:image.width,height:image.height,pixels:image.pixels.clone()};
 let task=tauri::async_runtime::spawn_blocking(move||native::recognize(crop,worker_flag));
 let result=tokio::select!{_=cancel.cancelled()=>None,result=tokio::time::timeout(std::time::Duration::from_secs(3),task)=>result.ok().and_then(|v|v.ok()).and_then(|v|v.ok()).map(|v|v.0)};
 flag.store(true,Ordering::Release);
 result.filter(|text|text.chars().filter(|c|!c.is_whitespace()).count()>=5)
}
pub fn session(core:&Core)->Option<String>{core.runtime.lock().unwrap().as_ref().filter(|r|!r.cancel.is_cancelled()).map(|r|r.session.id.clone())}
fn publish(core:&Core,state:&CaptureState){core.emit(serde_json::json!({"type":"screenCapture","sessionId":state.session_id,"screenCapture":state}));}
fn update(core:&Core,id:&str,change:impl FnOnce(&mut CaptureState))->bool {
 let mut state=core.screen.lock().unwrap();
 if state.job_id!=id||state.cancel.load(Ordering::Acquire){return false;}
 change(&mut state);state.version+=1;let snapshot=state.clone();drop(state);publish(core,&snapshot);true
}
pub fn clear(core:&Core){
 let mut state=core.screen.lock().unwrap();state.cancel.store(true,Ordering::Release);
 let version=state.version+1;let session_id=state.session_id.clone();
 *state=CaptureState{version,session_id,..Default::default()};
 let snapshot=state.clone();drop(state);core.screen_priority.store(false,Ordering::Release);publish(core,&snapshot);
}
pub fn answered(core:&Core,answer:&Answer){
 let mut state=core.screen.lock().unwrap();
 let current=core.active_answer.lock().unwrap().as_ref().is_some_and(|a|a.id==answer.id&&a.status!="generating");
 if !current{return;}
 if !matches!(state.stage.as_str(),"capturing"|"recognizing"|"ready") {core.screen_priority.store(false,Ordering::Release);}
 if state.session_id==answer.session_id && state.question_id==answer.question_id && state.stage=="answering" {
  state.stage="answered".into();state.version+=1;let snapshot=state.clone();drop(state);core.screen_priority.store(false,Ordering::Release);publish(core,&snapshot);
 }
}
pub fn validate_text(text:&str)->Result<()> {
 ensure!(!text.trim().is_empty(),"未识别出文字，请重新框选或手动输入题目");
 ensure!(text.chars().count()<=12000,"题目过长，请缩小选区（最多12000字）");Ok(())
}
pub fn submit(core:&Arc<Core>,id:&str,text:String)->Result<()> {
 validate_text(&text)?;
 let session=session(core).context("面试已结束")?;
 let (qid,revision,snapshot)={
  let mut state=core.screen.lock().unwrap();
  ensure!(state.job_id==id&&state.session_id==session&&!state.cancel.load(Ordering::Acquire),"截图任务已失效，请重新框选");
  ensure!(matches!(state.stage.as_str(),"ready"|"error"|"answered"),"截图任务仍在进行");
  let qid=if state.question_id.is_empty(){new_id()}else{state.question_id.clone()};
  let revision=core.db.lock().unwrap().answers(&session)?.into_iter().filter(|a|a.question_id==qid).map(|a|a.revision).max().unwrap_or(0)+1;
  state.question_id=qid.clone();state.text=text.clone();state.stage="answering".into();state.error.clear();state.version+=1;(qid,revision,state.clone())
 };
 publish(core,&snapshot);
 if let Err(error)=core.launch_answer(&session,qid,text,revision,now_ms(),"screen") {
  update(core,id,|s|{s.stage="error".into();s.error=error.to_string();core.screen_priority.store(false,Ordering::Release);});return Err(error);
 }
 Ok(())
}
pub fn correct(core:&Arc<Core>,qid:String,text:String)->Result<()> {
 validate_text(&text)?;let session=session(core).context("面试已结束")?;
 let old=core.db.lock().unwrap().answers(&session)?.into_iter().rev().find(|a|a.question_id==qid&&a.mode.starts_with("screen")).context("屏幕题不存在")?;
 ensure!(!core.screen_priority.load(Ordering::Acquire),"请先完成或取消当前截图任务");
 core.launch_answer(&session,qid,text,old.revision+1,old.speech_end_at,"screen")
}
fn auto_submit(core:&Arc<Core>,id:&str,text:String){
 // Drop the settings guard before submit -> launch_answer reads settings again.
 let confirm=core.settings.lock().unwrap().screen_capture.confirm_before_answer;
 if !confirm{let _=submit(core,id,text);}
}
// Diagnostic metadata only: never log pixels, recognized text, prompts or credentials.
fn trace_windows(app:&tauri::AppHandle,phase:&str){
 use std::io::Write;
 let main=app.get_webview_window("main").and_then(|w|w.is_visible().ok());
 let answer=app.get_webview_window("answer").and_then(|w|w.is_visible().ok());
 if let Ok(directory)=app.path().app_data_dir(){if let Ok(mut log)=std::fs::OpenOptions::new().create(true).append(true).open(directory.join("runtime.log")){let _=writeln!(log,"{} screen={} main_visible={:?} answer_visible={:?}",now_ms(),phase,main,answer);}}
}
async fn restore_answer(app:&tauri::AppHandle,core:&Core,id:&str,session_id:&str)->Result<()> {
 trace_windows(app,"restore_wait");
 let service=app.state::<capture_protection::Protection>();let _guard=service.gate.lock().await;
 let restore={let state=core.screen.lock().unwrap();state.job_id==id||state.stage=="idle"};
 if session(core).as_deref()==Some(session_id)&&restore&&crate::interview_windows::active(app){
  trace_windows(app,"restore_present");
  capture_protection::present_locked(app,"answer").await.map_err(anyhow::Error::msg)?;
 }
 Ok(())
}
async fn recover_visible_entry(app:&tauri::AppHandle,core:&Core,session_id:&str){
 if session(core).as_deref()!=Some(session_id){return;}
 let restored=capture_protection::on_ui(app,|app|{
  // Restore the tray first, even if presenting the main window also fails.
  if let Some(tray)=app.tray_by_id("main"){tray.set_visible(true).map_err(|e|e.to_string())?;}
  let shown=capture_protection::show_checked(&app,"main");
  if let Some(main)=app.get_webview_window("main"){crate::taskbar::configure(&main,false)?;}
  shown
 }).await;
 if restored.is_ok(){core.emit(serde_json::json!({"type":"workflowError","sessionId":session_id,"message":"答案窗口恢复失败，已返回主窗口。"}));}
 trace_windows(app,"restore_recovery");
}
pub fn start(app:tauri::AppHandle)->Result<()> {
 let core=app.state::<Arc<Core>>().inner().clone();let guard=core.lifecycle.lock().unwrap();let session=session(&core).context("请先开始面试")?;
 ensure!(crate::interview_windows::active(&app),"请等待答案窗口打开后再截图");
 let (id,cancel)={
  let mut state=core.screen.lock().unwrap();
  ensure!(!matches!(state.stage.as_str(),"capturing"|"recognizing"|"ready"|"answering"),"请先完成或取消当前截图提问");
  state.cancel.store(true,Ordering::Release);
  let id=new_id();let cancel=Arc::new(AtomicBool::new(false));let version=state.version+1;
  *state=CaptureState{version,job_id:id.clone(),session_id:session.clone(),stage:"capturing".into(),cancel:cancel.clone(),..Default::default()};
  let snapshot=state.clone();drop(state);core.screen_priority.store(true,Ordering::Release);publish(&core,&snapshot);(id,cancel)
 };
 drop(guard);
 tauri::async_runtime::spawn(async move {
  trace_windows(&app,"begin");
  let mut restoration_attempted=false;
  let mut vision_dispatched=false;
  let result:Result<Option<(String,Vec<u8>)>>=async {
   // Hold the shared window gate only for showing/hiding, never while awaiting user selection.
   {let service=app.state::<capture_protection::Protection>();let _guard=service.gate.lock().await;
    let worker=core.clone();let target=session.clone();
    capture_protection::on_ui(&app,move |app|{
     if self::session(&worker).as_deref()!=Some(&target)||!crate::interview_windows::active(&app){return Err("面试已结束".into());}
     for label in ["main","answer"]{if let Some(w)=app.get_webview_window(label){crate::window_lifecycle::hide_checked(&w)?;}}
     Ok(())
    }).await.map_err(anyhow::Error::msg)?;
   }
   trace_windows(&app,"hidden");
   tokio::time::sleep(std::time::Duration::from_millis(60)).await;
   let flag=cancel.clone();let crop=tauri::async_runtime::spawn_blocking(move||native::select(flag)).await??;
   trace_windows(&app,"picker_closed");
   let Some(crop)=crop else{return Ok(None)};
   if cancel.load(Ordering::Acquire){return Ok(None)}
   if !update(&core,&id,|s|s.stage="recognizing".into()){return Ok(None)}
   trace_windows(&app,"recognizing");
   // The frozen picker is gone. Restore now so slow OCR has visible progress and Cancel.
   restoration_attempted=true;
   if let Err(error)=restore_answer(&app,&core,&id,&session).await{recover_visible_entry(&app,&core,&session).await;return Err(error);}trace_windows(&app,"answer_restored");
   let settings=core.settings.lock().unwrap().clone();
   if !settings.screenshot_model.is_empty(){
    let (image,original)=tauri::async_runtime::spawn_blocking(move||{let original=native::bmp(&crop);VisionImage::new(crop.width,crop.height,crop.pixels).map(|image|(Arc::new(image),original))}).await??;
    let qid=new_id();
    if !update(&core,&id,|state|{state.stage="answering".into();state.question_id=qid.clone();state.text="截图提问".into();state.image=Some(Arc::new(original));state.vision_image=Some(image);}){return Ok(None);}
    core.launch_answer(&session,qid,"截图提问".into(),1,now_ms(),"screen-vision")?;
    vision_dispatched=true;return Ok(None);
   }
   let recognized=if settings.ocr_provider=="local"{
    let flag=cancel.clone();tauri::async_runtime::spawn_blocking(move||native::recognize(crop,flag)).await??
   }else{
    let (provider,secret)=crate::remote_ocr::service(&settings).await?;
    let original=native::bmp(&crop);
    let text=crate::remote_ocr::recognize(&provider,&secret,&settings.network,crop.width,crop.height,crop.pixels,cancel.clone()).await?;
    (text,original)
   };trace_windows(&app,"ocr_complete");
   Ok(Some(recognized))
  }.await;
  if self::session(&core).as_deref()==Some(&session) {
   if !restoration_attempted {if let Err(error)=restore_answer(&app,&core,&id,&session).await {recover_visible_entry(&app,&core,&session).await;core.status(&session,"screen-window",&error.to_string(),true);}}
   if cancel.load(Ordering::Acquire){return;}
   match result {
    Ok(Some((text,image)))=>{
     if let Err(error)=validate_text(&text){update(&core,&id,|s|{s.stage="error".into();s.error=error.to_string();s.image=Some(Arc::new(image));core.screen_priority.store(false,Ordering::Release);});return;}
     if !update(&core,&id,|s|{s.stage="ready".into();s.text=text.clone();s.image=Some(Arc::new(image));}){return;}
     auto_submit(&core,&id,text);
    },
    Ok(None)=>{if !vision_dispatched{clear(&core);}},
    Err(error)=>{update(&core,&id,|s|{s.stage="error".into();s.error=format!("{error:#}");core.screen_priority.store(false,Ordering::Release);});}
   }
  }
 });Ok(())
}
#[derive(Serialize)] pub struct OcrStatus{pub available:bool,pub languages:Vec<String>,pub message:String}
pub fn availability()->OcrStatus {match native::languages(){Ok(languages)=>OcrStatus{available:!languages.is_empty(),message:if languages.is_empty(){"请在 Windows 语言选项中安装 OCR 语言组件".into()}else{"本地 Windows OCR；仅识别文字发送给回答模型".into()},languages},Err(e)=>OcrStatus{available:false,languages:vec![],message:format!("本地识别不可用：{e}")}}}
pub fn image(core:&Core,id:&str)->Result<String>{use base64::Engine;let state=core.screen.lock().unwrap();ensure!(state.job_id==id,"原截图已释放，请重新框选");let image=state.image.as_ref().context("原截图已释放")?;Ok(format!("data:image/bmp;base64,{}",base64::engine::general_purpose::STANDARD.encode(image.as_ref())))}

#[cfg(test)] mod tests {
 use super::*;
 #[test]fn question_limits_preserve_code(){assert!(validate_text("  \n ").is_err());assert!(validate_text(&"题".repeat(12001)).is_err());assert!(validate_text("if (a <= b) {\n  x_y++;\n}").is_ok());}
 #[test]fn clear_invalidates_old_jobs_and_pixels(){let dir=tempfile::tempdir().unwrap();let core=Core::open(&dir.path().join("fixture.sqlite3")).unwrap();let old=Arc::new(AtomicBool::new(false));*core.screen.lock().unwrap()=CaptureState{job_id:"old".into(),cancel:old.clone(),image:Some(Arc::new(vec![1,2])),..Default::default()};clear(&core);assert!(old.load(Ordering::Acquire));assert!(!update(&core,"old",|s|s.text="late".into()));assert!(core.screen.lock().unwrap().image.is_none());}
}

#[cfg(test)]mod lifecycle_tests{
 use super::*;use crate::{core::Runtime,types::*};use tokio_util::sync::CancellationToken;
 fn answer(id:&str,qid:&str)->Answer{Answer{sources:Vec::new(),id:id.into(),session_id:"fixture".into(),question_id:qid.into(),revision:1,question:"fixture question".into(),text:"fixture answer".into(),status:"generating".into(),mode:"screen".into(),created_at:1,speech_end_at:1,trigger_at:1,request_at:1,first_token_ms:None,first_sentence_ms:None}}
 fn active()->Arc<Core>{let core=Core::open(std::path::Path::new(":memory:")).unwrap();let session=Session{id:"fixture".into(),title:"fixture".into(),created_at:1,ended_at:None};core.db.lock().unwrap().session(&session).unwrap();*core.runtime.lock().unwrap()=Some(Runtime{session,cancel:CancellationToken::new()});core}
 #[test]fn missing_model_keeps_ocr_text_for_retry_and_releases_priority(){let core=active();core.settings.lock().unwrap().providers.clear();*core.screen.lock().unwrap()=CaptureState{job_id:"job".into(),session_id:"fixture".into(),stage:"ready".into(),..Default::default()};core.screen_priority.store(true,Ordering::Release);assert!(submit(&core,"job","if (a <= b) return a;".into()).is_err());let state=core.screen.lock().unwrap();assert_eq!(state.stage,"error");assert_eq!(state.text,"if (a <= b) return a;");assert!(!core.screen_priority.load(Ordering::Acquire));}
 #[test]fn late_generation_cannot_overwrite_a_newer_screen_question_or_ended_session(){let core=active();core.generation.store(2,Ordering::SeqCst);*core.active_answer.lock().unwrap()=Some(answer("new","new-question"));*core.screen.lock().unwrap()=CaptureState{job_id:"new-job".into(),session_id:"fixture".into(),stage:"answering".into(),question_id:"new-question".into(),..Default::default()};core.screen_priority.store(true,Ordering::Release);let old=answer("old","old-question");assert!(!core.publish_generation(&old,1,false));assert!(!core.publish_generation(&old,1,true));assert_eq!(core.active_answer.lock().unwrap().as_ref().unwrap().id,"new");assert!(core.screen_priority.load(Ordering::Acquire));assert!(core.db.lock().unwrap().answers("fixture").unwrap().is_empty());core.stop().unwrap();assert!(!core.publish_generation(&old,2,true));assert_eq!(core.screen.lock().unwrap().stage,"idle");}
 #[test]fn old_settings_preserve_custom_shortcuts_and_gain_safe_capture_defaults(){let mut value=serde_json::to_value(Settings::default()).unwrap();value.as_object_mut().unwrap().remove("screenCapture");value["shortcuts"].as_object_mut().unwrap().remove("screen");value["shortcuts"]["answer"]=serde_json::json!("Ctrl+Alt+Backspace");let settings:Settings=serde_json::from_value(value).unwrap();assert_eq!(settings.shortcuts.answer,"Ctrl+Alt+Backspace");assert_eq!(settings.shortcuts.screen,"Ctrl+Shift+S");assert!(!settings.screen_capture.shift_double_click);assert!(!settings.screen_capture.confirm_before_answer);}
}

#[cfg(test)] #[path="capture_restore_regression.rs"] mod restore_regression;

#[cfg(test)] mod lock_regressions {
 use super::*;
 #[test]fn automatic_submission_releases_settings_and_state_before_dispatch(){
  let directory=tempfile::tempdir().unwrap();let path=directory.path().join("fixture.sqlite3");
  let mut settings=crate::types::Settings::default();settings.providers.clear();settings.screen_capture.confirm_before_answer=false;
  {let db=crate::storage::Database::open(&path).unwrap();db.save_settings(&settings).unwrap();}
  let core=Core::open(&path).unwrap();let session=crate::types::Session{id:"lock-fixture".into(),title:"synthetic".into(),created_at:1,ended_at:None};
  core.db.lock().unwrap().session(&session).unwrap();*core.runtime.lock().unwrap()=Some(crate::core::Runtime{session,cancel:tokio_util::sync::CancellationToken::new()});
  *core.screen.lock().unwrap()=CaptureState{job_id:"lock-job".into(),session_id:"lock-fixture".into(),stage:"ready".into(),..Default::default()};
  let worker=core.clone();core.channels.lock().unwrap().push(tauri::ipc::Channel::new(move|_|{assert!(worker.screen.try_lock().is_ok(),"event emitted while screen lock held");assert!(worker.settings.try_lock().is_ok(),"event emitted while settings lock held");Ok(())}));
  let(tx,rx)=std::sync::mpsc::channel();let worker=core.clone();std::thread::spawn(move||{auto_submit(&worker,"lock-job","synthetic x=1".into());let _=tx.send(());});
  rx.recv_timeout(std::time::Duration::from_secs(3)).expect("automatic submission deadlocked");assert_eq!(core.screen.lock().unwrap().stage,"error");
  core.channels.lock().unwrap().clear();
 }
}
