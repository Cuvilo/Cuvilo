use crate::{llm, network, provider_check::CheckConfig};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, time::Duration};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: Option<String>,
    pub vision: Option<bool>,
}
fn endpoint(base: &str) -> Result<String> {
    let completion = llm::endpoint(base)?;
    Ok(format!(
        "{}/models",
        completion.trim_end_matches("/chat/completions")
    ))
}
fn parse(value: Value, vision_only: bool) -> Result<Vec<Model>> {
    let values = value
        .get("data")
        .and_then(Value::as_array)
        .context("此接口未返回模型列表，可直接输入模型名称")?;
    anyhow::ensure!(values.len() <= 10000, "模型列表过大，请直接输入模型名称");
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for item in values {
        let Some(id) = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control))
        else {
            continue;
        };
        let vision = item
            .get("input_modalities")
            .and_then(Value::as_array)
            .or_else(|| {
                item.pointer("/architecture/input_modalities")
                    .and_then(Value::as_array)
            })
            .map(|modalities| modalities.iter().any(|m| m.as_str() == Some("image")));
        if vision_only && vision == Some(false) {
            continue;
        }
        if !seen.insert(id.to_string()) {
            continue;
        }
        models.push(Model {
            id: id.into(),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 256 && !s.chars().any(char::is_control))
                .map(str::to_string),
            vision,
        });
    }
    models.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    Ok(models)
}
pub async fn fetch(config: &CheckConfig) -> Result<Vec<Model>> {
    anyhow::ensure!(
        ["llm", "ocr"].contains(&config.provider.kind.as_str()),
        "此服务不支持获取模型"
    );
    anyhow::ensure!(!config.secret.api_key.trim().is_empty(), "请先填写 API Key");
    let url = endpoint(&config.provider.base_url)?;
    // Use the same proxy policy as answers. Never echo a remote error body or URL containing credentials.
    let result: Result<Vec<Model>> = async {
        let mut response = network::client(&config.network)?
            .get(url)
            .bearer_auth(config.secret.api_key.trim())
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("获取模型失败，请检查网络与接口地址"))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            bail!(match status {
                401 | 403 => "密钥无效或没有权限，请检查 API Key".to_string(),
                404 | 405 => "此接口不支持获取模型，可直接输入模型名称".to_string(),
                _ => format!("获取模型失败（HTTP {status}），可重试或直接输入"),
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("读取模型列表失败，请重试"))?
        {
            anyhow::ensure!(
                bytes.len() + chunk.len() <= 4 * 1024 * 1024,
                "模型列表过大，请直接输入模型名称"
            );
            bytes.extend_from_slice(&chunk);
        }
        parse(
            serde_json::from_slice(&bytes).context("此接口未返回有效的模型列表")?,
            config.provider.kind == "ocr",
        )
    }
    .await;
    result.map_err(|e| anyhow::anyhow!(crate::secrets::redact(&e.to_string(), &config.secret)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_keep_gateway_prefix_and_validate_scheme() {
        assert_eq!(
            endpoint("https://fixture.invalid/v1/").unwrap(),
            "https://fixture.invalid/v1/models"
        );
        assert_eq!(
            endpoint("https://fixture.invalid/proxy/chat/completions").unwrap(),
            "https://fixture.invalid/proxy/models"
        );
        assert_eq!(
            endpoint("https://fixture.invalid").unwrap(),
            "https://fixture.invalid/models"
        );
        assert!(endpoint("http://cloud.invalid/v1").is_err());
        assert!(endpoint("https://fixture.invalid/v1?key=x").is_err());
    }
    #[test]
    fn catalog_deduplicates_and_filters_only_declared_nonvision() {
        let value = serde_json::json!({"data":[{"id":"text","input_modalities":["text"]},{"id":"vision","input_modalities":["text","image"]},{"id":"unknown"},{"id":"unknown"},{"id":" "},{"id":"bad\nname"}]});
        assert_eq!(parse(value.clone(), false).unwrap().len(), 3);
        let ocr = parse(value, true).unwrap();
        assert_eq!(
            ocr.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["unknown", "vision"]
        );
        assert_eq!(ocr[0].vision, None);
        assert!(parse(serde_json::json!({"models":[]}), false).is_err());
    }
    #[tokio::test]
    async fn remote_failures_are_local_and_never_echo_response_secrets() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        for status in [401, 404, 429] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 4096];
                socket.read(&mut bytes).await.unwrap();
                let body = r#"{"error":{"message":"fixture-private-key"}}"#;
                socket.write_all(format!("HTTP/1.1 {status} Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
            });
            let mut provider = crate::types::Settings::default().providers[2].clone();
            provider.base_url = format!("http://{address}/v1");
            let config = CheckConfig {
                provider,
                secret: crate::types::Secret {
                    api_key: "fixture-private-key".into(),
                    secret_key: String::new(),
                },
                network: crate::types::Network {
                    mode: "direct".into(),
                    url: String::new(),
                },
            };
            let error = fetch(&config).await.unwrap_err().to_string();
            assert!(!error.contains("fixture-private-key"));
            assert!(error.contains(match status {
                401 => "权限",
                404 => "直接输入",
                _ => "429",
            }));
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn uses_current_key_endpoint_and_network_without_writing_settings() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
                if request.windows(4).any(|s| s == b"\r\n\r\n") {
                    break;
                }
            }
            let body = r#"{"data":[{"id":"fixture-model"}]}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            String::from_utf8(request).unwrap()
        });
        let settings = crate::types::Settings::default();
        let mut provider = settings.providers[2].clone();
        provider.base_url = format!("http://{address}/draft/v1");
        let config = crate::provider_check::resolve(
            &settings,
            "deepseek",
            Some(provider),
            Some(crate::types::Secret {
                api_key: "fixture-current-key".into(),
                secret_key: String::new(),
            }),
            Some(crate::types::Network {
                mode: "direct".into(),
                url: String::new(),
            }),
        )
        .unwrap();
        assert_eq!(fetch(&config).await.unwrap()[0].id, "fixture-model");
        let request = server.await.unwrap();
        assert!(request.starts_with("GET /draft/v1/models "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer fixture-current-key"));
        let empty = CheckConfig {
            secret: crate::types::Secret::default(),
            ..config
        };
        assert!(fetch(&empty)
            .await
            .unwrap_err()
            .to_string()
            .contains("API Key"));
    }
}
