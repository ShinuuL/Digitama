//! Print da tela com GDI (BitBlt), reduzido para no máximo MAX_W×MAX_H e
//! codificado em PNG. Nada é gravado em disco: a imagem vai direto para o chat
//! ou para quem chamou a ferramenta MCP.

use base64::Engine;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    CAPTUREBLT, DIB_RGB_COLORS, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// Limite do lado maior: o Claude reduz imagens grandes de qualquer jeito, e
/// assim o print gasta menos da janela de contexto.
const MAX_W: u32 = 1600;
const MAX_H: u32 = 1000;

pub struct Shot {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

/// `all` = todos os monitores; senão, o monitor onde está o cursor.
/// Reduzido para no máximo MAX_W×MAX_H (vai para o Claude).
pub fn capture(all: bool) -> Result<Shot, String> {
    let (x, y, w, h) = if all { virtual_screen() } else { cursor_monitor()? };
    if w <= 0 || h <= 0 {
        return Err("tela sem tamanho".into());
    }
    let bgra = grab(x, y, w, h)?;
    let (rgb, ow, oh) = downscale(&bgra, w as u32, h as u32);
    let png = encode_png(&rgb, ow, oh)?;
    Ok(Shot { png_base64: base64::engine::general_purpose::STANDARD.encode(png), width: ow, height: oh })
}

/// O monitor do cursor em resolução cheia, para o recorte estilo Lightshot,
/// com o retângulo dele em pixels físicos (x, y, largura, altura).
pub fn capture_full() -> Result<(Shot, (i32, i32, i32, i32)), String> {
    let rect = cursor_monitor()?;
    let (x, y, w, h) = rect;
    let bgra = grab(x, y, w, h)?;
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in bgra.chunks_exact(4) {
        rgb.extend_from_slice(&[px[2], px[1], px[0]]);
    }
    let png = encode_png(&rgb, w as u32, h as u32)?;
    let shot = Shot { png_base64: base64::engine::general_purpose::STANDARD.encode(png), width: w as u32, height: h as u32 };
    Ok((shot, rect))
}

/// Põe um PNG na área de transferência como imagem (CF_DIB), como o Print faz.
pub fn copy_png_to_clipboard(png_bytes: &[u8]) -> Result<(), String> {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (info.width as usize, info.height as usize);
    let channels = match info.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        _ => return Err("PNG precisa ser RGB ou RGBA".into()),
    };
    if info.bit_depth != png::BitDepth::Eight {
        return Err("PNG precisa ter 8 bits por canal".into());
    }

    // BITMAPINFOHEADER + pixels BGRA de baixo para cima.
    let header_len = 40usize;
    let mut dib = vec![0u8; header_len + w * h * 4];
    dib[0..4].copy_from_slice(&(header_len as u32).to_le_bytes());
    dib[4..8].copy_from_slice(&(w as i32).to_le_bytes());
    dib[8..12].copy_from_slice(&(h as i32).to_le_bytes());
    dib[12..14].copy_from_slice(&1u16.to_le_bytes());
    dib[14..16].copy_from_slice(&32u16.to_le_bytes());
    for y in 0..h {
        let src_row = &buf[y * w * channels..(y + 1) * w * channels];
        let dst_start = header_len + (h - 1 - y) * w * 4;
        for x in 0..w {
            let s = &src_row[x * channels..x * channels + channels];
            let d = dst_start + x * 4;
            dib[d] = s[2];
            dib[d + 1] = s[1];
            dib[d + 2] = s[0];
            dib[d + 3] = if channels == 4 { s[3] } else { 255 };
        }
    }

    const CF_DIB: u32 = 8;
    unsafe {
        OpenClipboard(None).map_err(|e| format!("área de transferência ocupada: {e}"))?;
        let result = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let mem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, dib.len()).map_err(|e| e.to_string())?;
            let ptr = GlobalLock(mem) as *mut u8;
            if ptr.is_null() {
                return Err("GlobalLock falhou".into());
            }
            std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr, dib.len());
            let _ = GlobalUnlock(mem);
            // Depois do SetClipboardData a memória pertence ao sistema.
            SetClipboardData(CF_DIB, Some(HANDLE(mem.0))).map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}

fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

fn cursor_monitor() -> Result<(i32, i32, i32, i32), String> {
    let (cx, cy) = crate::winsys::cursor_pos().unwrap_or((0, 0));
    unsafe {
        let mon = MonitorFromPoint(POINT { x: cx, y: cy }, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut info).as_bool() {
            return Err("não consegui ler o monitor".into());
        }
        let r = info.rcMonitor;
        Ok((r.left, r.top, r.right - r.left, r.bottom - r.top))
    }
}

/// Os pixels da área, em BGRA de cima para baixo.
fn grab(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("GetDC falhou".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bitmap.into());
        let blit = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negativo: linhas de cima para baixo
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(mem, bitmap, 0, h as u32, Some(buf.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);

        SelectObject(mem, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        blit.map_err(|e| format!("BitBlt falhou: {e}"))?;
        if lines == 0 {
            return Err("GetDIBits falhou".into());
        }
        Ok(buf)
    }
}

/// BGRA → RGB, reduzindo por média de blocos quando passa do limite.
fn downscale(bgra: &[u8], w: u32, h: u32) -> (Vec<u8>, u32, u32) {
    let ratio = (w as f64 / MAX_W as f64).max(h as f64 / MAX_H as f64).max(1.0);
    let ow = ((w as f64 / ratio).round() as u32).max(1);
    let oh = ((h as f64 / ratio).round() as u32).max(1);
    let mut out = vec![0u8; (ow * oh * 3) as usize];
    for oy in 0..oh {
        let y0 = (oy as f64 * ratio) as u32;
        let y1 = (((oy + 1) as f64 * ratio) as u32).clamp(y0 + 1, h);
        for ox in 0..ow {
            let x0 = (ox as f64 * ratio) as u32;
            let x1 = (((ox + 1) as f64 * ratio) as u32).clamp(x0 + 1, w);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row = (y * w) as usize * 4;
                for x in x0..x1 {
                    let i = row + x as usize * 4;
                    b += bgra[i] as u32;
                    g += bgra[i + 1] as u32;
                    r += bgra[i + 2] as u32;
                    n += 1;
                }
            }
            let o = ((oy * ow + ox) * 3) as usize;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
        }
    }
    (out, ow, oh)
}

fn encode_png(rgb: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgb).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduz_mantendo_a_proporcao_e_converte_bgra_para_rgb() {
        let (w, h) = (3200u32, 1000u32);
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        for px in bgra.chunks_mut(4) {
            px.copy_from_slice(&[10, 20, 30, 255]);
        }
        let (rgb, ow, oh) = downscale(&bgra, w, h);
        assert_eq!((ow, oh), (1600, 500));
        assert_eq!(&rgb[..3], &[30, 20, 10]);
        let (_, sw, sh) = downscale(&bgra[..(100 * 50 * 4)], 100, 50);
        assert_eq!((sw, sh), (100, 50));
    }
}
