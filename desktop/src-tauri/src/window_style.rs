// Preserve the native caption controls while overriding Windows accent tint.
// https://learn.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
pub fn apply(raw: *mut std::ffi::c_void) {
    apply_theme(raw,false);
}
pub fn apply_theme(raw:*mut std::ffi::c_void,dark:bool){
    let (caption,text)=if dark{(24,229)}else{(245,23)};
    apply_neutral(raw,caption,text);
}
pub fn apply_neutral(raw:*mut std::ffi::c_void,caption:u32,text:u32){
    #[cfg(target_os = "windows")]
    {
        let hwnd = windows::Win32::Foundation::HWND(raw);
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DwmGetWindowAttribute, DwmFlush, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_TRANSITIONS_FORCEDISABLED};
        // COLORREF is 0x00BBGGRR. Neutral components are intentionally equal.
        let caption=caption.min(255)*0x010101;
        let text=text.min(255)*0x010101;
        unsafe {
            let mut previous_transition=0i32;
            let _=DwmGetWindowAttribute(hwnd,DWMWA_TRANSITIONS_FORCEDISABLED,&mut previous_transition as *mut _ as _,4);
            let no_transition=1i32;
            let _=DwmSetWindowAttribute(hwnd,DWMWA_TRANSITIONS_FORCEDISABLED,&no_transition as *const _ as _,4);
            // Older Windows versions may not support these attributes; native light theme remains.
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, &caption as *const _ as _, 4);
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, &text as *const _ as _, 4);
            crate::update_caption::refresh(raw,caption,text);
            let _=DwmFlush();
            let _=DwmSetWindowAttribute(hwnd,DWMWA_TRANSITIONS_FORCEDISABLED,&previous_transition as *const _ as _,4);
        }
    }
}
