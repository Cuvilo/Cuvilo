use crate::types::Settings;
use anyhow::{Context, Result};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub struct SettingsCopies {
    primary: PathBuf,
    backup: PathBuf,
}
impl SettingsCopies {
    pub fn for_database(database: &Path) -> Self {
        Self {
            primary: database.with_extension("settings.json"),
            backup: database.with_extension("settings.backup.json"),
        }
    }
    pub fn save(&self, settings: &Settings) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(settings)?;
        atomic_write(&self.backup, &bytes).context("配置恢复副本保存失败")?;
        atomic_write(&self.primary, &bytes).context("配置文件保存失败")
    }
    pub fn recover(&self) -> Result<Option<Settings>> {
        let mut existed = false;
        for path in [&self.primary, &self.backup] {
            match fs::read(path) {
                Ok(bytes) => {
                    existed = true;
                    if let Ok(settings) = serde_json::from_slice::<Settings>(&bytes) {
                        return Ok(Some(settings));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("无法读取已保存配置，未使用默认值覆盖"),
            }
        }
        anyhow::ensure!(
            !existed,
            "配置文件及恢复副本均无法解析；已保留原文件，未加载默认值。请检查本地配置文件"
        );
        Ok(None)
    }
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", crate::types::new_id()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
