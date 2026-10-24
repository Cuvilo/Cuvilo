use super::*;
use crate::{core::Runtime,screen_capture::CaptureState,secrets};
use serde_json::{json,Value};
use std::sync::Mutex;
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
struct Server{address:String,requests:Arc<Mutex<Vec<(String,Value)>>>,task:tokio::task::JoinHandle<()>}
impl Drop for Server{fn drop(&mut self){self.task.abort();}}
async fn server(behavior:&'static str)->Server{
 let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap().to_string();let requests=Arc::new(Mutex::new(vec![]));let captured=requests.clone();
 let task=tokio::spawn(async move{loop{let (mut socket,_)=listener.accept().await.unwrap();let captured=captured.clone();tokio::spawn(async move{
  let mut bytes=vec![];let (header_end,length)=loop{let mut buf=[0;4096];let n=socket.read(&mut buf).await.unwrap();if n==0{return;}bytes.extend_from_slice(&buf[..n]);assert!(bytes.len()<65536);if let Some(pos)=bytes.windows(4).position(|b|b==b"\r\n\r\n"){let head=String::from_utf8_lossy(&bytes[..pos]);let length=head.lines().find_map(|l|l.to_lowercase().strip_prefix("content-length:").map(|v|v.trim().parse::<usize>().unwrap())).unwrap();break(pos+4,length);}};
  while bytes.len()<header_end+length{let mut buf=[0;4096];let n=socket.read(&mut buf).await.unwrap();if n==0{return;}bytes.extend_from_slice(&buf[..n]);}
  let path=String::from_utf8_lossy(&bytes[..header_end]).lines().next().unwrap().split_whitespace().nth(1).unwrap().to_string();let body:Value=serde_json::from_slice(&bytes[header_end..header_end+length]).unwrap();captured.lock().unwrap().push((path.clone(),body));
  let (status,kind,body)=if path.starts_with("/vision"){
   match behavior{
    "stall"=>{tokio::time::sleep(std::time::Duration::from_secs(2)).await;(200,"text/event-stream",String::new())},
    "http"|"ocr-fail"|"ocr-stall"=>(400,"application/json",json!({"error":{"message":"fixture image unsupported"}}).to_string()),
    "partial"=>(200,"text/event-stream",format!("data: {}\n\ndata: {}\n\n",json!({"choices":[{"delta":{"content":"题目：错误标题\n半截旧答案"}}]}),json!({"error":{"message":"fixture interrupted"}}))),
    "truncated"=>(200,"text/event-stream",format!("data: {}\n\n",json!({"choices":[{"delta":{"content":"题目：错误标题\n半截旧答案"}}]}))),
    "empty"=>(200,"text/event-stream","data: [DONE]\n\n".into()),
    _=>(200,"text/event-stream",format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":"题目：图片题摘要\n"}}]}),json!({"choices":[{"delta":{"content":"直接视觉答案。"}}]}))),
   }
  }else if path.starts_with("/ocr"){
   if behavior=="ocr-stall"{tokio::time::sleep(std::time::Duration::from_secs(2)).await;}
   if behavior=="ocr-fail"{(503,"application/json",json!({"error":{"message":"fixture OCR failed"}}).to_string())}else{(200,"application/json",json!({"choices":[{"message":{"content":"if (a <= b) return a;"},"finish_reason":"stop"}]}).to_string())}
  }else{(200,"text/event-stream",format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":"OCR回退后的文字答案。"}}]})))};
  let reply=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());let _=socket.write_all(reply.as_bytes()).await;
 });}});Server{address,requests,task}
}
struct Fixture{core:Arc<Core>,settings:Settings,p:Provider,secret:Secret,answer:Answer,cancel:CancellationToken,image:Arc<VisionImage>,ids:Vec<String>}
impl Drop for Fixture{fn drop(&mut self){for id in &self.ids{let _=secrets::remove(id);}}}
fn fixture(server:&Server)->Fixture{
 let core=Core::open(std::path::Path::new(":memory:")).unwrap();let session=Session{id:"vision-fixture".into(),title:"synthetic".into(),created_at:1,ended_at:None};core.db.lock().unwrap().session(&session).unwrap();*core.runtime.lock().unwrap()=Some(Runtime{session:session.clone(),cancel:CancellationToken::new()});
 let secret=Secret{api_key:"fixture-not-a-real-key".into(),secret_key:String::new()};let mut settings=Settings::default();settings.network=Network{mode:"direct".into(),url:String::new()};let mut ids=vec![];let mut providers=vec![];
 for (route,kind)in [("vision","llm"),("text","llm"),("ocr","ocr")]{let id=format!("test-vision-{route}-{}",new_id());secrets::save(&id,&secret).unwrap();providers.push(Provider{id:id.clone(),name:route.into(),kind:kind.into(),base_url:format!("http://{}/{route}",server.address),model:format!("fixture-{route}"),app_id:String::new(),secret_id:String::new()});ids.push(id);}
 settings.screenshot_model=ids[0].clone();settings.active_model=ids[1].clone();settings.ocr_provider=ids[2].clone();settings.providers=providers;*core.settings.lock().unwrap()=settings.clone();
 let cancel=CancellationToken::new();*core.answer_cancel.lock().unwrap()=cancel.clone();core.generation.store(1,Ordering::SeqCst);core.screen_priority.store(true,Ordering::Release);
 let image=Arc::new(VisionImage::new(8,8,vec![255;256]).unwrap());let answer=Answer{sources:Vec::new(),id:"answer-fixture".into(),session_id:session.id,question_id:"question-fixture".into(),question:"截图提问".into(),revision:1,text:String::new(),status:"generating".into(),mode:"screen-vision".into(),created_at:1,speech_end_at:1,trigger_at:1,request_at:0,first_token_ms:None,first_sentence_ms:None};core.save_answer(&answer);*core.active_answer.lock().unwrap()=Some(answer.clone());*core.screen.lock().unwrap()=CaptureState{job_id:"job-fixture".into(),session_id:answer.session_id.clone(),question_id:answer.question_id.clone(),stage:"answering".into(),vision_image:Some(image.clone()),image:Some(Arc::new(vec![1,2,3])),..Default::default()};
 Fixture{core,p:settings.providers[0].clone(),settings,secret,answer,cancel,image,ids}
}
async fn run(f:&Fixture,budget:u64){generate_with_deadline(f.core.clone(),f.answer.clone(),f.p.clone(),f.secret.clone(),f.settings.clone(),"fixture-reference-material".into(),f.cancel.clone(),1,f.image.clone(),std::time::Duration::from_millis(budget)).await;}
fn result(f:&Fixture)->Answer{f.core.db.lock().unwrap().answers("vision-fixture").unwrap().pop().unwrap()}
#[tokio::test]async fn image_goes_only_to_selected_model_and_streams_into_one_history_answer(){
 let s=server("success").await;let f=fixture(&s);run(&f,2000).await;let answer=result(&f);assert_eq!((answer.question.as_str(),answer.text.as_str(),answer.status.as_str()),("图片题摘要","直接视觉答案。","complete"));assert_eq!(answer.id,f.answer.id);assert_eq!(f.core.db.lock().unwrap().answers("vision-fixture").unwrap().len(),1);assert!(!f.core.screen_priority.load(Ordering::Acquire));let requests=s.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(requests[0].0.starts_with("/vision"));assert!(requests[0].1["messages"][1]["content"][1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
}
#[tokio::test]async fn unsupported_empty_partial_and_truncated_images_fall_back_once_and_replace_partial_output(){
 for behavior in ["http","empty","partial","truncated"]{let s=server(behavior).await;let f=fixture(&s);run(&f,2000).await;let answer=result(&f);assert_eq!(answer.id,f.answer.id);assert_eq!(answer.question,"if (a <= b) return a;");assert_eq!(answer.text,"OCR回退后的文字答案。");assert_eq!(answer.status,"complete");assert_eq!(answer.mode,"screen");let requests=s.requests.lock().unwrap();assert_eq!(requests.iter().map(|r|r.0.as_str()).collect::<Vec<_>>(),vec!["/vision/chat/completions","/ocr/chat/completions","/text/chat/completions"]);assert!(requests[2].1["messages"][1]["content"].is_string());assert!(!requests[2].1.to_string().contains("image_url"));assert!(!f.core.screen_priority.load(Ordering::Acquire));}
}
#[tokio::test]async fn deadline_falls_back_instead_of_waiting_for_stalled_vision(){let s=server("stall").await;let f=fixture(&s);run(&f,100).await;assert_eq!(result(&f).status,"complete");assert_eq!(s.requests.lock().unwrap().len(),3);}
#[tokio::test]async fn failed_ocr_stops_without_retrying_or_sending_an_empty_text_question(){let s=server("ocr-fail").await;let f=fixture(&s);run(&f,2000).await;assert_eq!(result(&f).status,"error");assert_eq!(s.requests.lock().unwrap().len(),2);assert_eq!(f.core.screen.lock().unwrap().stage,"error");assert!(!f.core.screen_priority.load(Ordering::Acquire));}
#[tokio::test]async fn fallback_respects_confirmation_then_reuses_the_question_id(){
 let s=server("http").await;let mut f=fixture(&s);f.settings.screen_capture.confirm_before_answer=true;*f.core.settings.lock().unwrap()=f.settings.clone();run(&f,2000).await;assert_eq!(f.core.screen.lock().unwrap().stage,"ready");assert_eq!(s.requests.lock().unwrap().len(),2);assert!(f.core.screen_priority.load(Ordering::Acquire));screen_capture::submit(&f.core,"job-fixture","corrected OCR question".into()).unwrap();tokio::time::timeout(std::time::Duration::from_secs(3),async{loop{let a=result(&f);if a.status=="complete"{assert_eq!(a.question_id,f.answer.question_id);assert_eq!(a.question,"corrected OCR question");break;}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}}).await.unwrap();assert_eq!(s.requests.lock().unwrap().len(),3);
}
#[tokio::test]async fn cancel_or_end_during_vision_never_starts_fallback_or_revives_old_jobs(){
 for end in [false,true]{let s=server("stall").await;let f=fixture(&s);let work={let core=f.core.clone();let answer=f.answer.clone();let p=f.p.clone();let secret=f.secret.clone();let settings=f.settings.clone();let cancel=f.cancel.clone();let image=f.image.clone();tokio::spawn(async move{generate(core,answer,p,secret,settings,String::new(),cancel,1,image).await})};tokio::time::timeout(std::time::Duration::from_secs(2),async{while s.requests.lock().unwrap().is_empty(){tokio::time::sleep(std::time::Duration::from_millis(5)).await;}}).await.unwrap();if end{f.core.stop().unwrap();}else{f.core.cancel_answer();}tokio::time::timeout(std::time::Duration::from_secs(1),work).await.unwrap().unwrap();assert_eq!(s.requests.lock().unwrap().len(),1);assert_eq!(result(&f).status,"cancelled");if end{assert!(f.core.screen.lock().unwrap().vision_image.is_none());}}
}
#[tokio::test]async fn already_cancelled_jobs_send_no_image(){let s=server("success").await;let f=fixture(&s);f.cancel.cancel();run(&f,100).await;assert!(s.requests.lock().unwrap().is_empty());}

#[tokio::test]async fn cancelling_during_ocr_clears_generating_state_and_never_sends_a_text_request(){
 let s=server("ocr-stall").await;let f=fixture(&s);let work={let core=f.core.clone();let answer=f.answer.clone();let p=f.p.clone();let secret=f.secret.clone();let settings=f.settings.clone();let cancel=f.cancel.clone();let image=f.image.clone();tokio::spawn(async move{generate(core,answer,p,secret,settings,String::new(),cancel,1,image).await})};
 tokio::time::timeout(std::time::Duration::from_secs(2),async{while s.requests.lock().unwrap().len()<2{tokio::time::sleep(std::time::Duration::from_millis(5)).await;}}).await.unwrap();f.core.cancel_screen_capture();tokio::time::timeout(std::time::Duration::from_secs(1),work).await.unwrap().unwrap();assert_eq!(s.requests.lock().unwrap().len(),2);assert_eq!(result(&f).status,"cancelled");assert_eq!(f.core.screen.lock().unwrap().stage,"idle");assert!(!f.core.screen_priority.load(Ordering::Acquire));
}
#[tokio::test]async fn reanswer_keeps_the_image_route_and_released_images_are_never_reused(){
 let s=server("success").await;let f=fixture(&s);run(&f,2000).await;f.core.trigger(None,"short",Some(f.answer.question_id.clone())).unwrap();
 tokio::time::timeout(std::time::Duration::from_secs(3),async{loop{let answers=f.core.db.lock().unwrap().answers("vision-fixture").unwrap();if answers.len()==2&&answers[1].status=="complete"{assert_eq!(answers[1].question_id,f.answer.question_id);assert_eq!(answers[1].mode,"screen-vision");break;}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}}).await.unwrap();assert_eq!(s.requests.lock().unwrap().len(),2);assert!(s.requests.lock().unwrap().iter().all(|r|r.0.starts_with("/vision")));screen_capture::clear(&f.core);assert!(f.core.trigger(None,"short",Some(f.answer.question_id.clone())).is_err());assert_eq!(s.requests.lock().unwrap().len(),2);
}

#[tokio::test]async fn blank_auxiliary_ocr_keeps_image_authoritative_and_does_not_add_unrelated_knowledge(){
 let s=server("success").await;let mut f=fixture(&s);
 {let db=f.core.db.lock().unwrap();for (id,kind,text) in [("profile","resume","负责订单结算服务"),("knowledge","knowledge","Vue 组件生命周期与网格布局")]{db.save_material(&Material{id:id.into(),title:id.into(),kind:kind.into(),text:text.into(),enabled:true,updated_at:1}).unwrap();}}
 let (context,sources)=f.core.answer_context(&f.settings,&f.answer.session_id,"").unwrap();f.answer.sources=sources;
 generate_with_deadline(f.core.clone(),f.answer.clone(),f.p.clone(),f.secret.clone(),f.settings.clone(),context,f.cancel.clone(),1,f.image.clone(),std::time::Duration::from_secs(15)).await;
 let answer=result(&f);assert_eq!(answer.status,"complete");assert_eq!(answer.sources.len(),1);assert_eq!(answer.sources[0].material_id,"profile");
 let requests=s.requests.lock().unwrap();assert_eq!(requests.len(),1);let payload=requests[0].1.to_string();assert!(payload.contains("负责订单"));assert!(!payload.contains("生命周期"));assert!(payload.contains("image_url"));
}
#[tokio::test]async fn ocr_fallback_retrieves_by_recognized_question_and_persists_exact_sources(){
 let s=server("http").await;let f=fixture(&s);
 f.core.db.lock().unwrap().save_material(&Material{id:"comparison-doc".into(),title:"比较运算笔记".into(),kind:"knowledge".into(),text:"if (a <= b) return a; compares a and b.".into(),enabled:true,updated_at:1}).unwrap();
 run(&f,15000).await;let answer=result(&f);assert_eq!(answer.status,"complete");assert_eq!(answer.sources.len(),1);assert_eq!(answer.sources[0].material_id,"comparison-doc");
 let requests=s.requests.lock().unwrap();assert_eq!(requests.len(),3);let payload=requests[2].1.to_string();assert!(payload.contains("知识参考"));assert!(payload.contains("compares a and b"));assert!(!payload.contains("image_url"));
}
