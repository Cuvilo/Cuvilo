//! Explicit user-clicked links. Never open an endpoint supplied by a provider.
pub fn destination(help:&str)->Option<&'static str>{match help{
 "openai"=>Some("https://platform.openai.com/api-keys"),
 "youdao"=>Some("https://ai.youdao.com/DOCSIRMA/html/ocr/api/tyocr/index.html"),
 "ocr-space"=>Some("https://ocr.space/ocrapi"),
 "deepseek"=>Some("https://platform.deepseek.com/api_keys"),
 "xfyun"=>Some("https://www.xfyun.cn/doc/asr/rtasr/API.html"),
 "qwen"=>Some("https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key"),
 "siliconflow"=>Some("https://cloud.siliconflow.cn/account/ak"),
 "volcengine"=>Some("https://console.volcengine.com/speech/new/setting/apikeys?projectName=default"),
 "tencent"=>Some("https://console.cloud.tencent.com/cam/capi"),
 _=>None,
}}
pub fn open(help:&str)->Result<(),String>{
 let url=destination(help).ok_or("没有此服务的官方帮助入口")?;
 let target:Vec<u16>=url.encode_utf16().chain(Some(0)).collect();
 let result=unsafe{windows::Win32::UI::Shell::ShellExecuteW(None,windows::core::w!("open"),windows::core::PCWSTR(target.as_ptr()),None,None,windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL)};
 if result.0 as isize>32{Ok(())}else{Err("无法打开浏览器，请稍后重试".into())}
}
#[cfg(test)]mod tests{use super::*;#[test]fn only_known_official_help_destinations_are_accepted(){for name in ["deepseek","xfyun","qwen","siliconflow","tencent","volcengine","youdao","ocr-space"]{assert!(destination(name).unwrap().starts_with("https://"));}for name in ["https://evil.invalid","file:///x","cmd.exe",""]{assert!(destination(name).is_none());}}}
