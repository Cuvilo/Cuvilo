use crate::types::Secret;
use anyhow::{Context, Result};

#[cfg(target_os = "windows")]
use windows::core::{PCWSTR, PWSTR};
#[cfg(target_os = "windows")]
use windows::Win32::Security::Credentials::*;

// Keep this legacy credential namespace stable when changing the product name.
#[cfg(target_os = "windows")]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

#[cfg(target_os = "windows")]
pub fn save(id: &str, secret: &Secret) -> Result<()> {
    let mut target = wide(&format!("InterviewCopilot/{id}"));
    let mut user = wide("InterviewCopilot");
    let mut blob = serde_json::to_vec(secret)?;
    let c = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(user.as_mut_ptr()),
        ..Default::default()
    };
    unsafe { CredWriteW(&c, 0).context("无法保存到 Windows 凭据管理器")? };
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn read_optional(id: &str) -> Result<Option<Secret>> {
    let target = wide(&format!("InterviewCopilot/{id}"));
    let mut ptr = std::ptr::null_mut();
    unsafe {
        match CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut ptr) {
            Ok(()) => {}
            Err(error) if error.code() == windows::core::HRESULT::from_win32(1168) => {
                return Ok(None)
            }
            Err(error) => return Err(error).context("无法读取 Windows 凭据管理器"),
        }
        let result = serde_json::from_slice(std::slice::from_raw_parts(
            (*ptr).CredentialBlob,
            (*ptr).CredentialBlobSize as usize,
        ));
        CredFree(ptr.cast());
        Ok(Some(result?))
    }
}

#[cfg(target_os = "windows")]
pub fn remove(id:&str)->Result<()>{
 let target=wide(&format!("InterviewCopilot/{id}"));
 match unsafe{CredDeleteW(PCWSTR(target.as_ptr()),CRED_TYPE_GENERIC,None)}{
  Ok(())=>Ok(()),Err(e)if e.code()==windows::core::HRESULT::from_win32(1168)=>Ok(()),Err(e)=>Err(e).context("无法移除服务密钥")
 }
}

#[cfg(target_os = "macos")]
pub fn save(id: &str, secret: &Secret) -> Result<()> {
    let blob = serde_json::to_string(secret)?;
    let status = std::process::Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-s", "InterviewCopilot", "-a", id, "-w", &blob])
        .status()
        .context("无法执行 macOS 钥匙串命令")?;
    if !status.success() {
        anyhow::bail!("无法保存到 macOS 钥匙串");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn read_optional(id: &str) -> Result<Option<Secret>> {
    let output = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "InterviewCopilot", "-a", id, "-w"])
        .output()
        .context("无法读取 macOS 钥匙串")?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8(output.stdout).context("钥匙串数据编码无效")?;
    let secret: Secret = serde_json::from_str(text.trim()).context("无法解析密钥数据")?;
    Ok(Some(secret))
}

#[cfg(target_os = "macos")]
pub fn remove(id: &str) -> Result<()> {
    let _ = std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", "InterviewCopilot", "-a", id])
        .status();
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn save(_id: &str, _secret: &Secret) -> Result<()> {
    anyhow::bail!("当前平台未配置密钥安全存储")
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn read_optional(_id: &str) -> Result<Option<Secret>> {
    Ok(None)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn remove(_id: &str) -> Result<()> {
    Ok(())
}

pub fn read(id: &str) -> Result<Secret> {
    read_optional(id)?.context("尚未配置服务密钥，请在设置中保存")
}
pub fn configured(id: &str) -> bool {
    read(id)
        .map(|s| !s.api_key.trim().is_empty() || !s.secret_key.trim().is_empty())
        .unwrap_or(false)
}

pub fn redact(message: &str, secret: &Secret) -> String {
    let mut safe = message.to_string();
    for value in [&secret.api_key, &secret.secret_key] {
        if !value.trim().is_empty() {
            safe = safe
                .replace(value.as_str(), "[已隐藏]")
                .replace(value.trim(), "[已隐藏]");
        }
    }
    safe
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    #[test]
    fn saved_credentials_can_be_read_back_for_the_settings_form() {
        let id = format!("test-{}", crate::types::new_id());
        assert!(read_optional(&id).unwrap().is_none());
        save(
            &id,
            &Secret {
                api_key: "fixture-api-key".into(),
                secret_key: "fixture-secret-key".into(),
            },
        )
        .unwrap();
        let actual = read(&id).unwrap();
        let target = wide(&format!("InterviewCopilot/{id}"));
        unsafe {
            CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None).unwrap();
        }
        assert_eq!(actual.api_key, "fixture-api-key");
        assert_eq!(actual.secret_key, "fixture-secret-key");
    }
}
