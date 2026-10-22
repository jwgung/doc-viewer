// 파일 내용으로 문서 형식을 정한다. Android DocFormat.detect와 같은 규칙이라 함께 고친다.
// 메신저로 받은 파일처럼 확장자가 실제 형식과 다르거나 없는 경우가 있어서다.

use std::{
    fs::File,
    io::{BufReader, Read},
    path::Path,
};

const PDF_MAGIC: &[u8] = b"%PDF";
const ZIP_MAGIC: &[u8] = &[0x50, 0x4B, 0x03, 0x04];
const CFB_MAGIC: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const HWP3_MAGIC: &[u8] = b"HWP Document File";

/// 판별 결과. 셸(src/shell.js)은 content → 확장자 → text 순으로 쓴다.
#[derive(Default, Debug, PartialEq)]
pub struct Detected {
    /// 내용(서명·내부 구조)으로 확실히 정한 형식. 확장자보다 앞선다.
    pub content: Option<&'static str>,
    /// 서명이 없는 글자 파일이면 첫 글자로 가린 형식(json·xml·txt). 확장자로도 모를 때만 쓴다.
    pub text: Option<&'static str>,
}

pub fn detect(path: &Path) -> Detected {
    let mut head = [0u8; 4096];
    let read = File::open(path).and_then(|mut f| read_up_to(&mut f, &mut head)).unwrap_or(0);
    let head = &head[..read];
    let content = if head.starts_with(PDF_MAGIC) {
        Some("pdf")
    } else if head.starts_with(ZIP_MAGIC) {
        zip_format(path)
    } else if head.starts_with(CFB_MAGIC) {
        compound_format(path)
    } else if head.starts_with(HWP3_MAGIC) {
        Some("hwp")
    } else {
        None
    };
    let text = if content.is_none() && looks_like_text(head) { Some(sniff_text(head)) } else { None };
    Detected { content, text }
}

fn read_up_to(file: &mut File, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    while total < buffer.len() {
        match file.read(&mut buffer[total..])? {
            0 => break,
            n => total += n,
        }
    }
    Ok(total)
}

/// OOXML·HWPX는 ZIP 안의 경로로 구분한다.
fn zip_format(path: &Path) -> Option<&'static str> {
    let mut zip = zip::ZipArchive::new(BufReader::new(File::open(path).ok()?)).ok()?;
    let names: Vec<String> = zip.file_names().map(str::to_owned).collect();
    let mut mimetype = String::new();
    if let Ok(entry) = zip.by_name("mimetype") {
        let _ = entry.take(64).read_to_string(&mut mimetype);
    }
    if mimetype.starts_with("application/hwp+zip") || names.iter().any(|n| n == "Contents/content.hpf") {
        Some("hwpx")
    } else if names.iter().any(|n| n.starts_with("word/")) {
        Some("docx")
    } else if names.iter().any(|n| n.starts_with("xl/")) {
        Some("xlsx")
    } else if names.iter().any(|n| n.starts_with("ppt/")) {
        Some("pptx")
    } else {
        None
    }
}

/// HWP·doc·xls·ppt는 모두 CFB(OLE2) 컨테이너라서 맨 위 스트림 이름으로 구분한다.
/// 암호 걸린 docx·xlsx·pptx(EncryptedPackage)는 확장자에 맡긴다. 웹 렌더러가 암호를 푼 뒤 실제 형식을 다시 정한다.
fn compound_format(path: &Path) -> Option<&'static str> {
    let cfb = cfb::open(path).ok()?;
    let names: Vec<String> = cfb.read_root_storage().map(|e| e.name().to_owned()).collect();
    let has = |name: &str| names.iter().any(|n| n == name);
    if has("EncryptedPackage") {
        None
    } else if has("FileHeader") && (has("BodyText") || has("DocInfo")) {
        Some("hwp")
    } else if has("WordDocument") {
        Some("doc")
    } else if has("Workbook") || has("Book") {
        Some("xls")
    } else if has("PowerPoint Document") {
        Some("ppt")
    } else {
        None
    }
}

/// 앞 4KB에 NUL이 없고 제어 문자가 거의 없으면 텍스트로 본다(UTF-16은 NUL이 있어 제외된다).
fn looks_like_text(head: &[u8]) -> bool {
    if head.is_empty() || head.contains(&0) {
        return false;
    }
    let control = head.iter().filter(|&&b| b < 0x20 && !matches!(b, 0x09 | 0x0A | 0x0C | 0x0D | 0x1B)).count();
    control * 50 < head.len()
}

/// 글자 파일의 첫 글자(공백·BOM 뒤)로 JSON·XML을 가려내고, 아니면 텍스트.
/// JSON은 '{', 또는 '[' 뒤에 JSON 값이나 ']'. '[INFO]' 로그·'[section]' 설정은 빠진다.
fn sniff_text(head: &[u8]) -> &'static str {
    let text = String::from_utf8_lossy(&head[..head.len().min(256)]);
    let text = text.trim_start_matches(['\u{FEFF}', ' ', '\t', '\r', '\n']);
    let mut chars = text.chars();
    match chars.next() {
        Some('{') => "json",
        Some('[') => {
            let rest = chars.as_str().trim_start();
            let starts_value = rest.starts_with(['[', '{', '"', ']', '-']) || rest.starts_with(|c: char| c.is_ascii_digit());
            if starts_value || ["true", "false", "null"].iter().any(|w| rest.starts_with(w)) {
                "json"
            } else {
                "txt"
            }
        }
        Some('<') if chars.next().is_some_and(|c| c == '?' || c == '!' || c.is_ascii_alphabetic()) => "xml",
        _ => "txt",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("doc-viewer-detect-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn zip_with(name: &str, entries: &[&str]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("doc-viewer-detect-{}-{name}", std::process::id()));
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for entry in entries {
            zip.start_file(*entry, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn detects_by_content() {
        let cases = [
            (write("a.bin", b"%PDF-1.7\n"), Some("pdf")),
            (zip_with("b.bin", &["[Content_Types].xml", "word/document.xml"]), Some("docx")),
            (zip_with("c.doc", &["xl/workbook.xml"]), Some("xlsx")),
            (zip_with("d.zip", &["mimetype", "Contents/content.hpf"]), Some("hwpx")),
            (zip_with("e.zip", &["readme.txt"]), None),
            (write("f.hwp", b"HWP Document File V3.00 \x1a\x01\x02"), Some("hwp")),
        ];
        for (path, expected) in cases {
            assert_eq!(detect(&path).content, expected, "{path:?}");
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn sniffs_text_without_signature() {
        let cases = [
            (&b"  {\"a\": 1}"[..], "json"),
            (b"[1, 2]", "json"),
            (b"[INFO] started", "txt"),
            (b"\xEF\xBB\xBF<?xml version=\"1.0\"?>", "xml"),
            (b"hello", "txt"),
        ];
        for (i, (bytes, expected)) in cases.into_iter().enumerate() {
            let path = write(&format!("t{i}"), bytes);
            assert_eq!(detect(&path), Detected { content: None, text: Some(expected) });
            std::fs::remove_file(path).unwrap();
        }
        let binary = write("bin", &[0, 1, 2, 3]);
        assert_eq!(detect(&binary), Detected::default());
        std::fs::remove_file(binary).unwrap();
    }
}
