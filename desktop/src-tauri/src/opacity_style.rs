//! Tao rebuilds GWL_EXSTYLE on show/pin changes. Preserve our owned layered bit through that rebuild.
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
         WindowsAndMessaging::{GWL_EXSTYLE, STYLESTRUCT, WM_NCDESTROY, WM_STYLECHANGING, WS_EX_LAYERED}},
};
const SUBCLASS_ID: usize = 0x4355_564f;
unsafe extern "system" fn layered_style(
    hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, id: usize, _: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(layered_style), id);
        return DefSubclassProc(hwnd, message, wparam, lparam);
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if message == WM_STYLECHANGING && wparam.0 as i32 == GWL_EXSTYLE.0 && lparam.0 != 0 {
        (*(lparam.0 as *mut STYLESTRUCT)).styleNew |= WS_EX_LAYERED.0;
    }
    result
}
pub fn installed(hwnd: HWND) -> bool {
    unsafe { GetWindowSubclass(hwnd, Some(layered_style), SUBCLASS_ID, None).as_bool() }
}
pub fn install(hwnd: HWND) -> Result<bool, String> {
    if installed(hwnd) { return Ok(false); }
    if unsafe { SetWindowSubclass(hwnd, Some(layered_style), SUBCLASS_ID, 0) }.as_bool() {
        Ok(true)
    } else {
        Err("无法保持答案窗透明度，请重试".into())
    }
}
pub fn remove(hwnd: HWND) {
    unsafe { let _ = RemoveWindowSubclass(hwnd, Some(layered_style), SUBCLASS_ID); }
}
