use crate::{capture_protection,core::Core,interview_windows,screen_capture};
use std::sync::Arc;
use tauri::Manager;
fn allowed(active:bool,stage:&str)->bool{active&&!matches!(stage,"capturing"|"recognizing"|"ready")}
pub async fn open(app:tauri::AppHandle)->Result<(),String>{
 let service=app.state::<capture_protection::Protection>();let _guard=service.gate.lock().await;
 let core=app.state::<Arc<Core>>().inner().clone();
 let Some(session)=screen_capture::session(&core)else{return Ok(())};
 let stage=core.screen.lock().unwrap().stage.clone();
 if !allowed(interview_windows::active(&app),&stage)||crate::window_lifecycle::closing(&app){return Ok(())}
 capture_protection::present_locked(&app,"answer").await?;
 let stage=core.screen.lock().unwrap().stage.clone();
 if allowed(interview_windows::active(&app),&stage)&&screen_capture::session(&core).as_deref()==Some(session.as_str()){
  core.emit(serde_json::json!({"type":"manualQuestionRequested","sessionId":session}));
 }
 Ok(())
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn manual_entry_never_interrupts_selection_recognition_or_confirmation(){
  assert!(!allowed(false,"idle"));for stage in ["capturing","recognizing","ready"]{assert!(!allowed(true,stage));}
  for stage in ["idle","error","answered","answering"]{assert!(allowed(true,stage));}
 }
 #[test]fn legacy_manual_default_preserves_custom_bindings_and_explicit_disabling(){
  let old=|answer:&str|serde_json::json!({"answer":answer,"cancel":"Ctrl+Shift+X","toggle":"Ctrl+Shift+H","screen":"Ctrl+Shift+S"});
  let normal:crate::types::Shortcuts=serde_json::from_value(old("Ctrl+Enter")).unwrap();assert_eq!(normal.manual,"Ctrl+Shift+M");
  let custom:crate::types::Shortcuts=serde_json::from_value(old("Ctrl+Shift+M")).unwrap();assert_eq!(custom.answer,"Ctrl+Shift+M");assert!(custom.manual.is_empty());
  let mut disabled=old("Ctrl+Enter");disabled["manual"]=serde_json::json!("");assert!(serde_json::from_value::<crate::types::Shortcuts>(disabled).unwrap().manual.is_empty());
 }
}
