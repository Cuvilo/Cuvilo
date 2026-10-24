use crate::{audio, question::QuestionBuffer, storage::Database, types::*};
use anyhow::Result;
use serde_json::json;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
pub fn run() -> Result<bool> {
    let args = std::env::args().collect::<Vec<_>>();
    if let Some(index) = args.iter().position(|a| a == "--test-provider") {
        let id = args
            .get(index + 1)
            .ok_or_else(|| anyhow::anyhow!("请指定服务 ID"))?;
        let db_path = std::path::PathBuf::from(std::env::var("APPDATA")?)
            .join("local.interview.copilot")
            .join("interview.sqlite3");
        let db = Database::open(&db_path)?;
        let settings = db.settings()?;
        let p = settings
            .providers
            .iter()
            .find(|p| &p.id == id)
            .ok_or_else(|| anyhow::anyhow!("服务不存在"))?;
        let secret = crate::secrets::read(id)?;
        let started = Instant::now();
        tokio::runtime::Runtime::new()?
            .block_on(async {
                if p.kind == "llm" {
                    crate::llm::test(p, &secret, &settings.network).await
                } else {
                    crate::asr::test(p, &secret, &settings.network).await
                }
            })
            .map_err(|e| anyhow::anyhow!(crate::secrets::redact(&format!("{e:#}"), &secret)))?;
        println!(
            "{}",
            json!({"ok":true,"provider":id,"milliseconds":started.elapsed().as_millis()})
        );
        return Ok(true);
    }
    if args.iter().any(|a| a == "--diagnostics") {
        let sources = audio::sources()?;
        println!(
            "{}",
            json!({"ok":true,"sources":sources,"windowsBuild":audio::windows_build(),"architecture":std::env::consts::ARCH,"version":env!("CARGO_PKG_VERSION")})
        );
        return Ok(true);
    }
    if let Some(index) = args.iter().position(|a| a == "--soak") {
        let seconds = args
            .get(index + 1)
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(3600);
        let db = Database::open(std::path::Path::new(":memory:"))?;
        let session = Session {
            id: new_id(),
            title: "Synthetic soak test".into(),
            created_at: now_ms(),
            ended_at: None,
        };
        db.session(&session)?;
        let start = Instant::now();
        let mut count = 0;
        let mut max_frame = 0usize;
        while start.elapsed() < Duration::from_secs(seconds) {
            let mut q = QuestionBuffer::default();
            q.last_voice = now_ms() - 800;
            let id = new_id();
            q.push(&id, "请介绍一下缓存的实现原理？");
            if let Some((qid, text, revision, end)) = q.take(now_ms(), false, 700) {
                let a = Answer {
                    sources: Vec::new(),
                    id: new_id(),
                    session_id: session.id.clone(),
                    question_id: qid,
                    revision,
                    question: text,
                    text: "这是一条合成测试答案，用于验证会话、问题与流式状态的持续处理。".into(),
                    status: "complete".into(),
                    mode: "short".into(),
                    created_at: now_ms(),
                    speech_end_at: end,
                    trigger_at: now_ms(),
                    request_at: now_ms(),
                    first_token_ms: Some(1),
                    first_sentence_ms: Some(800),
                };
                db.answer(&a)?;
            }
            let pcm = vec![0u8; 1280];
            max_frame = max_frame.max(pcm.len());
            count += 1;
            std::thread::sleep(Duration::from_millis(100));
        }
        println!(
            "{}",
            json!({"ok":true,"seconds":start.elapsed().as_secs(),"iterations":count,"frameBytes":max_frame,"storedAnswers":db.answers(&session.id)?.len(),"synthetic":true})
        );
        return Ok(true);
    }
    if args.iter().any(|a| a == "--audio-probe") {
        let seconds = args
            .iter()
            .position(|a| a == "--seconds")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(5);
        let pid = args
            .iter()
            .position(|a| a == "--pid")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse::<u32>().ok());
        let mic = args.iter().any(|a| a == "--microphone");
        let source = AudioSource {
            id: "probe".into(),
            name: "Audio probe".into(),
            kind: if pid.is_some() { "process" } else { "system" }.into(),
            pid,
            recommended: false,
        };
        let cancel = CancellationToken::new();
        let (tx, mut rx) = tokio::sync::mpsc::channel(150);
        let (ntx, mut nrx) = tokio::sync::mpsc::unbounded_channel();
        audio::spawn(source, mic, cancel.clone(), tx, ntx);
        let start = Instant::now();
        let mut frames = 0;
        let mut peak = 0f32;
        let mut errors = Vec::new();
        while start.elapsed() < Duration::from_secs(seconds) {
            while let Ok(f) = rx.try_recv() {
                frames += 1;
                peak = peak.max(f.level);
            }
            while let Ok(n) = nrx.try_recv() {
                if n.error {
                    errors.push(n.message)
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        cancel.cancel();
        std::thread::sleep(Duration::from_millis(100));
        println!(
            "{}",
            json!({"ok":errors.is_empty()&&frames>0,"frames":frames,"peak":peak,"errors":errors,"seconds":seconds})
        );
        return Ok(true);
    }
    Ok(false)
}
