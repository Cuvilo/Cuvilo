//! macOS interactive region picker and OCR bridge.
use anyhow::{Context, Result};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

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
    Ok((String::new(), bmp_bytes))
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

    let decoder = png::Decoder::new(std::io::Cursor::new(file_bytes));
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf)?;
    let width = info.width as i32;
    let height = info.height as i32;

    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    match info.color_type {
        png::ColorType::Rgba => {
            pixels.extend_from_slice(&buf[..info.buffer_size()]);
        }
        png::ColorType::Rgb => {
            for chunk in buf[..info.buffer_size()].chunks_exact(3) {
                pixels.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
            }
        }
        png::ColorType::Grayscale => {
            for &g in &buf[..info.buffer_size()] {
                pixels.extend_from_slice(&[g, g, g, 255]);
            }
        }
        _ => anyhow::bail!("不支持的截图颜色格式"),
    }

    Ok(Some(Crop { width, height, pixels }))
}
