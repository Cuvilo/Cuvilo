use crate::{
    asr, audio, documents, llm, question::QuestionBuffer, secrets, storage::Database, types::*,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::ipc::Channel;
use tokio::{
    sync::mpsc,
    time::{interval, Duration},
};
use tokio_util::sync::CancellationToken;
#[derive(Debug, PartialEq)]
enum ForwardState {
    Sent,
    Waiting,
    Congested,
    Stopped,
    Closed,
}
fn forward_audio(
    tx: &mpsc::Sender<Vec<u8>>,
    pcm: Vec<u8>,
    ready: &AtomicBool,
    cancel: &CancellationToken,
) -> ForwardState {
    if cancel.is_cancelled() {
        return ForwardState::Stopped;
    }
    if !ready.load(Ordering::Acquire) {
        return ForwardState::Waiting;
    }
    match tx.try_send(pcm) {
        Ok(()) => ForwardState::Sent,
        Err(mpsc::error::TrySendError::Full(_)) => ForwardState::Congested,
        Err(mpsc::error::TrySendError::Closed(_)) if cancel.is_cancelled() => ForwardState::Stopped,
        Err(mpsc::error::TrySendError::Closed(_)) if !ready.load(Ordering::Acquire) => {
            ForwardState::Waiting
        }
        Err(mpsc::error::TrySendError::Closed(_)) => ForwardState::Closed,
    }
}
#[derive(Default)]
struct UploadBacklog {
    active: bool,
    gap_reported: bool,
}
impl UploadBacklog {
    fn dropped(&mut self, contains_audio: bool) -> (bool, bool) {
        let started = !self.active;
        self.active = true;
        let gap = contains_audio && !self.gap_reported;
        self.gap_reported |= contains_audio;
        (started, gap)
    }
    fn sent(&mut self, available: usize, total: usize) -> bool {
        if self.active && available * 2 >= total {
            *self = Self::default();
            true
        } else {
            false
        }
    }
}
pub struct Runtime {
    pub session: Session,
    pub cancel: CancellationToken,
}
pub struct Core {
    pub screen: Mutex<crate::screen_capture::CaptureState>,
    pub screen_priority: AtomicBool,
    pub db: Mutex<Database>,
    pub settings: Mutex<Settings>,
    pub channels: Mutex<Vec<Channel<Value>>>,
    pub runtime: Mutex<Option<Runtime>>,
    deleted_sessions: Mutex<std::collections::HashSet<String>>,
    pub(crate) lifecycle: Mutex<()>,
    pub buffer: Mutex<QuestionBuffer>,
    pub answer_cancel: Mutex<CancellationToken>,
    pub generation: AtomicU64,
    pub active_answer: Mutex<Option<Answer>>,
    pub warnings: Mutex<Vec<String>>,
    pub status_events: Mutex<std::collections::VecDeque<Value>>,
}
impl Core {
    pub fn open(path: &Path) -> Result<Arc<Self>> {
        let db = Database::open(path)?;
        let mut settings = db.settings()?;
        if crate::settings_actions::migrate_shortcut(&mut settings){db.save_settings(&settings)?;}
        let warnings = db.take_notice().into_iter().collect::<Vec<_>>();
        Ok(Arc::new(Self {
            db: Mutex::new(db),
            screen: Mutex::new(crate::screen_capture::CaptureState::default()),
            screen_priority: AtomicBool::new(false),
            settings: Mutex::new(settings),
            channels: Mutex::new(Vec::new()),
            runtime: Mutex::new(None),
            deleted_sessions: Mutex::new(std::collections::HashSet::new()),
            lifecycle: Mutex::new(()),
            buffer: Mutex::new(QuestionBuffer::default()),
            answer_cancel: Mutex::new(CancellationToken::new()),
            generation: AtomicU64::new(0),
            active_answer: Mutex::new(None),
            warnings: Mutex::new(warnings),
            status_events: Mutex::new(std::collections::VecDeque::new()),
        }))
    }
    pub fn emit(&self, event: Value) {
        self.channels
            .lock()
            .unwrap()
            .retain(|c| c.send(event.clone()).is_ok());
    }
    pub fn status(&self, id: &str, source: &str, message: &str, error: bool) {
        let event = json!({"type":"status","sessionId":id,"source":source,"message":message,"error":error,"at":now_ms()});
        {
            let mut history = self.status_events.lock().unwrap();
            if history.back().is_none_or(|old| {
                old["source"] != event["source"]
                    || old["message"] != event["message"]
                    || old["sessionId"] != event["sessionId"]
            }) {
                if history.len() == 128 {
                    history.pop_front();
                }
                history.push_back(event.clone());
            }
        }
        self.emit(event);
    }
    fn save_transcript(&self, transcript: &Transcript) -> bool {
        let deleted = self.deleted_sessions.lock().unwrap();
        if deleted.contains(&transcript.session_id) { return false; }
        if let Err(error) = self.db.lock().unwrap().transcript(transcript) {
            self.status(&transcript.session_id, "storage", &format!("转写保存失败：{error}"), true);
        }
        true
    }
    pub fn save_answer(&self, a: &Answer) {
        let deleted = self.deleted_sessions.lock().unwrap();
        if deleted.contains(&a.session_id) { return; }
        if let Err(e) = self.db.lock().unwrap().answer(a) {
            self.status(
                &a.session_id,
                "storage",
                &format!("答案保存失败：{e}"),
                true,
            )
        }
        self.emit(json!({"type":"answer","sessionId":a.session_id,"answer":a}));
    }
    pub fn publish_generation(&self,answer:&Answer,generation:u64,finished:bool)->bool {
        let _guard=self.lifecycle.lock().unwrap();
        if self.generation.load(Ordering::SeqCst)!=generation || !self.runtime.lock().unwrap().as_ref().is_some_and(|r|r.session.id==answer.session_id&&!r.cancel.is_cancelled()){return false;}
        *self.active_answer.lock().unwrap()=Some(answer.clone());
        if finished {self.save_answer(answer);if answer.mode.starts_with("screen"){crate::screen_capture::answered(self,answer);}}
        else {self.emit(json!({"type":"answer","sessionId":answer.session_id,"answer":answer}));}
        true
    }
    pub fn snapshot(&self) -> Result<Value> {
        let runtime = self.runtime.lock().unwrap();
        let session = runtime.as_ref().map(|r| r.session.clone());
        drop(runtime);
        let notices = {
            let history = self.status_events.lock().unwrap();
            let mut sources = std::collections::HashSet::new();
            history
                .iter()
                .rev()
                .filter(|event| {
                    session.as_ref().is_some_and(|s| event["sessionId"] == s.id)
                        && sources.insert(event["source"].as_str().unwrap_or("").to_string())
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        let (transcripts,mut answers,materials,sessions) = {
            let db=self.db.lock().unwrap();
            let (transcripts,answers)=if let Some(s)=&session{(db.transcripts(&s.id)?,db.answers(&s.id)?)}else{(vec![],vec![])};
            (transcripts,answers,db.materials()?,db.history_sessions()?)
        };
        // Streaming content is published in memory before its final DB write.
        // Opening another window or refreshing settings must not restore the
        // empty generating row over text already visible in the answer window.
        if let Some(live)=self.active_answer.lock().unwrap().as_ref().filter(|a|session.as_ref().is_some_and(|s|s.id==a.session_id)){
            if let Some(row)=answers.iter_mut().find(|a|a.id==live.id){*row=live.clone();}else{answers.push(live.clone());}
        }
        let settings = self.settings.lock().unwrap().clone();
        let configured: Vec<_> = settings
            .providers
            .iter()
            .filter(|p| secrets::configured(&p.id))
            .map(|p| p.id.clone())
            .collect();
        let mut warnings=self.warnings.lock().unwrap().clone();
        warnings.extend(settings.providers.iter().filter(|p|[&settings.active_model,&settings.asr_provider,&settings.ocr_provider].contains(&&p.id)&&configured.contains(&p.id)).filter_map(crate::provider_check::configuration_warning));
        Ok(
            json!({"notices":notices,"warnings":warnings,"settings":settings,"configured":configured,"session":session,"transcripts":transcripts,"answers":answers,"materials":materials,"sessions":sessions}),
        )
    }
    pub fn delete_session(&self, id: &str) -> Result<()> {
        self.delete_sessions(&[id.to_string()])
    }
    pub fn delete_sessions(&self, ids: &[String]) -> Result<()> {
        let _guard = self.lifecycle.lock().unwrap();
        if self.runtime.lock().unwrap().as_ref().is_some_and(|r| ids.contains(&r.session.id)) {
            bail!("请先结束当前面试，再删除记录");
        }
        // One lock and transaction prevent partial deletion and late writes for the entire batch.
        let mut deleted = self.deleted_sessions.lock().unwrap();
        self.db.lock().unwrap().delete_sessions(ids)?;
        deleted.extend(ids.iter().cloned());
        self.emit(json!({"type":"historyChanged","sessionId":""}));
        Ok(())
    }
    pub fn create_data_backup(&self, path: &Path) -> Result<()> {
        let _guard=self.lifecycle.lock().unwrap();
        anyhow::ensure!(self.runtime.lock().unwrap().is_none(), "请先结束面试，再备份数据");
        self.db.lock().unwrap().data_backup()?.write(path)
    }
    pub fn restore_data_backup(&self, data: &crate::data_backup::DataBackup, rollback: &Path) -> Result<()> {
        let _guard=self.lifecycle.lock().unwrap();
        anyhow::ensure!(self.runtime.lock().unwrap().is_none(), "请先结束面试，再恢复数据");
        let mut deleted=self.deleted_sessions.lock().unwrap();
        let mut db=self.db.lock().unwrap();
        let previous=db.data_backup()?;
        previous.write(rollback)?; // No replacement can begin until a durable recovery file exists.
        db.restore_data(data)?;
        // Historical sessions never receive new content. Block late writers from either dataset.
        deleted.extend(previous.sessions.iter().chain(data.sessions.iter()).map(|s|s.id.clone()));
        drop(db);drop(deleted);
        self.generation.fetch_add(1,Ordering::SeqCst);
        self.answer_cancel.lock().unwrap().cancel();
        *self.active_answer.lock().unwrap()=None;
        *self.buffer.lock().unwrap()=QuestionBuffer::default();
        self.status_events.lock().unwrap().clear();
        self.emit(json!({"type":"dataRestored","sessionId":""}));
        Ok(())
    }
    pub fn stop(&self) -> Result<()> {
        let _guard = self.lifecycle.lock().unwrap();
        self.stop_inner()
    }
    fn stop_inner(&self) -> Result<()> {
        crate::screen_capture::clear(self);
        let runtime = self.runtime.lock().unwrap().take();
        if let Some(r) = runtime {
            r.cancel.cancel();
            self.cancel_answer_inner();
            let mut session = r.session.clone();
            session.ended_at = Some(now_ms());
            let mut deleted = self.deleted_sessions.lock().unwrap();
            let result = self.db.lock().unwrap().finish_session(&session);
            match result {
                Ok(false) => { deleted.insert(session.id.clone()); }
                Ok(true) => {}
                Err(error) => {
                    *self.runtime.lock().unwrap() = Some(r);
                    return Err(error);
                }
            }
            drop(deleted);
            self.emit(json!({"type":"sessionStopped","sessionId":session.id,"session":session}));
        }
        Ok(())
    }
    pub fn cancel_screen_capture(&self){
        let _guard=self.lifecycle.lock().unwrap();
        let qid=self.screen.lock().unwrap().question_id.clone();
        let generating=self.active_answer.lock().unwrap().as_ref().is_some_and(|a|a.status=="generating"&&a.question_id==qid&&a.mode.starts_with("screen"));
        if generating{self.cancel_answer_inner();}
        crate::screen_capture::clear(self);
    }
    pub fn cancel_answer(&self) {
        let _guard=self.lifecycle.lock().unwrap();
        self.cancel_answer_inner();
    }
    fn cancel_answer_inner(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.answer_cancel.lock().unwrap().cancel();
        let answer = {
            let mut current = self.active_answer.lock().unwrap();
            if let Some(a) = current.as_mut() {
                if a.status == "generating" {
                    a.status = "cancelled".into();
                    Some(a.clone())
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(a) = answer {
            if a.mode.starts_with("screen") { crate::screen_capture::answered(self, &a); }
            self.save_answer(&a)
        }
    }
    pub async fn start(self: &Arc<Self>, options: StartOptions) -> Result<Session> {
        let _guard = self.lifecycle.lock().unwrap();
        self.stop_inner()?;
        let settings = self.settings.lock().unwrap().clone();
        let provider = settings
            .providers
            .iter()
            .find(|p| p.id == settings.asr_provider && ["xfyun","tencent","dashscope","volcengine","openai-asr"].contains(&p.kind.as_str()))
            .context("请选择语音服务")?
            .clone();
        let secret = secrets::read(&provider.id)?;
        asr::signed_url(
            &provider,
            &secret,
            chrono::Utc::now().timestamp(),
            &new_id(),
        )?;
        let model = settings
            .providers
            .iter()
            .find(|p| p.id == settings.active_model && p.kind == "llm")
            .context("请选择回答模型")?;
        if !secrets::configured(&model.id) {
            bail!("请先在设置中保存回答模型 API Key")
        };
        let session = Session {
            id: new_id(),
            title: if options.title.trim().is_empty() {
                format!("面试 · {}", chrono::Local::now().format("%m-%d %H:%M"))
            } else {
                options.title
            },
            created_at: now_ms(),
            ended_at: None,
        };
        self.db.lock().unwrap().session(&session)?;
        let cancel = CancellationToken::new();
        *self.runtime.lock().unwrap() = Some(Runtime {
            session: session.clone(),
            cancel: cancel.clone(),
        });
        *self.buffer.lock().unwrap() = QuestionBuffer::default();
        self.emit(json!({"type":"sessionStarted","sessionId":session.id,"session":session}));
        let (frame_tx, mut frame_rx) = mpsc::channel::<audio::Frame>(150);
        let (notice_tx, mut notice_rx) = mpsc::unbounded_channel::<audio::Notice>();
        let (transcript_tx, mut transcript_rx) = mpsc::unbounded_channel::<Transcript>();
        let (meeting_tx, meeting_rx) = mpsc::channel(25);
        let (mic_tx, mic_rx) = mpsc::channel(25);
        let meeting_ready = Arc::new(AtomicBool::new(false));
        let mic_ready = Arc::new(AtomicBool::new(false));
        let meeting_voice = Arc::new(AtomicI64::new(now_ms()));
        let mic_voice = Arc::new(AtomicI64::new(now_ms()));
        audio::spawn(
            options.source.clone(),
            false,
            cancel.clone(),
            frame_tx.clone(),
            notice_tx.clone(),
        );
        if options.microphone {
            audio::spawn(
                options.source.clone(),
                true,
                cancel.clone(),
                frame_tx.clone(),
                notice_tx.clone(),
            );
        }
        tokio::spawn(asr::run(
            provider.clone(),
            secret.clone(),
            settings.network.clone(),
            session.id.clone(),
            "meeting".into(),
            meeting_rx,
            transcript_tx.clone(),
            notice_tx.clone(),
            meeting_voice.clone(),
            cancel.clone(),
            meeting_ready.clone(),
        ));
        if options.microphone {
            tokio::spawn(asr::run(
                provider,
                secret,
                settings.network.clone(),
                session.id.clone(),
                "microphone".into(),
                mic_rx,
                transcript_tx,
                notice_tx,
                mic_voice.clone(),
                cancel.clone(),
                mic_ready.clone(),
            ));
        } else {
            drop(mic_rx)
        }
        let core = self.clone();
        let id = session.id.clone();
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_millis(100));
            let mut last_meter = 0;
            let mut last_final = std::collections::HashMap::<String, String>::new();
            let mut congested = std::collections::HashMap::<String, UploadBacklog>::new();
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    Some(frame) = frame_rx.recv() => {
                        let (voice, tx, ready) = match frame.source.as_str() {
                            "meeting" => (&meeting_voice, &meeting_tx, &meeting_ready),
                            "microphone" => (&mic_voice, &mic_tx, &mic_ready),
                            _ => { core.status(&id, "audio", "采音返回了未知音轨，请重新开始", true); continue; }
                        };
                        if frame.level > 0.015 {
                            voice.store(frame.at, Ordering::Relaxed);
                            if frame.source == "meeting" { core.buffer.lock().unwrap().observe_voice(frame.at); }
                        }
                        if frame.at - last_meter > 80 {
                            core.emit(json!({"type":"level","sessionId":id,"source":frame.source,"level":frame.level}));
                            last_meter = frame.at;
                        }
                        let contains_audio = frame.level > 0.0;
                        match forward_audio(tx, frame.pcm, ready, &cancel) {
                            ForwardState::Sent => {
                                if congested.entry(frame.source.clone()).or_default().sent(tx.capacity(), tx.max_capacity()) { core.status(&id, &frame.source, "音频上传已恢复", false); }
                            },
                            ForwardState::Waiting | ForwardState::Stopped => {},
                            ForwardState::Congested => {
                                let (started, gap) = congested.entry(frame.source.clone()).or_default().dropped(contains_audio);
                                if started { core.status(&id, &frame.source, "语音上传暂时积压，正在等待发送恢复", true); }
                                if gap {
                                    let segment = new_id();
                                    let gap = Transcript { id: format!("{}-gap-{segment}", frame.source), session_id: id.clone(), source: frame.source.clone(), segment_id: segment, text: "【转写缺口：音频上传积压，部分声音未能及时发送】".into(), is_final: true, at: now_ms(), speech_end_at: frame.at };
                                    if !core.save_transcript(&gap) { continue; }
                                    core.emit(json!({"type":"transcript","sessionId":id,"transcript":gap}));
                                    if frame.source == "meeting" { *core.buffer.lock().unwrap() = QuestionBuffer::default(); }
                                }
                            },
                            ForwardState::Closed => {
                                ready.store(false, Ordering::Release);
                                core.status(&id, &frame.source, "转写任务已退出，请查看语音服务错误后重新开始", true);
                            }
                        }
                    },
                    Some(notice) = notice_rx.recv() => { core.status(&id, &notice.source, &notice.message, notice.error); },
                    Some(t) = transcript_rx.recv() => {
                        if !t.is_final && t.source=="meeting" {core.buffer.lock().unwrap().observe_partial(&t.segment_id,&t.text,now_ms());}
                        if t.is_final {
                            if last_final.get(&t.id) == Some(&t.text) { continue; }
                            last_final.insert(t.id.clone(), t.text.clone());
                            if !core.save_transcript(&t) { continue; }
                            if t.source == "meeting" {
                                let mut buffer = core.buffer.lock().unwrap();
                                if t.text.starts_with("【转写缺口") { *buffer = QuestionBuffer::default(); }
                                else { buffer.last_voice = buffer.last_voice.max(t.speech_end_at); buffer.push_final_at(&t.segment_id, &t.text,now_ms()); }
                            }
                        }
                        core.emit(json!({"type":"transcript","sessionId":id,"transcript":t}));
                    },
                    _ = tick.tick() => {
                        let pending = { let mut buffer = core.buffer.lock().unwrap(); if core.screen_priority.load(Ordering::Acquire) { *buffer=QuestionBuffer::default(); None } else { let pending=buffer.take(now_ms(),false,settings.silence_ms); buffer.expire(now_ms());pending } };
                        if let Some((qid, text, revision, end)) = pending {
                            if let Err(error) = core.launch_answer(&id, qid, text, revision, end, "short") { core.status(&id, "model", &format!("{error:#}"), true); }
                        }
                    }
                }
            }
        });
        Ok(session)
    }
    pub fn trigger(
        self: &Arc<Self>,
        text: Option<String>,
        mode: &str,
        question_id: Option<String>,
    ) -> Result<()> {
        let session = self
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .filter(|r| !r.cancel.is_cancelled())
            .map(|r| r.session.id.clone())
            .context("请先开始面试；若刚才结束失败，请重试结束")?;
        if let Some(qid) = question_id {
            let latest = self
                .db
                .lock()
                .unwrap()
                .answers(&session)?
                .into_iter()
                .rev()
                .find(|a| a.question_id == qid)
                .context("问题不存在")?;
            return self.launch_answer(
                &session,
                latest.question_id,
                latest.question,
                latest.revision + 1,
                latest.speech_end_at,
                if latest.mode.starts_with("screen-vision") {if mode=="detail" {"screen-vision-detail"}else{"screen-vision"}} else if latest.mode.starts_with("screen") { if mode=="detail" {"screen-detail"} else {"screen"} } else {mode},
            );
        }
        let pending = if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
            Some((new_id(), text, 1, now_ms()))
        } else {
            self.buffer.lock().unwrap().take(now_ms(), true, 0)
        };
        if let Some((qid, text, revision, end)) = pending {
            self.launch_answer(&session, qid, text, revision, end, mode)
        } else {
            let latest = self
                .db
                .lock()
                .unwrap()
                .answers(&session)?
                .pop()
                .context("还没有可以回答的问题，请输入问题或等待转写")?;
            self.launch_answer(
                &session,
                latest.question_id,
                latest.question,
                latest.revision + 1,
                latest.speech_end_at,
                if latest.mode.starts_with("screen-vision") {if mode=="detail" {"screen-vision-detail"}else{"screen-vision"}} else if latest.mode.starts_with("screen") { if mode=="detail" {"screen-detail"} else {"screen"} } else {mode},
            )
        }
    }
    pub(crate) fn answer_context(&self,settings:&Settings,session:&str,text:&str)->Result<(String,Vec<MaterialSource>)>{
        let (materials, transcripts) = { let db=self.db.lock().unwrap(); (db.materials()?, db.transcripts(session)?) };
        let relevant=documents::material_context(&materials,text,&settings.job);
        let history=transcripts.into_iter().rev().take(16).collect::<Vec<_>>().into_iter().rev().map(|t|format!("{}：{}",if t.source=="meeting"{"会议"}else{"本人"},t.text)).collect::<Vec<_>>().join("\n");
        Ok((format!("目标岗位：{}\n\n{}\n\n近期对话：\n{}",settings.job,relevant.text,history),relevant.sources))
    }
    pub(crate) fn launch_answer(
        self: &Arc<Self>,
        session: &str,
        qid: String,
        text: String,
        revision: u32,
        end: i64,
        mode: &str,
    ) -> Result<()> {
        let _guard=self.lifecycle.lock().unwrap();
        anyhow::ensure!(self.runtime.lock().unwrap().as_ref().is_some_and(|r|r.session.id==session&&!r.cancel.is_cancelled()),"面试已结束，请重新开始");
        if !mode.starts_with("screen") && self.screen_priority.load(Ordering::Acquire) { anyhow::bail!("请先完成或取消截图提问"); }
        self.cancel_answer_inner();
        let settings = self.settings.lock().unwrap().clone();
        let visual=if mode.starts_with("screen-vision"){
            let state=self.screen.lock().unwrap();
            anyhow::ensure!(state.session_id==session&&state.question_id==qid,"原截图已释放，请重新截图或修改题目");
            Some(state.vision_image.clone().context("原截图已释放，请重新截图或修改题目")?)
        }else{None};
        let selected=if visual.is_some(){&settings.screenshot_model}else{&settings.active_model};
        let p = settings
            .providers
            .iter()
            .find(|p| &p.id == selected && p.kind == "llm")
            .context("回答模型配置不存在")?
            .clone();
        let secret = if visual.is_some(){secrets::read(&p.id).unwrap_or(Secret{api_key:String::new(),secret_key:String::new()})}else{secrets::read(&p.id)?};
        let (context, sources) = self.answer_context(&settings,session,if visual.is_some(){""}else{&text})?;
        if mode.starts_with("screen") { self.screen_priority.store(true,Ordering::Release); }
        let cancel = CancellationToken::new();
        *self.answer_cancel.lock().unwrap() = cancel.clone();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let answer = Answer {
            sources,
            id: new_id(),
            session_id: session.into(),
            question_id: qid,
            revision,
            question: text,
            text: String::new(),
            status: "generating".into(),
            mode: mode.into(),
            created_at: now_ms(),
            speech_end_at: end,
            trigger_at: now_ms(),
            request_at: 0,
            first_token_ms: None,
            first_sentence_ms: None,
        };
        *self.active_answer.lock().unwrap() = Some(answer.clone());
        self.save_answer(&answer);
        let core = self.clone();
        // Commands and global shortcuts can enter here on the native UI thread.
        // Dispatch on Tauri's runtime instead of requiring a Tokio context on the caller.
        tauri::async_runtime::spawn(async move {
            if let Some(image)=visual {
                crate::vision_answer::generate(core,answer,p,secret,settings,context,cancel,generation,image).await;
                return;
            }
            llm::generate(
                core,
                answer,
                p,
                secret,
                settings.network,
                context,
                cancel,
                generation,
                settings.answer_words,
            )
            .await;
        });
        Ok(())
    }
}

#[cfg(test)]
mod native_live_tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires saved cloud credentials, speakers and an explicit synthetic WAV fixture"]
    async fn process_capture_routes_audio_to_asr_and_answer() {
        let fixture = std::env::var("INTERVIEW_COPILOT_TEST_WAV").expect("set synthetic WAV path");
        let playback = format!("Start-Sleep -Seconds 3; $player=New-Object System.Media.SoundPlayer '{}'; $player.PlaySync(); Start-Sleep -Seconds 12", fixture.replace('\'', "''"));
        let mut player = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &playback])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let app_data = std::path::PathBuf::from(std::env::var("APPDATA").unwrap())
            .join("local.interview.copilot");
        let settings = Database::open(&app_data.join("interview.sqlite3"))
            .unwrap()
            .settings()
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let core = Core::open(&directory.path().join("test.sqlite3")).unwrap();
        core.db.lock().unwrap().save_settings(&settings).unwrap();
        *core.settings.lock().unwrap() = settings;
        let session = core
            .start(StartOptions {
                source: AudioSource {
                    process_capture_supported: None,
                    id: "controlled-test".into(),
                    name: "Synthetic speech player".into(),
                    kind: "process".into(),
                    pid: Some(player.id()),
                    recommended: false,
                },
                microphone: false,
                title: "Synthetic native integration test".into(),
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(18)).await;
        let before = core.status_events.lock().unwrap().clone();
        core.stop().unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let transcripts = core.db.lock().unwrap().transcripts(&session.id).unwrap();
        let answers = core.db.lock().unwrap().answers(&session.id).unwrap();
        let after = core.status_events.lock().unwrap().clone();
        let _ = player.kill();
        let _ = player.wait();
        println!(
            "{}",
            json!({"beforeStop":before,"afterStop":after,"transcripts":transcripts.iter().map(|t| &t.text).collect::<Vec<_>>(),"answers":answers.iter().map(|a| json!({"question":a.question,"revision":a.revision,"status":a.status,"text":a.text,"firstSentenceMs":a.first_sentence_ms})).collect::<Vec<_>>()})
        );
        assert!(
            before
                .iter()
                .all(|e| !e["message"].as_str().unwrap_or("").contains("音频发送队列")),
            "native routing failed"
        );
        assert!(
            !transcripts.is_empty(),
            "no final transcription from controlled player"
        );
        let latest = answers.last().expect("no answer");
        assert!(
            latest.question.contains("缓存的实现原理")
                && latest.question.contains("如何处理缓存穿透"),
            "answer prompt lost a spoken fragment: {}",
            latest.question
        );
        assert!(
            answers.iter().any(|a| a.status == "complete"),
            "no complete answer"
        );
    }
}

#[cfg(test)]
mod queue_regressions {
    use super::*;
    #[test]
    fn a_congestion_episode_does_not_repeatedly_clear_the_question() {
        let mut backlog = UploadBacklog::default();
        assert_eq!(backlog.dropped(false), (true, false));
        for _ in 0..30 {
            assert!(!backlog.sent(1, 25), "one slot is not a recovered queue");
            assert_eq!(
                backlog.dropped(false),
                (false, false),
                "dropped silence must not discard confirmed words"
            );
        }
        assert_eq!(backlog.dropped(true), (false, true));
        assert!(!backlog.sent(2, 25));
        assert_eq!(
            backlog.dropped(true),
            (false, false),
            "one real gap per episode"
        );
        assert!(backlog.sent(20, 25));
        assert_eq!(backlog.dropped(true), (true, true));
    }

    #[tokio::test]
    async fn connecting_drops_audio_without_filling_the_queue() {
        let (tx, mut rx) = mpsc::channel(1);
        let ready = AtomicBool::new(false);
        let cancel = CancellationToken::new();
        for _ in 0..200 {
            assert_eq!(
                forward_audio(&tx, vec![0; 1280], &ready, &cancel),
                ForwardState::Waiting
            );
        }
        assert!(rx.try_recv().is_err());
        ready.store(true, Ordering::Release);
        assert_eq!(
            forward_audio(&tx, vec![1; 1280], &ready, &cancel),
            ForwardState::Sent
        );
        assert_eq!(rx.recv().await.unwrap()[0], 1);
    }
    #[tokio::test]
    async fn shutdown_does_not_turn_a_closed_receiver_into_a_network_error() {
        let (tx, rx) = mpsc::channel(1);
        let ready = AtomicBool::new(true);
        let cancel = CancellationToken::new();
        cancel.cancel();
        drop(rx);
        assert_eq!(
            forward_audio(&tx, vec![], &ready, &cancel),
            ForwardState::Stopped
        );
    }
    #[tokio::test]
    async fn stopped_asr_keeps_its_original_error_instead_of_queue_noise() {
        let (tx, rx) = mpsc::channel(1);
        let ready = AtomicBool::new(false);
        drop(rx);
        assert_eq!(
            forward_audio(&tx, vec![], &ready, &CancellationToken::new()),
            ForwardState::Waiting
        );
    }
    #[tokio::test]
    async fn congestion_and_worker_exit_are_distinct() {
        let (tx, rx) = mpsc::channel(1);
        let ready = AtomicBool::new(true);
        let cancel = CancellationToken::new();
        assert_eq!(
            forward_audio(&tx, vec![], &ready, &cancel),
            ForwardState::Sent
        );
        assert_eq!(
            forward_audio(&tx, vec![], &ready, &cancel),
            ForwardState::Congested
        );
        drop(rx);
        assert_eq!(
            forward_audio(&tx, vec![], &ready, &cancel),
            ForwardState::Closed
        );
    }
}


#[cfg(test)]
mod manual_answer_regressions {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread, time::{Duration, Instant}};

    struct FixtureCredential(String);
    impl Drop for FixtureCredential {
        fn drop(&mut self) {
            let target: Vec<u16> = format!("InterviewCopilot/{}", self.0).encode_utf16().chain(Some(0)).collect();
            unsafe {
                let _ = windows::Win32::Security::Credentials::CredDeleteW(
                    windows::core::PCWSTR(target.as_ptr()),
                    windows::Win32::Security::Credentials::CRED_TYPE_GENERIC, None,
                );
            }
        }
    }

    fn completed(core: &Core, count: usize) -> Vec<Answer> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let answers = core.db.lock().unwrap().answers("manual-runtime-fixture").unwrap();
            if answers.len() == count && answers.last().is_some_and(|a| a.status != "generating") && !core.screen_priority.load(Ordering::Acquire) {
                assert_eq!(answers.last().unwrap().status, "complete");
                return answers;
            }
            assert!(Instant::now() < deadline, "local model generation did not finish");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn manual_regenerate_and_shortcut_dispatch_without_a_tokio_context() {
        assert!(tokio::runtime::Handle::try_current().is_err());
        let directory = tempfile::tempdir().unwrap();
        let core = Core::open(&directory.path().join("manual.db")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut served = 0;
            while served < 7 && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        // The polling listener is nonblocking; explicitly restore blocking reads
                        // on accepted Windows fixture sockets before waiting for the HTTP request.
                        socket.set_nonblocking(false).unwrap();
                        socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                        let mut request = [0; 16384];
                        let read = socket.read(&mut request).unwrap();
                        assert!(String::from_utf8_lossy(&request[..read]).starts_with("POST /v1/chat/completions "));
                        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"本地回归测试答案。\"}}]}\n\ndata: [DONE]\n\n";
                        let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                        socket.write_all(reply.as_bytes()).unwrap();
                        served += 1;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                    Err(error) => panic!("local fixture listener failed: {error}"),
                }
            }
            assert_eq!(served, 7);
        });
        let credential = FixtureCredential(format!("test-manual-runtime-{}", new_id()));
        secrets::save(&credential.0, &Secret { api_key: "local-fixture-key".into(), secret_key: String::new() }).unwrap();
        let mut settings = Settings::default();
        let mut provider = settings.providers.iter().find(|p| p.kind == "llm").unwrap().clone();
        provider.id = credential.0.clone();
        provider.base_url = format!("http://{address}/v1");
        settings.active_model = provider.id.clone();
        settings.providers = vec![provider];
        settings.network = Network { mode: "direct".into(), url: String::new() };
        *core.settings.lock().unwrap() = settings;
        let session = Session { id: "manual-runtime-fixture".into(), title: "local fixture".into(), created_at: now_ms(), ended_at: None };
        core.db.lock().unwrap().session(&session).unwrap();
        *core.runtime.lock().unwrap() = Some(Runtime { session, cancel: CancellationToken::new() });

        // The same synchronous entry serves the IPC button and native shortcut callbacks.
        core.trigger(Some("什么是缓存？".into()), "short", None).unwrap();
        let first = completed(&core, 1).pop().unwrap();
        assert_eq!(first.text, "本地回归测试答案。");
        core.trigger(None, "detail", Some(first.question_id.clone())).unwrap();
        let second = completed(&core, 2).pop().unwrap();
        assert_eq!(second.question_id, first.question_id);
        assert_eq!(second.revision, 2);
        core.trigger(None, "short", None).unwrap();
        let third = completed(&core, 3).pop().unwrap();
        assert_eq!(third.question_id, first.question_id);
        assert_eq!(third.revision, 3);
        *core.screen.lock().unwrap()=crate::screen_capture::CaptureState{job_id:"screen-fixture-job".into(),session_id:"manual-runtime-fixture".into(),stage:"ready".into(),text:"if (a <= b) return a;".into(),..Default::default()};
        core.screen_priority.store(true,Ordering::Release);
        assert!(core.trigger(Some("voice must wait".into()),"short",None).is_err());
        crate::screen_capture::submit(&core,"screen-fixture-job","if (a <= b) return a;".into()).unwrap();
        let fourth=completed(&core,4).pop().unwrap();assert_eq!(fourth.mode,"screen");assert!(!core.screen_priority.load(Ordering::Acquire));
        core.trigger(None,"detail",Some(fourth.question_id.clone())).unwrap();let fifth=completed(&core,5).pop().unwrap();assert_eq!(fifth.mode,"screen-detail");assert_eq!(fifth.question_id,fourth.question_id);
        core.trigger(None,"short",None).unwrap();let sixth=completed(&core,6).pop().unwrap();assert_eq!(sixth.mode,"screen");
        crate::screen_capture::correct(&core,sixth.question_id.clone(),"if (a >= b) return b;".into()).unwrap();let seventh=completed(&core,7).pop().unwrap();assert_eq!(seventh.revision,4);assert_eq!(seventh.question,"if (a >= b) return b;");assert_eq!(seventh.mode,"screen");assert!(!core.screen_priority.load(Ordering::Acquire));
        assert!(core.db.lock().unwrap().export("manual-runtime-fixture").unwrap().contains("来源：屏幕提问"));
        core.stop().unwrap();assert!(crate::screen_capture::submit(&core,"screen-fixture-job","late".into()).is_err());assert_eq!(core.screen.lock().unwrap().stage,"idle");
        assert!(tokio::runtime::Handle::try_current().is_err());
        server.join().unwrap();
        core.stop().unwrap();
    }
    #[test]
    fn split_asr_sentence_regenerates_one_complete_question_and_discards_the_old_stream(){
        let directory=tempfile::tempdir().unwrap();let core=Core::open(&directory.path().join("compound.db")).unwrap();
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let address=listener.local_addr().unwrap();
        let (first_seen,seen)=std::sync::mpsc::channel();let (release_old,old_release)=std::sync::mpsc::channel();
        let server=thread::spawn(move||{
            let deadline=Instant::now()+Duration::from_secs(15);let mut requests=Vec::new();let mut old_release=Some(old_release);let mut old_worker=None;
            while requests.len()<2&&Instant::now()<deadline{
                let(mut socket,_)=match listener.accept(){Ok(value)=>value,Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{thread::sleep(Duration::from_millis(5));continue;},Err(e)=>panic!("fixture accept failed: {e}")};
                socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();let mut bytes=Vec::new();let mut chunk=[0;4096];let header_end;
                loop{let n=socket.read(&mut chunk).unwrap();assert!(n>0);bytes.extend_from_slice(&chunk[..n]);if let Some(at)=bytes.windows(4).position(|w|w==b"\r\n\r\n"){header_end=at+4;break;}}
                let headers=String::from_utf8_lossy(&bytes[..header_end]);let length:usize=headers.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|v|v.trim().parse().unwrap())).unwrap();while bytes.len()<header_end+length{let n=socket.read(&mut chunk).unwrap();assert!(n>0);bytes.extend_from_slice(&chunk[..n]);}
                let request:Value=serde_json::from_slice(&bytes[header_end..header_end+length]).unwrap();requests.push(request["messages"][1]["content"].as_str().unwrap().to_owned());
                let text=if requests.len()==1{"迟到的第一段答案"}else{"缓存原理与缓存穿透的完整回答"};let body=format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":text}}]}));let headers=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());socket.write_all(headers.as_bytes()).unwrap();
                if requests.len()==1{let release=old_release.take().unwrap();old_worker=Some(thread::spawn(move||{let _=release.recv_timeout(Duration::from_secs(10));let _=socket.write_all(body.as_bytes());}));first_seen.send(()).unwrap();}else{socket.write_all(body.as_bytes()).unwrap();}
            }
            if let Some(worker)=old_worker{worker.join().unwrap();}assert_eq!(requests.len(),2);requests
        });
        let credential=FixtureCredential(format!("test-compound-runtime-{}",new_id()));secrets::save(&credential.0,&Secret{api_key:"fixture-compound-key".into(),secret_key:String::new()}).unwrap();let mut settings=Settings::default();let mut provider=settings.providers.iter().find(|p|p.kind=="llm").unwrap().clone();provider.id=credential.0.clone();provider.base_url=format!("http://{address}/v1");settings.active_model=provider.id.clone();settings.providers=vec![provider];settings.network=Network{mode:"direct".into(),url:String::new()};*core.settings.lock().unwrap()=settings;
        let session=Session{id:"manual-runtime-fixture".into(),title:"synthetic compound".into(),created_at:now_ms(),ended_at:None};core.db.lock().unwrap().session(&session).unwrap();*core.runtime.lock().unwrap()=Some(Runtime{session,cancel:CancellationToken::new()});
        let first={let mut q=core.buffer.lock().unwrap();q.observe_voice(1000);q.push_final_at("first","请介绍一下缓存的实现原理。",1100);q.take(1800,false,700).unwrap()};core.launch_answer("manual-runtime-fixture",first.0.clone(),first.1,first.2,first.3,"short").unwrap();seen.recv_timeout(Duration::from_secs(10)).unwrap();
        let next={let mut q=core.buffer.lock().unwrap();q.observe_voice(2200);q.push_final_at("second","如何处理缓存穿透？",2300);q.take(3000,false,700).unwrap()};assert_eq!(first.0,next.0);core.launch_answer("manual-runtime-fixture",next.0.clone(),next.1,next.2,next.3,"short").unwrap();let answers=completed(&core,2);assert_eq!(answers[0].status,"cancelled");assert_eq!(answers[1].status,"complete");assert_eq!(answers[1].question_id,first.0);assert_eq!(answers[1].revision,2);assert_eq!(answers[1].text,"缓存原理与缓存穿透的完整回答");release_old.send(()).unwrap();let requests=server.join().unwrap();assert!(requests[1].contains("实现原理。如何处理缓存穿透"));assert_eq!(core.active_answer.lock().unwrap().as_ref().unwrap().question_id,next.0);core.stop().unwrap();
    }

}


#[cfg(test)]
mod history_guard_tests {
    use super::*;
    fn fixture_transcript(session: &str) -> Transcript {
        Transcript { id: format!("t-{session}"), session_id: session.into(), source: "meeting".into(), segment_id: "segment".into(), text: "保留转写".into(), is_final: true, at: 1, speech_end_at: 1 }
    }

    #[test]
    fn active_session_cannot_be_deleted_and_late_answers_cannot_restore_deleted_history() {
        let directory = tempfile::tempdir().unwrap();
        let core = Core::open(&directory.path().join("history.db")).unwrap();
        let session = Session { id: "history-fixture".into(), title: "fixture".into(), created_at: 1, ended_at: None };
        core.db.lock().unwrap().session(&session).unwrap();
        *core.runtime.lock().unwrap() = Some(Runtime { session, cancel: CancellationToken::new() });
        assert!(core.delete_session("history-fixture").is_err());
        assert_eq!(core.db.lock().unwrap().sessions().unwrap().len(), 1);
        core.db.lock().unwrap().transcript(&fixture_transcript("history-fixture")).unwrap();
        core.stop().unwrap();
        core.delete_session("history-fixture").unwrap();
        let answer: Answer = serde_json::from_value(json!({"id":"late-answer","sessionId":"history-fixture","questionId":"q","revision":1,"question":"问题","text":"迟到答案","status":"complete","mode":"short","createdAt":1,"speechEndAt":1,"triggerAt":1,"requestAt":1,"firstTokenMs":null,"firstSentenceMs":null})).unwrap();
        core.save_answer(&answer);
        let transcript = Transcript { id: "late-transcript".into(), session_id: "history-fixture".into(), source: "meeting".into(), segment_id: "late".into(), text: "迟到转写".into(), is_final: true, at: 1, speech_end_at: 1 };
        assert!(!core.save_transcript(&transcript));
        assert!(core.db.lock().unwrap().transcripts("history-fixture").unwrap().is_empty());
        assert!(core.db.lock().unwrap().sessions().unwrap().is_empty());
        assert!(core.db.lock().unwrap().answers("history-fixture").unwrap().is_empty());
    }
    #[test]
    fn batch_including_active_session_is_rejected_before_deleting_any_record() {
        let directory = tempfile::tempdir().unwrap();
        let core = Core::open(&directory.path().join("history.db")).unwrap();
        let active = Session { id: "active".into(), title: "active".into(), created_at: 1, ended_at: None };
        let old = Session { id: "old".into(), title: "old".into(), created_at: 1, ended_at: Some(2) };
        core.db.lock().unwrap().session(&active).unwrap();
        core.db.lock().unwrap().session(&old).unwrap();
        *core.runtime.lock().unwrap() = Some(Runtime { session: active, cancel: CancellationToken::new() });
        let ids = vec!["old".to_string(), "active".to_string()];
        assert!(core.delete_sessions(&ids).is_err());
        assert_eq!(core.db.lock().unwrap().sessions().unwrap().len(), 2);
        assert!(core.deleted_sessions.lock().unwrap().is_empty());
        core.db.lock().unwrap().transcript(&fixture_transcript("active")).unwrap();
        core.stop().unwrap();
        core.delete_sessions(&ids).unwrap();
        assert!(core.db.lock().unwrap().sessions().unwrap().is_empty());
        assert!(ids.iter().all(|id| core.deleted_sessions.lock().unwrap().contains(id)));
    }

    #[test]
    fn stopping_an_empty_interview_discards_it_and_blocks_late_writes() {
        let directory = tempfile::tempdir().unwrap();
        let core = Core::open(&directory.path().join("empty.db")).unwrap();
        let session = Session { id: "empty".into(), title: "empty".into(), created_at: 1, ended_at: None };
        core.db.lock().unwrap().session(&session).unwrap();
        *core.runtime.lock().unwrap() = Some(Runtime { session, cancel: CancellationToken::new() });
        assert!(core.db.lock().unwrap().history_sessions().unwrap().is_empty());
        core.stop().unwrap();
        assert!(core.db.lock().unwrap().sessions().unwrap().is_empty());
        assert!(!core.save_transcript(&fixture_transcript("empty")));
        assert!(core.db.lock().unwrap().transcripts("empty").unwrap().is_empty());
    }
    #[test]
    fn stopping_an_interview_with_only_transcription_keeps_its_history() {
        let directory = tempfile::tempdir().unwrap();
        let core = Core::open(&directory.path().join("text.db")).unwrap();
        let session = Session { id: "text-only".into(), title: "text".into(), created_at: 1, ended_at: None };
        core.db.lock().unwrap().session(&session).unwrap();
        core.db.lock().unwrap().transcript(&fixture_transcript("text-only")).unwrap();
        *core.runtime.lock().unwrap() = Some(Runtime { session, cancel: CancellationToken::new() });
        core.stop().unwrap();
        let sessions = core.db.lock().unwrap().history_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].ended_at.is_some());
        assert_eq!(core.db.lock().unwrap().transcripts("text-only").unwrap().len(), 1);
    }

    #[test]
    fn failed_end_preserves_a_cancelled_session_for_retry_without_losing_transcripts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("retry.db");
        let core = Core::open(&path).unwrap();
        let session = Session { id: "retry-end".into(), title: "fixture".into(), created_at: 1, ended_at: None };
        core.db.lock().unwrap().session(&session).unwrap();
        core.db.lock().unwrap().transcript(&fixture_transcript(&session.id)).unwrap();
        *core.runtime.lock().unwrap() = Some(Runtime { session, cancel: CancellationToken::new() });
        let fixture = rusqlite::Connection::open(&path).unwrap();
        fixture.execute_batch("CREATE TRIGGER reject_finish BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture end failure'); END;").unwrap();
        assert!(core.stop().is_err());
        assert!(core.runtime.lock().unwrap().as_ref().unwrap().cancel.is_cancelled());
        assert!(core.trigger(Some("must not restart generation".into()), "short", None).is_err());
        assert_eq!(core.db.lock().unwrap().transcripts("retry-end").unwrap().len(), 1);
        fixture.execute_batch("DROP TRIGGER reject_finish;").unwrap();
        core.stop().unwrap();
        assert!(core.runtime.lock().unwrap().is_none());
        assert!(core.db.lock().unwrap().history_sessions().unwrap()[0].ended_at.is_some());
        assert_eq!(core.db.lock().unwrap().transcripts("retry-end").unwrap().len(), 1);
    }

}

#[cfg(test)]mod backup_guard_tests{
 use super::*;
 #[test]fn backup_and_restore_require_idle_and_a_durable_rollback_file(){
  let core=Core::open(Path::new(":memory:")).unwrap();let dir=tempfile::tempdir().unwrap();let path=dir.path().join("before.cuvilo-backup");
  let material=Material{id:"original".into(),title:"fixture".into(),kind:"project".into(),text:"retained".into(),enabled:true,updated_at:1};core.db.lock().unwrap().save_material(&material).unwrap();
  let mut data=core.db.lock().unwrap().data_backup().unwrap();data.materials[0].id="replacement".into();
  *core.runtime.lock().unwrap()=Some(Runtime{session:Session{id:"active".into(),title:"fixture".into(),created_at:1,ended_at:None},cancel:CancellationToken::new()});
  assert!(core.create_data_backup(&path).is_err());assert!(core.restore_data_backup(&data,&path).is_err());assert!(!path.exists());
  *core.runtime.lock().unwrap()=None;
  assert!(core.restore_data_backup(&data,&dir.path().join("missing/before.cuvilo-backup")).is_err());assert_eq!(core.db.lock().unwrap().materials().unwrap()[0].id,"original");
  core.restore_data_backup(&data,&path).unwrap();assert_eq!(crate::data_backup::DataBackup::read(&path).unwrap().materials[0].id,"original");assert_eq!(core.db.lock().unwrap().materials().unwrap()[0].id,"replacement");
 }
 #[test]fn restoring_cannot_accept_late_transcripts_from_replaced_or_restored_sessions(){
  let core=Core::open(Path::new(":memory:")).unwrap();let directory=tempfile::tempdir().unwrap();
  let old=Session{id:"old".into(),title:"fixture".into(),created_at:1,ended_at:Some(2)};core.db.lock().unwrap().session(&old).unwrap();
  let mut next=core.db.lock().unwrap().data_backup().unwrap();next.sessions[0].id="restored".into();
  core.restore_data_backup(&next,&directory.path().join("rollback.cuvilo-backup")).unwrap();
  for id in ["old","restored"]{let t=Transcript{id:format!("late-{id}"),session_id:id.into(),source:"meeting".into(),segment_id:"late".into(),text:"late fixture".into(),is_final:true,at:3,speech_end_at:3};assert!(!core.save_transcript(&t));}
  assert!(core.db.lock().unwrap().transcripts("old").unwrap().is_empty());assert!(core.db.lock().unwrap().transcripts("restored").unwrap().is_empty());
 }

}

#[cfg(test)]mod configured_warning_tests{
 use super::*;
 struct Cleanup(Vec<String>);impl Drop for Cleanup{fn drop(&mut self){for id in &self.0{let _=secrets::remove(id);}}}
 #[test]fn configured_aliyun_services_without_app_ids_do_not_show_recovery_warning(){
  let core=Core::open(Path::new(":memory:")).unwrap();let mut settings=Settings::for_first_run();let mut cleanup=Cleanup(Vec::new());
  settings.providers.retain(|p|p.id=="qwen"||p.id=="dashscope");
  for p in &mut settings.providers{let old=p.id.clone();p.id=format!("test-warning-{}",new_id());cleanup.0.push(p.id.clone());secrets::save(&p.id,&Secret{api_key:"fixture-warning-key".into(),secret_key:String::new()}).unwrap();if old=="qwen"{settings.active_model=p.id.clone();}else{settings.asr_provider=p.id.clone();}assert!(p.app_id.is_empty());}
  *core.settings.lock().unwrap()=settings;let snapshot=core.snapshot().unwrap();assert!(snapshot["warnings"].as_array().unwrap().is_empty());assert_eq!(snapshot["configured"].as_array().unwrap().len(),2);
 }
}

#[cfg(test)]mod project_review_snapshot_progress_tests{
 use super::*;
 fn answer()->Answer{Answer{sources:vec![],id:"answer".into(),session_id:"session".into(),question_id:"question".into(),revision:1,question:"synthetic question".into(),text:String::new(),status:"generating".into(),mode:"short".into(),created_at:1,speech_end_at:1,trigger_at:1,request_at:1,first_token_ms:None,first_sentence_ms:None}}
 #[test]fn snapshot_uses_live_answer_and_does_not_resurrect_it_after_session_ends(){
  let dir=tempfile::tempdir().unwrap();let core=Core::open(&dir.path().join("snapshot.db")).unwrap();core.settings.lock().unwrap().providers.clear();let session=Session{id:"session".into(),title:"synthetic".into(),created_at:1,ended_at:None};core.db.lock().unwrap().session(&session).unwrap();*core.runtime.lock().unwrap()=Some(Runtime{session,cancel:CancellationToken::new()});
  let mut live=answer();core.db.lock().unwrap().answer(&live).unwrap();live.text="already streamed".into();*core.active_answer.lock().unwrap()=Some(live.clone());
  let snapshot=core.snapshot().unwrap();assert_eq!(snapshot["answers"][0]["text"],"already streamed");assert_eq!(snapshot["answers"].as_array().unwrap().len(),1);
  live.status="complete".into();live.text="just completed".into();*core.active_answer.lock().unwrap()=Some(live);assert_eq!(core.snapshot().unwrap()["answers"][0]["text"],"just completed");
  *core.runtime.lock().unwrap()=None;assert!(core.snapshot().unwrap()["answers"].as_array().unwrap().is_empty());
 }
}
