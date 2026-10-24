use serde::{Deserialize, Serialize};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub app_id: String,
    pub secret_id: String,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    pub screen: String,
    pub manual: String,
    pub answer: String,
    pub cancel: String,
    pub toggle: String,
}

impl<'de> Deserialize<'de> for Shortcuts {
    fn deserialize<D:serde::Deserializer<'de>>(deserializer:D)->Result<Self,D::Error>{
        #[derive(Deserialize)]
        struct Stored {
            #[serde(default="default_screen_shortcut")] screen:String,
            manual:Option<String>,answer:String,cancel:String,toggle:String,
        }
        let value=Stored::deserialize(deserializer)?;
        let manual=value.manual.unwrap_or_else(||{
            let default="Ctrl+Shift+M";
            let parsed=default.parse::<tauri_plugin_global_shortcut::Shortcut>().ok();
            if [&value.answer,&value.cancel,&value.toggle,&value.screen].iter().any(|key|!key.is_empty()&&key.parse::<tauri_plugin_global_shortcut::Shortcut>().ok()==parsed){String::new()}else{default.into()}
        });
        Ok(Self{screen:value.screen,manual,answer:value.answer,cancel:value.cancel,toggle:value.toggle})
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub mode: String,
    pub url: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default="default_language")] pub language:String,
    #[serde(default="default_theme")] pub theme:String,
    #[serde(default="default_close_action")] pub close_action:String,
    #[serde(default)]
    pub screen_capture: ScreenPreferences,
    #[serde(default = "default_capture_protection")]
    pub capture_protection: bool,
    pub asr_provider: String,
    #[serde(default = "default_ocr_provider")]
    pub ocr_provider: String,
    pub active_model: String,
    #[serde(default)] pub screenshot_model: String,
    pub providers: Vec<Provider>,
    pub network: Network,
    pub shortcuts: Shortcuts,
    pub job: String,
    pub silence_ms: u64,
    pub font_size: u32,
    #[serde(default="default_answer_opacity",deserialize_with="read_answer_opacity")] pub answer_opacity:u32,
    #[serde(default="default_answer_words")] pub answer_words:u32,
    #[serde(default)] pub shortcut_preset_version:u32,
}
fn default_language()->String {"system".into()}
fn default_theme()->String {"light".into()}
fn default_close_action()->String {"tray".into()}
fn default_answer_opacity()->u32 {60}
fn read_answer_opacity<'de,D:serde::Deserializer<'de>>(d:D)->Result<u32,D::Error>{Ok(u32::deserialize(d)?.max(20))}
fn default_answer_words()->u32 {200}
fn default_ocr_provider()->String { "local".into() }
fn default_capture_protection() -> bool { true }
fn default_screen_shortcut() -> String { "Ctrl+Shift+S".into() }
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all="camelCase")]
pub struct ScreenPreferences {
    #[serde(default)] pub confirm_before_answer: bool,
    #[serde(default)] pub shift_double_click: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            language:default_language(),theme:default_theme(),close_action:default_close_action(),
            capture_protection: true,
            screen_capture: ScreenPreferences::default(),
            asr_provider: "xfyun".into(),
            ocr_provider: default_ocr_provider(),
            active_model: "deepseek".into(),
            screenshot_model: String::new(),
            job: "软件开发工程师".into(),
            silence_ms: 700,
            font_size: 14,
            answer_opacity:default_answer_opacity(),
            answer_words:default_answer_words(),
            shortcut_preset_version:1,
            providers: vec![
                Provider {
                    id: "xfyun".into(),
                    name: "讯飞 RTasr".into(),
                    kind: "xfyun".into(),
                    base_url: "wss://rtasr.xfyun.cn/v1/ws".into(),
                    model: String::new(),
                    app_id: String::new(),
                    secret_id: String::new(),
                },
                Provider {
                    id: "tencent".into(),
                    name: "腾讯云实时语音识别".into(),
                    kind: "tencent".into(),
                    base_url: "wss://asr.cloud.tencent.com/asr/v2".into(),
                    model: "16k_zh".into(),
                    app_id: String::new(),
                    secret_id: String::new(),
                },
                Provider {
                    id: "deepseek".into(),
                    name: "DeepSeek".into(),
                    kind: "llm".into(),
                    base_url: "https://api.deepseek.com".into(),
                    model: "deepseek-flash".into(),
                    app_id: String::new(),
                    secret_id: String::new(),
                },
            ],
            network: Network {
                mode: "system".into(),
                url: String::new(),
            },
            shortcuts: Shortcuts {
                answer: "Ctrl+Enter".into(),
                screen: default_screen_shortcut(),
                manual: "Ctrl+Shift+M".into(),
                cancel: "Ctrl+Shift+X".into(),
                toggle: "Ctrl+Shift+H".into(),
            },
        }
    }
}
impl Settings {
    /// Seed only a genuinely new profile. Never replace loaded/recovered vendor choices.
    pub fn for_first_run()->Self {
        let mut settings=Self::default();
        let provider=|id:&str,name:&str,kind:&str,base_url:&str,model:&str|Provider{id:id.into(),name:name.into(),kind:kind.into(),base_url:base_url.into(),model:model.into(),app_id:String::new(),secret_id:String::new()};
        settings.providers.insert(0,provider("qwen","通义千问","llm","https://dashscope.aliyuncs.com/compatible-mode/v1","qwen-plus"));
        settings.providers.insert(1,provider("dashscope","阿里云 Paraformer","dashscope","wss://dashscope.aliyuncs.com/api-ws/v1/inference","paraformer-realtime-v2"));
        settings.active_model="qwen".into();settings.asr_provider="dashscope".into();settings
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub api_key: String,
    pub secret_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretUpdate {
    pub id: String,
    pub secret: Secret,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    #[serde(default,skip_serializing_if="Option::is_none")] pub process_capture_supported:Option<bool>,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub pid: Option<u32>,
    pub recommended: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    pub source: AudioSource,
    pub microphone: bool,
    pub title: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub id: String,
    pub session_id: String,
    pub source: String,
    pub segment_id: String,
    pub text: String,
    pub is_final: bool,
    pub at: i64,
    pub speech_end_at: i64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<MaterialSource>,
    pub id: String,
    pub session_id: String,
    pub question_id: String,
    pub revision: u32,
    pub question: String,
    pub text: String,
    pub status: String,
    pub mode: String,
    pub created_at: i64,
    pub speech_end_at: i64,
    pub trigger_at: i64,
    pub request_at: i64,
    pub first_token_ms: Option<i64>,
    pub first_sentence_ms: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub ended_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaterialSource {
    pub material_id: String,
    pub title: String,
    pub kind: String,
    pub excerpt: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub text: String,
    pub enabled: bool,
    pub updated_at: i64,
}

#[cfg(test)]mod background_opacity_tests{
 use super::*;
 #[test]fn old_nearly_invisible_preferences_are_limited_without_changing_readable_values(){
  for (old,expected)in [(0,20),(10,20),(20,20),(60,60),(100,100)]{let mut value=serde_json::to_value(Settings::default()).unwrap();value["answerOpacity"]=old.into();let decoded:Settings=serde_json::from_value(value).unwrap();assert_eq!(decoded.answer_opacity,expected);}
 }
}
