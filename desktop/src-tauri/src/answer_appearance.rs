//! Background opacity belongs to the WebView surface; foreground stays at native alpha 255.
use tauri::Manager;
#[cfg(target_os="windows")] #[path="opacity_style.rs"] mod opacity_style;
pub fn alpha(opacity:u32)->Result<u8,String>{if !(20..=100).contains(&opacity){return Err("答案窗背景透明度应在0–80%之间".into());}Ok(255)}
#[cfg(target_os="windows")]
pub fn apply(window:&tauri::WebviewWindow,opacity:u32)->Result<(),String>{
 window.set_background_color(Some(tauri::window::Color(0,0,0,0))).map_err(|e|e.to_string())?;
 let hwnd=windows::Win32::Foundation::HWND(window.hwnd().map_err(|e|e.to_string())?.0);apply_handle(hwnd,opacity)
}
#[cfg(target_os="windows")]
fn apply_handle(hwnd:windows::Win32::Foundation::HWND,opacity:u32)->Result<(),String>{
 use windows::Win32::{Foundation::COLORREF,UI::WindowsAndMessaging::*};
 let expected=alpha(opacity)?;
 unsafe{
  let previous=GetWindowLongPtrW(hwnd,GWL_EXSTYLE);if opacity==100&&previous&WS_EX_LAYERED.0 as isize==0{return Ok(());}
  let mut old_alpha=255;let _=GetLayeredWindowAttributes(hwnd,None,Some(&mut old_alpha),None);let mut before=0;GetWindowDisplayAffinity(hwnd,&mut before).map_err(|e|e.to_string())?;
  let added_guard=opacity_style::install(hwnd)?;
  if previous&WS_EX_LAYERED.0 as isize==0{SetWindowLongPtrW(hwnd,GWL_EXSTYLE,previous|WS_EX_LAYERED.0 as isize);}
  let result=(||->Result<(),String>{
   SetLayeredWindowAttributes(hwnd,COLORREF(0),expected,LWA_ALPHA).map_err(|e|e.to_string())?;
   let mut actual=0;GetLayeredWindowAttributes(hwnd,None,Some(&mut actual),None).map_err(|e|e.to_string())?;if actual!=expected{return Err("透明度核验失败".into());}
   let mut after=0;GetWindowDisplayAffinity(hwnd,&mut after).map_err(|e|e.to_string())?;if after!=before{return Err("窗口共享保护属性发生变化".into());}Ok(())
  })();
  if result.is_err(){if added_guard{opacity_style::remove(hwnd);}SetWindowLongPtrW(hwnd,GWL_EXSTYLE,previous);if previous&WS_EX_LAYERED.0 as isize!=0{let _=SetLayeredWindowAttributes(hwnd,COLORREF(0),old_alpha,LWA_ALPHA);}if before!=0{let _=SetWindowDisplayAffinity(hwnd,WINDOW_DISPLAY_AFFINITY(before));}let mut restored=0;if GetWindowDisplayAffinity(hwnd,&mut restored).is_err()||restored!=before{let _=ShowWindow(hwnd,SW_HIDE);}}
  result
 }
}
#[cfg(not(target_os="windows"))]pub fn apply(_:&tauri::WebviewWindow,opacity:u32)->Result<(),String>{alpha(opacity).map(|_|())}
pub fn existing(app:&tauri::AppHandle,opacity:u32)->Result<(),String>{if let Some(window)=app.get_webview_window("answer"){apply(&window,opacity)?;}Ok(())}
#[cfg(test)]mod tests{#[test]fn opacity_is_bounded_and_maps_to_native_alpha(){assert_eq!(super::alpha(100).unwrap(),255);assert_eq!(super::alpha(60).unwrap(),255);assert_eq!(super::alpha(80).unwrap(),255);assert!(super::alpha(0).is_err());assert_eq!(super::alpha(20).unwrap(),255);assert!(super::alpha(101).is_err());}}

#[cfg(all(test,target_os="windows"))]mod native_tests{
 #[test]fn actual_layered_window_preserves_capture_exclusion_at_all_opacities(){unsafe{
 use windows::{core::w,Win32::UI::WindowsAndMessaging::*};
 let hwnd=CreateWindowExW(WS_EX_TOOLWINDOW,w!("STATIC"),w!("Cuvilo isolated opacity fixture"),WS_OVERLAPPEDWINDOW,-30000,-30000,460,480,None,None,None,None).unwrap();
 struct Cleanup(windows::Win32::Foundation::HWND);impl Drop for Cleanup{fn drop(&mut self){unsafe{let _=DestroyWindow(self.0);}}}let _cleanup=Cleanup(hwnd);
 SetWindowDisplayAffinity(hwnd,WINDOW_DISPLAY_AFFINITY(17)).unwrap();
 for opacity in [60,20,25,80,100,65,100]{super::apply_handle(hwnd,opacity).unwrap();let mut alpha=0;GetLayeredWindowAttributes(hwnd,None,Some(&mut alpha),None).unwrap();assert_eq!(alpha,super::alpha(opacity).unwrap());let mut affinity=0;GetWindowDisplayAffinity(hwnd,&mut affinity).unwrap();assert_eq!(affinity,17);assert!(!IsWindowVisible(hwnd).as_bool());}
 }}
}

#[cfg(test)] #[path="opacity_visual_regression.rs"] mod visual_regression;

#[cfg(all(test,target_os="windows"))]mod style_regressions{
 #[test]fn style_refresh_keeps_alpha_and_protection_and_destroy_removes_guard(){unsafe{
  use windows::{core::w,Win32::UI::WindowsAndMessaging::*};
  let hwnd=CreateWindowExW(WS_EX_TOOLWINDOW,w!("STATIC"),w!("Cuvilo style fixture"),WS_OVERLAPPEDWINDOW,-30000,-30000,460,430,None,None,None,None).unwrap();
  SetWindowDisplayAffinity(hwnd,WINDOW_DISPLAY_AFFINITY(17)).unwrap();super::apply_handle(hwnd,60).unwrap();
  let previous=GetWindowLongPtrW(hwnd,GWL_EXSTYLE);SetWindowLongPtrW(hwnd,GWL_EXSTYLE,previous & !(WS_EX_LAYERED.0 as isize));
  assert_ne!(GetWindowLongPtrW(hwnd,GWL_EXSTYLE)&WS_EX_LAYERED.0 as isize,0);let mut alpha=0;GetLayeredWindowAttributes(hwnd,None,Some(&mut alpha),None).unwrap();assert_eq!(alpha,255);
  let mut affinity=0;GetWindowDisplayAffinity(hwnd,&mut affinity).unwrap();assert_eq!(affinity,17);assert!(super::opacity_style::installed(hwnd));
  DestroyWindow(hwnd).unwrap();assert!(!super::opacity_style::installed(hwnd));
 }}
}
