#[cfg(test)]
use crate::types::Material;
use anyhow::{bail, Context, Result};
use std::{io::Read, path::Path};
pub fn extract(path: &str) -> Result<String> {
    let path = Path::new(path);
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > 20 * 1024 * 1024 {
        bail!("文件超过 20 MB，请缩小后导入")
    };
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let text = match ext.as_str() {
        "txt" | "md" => std::fs::read_to_string(path).context("请使用 UTF-8 编码的文本")?,
        "pdf" => pdf_extract::extract_text(path)
            .context("PDF 提取失败，可能已加密或不支持该字体；请复制文字后粘贴")?,
        "docx" => {
            let mut archive =
                zip::ZipArchive::new(std::fs::File::open(path)?).context("DOCX 文件无效")?;
            let mut xml = String::new();
            archive
                .by_name("word/document.xml")?
                .take(40 * 1024 * 1024)
                .read_to_string(&mut xml)?;
            let mut reader = quick_xml::Reader::from_str(&xml);
            let mut text = String::new();
            let mut in_text = false;
            loop {
                use quick_xml::events::Event;
                match reader.read_event()? {
                    Event::Start(e) => {
                        if e.name().as_ref() == b"w:t" {
                            in_text = true
                        }
                    }
                    Event::Empty(e) => match e.name().as_ref(){
                        b"w:br"|b"w:cr"=>text.push('\n'),
                        b"w:tab"=>text.push('\t'),
                        _=>{}
                    },
                    Event::Text(t) if in_text => text.push_str(&t.unescape()?),
                    Event::End(e) => match e.name().as_ref() {
                        b"w:t" => in_text = false,
                        b"w:p" | b"w:tr" => text.push('\n'),
                        b"w:tc" => text.push('\t'),
                        _ => {}
                    },
                    Event::Eof => break,
                    _ => {}
                }
            }
            text
        }
        _ => bail!("支持 PDF、DOCX、TXT、Markdown；旧版 DOC 请另存为 DOCX"),
    };
    if text.trim().chars().filter(|c| !c.is_whitespace()).count() < 5 {
        bail!("未能提取有效文字，扫描件需要先转换为文字；本版不含 OCR")
    }
    if text.chars().count() > 100_000 {
        bail!("提取文字超过10万字，请拆分材料后导入")
    };
    Ok(text)
}
#[path="material_context.rs"] mod retrieval;
pub use retrieval::material_context;
#[cfg(test)]
pub fn relevant(materials: &[Material], question: &str) -> String {
    material_context(materials, question, "").text
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retrieves_project() {
        let m = Material {
            id: "1".into(),
            title: "项目".into(),
            kind: "project".into(),
            text: "使用 Redis 缓存解决数据库压力".into(),
            enabled: true,
            updated_at: 0,
        };
        assert!(relevant(&[m], "Redis 项目如何实现").contains("Redis"));
    }
    #[test]
    fn rejects_unsupported_existing_doc() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resume.doc");
        std::fs::write(&path, "a legacy Word document").unwrap();
        assert!(extract(path.to_str().unwrap())
            .unwrap_err()
            .to_string()
            .contains("DOCX"));
    }
}
#[cfg(test)]
mod file_tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn extracts_docx_paragraphs_and_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resume.docx");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(br#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Project &amp; Rust</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>API service</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#).unwrap();
        zip.finish().unwrap();
        let text = extract(path.to_str().unwrap()).unwrap();
        assert!(text.contains("Project & Rust"));
        assert!(text.contains("API service"));
    }
    #[test]
    fn text_roundtrip_and_empty_rejection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resume.md");
        std::fs::write(&path, "# 项目经历\n实现实时语音转写").unwrap();
        assert!(extract(path.to_str().unwrap())
            .unwrap()
            .contains("语音转写"));
        std::fs::write(&path, " ").unwrap();
        assert!(extract(path.to_str().unwrap()).is_err());
    }
}

#[cfg(test)]mod project_review_line_break_tests{
 use super::*;use std::io::Write;
 #[test]fn docx_preserves_explicit_line_breaks_and_tabs_inside_a_paragraph(){
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("code.docx");let mut zip=zip::ZipWriter::new(std::fs::File::create(&path).unwrap());zip.start_file("word/document.xml",zip::write::SimpleFileOptions::default()).unwrap();
  zip.write_all(br#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>def solve():</w:t><w:br/><w:tab/><w:t>return 42</w:t><w:cr/><w:t>next line</w:t></w:r></w:p></w:body></w:document>"#).unwrap();zip.finish().unwrap();
  assert_eq!(extract(path.to_str().unwrap()).unwrap(),"def solve():\n\treturn 42\nnext line\n");
 }
}
