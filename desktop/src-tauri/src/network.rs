use crate::types::Network;
use anyhow::{bail, Context, Result};
use std::time::Duration;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};
use url::Url;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};
pub trait SocketIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> SocketIo for T {}
pub type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<Box<dyn SocketIo>>>;
pub fn system_proxy() -> Option<String> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    if key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 0 {
        return None;
    }
    let raw = key.get_value::<String, _>("ProxyServer").ok()?;
    let value = if raw.contains('=') {
        raw.split(';')
            .find_map(|s| s.strip_prefix("https="))
            .or_else(|| raw.split(';').find_map(|s| s.strip_prefix("http=")))?
            .to_string()
    } else {
        raw
    };
    Some(if value.contains("://") {
        value
    } else {
        format!("http://{value}")
    })
}
pub fn client(n: &Network) -> Result<reqwest::Client> { client_with_redirects(n,true) }
pub fn client_no_redirects(n: &Network) -> Result<reqwest::Client> { client_with_redirects(n,false) }
fn client_with_redirects(n: &Network,follow_redirects:bool) -> Result<reqwest::Client> {
    static CLIENTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, reqwest::Client>>,
    > = std::sync::OnceLock::new();
    let key = format!(
        "{}:{}:{}:{}",
        follow_redirects,
        n.mode,
        n.url,
        system_proxy().unwrap_or_default()
    );
    let cache = CLIENTS.get_or_init(Default::default);
    if let Some(client) = cache.lock().unwrap().get(&key) {
        return Ok(client.clone());
    }
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(120));
    if !follow_redirects { builder=builder.redirect(reqwest::redirect::Policy::none()); }
    match n.mode.as_str() {
        "direct" => builder = builder.no_proxy(),
        "manual" => {
            builder = builder.proxy(reqwest::Proxy::all(&n.url).context("代理地址格式不正确")?)
        }
        _ => {}
    }
    let client = builder.build()?;
    let mut clients = cache.lock().unwrap();
    if clients.len() >= 4 {
        clients.clear();
    }
    clients.insert(key, client.clone());
    Ok(client)
}
pub async fn websocket(address: &str, n: &Network) -> Result<Ws> {
    websocket_authorized(address,n,None).await
}
pub async fn websocket_authorized(address:&str,n:&Network,bearer:Option<&str>)->Result<Ws>{
    let headers=bearer.map(|key|vec![("authorization",format!("Bearer {}",key.trim()))]).unwrap_or_default();
    websocket_headers(address,n,&headers).await
}
pub async fn websocket_headers(address:&str,n:&Network,headers:&[(&str,String)])->Result<Ws>{
    let url = Url::parse(address)?;
    if url.scheme() != "wss" {
        bail!("语音接口必须使用 wss:// 地址")
    };
    let host = url.host_str().context("语音服务地址缺少域名")?;
    let port = url.port_or_known_default().unwrap_or(443);
    let proxy = match n.mode.as_str() {
        "manual" => Some(n.url.clone()),
        "direct" => None,
        _ => system_proxy(),
    };
    let stream: Box<dyn SocketIo> = if let Some(proxy) = proxy {
        let p = Url::parse(&proxy).context("代理地址错误")?;
        if p.scheme() != "http" {
            bail!("语音连接请使用 HTTP 代理，例如 http://127.0.0.1:7890")
        }
        let mut tcp = TcpStream::connect((
            p.host_str().context("代理缺少主机")?,
            p.port_or_known_default().unwrap_or(80),
        ))
        .await?;
        let mut auth = String::new();
        if !p.username().is_empty() {
            use base64::Engine;
            auth = format!(
                "Proxy-Authorization: Basic {}\r\n",
                base64::engine::general_purpose::STANDARD.encode(format!(
                    "{}:{}",
                    p.username(),
                    p.password().unwrap_or("")
                ))
            );
        }
        tcp.write_all(
            format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth}\r\n")
                .as_bytes(),
        )
        .await?;
        let mut response = Vec::new();
        while !response.ends_with(b"\r\n\r\n") {
            let mut b = [0];
            if tcp.read(&mut b).await? == 0 {
                bail!("代理连接提前关闭")
            };
            response.push(b[0]);
            if response.len() > 8192 {
                bail!("代理响应异常")
            }
        }
        if !String::from_utf8_lossy(&response)
            .lines()
            .next()
            .unwrap_or("")
            .contains(" 200 ")
        {
            bail!("代理拒绝了语音服务连接，请检查代理设置")
        }
        Box::new(tcp)
    } else {
        Box::new(TcpStream::connect((host, port)).await?)
    };
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest,http::{HeaderName,HeaderValue}};
    let mut request=address.into_client_request()?;
    for (name,value) in headers{let mut value=HeaderValue::from_str(value).context("鉴权参数格式无效")?;value.set_sensitive(true);request.headers_mut().insert(HeaderName::from_bytes(name.as_bytes()).context("鉴权参数格式无效")?,value);}
    let (ws, _) = tokio_tungstenite::client_async_tls_with_config(request, stream, None, None).await?;
    Ok(ws)
}
