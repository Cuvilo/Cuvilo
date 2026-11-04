//! Fallback interactive region picker and OCR bridge.
use anyhow::Result;
use std::sync::{Arc, atomic::AtomicBool};

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
    Ok(vec![])
}

pub fn recognize(crop: Crop, _cancel: Arc<AtomicBool>) -> Result<(String, Vec<u8>)> {
    let bmp_bytes = bmp(&crop);
    Ok((String::new(), bmp_bytes))
}

pub fn select(_cancel: Arc<AtomicBool>, _english: bool) -> Result<Option<Crop>> {
    anyhow::bail!("当前系统暂不支持本地截图选区")
}
