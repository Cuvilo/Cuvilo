//! Traditional OCR adapters. Images, signatures and credentials stay in memory.
use crate::{network,types::{Provider,Secret,Network}};
use anyhow::{ensure,Context,Result};
use base64::Engine;
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::{sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};

pub const YOUDAO_FREE_ID:&str="youdao-free";
pub fn youdao_free_provider()->Provider{Provider{id:YOUDAO_FREE_ID.into(),name:"有道云端 OCR".into(),kind:YOUDAO_FREE_ID.into(),base_url:"https://ocrtran.youdao.com/ocr/imgtranocr".into(),model:"auto".into(),app_id:String::new(),secret_id:String::new()}}
pub fn supports(p:&Provider)->bool{["youdao-ocr","ocr-space","youdao-free"].contains(&p.kind.as_str())}
pub fn validate(p:&Provider)->Result<url::Url>{
 ensure!(supports(p),"不支持的云端 OCR 类型");
 let url=url::Url::parse(p.base_url.trim()).context("OCR 接口地址格式不正确")?;
 let loopback=matches!(url.host_str(),Some("127.0.0.1"|"localhost"|"[::1]"));
 ensure!((url.scheme()=="https"||(url.scheme()=="http"&&loopback))&&url.host_str().is_some()&&url.username().is_empty()&&url.password().is_none()&&url.query().is_none()&&url.fragment().is_none(),"OCR 接口须使用不含凭据或查询参数的 HTTPS 地址");
 if p.kind==YOUDAO_FREE_ID{ensure!(loopback||(url.host_str()==Some("ocrtran.youdao.com")&&url.path()=="/ocr/imgtranocr"),"免密 OCR 接口地址不正确");}
 Ok(url)
}
fn signed_form(p:&Provider,s:&Secret,image:&str,salt:&str,time:&str)->Vec<(String,String)>{
 let input=if image.len()>20{format!("{}{}{}",&image[..10],image.len(),&image[image.len()-10..])}else{image.to_string()};
 let sign=format!("{:x}",Sha256::digest(format!("{}{}{}{}{}",p.app_id.trim(),input,salt,time,s.api_key.trim()).as_bytes()));
 [("img",image),("langType",if p.model.trim().is_empty(){"zh-CHS"}else{p.model.trim()}),("detectType","10012"),("imageType","1"),("appKey",p.app_id.trim()),("salt",salt),("curtime",time),("signType","v3"),("docType","json"),("sign",&sign)].into_iter().map(|(k,v)|(k.into(),v.into())).collect()
}
// Wire format reference: reevebyte/ScreenTranslate, native/src/cloud_ocr.cpp,
// revision b78836bec041d12b081ab9ba027f39aeea6cb942 (MIT).
// This is the public client's protocol constant, not a user's API credential.
fn youdao_free_signature(encoded:&str,salt:&str)->String{
 let input=format!("{}{}{}",&encoded[..encoded.len().min(10)],encoded.len(),&encoded[encoded.len().saturating_sub(10)..]);
 let client_constant="VPaHE3kX_vl4BhgYiu2n";
 format!("{:x}",md5::compute(format!("deskdict{input}{salt}{client_constant}")))
}
fn youdao_free_form(image:&[u8],encoded:&str,salt:&str,boundary:&str)->Vec<u8>{
 let mut body=Vec::new();
 let sign=youdao_free_signature(encoded,salt);
 for(name,value)in [("clientele","deskdict"),("salt",salt),("sign",&sign),("from","auto"),("to","zh-CHS"),("isSaveHistory","false"),("isSyncSaveHistory","false"),("funDesc","photo_translate")]{
  body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
 }
 body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"multipartFile\"; filename=\"capture.png\"\r\nContent-Type: image/png\r\n\r\n").as_bytes());
 body.extend_from_slice(image);body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());body
}
fn form_body(fields:&[(String,String)])->String{url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields.iter().map(|(k,v)|(k.as_str(),v.as_str()))).finish()}
fn code(v:&Value)->String{v.as_str().map(str::to_string).or_else(||v.as_i64().map(|v|v.to_string())).unwrap_or_default()}
fn parse(p:&Provider,v:&Value)->Result<String>{
 let lines=if p.kind==YOUDAO_FREE_ID{
  let error=code(&v["errorCode"]);ensure!(error=="0","有道免密 OCR 失败（代码 {}），请稍后重试或切换本地识别",safe_code(&error));
  let regions=v["resRegions"].as_array().context("有道免密 OCR 返回格式无效")?;
  let mut out=Vec::new();for region in regions{
   let mut texts=Vec::new();if let Some(lines)=region["lines"].as_array(){for line in lines{let text=line["text"].as_str().context("有道免密 OCR 缺少文字内容")?;if !text.trim().is_empty(){texts.push(text.to_string());}}}
   if texts.is_empty(){if let Some(context)=region["context"].as_str(){texts.extend(context.lines().filter(|line|!line.trim().is_empty()).map(str::to_string));}}
   out.extend(texts);
  }out
 }else if p.kind=="youdao-ocr"{
  let error=code(&v["errorCode"]);ensure!(error=="0","有道 OCR 识别失败（代码 {}），请检查应用密钥、服务开通及额度",safe_code(&error));
  let regions=v["Result"]["regions"].as_array().context("有道 OCR 返回格式无效")?;
  let mut out=Vec::new();for region in regions{for line in region["lines"].as_array().context("有道 OCR 缺少行数据")?{out.push(line["text"].as_str().context("有道 OCR 缺少文字内容")?.to_string());}}out
 }else{
  ensure!(v["IsErroredOnProcessing"]==false&&code(&v["OCRExitCode"])=="1","OCR.space 识别失败或结果不完整，请检查密钥、额度和图片大小");
  let mut out=Vec::new();for page in v["ParsedResults"].as_array().context("OCR.space 返回格式无效")?{
   ensure!(code(&page["FileParseExitCode"])=="1","OCR.space 未完整识别图片，请重试");out.push(page["ParsedText"].as_str().context("OCR.space 缺少文字内容")?.to_string());
  }out
 };
 let text=lines.join("\n");ensure!(text.chars().count()<=12000,"识别文字过长，请缩小选区");Ok(text)
}
fn safe_code(value:&str)->String{let result=value.chars().filter(char::is_ascii_alphanumeric).take(12).collect::<String>();if result.is_empty(){"未知".into()}else{result}}
async fn response_value(mut response:reqwest::Response)->Result<Value>{
 ensure!(response.status().is_success(),"云端 OCR 请求失败（HTTP {}）",response.status().as_u16());
 let mut bytes=Vec::new();while let Some(part)=response.chunk().await.context("云端 OCR 响应中断")?{ensure!(bytes.len()+part.len()<=256*1024,"云端 OCR 响应过长");bytes.extend_from_slice(&part);}
 serde_json::from_slice(&bytes).context("云端 OCR 返回格式无效")
}
pub async fn recognize(p:&Provider,s:&Secret,n:&Network,image:Vec<u8>,cancel:Arc<AtomicBool>)->Result<String>{
 let work=async{
  let endpoint=validate(p)?;ensure!(p.kind==YOUDAO_FREE_ID||!s.api_key.trim().is_empty(),"请填写 OCR 服务密钥");
  ensure!(image.len()<=if p.kind=="ocr-space"{1_000_000}else{4*1024*1024},"图片超过此 OCR 接口的大小限制，请缩小选区");
  ensure!(!cancel.load(Ordering::Acquire),"识别已取消");
  let encoded=base64::engine::general_purpose::STANDARD.encode(&image);
  let client=network::client_no_redirects(n)?;let request=if p.kind==YOUDAO_FREE_ID{
   let salt=format!("0.{:018}",uuid::Uuid::new_v4().as_u128()%1_000_000_000_000_000_000u128);
   let boundary=format!("----Cuvilo{}",crate::types::new_id().replace('-',""));
   let body=youdao_free_form(&image,&encoded,&salt,&boundary);
   client.post(endpoint).header("User-Agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36").header("Accept","*/*").header("Content-Type",format!("multipart/form-data; boundary={boundary}")).body(body)
  }else if p.kind=="youdao-ocr"{
   ensure!(!p.app_id.trim().is_empty(),"请填写有道应用 ID");
   let fields=signed_form(p,s,&encoded,&crate::types::new_id(),&chrono::Utc::now().timestamp().to_string());
   client.post(endpoint).header("Content-Type","application/x-www-form-urlencoded").body(form_body(&fields))
  }else{
   let fields=vec![("base64Image".into(),format!("data:image/png;base64,{encoded}")),("language".into(),if p.model.trim().is_empty(){"chs".into()}else{p.model.trim().into()}),("isOverlayRequired".into(),"false".into()),("OCREngine".into(),"1".into())];
   client.post(endpoint).header("apikey",s.api_key.trim()).header("Content-Type","application/x-www-form-urlencoded").body(form_body(&fields))
  };
  let response=request.timeout(Duration::from_secs(40)).send().await.context("云端 OCR 连接失败")?;
  parse(p,&response_value(response).await?)
 };
 tokio::pin!(work);let mut ticker=tokio::time::interval(Duration::from_millis(40));
 let result=loop{tokio::select!{result=&mut work=>break result,_=ticker.tick()=>{if cancel.load(Ordering::Acquire){break Err(anyhow::anyhow!("识别已取消"));}}}};
 result.map_err(|e|anyhow::anyhow!(crate::secrets::redact(&format!("{e:#}"),s)))
}
pub fn probe_image()->Result<Vec<u8>>{
 // A static TEST bitmap checks real OCR, without capturing the user's desktop.
 let mut pixels=vec![255;192*64*4];
 for(index,rows)in [[31u8,4,4,4,4,4,4],[31,16,16,30,16,16,31],[31,16,16,31,1,1,31],[31,4,4,4,4,4,4]].iter().enumerate(){
  for(y,row)in rows.iter().enumerate(){for x in 0..5{if row&(1<<(4-x))!=0{for dy in 0..6{for dx in 0..6{let offset=((8+y*6+dy)*192+16+index*36+x*6+dx)*4;pixels[offset..offset+3].fill(0);}}}}}
 }
 crate::remote_ocr::png_image(192,64,&pixels)
}

#[cfg(test)]mod tests{
 use super::*;
 use serde_json::json;
 fn provider(kind:&str)->Provider{Provider{id:format!("fixture-{kind}"),name:"fixture OCR".into(),kind:kind.into(),base_url:"https://fixture.invalid/ocr".into(),model:if kind=="youdao-ocr"{"zh-CHS"}else{"chs"}.into(),app_id:"id".into(),secret_id:String::new()}}
 fn secret()->Secret{Secret{api_key:"secret".into(),secret_key:String::new()}}
 fn direct()->Network{Network{mode:"direct".into(),url:String::new()}}
 async fn server(body:&'static str)->(String,tokio::task::JoinHandle<String>){server_response("200 OK",String::new(),body).await}
 async fn server_response(status:&'static str,headers:String,body:&'static str)->(String,tokio::task::JoinHandle<String>){
  use tokio::{net::TcpListener,io::{AsyncReadExt,AsyncWriteExt}};
  let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
  let task=tokio::spawn(async move{let(mut socket,_)=listener.accept().await.unwrap();let mut bytes=Vec::new();loop{let mut chunk=[0;4096];let n=socket.read(&mut chunk).await.unwrap();assert!(n>0);bytes.extend_from_slice(&chunk[..n]);if let Some(pos)=bytes.windows(4).position(|v|v==b"\r\n\r\n"){let head=String::from_utf8_lossy(&bytes[..pos]);let length=head.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|v|v.trim().parse::<usize>().unwrap())).unwrap();if bytes.len()>=pos+4+length{break}}}
   socket.write_all(format!("HTTP/1.1 {status}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();String::from_utf8_lossy(&bytes).into_owned()});
  (format!("http://{address}/ocr"),task)
 }
 #[test]fn official_v3_signature_uses_truncated_image_and_raw_form_values(){
  let fields=signed_form(&provider("youdao-ocr"),&secret(),"abcdefghijklmnopqrstuvwxy","salt","123");
  assert_eq!(fields.iter().find(|v|v.0=="sign").unwrap().1,"f7e467f4501cfa9beab982ef8e2248bbd8c2195a150ef1a228da317b0a9b3774");
  let fields=signed_form(&provider("youdao-ocr"),&secret(),"+/8=","salt","123");let form=form_body(&fields);let decoded=url::form_urlencoded::parse(form.as_bytes()).collect::<std::collections::HashMap<_,_>>();assert_eq!(decoded["img"],"+/8=");assert!(!form.contains("secret"));
 }
 #[tokio::test]async fn youdao_posts_v3_form_and_returns_lines_without_answering(){
  let(url,task)=server(r#"{"errorCode":"0","Result":{"regions":[{"lines":[{"text":"if (x) {"},{"text":"  return 1;"}]}]}}"#).await;let mut p=provider("youdao-ocr");p.base_url=url;
  let out=recognize(&p,&secret(),&direct(),vec![251,255],Arc::new(AtomicBool::new(false))).await.unwrap();assert_eq!(out,"if (x) {\n  return 1;");
  let raw=task.await.unwrap();assert!(raw.starts_with("POST /ocr "));let fields=url::form_urlencoded::parse(raw.split("\r\n\r\n").nth(1).unwrap().as_bytes()).collect::<std::collections::HashMap<_,_>>();assert_eq!(fields["appKey"],"id");assert_eq!(fields["signType"],"v3");assert_eq!(fields["img"],"+/8=");assert_eq!(fields["langType"],"zh-CHS");assert!(!raw.contains("secret"));
 }
 #[tokio::test]async fn ocr_space_sends_key_header_and_preserves_original_base64(){
  let(url,task)=server(r#"{"IsErroredOnProcessing":false,"OCRExitCode":1,"ParsedResults":[{"FileParseExitCode":1,"ParsedText":"题目\n  code"}]}"#).await;let mut p=provider("ocr-space");p.base_url=url;
  assert_eq!(recognize(&p,&secret(),&direct(),vec![251,255],Arc::new(AtomicBool::new(false))).await.unwrap(),"题目\n  code");let raw=task.await.unwrap();assert!(raw.to_lowercase().contains("apikey: secret"));let fields=url::form_urlencoded::parse(raw.split("\r\n\r\n").nth(1).unwrap().as_bytes()).collect::<std::collections::HashMap<_,_>>();assert_eq!(fields["base64Image"],"data:image/png;base64,+/8=");assert_eq!(fields["language"],"chs");
 }
 #[test]fn partial_errors_and_malformed_results_are_not_success(){
  assert!(parse(&provider("youdao-ocr"),&json!({"errorCode":"401"})).is_err());assert!(parse(&provider("youdao-ocr"),&json!({"errorCode":"0"})).is_err());
  for value in [json!({"IsErroredOnProcessing":true,"OCRExitCode":3}),json!({"IsErroredOnProcessing":false,"OCRExitCode":2,"ParsedResults":[]}),json!({"IsErroredOnProcessing":false,"OCRExitCode":1,"ParsedResults":[{"FileParseExitCode":-10}]})]{assert!(parse(&provider("ocr-space"),&value).is_err());}
 }
 #[tokio::test]async fn empty_keys_missing_appid_cancel_and_size_limits_fail_without_network(){
  let mut p=provider("youdao-ocr");assert!(recognize(&p,&Secret::default(),&direct(),vec![],Arc::new(AtomicBool::new(false))).await.unwrap_err().to_string().contains("密钥"));
  p.app_id.clear();assert!(recognize(&p,&secret(),&direct(),vec![],Arc::new(AtomicBool::new(false))).await.unwrap_err().to_string().contains("应用 ID"));
  assert!(recognize(&provider("ocr-space"),&secret(),&direct(),vec![],Arc::new(AtomicBool::new(true))).await.unwrap_err().to_string().contains("取消"));
  assert!(recognize(&provider("ocr-space"),&secret(),&direct(),vec![0;1_000_001],Arc::new(AtomicBool::new(false))).await.unwrap_err().to_string().contains("大小限制"));
 }
 #[test]fn endpoint_validation_rejects_remote_http_and_credentials(){let mut p=provider("ocr-space");for value in ["http://fixture.invalid","file:///tmp/a","https://key@fixture.invalid","https://fixture.invalid?apikey=x"]{p.base_url=value.into();assert!(validate(&p).is_err());}assert!(probe_image().unwrap().starts_with(b"\x89PNG"));}
 #[tokio::test]async fn redirects_do_not_forward_ocr_api_keys_to_another_endpoint(){
  let target=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=target.local_addr().unwrap();
  let(url,task)=server_response("307 Temporary Redirect",format!("Location: http://{address}/other\r\n"),"{}").await;
  let mut p=provider("ocr-space");p.base_url=url;let error=recognize(&p,&secret(),&direct(),vec![],Arc::new(AtomicBool::new(false))).await.unwrap_err();assert!(error.to_string().contains("HTTP 307"));task.await.unwrap();
  assert!(tokio::time::timeout(Duration::from_millis(100),target.accept()).await.is_err());
 }

 #[tokio::test]async fn free_youdao_uploads_multipart_png_without_user_credentials(){
  let(url,task)=server(r#"{"errorCode":"0","resRegions":[{"lines":[{"text":"题目"},{"text":"  if (x) return 1;"}]},{"context":"第二段\nthird line"}]}"#).await;
  let mut p=youdao_free_provider();p.base_url=url;let image=probe_image().unwrap();let expected=image.clone();
  let output=recognize(&p,&Secret::default(),&direct(),image,Arc::new(AtomicBool::new(false))).await.unwrap();assert_eq!(output,"题目\n  if (x) return 1;\n第二段\nthird line");
  let raw=task.await.unwrap();assert!(raw.to_lowercase().contains("content-type: multipart/form-data; boundary="));assert!(raw.contains("name=\"clientele\"\r\n\r\ndeskdict"));assert!(raw.contains("name=\"isSaveHistory\"\r\n\r\nfalse"));assert!(raw.contains("name=\"isSyncSaveHistory\"\r\n\r\nfalse"));assert!(!raw.to_lowercase().contains("authorization:"));assert!(!raw.to_lowercase().contains("apikey:"));
  // This server helper decodes raw HTTP as UTF-8; the PNG part is checked separately below.
  assert!(expected.starts_with(b"\x89PNG"));
 }
 #[test]fn free_youdao_signature_and_multipart_match_the_reference_protocol(){
  let encoded="abcdefghijklmnopqrstuvwxy";let salt="0.123";
  assert_eq!(youdao_free_signature(encoded,salt),"dbefe9c69108c2e658b72fc95833928d");
  let bytes=probe_image().unwrap();let body=youdao_free_form(&bytes,&base64::engine::general_purpose::STANDARD.encode(&bytes),salt,"fixture-boundary");
  assert!(body.windows(bytes.len()).any(|part|part==bytes));assert!(body.ends_with(b"\r\n--fixture-boundary--\r\n"));
  let p=youdao_free_provider();assert!(parse(&p,&serde_json::json!({"errorCode":"1"})).is_err());assert!(parse(&p,&serde_json::json!({"errorCode":"0"})).is_err());
 }
 #[tokio::test]#[ignore="Explicit network smoke test; uploads only a built-in TEST bitmap"]async fn live_youdao_free_probe(){
  let p=youdao_free_provider();let text=recognize(&p,&Secret::default(),&Network{mode:"system".into(),url:String::new()},probe_image().unwrap(),Arc::new(AtomicBool::new(false))).await.unwrap();assert!(!text.trim().is_empty(),"Live OCR returned no text for synthetic TEST bitmap");
 }

}
