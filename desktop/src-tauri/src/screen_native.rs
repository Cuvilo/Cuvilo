//! Win32 region picker and system OCR. No files, clipboard writes, or cloud calls.
use anyhow::{ensure,Context,Result};
use std::{mem::size_of,sync::{Arc,atomic::{AtomicBool,Ordering}}};
use windows::{core::w,Win32::{Foundation::*,Graphics::Gdi::*,UI::{WindowsAndMessaging::*,Input::KeyboardAndMouse::*},System::WinRT::*}};
use windows::{Graphics::Imaging::{SoftwareBitmap,BitmapPixelFormat},Media::Ocr::OcrEngine,Security::Cryptography::CryptographicBuffer};
#[path="screen_preprocess.rs"] mod preprocess;
pub struct Crop{pub width:i32,pub height:i32,pub pixels:Vec<u8>}
struct Apartment;
impl Apartment{fn enter()->Result<Self>{unsafe{RoInitialize(RO_INIT_MULTITHREADED)?;}Ok(Self)}}
impl Drop for Apartment{fn drop(&mut self){unsafe{RoUninitialize();}}}
// Windows activation factories are cached by windows-rs. Keep their COM apartment alive
// on one lazy OCR thread; tearing it down between language checks and recognition can
// leave the cached factory unusable. The thread sleeps between bounded, cancellable jobs.
enum OcrJob{Languages(std::sync::mpsc::Sender<Result<Vec<String>>>),Recognize(Crop,Arc<AtomicBool>,std::sync::mpsc::Sender<Result<(String,Vec<u8>)>>)}
fn worker()->Result<&'static std::sync::mpsc::Sender<OcrJob>>{
 static WORKER:std::sync::OnceLock<std::result::Result<std::sync::mpsc::Sender<OcrJob>,String>>=std::sync::OnceLock::new();
 match WORKER.get_or_init(||{let(tx,rx)=std::sync::mpsc::channel::<OcrJob>();std::thread::Builder::new().name("cuvilo-ocr".into()).spawn(move||{
  let apartment=Apartment::enter();while let Ok(job)=rx.recv(){match job{
   OcrJob::Languages(reply)=>{let value=if let Err(e)=&apartment{Err(anyhow::anyhow!("OCR初始化失败：{e}"))}else{languages_inner()};let _=reply.send(value);},
   OcrJob::Recognize(crop,cancel,reply)=>{let value=if let Err(e)=&apartment{Err(anyhow::anyhow!("OCR初始化失败：{e}"))}else{recognize_inner(crop,cancel)};let _=reply.send(value);}
  }}
 }).map(|_|tx).map_err(|e|format!("无法启动本地识别线程：{e}"))}){Ok(sender)=>Ok(sender),Err(message)=>Err(anyhow::anyhow!(message.clone()))}
}
pub fn languages()->Result<Vec<String>>{let(tx,rx)=std::sync::mpsc::channel();worker()?.send(OcrJob::Languages(tx)).context("OCR工作线程不可用")?;rx.recv().context("OCR工作线程已退出")?}
pub fn recognize(crop:Crop,cancel:Arc<AtomicBool>)->Result<(String,Vec<u8>)>{let(tx,rx)=std::sync::mpsc::channel();worker()?.send(OcrJob::Recognize(crop,cancel,tx)).context("OCR工作线程不可用")?;rx.recv().context("OCR工作线程已退出")?}
fn engine()->Result<OcrEngine>{
 if let Ok(engine)=OcrEngine::TryCreateFromUserProfileLanguages(){return Ok(engine)}
 let langs=OcrEngine::AvailableRecognizerLanguages()?;
 ensure!(langs.Size()?>0,"请在 Windows 语言选项中安装 OCR 语言组件");
 Ok(OcrEngine::TryCreateFromLanguage(&langs.GetAt(0)?)?)
}
fn languages_inner()->Result<Vec<String>>{let langs=OcrEngine::AvailableRecognizerLanguages()?;(0..langs.Size()?).map(|i|Ok(langs.GetAt(i)?.LanguageTag()?.to_string())).collect()}
pub fn bmp(crop:&Crop)->Vec<u8>{
 let mut bytes=Vec::with_capacity(54+crop.pixels.len());bytes.extend(b"BM");bytes.extend(((54+crop.pixels.len())as u32).to_le_bytes());bytes.extend([0;4]);bytes.extend(54u32.to_le_bytes());bytes.extend(40u32.to_le_bytes());bytes.extend(crop.width.to_le_bytes());bytes.extend((-crop.height).to_le_bytes());bytes.extend(1u16.to_le_bytes());bytes.extend(32u16.to_le_bytes());bytes.extend([0;24]);bytes.extend(&crop.pixels);bytes
}
fn recognize_inner(crop:Crop,cancel:Arc<AtomicBool>)->Result<(String,Vec<u8>)>{
 let engine=engine()?;
 ensure!(crop.width>0&&crop.height>0,"选区无效");
 let max=OcrEngine::MaxImageDimension()? as i32;
 ensure!(crop.width<=max&&crop.height<=max,"选区超过系统识别上限，请缩小选区");
 if cancel.load(Ordering::Acquire){return Ok((String::new(),vec![]))}
 let prepared=preprocess::prepare(crop.width,crop.height,&crop.pixels,max,&cancel)?;
 let buffer=CryptographicBuffer::CreateFromByteArray(&prepared.pixels)?;
 let bitmap=SoftwareBitmap::CreateCopyFromBuffer(&buffer,BitmapPixelFormat::Gray8,prepared.width,prepared.height)?;
 drop(prepared);
 drop(buffer);
 struct BitmapClose<'a>(&'a SoftwareBitmap);impl Drop for BitmapClose<'_>{fn drop(&mut self){let _=self.0.Close();}}
 let _close=BitmapClose(&bitmap);let operation=engine.RecognizeAsync(&bitmap)?;let started=std::time::Instant::now();
 let result=loop {
  if cancel.load(Ordering::Acquire){let _=operation.Cancel();break Err(anyhow::anyhow!("识别已取消"));}
  if started.elapsed().as_secs()>=20{let _=operation.Cancel();break Err(anyhow::anyhow!("本地识别超时，请缩小选区后重试"));}
  if operation.Status()?.0!=0{break operation.GetResults().map_err(anyhow::Error::from);}
  std::thread::sleep(std::time::Duration::from_millis(20));
 };
 let result=result.context("系统 OCR 识别失败")?;
 if cancel.load(Ordering::Acquire){return Ok((String::new(),vec![]))}
 // Keep actual line breaks and Unicode symbols. Never silently rewrite code or punctuation.
 let lines=result.Lines()?;let mut rows=Vec::new();
 for i in 0..lines.Size()? {let words=lines.GetAt(i)?.Words()?;let mut row=Vec::new();for j in 0..words.Size()?{let word=words.GetAt(j)?;let bounds=word.BoundingRect()?;row.push((word.Text()?.to_string(),bounds.X,bounds.Width));}if !row.is_empty(){rows.push(row);}}
 let left=rows.iter().filter_map(|row|row.first().map(|word|word.1)).fold(f32::INFINITY,f32::min);
 let text=rows.into_iter().map(|row|compose_line(&row,left)).collect::<Vec<_>>().join("\n");
 Ok((text,bmp(&crop)))
}
fn cjk(ch:char)->bool{matches!(ch as u32,0x3400..=0x9FFF|0xF900..=0xFAFF|0x3000..=0x303F|0xFF00..=0xFFEF)}
fn compose_line(words:&[(String,f32,f32)],left:f32)->String{
 let mut character_widths=words.iter().filter(|(text,_,_)|text.is_ascii()&&!text.is_empty()).map(|(text,_,width)|width/text.chars().count().max(1)as f32).filter(|width|*width>=3.).collect::<Vec<_>>();character_widths.sort_by(f32::total_cmp);
 let char_width=character_widths.get(character_widths.len()/2).copied().unwrap_or(f32::INFINITY);
 let width=if char_width.is_finite(){char_width.max(3.)}else{words.first().map(|w|w.2/w.0.chars().count().max(1)as f32).unwrap_or(16.).max(3.)};
 let indent=words.first().map(|w|((w.1-left)/width).round().clamp(0.,80.)as usize).unwrap_or(0);let mut out=" ".repeat(indent);
 for(i,(text,x,_))in words.iter().enumerate(){if i>0{let previous=&words[i-1];let gap=x-(previous.1+previous.2);let adjacent_cjk=previous.0.chars().last().is_some_and(cjk)&&text.chars().next().is_some_and(cjk);if gap>width*0.55&&!adjacent_cjk{out.push(' ');}}out.push_str(text);}out
}
struct Surface{dc:HDC,bitmap:HBITMAP,previous:HGDIOBJ,bits:*mut u8,width:i32,height:i32}
impl Drop for Surface{fn drop(&mut self){unsafe{let _=SelectObject(self.dc,self.previous);let _=DeleteObject(self.bitmap.into());let _=DeleteDC(self.dc);}}}
impl Surface{
 unsafe fn capture(bounds:RECT)->Result<Self>{
  let width=bounds.right-bounds.left;let height=bounds.bottom-bounds.top;
  ensure!(width>0&&height>0&&(width as i64)*(height as i64)<=20_000_000,"屏幕分辨率过大，请使用较小的显示区域");
  let screen=GetDC(None);ensure!(!screen.is_invalid(),"无法访问屏幕");
  let dc=CreateCompatibleDC(Some(screen));
  if dc.is_invalid(){ReleaseDC(None,screen);anyhow::bail!("无法创建截图缓冲区")}
  let mut info=BITMAPINFO::default();info.bmiHeader=BITMAPINFOHEADER{biSize:size_of::<BITMAPINFOHEADER>()as u32,biWidth:width,biHeight:-height,biPlanes:1,biBitCount:32,biCompression:BI_RGB.0,..Default::default()};
  let mut bits=std::ptr::null_mut();
  let bitmap=match CreateDIBSection(Some(screen),&info,DIB_RGB_COLORS,&mut bits,None,0){Ok(value)=>value,Err(error)=>{let _=DeleteDC(dc);ReleaseDC(None,screen);return Err(error.into())}};
  let previous=SelectObject(dc,bitmap.into());
  let result=BitBlt(dc,0,0,width,height,Some(screen),bounds.left,bounds.top,SRCCOPY|CAPTUREBLT);
  ReleaseDC(None,screen);
  let surface=Self{dc,bitmap,previous,bits:bits.cast(),width,height};result?;Ok(surface)
 }
 unsafe fn crop(&self,rect:RECT)->Result<Crop>{
  let rect=normalize(POINT{x:rect.left,y:rect.top},POINT{x:rect.right,y:rect.bottom},self.width,self.height).context("选区太小，请重新框选")?;
  GdiFlush().ok().context("截图绘制未完成，请重新框选")?;
  let width=rect.right-rect.left;let height=rect.bottom-rect.top;
  ensure!(width as i64*height as i64<=12_000_000,"选区过大，请缩小到当前题目");
  let mut pixels=Vec::with_capacity(width as usize*height as usize*4);
  for y in rect.top..rect.bottom{let row=self.bits.add((y as usize*self.width as usize+rect.left as usize)*4);pixels.extend_from_slice(std::slice::from_raw_parts(row,width as usize*4));}
  for pixel in pixels.chunks_exact_mut(4){pixel[3]=255;}
  Ok(Crop{width,height,pixels})
 }
}
pub fn normalize(a:POINT,b:POINT,width:i32,height:i32)->Option<RECT>{
 let r=RECT{left:a.x.min(b.x).clamp(0,width),top:a.y.min(b.y).clamp(0,height),right:a.x.max(b.x).clamp(0,width),bottom:a.y.max(b.y).clamp(0,height)};
 (r.right-r.left>=8&&r.bottom-r.top>=8).then_some(r)
}
struct Picker{surface:Surface,start:Option<POINT>,end:POINT,result:Option<RECT>,cancel:Arc<AtomicBool>,started:std::time::Instant}
unsafe extern "system" fn picker_proc(hwnd:HWND,message:u32,w:WPARAM,l:LPARAM)->LRESULT {
 if message==WM_NCCREATE {let create=&*(l.0 as *const CREATESTRUCTW);SetWindowLongPtrW(hwnd,GWLP_USERDATA,create.lpCreateParams as isize);}
 let ptr=GetWindowLongPtrW(hwnd,GWLP_USERDATA)as *mut Picker;
 if ptr.is_null(){return DefWindowProcW(hwnd,message,w,l)}
 let state=&mut *ptr;
 let point=POINT{x:(l.0 as u16 as i16)as i32,y:((l.0>>16)as u16 as i16)as i32};
 match message{
  WM_LBUTTONDOWN=>{state.start=Some(point);state.end=point;SetCapture(hwnd);let _=InvalidateRect(Some(hwnd),None,false);LRESULT(0)},
  WM_MOUSEMOVE if state.start.is_some()=>{state.end=point;let _=InvalidateRect(Some(hwnd),None,false);LRESULT(0)},
  WM_LBUTTONUP=>{let _=ReleaseCapture();if let Some(start)=state.start {if let Some(rect)=normalize(start,point,state.surface.width,state.surface.height){state.result=Some(rect);let _=DestroyWindow(hwnd);}else{state.start=None;let _=InvalidateRect(Some(hwnd),None,false);}}LRESULT(0)},
  WM_RBUTTONDOWN|WM_CLOSE=>{let _=DestroyWindow(hwnd);LRESULT(0)},
  WM_KEYDOWN if w.0==VK_ESCAPE.0 as usize=>{let _=DestroyWindow(hwnd);LRESULT(0)},
  WM_TIMER=>{if state.cancel.load(Ordering::Acquire)||state.started.elapsed().as_secs()>120||GetAsyncKeyState(VK_ESCAPE.0 as i32)<0 {let _=DestroyWindow(hwnd);}LRESULT(0)},
  WM_PAINT=>{
   let mut paint=PAINTSTRUCT::default();let dc=BeginPaint(hwnd,&mut paint);
   let _=BitBlt(dc,0,0,state.surface.width,state.surface.height,Some(state.surface.dc),0,0,SRCCOPY);
   let black=CreateSolidBrush(COLORREF(0x171717));let white=CreateSolidBrush(COLORREF(0xFFFFFF));
   let left=(state.surface.width-300).max(0)/2;let banner=RECT{left,top:20,right:(left+300).min(state.surface.width),bottom:58};
   FillRect(dc,&banner,black);SetTextColor(dc,COLORREF(0xFFFFFF));SetBkMode(dc,TRANSPARENT);
   let old=SelectObject(dc,GetStockObject(DEFAULT_GUI_FONT));
   let mut title="框选题目 · Esc 取消".encode_utf16().collect::<Vec<_>>();let mut label=banner;
   DrawTextW(dc,&mut title,&mut label,DT_CENTER|DT_VCENTER|DT_SINGLELINE);SelectObject(dc,old);
   if let Some(start)=state.start{if let Some(mut rect)=normalize(start,state.end,state.surface.width,state.surface.height){FrameRect(dc,&rect,black);rect.left+=1;rect.top+=1;rect.right-=1;rect.bottom-=1;FrameRect(dc,&rect,white);}}
   let _=DeleteObject(black.into());let _=DeleteObject(white.into());let _=EndPaint(hwnd,&paint);LRESULT(0)
  },
  WM_DESTROY=>{PostQuitMessage(0);LRESULT(0)},
  _=>DefWindowProcW(hwnd,message,w,l)
 }
}
#[cfg(test)] pub(super) static FIXTURE_SELECTION:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
pub fn select(cancel:Arc<AtomicBool>)->Result<Option<Crop>> {unsafe{
 #[cfg(test)] {let mode=FIXTURE_SELECTION.swap(0,Ordering::SeqCst);if mode!=0{return ocr_fixture_tests::select_fixture(cancel,mode==2);}}
 if cancel.load(Ordering::Acquire){return Ok(None)}
 let previous=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
 struct Dpi(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT);
 impl Drop for Dpi{fn drop(&mut self){unsafe{if !self.0.0.is_null(){let _=SetThreadDpiAwarenessContext(self.0);}}}}
 let _dpi=Dpi(previous);
 let mut point=POINT::default();GetCursorPos(&mut point)?;
 let monitor=MonitorFromPoint(point,MONITOR_DEFAULTTONEAREST);let mut info=MONITORINFO{cbSize:size_of::<MONITORINFO>()as u32,..Default::default()};ensure!(GetMonitorInfoW(monitor,&mut info).as_bool(),"无法读取屏幕边界");
 let bounds=info.rcMonitor;let _=windows::Win32::Graphics::Dwm::DwmFlush();let surface=Surface::capture(bounds)?;pick(surface,bounds,cancel,false)
}}
fn pick(surface:Surface,bounds:RECT,cancel:Arc<AtomicBool>,fixture:bool)->Result<Option<Crop>>{unsafe{
 let mut state=Box::new(Picker{surface,start:None,end:POINT::default(),result:None,cancel,started:std::time::Instant::now()});
 let class=w!("CuviloScreenPicker");let wc=WNDCLASSW{lpfnWndProc:Some(picker_proc),hCursor:LoadCursorW(None,IDC_CROSS)?,lpszClassName:class,..Default::default()};
 let atom=RegisterClassW(&wc);if atom==0{let error=GetLastError();ensure!(error==ERROR_CLASS_ALREADY_EXISTS,"无法注册框选窗口：{error:?}");}
 let hwnd=CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW,class,w!("Cuvilo 截图提问"),WS_POPUP,bounds.left,bounds.top,bounds.right-bounds.left,bounds.bottom-bounds.top,None,None,None,Some((&mut *state as *mut Picker).cast()))?;
 struct PickerWindow(HWND);impl Drop for PickerWindow{fn drop(&mut self){unsafe{if IsWindow(Some(self.0)).as_bool(){let _=DestroyWindow(self.0);}let mut msg=MSG::default();while PeekMessageW(&mut msg,None,WM_QUIT,WM_QUIT,PM_REMOVE).as_bool(){}}}}
 let _window=PickerWindow(hwnd);
 // Verify capture exclusion before showing any frozen desktop pixels. No fallback to unprotected display.
 let protected=(||->Result<()>{SetWindowDisplayAffinity(hwnd,WINDOW_DISPLAY_AFFINITY(0x11))?;let mut actual=0;GetWindowDisplayAffinity(hwnd,&mut actual)?;ensure!(actual==0x11,"框选窗口共享隐藏核验失败");Ok(())})();
 if let Err(error)=protected{let _=DestroyWindow(hwnd);let mut msg=MSG::default();while PeekMessageW(&mut msg,None,WM_QUIT,WM_QUIT,PM_REMOVE).as_bool(){}return Err(error)}
 if SetTimer(Some(hwnd),1,50,None)==0{let _=DestroyWindow(hwnd);anyhow::bail!("无法创建框选取消计时器")}
 let driver=if fixture{let raw=hwnd.0 as usize;Some(std::thread::spawn(move||{std::thread::sleep(std::time::Duration::from_millis(25));let target=HWND(raw as *mut _);SendMessageW(target,WM_LBUTTONDOWN,Some(WPARAM(1)),Some(LPARAM(20|(80<<16))));SendMessageW(target,WM_MOUSEMOVE,Some(WPARAM(1)),Some(LPARAM(220|(160<<16))));SendMessageW(target,WM_LBUTTONUP,Some(WPARAM(0)),Some(LPARAM(220|(160<<16))));}))}else{None};
 let _=ShowWindow(hwnd,if fixture{SW_SHOWNOACTIVATE}else{SW_SHOW});if !fixture{let _=SetForegroundWindow(hwnd);let _=SetFocus(Some(hwnd));}
 let mut msg=MSG::default();loop{let result=GetMessageW(&mut msg,None,0,0).0;if result<=0{if IsWindow(Some(hwnd)).as_bool(){let _=DestroyWindow(hwnd);}break;}let _=TranslateMessage(&msg);DispatchMessageW(&msg);}
 if let Some(driver)=driver{let _=driver.join();}
 let _=windows::Win32::Graphics::Dwm::DwmFlush();
 if state.cancel.load(Ordering::Acquire){return Ok(None)}
 state.result.map(|rect|state.surface.crop(rect)).transpose()
}}
use windows::Win32::UI::HiDpi::*;
#[cfg(test)]mod tests{use super::*;#[test]fn reversed_and_outside_selection_is_clipped(){let r=normalize(POINT{x:100,y:90},POINT{x:-20,y:10},80,80).unwrap();assert_eq!((r.left,r.top,r.right,r.bottom),(0,10,80,80));assert!(normalize(POINT{x:0,y:0},POINT{x:2,y:3},80,80).is_none());}#[test]fn bmp_header_is_bounded_top_down(){let crop=Crop{width:8,height:8,pixels:vec![255;256]};let bytes=bmp(&crop);assert_eq!(bytes.len(),310);assert_eq!(&bytes[..2],b"BM");assert_eq!(i32::from_le_bytes(bytes[22..26].try_into().unwrap()),-8);}}

#[cfg(test)]
mod ocr_fixture_tests {
 use super::*;
 pub(super) unsafe fn fixture()->Crop {
  let width=1500;let height=240;let dc=CreateCompatibleDC(None);assert!(!dc.is_invalid());
  let mut info=BITMAPINFO::default();info.bmiHeader=BITMAPINFOHEADER{biSize:size_of::<BITMAPINFOHEADER>()as u32,biWidth:width,biHeight:-height,biPlanes:1,biBitCount:32,biCompression:BI_RGB.0,..Default::default()};
  let mut bits=std::ptr::null_mut();let bitmap=CreateDIBSection(Some(dc),&info,DIB_RGB_COLORS,&mut bits,None,0).unwrap();let previous=SelectObject(dc,bitmap.into());
  let surface=Surface{dc,bitmap,previous,bits:bits.cast(),width,height};std::ptr::write_bytes(surface.bits,255,width as usize*height as usize*4);
  let mut font=LOGFONTW::default();font.lfHeight=-36;font.lfWeight=400;
  for(i,c)in "Microsoft YaHei".encode_utf16().enumerate(){font.lfFaceName[i]=c;}
  let handle=CreateFontIndirectW(&font);let old=SelectObject(dc,handle.into());SetTextColor(dc,COLORREF(0));SetBkMode(dc,TRANSPARENT);
  let mut text="Cuvilo OCR fixture 12345\n数组中查找目标值并返回索引".encode_utf16().collect::<Vec<_>>();let mut rect=RECT{left:24,top:24,right:1470,bottom:220};DrawTextW(dc,&mut text,&mut rect,DT_LEFT);
  SelectObject(dc,old);let _=DeleteObject(handle.into());surface.crop(RECT{left:0,top:0,right:width,bottom:height}).unwrap()
 }
 pub(super) unsafe fn select_fixture(cancel:Arc<AtomicBool>,cancelled:bool)->Result<Option<Crop>> {
  let crop=fixture();let dc=CreateCompatibleDC(None);let mut info=BITMAPINFO::default();info.bmiHeader=BITMAPINFOHEADER{biSize:size_of::<BITMAPINFOHEADER>()as u32,biWidth:crop.width,biHeight:-crop.height,biPlanes:1,biBitCount:32,biCompression:BI_RGB.0,..Default::default()};let mut bits=std::ptr::null_mut();let bitmap=CreateDIBSection(Some(dc),&info,DIB_RGB_COLORS,&mut bits,None,0)?;let previous=SelectObject(dc,bitmap.into());std::ptr::copy_nonoverlapping(crop.pixels.as_ptr(),bits.cast::<u8>(),crop.pixels.len());let surface=Surface{dc,bitmap,previous,bits:bits.cast(),width:crop.width,height:crop.height};
  if cancelled{cancel.store(true,Ordering::Release);}
  pick(surface,RECT{left:-30000,top:-30000,right:-28500,bottom:-29760},cancel,true)
 }
 fn memory()->usize {unsafe{use windows::Win32::System::{ProcessStatus::*,Threading::*};let mut counters=PROCESS_MEMORY_COUNTERS::default();GetProcessMemoryInfo(GetCurrentProcess(),&mut counters,size_of::<PROCESS_MEMORY_COUNTERS>()as u32).unwrap();counters.WorkingSetSize}}
 #[test] fn protected_native_picker_repeatedly_crops_and_cancels_without_focus(){unsafe{
  for i in 0..12 {let crop=fixture();let dc=CreateCompatibleDC(None);let mut info=BITMAPINFO::default();info.bmiHeader=BITMAPINFOHEADER{biSize:size_of::<BITMAPINFOHEADER>()as u32,biWidth:crop.width,biHeight:-crop.height,biPlanes:1,biBitCount:32,biCompression:BI_RGB.0,..Default::default()};let mut bits=std::ptr::null_mut();let bitmap=CreateDIBSection(Some(dc),&info,DIB_RGB_COLORS,&mut bits,None,0).unwrap();let previous=SelectObject(dc,bitmap.into());std::ptr::copy_nonoverlapping(crop.pixels.as_ptr(),bits.cast::<u8>(),crop.pixels.len());let surface=Surface{dc,bitmap,previous,bits:bits.cast(),width:crop.width,height:crop.height};
   let result=pick(surface,RECT{left:-30000,top:-30000,right:-28500,bottom:-29760},Arc::new(AtomicBool::new(i%2==1)),true).unwrap();if i%2==0{let crop=result.unwrap();assert_eq!((crop.width,crop.height),(200,80));assert_eq!(crop.pixels.len(),200*80*4);}else{assert!(result.is_none());}
  }
 }}
 #[test] fn four_k_picker_releases_full_screen_pixels_after_cropping(){unsafe{
  let before=memory();let mut peak=before;for _ in 0..3 {
   let width=3840;let height=2160;let dc=CreateCompatibleDC(None);let mut info=BITMAPINFO::default();info.bmiHeader=BITMAPINFOHEADER{biSize:size_of::<BITMAPINFOHEADER>()as u32,biWidth:width,biHeight:-height,biPlanes:1,biBitCount:32,biCompression:BI_RGB.0,..Default::default()};let mut bits=std::ptr::null_mut();let bitmap=CreateDIBSection(Some(dc),&info,DIB_RGB_COLORS,&mut bits,None,0).unwrap();let previous=SelectObject(dc,bitmap.into());std::ptr::write_bytes(bits.cast::<u8>(),255,width as usize*height as usize*4);peak=peak.max(memory());
   let surface=Surface{dc,bitmap,previous,bits:bits.cast(),width,height};let crop=pick(surface,RECT{left:-30000,top:-30000,right:-30000+width,bottom:-30000+height},Arc::new(AtomicBool::new(false)),true).unwrap().unwrap();assert_eq!(crop.pixels.len(),200*80*4);drop(crop);
  }println!("PICKER_4K iterations=3 baseline_mib={:.2} sampled_allocated_peak_mib={:.2} final_mib={:.2}",before as f64/1048576.,peak as f64/1048576.,memory()as f64/1048576.);
 }}
 #[test] fn installed_system_ocr_reads_synthetic_ascii_repeatedly(){exercise_ocr_fixture(false);}
 #[test]
 #[ignore="requires Simplified Chinese OCR, Microsoft YaHei and a Chinese user language; run separately with the test manifest"]
 fn installed_system_ocr_reads_synthetic_chinese_and_ascii_repeatedly(){exercise_ocr_fixture(true);}
 fn exercise_ocr_fixture(require_chinese:bool){
  let langs=languages().unwrap();assert!(!langs.is_empty(),"fixture requires installed OCR language");let before=memory();let started=std::time::Instant::now();let mut samples=vec![];
  for _ in 0..12 {let crop=unsafe{fixture()};let(text,image)=recognize(crop,Arc::new(AtomicBool::new(false))).unwrap();assert!(text.contains("12345"),"synthetic ASCII recognition failed");if require_chinese{assert!(text.contains("目标"),"synthetic Chinese recognition failed: {text:?}");}assert_eq!(&image[..2],b"BM");drop(image);samples.push(memory());}
  println!("OCR_FIXTURE iterations=12 elapsed_ms={} baseline_mib={:.2} first_mib={:.2} final_mib={:.2} max_sample_mib={:.2}",started.elapsed().as_millis(),before as f64/1048576.,samples[0]as f64/1048576.,samples[11]as f64/1048576.,*samples.iter().max().unwrap()as f64/1048576.);
 }
}

#[cfg(test)]mod spacing_tests{use super::*;#[test]fn reconstructs_words_without_inserting_spaces_in_chinese_or_split_identifiers(){let chinese=vec![("目".into(),0.,30.),("标".into(),31.,30.)];assert_eq!(compose_line(&chinese,0.),"目标");let code=vec![("item_".into(),20.,50.),("count".into(),71.,50.),("+=".into(),131.,20.)];assert_eq!(compose_line(&code,0.),"  item_count +=");}}

#[cfg(test)] mod variable_spacing_regressions {
 use super::*;
 #[test] fn thin_punctuation_does_not_split_variable_or_number() {
  let words=vec![("n".into(),0.,7.),("u".into(),8.,7.),("m".into(),16.,8.),("s".into(),25.,6.),("=".into(),38.,6.),("[".into(),49.,1.),("1".into(),51.,6.),("5".into(),58.,6.),("]".into(),65.,1.)];
  assert_eq!(compose_line(&words,0.),"nums = [15]");
 }
 #[test] fn actual_large_word_gap_and_indentation_remain() {
  let words=vec![("return".into(),20.,42.),("value".into(),69.,35.),(";".into(),105.,1.)];
  assert_eq!(compose_line(&words,0.),"   return value;");
 }
}
