use crate::{asr, llm, secrets, types::*};
use anyhow::{Context, Result};
pub struct CheckConfig {
    pub provider: Provider,
    pub secret: Secret,
    pub network: Network,
}
pub fn resolve(
    saved: &Settings,
    id: &str,
    provider: Option<Provider>,
    secret: Option<Secret>,
    network: Option<Network>,
) -> Result<CheckConfig> {
    let provider = match provider {
        Some(provider) => provider,
        None => saved
            .providers
            .iter()
            .find(|p| p.id == id)
            .context("服务不存在")?
            .clone(),
    };
    anyhow::ensure!(provider.id == id, "检测服务 ID 不一致");
    anyhow::ensure!(
        ["llm", "xfyun", "tencent", "dashscope", "volcengine", "openai-asr", "ocr", "youdao-ocr", "ocr-space", "youdao-free"].contains(&provider.kind.as_str()),
        "不支持的服务类型"
    );
    // Some(empty) is an explicitly cleared input. It must never silently reuse a saved key.
    let secret = match secret {
        Some(secret) => secret,
        None if provider.kind==crate::cloud_ocr::YOUDAO_FREE_ID => Secret::default(),
        None => secrets::read(id)?,
    };
    Ok(CheckConfig {
        provider,
        secret,
        network: network.unwrap_or_else(|| saved.network.clone()),
    })
}
pub async fn test(config: &CheckConfig) -> Result<String> {
    let started = now_ms();
    let result = if config.provider.kind == "llm" {
        llm::test(&config.provider, &config.secret, &config.network).await
    } else if crate::settings_actions::belongs(&config.provider,"ocr") {
        crate::remote_ocr::test(&config.provider,&config.secret,&config.network).await
    } else {
        asr::test(&config.provider, &config.secret, &config.network).await
    };
    result
        .map_err(|error| anyhow::anyhow!(secrets::redact(&format!("{error:#}"), &config.secret)))?;
    Ok(format!("连接成功 · {} ms", now_ms() - started))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_values_override_saved_provider_and_key() {
        let saved = Settings::default();
        let mut provider = saved.providers[2].clone();
        provider.base_url = "https://fixture.invalid/custom/v1".into();
        provider.model = "current-model".into();
        let config = resolve(
            &saved,
            "deepseek",
            Some(provider),
            Some(Secret {
                api_key: "new-fixture-key".into(),
                secret_key: String::new(),
            }),
            Some(Network {
                mode: "direct".into(),
                url: String::new(),
            }),
        )
        .unwrap();
        assert_eq!(config.secret.api_key, "new-fixture-key");
        assert_eq!(config.provider.model, "current-model");
        assert_eq!(
            config.provider.base_url,
            "https://fixture.invalid/custom/v1"
        );
        assert_eq!(config.network.mode, "direct");
    }
    #[tokio::test]
    async fn explicitly_empty_key_cannot_fall_back_to_a_saved_key() {
        let saved = Settings::default();
        let config = resolve(
            &saved,
            "deepseek",
            Some(saved.providers[2].clone()),
            Some(Secret::default()),
            None,
        )
        .unwrap();
        assert!(test(&config)
            .await
            .unwrap_err()
            .to_string()
            .contains("请填写模型 API Key"));
    }
    #[tokio::test]
    async fn authentication_header_and_request_use_the_current_inputs() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
                if let Some(pos) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&request[..pos]);
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if request.len() >= pos + 4 + length {
                        break;
                    }
                }
            }
            let body = r#"{"choices":[{"message":{"content":"OK"}}]}"#;
            let reply=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        let saved = Settings::default();
        let mut provider = saved.providers[2].clone();
        provider.base_url = format!("http://{address}/current/v1");
        provider.model = "current-model".into();
        let config = resolve(
            &saved,
            "deepseek",
            Some(provider),
            Some(Secret {
                api_key: "new-fixture-key".into(),
                secret_key: String::new(),
            }),
            Some(Network {
                mode: "direct".into(),
                url: String::new(),
            }),
        )
        .unwrap();
        test(&config).await.unwrap();
        let request = server.await.unwrap();
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer new-fixture-key"));
        assert!(request.contains("POST /current/v1/chat/completions"));
        assert!(request.contains("current-model"));
    }
}

pub fn configuration_warning(p:&Provider)->Option<String>{
 let mut fields=Vec::new();
 if p.base_url.trim().is_empty(){fields.push("接口地址");}
 if (p.kind=="llm"||p.kind=="ocr"||p.kind=="openai-asr")&&p.model.trim().is_empty(){fields.push("模型名称");}
 if ["xfyun","tencent"].contains(&p.kind.as_str())&&p.app_id.trim().is_empty(){fields.push("App ID");}
 if p.kind=="tencent"&&p.secret_id.trim().is_empty(){fields.push("Secret ID");}
 if p.kind=="youdao-ocr"&&p.app_id.trim().is_empty(){fields.push("应用 ID");}
 (!fields.is_empty()).then(||format!("{} 缺少{}，请在设置中补充。",p.name,fields.join("、")))
}

#[cfg(test)]mod warning_tests{
 use super::*;
 #[test]fn required_fields_follow_protocol_and_never_assume_every_service_needs_app_id(){
  let mut p=Settings::default().providers[2].clone();p.app_id.clear();
  for kind in ["llm","ocr","dashscope","volcengine","ocr-space"]{p.kind=kind.into();assert!(configuration_warning(&p).is_none());}
  for kind in ["xfyun","tencent","youdao-ocr"]{p.kind=kind.into();assert!(configuration_warning(&p).is_some());}
  p.kind="youdao-ocr".into();p.app_id="fixture app".into();assert!(configuration_warning(&p).is_none());
 }
}

#[cfg(test)]mod free_ocr_tests{
 use super::*;
 #[test]fn built_in_free_ocr_can_be_resolved_without_reading_any_saved_key(){let saved=Settings::default();let p=crate::cloud_ocr::youdao_free_provider();let config=resolve(&saved,&p.id,Some(p.clone()),None,None).unwrap();assert!(config.secret.api_key.is_empty());assert!(config.secret.secret_key.is_empty());}
}
