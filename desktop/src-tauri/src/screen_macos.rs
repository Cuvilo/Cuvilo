//! macOS interactive region picker and OCR bridge.
use anyhow::{Context, Result};
use std::ffi::c_char;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

unsafe extern "C" {
    fn mac_ocr_recognize_png(
        png_bytes: *const u8,
        png_len: usize,
        error_out: *mut *mut c_char,
    ) -> *mut c_char;
    fn mac_audio_free_string(s: *mut c_char);
}

pub struct Crop {
    pub width: i32,
    pub height: i32,
    pub pixels: Vec<u8>,
}

#[cfg(test)]
pub(super) static FIXTURE_SELECTION: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub fn bmp(crop: &Crop) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(54 + crop.pixels.len());
    bytes.extend(b"BM");
    bytes.extend(((54 + crop.pixels.len()) as u32).to_le_bytes());
    bytes.extend([0; 4]);
    bytes.extend(54u32.to_le_bytes());
    bytes.extend(40u32.to_le_bytes());
    bytes.extend(crop.width.to_le_bytes());
    bytes.extend((-crop.height).to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(32u16.to_le_bytes());
    bytes.extend([0; 24]);
    bytes.extend(&crop.pixels);
    bytes
}

pub fn languages() -> Result<Vec<String>> {
    Ok(vec!["zh-Hans".into(), "en-US".into()])
}

pub fn recognize(crop: Crop, cancel: Arc<AtomicBool>) -> Result<(String, Vec<u8>)> {
    let bmp_bytes = bmp(&crop);
    if cancel.load(Ordering::Acquire) {
        return Ok((String::new(), vec![]));
    }
    let png_bytes = crate::remote_ocr::png_image(crop.width, crop.height, &crop.pixels)?;
    let mut err_ptr: *mut c_char = std::ptr::null_mut();
    let text_ptr = unsafe {
        mac_ocr_recognize_png(png_bytes.as_ptr(), png_bytes.len(), &mut err_ptr)
    };
    if text_ptr.is_null() {
        let msg = if !err_ptr.is_null() {
            let s = unsafe { std::ffi::CStr::from_ptr(err_ptr) }
                .to_string_lossy()
                .into_owned();
            unsafe { mac_audio_free_string(err_ptr) };
            s
        } else {
            "Apple Vision OCR 识别失败".into()
        };
        anyhow::bail!("{msg}");
    }
    let text = unsafe { std::ffi::CStr::from_ptr(text_ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { mac_audio_free_string(text_ptr) };
    if cancel.load(Ordering::Acquire) {
        return Ok((String::new(), vec![]));
    }
    Ok((text, bmp_bytes))
}

pub fn select(cancel: Arc<AtomicBool>, _english: bool) -> Result<Option<Crop>> {
    if cancel.load(Ordering::Acquire) {
        return Ok(None);
    }
    let temp_file = std::env::temp_dir().join(format!("cuvilo_crop_{}.png", crate::types::new_id()));
    let temp_path = temp_file.to_string_lossy().to_string();

    let mut child = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-r", "-x", &temp_path])
        .spawn()
        .context("无法启动 macOS 屏幕截图工具")?;

    while !cancel.load(Ordering::Acquire) {
        if let Some(status) = child.try_wait()? {
            if !status.success() || !temp_file.exists() {
                let _ = std::fs::remove_file(&temp_file);
                return Ok(None);
            }
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    if cancel.load(Ordering::Acquire) {
        let _ = child.kill();
        let _ = std::fs::remove_file(&temp_file);
        return Ok(None);
    }

    let file_bytes = std::fs::read(&temp_file)?;
    let _ = std::fs::remove_file(&temp_file);

    let mut decoder = png::Decoder::new(std::io::Cursor::new(file_bytes));
    decoder.set_transformations(
        png::Transformations::EXPAND | png::Transformations::STRIP_16 | png::Transformations::ALPHA,
    );
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0; reader.output_buffer_size().context("无法读取截图缓冲区大小")?];
    let info = reader.next_frame(&mut buf)?;
    let mut width = info.width as i32;
    let mut height = info.height as i32;

    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    match info.color_type {
        png::ColorType::Rgba => {
            for chunk in buf[..info.buffer_size()].chunks_exact(4) {
                pixels.extend_from_slice(&[chunk[2], chunk[1], chunk[0], chunk[3]]);
            }
        }
        png::ColorType::Rgb => {
            for chunk in buf[..info.buffer_size()].chunks_exact(3) {
                pixels.extend_from_slice(&[chunk[2], chunk[1], chunk[0], 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for chunk in buf[..info.buffer_size()].chunks_exact(2) {
                pixels.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
            }
        }
        png::ColorType::Grayscale => {
            for &g in &buf[..info.buffer_size()] {
                pixels.extend_from_slice(&[g, g, g, 255]);
            }
        }
        _ => anyhow::bail!("不支持的截图颜色格式"),
    }

    while width > 1 && height > 1 && (width as u64) * (height as u64) > 8_000_000 {
        let new_w = (width / 2).max(1);
        let new_h = (height / 2).max(1);
        let mut scaled = Vec::with_capacity((new_w * new_h * 4) as usize);
        for y in 0..new_h {
            let sy = (y * 2) as usize;
            for x in 0..new_w {
                let sx = (x * 2) as usize;
                let idx = (sy * width as usize + sx) * 4;
                scaled.extend_from_slice(&pixels[idx..idx + 4]);
            }
        }
        width = new_w;
        height = new_h;
        pixels = scaled;
    }

    Ok(Some(Crop { width, height, pixels }))
}
