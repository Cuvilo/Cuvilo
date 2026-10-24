//! Optional Shift + double-click. Hook callbacks never block on app state or perform capture.
use crate::{core::Core,screen_capture};
use std::{cell::Cell,sync::{Arc,OnceLock},time::Instant};
use tauri::Manager;
use windows::Win32::{Foundation::*,UI::{WindowsAndMessaging::*,Input::KeyboardAndMouse::*}};
static APP:OnceLock<tauri::AppHandle>=OnceLock::new();
thread_local!{static LAST:Cell<Option<(Instant,i32,i32)>>=const{Cell::new(None)};static SWALLOW:Cell<bool>=const{Cell::new(false)};}
unsafe extern "system" fn hook(code:i32,w:WPARAM,l:LPARAM)->LRESULT{
 if code>=0 {
  if w.0==WM_LBUTTONUP as usize && SWALLOW.with(|s|s.replace(false)){return LRESULT(1)}
  if w.0==WM_LBUTTONDOWN as usize {
   let down=&*(l.0 as *const MSLLHOOKSTRUCT);
   let enabled=APP.get().is_some_and(|app| crate::interview_windows::active(app)&&app.state::<Arc<Core>>().settings.try_lock().is_ok_and(|s|s.screen_capture.shift_double_click));
   if enabled&&down.flags&1==0&&GetAsyncKeyState(VK_SHIFT.0 as i32)<0 {
    let now=Instant::now();let old=LAST.with(|s|s.replace(Some((now,down.pt.x,down.pt.y))));
    let dx=GetSystemMetrics(SM_CXDOUBLECLK).max(2);let dy=GetSystemMetrics(SM_CYDOUBLECLK).max(2);
    if old.is_some_and(|(at,x,y)|now.duration_since(at).as_millis()<=GetDoubleClickTime()as u128&&(x-down.pt.x).abs()<=dx&&(y-down.pt.y).abs()<=dy){
     LAST.with(|s|s.set(None));SWALLOW.with(|s|s.set(true));
     if let Some(app)=APP.get(){let app=app.clone();tauri::async_runtime::spawn(async move{if let Err(e)=screen_capture::start(app.clone()){let core=app.state::<Arc<Core>>();let id=screen_capture::session(&core).unwrap_or_default();core.emit(serde_json::json!({"type":"workflowError","sessionId":id,"message":e.to_string()}));}});}
     return LRESULT(1);
    }
   }else{LAST.with(|s|s.set(None));}
  }
 }
 CallNextHookEx(None,code,w,l)
}
pub fn install(app:tauri::AppHandle){
 if APP.set(app).is_err(){return;}
 std::thread::spawn(||unsafe{let Ok(handle)=SetWindowsHookExW(WH_MOUSE_LL,Some(hook),None,0)else{if let Some(app)=APP.get(){app.state::<Arc<Core>>().warnings.lock().unwrap().push("鼠标截图手势不可用，请使用快捷键或菜单截图".into());}return;};let mut message=MSG::default();while GetMessageW(&mut message,None,0,0).0>0 {let _=TranslateMessage(&message);DispatchMessageW(&message);}let _=UnhookWindowsHookEx(handle);});
}
