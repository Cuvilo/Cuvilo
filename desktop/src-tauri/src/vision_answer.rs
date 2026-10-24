use crate::{core::Core,llm,screen_capture::{self,VisionImage},types::*};
use anyhow::{Context,Result};
use std::sync::{Arc,atomic::Ordering};
use tokio_util::sync::CancellationToken;

pub(crate) struct Heading{pending:String,done:bool}
impl Heading{
 pub fn new(enabled:bool)->Self{Self{pending:String::new(),done:!enabled}}
 pub fn push(&mut self,text:&str,finished:bool)->(Option<String>,String){
  if self.done{return (None,text.into());}
  self.pending.push_str(text);
  if !finished&&!self.pending.contains('\n')&&self.pending.chars().count()<=256{return (None,String::new());}
  self.done=true;let text=std::mem::take(&mut self.pending);
  let (line,rest)=text.split_once('\n').unwrap_or((&text,""));
  let title=line.trim().strip_prefix("题目：").or_else(||line.trim().strip_prefix("题目:"));
  if let Some(title)=title.filter(|v|!v.trim().is_empty()&&v.chars().count()<=120){(Some(title.trim().into()),rest.into())}else{(None,text)}
 }
}
fn live(core:&Core,answer:&Answer,cancel:&CancellationToken,generation:u64)->bool{
 if cancel.is_cancelled()||core.generation.load(Ordering::SeqCst)!=generation||screen_capture::session(core).as_deref()!=Some(&answer.session_id){return false;}
 let state=core.screen.lock().unwrap();state.session_id==answer.session_id&&state.question_id==answer.question_id&&!state.cancel.load(Ordering::Acquire)
}
pub async fn generate(core:Arc<Core>,answer:Answer,p:Provider,secret:Secret,settings:Settings,context:String,cancel:CancellationToken,generation:u64,image:Arc<VisionImage>){
 generate_with_deadline(core,answer,p,secret,settings,context,cancel,generation,image,std::time::Duration::from_secs(45)).await;
}
async fn generate_with_deadline(core:Arc<Core>,mut answer:Answer,p:Provider,secret:Secret,settings:Settings,context:String,cancel:CancellationToken,generation:u64,image:Arc<VisionImage>,deadline:std::time::Duration){
 if !live(&core,&answer,&cancel,generation){return;}
 // Auxiliary local text selects reference material only; the original image is
 // still authoritative and is the only question sent to the visual model.
 let started=std::time::Instant::now();
 let mut context=context;
 let has_knowledge=core.db.lock().unwrap().materials().map(|ms|ms.iter().any(|m|m.enabled&&matches!(m.kind.as_str(),"knowledge"|"terms"))).unwrap_or(false);
 if has_knowledge {
  let query=screen_capture::knowledge_text(image.clone(),cancel.clone()).await;
  if !live(&core,&answer,&cancel,generation){return;}
  if let Some(query)=query {if let Ok((value,sources))=core.answer_context(&settings,&answer.session_id,&query){context=value;answer.sources=sources;}}
 }
 let result=tokio::time::timeout(deadline.saturating_sub(started.elapsed()),llm::stream_answer(&core,&mut answer,&p,&secret,&settings.network,&context,&cancel,generation,settings.answer_words,Some(&image.png))).await.unwrap_or_else(|_|Err(anyhow::anyhow!("截图模型响应超时")));
 if !live(&core,&answer,&cancel,generation){return;}
 if result.is_ok(){screen_capture::vision_progress(&core,&answer,generation,"answering",&answer.question,false);llm::finish(&core,answer,result,&secret,&cancel,generation);return;}
 // Never retry the image model or create another question card. A failed partial
 // stream is replaced in place by at most one OCR + conversation attempt.
 answer.sources.clear();answer.text.clear();answer.question="截图提问".into();answer.mode="screen".into();answer.first_token_ms=None;answer.first_sentence_ms=None;
 if !screen_capture::vision_progress(&core,&answer,generation,"recognizing","",true){return;}
 if !core.publish_generation(&answer,generation,false){return;}
 let flag=core.screen.lock().unwrap().cancel.clone();
 let recognized=tokio::select!{_=cancel.cancelled()=>{flag.store(true,Ordering::Release);return;},result=screen_capture::recognize_image(image,settings.clone(),flag.clone())=>result};
 if !live(&core,&answer,&cancel,generation){return;}
 let mut fallback_secret=Secret{api_key:String::new(),secret_key:String::new()};
 let outcome:Result<()>=async{
  let text=recognized?;screen_capture::validate_text(&text)?;answer.question=text;
  if settings.screen_capture.confirm_before_answer {
   anyhow::ensure!(screen_capture::vision_progress(&core,&answer,generation,"ready",&answer.question,true),"截图任务已失效");return Ok(());
  }
  anyhow::ensure!(screen_capture::vision_progress(&core,&answer,generation,"answering",&answer.question,true),"截图任务已失效");
  if !core.publish_generation(&answer,generation,false){return Ok(());}
  let fallback=settings.providers.iter().find(|p|p.id==settings.active_model&&p.kind=="llm").context("回答模型配置不存在")?;
  let id=fallback.id.clone();fallback_secret=tauri::async_runtime::spawn_blocking(move||crate::secrets::read(&id)).await??;
  let (context,sources)=core.answer_context(&settings,&answer.session_id,&answer.question)?;
  answer.sources=sources;
  llm::stream_answer(&core,&mut answer,fallback,&fallback_secret,&settings.network,&context,&cancel,generation,settings.answer_words,None).await
 }.await;
 if !live(&core,&answer,&cancel,generation){return;}
 if outcome.is_err(){screen_capture::vision_error(&core,&answer,generation,"截图模型和 OCR 回退未能完成，请重试或手动输入题目");}
 if outcome.is_ok()&&settings.screen_capture.confirm_before_answer{
  answer.status="cancelled".into();core.publish_generation(&answer,generation,true);return;
 }
 llm::finish(&core,answer,outcome,&fallback_secret,&cancel,generation);
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn heading_handles_fragmented_titles_and_does_not_discard_nonconforming_answers(){
  let mut p=Heading::new(true);assert_eq!(p.push("题",false),(None,String::new()));assert_eq!(p.push("目：数组求和\n使用哈希表",false),(Some("数组求和".into()),"使用哈希表".into()));assert_eq!(p.push("解答",false),(None,"解答".into()));
  let mut p=Heading::new(true);assert_eq!(p.push("直接给出答案\n正文",false),(None,"直接给出答案\n正文".into()));
  let mut p=Heading::new(true);assert_eq!(p.push("题目：仅有摘要",true),(Some("仅有摘要".into()),String::new()));
 }
}

#[cfg(test)]#[path="vision_answer_tests.rs"]mod integration_tests;
