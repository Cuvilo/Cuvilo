//! Synthetic owned windows only: verify real pixels without capturing user content.
use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
use tauri::Manager;
use windows::Win32::{Foundation::HWND,Graphics::Gdi::*,UI::WindowsAndMessaging::*};
fn color(x:i32,y:i32)->[u8;3]{unsafe{let dc=GetDC(None);let value=GetPixel(dc,x,y).0;ReleaseDC(None,dc);[(value&255)as u8,((value>>8)&255)as u8,((value>>16)&255)as u8]}}
#[test]
#[ignore="isolated compositor fixture; run alone with common-controls manifest"]
fn webview_background_blends_while_foreground_and_caption_remain_opaque(){
 let directory=tempfile::tempdir().unwrap();let background=directory.path().join("background.html");let paper=directory.path().join("paper.html");
 std::fs::write(&background,"<style>html,body{margin:0;height:100%;background:rgb(32,80,160)}</style>").unwrap();
 std::fs::write(&paper,"<style>html,body{margin:0;height:100%;background:transparent}#paper{position:absolute;inset:0;background:rgba(255,255,255,var(--surface-opacity,.6))}#ink{position:absolute;left:40px;top:40px;width:40px;height:40px;background:#171717}</style><div id='paper'></div><div id='ink'></div>").unwrap();
 let loaded=Arc::new(AtomicUsize::new(0));let mut context=tauri::generate_context!();context.config_mut().app.windows.clear();context.config_mut().identifier="local.cuvilo.surface-fixture".into();
 let app=tauri::Builder::default().any_thread().build(context).unwrap();
 for(label,path,x,y,width,height)in [("main",background,80.,80.,700.,490.),("answer",paper,100.,100.,360.,400.)]{let count=loaded.clone();tauri::WebviewWindowBuilder::new(&app,label,tauri::WebviewUrl::External(url::Url::from_file_path(path).unwrap())).title("Cuvilo synthetic surface fixture").position(x,y).inner_size(width,height).decorations(label=="main").transparent(label=="answer").min_inner_size(360.,400.).background_color(if label=="answer"{tauri::window::Color(0,0,0,0)}else{tauri::window::Color(32,80,160,255)}).always_on_top(true).skip_taskbar(true).focused(false).visible(false).content_protected(false).data_directory(directory.path().join("webview")).on_page_load(move|_,p|{if p.event()==tauri::webview::PageLoadEvent::Finished{count.fetch_add(1,Ordering::SeqCst);}}).build().unwrap();}
 let memory=directory.path().join("answer-memory.json");
 std::fs::write(&memory,r#"{"remember":true,"bounds":{"x":100,"y":100,"width":360.0,"height":900.0,"scale":1.0}}"#).unwrap();
 app.manage(crate::window_memory::Memory::load(memory.clone()));
 let outcome=Arc::new(std::sync::Mutex::new(None));let result_outcome=outcome.clone();
 let handle=app.handle().clone();tauri::async_runtime::spawn(async move{
  let run=async{
   let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(20);while loaded.load(Ordering::SeqCst)<2{if tokio::time::Instant::now()>deadline{return Err("fixture pages not loaded".to_string());}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
   crate::window_lifecycle::on_ui(&handle,|app|{for label in ["main","answer"]{let w=app.get_webview_window(label).unwrap();if label=="answer"{crate::window_memory::restore(&app,&w)?;println!("RESTORE immediate={:?} scale={:?}",w.inner_size(),w.scale_factor());}crate::window_lifecycle::content_visible_on_ui(&w,true)?;w.show().map_err(|e|e.to_string())?;unsafe{SetWindowPos(HWND(w.hwnd().map_err(|e|e.to_string())?.0),Some(HWND_TOPMOST),0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE).map_err(|e|e.to_string())?;}}Ok(())}).await?;
   tokio::time::sleep(std::time::Duration::from_millis(350)).await;
   for opacity in [100,60,20,60]{
    crate::window_lifecycle::on_ui(&handle,move|app|{let w=app.get_webview_window("answer").unwrap();super::apply(&w,100)?;w.eval(format!("document.documentElement.style.setProperty('--surface-opacity','{}')",opacity as f64/100.)).map_err(|e|e.to_string())}).await?;
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;unsafe{let _=windows::Win32::Graphics::Dwm::DwmFlush();}
    let actual=color(300,300);let expected=[32u8,80,160].map(|c|((255*opacity+c as u32*(100-opacity)+50)/100)as u8);let ink=color(150,150);
    println!("SURFACE opacity={opacity} background={actual:?} expected={expected:?} ink={ink:?}");
    if actual.iter().zip(expected).any(|(a,b)|(*a as i32-b as i32).abs()>4)||ink.iter().any(|v|(*v as i32-23).abs()>2){return Err("background or foreground rendered incorrectly".into());}
   }
   for mode in ["show","pin","dark","light","system"]{
    crate::window_lifecycle::on_ui(&handle,move|app|{let w=app.get_webview_window("answer").unwrap();if mode=="show"{w.hide().map_err(|e|e.to_string())?;w.show().map_err(|e|e.to_string())?;}else if mode=="pin"{w.set_always_on_top(false).map_err(|e|e.to_string())?;w.set_always_on_top(true).map_err(|e|e.to_string())?;}else{let hwnd=HWND(w.hwnd().map_err(|e|e.to_string())?.0);unsafe{SetWindowDisplayAffinity(hwnd,WINDOW_DISPLAY_AFFINITY(17)).map_err(|e|e.to_string())?;}crate::window_theme::apply(&app,mode)?;let mut affinity=0;unsafe{GetWindowDisplayAffinity(hwnd,&mut affinity).map_err(|e|e.to_string())?;}if affinity!=17{return Err("theme changed capture exclusion".into());}unsafe{SetWindowDisplayAffinity(hwnd,WINDOW_DISPLAY_AFFINITY(0)).map_err(|e|e.to_string())?;}}
     println!("LIFECYCLE mode={mode} size={:?}",w.inner_size());super::apply(&w,60)
    }).await?;
    unsafe{let _=windows::Win32::Graphics::Dwm::DwmFlush();}
    if mode=="light"||mode=="dark"{let actual=color(440,85);let expected=if mode=="dark"{24}else{245};println!("CAPTION immediate={mode} color={actual:?}");if actual.iter().any(|v|(*v as i32-expected).abs()>6){return Err("caption did not update immediately".into());}}
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;
    if color(150,150).iter().any(|v|(*v as i32-23).abs()>2){return Err("lifecycle faded foreground".into());}
    if color(300,300).iter().zip([166,185,217]).any(|(a,b)|(*a as i32-b).abs()>4){return Err("lifecycle replaced transparent background".into());}
   }
   crate::window_lifecycle::on_ui(&handle,|app|{let w=app.get_webview_window("answer").unwrap();let scale=w.scale_factor().map_err(|e|e.to_string())?;let size=w.inner_size().map_err(|e|e.to_string())?;if (size.width as f64/scale-360.).abs()>1.||(size.height as f64/scale-400.).abs()>1.{return Err(format!("legacy long window did not compact: width={} height={} scale={scale}",size.width,size.height));}w.set_size(tauri::LogicalSize::new(412.,444.)).map_err(|e|e.to_string())?;Ok(())}).await?;
   tokio::time::sleep(std::time::Duration::from_millis(80)).await;
   crate::window_lifecycle::on_ui(&handle,|app|{crate::window_memory::capture(&app);crate::window_memory::flush(&app);crate::window_memory::restore(&app,&app.get_webview_window("answer").unwrap())}).await?;
   Ok::<_,String>(())
  }.await;
  println!("SURFACE_RESULT {run:?}");*result_outcome.lock().unwrap()=Some(run);
  let _=crate::window_lifecycle::on_ui(&handle,|app|{for w in app.webview_windows().values(){let _=w.hide();let _=w.destroy();}Ok(())}).await;
  tokio::time::sleep(std::time::Duration::from_millis(150)).await;handle.exit(0);
 });
 app.run_return(|_,event|{if let tauri::RunEvent::ExitRequested{code:None,api,..}=event{api.prevent_exit();}});
 let result=outcome.lock().unwrap().take().unwrap();result.unwrap();
 let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(&memory).unwrap()).unwrap();assert_eq!(saved["compactVersion"],1);assert_eq!(saved["bounds"]["width"],412.);assert_eq!(saved["bounds"]["height"],444.);
}
