use crate::{network, types::*};
use anyhow::{bail, Context, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::json;
use serde_json::Value;
use sha1::Sha1;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc,
    },
};
use tokio::{
    sync::mpsc,
    time::{timeout, Duration},
};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
fn sign(text: &str, key: &str) -> Result<String> {
    let mut h = Hmac::<Sha1>::new_from_slice(key.as_bytes())?;
    h.update(text.as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(h.finalize().into_bytes()))
}
pub fn signed_url(p: &Provider, s: &Secret, ts: i64, voice: &str) -> Result<String> {
    if p.kind=="openai-asr" {anyhow::ensure!(!s.api_key.trim().is_empty(),"请填写语音 API Key");return Ok(crate::openai_asr::endpoint(p)?.to_string());}
    let mut url = url::Url::parse(&p.base_url)?;
    if p.kind=="volcengine" {crate::volcengine_asr::headers(p,s)?;return Ok(url.to_string());}
    if p.kind=="dashscope" {
        anyhow::ensure!(url.scheme()=="wss"&&url.host_str().is_some(),"语音接口必须使用 wss:// 地址");
        anyhow::ensure!(!s.api_key.trim().is_empty(),"请填写语音 API Key");
        anyhow::ensure!(!p.model.trim().is_empty(),"请填写语音模型");
        return Ok(url.to_string());
    }
    if p.app_id.trim().is_empty() {
        bail!("请填写语音服务 App ID")
    };
    if p.kind == "xfyun" {
        if s.api_key.trim().is_empty() {
            bail!("请填写讯飞 RTasr API Key")
        };
        let hash = format!("{:x}", md5::compute(format!("{}{ts}", p.app_id.trim())));
        url.query_pairs_mut()
            .append_pair("appid", p.app_id.trim())
            .append_pair("ts", &ts.to_string())
            .append_pair("signa", &sign(&hash, s.api_key.trim())?);
    } else if p.kind == "tencent" {
        if p.secret_id.trim().is_empty() || s.secret_key.trim().is_empty() {
            bail!("请填写腾讯云 SecretId 和 SecretKey")
        };
        url.set_path(&format!(
            "{}/{}",
            url.path().trim_end_matches('/'),
            p.app_id.trim()
        ));
        let params = BTreeMap::from([
            ("secretid", p.secret_id.trim().to_string()),
            ("timestamp", ts.to_string()),
            ("expired", (ts + 3600).to_string()),
            ("nonce", (ts as u64 % 1_000_000_000).to_string()),
            ("engine_model_type", p.model.clone()),
            ("voice_id", voice.into()),
            ("voice_format", "1".into()),
            ("needvad", "1".into()),
            ("filter_punc", "0".into()),
        ]);
        let query = params
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&");
        let text = format!(
            "GET{}{}?{}",
            url.host_str().context("无效语音地址")?,
            url.path(),
            query
        );
        let signature = sign(&text, s.secret_key.trim())?;
        for (k, v) in params {
            url.query_pairs_mut().append_pair(k, &v);
        }
        url.query_pairs_mut().append_pair("signature", &signature);
    } else {
        bail!("不支持的语音服务")
    };
    Ok(url.to_string())
}
pub struct Parsed {
    pub segment: String,
    pub text: String,
    pub final_result: bool,
}
pub fn parse(kind: &str, v: &Value) -> Result<Vec<Parsed>> {
    if kind=="dashscope" {
        if v["header"]["event"]=="task-failed"{bail!("阿里云语音识别失败：{}",v["header"]["error_code"].as_str().unwrap_or("请检查密钥、模型与额度"));}
        let sentence=&v["payload"]["output"]["sentence"];
        return Ok(if v["header"]["event"]=="result-generated" && sentence["heartbeat"]!=true {
            sentence["text"].as_str().map(|text|Parsed{segment:sentence["begin_time"].to_string(),text:text.into(),final_result:sentence["sentence_end"]==true}).into_iter().collect()
        }else{vec![]});
    }
    let code = v
        .get("code")
        .map(|c| {
            c.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| c.to_string())
        })
        .unwrap_or_else(|| "0".into());
    if code == "10800" {
        bail!("讯飞 10800：超过授权连接数。请关闭使用同一 App ID 的其他转写会话，等待旧连接释放后重新开始")
    }
    if code != "0" || v["action"] == "error" {
        bail!(
            "语音服务错误 {code}：{}",
            v["desc"]
                .as_str()
                .or(v["message"].as_str())
                .unwrap_or("请检查权限、额度和密钥")
        )
    }
    let mut out = Vec::new();
    if kind == "xfyun" && v["action"] == "result" {
        let data = if let Some(s) = v["data"].as_str() {
            serde_json::from_str(s)?
        } else {
            v["data"].clone()
        };
        let text = data["cn"]["st"]["rt"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|r| r["ws"].as_array().into_iter().flatten())
            .filter_map(|w| w["cw"][0]["w"].as_str())
            .collect::<String>();
        let t = &data["cn"]["st"]["type"];
        out.push(Parsed {
            segment: data["seg_id"].to_string(),
            text,
            final_result: t == "0" || t == 0,
        });
    } else if kind == "tencent" {
        if let Some(result) = v.get("result") {
            if let Some(text) = result["voice_text_str"].as_str() {
                out.push(Parsed {
                    segment: result["index"].to_string(),
                    text: text.into(),
                    final_result: result["slice_type"] == 2,
                })
            }
        }
        if let Some(sentences) = v["sentences"].as_array() {
            for s in sentences {
                out.push(Parsed {
                    segment: s["sentence_id"].to_string(),
                    text: s["sentence"].as_str().unwrap_or("").into(),
                    final_result: s["sentence_type"] == 1,
                });
            }
        }
    }
    Ok(out)
}
struct Connection {ws:network::Ws,task_id:String}
fn task_message(action:&str,id:&str,model:&str)->Message{
 let payload=if action=="run-task"{json!({"task_group":"audio","task":"asr","function":"recognition","model":model,"parameters":{"format":"pcm","sample_rate":16000,"heartbeat":true},"input":{}})}else{json!({"input":{}})};
 Message::Text(json!({"header":{"action":action,"task_id":id,"streaming":"duplex"},"payload":payload}).to_string())
}
async fn dashscope_handshake<S>(ws:&mut tokio_tungstenite::WebSocketStream<S>,task_id:&str,model:&str)->Result<()> where S:tokio::io::AsyncRead+tokio::io::AsyncWrite+Unpin{
 ws.send(task_message("run-task",task_id,model)).await?;
 timeout(Duration::from_secs(12),async{
 loop{match ws.next().await.context("语音连接已关闭")??{
  Message::Text(text)=>{let v:Value=serde_json::from_str(&text)?;parse("dashscope",&v)?;if v["header"]["event"]=="task-started"{anyhow::ensure!(v["header"]["task_id"]==task_id,"语音任务不匹配");return Ok(());}},
  Message::Ping(data)=>ws.send(Message::Pong(data)).await?,
  Message::Close(_)=>bail!("语音连接已关闭"),_=>{}
 }}
 }).await.context("阿里云语音启动超时")?
}
async fn volcengine_handshake<S>(ws:&mut tokio_tungstenite::WebSocketStream<S>)->Result<()> where S:tokio::io::AsyncRead+tokio::io::AsyncWrite+Unpin{
 ws.send(crate::volcengine_asr::initialize()).await?;
 timeout(Duration::from_secs(12),async{loop{match ws.next().await.context("语音连接已关闭")??{
  Message::Binary(bytes)=>{crate::volcengine_asr::decode(&bytes)?;return Ok(());},
  Message::Ping(bytes)=>ws.send(Message::Pong(bytes)).await?,
  Message::Close(_)=>bail!("语音连接已关闭"),_=>bail!("火山引擎没有返回有效鉴权结果")
 }}}).await.context("火山引擎语音启动超时")?
}
async fn connect(p: &Provider, s: &Secret, n: &Network) -> Result<Connection> {
    if p.kind=="volcengine"{
     let headers=crate::volcengine_asr::headers(p,s)?;
     let mut ws=timeout(Duration::from_secs(15),network::websocket_headers(&p.base_url,n,&headers)).await.context("语音连接超时")?.context("无法连接火山引擎语音，请检查网络、密钥和服务开通")?;
     volcengine_handshake(&mut ws).await?;return Ok(Connection{ws,task_id:String::new()});
    }
    if p.kind=="dashscope"{
     anyhow::ensure!(!s.api_key.trim().is_empty(),"请填写语音 API Key");
     anyhow::ensure!(!p.model.trim().is_empty(),"请填写语音模型");
     let mut ws=timeout(Duration::from_secs(15),network::websocket_authorized(&signed_url(p,s,chrono::Utc::now().timestamp(),"")?,n,Some(&s.api_key))).await.context("语音连接超时")?.context("无法连接语音服务，请检查网络或代理")?;
     let task_id=new_id();dashscope_handshake(&mut ws,&task_id,&p.model).await?;return Ok(Connection{ws,task_id});
    }
    let address = signed_url(p, s, chrono::Utc::now().timestamp(), &new_id())?;
    let mut ws = timeout(Duration::from_secs(15), network::websocket(&address, n))
        .await
        .context("语音连接超时")?
        .context("无法连接语音服务，请检查网络或代理")?;
    let first = timeout(Duration::from_secs(12), ws.next())
        .await
        .context("语音服务鉴权超时")?
        .context("语音连接关闭")??;
    if let Message::Text(text) = first {
        let v: Value = serde_json::from_str(&text)?;
        parse(&p.kind, &v)?;
        if p.kind == "xfyun" && v["action"] != "started" {
            bail!("讯飞没有确认转写会话")
        }
    } else {
        bail!("语音服务没有返回有效鉴权结果")
    }
    Ok(Connection{ws,task_id:String::new()})
}
async fn finish_connection<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>, kind: &str, task_id:&str)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    if timeout(Duration::from_millis(500), ws.send(if kind=="dashscope"{task_message("finish-task",task_id,"")}else{end_message(kind)}))
        .await
        .is_ok()
    {
        let _ = timeout(Duration::from_millis(1200), async {
            while let Some(message) = ws.next().await {
                if matches!(message, Ok(Message::Close(_)) | Err(_)) {
                    break;
                }
            }
        })
        .await;
    }
    let _ = timeout(Duration::from_millis(300), ws.close(None)).await;
}
pub async fn test(p: &Provider, s: &Secret, n: &Network) -> Result<()> {
    if p.kind=="openai-asr" {return crate::openai_asr::test(p,s,n).await;}
    let Connection{mut ws,task_id}=connect(p,s,n).await?;
    finish_connection(&mut ws,&p.kind,&task_id).await;
    Ok(())
}
struct AvailabilityGuard(Arc<AtomicBool>);
impl Drop for AvailabilityGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
struct StreamContext<'a> {
    kind: &'a str,
    task_id: &'a str,
    session: &'a str,
    source: &'a str,
    transcripts: &'a mpsc::UnboundedSender<Transcript>,
    voice: &'a AtomicI64,
    cancel: &'a CancellationToken,
}
fn end_message(kind: &str) -> Message {
    if kind=="volcengine"{return crate::volcengine_asr::audio(&[],true);}
    if kind == "xfyun" {
        Message::Binary(br#"{"end":true}"#.to_vec())
    } else {
        Message::Text("{\"type\":\"end\"}".into())
    }
}
async fn send<S>(
    ws: &mut tokio_tungstenite::WebSocketStream<S>,
    message: Message,
    cancel: &CancellationToken,
) -> Result<bool>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::select! {
        _ = cancel.cancelled() => Ok(false),
        result = timeout(Duration::from_secs(10), ws.send(message)) => {
            result.context("语音服务发送超时，请检查网络")??;
            Ok(true)
        }
    }
}
fn audio_cadence(kind: &str) -> tokio::time::Interval {
    let mut cadence = tokio::time::interval(Duration::from_millis(if ["tencent","volcengine"].contains(&kind) {
        200
    } else {
        40
    }));
    // Keep the original audio clock when Windows wakes a timer late.
    // Delay would add each late wake-up to every later packet and fill a healthy queue.
    cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    cadence
}
async fn stream_connection<S>(
    mut ws: tokio_tungstenite::WebSocketStream<S>,
    audio: &mut mpsc::Receiver<Vec<u8>>,
    context: StreamContext<'_>,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let connection_id = new_id();
    let mut packet = Vec::new();
    let packet_size = if ["tencent","volcengine"].contains(&context.kind) {
        6400
    } else {
        1280
    };
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    let mut cadence = audio_cadence(context.kind);
    let mut last_message = std::time::Instant::now();
    let mut volc_seen=std::collections::HashMap::<String,(String,bool)>::new();
    loop {
        tokio::select! {
            _ = context.cancel.cancelled() => {
                finish_connection(&mut ws, context.kind, context.task_id).await;
                return Ok(());
            },
            data = audio.recv(), if packet.len() < packet_size => {
                let Some(data) = data else { return Ok(()) };
                packet.extend(data);
            },
            _ = cadence.tick() => {
                if packet.len() >= packet_size {
                    let rest = packet.split_off(packet_size);
                    let frame = std::mem::replace(&mut packet, rest);
                    if !send(&mut ws, if context.kind=="volcengine"{crate::volcengine_asr::audio(&frame,false)}else{Message::Binary(frame)}, context.cancel).await? { return Ok(()) }
                }
            },
            _ = heartbeat.tick() => {
                if last_message.elapsed() > Duration::from_secs(60) { bail!("语音连接超过60秒没有响应，请检查网络") }
                if !send(&mut ws, Message::Ping(Vec::new()), context.cancel).await? { return Ok(()) }
            },
            data = ws.next() => {
                last_message = std::time::Instant::now();
                match data {
                    Some(Ok(Message::Binary(bytes))) if context.kind=="volcengine"=>{
                        for parsed in crate::volcengine_asr::parse(&crate::volcengine_asr::decode(&bytes)?)?{
                            if volc_seen.get(&parsed.segment).is_some_and(|(text,final_result)|*final_result||(*text==parsed.text&&*final_result==parsed.final_result)){continue;}
                            // Partial revisions share an ID; once definite, a later full result cannot duplicate it.
                            volc_seen.insert(parsed.segment.clone(),(parsed.text.clone(),parsed.final_result));
                            let segment=format!("{connection_id}-{}",parsed.segment);
                            let _=context.transcripts.send(Transcript{id:format!("{}-{segment}",context.source),session_id:context.session.into(),source:context.source.into(),segment_id:segment,text:parsed.text,is_final:parsed.final_result,at:now_ms(),speech_end_at:context.voice.load(Ordering::Relaxed)});
                        }
                    },
                    Some(Ok(Message::Text(text))) => {
                        let value: Value = serde_json::from_str(&text)?;
                        for parsed in parse(context.kind, &value)? {
                            if parsed.text.trim().is_empty() { continue }
                            let segment = format!("{connection_id}-{}", parsed.segment);
                            let _ = context.transcripts.send(Transcript {
                                id: format!("{}-{segment}", context.source),
                                session_id: context.session.into(),
                                source: context.source.into(),
                                segment_id: segment,
                                text: parsed.text,
                                is_final: parsed.final_result,
                                at: now_ms(),
                                speech_end_at: context.voice.load(Ordering::Relaxed),
                            });
                        }
                    },
                    Some(Ok(Message::Ping(data))) => { if !send(&mut ws, Message::Pong(data), context.cancel).await? { return Ok(()) } },
                    Some(Ok(Message::Close(_))) | None => bail!("语音连接已关闭"),
                    Some(Err(error)) => return Err(error.into()),
                    _ => {}
                }
            }
        }
    }
}
pub async fn run(
    p: Provider,
    s: Secret,
    n: Network,
    session: String,
    source: String,
    mut audio: mpsc::Receiver<Vec<u8>>,
    transcripts: mpsc::UnboundedSender<Transcript>,
    notices: mpsc::UnboundedSender<crate::audio::Notice>,
    voice: Arc<AtomicI64>,
    cancel: CancellationToken,
    ready: Arc<AtomicBool>,
) {
    let _availability = AvailabilityGuard(ready.clone());
    if p.kind=="openai-asr" {crate::openai_asr::run(p,s,n,session,source,audio,transcripts,notices,cancel,ready).await;return;}
    let mut last_error = String::new();
    let mut attempts = 0;
    while !cancel.is_cancelled() {
        ready.store(false, Ordering::Release);
        let connection_started = now_ms();
        let connection = tokio::select! {
            _ = cancel.cancelled() => return,
            result = connect(&p, &s, &n) => result,
        };
        match connection {
            Ok(Connection{ws,task_id}) => {
                let mut _skipped = 0;
                while audio.try_recv().is_ok() {
                    _skipped += 1;
                }
                if attempts > 0 || voice.load(Ordering::Relaxed) > connection_started {
                    let segment = new_id();
                    let _ = transcripts.send(Transcript {
                        id: format!("{source}-gap-{segment}"),
                        session_id: session.clone(),
                        source: source.clone(),
                        segment_id: segment,
                        text: "【转写缺口：语音连接期间部分声音未被识别，请重复遗漏的问题】".into(),
                        is_final: true,
                        at: now_ms(),
                        speech_end_at: voice.load(Ordering::Relaxed),
                    });
                }
                let _ = notices.send(crate::audio::Notice {
                    source: source.clone(),
                    message: format!("{}已连接", p.name),
                    error: false,
                });
                ready.store(true, Ordering::Release);
                let result = stream_connection(
                    ws,
                    &mut audio,
                    StreamContext {
                        task_id: &task_id,
                        kind: &p.kind,
                        session: &session,
                        source: &source,
                        transcripts: &transcripts,
                        voice: &voice,
                        cancel: &cancel,
                    },
                )
                .await;
                ready.store(false, Ordering::Release);
                if cancel.is_cancelled() || result.is_ok() {
                    return;
                }
                if let Err(error) = result {
                    last_error = crate::secrets::redact(&format!("{error:#}"), &s);
                    let _ = notices.send(crate::audio::Notice {
                        source: source.clone(),
                        message: crate::secrets::redact(
                            &format!("转写中断，存在文本缺口：{error:#}"),
                            &s,
                        ),
                        error: true,
                    });
                }
            }
            Err(error) => {
                let text = crate::secrets::redact(&format!("{error:#}"), &s);
                last_error = text.clone();
                let _ = notices.send(crate::audio::Notice {
                    source: source.clone(),
                    message: text.clone(),
                    error: true,
                });
                if text.contains("权限")
                    || text.contains("密钥")
                    || text.contains("10105")
                    || text.contains("10110")
                    || text.contains("额度")
                {
                    return;
                }
            }
        }
        attempts += 1;
        if attempts > 3 {
            let _ = notices.send(crate::audio::Notice {
                source: source.clone(),
                message: format!("转写已停止：{last_error}。请处理上述原因后重新开始"),
                error: true,
            });
            return;
        }
        tokio::select! { _ = cancel.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(1 << (attempts - 1))) => {} }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_and_partial() {
        let v = json!({"action":"result","code":"0","data":{"seg_id":1,"cn":{"st":{"type":"0","rt":[{"ws":[{"cw":[{"w":"你好"}]}]}]}}}});
        let p = parse("xfyun", &v).unwrap();
        assert!(p[0].final_result);
        assert_eq!(p[0].text, "你好");
        let p = parse(
            "tencent",
            &json!({"code":0,"result":{"index":1,"slice_type":1,"voice_text_str":"如何"}}),
        )
        .unwrap();
        assert!(!p[0].final_result);
    }
    #[test]
    fn auth_errors() {
        assert!(parse(
            "xfyun",
            &json!({"action":"error","code":"10110","desc":"no license"})
        )
        .is_err());
    }
    #[test]
    fn signed_address() {
        let p = Settings::default().providers.remove(0);
        let s = Secret {
            api_key: "test-key".into(),
            secret_key: String::new(),
        };
        let mut p = p;
        p.app_id = "test-app".into();
        let url = signed_url(&p, &s, 1, "a").unwrap();
        assert!(url.contains("signa="));
        assert!(!url.contains("test-key"));
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use tokio::net::{TcpListener, TcpStream};

    async fn mock_connection() -> (
        tokio_tungstenite::WebSocketStream<TcpStream>,
        tokio::task::JoinHandle<tokio_tungstenite::WebSocketStream<TcpStream>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        });
        let (client, _) = tokio_tungstenite::client_async(
            format!("ws://{address}"),
            TcpStream::connect(address).await.unwrap(),
        )
        .await
        .unwrap();
        (client, server)
    }

    #[tokio::test]
    async fn both_protocols_frame_audio_and_replace_partial_with_final() {
        for kind in ["xfyun", "tencent"] {
            let (client, accepted) = mock_connection().await;
            let mut server = accepted.await.unwrap();
            let (audio_tx, mut audio_rx) = mpsc::channel(10);
            let (transcripts_tx, mut transcripts_rx) = mpsc::unbounded_channel();
            let cancel = CancellationToken::new();
            let worker_cancel = cancel.clone();
            let worker = tokio::spawn(async move {
                stream_connection(
                    client,
                    &mut audio_rx,
                    StreamContext {
                        task_id:"",
                        kind,
                        session: "test-session",
                        source: "meeting",
                        transcripts: &transcripts_tx,
                        voice: &AtomicI64::new(1000),
                        cancel: &worker_cancel,
                    },
                )
                .await
            });
            for _ in 0..5 {
                audio_tx.send(vec![0; 1280]).await.unwrap();
            }
            let audio_size = timeout(Duration::from_secs(2), async {
                loop {
                    match server.next().await.unwrap().unwrap() {
                        Message::Binary(bytes) => break bytes.len(),
                        Message::Ping(bytes) => {
                            server.send(Message::Pong(bytes)).await.unwrap();
                        }
                        _ => {}
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(audio_size, if kind == "tencent" { 6400 } else { 1280 });
            for final_result in [false, true] {
                let text = if final_result {
                    "请介绍你的项目架构？"
                } else {
                    "请介绍你的项目"
                };
                let value = if kind == "xfyun" {
                    json!({"action":"result","data":{"seg_id":7,"cn":{"st":{"type":if final_result {"0"} else {"1"},"rt":[{"ws":[{"cw":[{"w":text}]}]}]}}}})
                } else {
                    json!({"code":0,"result":{"index":7,"slice_type":if final_result {2} else {1},"voice_text_str":text}})
                };
                server.send(Message::Text(value.to_string())).await.unwrap();
            }
            let partial = timeout(Duration::from_secs(2), transcripts_rx.recv())
                .await
                .unwrap()
                .unwrap();
            let final_text = timeout(Duration::from_secs(2), transcripts_rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(partial.id, final_text.id);
            assert!(!partial.is_final);
            assert!(final_text.is_final);
            assert_eq!(final_text.text, "请介绍你的项目架构？");
            assert_eq!(final_text.speech_end_at, 1000);
            cancel.cancel();
            assert!(timeout(Duration::from_secs(2), worker)
                .await
                .unwrap()
                .unwrap()
                .is_ok());
        }
    }
    #[tokio::test(start_paused = true)]
    async fn timer_jitter_keeps_the_original_audio_clock() {
        for kind in ["xfyun", "tencent"] {
            let period = if kind == "tencent" { 200 } else { 40 };
            let mut cadence = audio_cadence(kind);
            let anchor = cadence.tick().await;
            for _ in 0..30 {
                tokio::time::advance(Duration::from_millis(period + 7)).await;
                let scheduled = cadence.tick().await;
                assert_eq!(
                    scheduled.duration_since(anchor).as_millis() % period as u128,
                    0,
                    "timer jitter shifted the audio clock for {kind}"
                );
            }
        }
    }
    #[tokio::test]
    async fn burst_capture_is_sent_at_the_provider_audio_rate() {
        for kind in ["xfyun", "tencent"] {
            let (client, accepted) = mock_connection().await;
            let mut server = accepted.await.unwrap();
            let (audio_tx, mut audio_rx) = mpsc::channel(25);
            let (tx, _) = mpsc::unbounded_channel();
            for _ in 0..15 {
                audio_tx.send(vec![0; 1280]).await.unwrap();
            }
            let cancel = CancellationToken::new();
            let worker_cancel = cancel.clone();
            let worker = tokio::spawn(async move {
                stream_connection(
                    client,
                    &mut audio_rx,
                    StreamContext {
                        task_id:"",
                        kind,
                        session: "pace",
                        source: "meeting",
                        transcripts: &tx,
                        voice: &AtomicI64::new(0),
                        cancel: &worker_cancel,
                    },
                )
                .await
            });
            let mut received = Vec::new();
            timeout(Duration::from_secs(3), async {
                while received.len() < 3 {
                    match server.next().await.unwrap().unwrap() {
                        Message::Binary(_) => received.push(std::time::Instant::now()),
                        Message::Ping(data) => server.send(Message::Pong(data)).await.unwrap(),
                        _ => {}
                    }
                }
            })
            .await
            .unwrap();
            let minimum = if kind == "tencent" { 300 } else { 55 };
            assert!(
                received[2].duration_since(received[0]).as_millis() >= minimum,
                "burst audio was sent without pacing"
            );
            cancel.cancel();
            let _ = timeout(Duration::from_secs(2), worker).await.unwrap();
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "60 second native system loopback to a local mock ASR; no cloud upload or recording"]
    async fn native_loopback_keeps_up_for_one_minute() {
        let (client, accepted) = mock_connection().await;
        let mut server = accepted.await.unwrap();
        let cancel = CancellationToken::new();
        let (frame_tx, mut frame_rx) = mpsc::channel(150);
        let (notice_tx, mut notice_rx) = mpsc::unbounded_channel();
        crate::audio::spawn(
            AudioSource {
                id: "rate-test".into(),
                name: "Rate test".into(),
                kind: "system".into(),
                pid: None,
                recommended: false,
            },
            false,
            cancel.clone(),
            frame_tx,
            notice_tx,
        );
        let (audio_tx, mut audio_rx) = mpsc::channel(25);
        let (transcripts_tx, _) = mpsc::unbounded_channel();
        let worker_cancel = cancel.clone();
        let worker = tokio::spawn(async move {
            stream_connection(
                client,
                &mut audio_rx,
                StreamContext {
                    task_id: "",
                        kind: "xfyun",
                    session: "native-rate-test",
                    source: "meeting",
                    transcripts: &transcripts_tx,
                    voice: &AtomicI64::new(0),
                    cancel: &worker_cancel,
                },
            )
            .await
        });
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let received = count.clone();
        let server_cancel = cancel.clone();
        let server_worker = tokio::spawn(async move {
            while let Some(message) = server.next().await {
                let message = match message {
                    Ok(message) => message,
                    Err(_) if server_cancel.is_cancelled() => break,
                    Err(error) => panic!("mock ASR connection failed: {error}"),
                };
                match message {
                    Message::Binary(bytes) if bytes.len() == 1280 => {
                        received.fetch_add(1, Ordering::Relaxed);
                    }
                    Message::Binary(_) => {
                        server.close(None).await.ok();
                        break;
                    }
                    Message::Ping(bytes) => {
                        server.send(Message::Pong(bytes)).await.ok();
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        let started = std::time::Instant::now();
        let deadline = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(deadline);
        let mut frames = 0usize;
        let mut dropped = 0usize;
        let mut errors = Vec::new();
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                Some(frame) = frame_rx.recv() => { frames += 1; if audio_tx.try_send(frame.pcm).is_err() { dropped += 1; } },
                Some(notice) = notice_rx.recv() => { if notice.error { errors.push(notice.message); } },
            }
        }
        let sent = count.load(Ordering::Relaxed);
        cancel.cancel();
        let _ = timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(2), server_worker)
            .await
            .unwrap()
            .unwrap();
        println!(
            "{}",
            json!({"elapsedSeconds":started.elapsed().as_secs_f32(),"capturedFrames":frames,"sentFrames":sent,"droppedFrames":dropped,"errors":errors})
        );
        assert!(errors.is_empty(), "native capture failed");
        assert!(
            frames > 1200,
            "native capture did not sustain an audio clock"
        );
        assert_eq!(dropped, 0, "a healthy ASR connection lost captured audio");
        assert!(
            sent + 30 >= frames,
            "sender fell more than a second behind capture"
        );
    }
    #[tokio::test]
    async fn remote_close_becomes_recoverable_error() {
        let (client, accepted) = mock_connection().await;
        let mut server = accepted.await.unwrap();
        let (_audio_tx, mut audio_rx) = mpsc::channel(1);
        let (tx, _) = mpsc::unbounded_channel();
        server.close(None).await.unwrap();
        let result = timeout(
            Duration::from_secs(2),
            stream_connection(
                client,
                &mut audio_rx,
                StreamContext {
                    task_id: "",
                        kind: "tencent",
                    session: "s",
                    source: "meeting",
                    transcripts: &tx,
                    voice: &AtomicI64::new(0),
                    cancel: &CancellationToken::new(),
                },
            ),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().to_string().contains("关闭"));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires saved credentials and an explicit local synthetic PCM WAV fixture"]
    async fn saved_provider_streams_synthetic_speech() {
        let path =
            std::env::var("INTERVIEW_COPILOT_TEST_WAV").expect("set INTERVIEW_COPILOT_TEST_WAV");
        let wav = std::fs::read(path).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        let mut position = 12;
        let mut pcm = Vec::new();
        while position + 8 <= wav.len() {
            let length =
                u32::from_le_bytes(wav[position + 4..position + 8].try_into().unwrap()) as usize;
            if &wav[position..position + 4] == b"data" {
                pcm.extend_from_slice(&wav[position + 8..position + 8 + length]);
                break;
            }
            position += 8 + length + (length % 2);
        }
        assert!(!pcm.is_empty());
        let data_dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap())
            .join("local.interview.copilot");
        let settings = crate::storage::Database::open(&data_dir.join("interview.sqlite3"))
            .unwrap()
            .settings()
            .unwrap();
        let id =
            std::env::var("INTERVIEW_COPILOT_TEST_PROVIDER").unwrap_or_else(|_| "xfyun".into());
        let provider = settings.providers.iter().find(|p| p.id == id).unwrap();
        let secret = crate::secrets::read(&id).unwrap();
        let Connection{ws,task_id} = connect(provider, &secret, &settings.network)
            .await
            .map_err(|e| crate::secrets::redact(&format!("{e:#}"), &secret))
            .unwrap();
        let (audio_tx, mut audio_rx) = mpsc::channel(150);
        let (text_tx, mut text_rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let send_cancel = cancel.clone();
        let feeder = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(40));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut offset = 0;
            loop {
                tokio::select! { _ = send_cancel.cancelled() => return, _ = interval.tick() => {} }
                let mut frame = vec![0; 1280];
                if offset < pcm.len() {
                    let len = 1280.min(pcm.len() - offset);
                    frame[..len].copy_from_slice(&pcm[offset..offset + len]);
                    offset += len;
                }
                if let Err(error) = audio_tx.try_send(frame) {
                    panic!("audio routing failed: {error}")
                }
            }
        });
        let worker_cancel = cancel.clone();
        let kind = provider.kind.clone();
        let mut worker = tokio::spawn(async move {
            stream_connection(
                ws,
                &mut audio_rx,
                StreamContext {
                    task_id: &task_id,
                        kind: &kind,
                    session: "synthetic-live-test",
                    source: "meeting",
                    transcripts: &text_tx,
                    voice: &AtomicI64::new(now_ms()),
                    cancel: &worker_cancel,
                },
            )
            .await
        });
        let deadline = tokio::time::sleep(Duration::from_secs(15));
        tokio::pin!(deadline);
        let mut finals = Vec::new();
        let mut partial_count = 0;
        let mut failure = None;
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                result = &mut worker => { failure = Some(match result { Ok(Err(error)) => crate::secrets::redact(&format!("{error:#}"), &secret), Ok(Ok(())) => "转写提前退出".into(), Err(error) => error.to_string() }); break; },
                Some(t) = text_rx.recv() => { if t.is_final { finals.push(t.text); } else { partial_count += 1; } }
            }
        }
        cancel.cancel();
        let _ = feeder.await;
        if failure.is_none() {
            let _ = worker.await;
        }
        println!(
            "{}",
            serde_json::json!({"provider":id,"finals":finals,"partialCount":partial_count,"error":failure})
        );
        assert!(failure.is_none(), "{}", failure.unwrap_or_default());
        assert!(!finals.is_empty(), "持续送音频后未收到最终转写");
    }
}

#[cfg(test)]mod dashscope_tests{
 use super::*;
 #[tokio::test]async fn starts_before_audio_and_finishes_same_task(){
  use tokio_tungstenite::tungstenite::protocol::Role;
  let(a,b)=tokio::io::duplex(8192);let mut client=tokio_tungstenite::WebSocketStream::from_raw_socket(a,Role::Client,None).await;let mut server=tokio_tungstenite::WebSocketStream::from_raw_socket(b,Role::Server,None).await;
  let peer=tokio::spawn(async move{let Message::Text(text)=server.next().await.unwrap().unwrap()else{panic!()};let v:Value=serde_json::from_str(&text).unwrap();assert_eq!(v["payload"]["parameters"]["sample_rate"],16000);assert_eq!(v["payload"]["model"],"paraformer-realtime-v2");assert_eq!(v["header"]["task_id"],"fixture");server.send(Message::Text(json!({"header":{"event":"task-started","task_id":"fixture"}}).to_string())).await.unwrap();let Message::Text(text)=server.next().await.unwrap().unwrap()else{panic!()};let end:Value=serde_json::from_str(&text).unwrap();assert_eq!(end["header"]["action"],"finish-task");assert_eq!(end["header"]["task_id"],"fixture");server.close(None).await.unwrap();});
  dashscope_handshake(&mut client,"fixture","paraformer-realtime-v2").await.unwrap();finish_connection(&mut client,"dashscope","fixture").await;peer.await.unwrap();
 }
 #[test]fn revisions_keep_sentence_id_and_heartbeat_is_ignored(){let mut v=json!({"header":{"event":"result-generated"},"payload":{"output":{"sentence":{"begin_time":170,"text":"当前题目","sentence_end":false}}}});let a=parse("dashscope",&v).unwrap().remove(0);v["payload"]["output"]["sentence"]["sentence_end"]=json!(true);let b=parse("dashscope",&v).unwrap().remove(0);assert_eq!(a.segment,b.segment);assert!(!a.final_result&&b.final_result);v["payload"]["output"]["sentence"]["heartbeat"]=json!(true);assert!(parse("dashscope",&v).unwrap().is_empty());assert!(parse("dashscope",&json!({"header":{"event":"task-failed","error_code":"InvalidApiKey"}})).is_err());}
}

#[cfg(test)]mod ali_start_validation{
 #[test]fn validates_bearer_speech_without_requiring_app_id(){let mut p=crate::types::Settings::default().providers[0].clone();p.kind="dashscope".into();p.model="paraformer-realtime-v2".into();p.base_url="wss://fixture.invalid/asr".into();let secret=crate::types::Secret{api_key:"fixture".into(),secret_key:String::new()};assert!(super::signed_url(&p,&secret,0,"").is_ok());p.model.clear();assert!(super::signed_url(&p,&secret,0,"").is_err());}
}

#[cfg(test)]mod volc_stream_tests{
 use super::*;
 use tokio::net::{TcpListener,TcpStream};
 async fn pair()->(tokio_tungstenite::WebSocketStream<TcpStream>,tokio_tungstenite::WebSocketStream<TcpStream>){
  let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
  let server=tokio::spawn(async move{let(stream,_)=listener.accept().await.unwrap();tokio_tungstenite::accept_async(stream).await.unwrap()});
  let(client,_)=tokio_tungstenite::client_async(format!("ws://{address}"),TcpStream::connect(address).await.unwrap()).await.unwrap();(client,server.await.unwrap())
 }
 fn response(value:Value)->Message{let payload=serde_json::to_vec(&value).unwrap();let mut bytes=vec![0x11,0x91,0x10,0];bytes.extend_from_slice(&1i32.to_be_bytes());bytes.extend_from_slice(&(payload.len()as u32).to_be_bytes());bytes.extend(payload);Message::Binary(bytes)}
 #[tokio::test]async fn authenticates_then_frames_200ms_audio_and_replaces_partial_with_one_final(){
  let(mut client,mut server)=pair().await;
  let handshake=tokio::spawn(async move{volcengine_handshake(&mut client).await.unwrap();client});
  let Message::Binary(init)=server.next().await.unwrap().unwrap()else{panic!()};assert_eq!(&init[..4],&[0x11,0x10,0x10,0]);
  server.send(response(json!({"audio_info":{"duration":0}}))).await.unwrap();let client=handshake.await.unwrap();
  let(audio_tx,mut audio_rx)=mpsc::channel(10);let(tx,mut rx)=mpsc::unbounded_channel();let cancel=CancellationToken::new();let worker_cancel=cancel.clone();
  let worker=tokio::spawn(async move{stream_connection(client,&mut audio_rx,StreamContext{kind:"volcengine",task_id:"",session:"fixture",source:"meeting",transcripts:&tx,voice:&AtomicI64::new(10),cancel:&worker_cancel}).await});
  for _ in 0..5{audio_tx.send(vec![0x12;1280]).await.unwrap();}
  let frame=timeout(Duration::from_secs(2),async{loop{match server.next().await.unwrap().unwrap(){Message::Binary(bytes)=>break bytes,Message::Ping(b)=>server.send(Message::Pong(b)).await.unwrap(),_=>{}}}}).await.unwrap();
  assert_eq!(&frame[..4],&[0x11,0x20,0,0]);assert_eq!(frame.len(),6408);assert!(frame[8..].iter().all(|b|*b==0x12));
  for (text,definite) in [("请介绍项目",false),("请介绍项目架构？",true),("请介绍项目架构？",true)]{server.send(response(json!({"result":{"utterances":[{"start_time":200,"text":text,"definite":definite}]}}))).await.unwrap();}
  let partial=timeout(Duration::from_secs(2),rx.recv()).await.unwrap().unwrap();let final_text=timeout(Duration::from_secs(2),rx.recv()).await.unwrap().unwrap();
  assert_eq!(partial.id,final_text.id);assert!(!partial.is_final);assert!(final_text.is_final);assert_eq!(final_text.text,"请介绍项目架构？");assert!(timeout(Duration::from_millis(60),rx.recv()).await.is_err());
  cancel.cancel();let end=timeout(Duration::from_secs(2),async{loop{match server.next().await.unwrap().unwrap(){Message::Binary(bytes)=>break bytes,Message::Ping(b)=>server.send(Message::Pong(b)).await.unwrap(),_=>{}}}}).await.unwrap();assert_eq!(end[1],0x22);let _=server.close(None).await;assert!(timeout(Duration::from_secs(2),worker).await.unwrap().unwrap().is_ok());
 }
 #[tokio::test]async fn binary_service_errors_fail_connection_and_stream_without_publishing_text(){
  let(mut client,mut server)=pair().await;let worker=tokio::spawn(async move{volcengine_handshake(&mut client).await});
  let _=server.next().await;server.send(Message::Binary(vec![0x11,0xf0,0,0,2,174,165,1,0,0,0,0])).await.unwrap();assert!(worker.await.unwrap().unwrap_err().to_string().contains("火山引擎语音错误"));
 }
}
