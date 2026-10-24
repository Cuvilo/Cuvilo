//! Volcengine SAUC binary streaming protocol, new-console X-Api-Key authentication.
//! https://www.volcengine.com/docs/6561/1354869
use anyhow::{ensure,Context,Result};
use serde_json::{json,Value};
use tokio_tungstenite::tungstenite::Message;
use std::io::Read;
use crate::{asr::Parsed,types::{Provider,Secret}};
const LIMIT:usize=4*1024*1024;
pub fn headers(p:&Provider,s:&Secret)->Result<Vec<(&'static str,String)>>{
 ensure!(!s.api_key.trim().is_empty(),"请填写火山引擎语音 API Key");
 ensure!(!p.model.trim().is_empty(),"请填写火山引擎资源 ID");
 let url=url::Url::parse(&p.base_url).context("语音接口地址无效")?;
 ensure!(url.scheme()=="wss"&&url.host_str().is_some(),"语音接口必须使用 wss:// 地址");
 Ok(vec![("x-api-key",s.api_key.trim().into()),("x-api-resource-id",p.model.trim().into()),("x-api-request-id",crate::types::new_id())])
}
fn frame(kind:u8,flags:u8,serialization:u8,payload:&[u8])->Message{
 let mut bytes=vec![0x11,kind<<4|flags,serialization<<4,0];
 bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());bytes.extend_from_slice(payload);Message::Binary(bytes)
}
pub fn initialize()->Message{
 frame(1,0,1,&serde_json::to_vec(&json!({"user":{"uid":"cuvilo"},"audio":{"format":"pcm","codec":"raw","rate":16000,"bits":16,"channel":1},"request":{"model_name":"bigmodel","enable_itn":true,"enable_punc":true,"show_utterances":true,"enable_nonstream":true,"result_type":"single"}})).expect("static ASR request"))
}
pub fn audio(pcm:&[u8],last:bool)->Message{frame(2,if last{2}else{0},0,pcm)}
fn number(bytes:&[u8],position:&mut usize)->Result<u32>{
 let end=position.checked_add(4).context("语音响应长度无效")?;
 let value=u32::from_be_bytes(bytes.get(*position..end).context("语音响应不完整")?.try_into()?);*position=end;Ok(value)
}
pub fn decode(bytes:&[u8])->Result<Value>{
 ensure!(bytes.len()>=8&&bytes.len()<=LIMIT,"语音响应长度无效");
 ensure!(bytes[0]>>4==1,"不支持的语音协议版本");
 let mut position=(bytes[0]&15) as usize*4;
 ensure!(position>=4&&position<=bytes.len(),"语音响应头无效");
 let kind=bytes[1]>>4;let flags=bytes[1]&15;
 ensure!(kind==9||kind==15,"不支持的语音响应类型");
 let code=if kind==15{Some(number(bytes,&mut position)?)}else{if flags&1!=0{number(bytes,&mut position)?;}if flags&4!=0{number(bytes,&mut position)?;}None};
 let size=number(bytes,&mut position)? as usize;
 ensure!(size<=LIMIT&&position.checked_add(size)==Some(bytes.len()),"语音响应大小不匹配");
 let payload=&bytes[position..];let decoded;
 let payload=match bytes[2]&15{
  0=>payload,
  1=>{let mut limited=flate2::read::GzDecoder::new(payload).take((LIMIT+1)as u64);let mut out=Vec::new();limited.read_to_end(&mut out).context("语音响应解压失败")?;ensure!(out.len()<=LIMIT,"语音响应过大");decoded=out;decoded.as_slice()},
  _=>anyhow::bail!("不支持的语音压缩格式")
 };
 if let Some(code)=code{anyhow::bail!("火山引擎语音错误 {code}，请检查密钥、服务开通和资源 ID");}
 ensure!(bytes[2]>>4==1,"语音响应格式无效");
 let value:Value=serde_json::from_slice(payload).context("语音响应 JSON 无效")?;
 if let Some(code)=value.get("code").and_then(Value::as_i64){ensure!(code==0||code==20000000,"火山引擎语音错误 {code}，请检查权限与额度");}
 Ok(value)
}
pub fn parse(value:&Value)->Result<Vec<Parsed>>{
 let result=value.get("result").unwrap_or(&Value::Null);
 let results:Vec<&Value>=match result{Value::Array(items)=>items.iter().collect(),Value::Object(_)=>vec![result],_=>vec![]};
 let mut parsed=Vec::new();
 for result in results{if let Some(utterances)=result["utterances"].as_array(){for utterance in utterances{
  let Some(text)=utterance["text"].as_str().filter(|s|!s.trim().is_empty())else{continue;};
  let start=utterance["start_time"].as_i64().context("语音分句缺少起始时间")?;
  parsed.push(Parsed{segment:start.to_string(),text:text.into(),final_result:utterance["definite"]==true});
 }}}
 Ok(parsed)
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn initialization_and_audio_have_correct_headers_and_final_marker(){
  let Message::Binary(init)=initialize()else{panic!()};assert_eq!(&init[..4],&[0x11,0x10,0x10,0]);
  let size=u32::from_be_bytes(init[4..8].try_into().unwrap())as usize;assert_eq!(size,init.len()-8);let value:Value=serde_json::from_slice(&init[8..]).unwrap();assert_eq!(value["audio"]["rate"],16000);assert_eq!(value["request"]["show_utterances"],true);assert_eq!(value["request"]["enable_nonstream"],true);
  for last in [false,true]{let Message::Binary(bytes)=audio(&[1,2,3,4],last)else{panic!()};assert_eq!(bytes[1],if last{0x22}else{0x20});assert_eq!(&bytes[8..],&[1,2,3,4]);}
 }
 fn response(value:Value,gzip:bool,flags:u8)->Vec<u8>{
  use std::io::Write;let mut payload=serde_json::to_vec(&value).unwrap();if gzip{let mut encoder=flate2::write::GzEncoder::new(Vec::new(),flate2::Compression::fast());encoder.write_all(&payload).unwrap();payload=encoder.finish().unwrap();}
  let mut bytes=vec![0x11,0x90|flags,0x10|u8::from(gzip),0];if flags&1!=0{bytes.extend_from_slice(&1i32.to_be_bytes());}if flags&4!=0{bytes.extend_from_slice(&0u32.to_be_bytes());}bytes.extend_from_slice(&(payload.len()as u32).to_be_bytes());bytes.extend(payload);bytes
 }
 #[test]fn decodes_plain_gzip_partial_final_and_rejects_invalid_frames(){
  for gzip in [false,true]{for flags in [0,1,3,5]{for definite in [false,true]{let value=json!({"result":{"utterances":[{"start_time":120,"text":"请介绍项目","definite":definite}]}});let bytes=response(value,gzip,flags);let parsed=parse(&decode(&bytes).unwrap()).unwrap();assert_eq!(parsed[0].segment,"120");assert_eq!(parsed[0].final_result,definite);let mut truncated=bytes.clone();truncated.pop();assert!(decode(&truncated).is_err());}}}
  for bytes in [vec![],vec![0x11,0x90,0x10,0],vec![0x11,0xf0,0,0,2,174,165,1,0,0,0,0]]{assert!(decode(&bytes).is_err());}
 }
 #[test]fn credentials_are_headers_never_query_parameters_and_required(){
  let mut p=crate::types::Settings::default().providers.remove(0);p.kind="volcengine".into();p.base_url="wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async".into();p.model="volc.seedasr.sauc.duration".into();let key=Secret{api_key:"synthetic-volc-key".into(),secret_key:String::new()};let h=headers(&p,&key).unwrap();assert_eq!(h[0].1,key.api_key);assert!(h.iter().any(|(k,v)|*k=="x-api-resource-id"&&v==&p.model));assert!(!p.base_url.contains(&key.api_key));assert!(headers(&p,&Secret::default()).is_err());p.model.clear();assert!(headers(&p,&key).is_err());
 }
}
