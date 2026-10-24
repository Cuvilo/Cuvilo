use crate::types::*;
use serde::Deserialize;
use anyhow::{ensure,Result};
#[derive(Deserialize,Default)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct PreferencesPatch{
 pub language:Option<String>,pub theme:Option<String>,pub close_action:Option<String>,pub job:Option<String>,pub silence_ms:Option<u64>,pub font_size:Option<u32>,pub answer_opacity:Option<u32>,pub answer_words:Option<u32>,pub capture_protection:Option<bool>,pub shortcuts:Option<Shortcuts>,pub network:Option<Network>,pub screen_capture:Option<ScreenPreferences>,
}
pub fn authorize_preferences(window:&str,patch:&PreferencesPatch)->std::result::Result<(),String>{
 if window=="main"{return Ok(());}
 if window=="answer"&&(patch.answer_opacity.is_some()||patch.answer_words.is_some())&&patch.language.is_none()&&patch.theme.is_none()&&patch.close_action.is_none()&&patch.job.is_none()&&patch.silence_ms.is_none()&&patch.font_size.is_none()&&patch.capture_protection.is_none()&&patch.shortcuts.is_none()&&patch.network.is_none()&&patch.screen_capture.is_none(){return Ok(());}
 Err("请在主窗口调整此设置".into())
}
impl PreferencesPatch{pub fn apply(self,mut s:Settings)->Settings{
 if let Some(value)=self.language{s.language=value;}
 if let Some(value)=self.theme{s.theme=value;}if let Some(value)=self.close_action{s.close_action=value;}
 if let Some(value)=self.job{s.job=value;}if let Some(value)=self.silence_ms{s.silence_ms=value;}if let Some(value)=self.font_size{s.font_size=value;}if let Some(value)=self.answer_opacity{s.answer_opacity=value;}if let Some(value)=self.answer_words{s.answer_words=value;}if let Some(value)=self.capture_protection{s.capture_protection=value;}if let Some(value)=self.shortcuts{s.shortcuts=value;}if let Some(value)=self.network{s.network=value;}if let Some(mut value)=self.screen_capture{value.shift_double_click=false;s.screen_capture=value;}s
}}
pub fn belongs(p:&Provider,group:&str)->bool{match group{"model"=>p.kind=="llm","ocr"=>p.kind=="ocr"||crate::cloud_ocr::supports(p),"asr"=>["xfyun","tencent","dashscope","volcengine","openai-asr"].contains(&p.kind.as_str()),_=>false}}
#[derive(Deserialize)]#[serde(deny_unknown_fields)]pub struct ServicesPatch{pub group:String,pub providers:Vec<Provider>,pub selected:String,#[serde(default,rename="screenshotModel")]pub screenshot_model:Option<String>}
impl ServicesPatch{pub fn apply(self,mut s:Settings)->Result<Settings>{
 ensure!(["model","asr","ocr"].contains(&self.group.as_str()),"未知服务分类");ensure!(self.providers.iter().all(|p|belongs(p,&self.group)),"服务分类不一致");
 ensure!(s.providers.iter().filter(|p|belongs(p,&self.group)).all(|old|self.providers.iter().any(|p|p.id==old.id)),"请使用删除服务操作移除配置");
 ensure!(self.screenshot_model.is_none()||self.group=="model","截图用途仅属于回答模型");
 ensure!(self.providers.iter().all(|p|!p.id.starts_with("custom-asr-")||s.providers.iter().find(|old|old.id==p.id).map_or(true,|old|old.kind==p.kind)),"已保存语音接口的协议不可修改，请添加新接口");
 let old=s.clone();s.providers.retain(|p|!belongs(p,&self.group));s.providers.extend(self.providers);
 match self.group.as_str(){"model"=>s.active_model=self.selected,"asr"=>s.asr_provider=self.selected,_=>s.ocr_provider=self.selected}
 if let Some(id)=self.screenshot_model{ensure!(id.is_empty()||s.providers.iter().any(|p|p.id==id&&p.kind=="llm"),"截图模型不存在");s.screenshot_model=id;}
 check_additions(&old,&s)?;Ok(s)
}}
fn identity(p:&Provider)->String{
 for (preset,vendor)in [("deepseek","deepseek"),("qwen","qwen"),("siliconflow","siliconflow")]{if (p.kind=="llm"||p.kind=="ocr")&&(p.id==preset||p.id.starts_with(&format!("{preset}-"))){return format!("{}:{vendor}",p.kind);}}

 if ["xfyun","tencent","dashscope","volcengine","openai-asr"].contains(&p.kind.as_str()){return p.kind.clone();}
 let host=url::Url::parse(&p.base_url).ok().map(|u|{let host=u.host_str().unwrap_or("");if host=="api.deepseek.com"{"deepseek".into()}else if host=="dashscope.aliyuncs.com"||host.ends_with(".maas.aliyuncs.com"){"qwen".into()}else if ["api.siliconflow.cn","api.siliconflow.com"].contains(&host){"siliconflow".into()}else{format!("{}{}",u.origin().ascii_serialization(),u.path().trim_end_matches('/'))}}).unwrap_or_default();format!("{}:{host}",p.kind)
}
fn custom_channel(p:&Provider)->bool{
 ((p.kind=="llm"||p.kind=="ocr")&&(p.id=="compatible"||p.id.starts_with("compatible-")))||(belongs(p,"asr")&&(p.id.starts_with("custom-asr-")||p.id.starts_with("openai-asr-")))
}
fn check_additions(old:&Settings,next:&Settings)->Result<()>{
 let mut counts=std::collections::HashMap::<String,usize>::new();for p in &next.providers{if custom_channel(p){continue;}*counts.entry(identity(p)).or_default()+=1;}
 for (key,count)in counts{let before=old.providers.iter().filter(|p|!custom_channel(p)&&identity(p)==key).count();ensure!(count<=before.max(1),"此厂商已添加，请使用已有服务");}Ok(())
}
pub fn remove(mut s:Settings,id:&str)->Result<Settings>{
 ensure!(s.providers.iter().any(|p|p.id==id),"服务不存在");s.providers.retain(|p|p.id!=id);
 if s.active_model==id{s.active_model=s.providers.iter().find(|p|p.kind=="llm").map(|p|p.id.clone()).unwrap_or_default();}
 if s.asr_provider==id{s.asr_provider=s.providers.iter().find(|p|belongs(p,"asr")).map(|p|p.id.clone()).unwrap_or_default();}
 if s.screenshot_model==id{s.screenshot_model.clear();}
 if s.ocr_provider==id{s.ocr_provider="local".into();}Ok(s)
}
pub fn migrate_shortcut(s:&mut Settings)->bool{
 if s.shortcut_preset_version!=0{return false;}
 if s.shortcuts.toggle=="Ctrl+Backslash"&&![&s.shortcuts.answer,&s.shortcuts.cancel,&s.shortcuts.screen,&s.shortcuts.manual].iter().any(|v|v.eq_ignore_ascii_case("Ctrl+Shift+H")){s.shortcuts.toggle="Ctrl+Shift+H".into();}
 s.shortcut_preset_version=1;true
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn answer_window_may_only_save_opacity(){let mut p=PreferencesPatch{answer_opacity:Some(75),..Default::default()};assert!(authorize_preferences("answer",&p).is_ok());assert!(authorize_preferences("main",&p).is_ok());assert!(authorize_preferences("unknown",&p).is_err());p.job=Some("forbidden".into());assert!(authorize_preferences("answer",&p).is_err());assert!(authorize_preferences("answer",&PreferencesPatch::default()).is_err());assert!(authorize_preferences("answer",&PreferencesPatch{answer_opacity:Some(80),theme:Some("dark".into()),..Default::default()}).is_err());}

 #[test]fn preferences_cannot_deserialize_services_or_modify_them(){assert!(serde_json::from_value::<PreferencesPatch>(serde_json::json!({"providers":[]})).is_err());let old=Settings::default();let changed=PreferencesPatch{font_size:Some(20),..Default::default()}.apply(old.clone());assert_eq!(serde_json::to_value(old.providers).unwrap(),serde_json::to_value(changed.providers).unwrap());assert_eq!(changed.font_size,20);}
 #[test]fn per_group_service_save_preserves_newer_preferences_and_other_services(){let mut old=Settings::default();old.font_size=22;old.answer_opacity=75;old.theme="dark".into();old.close_action="quit".into();let mut provider=old.providers[2].clone();provider.model="edited".into();let updated=ServicesPatch{group:"model".into(),providers:vec![provider],selected:"deepseek".into(),screenshot_model:None}.apply(old).unwrap();assert_eq!((updated.font_size,updated.answer_opacity),(22,75));assert_eq!((&updated.theme[..],&updated.close_action[..]),("dark","quit"));assert_eq!(updated.asr_provider,"xfyun");}
 #[test]fn duplicate_vendor_is_rejected_and_removing_last_service_keeps_other_groups(){let old=Settings::default();let mut duplicate=old.providers[2].clone();duplicate.id="other".into();let mut providers=vec![old.providers[2].clone()];providers.push(duplicate);assert!(ServicesPatch{group:"model".into(),providers,selected:"deepseek".into(),screenshot_model:None}.apply(old.clone()).is_err());let next=remove(old,"deepseek").unwrap();assert!(next.active_model.is_empty());assert_eq!(next.asr_provider,"xfyun");assert_eq!(next.ocr_provider,"local");}
 #[test]fn only_previous_builtin_shortcut_migrates_once(){let mut s=Settings::default();s.shortcut_preset_version=0;s.shortcuts.toggle="Ctrl+Backslash".into();assert!(migrate_shortcut(&mut s));assert_eq!(s.shortcuts.toggle,"Ctrl+Shift+H");s.shortcuts.toggle="Ctrl+Backslash".into();assert!(!migrate_shortcut(&mut s));assert_eq!(s.shortcuts.toggle,"Ctrl+Backslash");s.shortcut_preset_version=0;s.shortcuts.toggle="Ctrl+Alt+Z".into();migrate_shortcut(&mut s);assert_eq!(s.shortcuts.toggle,"Ctrl+Alt+Z");}
}

#[cfg(test)]mod screenshot_tests{
 use super::*;
 #[test]fn legacy_defaults_off_and_only_model_service_saves_can_assign_one_llm(){
  let mut value=serde_json::to_value(Settings::default()).unwrap();value.as_object_mut().unwrap().remove("screenshotModel");let old:Settings=serde_json::from_value(value).unwrap();assert!(old.screenshot_model.is_empty());
  let patch:ServicesPatch=serde_json::from_value(serde_json::json!({"group":"model","providers":old.providers.iter().filter(|p|p.kind=="llm").collect::<Vec<_>>(),"selected":"deepseek","screenshotModel":"deepseek"})).unwrap();
  let enabled=patch.apply(old.clone()).unwrap();assert_eq!(enabled.screenshot_model,"deepseek");assert!(remove(enabled,"deepseek").unwrap().screenshot_model.is_empty());
  let patch:ServicesPatch=serde_json::from_value(serde_json::json!({"group":"asr","providers":old.providers.iter().filter(|p|belongs(p,"asr")).collect::<Vec<_>>(),"selected":"xfyun","screenshotModel":"deepseek"})).unwrap();assert!(patch.apply(old.clone()).is_err());
  let patch:ServicesPatch=serde_json::from_value(serde_json::json!({"group":"model","providers":old.providers.iter().filter(|p|p.kind=="llm").collect::<Vec<_>>(),"selected":"deepseek","screenshotModel":"xfyun"})).unwrap();assert!(patch.apply(old).is_err());
 }
}

#[cfg(test)]mod answer_words_tests{
 use super::*;
 #[test]fn answer_window_can_only_change_its_opacity_and_word_target(){let patch:PreferencesPatch=serde_json::from_value(serde_json::json!({"answerWords":500,"answerOpacity":0})).unwrap();assert!(authorize_preferences("answer",&patch).is_ok());let updated=patch.apply(Settings::default());assert_eq!((updated.answer_words,updated.answer_opacity),(500,0));let patch:PreferencesPatch=serde_json::from_value(serde_json::json!({"answerWords":500,"job":"forbidden"})).unwrap();assert!(authorize_preferences("answer",&patch).is_err());}
 #[test]fn new_defaults_do_not_overwrite_saved_opacity_or_word_choices(){let mut value=serde_json::to_value(Settings::default()).unwrap();assert_eq!((value["answerOpacity"].as_u64(),value["answerWords"].as_u64()),(Some(60),Some(200)));value["answerOpacity"]=serde_json::json!(100);value["answerWords"]=serde_json::json!(800);let saved:Settings=serde_json::from_value(value.clone()).unwrap();assert_eq!((saved.answer_opacity,saved.answer_words),(100,800));value.as_object_mut().unwrap().remove("answerWords");value.as_object_mut().unwrap().remove("answerOpacity");let defaults:Settings=serde_json::from_value(value).unwrap();assert_eq!((defaults.answer_opacity,defaults.answer_words),(60,200));}
}

#[cfg(test)]mod custom_provider_tests{
 use super::*;
 #[test]fn several_custom_channels_can_share_an_endpoint_with_independent_ids(){
  let old=Settings::default();let mut providers=vec![old.providers[2].clone()];
  for index in 1..=4{let mut p=old.providers[2].clone();p.id=format!("compatible-fixture-{index}");p.name=format!("custom {index}");providers.push(p);}
  let next=ServicesPatch{group:"model".into(),providers,selected:"compatible-fixture-2".into(),screenshot_model:Some("compatible-fixture-3".into())}.apply(old).unwrap();
  assert_eq!(next.providers.iter().filter(|p|p.kind=="llm").count(),5);let removed=remove(next,"compatible-fixture-2").unwrap();assert!(removed.providers.iter().any(|p|p.id=="compatible-fixture-3"));assert_eq!(removed.screenshot_model,"compatible-fixture-3");
 }
}

#[cfg(test)]mod custom_asr_tests{
 use super::*;
 #[test]fn custom_asr_channels_share_protocols_without_merging_builtin_credentials(){
  let old=Settings::default();let mut providers=old.providers.iter().filter(|p|belongs(p,"asr")).cloned().collect::<Vec<_>>();
  for index in 1..=3{let mut p=providers[0].clone();p.id=format!("custom-asr-fixture-{index}");p.name=format!("custom voice {index}");providers.push(p);}
  let next=ServicesPatch{group:"asr".into(),providers,selected:"custom-asr-fixture-2".into(),screenshot_model:None}.apply(old).unwrap();
  assert_eq!(next.providers.iter().filter(|p|belongs(p,"asr")).count(),5);assert_eq!(next.asr_provider,"custom-asr-fixture-2");
  let mut providers=next.providers.iter().filter(|p|belongs(p,"asr")).cloned().collect::<Vec<_>>();providers.iter_mut().find(|p|p.id=="custom-asr-fixture-2").unwrap().kind="tencent".into();
  assert!(ServicesPatch{group:"asr".into(),providers,selected:next.asr_provider.clone(),screenshot_model:None}.apply(next).is_err());
 }
}

#[cfg(test)]mod openai_channel_tests{
 use super::*;
 #[test]fn independent_openai_channels_save_select_and_remove_without_changing_legacy_voice(){
  let old=Settings::default();let legacy=old.asr_provider.clone();let mut providers=old.providers.iter().filter(|p|belongs(p,"asr")).cloned().collect::<Vec<_>>();
  for index in 1..=3{providers.push(Provider{id:format!("openai-asr-fixture-{index}"),name:format!("OpenAI {index}"),kind:"openai-asr".into(),base_url:"https://api.openai.com/v1".into(),model:"gpt-transcribe".into(),app_id:String::new(),secret_id:String::new()});}
  let next=ServicesPatch{group:"asr".into(),providers,selected:"openai-asr-fixture-2".into(),screenshot_model:None}.apply(old.clone()).unwrap();assert_eq!(next.asr_provider,"openai-asr-fixture-2");let next=remove(next,"openai-asr-fixture-2").unwrap();assert!(next.providers.iter().any(|p|p.id==legacy));assert!(next.providers.iter().any(|p|p.id=="openai-asr-fixture-3"));assert_eq!(next.active_model,old.active_model);
 }
}

#[cfg(test)]
mod language_tests {
    use super::*;
    #[test]
    fn old_settings_follow_system_and_language_patch_keeps_other_data() {
        let original=Settings::default();
        let mut stored=serde_json::to_value(&original).unwrap();stored.as_object_mut().unwrap().remove("language");
        let restored:Settings=serde_json::from_value(stored).unwrap();assert_eq!(restored.language,"system");
        let patch:PreferencesPatch=serde_json::from_value(serde_json::json!({"language":"en"})).unwrap();
        assert!(authorize_preferences("main",&patch).is_ok());assert!(authorize_preferences("answer",&patch).is_err());
        let updated=patch.apply(restored);assert_eq!(updated.language,"en");assert_eq!(updated.job,original.job);
        assert_eq!(serde_json::to_value(updated.providers).unwrap(),serde_json::to_value(original.providers).unwrap());
        assert_eq!(updated.asr_provider,original.asr_provider);
    }
}
