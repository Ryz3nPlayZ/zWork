//! Port of pi `core/tools/image.ts` — magic-byte image detection.
//!
//! Sniffs the image formats the model APIs actually accept. Beyond the
//! well-known signatures this rejects files that would be rejected or
//! mis-encoded downstream: JPEG-XR (shares the JPEG SOI marker but is not
//! JPEG), APNG (animation chunk before the first IDAT), and structurally
//! invalid BMP headers. A wrong `image/*` mime is worse than none — the
//! provider 400s the whole request — so detection errs toward `None`.

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

pub fn detect_supported_image_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        // 0xFFD8FFF7 is JPEG-XR (WPX), which model APIs do not accept.
        return if bytes.get(3) == Some(&0xF7) { None } else { Some("image/jpeg") };
    }
    if bytes.starts_with(&PNG_SIGNATURE) {
        return if is_png(bytes) && !is_animated_png(bytes) { Some("image/png") } else { None };
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") && is_bmp(bytes) {
        return Some("image/bmp");
    }
    None
}

fn read_u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let slice = bytes.get(offset..end)?;
    Some(u32::from_be_bytes(slice.try_into().unwrap()))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let slice = bytes.get(offset..end)?;
    Some(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    let slice = bytes.get(offset..end)?;
    Some(u16::from_le_bytes(slice.try_into().unwrap()))
}

fn starts_with_ascii_at(bytes: &[u8], offset: usize, text: &[u8]) -> bool {
    match bytes.get(offset..offset.saturating_add(text.len())) {
        Some(slice) => slice == text,
        None => false,
    }
}

fn is_png(bytes: &[u8]) -> bool {
    // A valid PNG's first chunk is IHDR with length 13.
    bytes.len() >= 16 && read_u32_be(bytes, PNG_SIGNATURE.len()) == Some(13) && starts_with_ascii_at(bytes, 12, b"IHDR")
}

fn is_animated_png(bytes: &[u8]) -> bool {
    // APNG carries an acTL chunk before the first IDAT.
    let mut offset = PNG_SIGNATURE.len();
    while offset + 8 <= bytes.len() {
        let Some(chunk_length) = read_u32_be(bytes, offset) else { return false };
        let chunk_type_offset = offset + 4;
        if starts_with_ascii_at(bytes, chunk_type_offset, b"acTL") {
            return true;
        }
        if starts_with_ascii_at(bytes, chunk_type_offset, b"IDAT") {
            return false;
        }
        // chunk + length field + type + CRC
        let Some(next_offset) = (offset as u64)
            .checked_add(8)
            .and_then(|v| v.checked_add(chunk_length as u64))
            .and_then(|v| v.checked_add(4))
        else {
            return false;
        };
        if next_offset <= offset as u64 || next_offset > bytes.len() as u64 {
            return false;
        }
        offset = next_offset as usize;
    }
    false
}

fn is_bmp(bytes: &[u8]) -> bool {
    if bytes.len() < 26 {
        return false;
    }
    let declared_file_size = read_u32_le(bytes, 2).unwrap_or(0);
    let pixel_data_offset = read_u32_le(bytes, 10).unwrap_or(0);
    let dib_header_size = read_u32_le(bytes, 14).unwrap_or(0);
    if declared_file_size != 0 && declared_file_size < 26 {
        return false;
    }
    if pixel_data_offset < 14 + dib_header_size {
        return false;
    }
    if declared_file_size != 0 && pixel_data_offset >= declared_file_size {
        return false;
    }

    // BITMAPCOREHEADER (12) puts planes/bpp at 22/24; later DIB headers
    // (40..=124) put them at 26/28.
    let (color_planes, bits_per_pixel) = if dib_header_size == 12 {
        (read_u16_le(bytes, 22), read_u16_le(bytes, 24))
    } else if (40..=124).contains(&dib_header_size) {
        if bytes.len() < 30 {
            return false;
        }
        (read_u16_le(bytes, 26), read_u16_le(bytes, 28))
    } else {
        return false;
    };
    color_planes == Some(1) && matches!(bits_per_pixel, Some(1 | 4 | 8 | 16 | 24 | 32))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PNG header: signature + IHDR chunk (length, type, payload, CRC).
    fn png_prefix() -> Vec<u8> {
        let mut v = PNG_SIGNATURE.to_vec();
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&[0; 13]);
        v.extend_from_slice(&[0; 4]); // CRC
        v
    }

    #[test]
    fn detects_png() {
        assert_eq!(detect_supported_image_mime_type(&png_prefix()), Some("image/png"));
    }

    #[test]
    fn rejects_animated_png() {
        let mut v = png_prefix();
        // acTL chunk before any IDAT marks an APNG.
        v.extend_from_slice(&8u32.to_be_bytes());
        v.extend_from_slice(b"acTL");
        v.extend_from_slice(&[0; 8]);
        assert_eq!(detect_supported_image_mime_type(&v), None);
    }

    #[test]
    fn detects_jpeg_and_rejects_jpeg_xr() {
        assert_eq!(detect_supported_image_mime_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(detect_supported_image_mime_type(&[0xFF, 0xD8, 0xFF, 0xF7]), None);
    }

    #[test]
    fn detects_gif_and_webp() {
        assert_eq!(detect_supported_image_mime_type(b"GIF89a...."), Some("image/gif"));
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(detect_supported_image_mime_type(&webp), Some("image/webp"));
    }

    #[test]
    fn validates_bmp_structure() {
        let mut bmp = vec![b'B', b'M'];
        bmp.extend_from_slice(&[0u8; 4]); // declared size 0 = ignore
        bmp.extend_from_slice(&[0u8; 4]); // reserved
        bmp.extend_from_slice(&54u32.to_le_bytes()); // pixel data offset
        bmp.extend_from_slice(&40u32.to_le_bytes()); // DIB header size
        bmp.extend_from_slice(&[0u8; 8]); // width + height
        bmp.extend_from_slice(&1u16.to_le_bytes()); // planes @ 26
        bmp.extend_from_slice(&24u16.to_le_bytes()); // bpp @ 28
        bmp.resize(64, 0);
        assert_eq!(detect_supported_image_mime_type(&bmp), Some("image/bmp"));

        // Same file but 2 color planes: not a valid BMP.
        let mut bad = bmp.clone();
        bad[26..28].copy_from_slice(&2u16.to_le_bytes());
        assert_eq!(detect_supported_image_mime_type(&bad), None);
    }

    #[test]
    fn rejects_non_images() {
        assert_eq!(detect_supported_image_mime_type(b"hello world, definitely text"), None);
        assert_eq!(detect_supported_image_mime_type(&[]), None);
    }
}
