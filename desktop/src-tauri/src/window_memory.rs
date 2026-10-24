use serde::{Deserialize,Serialize};
use std::{path::PathBuf,sync::{Mutex,atomic::{AtomicU64,AtomicBool,Ordering}}};
use tauri::Manager;
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Bounds { x:i32,y:i32,width:f64,height:f64,scale:f64 }
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences { pub remember:bool,bounds:Option<Bounds>,#[serde(default,rename="compactVersion",skip_serializing_if="zero")]compact_version:u32 }
fn zero(value:&u32)->bool{*value==0}
impl Default for Preferences {fn default()->Self{Self{remember:true,bounds:None,compact_version:0}}}
pub struct Memory {path:PathBuf,prefs:Mutex<Preferences>,error:Mutex<Option<String>>,revision:AtomicU64,write_allowed:AtomicBool}
#[derive(Serialize)] pub struct View {remember:bool,error:Option<String>}
impl Bounds {fn valid(&self)->bool{self.width.is_finite()&&self.height.is_finite()&&self.scale.is_finite()&&(1.0..=8.0).contains(&self.scale)&&(360.0..=16384.0).contains(&self.width)&&(400.0..=16384.0).contains(&self.height)}}
impl Memory {
 pub fn load(path:PathBuf)->Self {
  let mut error=None;
  let prefs=match std::fs::read(&path){
   Ok(bytes)=>match serde_json::from_slice::<Preferences>(&bytes){Ok(value) if value.bounds.as_ref().is_none_or(Bounds::valid)=>value,_=>{error=Some("位置偏好读取失败，暂用默认位置；切换记忆开关可重新保存。".into());Preferences{remember:false,bounds:None,compact_version:0}}},
   Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Preferences::default(),
   Err(_)=>{error=Some("位置偏好暂不可读，原文件已保留。".into());Preferences{remember:false,bounds:None,compact_version:0}}
  };
  let write_allowed=error.is_none();
  Self{path,prefs:Mutex::new(prefs),error:Mutex::new(error),revision:AtomicU64::new(0),write_allowed:AtomicBool::new(write_allowed)}
 }
 fn write(&self,prefs:&Preferences)->Result<(),String>{
  let temporary=self.path.with_extension(format!("{}.tmp",crate::types::new_id()));
  let result=(||->Result<(),String>{use std::io::Write;let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e|e.to_string())?;file.write_all(&serde_json::to_vec(prefs).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;drop(file);std::fs::rename(&temporary,&self.path).map_err(|e|e.to_string())})();
  if result.is_err(){let _=std::fs::remove_file(&temporary);} result
 }
 pub fn view(&self)->View{View{remember:self.prefs.lock().unwrap().remember,error:self.error.lock().unwrap().clone()}}
 pub fn set(&self,remember:bool)->Result<(),String>{let mut prefs=self.prefs.lock().unwrap();let mut next=prefs.clone();next.remember=remember;self.write(&next)?;*prefs=next;self.revision.fetch_add(1,Ordering::SeqCst);*self.error.lock().unwrap()=None;self.write_allowed.store(true,Ordering::SeqCst);Ok(())}
 fn persist(&self){if !self.write_allowed.load(Ordering::SeqCst){return;}let prefs=self.prefs.lock().unwrap();if let Err(error)=self.write(&prefs){*self.error.lock().unwrap()=Some(format!("窗口位置未能保存：{error}"));}}
}
#[derive(Clone,Copy)] struct Area{x:i32,y:i32,width:u32,height:u32,scale:f64}
#[derive(Debug,PartialEq)] struct Placement{x:i32,y:i32,width:u32,height:u32}
fn fit(bounds:&Bounds,areas:&[Area])->Option<Placement>{
 if !bounds.valid(){return None;}
 let overlap=|area:&Area|{let right=(bounds.x as f64+bounds.width*bounds.scale).min(area.x as f64+area.width as f64);let bottom=(bounds.y as f64+bounds.height*bounds.scale).min(area.y as f64+area.height as f64);(right-bounds.x.max(area.x) as f64).max(0.0)*(bottom-bounds.y.max(area.y) as f64).max(0.0)};
 let target=areas.iter().max_by(|a,b|overlap(a).total_cmp(&overlap(b))).filter(|a|overlap(a)>0.0).or_else(||areas.first())?;
 let margin=(12.0*target.scale).round() as i32;
 let width=(bounds.width*target.scale).round().min((target.width as i32-2*margin).max(1) as f64) as u32;
 let height=(bounds.height*target.scale).round().min((target.height as i32-2*margin).max(1) as f64) as u32;
 let x=bounds.x.clamp(target.x+margin,(target.x+target.width as i32-width as i32-margin).max(target.x+margin));
 let y=bounds.y.clamp(target.y+margin,(target.y+target.height as i32-height as i32-margin).max(target.y+margin));
 Some(Placement{x,y,width,height})
}
// Tao's first resize of an undecorated shadowed window can include the old
// hidden caption in the client height. Correct from measured owned rectangles.
pub(crate) fn set_answer_size(window:&tauri::WebviewWindow,width:u32,height:u32)->Result<(),String>{
 window.set_size(tauri::PhysicalSize::new(width,height)).map_err(|e|e.to_string())?;
 #[cfg(target_os="windows")]unsafe{
  use windows::Win32::{Foundation::{HWND,RECT},UI::WindowsAndMessaging::*};
  let hwnd=HWND(window.hwnd().map_err(|e|e.to_string())?.0);
  for _ in 0..2{let mut client=RECT::default();let mut outer=RECT::default();GetClientRect(hwnd,&mut client).map_err(|e|e.to_string())?;GetWindowRect(hwnd,&mut outer).map_err(|e|e.to_string())?;
   let dx=width as i32-(client.right-client.left);let dy=height as i32-(client.bottom-client.top);if dx.abs()<=1&&dy.abs()<=1{return Ok(());}
   SetWindowPos(hwnd,None,0,0,(outer.right-outer.left+dx).max(1),(outer.bottom-outer.top+dy).max(1),SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE).map_err(|e|e.to_string())?;
  }
  let mut actual=RECT::default();GetClientRect(hwnd,&mut actual).map_err(|e|e.to_string())?;
  if ((actual.right-actual.left)-width as i32).abs()>1||((actual.bottom-actual.top)-height as i32).abs()>1{return Err("答案窗尺寸恢复失败，请重试".into());}
 }
 Ok(())
}
// Run on the UI thread: queued size changes must finish before measuring the client area.
pub fn restore(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Result<(),String>{
 let Some(memory)=app.try_state::<Memory>()else{return Ok(())};
 let prefs={let mut prefs=memory.prefs.lock().unwrap();
  if prefs.compact_version<1 && memory.write_allowed.load(Ordering::Acquire) {
   let mut next=prefs.clone();if let Some(bounds)=&mut next.bounds{bounds.width=360.0;bounds.height=400.0;}next.compact_version=1;
   memory.write(&next)?;*prefs=next;
  }
  prefs.clone()
 };if !prefs.remember{return Ok(());}let Some(bounds)=prefs.bounds else{return Ok(())};
 let mut monitors=window.available_monitors().map_err(|e|e.to_string())?;
 if let Some(primary)=window.primary_monitor().map_err(|e|e.to_string())?{monitors.sort_by_key(|m|m.position()!=primary.position());}
 let areas=monitors.iter().map(|m|{let area=m.work_area();Area{x:area.position.x,y:area.position.y,width:area.size.width,height:area.size.height,scale:m.scale_factor()}}).collect::<Vec<_>>();
 if let Some(p)=fit(&bounds,&areas){window.set_position(tauri::PhysicalPosition::new(p.x,p.y)).map_err(|e|e.to_string())?;set_answer_size(window,p.width,p.height)?;}
 Ok(())
}
pub fn capture(app:&tauri::AppHandle){
 let Some(memory)=app.try_state::<Memory>()else{return};
 let Some(window)=app.get_webview_window("answer")else{return};
 if !window.is_visible().unwrap_or(false)||window.is_minimized().unwrap_or(true){return;}
 let (Ok(position),Ok(size),Ok(scale))=(window.outer_position(),window.inner_size(),window.scale_factor())else{return};
 let bounds=Bounds{x:position.x,y:position.y,width:size.width as f64/scale,height:size.height as f64/scale,scale};
 if !bounds.valid(){return;}
 {let mut prefs=memory.prefs.lock().unwrap();if !prefs.remember{return;}prefs.bounds=Some(bounds);}
 let revision=memory.revision.fetch_add(1,Ordering::SeqCst)+1;let app=app.clone();
 tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_millis(350)).await;if app.state::<Memory>().revision.load(Ordering::SeqCst)==revision{let _=tauri::async_runtime::spawn_blocking(move||app.state::<Memory>().persist()).await;}});
}
pub fn flush(app:&tauri::AppHandle){if let Some(memory)=app.try_state::<Memory>(){memory.persist();}}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn removed_monitor_is_clamped_and_dpi_preserves_logical_size(){let bounds=Bounds{x:4000,y:-2000,width:460.0,height:480.0,scale:1.0};let p=fit(&bounds,&[Area{x:0,y:0,width:1920,height:1080,scale:1.5}]).unwrap();assert_eq!((p.width,p.height),(690,720));assert!(p.x>=18&&p.x+690<=1902);assert!(p.y>=18&&p.y+720<=1062);}
 #[test]fn negative_monitor_and_large_window_remain_accessible(){let b=Bounds{x:-1600,y:20,width:1600.0,height:900.0,scale:1.0};let p=fit(&b,&[Area{x:0,y:0,width:1920,height:1080,scale:1.0},Area{x:-1280,y:0,width:1280,height:720,scale:1.0}]).unwrap();assert!(p.x>=-1268&&p.x<0);assert!(p.width<=1256&&p.height<=696);}
 #[test]fn remember_toggle_persists_without_losing_bounds_and_corrupt_file_is_preserved(){let dir=tempfile::tempdir().unwrap();let path=dir.path().join("memory.json");let memory=Memory::load(path.clone());assert!(memory.view().remember);memory.prefs.lock().unwrap().bounds=Some(Bounds{x:100,y:120,width:460.0,height:480.0,scale:1.0});memory.set(false).unwrap();assert!(!Memory::load(path.clone()).view().remember);assert!(Memory::load(path.clone()).prefs.lock().unwrap().bounds.is_some());std::fs::write(&path,b"broken").unwrap();let broken=Memory::load(path.clone());assert!(!broken.view().remember);assert!(broken.view().error.is_some());broken.persist();assert_eq!(std::fs::read(&path).unwrap(),b"broken");broken.set(true).unwrap();assert!(Memory::load(path).view().remember);}
}

// Main window remembers size only; answer position/preferences remain independent.
pub struct MainMemory(Memory);
impl MainMemory { pub fn load(path:PathBuf)->Self{Self(Memory::load(path))} }
pub fn restore_main(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Result<(),String>{
 let Some(memory)=app.try_state::<MainMemory>()else{return Ok(())};
 let bounds=memory.0.prefs.lock().unwrap().bounds.clone();
 if let Some(bounds)=bounds.filter(|b|b.valid()){
  let monitor=window.current_monitor().ok().flatten().or_else(||window.primary_monitor().ok().flatten());
  let scale=monitor.as_ref().map(|m|m.scale_factor()).unwrap_or(1.0);
  let (max_w,max_h)=monitor.map(|m|{let a=m.work_area();(a.size.width as f64/scale,a.size.height as f64/scale)}).unwrap_or((16384.0,16384.0));
  window.set_size(tauri::LogicalSize::new(bounds.width.min(max_w).max(940.0),bounds.height.min(max_h).max(640.0))).map_err(|e|e.to_string())?;
  window.center().map_err(|e|e.to_string())?;
 }
 Ok(())
}
pub fn capture_main(app:&tauri::AppHandle){
 let Some(memory)=app.try_state::<MainMemory>()else{return};let memory=&memory.0;
 let Some(window)=app.get_webview_window("main")else{return};
 if !window.is_visible().unwrap_or(false)||window.is_minimized().unwrap_or(true)||window.is_maximized().unwrap_or(true){return;}
 let (Ok(size),Ok(scale))=(window.inner_size(),window.scale_factor())else{return};
 let bounds=Bounds{x:0,y:0,width:size.width as f64/scale,height:size.height as f64/scale,scale};
 if !bounds.valid()||bounds.width<939.5||bounds.height<639.5{return;}
 memory.prefs.lock().unwrap().bounds=Some(bounds);
 let revision=memory.revision.fetch_add(1,Ordering::SeqCst)+1;let app=app.clone();
 tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_millis(350)).await;if app.state::<MainMemory>().0.revision.load(Ordering::SeqCst)==revision{let _=tauri::async_runtime::spawn_blocking(move||app.state::<MainMemory>().0.persist()).await;}});
}
pub fn flush_main(app:&tauri::AppHandle){if let Some(memory)=app.try_state::<MainMemory>(){memory.0.persist();}}

#[cfg(test)]mod main_tests{
 use super::*;
 #[test]fn main_size_survives_restart_separately_from_answer_preferences(){let dir=tempfile::tempdir().unwrap();let path=dir.path().join("main.json");let memory=MainMemory::load(path.clone());memory.0.prefs.lock().unwrap().bounds=Some(Bounds{x:0,y:0,width:940.,height:640.,scale:1.25});memory.0.persist();let reread=MainMemory::load(path);let saved=reread.0.prefs.lock().unwrap().bounds.clone().unwrap();assert_eq!((saved.width,saved.height,saved.scale),(940.,640.,1.25));let answer=Memory::load(dir.path().join("answer.json"));assert!(answer.prefs.lock().unwrap().bounds.is_none());}
}
