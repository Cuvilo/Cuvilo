//! Only the explicit main-window toggle changes the owned HKCU startup entry.
#[cfg(target_os="windows")]
use winreg::{RegKey,enums::{HKEY_CURRENT_USER,KEY_READ,KEY_WRITE}};
#[cfg(target_os="windows")]
const RUN:&str=r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os="windows")]
fn command()->Result<String,String>{
 let path=std::env::current_exe().map_err(|_|"无法读取程序位置")?;
 quoted_command(&path)
}
#[allow(dead_code)]
fn quoted_command(path:&std::path::Path)->Result<String,String>{
 let value=path.to_str().ok_or("程序路径格式不受支持")?;
 if !path.is_absolute()||value.contains(['"','\r','\n']){return Err("程序路径格式不受支持".into());}
 Ok(format!("\"{value}\""))
}
#[cfg(target_os="windows")]
fn enabled_in(key:&RegKey,expected:&str)->Result<bool,String>{
 match key.get_value::<String,_>("Cuvilo"){Ok(value)=>Ok(value==expected),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Ok(false),Err(_)=>Err("无法读取开机启动设置".into())}
}
#[cfg(target_os="windows")]
fn change_in(key:&RegKey,expected:&str,enabled:bool)->Result<bool,String>{
 let before=match key.get_raw_value("Cuvilo"){Ok(value)=>Some(value),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>None,Err(_)=>return Err("无法读取原开机启动设置".into())};
 let result=(||{
  if enabled{key.set_value("Cuvilo",&expected).map_err(|_|"无法启用开机启动")?;}else{match key.delete_value("Cuvilo"){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>return Err("无法关闭开机启动".to_string())}}
  if enabled_in(key,expected)?!=enabled{return Err("开机启动核验失败".into());}Ok(enabled)
 })();
 if result.is_err(){if let Some(value)=before{let _=key.set_raw_value("Cuvilo",&value);}else{let _=key.delete_value("Cuvilo");}}
 result
}
#[cfg(target_os="macos")]
const MACOS_LABEL:&str="local.interview.copilot";
#[cfg(target_os="macos")]
fn macos_plist_path()->Result<std::path::PathBuf,String>{
 let home=std::env::var_os("HOME").ok_or("无法读取用户目录")?;
 Ok(std::path::PathBuf::from(home).join("Library/LaunchAgents").join(format!("{MACOS_LABEL}.plist")))
}
#[allow(dead_code)]
fn macos_plist_content(path:&std::path::Path)->Result<String,String>{
 let value=path.to_str().ok_or("程序路径格式不受支持")?;
 if !path.is_absolute()||value.contains(['\r','\n','\0']){return Err("程序路径格式不受支持".into());}
 let escaped= value.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&apos;");
 Ok(format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>local.interview.copilot</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{escaped}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>\n</plist>\n"))
}
#[cfg(target_os="macos")]
fn macos_enabled_in(plist_path:&std::path::Path,expected_content:&str)->Result<bool,String>{
 match std::fs::read_to_string(plist_path){
  Ok(content)=>Ok(content==expected_content),
  Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(false),
  Err(_)=>Err("无法读取开机启动设置".into()),
 }
}
#[cfg(target_os="macos")]
fn macos_change_in(plist_path:&std::path::Path,expected_content:&str,enabled:bool)->Result<bool,String>{
 let before=match std::fs::read(plist_path){Ok(bytes)=>Some(bytes),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>None,Err(_)=>return Err("无法读取原开机启动设置".into())};
 let result=(||{
  if enabled{
   if let Some(parent)=plist_path.parent(){std::fs::create_dir_all(parent).map_err(|_|"无法创建开机启动目录")?;}
   std::fs::write(plist_path,expected_content.as_bytes()).map_err(|_|"无法启用开机启动")?;
  }else{
   match std::fs::remove_file(plist_path){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>return Err("无法关闭开机启动".to_string())}
  }
  if macos_enabled_in(plist_path,expected_content)?!=enabled{return Err("开机启动核验失败".into());}
  Ok(enabled)
 })();
 if result.is_err(){if let Some(bytes)=before{let _=std::fs::write(plist_path,bytes);}else{let _=std::fs::remove_file(plist_path);}}
 result
}
pub fn get()->Result<bool,String>{
 #[cfg(target_os="windows")]{let command=command()?;let root=RegKey::predef(HKEY_CURRENT_USER);return match root.open_subkey_with_flags(RUN,KEY_READ){Ok(key)=>enabled_in(&key,&command),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Ok(false),Err(_)=>Err("无法读取开机启动设置".into())};}
 #[cfg(target_os="macos")]{let exe=std::env::current_exe().map_err(|_|"无法读取程序位置")?;let expected=macos_plist_content(&exe)?;let plist=macos_plist_path()?;return macos_enabled_in(&plist,&expected);}
 #[cfg(not(any(target_os="windows",target_os="macos")))]{Ok(false)}
}
pub fn set(enabled:bool)->Result<bool,String>{
 #[cfg(target_os="windows")]{let command=command()?;let(key,_)=RegKey::predef(HKEY_CURRENT_USER).create_subkey_with_flags(RUN,KEY_READ|KEY_WRITE).map_err(|_|"无法修改开机启动设置")?;change_in(&key,&command,enabled)}
 #[cfg(target_os="macos")]{let exe=std::env::current_exe().map_err(|_|"无法读取程序位置")?;let expected=macos_plist_content(&exe)?;let plist=macos_plist_path()?;macos_change_in(&plist,&expected,enabled)}
 #[cfg(not(any(target_os="windows",target_os="macos")))]{let _=enabled;Err("此平台暂不支持开机启动".into())}
}
#[cfg(test)]mod macos_plist_tests{
 use super::*;
 #[test]fn macos_launch_agent_plist_escapes_and_validates_absolute_paths(){
  #[cfg(target_os="windows")]let path=std::path::Path::new(r"C:\Applications\Cuvilo & Co.app\Contents\MacOS\cuvilo");
  #[cfg(not(target_os="windows"))]let path=std::path::Path::new("/Applications/Cuvilo & Co.app/Contents/MacOS/cuvilo");
  let plist=macos_plist_content(path).unwrap();
  assert!(plist.contains("Cuvilo &amp; Co.app"));
  assert!(macos_plist_content(std::path::Path::new("relative/cuvilo")).is_err());
 }
}
#[cfg(all(test,target_os="windows"))]mod tests{
 use super::*;
 #[test]fn quoted_paths_and_isolated_registry_roundtrip(){
  let expected=quoted_command(std::path::Path::new(r"C:\Program Files\Cuvilo\cuvilo.exe")).unwrap();assert_eq!(expected,r#""C:\Program Files\Cuvilo\cuvilo.exe""#);assert!(quoted_command(std::path::Path::new("relative.exe")).is_err());
  let root=RegKey::predef(HKEY_CURRENT_USER);let path=format!(r"Software\Cuvilo\Tests\{}",crate::types::new_id());let(key,_)=root.create_subkey(&path).unwrap();
  struct Cleanup(RegKey,String);impl Drop for Cleanup{fn drop(&mut self){let _=self.0.delete_subkey_all(&self.1);}}let _cleanup=Cleanup(root,path);
  key.set_value("unrelated",&"preserved").unwrap();assert!(!enabled_in(&key,&expected).unwrap());assert!(change_in(&key,&expected,true).unwrap());assert!(enabled_in(&key,&expected).unwrap());assert!(!change_in(&key,&expected,false).unwrap());assert!(!enabled_in(&key,&expected).unwrap());assert_eq!(key.get_value::<String,_>("unrelated").unwrap(),"preserved");
 }
}
