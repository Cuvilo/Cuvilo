//! Render only synthetic fixture pixels; never capture application/user contents.
use std::sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}};
use tauri::Manager;
struct FixtureAssets(Vec<u8>);
impl<R:tauri::Runtime>tauri::Assets<R> for FixtureAssets{
 fn get(&self,_:&tauri::utils::assets::AssetKey)->Option<std::borrow::Cow<'_,[u8]>>{Some(std::borrow::Cow::Borrowed(&self.0))}
 fn iter(&self)->Box<tauri::utils::assets::AssetsIter<'_>>{Box::new(std::iter::empty())}
 fn csp_hashes(&self,_:&tauri::utils::assets::AssetKey)->Box<dyn Iterator<Item=tauri::utils::assets::CspHash<'_>>+'_>{Box::new(std::iter::empty())}
}
#[derive(Default)]struct Reports(Mutex<Vec<String>>);
#[derive(Default)]struct FramePeriod(Mutex<f64>);
#[tauri::command]
fn fixture_frame(app:tauri::AppHandle,milliseconds:f64){*app.state::<FramePeriod>().0.lock().unwrap()=milliseconds;}
#[tauri::command]
async fn fixture_theme(app:tauri::AppHandle,theme:String,dark:bool)->Result<f64,String>{
 let(start,job)=crate::window_theme::schedule(&app,theme,dark).await?;
 tauri::async_runtime::spawn(async move{let result=job.await.map_err(|e|e.to_string()).and_then(|r|r).map(|_|"ok".to_string()).unwrap_or_else(|e|e);app.state::<Reports>().0.lock().unwrap().push(result);});Ok(start)
}
#[tauri::command]
fn fixture_theme_error(app:tauri::AppHandle,error:String){app.state::<Reports>().0.lock().unwrap().push(error);}
fn fixture_pixels()->(u8,u8){use windows::Win32::Graphics::Gdi::*;unsafe{
 // Copy one synthetic-window column atomically. Two separate screen GetPixel
 // calls can straddle compositor frames and fabricate a caption/document lag.
 let screen=GetDC(None);let memory=CreateCompatibleDC(Some(screen));let bitmap=CreateCompatibleBitmap(screen,1,216);let previous=SelectObject(memory,bitmap.into());
 let copied=BitBlt(memory,0,0,1,216,Some(screen),500,85,SRCCOPY);let pair=((GetPixel(memory,0,0).0&255)as u8,(GetPixel(memory,0,215).0&255)as u8);let _=SelectObject(memory,previous);let _=DeleteObject(bitmap.into());let _=DeleteDC(memory);ReleaseDC(None,screen);copied.unwrap();pair
}}
fn transition_time(progress:f64)->f64{
 let(mut low,mut high)=(0.,1.);for _ in 0..20{let t=(low+high)/2.;let y=3.*t*t-2.*t*t*t;if y<progress{low=t;}else{high=t;}}let t=(low+high)/2.;(0.6*(1.-t)*(1.-t)*t+t*t*t)*180.
}
fn compositor_frame_ms()->f64{use windows::Win32::Graphics::Dwm::*;let mut info=DWM_TIMING_INFO::default();info.cbSize=std::mem::size_of::<DWM_TIMING_INFO>()as u32;if unsafe{DwmGetCompositionTimingInfo(windows::Win32::Foundation::HWND::default(),&mut info)}.is_ok()&&info.rateRefresh.uiNumerator>0{1000.*info.rateRefresh.uiDenominator as f64/info.rateRefresh.uiNumerator as f64}else{1000./60.}}
#[test]#[ignore="isolated real WebView/native compositor fixture; run alone with manifest"]
fn caption_and_document_share_the_actual_transition_clock(){
 let directory=tempfile::tempdir().unwrap();let html=directory.path().join("theme.html");
 std::fs::write(&html,r#"<style>html,body{margin:0;height:100%;background:#fff}html.dark,html.dark body{background:#141414}::view-transition-group(root),::view-transition-old(root),::view-transition-new(root){animation-duration:180ms;animation-timing-function:cubic-bezier(.2,0,0,1)}html[data-theme-transition="preparing"]::view-transition-group(root),html[data-theme-transition="preparing"]::view-transition-old(root),html[data-theme-transition="preparing"]::view-transition-new(root){animation-play-state:paused;animation-fill-mode:both}</style><script>
 (async()=>{const frames=[];let previous=await new Promise(requestAnimationFrame);for(let i=0;i<16;i++){const now=await new Promise(requestAnimationFrame);frames.push(now-previous);previous=now;}frames.sort((a,b)=>a-b);await window.__TAURI_INTERNALS__.invoke('fixture_frame',{milliseconds:frames[8]});})();
 window.resumeTheme=start=>{document.documentElement.dataset.themeTransition='true';for(const a of document.getAnimations()){if(a.effect?.pseudoElement?.startsWith('::view-transition-')){a.play();a.startTime=start-performance.timeOrigin;}}};
 window.startTheme=(theme,dark)=>{document.documentElement.dataset.themeTransition='preparing';const tr=document.startViewTransition(()=>document.documentElement.classList.toggle('dark',dark));tr.ready.then(async()=>{const start=await window.__TAURI_INTERNALS__.invoke('fixture_theme',{theme,dark});window.resumeTheme(start);}).catch(e=>window.__TAURI_INTERNALS__.invoke('fixture_theme_error',{error:String(e)}));};
 </script>"#).unwrap();
 let ready=Arc::new(AtomicBool::new(false));let page_ready=ready.clone();let mut context=tauri::generate_context!();context.config_mut().app.windows.clear();context.config_mut().identifier="local.cuvilo.theme-clock-fixture".into();context.config_mut().build.dev_url=None;context.config_mut().app.security.csp=None;context.set_assets(Box::new(FixtureAssets(std::fs::read(&html).unwrap())));
 let app=tauri::Builder::default().any_thread().invoke_handler(tauri::generate_handler![fixture_theme,fixture_theme_error,fixture_frame]).manage(Reports::default()).manage(FramePeriod::default()).manage(crate::capture_protection::Protection::new(false)).build(context).unwrap();
 tauri::WebviewWindowBuilder::new(&app,"main",tauri::WebviewUrl::App("index.html".into())).title("Cuvilo synthetic theme clock").position(80.,80.).inner_size(700.,490.).visible(false).focused(false).always_on_top(true).skip_taskbar(true).data_directory(directory.path().join("webview")).on_page_load(move|_,p|{if p.event()==tauri::webview::PageLoadEvent::Finished{page_ready.store(true,Ordering::SeqCst);}}).build().unwrap();
 let outcome=Arc::new(Mutex::new(None));let saved=outcome.clone();let handle=app.handle().clone();tauri::async_runtime::spawn(async move{
  let run=async{
   for attempt in 0..200{if ready.load(Ordering::SeqCst){break;}if attempt==199{return Err("theme fixture load timed out".to_string());}tokio::time::sleep(std::time::Duration::from_millis(50)).await;}
   crate::window_lifecycle::on_ui(&handle,|app|{let w=app.get_webview_window("main").unwrap();crate::window_theme::apply_window(&w,"light")?;w.show().map_err(|e|e.to_string())?;Ok(())}).await?;
   tokio::time::sleep(std::time::Duration::from_millis(250)).await;
   for _ in 0..100{if *handle.state::<FramePeriod>().0.lock().unwrap()>0.{break;}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
   let renderer_ms=*handle.state::<FramePeriod>().0.lock().unwrap();if renderer_ms<=0.{return Err("renderer frame cadence unavailable".into());}
   let frame_ms=compositor_frame_ms().max(renderer_ms);println!("THEME_FRAME renderer_ms={renderer_ms:.2} display_ms={:.2}",compositor_frame_ms());
   let system_dark=crate::window_theme::system_dark();let opposite=if system_dark{"light"}else{"dark"};let mut previous_dark=false;
   for (index,(theme,target_dark)) in [("dark",true),("light",false),("system",system_dark),(opposite,!system_dark),("system",system_dark)].into_iter().enumerate(){
    let changed=previous_dark!=target_dark;previous_dark=target_dark;
    crate::window_lifecycle::on_ui(&handle,move|app|app.get_webview_window("main").unwrap().eval(format!("startTheme('{theme}',{target_dark})")).map_err(|e|e.to_string())).await?;
    let mut samples=Vec::new();for _ in 0..180{samples.push(fixture_pixels());tokio::time::sleep(std::time::Duration::from_millis(12)).await;if handle.state::<Reports>().0.lock().unwrap().len()>index&&samples.len()>3{tokio::time::sleep(std::time::Duration::from_millis(40)).await;samples.push(fixture_pixels());break;}}
    println!("THEME_REPORTS {:?}",handle.state::<Reports>().0.lock().unwrap());
    let mut intermediate=0;let mut worst=0f64;let mut clock_gap=0f64;
    for &(caption,page)in &samples{let cp=(245.-caption as f64)/221.;let pp=(255.-page as f64)/235.;let(cp,pp)=if target_dark{(cp,pp)}else{(1.-cp,1.-pp)};if pp>0.03&&pp<0.97{intermediate+=1;worst=worst.max((cp-pp).abs());if cp>0.03&&cp<0.97{clock_gap=clock_gap.max((transition_time(cp)-transition_time(pp)).abs());}}}
    println!("THEME_CLOCK {theme} intermediate={intermediate} max_progress_gap={worst:.3} max_clock_gap_ms={clock_gap:.2} compositor_frame_ms={frame_ms:.2} samples={:?}",samples.iter().copied().filter(|(c,p)|(*c>24&&*c<245)||(*p>20&&*p<255)).collect::<Vec<_>>());
    // Compare time, not nonlinear opacity deltas: at the steep beginning a
    // single display frame can span over 25% of this easing curve. Native and
    // WebView compositor queues must stay within two measured frames (+2ms).
    // A 180Hz monitor can host a 60Hz WebView: use its actual rAF cadence too.
    if (changed&&intermediate<2)||clock_gap>2.*frame_ms+2.{return Err("caption and document transition are out of sync".into());}
    let reports=handle.state::<Reports>();let report=reports.0.lock().unwrap();if report.get(index).map(String::as_str)!=Some("ok"){return Err(format!("native preview did not complete: {report:?}"));}
    let last=*samples.last().unwrap();let expected=if target_dark{(24u8,20u8)}else{(245u8,255u8)};if (last.0 as i32-expected.0 as i32).abs()>6||(last.1 as i32-expected.1 as i32).abs()>6{return Err("final palette did not settle".into());}
   }Ok::<_,String>(())
  }.await;println!("THEME_CLOCK_RESULT {run:?}");*saved.lock().unwrap()=Some(run);let _=crate::window_lifecycle::on_ui(&handle,|app|{if let Some(w)=app.get_webview_window("main"){let _=w.hide();let _=w.destroy();}Ok(())}).await;tokio::time::sleep(std::time::Duration::from_millis(120)).await;handle.exit(0);
 });app.run_return(|_,event|{if let tauri::RunEvent::ExitRequested{code:None,api,..}=event{api.prevent_exit();}});outcome.lock().unwrap().take().unwrap().unwrap();
}
