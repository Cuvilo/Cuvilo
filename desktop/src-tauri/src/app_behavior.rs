use std::sync::atomic::{AtomicBool,Ordering};
use tauri::Manager;
#[derive(Default)]pub struct QuitState(AtomicBool);
#[derive(Debug,PartialEq)]pub enum CloseIntent{Hide,Quit,Finish}
pub fn close_intent(label:&str,preference:&str)->CloseIntent{if label=="answer"{CloseIntent::Finish}else if label=="main"&&preference=="quit"{CloseIntent::Quit}else{CloseIntent::Hide}}
pub fn request_quit(app:&tauri::AppHandle){
 let state=app.state::<QuitState>();if state.0.swap(true,Ordering::SeqCst){return;}
 let app=app.clone();tauri::async_runtime::spawn(async move{
  let protection=app.state::<crate::capture_protection::Protection>();let _guard=protection.gate.lock().await;
  let result=crate::window_lifecycle::on_ui(&app,|app|{
   let core=app.state::<std::sync::Arc<crate::core::Core>>();core.stop().map_err(|_|"结束保存失败，未退出程序".to_string())?;core.db.lock().unwrap().checkpoint().map_err(|_|"数据备份失败，未退出程序".to_string())?;
   crate::window_memory::flush(&app);crate::window_memory::flush_main(&app);app.exit(0);Ok(())
  }).await;
  if let Err(message)=result{app.state::<QuitState>().0.store(false,Ordering::SeqCst);app.state::<std::sync::Arc<crate::core::Core>>().emit(serde_json::json!({"type":"workflowError","sessionId":"","message":message}));let running=app.state::<std::sync::Arc<crate::core::Core>>().runtime.lock().unwrap().is_some();if running{crate::interview_windows::request_restore(&app);}else{let _=crate::interview_windows::restore_preparation(&app).await;}}
 });
}
#[cfg(test)]mod tests{use super::*;#[test]fn answer_finish_is_independent_of_main_close_preference(){assert_eq!(close_intent("answer","quit"),CloseIntent::Finish);assert_eq!(close_intent("answer","tray"),CloseIntent::Finish);assert_eq!(close_intent("main","quit"),CloseIntent::Quit);assert_eq!(close_intent("main","tray"),CloseIntent::Hide);assert_eq!(close_intent("helper","quit"),CloseIntent::Hide);}}
