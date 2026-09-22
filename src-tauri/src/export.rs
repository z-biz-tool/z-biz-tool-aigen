//! 统一导出（doc/优化方案/02 §6，任务 T-Export）。
//!
//! 前端用 `dialog` 插件拿到用户选定的目标路径，这里负责取源、校验、原子落盘。
//! 覆盖已有文件属破坏性操作：默认拒绝，必须由前端二次确认后显式带 `allow_overwrite`（04 §6）。

use crate::ai_client;
use crate::error::{code, GenError};
use crate::history::{self, Record};
use reqwest::Client;
use serde::Serialize;
use std::path::Path;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct Exported {
    pub path: String,
    pub bytes: usize,
    /// file（来自已落盘的结果文件）| text（文本结果）| remote（现场下载）
    pub source: String,
}

fn is_remote_ref(s: &str) -> bool {
    let low = s.to_ascii_lowercase();
    low.starts_with("https://") || low.starts_with("http://")
}

fn is_task_ref(s: &str) -> bool {
    s.starts_with("task:")
}

/// 解析并写出。`record` 与 `text` 二者至少给一个。
pub async fn write_export(
    client: &Client,
    record: Option<&Record>,
    ref_index: Option<usize>,
    inline_text: Option<&str>,
    target: &Path,
    allow_overwrite: bool,
    cancel: &CancellationToken,
) -> Result<Exported, GenError> {
    if target.as_os_str().is_empty() {
        return Err(GenError::new(code::INVALID_PARAM, "未选择导出路径"));
    }
    if is_task_ref_from(record, ref_index) {
        return Err(GenError::new(
            code::INVALID_PARAM,
            "视频任务尚未产出可下载结果（异步轮询未完成）",
        ));
    }

    let (bytes, source) = resolve_source(client, record, ref_index, inline_text, cancel).await?;

    if bytes.len() > history::MAX_RESULT_BYTES {
        return Err(GenError::new(
            code::STORAGE,
            format!("导出内容过大（{} 字节）", bytes.len()),
        ));
    }
    if target.is_dir() {
        return Err(GenError::new(
            code::INVALID_PARAM,
            "目标是一个目录，请选择具体文件名",
        ));
    }
    if target.exists() && !allow_overwrite {
        return Err(GenError::conflict(&target.to_string_lossy()));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| GenError::storage(format!("创建目录失败: {e}")))?;
        }
    }
    crate::secret::atomic_write(target, &bytes)
        .map_err(|e| GenError::storage(format!("写入导出文件失败: {e}")))?;

    Ok(Exported {
        path: target.to_string_lossy().to_string(),
        bytes: bytes.len(),
        source,
    })
}

fn is_task_ref_from(record: Option<&Record>, ref_index: Option<usize>) -> bool {
    let Some(r) = record else { return false };
    let idx = ref_index.unwrap_or(0);
    match r.result_refs.get(idx) {
        Some(v) => is_task_ref(v),
        None => false,
    }
}

async fn resolve_source(
    client: &Client,
    record: Option<&Record>,
    ref_index: Option<usize>,
    inline_text: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(Vec<u8>, String), GenError> {
    if let Some(r) = record {
        let idx = ref_index.unwrap_or(0);
        if let Some(rel) = r.result_refs.get(idx) {
            if is_remote_ref(rel) {
                let bytes =
                    ai_client::fetch_bytes(client, rel, cancel, crate::ai_client::IMAGE_TIMEOUT)
                        .await?;
                return Ok((bytes, "remote".to_string()));
            }
            if !is_task_ref(rel) {
                let abs = history::Store::resolve_ref(rel);
                let bytes = std::fs::read(&abs)
                    .map_err(|e| GenError::storage(format!("读取结果文件失败: {e}")))?;
                return Ok((bytes, "file".to_string()));
            }
        }
        // 文本类结果（含 PPT 之外的 text 生成）
        if let Some(t) = &r.text_result {
            return Ok((t.as_bytes().to_vec(), "text".to_string()));
        }
        // PPT：result_refs[0] 已被上面处理；走到这里说明引用不可用
        if !r.result_refs.is_empty() {
            return Err(GenError::new(
                code::STORAGE,
                format!(
                    "结果 {} 已不在本地，无法导出",
                    r.result_refs[idx.min(r.result_refs.len() - 1)]
                ),
            ));
        }
    }
    // 面板当场展示的结果：data URL 直接解码、http(s) 现场拉取、其余按纯文本处理
    if let Some(t) = inline_text.map(str::trim).filter(|s| !s.is_empty()) {
        if t.starts_with("data:") {
            let (bytes, _ext) = history::decode_data_url(t)
                .ok_or_else(|| GenError::new(code::PARSE, "结果数据无法解码，无法导出"))?;
            return Ok((bytes, "dataurl".to_string()));
        }
        if is_remote_ref(t) {
            let bytes =
                ai_client::fetch_bytes(client, t, cancel, crate::ai_client::IMAGE_TIMEOUT).await?;
            return Ok((bytes, "remote".to_string()));
        }
        return Ok((t.as_bytes().to_vec(), "text".to_string()));
    }
    Err(GenError::new(
        code::INVALID_PARAM,
        "没有可导出的内容（结果未留存且无文本）",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{now_iso8601, Record};
    use std::path::PathBuf;

    fn record(refs: Vec<String>, text: Option<String>) -> Record {
        Record {
            id: "r1".into(),
            kind: "text".into(),
            prompt: "p".into(),
            model: None,
            params: serde_json::Map::new(),
            result_refs: refs,
            text_result: text,
            status: "succeeded".into(),
            created_at: now_iso8601(),
            usage: None,
            favorite: false,
        }
    }

    fn token() -> CancellationToken {
        CancellationToken::new()
    }

    #[tokio::test]
    async fn exports_inline_text_to_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("笔记.md");
        let out = write_export(
            &Client::new(),
            None,
            None,
            Some("# 标题\n正文"),
            &target,
            false,
            &token(),
        )
        .await
        .unwrap();
        assert_eq!(out.source, "text");
        assert_eq!(out.bytes, "# 标题\n正文".len());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "# 标题\n正文");
    }

    #[tokio::test]
    async fn copies_existing_local_result_file() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let rel = history::save_result_bytes("exp1", 0, "png", b"\x89PNG-bytes").unwrap();
        let rec = record(vec![rel], None);
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("导出 图片.png");
        let out = write_export(
            &Client::new(),
            Some(&rec),
            Some(0),
            None,
            &target,
            false,
            &token(),
        )
        .await
        .unwrap();
        assert_eq!(out.source, "file");
        assert_eq!(std::fs::read(&target).unwrap(), b"\x89PNG-bytes");
    }

    #[tokio::test]
    async fn refuses_overwrite_without_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.txt");
        std::fs::write(&target, b"old").unwrap();
        let err = write_export(
            &Client::new(),
            None,
            None,
            Some("new"),
            &target,
            false,
            &token(),
        )
        .await
        .expect_err("must refuse");
        assert_eq!(err.code, code::CONFLICT);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "old",
            "拒绝覆盖时不该改动原文件"
        );
        assert!(
            !target.with_extension("txt.tmp").exists(),
            "不应留下临时文件"
        );

        let out = write_export(
            &Client::new(),
            None,
            None,
            Some("new"),
            &target,
            true,
            &token(),
        )
        .await
        .unwrap();
        assert_eq!(out.bytes, 3);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
    }

    #[tokio::test]
    async fn validates_targets_and_sources() {
        let dir = tempfile::tempdir().unwrap();
        // 目标是目录
        let err = write_export(
            &Client::new(),
            None,
            None,
            Some("x"),
            dir.path(),
            true,
            &token(),
        )
        .await
        .expect_err("must fail");
        assert_eq!(err.code, code::INVALID_PARAM);
        assert!(err.message.contains("目录"), "{}", err.message);

        // 空路径
        assert_eq!(
            write_export(
                &Client::new(),
                None,
                None,
                Some("x"),
                &PathBuf::from(""),
                false,
                &token()
            )
            .await
            .expect_err("must fail")
            .code,
            code::INVALID_PARAM
        );

        // 什么都没有
        assert_eq!(
            write_export(
                &Client::new(),
                None,
                None,
                Some("   "),
                &dir.path().join("x.txt"),
                false,
                &token()
            )
            .await
            .expect_err("must fail")
            .code,
            code::INVALID_PARAM
        );

        // 本地结果文件已被删除
        let rec = record(vec!["results/ghost.png".into()], None);
        let err = write_export(
            &Client::new(),
            Some(&rec),
            Some(0),
            None,
            &dir.path().join("y.png"),
            false,
            &token(),
        )
        .await
        .expect_err("must fail");
        assert_eq!(err.code, code::STORAGE);

        // 未完成的视频任务不许导出
        let task = record(vec!["task:abc123".into()], None);
        assert_eq!(
            write_export(
                &Client::new(),
                Some(&task),
                Some(0),
                None,
                &dir.path().join("z.mp4"),
                false,
                &token()
            )
            .await
            .expect_err("must fail")
            .code,
            code::INVALID_PARAM
        );
    }

    #[tokio::test]
    async fn creates_missing_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("sub").join("deep").join("out.txt");
        let out = write_export(
            &Client::new(),
            None,
            None,
            Some("内容"),
            &target,
            false,
            &token(),
        )
        .await
        .unwrap();
        assert_eq!(out.bytes, "内容".len());
        assert!(target.exists());
    }
}
