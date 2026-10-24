use crate::types::{now_ms, AudioSource};
use anyhow::{bail, Context, Result};
use std::{
    mem::{size_of, ManuallyDrop},
    sync::{mpsc as sync_mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use windows::{
    core::{implement, Interface, Ref, HRESULT},
    Win32::{
        Foundation::CloseHandle,
        Media::Audio::*,
        System::{
            Com::{StructuredStorage::*, *},
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            Variant::VT_BLOB,
        },
    },
};

pub struct Frame {
    pub pcm: Vec<u8>,
    pub source: String,
    pub level: f32,
    pub at: i64,
}
#[derive(Clone)]
pub struct Notice {
    pub source: String,
    pub message: String,
    pub error: bool,
}
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activation {
    tx: Mutex<Option<sync_mpsc::Sender<std::result::Result<usize, String>>>>,
}
impl IActivateAudioInterfaceCompletionHandler_Impl for Activation_Impl {
    fn ActivateCompleted(
        &self,
        op: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        unsafe {
            let mut hr = HRESULT(0);
            let mut unknown = None;
            let result = op
                .as_ref()
                .ok_or_else(windows::core::Error::from_win32)
                .and_then(|op| op.GetActivateResult(&mut hr, &mut unknown))
                .and_then(|_| hr.ok())
                .and_then(|_| unknown.ok_or_else(windows::core::Error::from_win32))
                .and_then(|u| u.cast::<IAudioClient>());
            if let Some(tx) = self.tx.lock().unwrap().take() {
                let _ = tx.send(
                    result
                        .map(|client| client.into_raw() as usize)
                        .map_err(|e| e.to_string()),
                );
            }
            Ok(())
        }
    }
}
struct ComGuard;
impl ComGuard {
    fn new() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        Ok(Self)
    }
}
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
fn process_name(pid: u32) -> String {
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut buffer = vec![0u16; 4096];
            let mut len = buffer.len() as u32;
            let result = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut len,
            );
            let _ = CloseHandle(handle);
            if result.is_ok() {
                return String::from_utf16_lossy(&buffer[..len as usize])
                    .rsplit('\\')
                    .next()
                    .unwrap_or("应用")
                    .to_string();
            }
        }
        format!("进程 {pid}")
    }
}
pub fn windows_build() -> Option<u32> {
    winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        .ok()?
        .get_value::<String, _>("CurrentBuildNumber")
        .ok()?
        .parse()
        .ok()
}
// The process-loopback API also works on updated Windows 10 2004+ builds.
// Do not reject 19041-19045 based only on the SDK documentation's 20348 label.
pub fn process_capture_candidate(build:Option<u32>)->bool { build.map_or(true,|value|value>=19041) }
pub fn sources() -> Result<Vec<AudioSource>> {
    let _com = ComGuard::new()?;
    let mut out = vec![AudioSource {
        process_capture_supported: None,
        id: "system".into(),
        name: "全部系统声音（包含其他应用）".into(),
        kind: "system".into(),
        pid: None,
        recommended: false,
    }];
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for n in 0..devices.GetCount()? {
            let device = devices.Item(n)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let sessions = manager.GetSessionEnumerator()?;
            for i in 0..sessions.GetCount()? {
                let session: IAudioSessionControl2 = sessions.GetSession(i)?.cast()?;
                let pid = session.GetProcessId()?;
                if pid == 0 || pid == std::process::id() || out.iter().any(|s| s.pid == Some(pid)) {
                    continue;
                }
                let name = process_name(pid);
                let lower = name.to_lowercase();
                let recommended = lower.contains("wemeet")
                    || lower.contains("txmeeting")
                    || lower.contains("tencentmeeting");
                out.push(AudioSource {
                    process_capture_supported: None,
                    id: format!("process-{pid}"),
                    name: format!("{name} · PID {pid}"),
                    kind: "process".into(),
                    pid: Some(pid),
                    recommended,
                });
            }
        }
    }
    if !process_capture_candidate(windows_build()) {
        out.retain(|s| s.kind == "system");
        out[0].process_capture_supported=Some(false);
    }
    out.sort_by_key(|s| !s.recommended);
    Ok(out)
}
unsafe fn process_client(pid: u32) -> Result<IAudioClient> {
    if !process_capture_candidate(windows_build()) {
        bail!("进程定向采集需要 Windows 10 2004（build 19041）或更新版本，请显式选择系统声音");
    }
    let (tx, rx) = sync_mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activation {
        tx: Mutex::new(Some(tx)),
    }
    .into();
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let variant = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: (&mut params as *mut AUDIOCLIENT_ACTIVATION_PARAMS).cast(),
                    },
                },
                ..Default::default()
            }),
        },
    });
    let _operation = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&*variant),
        &handler,
    )
    .context("无法初始化此应用的音频采集，请检查应用和系统更新，或显式选择系统声音")?;
    let raw = rx
        .recv_timeout(Duration::from_secs(8))
        .context("音频接口激活超时")?
        .map_err(anyhow::Error::msg)
        .context("无法初始化此应用的音频采集，请检查应用和系统更新，或显式选择系统声音")?;
    Ok(IAudioClient::from_raw(raw as *mut _))
}
unsafe fn default_client(mic: bool) -> Result<(IAudioClient, IMMDeviceEnumerator, String)> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device = enumerator
        .GetDefaultAudioEndpoint(if mic { eCapture } else { eRender }, eConsole)
        .context("未检测到可用的音频设备")?;
    let id = device.GetId()?;
    let id_text = id.to_string()?;
    CoTaskMemFree(Some(id.0.cast()));
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
    Ok((client, enumerator, id_text))
}
pub fn spawn(
    source: AudioSource,
    mic: bool,
    cancel: CancellationToken,
    frames: mpsc::Sender<Frame>,
    notices: mpsc::UnboundedSender<Notice>,
) {
    thread::spawn(move || {
        let name = if mic { "microphone" } else { "meeting" };
        let result = capture(&source, mic, &cancel, &frames, &notices);
        if let Err(e) = result {
            let _ = notices.send(Notice {
                source: name.into(),
                message: format!("采音停止：{e:#}"),
                error: true,
            });
        }
    });
}
fn capture(
    source: &AudioSource,
    mic: bool,
    cancel: &CancellationToken,
    frames: &mpsc::Sender<Frame>,
    notices: &mpsc::UnboundedSender<Notice>,
) -> Result<()> {
    let _com = ComGuard::new()?;
    let label = if mic { "microphone" } else { "meeting" };
    unsafe {
        let mut endpoint = None;
        let client = if !mic && source.kind == "process" {
            process_client(source.pid.context("未选择会议进程")?)?
        } else {
            let (c, e, id) = default_client(mic)?;
            endpoint = Some((e, id));
            c
        };
        // WASAPI's shared audio engine performs channel conversion and resampling to 16k mono PCM.
        let format = WAVEFORMATEX {
            wFormatTag: 1,
            nChannels: 1,
            nSamplesPerSec: 16000,
            nAvgBytesPerSec: 32000,
            nBlockAlign: 2,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
            | if mic { 0 } else { AUDCLNT_STREAMFLAGS_LOOPBACK };
        client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &format, None)
            .context("音频格式初始化失败；请检查设备或切换系统声音")?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let _ = notices.send(Notice {
            source: label.into(),
            message: "音频采集已启动".into(),
            error: false,
        });
        let result = (|| -> Result<()> {
            let mut pending = Vec::with_capacity(2560);
            let mut last_silence = Instant::now();
            let mut last_check = Instant::now();
            let mut idle = Instant::now();
            while !cancel.is_cancelled() {
                if last_check.elapsed() > Duration::from_secs(2) {
                    last_check = Instant::now();
                    if source.kind == "process"
                        && !mic
                        && process_name(source.pid.unwrap_or(0)).starts_with("进程 ")
                    {
                        bail!("会议进程已退出，请重新选择音源")
                    };
                    if let Some((enumerator, id)) = &endpoint {
                        let current = enumerator.GetDefaultAudioEndpoint(
                            if mic { eCapture } else { eRender },
                            eConsole,
                        )?;
                        let ptr = current.GetId()?;
                        let new_id = ptr.to_string()?;
                        CoTaskMemFree(Some(ptr.0.cast()));
                        if &new_id != id {
                            bail!("默认音频设备已切换，请重新开始采集")
                        }
                    }
                }
                let mut available = capture.GetNextPacketSize()?;
                while available > 0 {
                    let mut data = std::ptr::null_mut();
                    let mut count = 0;
                    let mut flags = 0;
                    capture.GetBuffer(&mut data, &mut count, &mut flags, None, None)?;
                    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                        pending.resize(pending.len() + count as usize * 2, 0)
                    } else if !data.is_null() {
                        pending.extend_from_slice(std::slice::from_raw_parts(
                            data,
                            count as usize * 2,
                        ));
                    }
                    capture.ReleaseBuffer(count)?;
                    idle = Instant::now();
                    available = capture.GetNextPacketSize()?;
                }
                // Loopback can stop delivering buffers while silent; keep the ASR connection alive at real-time rate.
                if idle.elapsed() > Duration::from_millis(40)
                    && last_silence.elapsed() > Duration::from_millis(40)
                {
                    pending.resize(pending.len().max(1280), 0);
                    last_silence = Instant::now();
                }
                while pending.len() >= 1280 {
                    let rest = pending.split_off(1280);
                    let pcm = std::mem::replace(&mut pending, rest);
                    let level = pcm
                        .chunks_exact(2)
                        .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs() as f32 / 32768.0)
                        .fold(0.0, f32::max);
                    match frames.try_send(Frame {
                        pcm,
                        source: label.into(),
                        level,
                        at: now_ms(),
                    }) {
                        Ok(_) => {}
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            bail!("音频队列积压，请检查网络后重试")
                        }
                        Err(_) => return Ok(()),
                    }
                }
                thread::sleep(Duration::from_millis(8));
            }
            Ok(())
        })();
        let _ = client.Stop();
        result
    }
}

#[cfg(test)]
mod process_support_tests {
 use super::*;
 #[test]fn updated_windows_10_is_not_rejected_by_the_sdk_version_label(){
  for build in [19041,19044,19045,20348,22000,26100]{assert!(process_capture_candidate(Some(build)),"build {build} must reach runtime activation");}
  for build in [17763,18363]{assert!(!process_capture_candidate(Some(build)));}
  assert!(process_capture_candidate(None),"an unknown version must be determined by runtime activation");
 }
}
