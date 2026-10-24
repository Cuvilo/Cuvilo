use tauri::Manager;
pub fn requested(preference:&str)->Option<tauri::Theme>{match preference{"dark"=>Some(tauri::Theme::Dark),"system"=>None,_=>Some(tauri::Theme::Light)}}
// Match Tao's Windows app-theme resolution without consulting a forced window.
fn resolved_system_dark(light:Option<u32>,high_contrast:bool)->bool{!high_contrast&&light==Some(0)}
pub fn system_dark()->bool{
 use winreg::{RegKey,enums::HKEY_CURRENT_USER};
 use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW,SPI_GETHIGHCONTRAST};
 use windows::Win32::UI::Accessibility::HIGHCONTRASTW;
 let mut contrast=HIGHCONTRASTW::default();contrast.cbSize=std::mem::size_of::<HIGHCONTRASTW>()as u32;
 let high_contrast=unsafe{SystemParametersInfoW(SPI_GETHIGHCONTRAST,contrast.cbSize,Some(&mut contrast as *mut _ as _),Default::default()).is_ok()}&&contrast.dwFlags.0&1!=0;
 let light=RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize").ok().and_then(|key|key.get_value::<u32,_>("AppsUseLightTheme").ok());
 resolved_system_dark(light,high_contrast)
}
fn effective_dark(preference:&str)->bool{match preference{"dark"=>true,"light"=>false,_=>system_dark()}}
static CAPTION_PREVIEW:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
struct CaptionPreview(u64);
impl CaptionPreview{fn new(ticket:u64)->Self{CAPTION_PREVIEW.store(ticket,std::sync::atomic::Ordering::SeqCst);Self(ticket)}}
impl Drop for CaptionPreview{fn drop(&mut self){let _=CAPTION_PREVIEW.compare_exchange(self.0,0,std::sync::atomic::Ordering::SeqCst,std::sync::atomic::Ordering::SeqCst);}}
pub fn refresh_caption(window:&tauri::WebviewWindow){
 if window.label()!="main"||CAPTION_PREVIEW.load(std::sync::atomic::Ordering::SeqCst)!=0{return;}
 if let Ok(hwnd)=window.hwnd(){crate::window_style::apply_theme(hwnd.0,window.theme().ok()==Some(tauri::Theme::Dark));}
}
fn surface_color(window:&tauri::WebviewWindow,dark:bool)->Result<(),String>{
 window.set_background_color(Some(if window.label()=="answer"{tauri::window::Color(0,0,0,0)}else if dark{tauri::window::Color(20,20,20,255)}else{tauri::window::Color(255,255,255,255)})).map_err(|_|"无法切换窗口背景".into())
}
pub fn sync_colors(window:&tauri::WebviewWindow)->Result<(),String>{
 // ThemeChanged also updates the WebView media query. The renderer starts the
 // caption fade from that notification; repainting it here would jump ahead.
 surface_color(window,window.theme().ok()==Some(tauri::Theme::Dark))
}
pub fn apply_window(window:&tauri::WebviewWindow,preference:&str)->Result<(),String>{
 #[cfg(target_os="windows")]let (hwnd,previous)={use windows::Win32::{Foundation::HWND,UI::WindowsAndMessaging::GetWindowDisplayAffinity};let hwnd=HWND(window.hwnd().map_err(|_|"无法读取窗口")?.0);let mut affinity=0;unsafe{GetWindowDisplayAffinity(hwnd,&mut affinity).map_err(|_|"无法读取窗口共享保护")?;} (hwnd,affinity)};
 let result=(||{
  let dark=effective_dark(preference);
  window.set_theme(requested(preference)).map_err(|_|"无法切换窗口主题")?;
  // set_theme queues a runtime message; window.theme() may still be the old
  // palette here. Paint the resolved target, rather than flashing that cache.
  surface_color(window,dark)?;
  if window.label()=="main"{if let Ok(hwnd)=window.hwnd(){crate::window_style::apply_theme(hwnd.0,dark);}}
  Ok(())
 })();
 #[cfg(target_os="windows")]unsafe{use windows::Win32::UI::WindowsAndMessaging::*;let mut after=0;if GetWindowDisplayAffinity(hwnd,&mut after).is_err()||after!=previous{let _=SetWindowDisplayAffinity(hwnd,WINDOW_DISPLAY_AFFINITY(previous));let mut restored=0;if GetWindowDisplayAffinity(hwnd,&mut restored).is_err()||restored!=previous{let _=window.hide();return Err("切换主题时共享保护核验失败".into());}}}
 result
}
fn apply_inner(app:&tauri::AppHandle,preference:&str)->Result<(),String>{
 for label in ["main","answer"]{if let Some(window)=app.get_webview_window(label){apply_window(&window,preference)?;}}Ok(())
}
pub fn apply(app:&tauri::AppHandle,preference:&str)->Result<(),String>{
 // A debounced preference save must not jump ahead of an in-flight palette fade.
 if CAPTION_PREVIEW.load(std::sync::atomic::Ordering::SeqCst)!=0{return Ok(());}
 apply_inner(app,preference)
}
#[cfg(test)]mod tests{#[test]fn explicit_and_system_themes(){assert_eq!(super::requested("light"),Some(tauri::Theme::Light));assert_eq!(super::requested("dark"),Some(tauri::Theme::Dark));assert_eq!(super::requested("system"),None);}}

// Caption and WebView use the same 180ms cubic-bezier(.2,0,0,1) clock.
// Tickets are issued before UI dispatch, so cancelled/late jobs cannot repaint.
static PREVIEW_TICKET:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
pub fn preview_ticket()->u64{PREVIEW_TICKET.fetch_add(1,std::sync::atomic::Ordering::SeqCst)+1}
pub fn preview_current(ticket:u64)->bool{PREVIEW_TICKET.load(std::sync::atomic::Ordering::SeqCst)==ticket}
pub fn fade_progress(linear:f64)->f64{
 let x=linear.clamp(0.,1.);let(mut low,mut high)=(0.,1.);
 for _ in 0..18{let t=(low+high)/2.;let a=1.-t;let estimate=3.*a*a*t*0.2+t*t*t;if estimate<x{low=t;}else{high=t;}}
 let t=(low+high)/2.;3.*(1.-t)*t*t+t*t*t
}
pub fn caption_values(window:&tauri::WebviewWindow)->(u32,u32){
 use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute,DWMWA_CAPTION_COLOR,DWMWA_TEXT_COLOR};
 let dark=window.theme().ok()==Some(tauri::Theme::Dark);let(mut caption,mut text)=if dark{(24u32,229u32)}else{(245u32,23u32)};
 if let Ok(hwnd)=window.hwnd(){unsafe{let mut value=0u32;if DwmGetWindowAttribute(windows::Win32::Foundation::HWND(hwnd.0),DWMWA_CAPTION_COLOR,&mut value as *mut _ as _,4).is_ok()&&value<=0xffffff{caption=value&255;}if DwmGetWindowAttribute(windows::Win32::Foundation::HWND(hwnd.0),DWMWA_TEXT_COLOR,&mut value as *mut _ as _,4).is_ok()&&value<=0xffffff{text=value&255;}}}
 (caption,text)
}
pub async fn preview(app:&tauri::AppHandle,preference:String,resolved_dark:Option<bool>,started:Option<f64>)->Result<(),String>{
 let animated=started.is_some();
 let ticket=preview_ticket();
 let _caption_preview=CaptionPreview::new(ticket);
 if let Some(start)=started{
  if !start.is_finite()||(start-crate::types::now_ms() as f64).abs()>1000.{return Err("外观过渡时间无效".into());}
  let chosen=preference.clone();
  let (from,to)=crate::capture_protection::on_ui(app,move|app|{
   let window=app.get_webview_window("main").ok_or("主窗口不存在")?;
   let dark=match chosen.as_str(){"dark"=>true,"light"=>false,_=>resolved_dark.unwrap_or_else(system_dark)};
   if preview_current(ticket){if let Some(core)=app.try_state::<std::sync::Arc<crate::core::Core>>(){core.emit(serde_json::json!({"type":"themePreview","sessionId":"","theme":chosen}));}}
   Ok((caption_values(&window),if dark{(24u32,229u32)}else{(245u32,23u32)}))
  }).await?;
  loop{
   if !preview_current(ticket){return Ok(());}
   let finished=crate::capture_protection::on_ui(app,move|app|{
    // Sample the clock on the UI thread; queued IPC/UI work must not cost a frame.
    let fraction=((crate::types::now_ms() as f64-start)/180.).clamp(0.,1.);
    let progress=fade_progress(fraction);
    if preview_current(ticket){if let Some(window)=app.get_webview_window("main"){if let Ok(hwnd)=window.hwnd(){let blend=|a:u32,b:u32|(a as f64+(b as f64-a as f64)*progress).round() as u32;crate::window_style::apply_neutral(hwnd.0,blend(from.0,to.0),blend(from.1,to.1));}}}Ok(fraction>=1.)
   }).await?;
   // apply_neutral already waits for DWM composition. A Windows 1ms
   // timer can round up to ~16ms and skip several high-refresh frames.
   if finished{break;}tokio::task::yield_now().await;
  }
 }
 if !preview_current(ticket){return Ok(());}
 let service=app.state::<crate::capture_protection::Protection>();let _guard=service.gate.lock().await;
 crate::capture_protection::on_ui(app,move|app|{if preview_current(ticket){apply_inner(&app,&preference)?;if !animated{if let Some(core)=app.try_state::<std::sync::Arc<crate::core::Core>>(){core.emit(serde_json::json!({"type":"themePreview","sessionId":"","theme":preference}));}}}Ok(())}).await
}

#[cfg(test)]mod system_resolution_tests{
 #[test]fn follows_the_os_app_theme_and_respects_high_contrast_without_a_window_cache(){
  assert!(super::resolved_system_dark(Some(0),false));assert!(!super::resolved_system_dark(Some(1),false));assert!(!super::resolved_system_dark(None,false));assert!(!super::resolved_system_dark(Some(0),true));
 }
}

// Prepare before the renderer releases its paused palette animation. Four frames
// of lead time let the IPC reply and caption worker reach the same start clock.
pub async fn schedule(app:&tauri::AppHandle,preference:String,dark:bool)->Result<(f64,tauri::async_runtime::JoinHandle<Result<(),String>>),String>{
 let start=crate::capture_protection::on_ui(app,|_|Ok(crate::types::now_ms()as f64+64.)).await?;
 let app=app.clone();let job=tauri::async_runtime::spawn(async move{preview(&app,preference,Some(dark),Some(start)).await});Ok((start,job))
}
