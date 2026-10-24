//! OpenAI Audio Transcriptions: bounded PCM segmentation, not a WebSocket protocol.
//! API: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
use crate::{audio::Notice, network, types::*};
use anyhow::{ensure, Context, Result};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const FRAME: usize = 640; // 20 ms, signed PCM16 LE, 16 kHz mono.
const MAX_CLIP: usize = 32000 * 12;
struct Clip {
    pcm: Vec<u8>,
    speech_end: i64,
}

pub fn endpoint(p: &Provider) -> Result<url::Url> {
    let mut url = url::Url::parse(p.base_url.trim()).context("语音 Base URL 格式不正确")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    ensure!(
        (url.scheme() == "https" || (url.scheme() == "http" && local))
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "语音 Base URL 须使用不含凭据或查询参数的 HTTPS 地址"
    );
    ensure!(
        !p.model.trim().is_empty()
            && p.model.len() <= 256
            && !p.model.chars().any(char::is_control),
        "请填写有效的语音模型名称"
    );
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/audio/transcriptions") {
        path.to_owned()
    } else {
        format!("{path}/audio/transcriptions")
    };
    url.set_path(&path);
    Ok(url)
}
fn wav(pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend(b"RIFF");
    out.extend((36 + pcm.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(16000u32.to_le_bytes());
    out.extend(32000u32.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((pcm.len() as u32).to_le_bytes());
    out.extend(pcm);
    out
}
fn multipart(p: &Provider, pcm: &[u8], boundary: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, value) in [("model", p.model.trim()), ("response_format", "json")] {
        out.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    out.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    out.extend(wav(pcm));
    out.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    out
}
async fn transcribe(
    p: &Provider,
    s: &Secret,
    n: &Network,
    pcm: &[u8],
    cancel: &CancellationToken,
) -> Result<String> {
    let work = async {
        let url = endpoint(p)?;
        ensure!(!s.api_key.trim().is_empty(), "请填写语音 API Key");
        ensure!(
            pcm.len() <= MAX_CLIP && pcm.len() % 2 == 0,
            "语音片段格式无效"
        );
        let boundary = format!("Cuvilo{}", new_id().replace('-', ""));
        let mut response = network::client_no_redirects(n)?
            .post(url)
            .bearer_auth(s.api_key.trim())
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(multipart(p, pcm, &boundary))
            .timeout(Duration::from_secs(40))
            .send()
            .await
            .context("语音转写连接失败")?;
        ensure!(
            response.status().is_success(),
            "语音转写失败（HTTP {}），请检查密钥、模型及额度",
            response.status().as_u16()
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.context("语音转写响应中断")? {
            ensure!(bytes.len() + chunk.len() <= 256 * 1024, "语音转写响应过长");
            bytes.extend(chunk);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).context("语音转写返回格式无效")?;
        ensure!(
            value.get("error").is_none(),
            "语音服务返回错误，请检查模型及额度"
        );
        let text = value["text"].as_str().context("语音服务没有返回转写文本")?;
        ensure!(text.chars().count() <= 12000, "语音转写文本过长");
        Ok(text.trim().to_owned())
    };
    tokio::select! {biased;_=cancel.cancelled()=>anyhow::bail!("语音转写已取消"),result=work=>result.map_err(|e|anyhow::anyhow!(crate::secrets::redact(&format!("{e:#}"),s)))}
}
pub async fn test(p: &Provider, s: &Secret, n: &Network) -> Result<()> {
    // Explicit connection test uploads synthetic silence, never microphone/desktop audio.
    transcribe(p, s, n, &vec![0; 32000], &CancellationToken::new())
        .await
        .map(|_| ())
}
#[derive(Default)]
struct Segmenter {
    pending: VecDeque<u8>,
    lead: VecDeque<u8>,
    active: Vec<u8>,
    silent: usize,
    voiced: usize,
    speech_end: i64,
}
impl Segmenter {
    fn push(&mut self, bytes: Vec<u8>, at: i64) -> Vec<Clip> {
        self.pending.extend(bytes);
        let mut clips = Vec::new();
        while self.pending.len() >= FRAME {
            let frame = self.pending.drain(..FRAME).collect::<Vec<_>>();
            let power = frame
                .chunks_exact(2)
                .map(|v| {
                    let x = i16::from_le_bytes([v[0], v[1]]) as f64;
                    x * x
                })
                .sum::<f64>()
                / (FRAME / 2) as f64;
            let voice = power >= (32768.0f64 * 0.015).powi(2);
            if self.active.is_empty() && !voice {
                self.lead.extend(frame);
                while self.lead.len() > FRAME * 8 {
                    self.lead.drain(..FRAME);
                }
                continue;
            }
            if self.active.is_empty() {
                self.active.extend(self.lead.drain(..));
            }
            self.active.extend(frame);
            if voice {
                self.voiced += FRAME;
                self.silent = 0;
                self.speech_end = at;
            } else {
                self.silent += FRAME;
            }
            if self.silent >= FRAME * 30 || self.active.len() >= MAX_CLIP {
                if let Some(clip) = self.flush() {
                    clips.push(clip);
                }
            }
        }
        clips
    }
    fn flush(&mut self) -> Option<Clip> {
        let pcm = std::mem::take(&mut self.active);
        let voiced = std::mem::take(&mut self.voiced);
        self.silent = 0;
        (voiced >= FRAME * 8).then_some(Clip {
            pcm,
            speech_end: self.speech_end,
        })
    }
}
fn notice(notices: &mpsc::UnboundedSender<Notice>, source: &str, message: String, error: bool) {
    let _ = notices.send(Notice {
        source: source.into(),
        message,
        error,
    });
}
fn gap(transcripts: &mpsc::UnboundedSender<Transcript>, session: &str, source: &str, at: i64) {
    let segment = new_id();
    let _ = transcripts.send(Transcript {
        id: format!("{source}-gap-{segment}"),
        session_id: session.into(),
        source: source.into(),
        segment_id: segment,
        text: "【转写缺口：部分语音未能识别，请重复遗漏的问题】".into(),
        is_final: true,
        at: now_ms(),
        speech_end_at: at,
    });
}
#[allow(clippy::too_many_arguments)]
pub async fn run(
    p: Provider,
    s: Secret,
    n: Network,
    session: String,
    source: String,
    mut audio: mpsc::Receiver<Vec<u8>>,
    transcripts: mpsc::UnboundedSender<Transcript>,
    notices: mpsc::UnboundedSender<Notice>,
    cancel: CancellationToken,
    ready: Arc<AtomicBool>,
) {
    if let Err(e) = endpoint(&p).and_then(|_| {
        ensure!(!s.api_key.trim().is_empty(), "请填写语音 API Key");
        Ok(())
    }) {
        notice(&notices, &source, e.to_string(), true);
        return;
    }
    let cancel = cancel.child_token();
    let (tx, mut rx) = mpsc::channel::<Clip>(3);
    ready.store(true, Ordering::Release);
    notice(&notices, &source, format!("{}等待语音", p.name), false);
    let collect = async {
        let mut segmenter = Segmenter::default();
        let mut overloaded = false;
        loop {
            let bytes =
                tokio::select! {biased;_=cancel.cancelled()=>break,value=audio.recv()=>value};
            let closing = bytes.is_none();
            let clips = if let Some(bytes) = bytes {
                segmenter.push(bytes, now_ms())
            } else {
                segmenter.flush().into_iter().collect()
            };
            for clip in clips {
                let at = clip.speech_end;
                match tx.try_send(clip) {
                    Ok(()) => overloaded = false,
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        if !overloaded {
                            overloaded = true;
                            notice(
                                &notices,
                                &source,
                                "语音转写积压，存在文本缺口，请检查网络或换用实时语音服务".into(),
                                true,
                            );
                            gap(&transcripts, &session, &source, at);
                        }
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => return,
                }
            }
            if closing {
                break;
            }
        }
        drop(tx);
    };
    let upload = async {
        let mut failed = 0;
        loop {
            let clip = tokio::select! {biased;_=cancel.cancelled()=>break,value=rx.recv()=>{let Some(clip)=value else{break};clip}};
            let result = transcribe(&p, &s, &n, &clip.pcm, &cancel).await;
            if cancel.is_cancelled() {
                break;
            }
            match result {
                Ok(text) => {
                    failed = 0;
                    notice(&notices, &source, format!("{}已连接", p.name), false);
                    if !text.is_empty() {
                        let segment = new_id();
                        let _ = transcripts.send(Transcript {
                            id: format!("{source}-{segment}"),
                            session_id: session.clone(),
                            source: source.clone(),
                            segment_id: segment,
                            text,
                            is_final: true,
                            at: now_ms(),
                            speech_end_at: clip.speech_end,
                        });
                    }
                }
                Err(e) => {
                    failed += 1;
                    gap(&transcripts, &session, &source, clip.speech_end);
                    notice(
                        &notices,
                        &source,
                        format!("转写失败，存在文本缺口：{e}"),
                        true,
                    );
                    if failed >= 3 {
                        notice(
                            &notices,
                            &source,
                            "语音转写已停止，请检查服务配置后重新开始".into(),
                            true,
                        );
                        cancel.cancel();
                        break;
                    }
                }
            }
        }
    };
    tokio::join!(collect, upload);
    ready.store(false, Ordering::Release);
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    fn provider(base_url: String) -> Provider {
        Provider {
            id: "openai-asr-fixture".into(),
            name: "fixture".into(),
            kind: "openai-asr".into(),
            base_url,
            model: "gpt-transcribe".into(),
            app_id: String::new(),
            secret_id: String::new(),
        }
    }
    fn key() -> Secret {
        Secret {
            api_key: "fixture-bearer-key".into(),
            secret_key: String::new(),
        }
    }
    fn direct() -> Network {
        Network {
            mode: "direct".into(),
            url: String::new(),
        }
    }
    fn speech(frames: usize) -> Vec<u8> {
        (0..frames * FRAME / 2)
            .flat_map(|i| if i % 2 == 0 { 2000i16 } else { -2000i16 }.to_le_bytes())
            .collect()
    }
    async fn read_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut chunk = [0; 8192];
        loop {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend(&chunk[..n]);
            if let Some(pos) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..pos]);
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|s| s.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= pos + 4 + length {
                    return bytes;
                }
            }
        }
    }
    async fn server(
        status: &'static str,
        body: &'static str,
    ) -> (Provider, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p = provider(format!(
            "http://{}/gateway/v1",
            listener.local_addr().unwrap()
        ));
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            request
        });
        (p, handle)
    }
    #[test]
    fn endpoint_preserves_gateway_prefix_and_rejects_invalid_credentials_or_transport() {
        for (base, expected) in [
            (
                "https://fixture.invalid/gateway/v1/",
                "https://fixture.invalid/gateway/v1/audio/transcriptions",
            ),
            (
                "https://fixture.invalid/v1/audio/transcriptions",
                "https://fixture.invalid/v1/audio/transcriptions",
            ),
        ] {
            assert_eq!(endpoint(&provider(base.into())).unwrap().as_str(), expected);
        }
        for base in [
            "wss://fixture.invalid",
            "http://fixture.invalid/v1",
            "https://key@fixture.invalid",
            "https://fixture.invalid?key=secret",
            "https://fixture.invalid#fragment",
        ] {
            assert!(endpoint(&provider(base.into())).is_err());
        }
        let mut p = provider("https://fixture.invalid/v1".into());
        p.model = "bad\r\nmodel".into();
        assert!(endpoint(&p).is_err());
    }
    #[test]
    fn segmentation_ignores_silence_and_keeps_lead_in_and_speech_timestamp() {
        let mut s = Segmenter::default();
        assert!(s.push(vec![0; 32000], 100).is_empty());
        assert!(s.push(speech(10), 200).is_empty());
        let clips = s.push(vec![0; FRAME * 30], 999);
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].speech_end, 200);
        assert_eq!(clips[0].pcm.len(), FRAME * (8 + 10 + 30));
        assert!(s.flush().is_none());
        assert!(s.push(speech(2), 300).is_empty());
        assert!(s.push(vec![0; FRAME * 30], 400).is_empty());
    }
    #[test]
    fn fragmented_pcm_and_long_speech_remain_bounded_without_duplicating_samples() {
        let mut s = Segmenter::default();
        let bytes = speech(1300);
        let mut clips = Vec::new();
        for chunk in bytes.chunks(193) {
            clips.extend(s.push(chunk.to_vec(), 1000));
        }
        clips.extend(s.flush());
        assert!(clips.len() >= 3);
        assert!(clips.iter().all(|c| c.pcm.len() <= MAX_CLIP));
        assert_eq!(
            clips.iter().map(|c| c.pcm.len()).sum::<usize>(),
            bytes.len()
        );
    }
    #[tokio::test]
    async fn http_upload_contains_authenticated_multipart_and_valid_mono_wav() {
        let (p, server) = server("200 OK", r#"{"text":" fixture transcript "}"#).await;
        let pcm = speech(10);
        assert_eq!(
            transcribe(&p, &key(), &direct(), &pcm, &CancellationToken::new())
                .await
                .unwrap(),
            "fixture transcript"
        );
        let bytes = server.await.unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("POST /gateway/v1/audio/transcriptions"));
        assert!(text
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-bearer-key"));
        assert!(text.contains("name=\"model\"\r\n\r\ngpt-transcribe"));
        assert!(text.contains("name=\"response_format\"\r\n\r\njson"));
        let start = bytes.windows(4).position(|w| w == b"RIFF").unwrap();
        assert_eq!(&bytes[start..start + 44], &wav(&pcm)[..44]);
        assert_eq!(&bytes[start + 44..start + 44 + pcm.len()], pcm);
    }
    #[tokio::test]
    async fn invalid_and_upstream_error_responses_are_failures_without_echoing_credentials() {
        for (status, body) in [
            ("401 Unauthorized", r#"{"error":"fixture-bearer-key"}"#),
            (
                "200 OK",
                r#"{"error":"fixture-bearer-key","text":"false success"}"#,
            ),
            ("200 OK", r#"{"text":23}"#),
            ("200 OK", "malformed"),
        ] {
            let (p, server) = server(status, body).await;
            let error = transcribe(
                &p,
                &key(),
                &direct(),
                &speech(10),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(!error.contains("fixture-bearer-key"));
            server.await.unwrap();
        }
        let (p, server) = server("200 OK", r#"{"text":""}"#).await;
        assert_eq!(
            transcribe(
                &p,
                &key(),
                &direct(),
                &speech(10),
                &CancellationToken::new()
            )
            .await
            .unwrap(),
            ""
        );
        server.await.unwrap();
    }
    #[tokio::test]
    async fn capture_dispatches_final_transcript_with_track_and_stored_speech_time() {
        let (p, server) = server("200 OK", r#"{"text":"recognized"}"#).await;
        let (audio_tx, audio) = mpsc::channel(4);
        let (tx, mut transcripts) = mpsc::unbounded_channel();
        let (notices, _) = mpsc::unbounded_channel();
        let ready = Arc::new(AtomicBool::new(false));
        let token = CancellationToken::new();
        let task = tokio::spawn(run(
            p,
            key(),
            direct(),
            "session-fixture".into(),
            "microphone".into(),
            audio,
            tx,
            notices,
            token,
            ready.clone(),
        ));
        audio_tx.send(speech(12)).await.unwrap();
        audio_tx.send(vec![0; FRAME * 30]).await.unwrap();
        drop(audio_tx);
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        server.await.unwrap();
        let t = transcripts.recv().await.unwrap();
        assert_eq!(
            (t.session_id.as_str(), t.source.as_str(), t.text.as_str()),
            ("session-fixture", "microphone", "recognized")
        );
        assert!(t.is_final && t.speech_end_at > 0);
        assert!(transcripts.try_recv().is_err());
        assert!(!ready.load(Ordering::Acquire));
    }
    #[tokio::test]
    async fn cancel_inflight_discards_result_and_releases_audio_worker() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p = provider(format!("http://{}/v1", listener.local_addr().unwrap()));
        let (seen, wait) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let _ = seen.send(());
            let mut byte = [0];
            tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap()
        });
        let (audio_tx, audio) = mpsc::channel(4);
        let (tx, mut transcripts) = mpsc::unbounded_channel();
        let (notices, _) = mpsc::unbounded_channel();
        let ready = Arc::new(AtomicBool::new(false));
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run(
            p,
            key(),
            direct(),
            "s".into(),
            "meeting".into(),
            audio,
            tx,
            notices,
            cancel.clone(),
            ready.clone(),
        ));
        audio_tx.send(speech(10)).await.unwrap();
        audio_tx.send(vec![0; FRAME * 30]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), wait)
            .await
            .unwrap()
            .unwrap();
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert!(transcripts.try_recv().is_err());
        assert!(!ready.load(Ordering::Acquire));
        assert_eq!(server.await.unwrap(), 0);
    }
    #[tokio::test]
    async fn slow_http_does_not_block_capture_and_reports_bounded_queue_overflow_once() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p = provider(format!("http://{}/v1", listener.local_addr().unwrap()));
        let (seen, wait) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let _ = seen.send(());
            let mut byte = [0];
            let _ = socket.read(&mut byte).await;
        });
        let (audio_tx, audio) = mpsc::channel(4);
        let (tx, mut transcripts) = mpsc::unbounded_channel();
        let (notices, _) = mpsc::unbounded_channel();
        let ready = Arc::new(AtomicBool::new(false));
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run(
            p,
            key(),
            direct(),
            "s".into(),
            "meeting".into(),
            audio,
            tx,
            notices,
            cancel.clone(),
            ready.clone(),
        ));
        let mut clip = speech(10);
        clip.extend(vec![0; FRAME * 30]);
        audio_tx.send(clip.clone()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), wait)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            for _ in 0..10 {
                audio_tx.send(clip.clone()).await.unwrap();
            }
        })
        .await
        .unwrap();
        let gap = tokio::time::timeout(Duration::from_secs(3), transcripts.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(gap.text.starts_with("【转写缺口"));
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        server.await.unwrap();
        assert!(transcripts.try_recv().is_err());
        assert!(!ready.load(Ordering::Acquire));
    }
}
