//! Bounded, cancellable preparation for small UI text; the original pixels stay unchanged.
use anyhow::{ensure, Result};
use std::sync::atomic::{AtomicBool, Ordering};

pub struct Prepared {
    pub width: i32,
    pub height: i32,
    pub pixels: Vec<u8>,
}
fn luminance(pixel: &[u8]) -> u8 {
    ((29 * pixel[0] as u32 + 150 * pixel[1] as u32 + 77 * pixel[2] as u32) >> 8) as u8
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Acquire), "识别已取消");
    Ok(())
}
pub fn prepare(width: i32, height: i32, pixels: &[u8], max: i32, cancel: &AtomicBool) -> Result<Prepared> {
    ensure!(width > 0 && height > 0 && max >= 32, "选区无效");
    let (w, h) = (width as usize, height as usize);
    ensure!(w.checked_mul(h).and_then(|n| n.checked_mul(4)) == Some(pixels.len()), "截图像素不完整，请重新框选");
    ensure!(width <= max && height <= max && w * h <= 12_000_000, "选区超过系统识别上限，请缩小选区");
    cancelled(cancel)?;
    // A histogram estimates the dominant background without relying on a particular UI theme.
    let mut histogram = [0usize; 256];
    for (i, pixel) in pixels.chunks_exact(4).enumerate() {
        if i % 65536 == 0 { cancelled(cancel)?; }
        histogram[luminance(pixel) as usize] += 1;
    }
    let background = histogram.iter().enumerate().max_by_key(|(_, count)| **count).unwrap().0;
    let invert = background < 128;
    let mut gray = Vec::with_capacity(w * h);
    let mut rows = Vec::with_capacity(h);
    for y in 0..h {
        if y % 32 == 0 { cancelled(cancel)?; }
        let mut ink = 0;
        for x in 0..w {
            let value = luminance(&pixels[(y * w + x) * 4..][..4]);
            let value = if invert { 255 - value } else { value };
            if value < 160 { ink += 1; }
            gray.push(value);
        }
        rows.push(ink >= 3 && ink < w * 3 / 4);
    }
    // Estimate text height from horizontal ink bands. Skip rules/large blocks and blank images.
    let mut bands = Vec::new();
    let mut run = 0;
    for ink in rows.into_iter().chain(std::iter::once(false)) {
        if ink { run += 1; } else { if (5..=64).contains(&run) { bands.push(run); } run = 0; }
    }
    bands.sort_unstable();
    let text_height = bands.get(bands.len() / 2).copied().unwrap_or(32);
    let requested = (32.0 / text_height as f64).clamp(1.0, 3.0);
    let padding = 8usize;
    let dimension_scale = ((max as usize - padding * 2) as f64 / w.max(h) as f64).min(requested);
    let area = (w * h) as f64;
    let edge = (padding * 2 * (w + h)) as f64;
    let pixel_scale = (-edge + (edge * edge + 4.0 * area * (12_000_000.0 - (padding * padding * 4) as f64)).sqrt()) / (2.0 * area);
    let scale = dimension_scale.min(pixel_scale).max(0.01);
    let out_w = ((w as f64 * scale).floor() as usize).max(1);
    let out_h = ((h as f64 * scale).floor() as usize).max(1);
    let stride = out_w + padding * 2;
    let mut output = vec![255; stride * (out_h + padding * 2)];
    for y in 0..out_h {
        if y % 16 == 0 { cancelled(cancel)?; }
        let sy = ((y as f64 + 0.5) / scale - 0.5).clamp(0.0, (h - 1) as f64);
        let y0 = sy.floor() as usize; let y1 = (y0 + 1).min(h - 1); let dy = sy - y0 as f64;
        for x in 0..out_w {
            let sx = ((x as f64 + 0.5) / scale - 0.5).clamp(0.0, (w - 1) as f64);
            let x0 = sx.floor() as usize; let x1 = (x0 + 1).min(w - 1); let dx = sx - x0 as f64;
            let top = gray[y0 * w + x0] as f64 * (1.0 - dx) + gray[y0 * w + x1] as f64 * dx;
            let bottom = gray[y1 * w + x0] as f64 * (1.0 - dx) + gray[y1 * w + x1] as f64 * dx;
            output[(y + padding) * stride + x + padding] = (top * (1.0 - dy) + bottom * dy).round() as u8;
        }
    }
    Ok(Prepared { width: stride as i32, height: (out_h + padding * 2) as i32, pixels: output })
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_incomplete_pixels_and_cancellation() {
        let cancel = AtomicBool::new(false);
        assert!(prepare(10, 10, &[255; 10], 4096, &cancel).is_err());
        cancel.store(true, Ordering::Release);
        assert!(prepare(10, 10, &[255; 400], 4096, &cancel).is_err());
    }
    #[test] fn preserves_original_and_normalizes_dark_background() {
        let mut pixels = vec![20; 100 * 40 * 4];
        for y in 10..24 { for x in 10..70 { let i = (y * 100 + x) * 4; pixels[i..i+4].fill(240); } }
        let original = pixels.clone(); let output = prepare(100, 40, &pixels, 4096, &AtomicBool::new(false)).unwrap();
        assert_eq!(pixels, original); assert!(output.width > 116);
        assert_eq!(output.pixels[8 * output.width as usize + 8], 235);
        assert_eq!(output.pixels.len(), output.width as usize * output.height as usize);
    }
    #[test] fn padding_is_included_in_pixel_budget() {
        let pixels = vec![255; 4000 * 2900 * 4];
        let output = prepare(4000, 2900, &pixels, 4096, &AtomicBool::new(false)).unwrap();
        assert!(output.pixels.len() <= 12_000_000);
    }
    #[test] fn bounds_scaled_dimensions_and_blank_images() {
        let pixels = vec![255; 4096 * 8 * 4];
        let output = prepare(4096, 8, &pixels, 4096, &AtomicBool::new(false)).unwrap();
        assert!(output.width <= 4096 && output.height <= 4096);
        assert!(output.pixels.iter().all(|v| *v == 255));
    }
}
