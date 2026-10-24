use crate::settings_copies::SettingsCopies;
use crate::types::*;
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Serialize};
use std::path::{Path, PathBuf};
pub struct Database {
    connection: Connection,
    path: Option<PathBuf>,
    copies: Option<SettingsCopies>,
    notice: std::sync::Mutex<Option<String>>,
}
impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        let integrity: String = c
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .context("本地数据库已损坏，已停止写入；请恢复数据库，原数据未覆盖")?;
        anyhow::ensure!(
            integrity == "ok",
            "本地数据库校验失败，已停止写入，原数据未覆盖"
        );
        // A single application connection serializes every write; a rollback journal avoids shared WAL state.
        c.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS transcripts_session ON transcripts(session_id,at); CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS answers_session ON answers(session_id,at); CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1;")?;
        Ok(Self {
            connection: c,
            path: (path != Path::new(":memory:")).then(|| path.to_path_buf()),
            copies: (path != Path::new(":memory:")).then(|| SettingsCopies::for_database(path)),
            notice: std::sync::Mutex::new(None),
        })
    }
    fn put<T: Serialize>(&self, table: &str, id: &str, value: &T) -> Result<()> {
        self.connection.execute(&format!("INSERT INTO {table}(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data"),params![id,serde_json::to_string(value)?])?;
        Ok(())
    }
    fn all<T: DeserializeOwned>(&self, table: &str) -> Result<Vec<T>> {
        let mut s = self
            .connection
            .prepare(&format!("SELECT data FROM {table} ORDER BY rowid DESC"))?;
        let rows = s.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn settings(&self) -> Result<Settings> {
        let row = self
            .connection
            .query_row("SELECT data FROM settings WHERE id='main'", [], |r| {
                r.get::<_, String>(0)
            });
        let malformed = match row {
            Ok(data) => match serde_json::from_str::<Settings>(&data) {
                Ok(settings) => {
                    if let Some(copies) = &self.copies {
                        copies.save(&settings)?;
                    }
                    return Ok(settings);
                }
                Err(error) => Some(error),
            },
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(error).context("读取配置数据库失败，未使用默认值覆盖"),
        };
        if let Some(settings) = self
            .copies
            .as_ref()
            .map(SettingsCopies::recover)
            .transpose()?
            .flatten()
        {
            self.save_settings(&settings)?;
            *self.notice.lock().unwrap() = Some("数据库配置记录缺失或损坏，已从本地恢复副本恢复；服务密钥仍使用 Windows 凭据管理器。".into());
            return Ok(settings);
        }
        if let Some(error) = malformed {
            return Err(error).context("已保存配置无法解析，已保留原数据，未加载默认值");
        }
        Ok(Settings::for_first_run())
    }
    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        self.put("settings", "main", s)?;
        if let Some(copies) = &self.copies {
            copies.save(s)?;
        }
        self.checkpoint()?;
        Ok(())
    }
    pub fn checkpoint(&self) -> Result<()> {
        self.connection.cache_flush()?;
        if let Some(path) = &self.path {
            let integrity: String = self
                .connection
                .query_row("PRAGMA quick_check", [], |row| row.get(0))?;
            anyhow::ensure!(integrity == "ok", "数据库校验失败，未覆盖上一次完整备份");
            let temporary = path.with_extension(format!("{}.backup.tmp", crate::types::new_id()));
            let result = (|| -> Result<()> {
                self.connection.backup("main", &temporary, None)?;
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&temporary)?
                    .sync_all()?;
                std::fs::rename(&temporary, path.with_extension("last-good.sqlite3"))?;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temporary);
            }
            result.context("完整数据库恢复副本保存失败")?;
        }
        Ok(())
    }
    pub fn data_backup(&self) -> Result<crate::data_backup::DataBackup> {
        let backup=crate::data_backup::DataBackup { format:"cuvilo-data-backup".into(),version:1,created_at:now_ms(),materials:self.all("materials")?,sessions:self.all("sessions")?,transcripts:self.all("transcripts")?,answers:self.all("answers")? };
        backup.validate()?; Ok(backup)
    }
    pub fn restore_data(&mut self, data: &crate::data_backup::DataBackup) -> Result<()> {
        data.validate()?;
        let tx=self.connection.transaction()?;
        tx.execute_batch("DELETE FROM answers;DELETE FROM transcripts;DELETE FROM sessions;DELETE FROM materials;")?;
        for m in data.materials.iter().rev(){tx.execute("INSERT INTO materials(id,data) VALUES(?1,?2)",params![m.id,serde_json::to_string(m)?])?;}
        for s in data.sessions.iter().rev(){tx.execute("INSERT INTO sessions(id,data) VALUES(?1,?2)",params![s.id,serde_json::to_string(s)?])?;}
        for t in data.transcripts.iter().rev(){tx.execute("INSERT INTO transcripts(id,session_id,at,data) VALUES(?1,?2,?3,?4)",params![t.id,t.session_id,t.at,serde_json::to_string(t)?])?;}
        for a in data.answers.iter().rev(){tx.execute("INSERT INTO answers(id,session_id,at,data) VALUES(?1,?2,?3,?4)",params![a.id,a.session_id,a.created_at,serde_json::to_string(a)?])?;}
        tx.commit()?; Ok(())
    }
    pub fn take_notice(&self) -> Option<String> {
        self.notice.lock().unwrap().take()
    }
    pub fn session(&self, s: &Session) -> Result<()> {
        self.put("sessions", &s.id, s)
    }
    pub fn sessions(&self) -> Result<Vec<Session>> {
        self.all("sessions")
    }
    pub fn history_sessions(&self) -> Result<Vec<Session>> {
        let mut statement = self.connection.prepare("SELECT s.data FROM sessions s WHERE EXISTS(SELECT 1 FROM transcripts t WHERE t.session_id=s.id) OR EXISTS(SELECT 1 FROM answers a WHERE a.session_id=s.id) ORDER BY s.rowid DESC")?;
        let rows = statement.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn finish_session(&mut self, session: &Session) -> Result<bool> {
        let tx = self.connection.transaction()?;
        let keep: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM transcripts WHERE session_id=?1) OR EXISTS(SELECT 1 FROM answers WHERE session_id=?1)", [&session.id], |row| row.get(0))?;
        if keep {
            tx.execute("INSERT INTO sessions(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![session.id, serde_json::to_string(session)?])?;
        } else {
            tx.execute("DELETE FROM sessions WHERE id=?1", [&session.id])?;
        }
        tx.commit()?;
        Ok(keep)
    }
    pub fn delete_session(&mut self, id: &str) -> Result<()> {
        self.delete_sessions(&[id.to_string()])
    }
    pub fn delete_sessions(&mut self, ids: &[String]) -> Result<()> {
        anyhow::ensure!(!ids.is_empty(), "请先选择记录");
        let transaction = self.connection.transaction()?;
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if !seen.insert(id) { continue; }
            transaction.execute("DELETE FROM answers WHERE session_id=?1", [id])?;
            transaction.execute("DELETE FROM transcripts WHERE session_id=?1", [id])?;
            if transaction.execute("DELETE FROM sessions WHERE id=?1", [id])? == 0 {
                anyhow::bail!("部分会话不存在或已删除，请刷新后重试");
            }
        }
        transaction.commit()?;
        Ok(())
    }
    pub fn transcript(&self, t: &Transcript) -> Result<()> {
        self.connection.execute("INSERT INTO transcripts(id,session_id,at,data) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![t.id,t.session_id,t.at,serde_json::to_string(t)?])?;
        Ok(())
    }
    pub fn answer(&self, a: &Answer) -> Result<()> {
        self.connection.execute("INSERT INTO answers(id,session_id,at,data) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![a.id,a.session_id,a.created_at,serde_json::to_string(a)?])?;
        Ok(())
    }
    pub fn transcripts(&self, id: &str) -> Result<Vec<Transcript>> {
        self.for_session("transcripts", id)
    }
    pub fn answers(&self, id: &str) -> Result<Vec<Answer>> {
        self.for_session("answers", id)
    }
    fn for_session<T: DeserializeOwned>(&self, table: &str, id: &str) -> Result<Vec<T>> {
        let mut s = self.connection.prepare(&format!(
            "SELECT data FROM {table} WHERE session_id=?1 ORDER BY at,rowid"
        ))?;
        let rows = s.query_map([id], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn materials(&self) -> Result<Vec<Material>> {
        self.all("materials")
    }
    pub fn save_material(&self, m: &Material) -> Result<()> {
        self.put("materials", &m.id, m)
    }
    pub fn delete_material(&mut self, id: &str) -> Result<()> {
        self.delete_materials(&[id.to_string()])
    }
    pub fn delete_materials(&mut self, ids: &[String]) -> Result<()> {
        anyhow::ensure!(!ids.is_empty(), "请先选择材料");
        let tx = self.connection.transaction()?;
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if !seen.insert(id) { continue; }
            anyhow::ensure!(tx.execute("DELETE FROM materials WHERE id=?1", [id])? == 1, "部分材料已不存在，请刷新后重试");
        }
        tx.commit()?;
        Ok(())
    }
    pub fn export(&self, id: &str) -> Result<String> {
        let sessions = self.sessions()?;
        let s = sessions
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| anyhow::anyhow!("会话不存在"))?;
        let mut out = format!("# {}\n\n", s.title);
        out.push_str("## 问答\n\n");
        let mut latest=std::collections::HashMap::<String,Answer>::new();
        let mut order=Vec::new();
        for answer in self.answers(id)?{
            if !latest.contains_key(&answer.question_id){order.push(answer.question_id.clone());}
            let replace=latest.get(&answer.question_id).is_none_or(|old|answer.revision>old.revision||(answer.revision==old.revision&&answer.created_at>=old.created_at));
            if replace{latest.insert(answer.question_id.clone(),answer);}
        }
        for a in order.into_iter().filter_map(|qid|latest.remove(&qid)) {
            out.push_str(&format!(
                "### {}\n\n{}{}\n\n状态：{}\n\n",
                a.question, if a.mode.starts_with("screen"){"来源：屏幕提问\n\n"}else{""}, a.text, a.status
            ));
        }
        out.push_str("## 转写\n\n");
        for t in self.transcripts(id)? {
            let text = crate::transcript_text::display_text(&t.text);
            if text.is_empty() { continue; }
            out.push_str(&format!(
                "- **{}**：{}\n",
                if t.source == "meeting" {
                    "会议"
                } else {
                    "本人"
                },
                text
            ));
        }
        Ok(out)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistence() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        let m = Material {
            id: "a".into(),
            title: "简历".into(),
            kind: "resume".into(),
            text: "测试".into(),
            enabled: true,
            updated_at: 0,
        };
        db.save_material(&m).unwrap();
        assert_eq!(db.materials().unwrap()[0].text, "测试");
        db.save_settings(&Settings::default()).unwrap();
        assert_eq!(db.settings().unwrap().silence_ms, 700);
    }
}

#[cfg(test)]
mod durability_tests {
    use super::*;
    fn configured() -> Settings {
        let mut settings = Settings::default();
        settings.providers[0].app_id = "fixture-app-id".into();
        settings.providers[2].base_url = "https://fixture.invalid/custom/v1".into();
        settings.shortcuts.toggle = "Ctrl+Alt+Shift+Space".into();
        settings.font_size = 14;
        settings
    }
    #[test]
    fn disk_settings_survive_reopen_and_create_recovery_copies() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("interview.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.save_settings(&configured()).unwrap();
        }
        let db = Database::open(&path).unwrap();
        let actual = db.settings().unwrap();
        assert_eq!(actual.providers[0].app_id, "fixture-app-id");
        assert_eq!(
            actual.providers[2].base_url,
            "https://fixture.invalid/custom/v1"
        );
        assert_eq!(actual.shortcuts.toggle, "Ctrl+Alt+Shift+Space");
        for extension in ["settings.json", "settings.backup.json"] {
            assert!(path.with_extension(extension).exists());
        }
    }
    #[test]
    fn a_missing_database_row_is_restored_without_resetting_preferences() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("interview.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.save_settings(&configured()).unwrap();
            db.connection.execute("DELETE FROM settings", []).unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.settings().unwrap().providers[0].app_id, "fixture-app-id");
        assert!(db.take_notice().is_some());
        let count: i64 = db
            .connection
            .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn damaged_primary_file_recovers_from_backup() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("interview.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.save_settings(&configured()).unwrap();
            db.connection.execute("DELETE FROM settings", []).unwrap();
        }
        std::fs::write(path.with_extension("settings.json"), b"incomplete-json").unwrap();
        assert_eq!(
            Database::open(&path)
                .unwrap()
                .settings()
                .unwrap()
                .shortcuts
                .toggle,
            "Ctrl+Alt+Shift+Space"
        );
    }
    #[test]
    fn unreadable_saved_settings_are_reported_instead_of_replaced_by_defaults() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("interview.sqlite3");
        for extension in ["settings.json", "settings.backup.json"] {
            std::fs::write(path.with_extension(extension), b"damaged-saved-data").unwrap();
        }
        assert!(Database::open(&path).unwrap().settings().is_err());
        assert_eq!(
            std::fs::read(path.with_extension("settings.json")).unwrap(),
            b"damaged-saved-data"
        );
    }
    #[test]
    fn an_existing_database_is_migrated_before_any_new_save() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("interview.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.put("settings", "main", &configured()).unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.settings().unwrap().providers[0].app_id, "fixture-app-id");
        assert!(path.with_extension("settings.json").exists());
    }
    #[test]
    fn settings_survive_process_exit_without_database_destructors() {
        const CHILD_PATH: &str = "INTERVIEW_COPILOT_PERSISTENCE_TEST_DB";
        if let Ok(path) = std::env::var(CHILD_PATH) {
            let db = Database::open(Path::new(&path)).unwrap();
            db.save_settings(&configured()).unwrap();
            std::process::exit(0);
        }
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("interview.sqlite3");
        let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","storage::durability_tests::settings_survive_process_exit_without_database_destructors","--nocapture"]).env(CHILD_PATH,&path).status().unwrap();
        assert!(status.success());
        assert_eq!(
            Database::open(&path).unwrap().settings().unwrap().providers[0].app_id,
            "fixture-app-id"
        );
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;
    #[test]
    fn disk_database_uses_rollback_journal_and_keeps_a_complete_backup() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("store.sqlite3");
        let db = Database::open(&path).unwrap();
        let mode: String = db
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "delete");
        db.session(&Session {
            id: "test-session".into(),
            title: "fixture".into(),
            created_at: 1,
            ended_at: Some(2),
        })
        .unwrap();
        db.save_settings(&Settings::default()).unwrap();
        let copy = Database::open(&path.with_extension("last-good.sqlite3")).unwrap();
        assert_eq!(copy.sessions().unwrap().len(), 1);
        let integrity: String = copy
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }
    #[test]
    fn damaged_database_is_rejected_before_it_can_be_overwritten() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("damaged.sqlite3");
        let bytes = b"invalid-existing-user-database";
        std::fs::write(&path, bytes).unwrap();
        assert!(Database::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}


#[cfg(test)]
mod history_delete_tests {
    use super::*;
    fn seed(db: &Database, id: &str) {
        db.session(&Session { id: id.into(), title: id.into(), created_at: 1, ended_at: Some(2) }).unwrap();
        db.transcript(&Transcript { id: format!("t-{id}"), session_id: id.into(), source: "meeting".into(), segment_id: "segment".into(), text: "转写".into(), is_final: true, at: 1, speech_end_at: 1 }).unwrap();
        let answer: Answer = serde_json::from_value(serde_json::json!({"id":format!("a-{id}"),"sessionId":id,"questionId":"q","revision":1,"question":"问题","text":"答案","status":"complete","mode":"short","createdAt":1,"speechEndAt":1,"triggerAt":1,"requestAt":1,"firstTokenMs":null,"firstSentenceMs":null})).unwrap();
        db.answer(&answer).unwrap();
    }
    #[test]
    fn deletion_removes_only_the_selected_session_and_its_children() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        seed(&db, "remove"); seed(&db, "keep");
        let before = db.settings().unwrap();
        db.delete_session("remove").unwrap();
        assert!(db.answers("remove").unwrap().is_empty());
        assert!(db.transcripts("remove").unwrap().is_empty());
        assert_eq!(db.sessions().unwrap().len(), 1);
        assert_eq!(db.sessions().unwrap()[0].id, "keep");
        assert_eq!(db.answers("keep").unwrap().len(), 1);
        assert_eq!(db.transcripts("keep").unwrap().len(), 1);
        assert_eq!(serde_json::to_value(db.settings().unwrap()).unwrap(), serde_json::to_value(before).unwrap());
    }
    #[test]
    fn a_failed_delete_rolls_back_transcripts_and_answers() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        seed(&db, "blocked");
        db.connection.execute_batch("CREATE TRIGGER block_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
        assert!(db.delete_session("blocked").is_err());
        assert_eq!(db.sessions().unwrap().len(), 1);
        assert_eq!(db.transcripts("blocked").unwrap().len(), 1);
        assert_eq!(db.answers("blocked").unwrap().len(), 1);
    }
    #[test]
    fn batch_deletion_is_atomic_and_deduplicates_selected_ids() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        for id in ["first", "blocked", "keep"] { seed(&db, id); }
        db.connection.execute_batch("CREATE TRIGGER block_one BEFORE DELETE ON sessions WHEN OLD.id='blocked' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
        assert!(db.delete_sessions(&["first".into(), "blocked".into()]).is_err());
        for id in ["first", "blocked", "keep"] {
            assert_eq!(db.answers(id).unwrap().len(), 1);
            assert_eq!(db.transcripts(id).unwrap().len(), 1);
        }
        assert_eq!(db.sessions().unwrap().len(), 3);
        db.connection.execute_batch("DROP TRIGGER block_one;").unwrap();
        db.delete_sessions(&["first".into(), "blocked".into(), "first".into()]).unwrap();
        assert_eq!(db.sessions().unwrap().len(), 1);
        assert_eq!(db.sessions().unwrap()[0].id, "keep");
        for id in ["first", "blocked"] { assert!(db.answers(id).unwrap().is_empty()); assert!(db.transcripts(id).unwrap().is_empty()); }
        assert_eq!(db.answers("keep").unwrap().len(), 1);
    }
    #[test]
    fn stale_or_empty_batch_does_not_remove_other_records() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        seed(&db, "keep");
        assert!(db.delete_sessions(&[]).is_err());
        assert!(db.delete_sessions(&["keep".into(), "missing".into()]).is_err());
        assert_eq!(db.sessions().unwrap().len(), 1);
        assert_eq!(db.answers("keep").unwrap().len(), 1);
        assert_eq!(db.transcripts("keep").unwrap().len(), 1);
    }

    #[test]
    fn history_excludes_old_empty_rows_and_retains_answer_only_sessions() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        db.session(&Session { id: "old-empty".into(), title: "empty".into(), created_at: 1, ended_at: Some(2) }).unwrap();
        seed(&db, "answer-only");
        db.connection.execute("DELETE FROM transcripts WHERE session_id='answer-only'", []).unwrap();
        let sessions = db.history_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "answer-only");
        assert!(db.finish_session(&sessions[0]).unwrap());
        assert_eq!(db.sessions().unwrap().len(), 2); // Existing empty rows are filtered, not destroyed.
    }
    #[test]
    fn material_batch_failure_is_atomic_and_does_not_change_session_content() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        seed(&db, "history");
        for id in ["first", "blocked", "keep"] {
            db.save_material(&Material { id: id.into(), title: id.into(), kind: "project".into(), text: "fixture".into(), enabled: true, updated_at: 1 }).unwrap();
        }
        db.connection.execute_batch("CREATE TRIGGER block_material BEFORE DELETE ON materials WHEN OLD.id='blocked' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;").unwrap();
        assert!(db.delete_materials(&["first".into(), "blocked".into()]).is_err());
        assert_eq!(db.materials().unwrap().len(), 3);
        db.connection.execute_batch("DROP TRIGGER block_material;").unwrap();
        db.delete_materials(&["first".into(), "blocked".into(), "first".into()]).unwrap();
        assert_eq!(db.materials().unwrap().len(), 1);
        assert_eq!(db.materials().unwrap()[0].id, "keep");
        assert!(db.delete_materials(&["keep".into(), "missing".into()]).is_err());
        assert!(db.delete_materials(&[]).is_err());
        assert_eq!(db.materials().unwrap().len(), 1);
        assert_eq!(db.answers("history").unwrap().len(), 1);
        assert_eq!(db.transcripts("history").unwrap().len(), 1);
    }

}

#[cfg(test)]
mod transcript_export_tests {
    use super::*;
    #[test]
    fn export_cleans_orphan_separators_without_rewriting_saved_transcripts() {
        let db=Database::open(Path::new(":memory:")).unwrap();
        db.session(&Session{id:"s".into(),title:"fixture".into(),created_at:0,ended_at:None}).unwrap();
        let texts=["？请介绍缓存？", "，如何处理穿透", "？ 。！… ", ".NET 与 .5", "-5 和 −2", "“如何实现？”"];
        for (i,text) in texts.iter().enumerate(){db.transcript(&Transcript{id:format!("t{i}"),session_id:"s".into(),source:"meeting".into(),segment_id:i.to_string(),text:(*text).into(),is_final:true,at:i as i64,speech_end_at:0}).unwrap();}
        let exported=db.export("s").unwrap();
        assert!(exported.contains("**会议**：请介绍缓存？"));assert!(exported.contains("**会议**：如何处理穿透"));
        assert!(!exported.contains("：？"));assert_eq!(exported.matches("**会议**").count(),5);
        assert!(exported.contains(".NET 与 .5"));assert!(exported.contains("-5 和 −2"));assert!(exported.contains("“如何实现？”"));
        assert_eq!(db.transcripts("s").unwrap().iter().map(|t|t.text.as_str()).collect::<Vec<_>>(),texts);
    }
}

#[cfg(test)] mod backup_restore_transaction_tests {
 use super::*;
 #[test]fn sql_failure_rolls_back_replacement_and_preserves_all_settings(){
  let mut db=Database::open(Path::new(":memory:")).unwrap();let mut settings=Settings::default();settings.job="retained fixture".into();db.save_settings(&settings).unwrap();
  let old=Material{id:"old".into(),title:"fixture".into(),kind:"project".into(),text:"original".into(),enabled:true,updated_at:1};db.save_material(&old).unwrap();
  let mut replacement=db.data_backup().unwrap();replacement.materials[0].id="blocked".into();
  db.connection.execute_batch("CREATE TRIGGER reject_backup BEFORE INSERT ON materials WHEN NEW.id='blocked' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;").unwrap();
  assert!(db.restore_data(&replacement).is_err());assert_eq!(db.materials().unwrap()[0].id,"old");assert_eq!(db.materials().unwrap()[0].text,"original");assert_eq!(db.settings().unwrap().job,"retained fixture");
 }
}

#[cfg(test)]mod first_run_vendor_tests{
 use super::*;
 #[test]fn new_profile_prefers_aliyun_but_saved_and_recovered_choices_are_not_changed(){
  let directory=tempfile::tempdir().unwrap();let path=directory.path().join("fixture.sqlite3");
  {let db=Database::open(&path).unwrap();let fresh=db.settings().unwrap();assert_eq!(fresh.active_model,"qwen");assert_eq!(fresh.asr_provider,"dashscope");let model=fresh.providers.iter().find(|p|p.id==fresh.active_model).unwrap();let voice=fresh.providers.iter().find(|p|p.id==fresh.asr_provider).unwrap();assert_eq!(model.model,"qwen-plus");assert_eq!(voice.model,"paraformer-realtime-v2");assert_eq!(voice.kind,"dashscope");let legacy=Settings::default();db.save_settings(&legacy).unwrap();assert_eq!(serde_json::to_value(db.settings().unwrap()).unwrap(),serde_json::to_value(&legacy).unwrap());db.connection.execute("DELETE FROM settings",[]).unwrap();let recovered=db.settings().unwrap();assert_eq!(recovered.active_model,"deepseek");assert_eq!(recovered.asr_provider,"xfyun");}
 }
}

#[cfg(test)]mod project_review_export_revision_tests{
 use super::*;
 fn answer(id:&str,qid:&str,revision:u32,at:i64,text:&str)->Answer{Answer{sources:vec![],id:id.into(),session_id:"session".into(),question_id:qid.into(),revision,question:qid.into(),text:text.into(),status:if revision==1{"cancelled"}else{"complete"}.into(),mode:"short".into(),created_at:at,speech_end_at:at,trigger_at:at,request_at:at,first_token_ms:None,first_sentence_ms:None}}
 #[test]fn markdown_exports_latest_revision_once_in_original_question_order(){
  let db=Database::open(Path::new(":memory:")).unwrap();db.session(&Session{id:"session".into(),title:"synthetic".into(),created_at:1,ended_at:Some(9)}).unwrap();
  for a in [answer("old","first",1,1,"obsolete partial"),answer("other","second",2,2,"second answer"),answer("new","first",2,3,"full first answer")] {db.answer(&a).unwrap();}
  let text=db.export("session").unwrap();assert!(!text.contains("obsolete partial"));assert_eq!(text.matches("### first").count(),1);assert!(text.find("full first answer").unwrap()<text.find("second answer").unwrap());assert_eq!(db.answers("session").unwrap().len(),3);
 }
}
