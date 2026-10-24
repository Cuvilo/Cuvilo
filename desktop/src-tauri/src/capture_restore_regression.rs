//! Real picker + production restore path, isolated from user profiles/audio/credentials.
use super::*;
use crate::{core::Runtime,types::*,window_lifecycle,window_memory};
use tokio_util::sync::CancellationToken;
use std::sync::{Mutex,atomic::AtomicUsize};
use tauri::Manager;
#[tauri::command] fn audio_sources()->serde_json::Value{serde_json::json!([])}
type Heartbeats=Arc<Mutex<Vec<(String,usize,bool)>>>;
#[tauri::command] fn fixture_heartbeat(window:tauri::WebviewWindow,state:tauri::State<Heartbeats>,cycle:usize,healthy:bool){state.lock().unwrap().push((window.label().into(),cycle,healthy));}
async fn heartbeat(app:&tauri::AppHandle,label:&str,cycle:usize)->Result<(),String>{
 let window=app.get_webview_window(label).ok_or("fixture missing")?;
 window.eval(format!("(function ready(){{if(document.querySelector('#root button')){{window.__TAURI_INTERNALS__.invoke('fixture_heartbeat',{{cycle:{cycle},healthy:!!document.querySelector('#root button')}})}}else setTimeout(ready,20)}})()" )).map_err(|e|e.to_string())?;
 let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(5);
 loop{if let Some((_,_,healthy))=app.state::<Heartbeats>().lock().unwrap().iter().find(|(name,n,_)|name==label&&*n==cycle){return if *healthy{Ok(())}else{Err("blank frontend".into())};}if tokio::time::Instant::now()>deadline{return Err(format!("{label} DOM heartbeat timeout"));}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
}
#[test]
#[ignore="isolated WebView2 integration; run by itself after embedding common-controls manifest"]
fn selected_region_restores_existing_answer_and_keeps_process_alive(){
 let profile=tempfile::tempdir().unwrap();let db_path=profile.path().join("fixture.sqlite3");
 let mut settings=Settings::default();settings.providers.clear();settings.active_model.clear();settings.asr_provider.clear();settings.capture_protection=false;settings.screen_capture.confirm_before_answer=true;
 {let db=crate::storage::Database::open(&db_path).unwrap();db.save_settings(&settings).unwrap();}
 let core=Core::open(&db_path).unwrap();let session=Session{id:"capture-fixture".into(),title:"synthetic fixture".into(),created_at:1,ended_at:None};core.db.lock().unwrap().session(&session).unwrap();*core.runtime.lock().unwrap()=Some(Runtime{session,cancel:CancellationToken::new()});
 let result=Arc::new(Mutex::new(None));let output=result.clone();let exits=Arc::new(AtomicUsize::new(0));let exit_count=exits.clone();let worker_exits=exits.clone();
 let mut context=tauri::generate_context!();context.config_mut().app.windows.clear();context.config_mut().identifier="local.cuvilo.capture-fixture".into();context.config_mut().build.dev_url=Some("http://127.0.0.1:18080/".parse().unwrap());
 std::fs::write(profile.path().join("answer-window.json"),r#"{"remember":true,"bounds":{"x":100,"y":100,"width":360.0,"height":900.0,"scale":1.0}}"#).unwrap();
 let app=tauri::Builder::default().any_thread().manage(Arc::new(Mutex::new(Vec::<(String,usize,bool)>::new()))).manage(core.clone()).manage(capture_protection::Protection::new(false)).manage(crate::interview_windows::fixture_mode()).manage(window_lifecycle::AnswerLifecycle::default()).manage(window_memory::Memory::load(profile.path().join("answer-window.json"))).invoke_handler(tauri::generate_handler![crate::snapshot,crate::subscribe,crate::report_ready,audio_sources,fixture_heartbeat]).build(context).unwrap();
 for (label,x) in [("main",-30000.)]{tauri::WebviewWindowBuilder::new(&app,label,tauri::WebviewUrl::App(if label=="answer"{"index.html?window=answer"}else{"index.html"}.into())).title("Cuvilo isolated capture fixture").position(x,-30000.).inner_size(460.,430.).visible(false).skip_taskbar(true).data_directory(profile.path().join("webview")).on_page_load(|window,payload|{if payload.event()==tauri::webview::PageLoadEvent::Finished{window_lifecycle::answer_ready(&window);}}).build().unwrap();}
 let handle=app.handle().clone();tauri::async_runtime::spawn(async move{
  let run=async{
   // Exercise the production creation path, including the legacy size reset.
   capture_protection::present_locked(&handle,"answer").await?;
   window_lifecycle::on_ui(&handle,|app|{let w=app.get_webview_window("answer").ok_or("answer not created")?;let size=w.inner_size().map_err(|e|e.to_string())?;let scale=w.scale_factor().map_err(|e|e.to_string())?;
    if (size.width as f64/scale-360.).abs()>1.||(size.height as f64/scale-400.).abs()>1.{return Err(format!("actual creation size mismatch: {size:?}"));}
    w.set_position(tauri::PhysicalPosition::new(-28000,-30000)).map_err(|e|e.to_string())?;println!("ACTUAL_ANSWER_CREATION logical=360x400 ready=true");Ok(())
   }).await?;
   window_lifecycle::on_ui(&handle,|app|capture_protection::show_checked(&app,"answer")).await?;
   heartbeat(&handle,"main",0).await?;heartbeat(&handle,"answer",0).await?;
   for cycle in 0..12{
    let protected=cycle%2==1;core.settings.lock().unwrap().capture_protection=protected;core.settings.lock().unwrap().answer_opacity=[60,80,100][cycle%3];core.settings.lock().unwrap().screen_capture.confirm_before_answer=cycle%3!=0;
    window_lifecycle::on_ui(&handle,move|app|capture_protection::apply(&app,protected)).await?;
    native::FIXTURE_SELECTION.store(1,Ordering::SeqCst);start(handle.clone()).map_err(|e|e.to_string())?;
    let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(25);
    loop{let stage=core.screen.lock().unwrap().stage.clone();if matches!(stage.as_str(),"ready"|"error"){break;}if tokio::time::Instant::now()>deadline{return Err(format!("cycle {cycle} stuck in {stage}"));}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
    window_lifecycle::on_ui(&handle,move|app|{let answer=app.get_webview_window("answer").ok_or("answer missing")?;if !answer.is_visible().map_err(|e|e.to_string())?{return Err(format!("cycle {cycle}: answer invisible"));}let opacity=app.state::<Arc<Core>>().settings.lock().unwrap().answer_opacity;
      if opacity<100{unsafe{use windows::Win32::UI::WindowsAndMessaging::*;let mut alpha=0;GetLayeredWindowAttributes(windows::Win32::Foundation::HWND(answer.hwnd().map_err(|e|e.to_string())?.0),None,Some(&mut alpha),None).map_err(|e|e.to_string())?;if alpha!=crate::answer_appearance::alpha(opacity)?{return Err("capture restore reset alpha".into());}}}
      if app.get_webview_window("main").unwrap().is_visible().map_err(|e|e.to_string())?{return Err("main revived".into());}Ok(())}).await?;
    heartbeat(&handle,"answer",cycle+1).await?;heartbeat(&handle,"main",cycle+1).await?;
    clear(&core);println!("CAPTURE_RESTORE cycle={} protected={} ready=true main_hidden=true",cycle+1,protected);
   }
   // A failed opacity application simulates a presentation failure, not an OCR failure.
   core.settings.lock().unwrap().answer_opacity=19;
   native::FIXTURE_SELECTION.store(1,Ordering::SeqCst);start(handle.clone()).map_err(|e|e.to_string())?;
   let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(10);
   while core.screen.lock().unwrap().stage!="error"{if tokio::time::Instant::now()>deadline{return Err("recovery timed out".into());}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
   window_lifecycle::on_ui(&handle,|app|{if !app.get_webview_window("main").unwrap().is_visible().map_err(|e|e.to_string())?{return Err("recovery left all windows hidden".into());}Ok(())}).await?;
   heartbeat(&handle,"main",20).await?;println!("CAPTURE_RECOVERY main_visible=true heartbeat=true");
   core.settings.lock().unwrap().answer_opacity=100;
   if worker_exits.load(Ordering::SeqCst)!=0{return Err("implicit exit from picker".into());}
   Ok::<_,String>(())
  };
  let status=tokio::time::timeout(std::time::Duration::from_secs(100),run).await.map_err(|_|"probe timeout".to_string()).and_then(|v|v);
  println!("CAPTURE_RESTORE_RESULT {:?}",status);let code=if status.is_ok(){0}else{1};*output.lock().unwrap()=Some(status);handle.exit(code);
 });
 app.run(move|_,event|{if let tauri::RunEvent::ExitRequested{code:None,api,..}=event{exit_count.fetch_add(1,Ordering::SeqCst);api.prevent_exit();}});
 assert_eq!(exits.load(Ordering::SeqCst),0,"picker caused implicit app exit");let value=result.lock().unwrap().take().unwrap();assert!(value.is_ok(),"{value:?}");
}
