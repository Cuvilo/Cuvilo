use crate::types::*;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, io::{Read,Write}, path::Path, sync::Mutex};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct DataBackup {
    pub format: String, pub version: u32, pub created_at: i64,
    pub materials: Vec<Material>, pub sessions: Vec<Session>,
    pub transcripts: Vec<Transcript>, pub answers: Vec<Answer>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Preview { pub token: String, pub created_at: i64, pub materials: usize, pub sessions: usize, pub transcripts: usize, pub answers: usize }
#[derive(Default)]
pub struct PendingRestore(pub Mutex<Option<(String, DataBackup)>>);
impl DataBackup {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(self.format=="cuvilo-data-backup" && self.version==1, "不支持的备份格式或版本");
        anyhow::ensure!((0..=253402300799999).contains(&self.created_at), "备份时间无效");
        fn ids<'a>(values: impl Iterator<Item=&'a str>) -> Result<HashSet<&'a str>> {
            let mut seen=HashSet::new();
            for id in values { anyhow::ensure!(!id.trim().is_empty() && seen.insert(id), "备份中存在空白或重复标识"); }
            Ok(seen)
        }
        ids(self.materials.iter().map(|m|m.id.as_str()))?;
        let sessions=ids(self.sessions.iter().map(|s|s.id.as_str()))?;
        ids(self.transcripts.iter().map(|t|t.id.as_str()))?;
        ids(self.answers.iter().map(|a|a.id.as_str()))?;
        anyhow::ensure!(self.transcripts.iter().all(|t|sessions.contains(t.session_id.as_str())) && self.answers.iter().all(|a|sessions.contains(a.session_id.as_str())), "备份中的面试记录关联不完整");
        anyhow::ensure!(self.materials.iter().all(|m|!m.title.trim().is_empty() && !m.text.trim().is_empty() && m.text.chars().count()<=100_000), "备份中存在无效材料");
        Ok(())
    }
    pub fn read(path: &Path) -> Result<Self> {
        anyhow::ensure!(std::fs::metadata(path)?.len() <= 256 * 1024 * 1024, "备份超过256MB，请使用较小的备份文件");
        let value:Self=serde_json::from_reader(std::io::BufReader::new(std::fs::File::open(path)?.take(256 * 1024 * 1024 + 1))).context("无法读取Cuvilo数据备份，原数据未改变")?;
        value.validate()?; Ok(value)
    }
    pub fn write(&self, path: &Path) -> Result<()> {
        self.validate()?;
        anyhow::ensure!(path.extension().and_then(|x|x.to_str()).is_some_and(|x|x.eq_ignore_ascii_case("cuvilo-backup")), "请保存为.cuvilo-backup文件");
        if path.exists() { anyhow::ensure!(!std::fs::symlink_metadata(path)?.file_type().is_symlink(), "不能覆盖链接文件"); }
        let temp=path.with_extension(format!("{}.tmp",new_id()));
        let result=(|| -> Result<()> {
            let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            serde_json::to_writer(&mut file,self)?;file.flush()?;file.sync_all()?;drop(file);
            std::fs::rename(&temp,path)?; Ok(())
        })();
        if result.is_err(){let _=std::fs::remove_file(&temp);} result.context("备份写入失败，原有文件已保留")
    }
    pub fn preview(&self, token: String) -> Preview { Preview { token,created_at:self.created_at,materials:self.materials.len(),sessions:self.sessions.len(),transcripts:self.transcripts.len(),answers:self.answers.len() } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;
    fn fixture()->DataBackup { DataBackup{format:"cuvilo-data-backup".into(),version:1,created_at:1,materials:vec![Material{id:"m".into(),title:"fixture".into(),kind:"project".into(),text:"fixture body".into(),enabled:true,updated_at:1}],sessions:vec![Session{id:"s".into(),title:"fixture".into(),created_at:1,ended_at:Some(2)}],transcripts:vec![Transcript{id:"t".into(),session_id:"s".into(),source:"meeting".into(),segment_id:"segment".into(),text:"fixture transcript".into(),is_final:true,at:1,speech_end_at:2}],answers:vec![Answer{sources:Vec::new(),id:"a".into(),session_id:"s".into(),question_id:"q".into(),revision:1,question:"fixture question".into(),text:"fixture answer".into(),status:"complete".into(),mode:"short".into(),created_at:1,speech_end_at:1,trigger_at:2,request_at:3,first_token_ms:Some(10),first_sentence_ms:Some(20)}]} }
    #[test] fn backup_round_trip_has_no_service_configuration_or_credentials() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("fixture.cuvilo-backup");fixture().write(&path).unwrap();
        let text=std::fs::read_to_string(&path).unwrap();assert!(!text.contains("settings"));assert!(!text.contains("apiKey"));
        let read=DataBackup::read(&path).unwrap();assert_eq!(read.materials[0].text,"fixture body");
        read.write(&path).unwrap();assert!(DataBackup::read(&path).is_ok());
    }
    #[test] fn invalid_versions_duplicates_and_orphans_are_rejected() {
        let mut b=fixture();b.version=99;assert!(b.validate().is_err());b.version=1;b.materials.push(b.materials[0].clone());assert!(b.validate().is_err());
        b.materials.pop();b.transcripts.push(Transcript{id:"orphan".into(),session_id:"missing".into(),source:"meeting".into(),segment_id:"segment".into(),text:"fixture".into(),is_final:true,at:1,speech_end_at:1});assert!(b.validate().is_err());
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("bad.cuvilo-backup");std::fs::write(&path,b"{broken").unwrap();assert!(DataBackup::read(&path).is_err());
    }
    #[test] fn restore_replaces_data_but_keeps_settings_and_rolls_back_on_failure() {
        let mut db=Database::open(Path::new(":memory:")).unwrap();let settings=Settings{job:"unchanged fixture".into(),..Settings::default()};db.save_settings(&settings).unwrap();
        let first=fixture();db.restore_data(&first).unwrap();assert_eq!(db.materials().unwrap()[0].id,"m");assert_eq!(db.settings().unwrap().job,"unchanged fixture");
        let mut next=fixture();next.materials[0].id="new".into();db.restore_data(&next).unwrap();assert_eq!(db.materials().unwrap().len(),1);assert_eq!(db.materials().unwrap()[0].id,"new");
        let mut bad=fixture();bad.materials.push(bad.materials[0].clone());assert!(db.restore_data(&bad).is_err());assert_eq!(db.materials().unwrap()[0].id,"new");
        let exported=db.data_backup().unwrap();assert_eq!(exported.materials.len(),1);assert_eq!(exported.sessions.len(),1);assert_eq!(exported.transcripts[0].text,"fixture transcript");assert_eq!(exported.answers[0].first_token_ms,Some(10));
    }
}
