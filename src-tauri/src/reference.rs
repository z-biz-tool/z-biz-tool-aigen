//! 参考图（doc/优化方案/02 §1.2 的第三项，任务 T-Batch/图片字段）。
//!
//! 信任边界：渲染进程此前**没有**任意读盘能力（阶段一把 `fs` 权限收掉了），
//! 所以这里由 Rust 侧提供唯一的读图入口，并施加硬约束：
//! - 只接受 ① 用户经原生 open 对话框亲手选中的路径 ② 已经在 `results/` 里的历史产物
//! - 必须是常规文件、≤ MAX_REFERENCE_BYTES、魔数必须是 PNG/JPEG/WEBP/GIF
//! - 只回 data URL 给前端，前端再作为参数发给上游（不接受任意路径直读后回显目录结构）

use crate::error::{code, GenError};
use crate::history::{self, Record};
use serde::Serialize;

/// 上游大多把 base64 参考图放在请求体里，8MB 原图编码后约 11MB，够用了
pub const MAX_REFERENCE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceImage {
    /// `data:image/png;base64,...`
    pub data_url: String,
    pub bytes: usize,
    pub ext: String,
    /// 来源：path（用户选的）| record（复用已生成的结果）
    pub source: String,
}

fn sniff(buf: &[u8]) -> Option<&'static str> {
    if buf.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if buf.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if buf.starts_with(b"GIF87a") || buf.starts_with(b"GIF89a") {
        Some("gif")
    } else if buf.len() >= 12 && &buf[..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn encode(bytes: Vec<u8>, ext: &str, source: &str) -> ReferenceImage {
    use base64::Engine;
    let len = bytes.len();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    ReferenceImage {
        data_url: format!("data:{};base64,{}", mime_of(ext), b64),
        bytes: len,
        ext: ext.to_string(),
        source: source.to_string(),
    }
}

fn shorten(s: &str) -> String {
    s.chars().take(200).collect()
}

/// 从用户选中的绝对路径读参考图。
pub fn from_path(path: &str) -> Result<ReferenceImage, GenError> {
    let p = std::path::Path::new(path.trim());
    if p.as_os_str().is_empty() {
        return Err(GenError::new(code::INVALID_PARAM, "未选择参考图"));
    }
    // symlink_metadata：不跟随链接，避免用软链把别处的文件绕进来
    let meta = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        // 取不到信息按"参数不对"处理：路径可能根本不存在，不是磁盘故障
        Err(_) => {
            return Err(GenError::new(
                code::INVALID_PARAM,
                "找不到这个参考图文件，或它已经不可读",
            ))
        }
    };
    if !meta.is_file() {
        return Err(GenError::new(
            code::INVALID_PARAM,
            "参考图必须是单个图片文件（不支持文件夹或符号链接）",
        ));
    }
    if meta.len() as usize > MAX_REFERENCE_BYTES {
        return Err(GenError::new(
            code::INVALID_PARAM,
            format!(
                "参考图过大（{} MB），上限是 {} MB",
                meta.len() / (1024 * 1024),
                MAX_REFERENCE_BYTES / (1024 * 1024)
            ),
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| GenError::storage(shorten(&e.to_string())))?;
    let ext = sniff(&bytes).ok_or_else(|| {
        GenError::new(
            code::INVALID_PARAM,
            "只支持 PNG / JPEG / WEBP / GIF 参考图（按文件头判断，不看扩展名）",
        )
    })?;
    Ok(encode(bytes, ext, "path"))
}

/// 复用已落盘的历史结果当参考图：路径只能来自历史引用，不新增读盘面
pub fn from_record(record: &Record, ref_index: Option<usize>) -> Result<ReferenceImage, GenError> {
    let idx = ref_index.unwrap_or(0);
    let rel = record
        .result_refs
        .get(idx)
        .ok_or_else(|| GenError::new(code::INVALID_PARAM, "这条历史没有可复用的结果文件"))?;
    if rel.starts_with("http://")
        || rel.starts_with("https://")
        || rel.starts_with("task:")
        || rel.starts_with("data:")
    {
        return Err(GenError::new(
            code::INVALID_PARAM,
            "这条记录的结果没有落在本地，先导出或重新生成后再复用",
        ));
    }
    let abs = history::Store::resolve_ref(rel);
    let bytes = std::fs::read(&abs)
        .map_err(|e| GenError::storage(format!("读取历史结果失败：{}", shorten(&e.to_string()))))?;
    let ext = sniff(&bytes)
        .ok_or_else(|| GenError::new(code::STORAGE, "历史结果文件已损坏或不是可识别的图片"))?;
    Ok(encode(bytes, ext, "record"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n-fake-payload";
    const JPEG: &[u8] = b"\xff\xd8\xffE0jpeg";

    #[test]
    fn sniffs_by_magic_not_extension() {
        assert_eq!(sniff(PNG), Some("png"));
        assert_eq!(sniff(JPEG), Some("jpg"));
        assert_eq!(sniff(b"GIF89a.."), Some("gif"));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        webp[4..8].copy_from_slice(&12u32.to_le_bytes());
        assert_eq!(sniff(&webp), Some("webp"));
        // 改扩展名没用
        assert_eq!(sniff(b"\x00\x01binary"), None);
    }

    #[test]
    fn path_source_is_size_and_type_checked() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("ref.png");
        std::fs::write(&ok, PNG).unwrap();
        let got = from_path(ok.to_str().unwrap()).unwrap();
        assert_eq!(got.source, "path");
        assert_eq!(got.ext, "png");
        assert!(got.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(got.bytes, PNG.len());

        // 目录 / 不存在 / 空路径
        assert_eq!(
            from_path(dir.path().to_str().unwrap()).unwrap_err().code,
            code::INVALID_PARAM
        );
        assert_eq!(
            from_path("/nonexistent/a.png").unwrap_err().code,
            code::INVALID_PARAM
        );
        assert_eq!(from_path("   ").unwrap_err().code, code::INVALID_PARAM);

        // 非图片内容，即使扩展名是 .png
        let bad = dir.path().join("evil.png");
        std::fs::write(&bad, b"#!/bin/sh\nrm -rf /").unwrap();
        let err = from_path(bad.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, code::INVALID_PARAM);
        assert!(
            err.message.contains("PNG / JPEG / WEBP / GIF"),
            "{}",
            err.message
        );

        // 超限
        let big = dir.path().join("big.png");
        let mut payload = PNG.to_vec();
        payload.extend(std::iter::repeat_n(b'x', MAX_REFERENCE_BYTES + 1));
        std::fs::write(&big, &payload).unwrap();
        assert!(from_path(big.to_str().unwrap())
            .unwrap_err()
            .message
            .contains("过大"));
    }

    #[test]
    fn symlink_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.png");
        std::fs::write(&target, PNG).unwrap();
        #[cfg(unix)]
        {
            let link = dir.path().join("link.png");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let err = from_path(link.to_str().unwrap()).unwrap_err();
            assert_eq!(err.code, code::INVALID_PARAM);
            assert!(err.message.contains("符号链接"), "{}", err.message);
        }
    }

    #[test]
    fn record_source_only_reads_stored_results() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let rel = history::save_result_bytes("r1", 0, "png", JPEG).unwrap();
        let rec = Record {
            id: "r1".into(),
            kind: "image".into(),
            prompt: "p".into(),
            model: None,
            params: serde_json::Map::new(),
            result_refs: vec![rel],
            text_result: None,
            status: "succeeded".into(),
            created_at: history::now_iso8601(),
            usage: None,
            favorite: false,
        };
        let got = from_record(&rec, None).unwrap();
        assert_eq!(got.source, "record");
        assert!(got.data_url.starts_with("data:image/jpeg;base64,"));

        // 越界/远程/未产出的一律拒绝
        let remote = Record {
            result_refs: vec!["https://cdn/x.png".into()],
            ..rec.clone()
        };
        assert_eq!(
            from_record(&remote, None).unwrap_err().code,
            code::INVALID_PARAM
        );
        let task = Record {
            result_refs: vec!["task:abc".into()],
            ..rec.clone()
        };
        assert!(from_record(&task, None)
            .unwrap_err()
            .message
            .contains("没有落在本地"));
        let none = Record {
            result_refs: vec![],
            ..rec.clone()
        };
        assert_eq!(
            from_record(&none, Some(3)).unwrap_err().code,
            code::INVALID_PARAM
        );
        // 历史引用被删掉后不能崩溃，要给存储错误
        let gone = Record {
            result_refs: vec!["results/ghost.png".into()],
            ..rec
        };
        assert_eq!(from_record(&gone, None).unwrap_err().code, code::STORAGE);
    }
}
