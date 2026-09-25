//! 生成历史与结果落盘（doc/优化方案/03 §6，任务 T-C1/B5/B6）。
//!
//! 选型：JSONL 追加 + 超量压实，而非 SQLite。理由是不引入 C 依赖（4 平台 CI 零风险），
//! 且 03 §6 本身把"轻量 JSONL 追加 + 定期压实（原子写）"列为可选方案。
//!
//! 关键约束：
//! - 历史**只存结果引用**（`results/...` 相对路径），base64 一律解码落盘为文件（B6、验收 #7）
//! - 时间戳为 ISO8601（B5）
//! - 追加用 `append+fsync`，压实走 `atomic_write`，坏行跳过并留 `.bak`（04 §5 可恢复）

use crate::error::GenError;
// 历史与结果文件共用同一套原子写与数据目录约定
pub use crate::secret::{atomic_write, data_dir};
// base64 编解码已下沉到 cap-img（decode_data_url / encode_data_url），本仓不再直接依赖
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 内存中保留的历史条数；超过后压实到该值。
pub const HISTORY_LIMIT: usize = 500;
/// 单个结果文件大小上限（字节），防止上游返回异常大的 body 打爆内存。
pub const MAX_RESULT_BYTES: usize = 32 * 1024 * 1024;

/// 与 03 §6 的 HistoryRecord 对齐
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub id: String,
    /// image | text | video | ppt
    pub kind: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub params: serde_json::Map<String, serde_json::Value>,
    /// 相对数据目录的路径，如 `results/abc-1.png`
    #[serde(default)]
    pub result_refs: Vec<String>,
    /// 文本类结果可直接内联（体量可控）
    #[serde(default)]
    pub text_result: Option<String>,
    #[serde(default)]
    pub status: String,
    /// ISO8601（UTC）
    pub created_at: String,
    #[serde(default)]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub favorite: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
}

/// 可读时间戳（03 §6：ISO8601，修 B5）
pub fn now_iso8601() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn history_path() -> PathBuf {
    data_dir().join("history.jsonl")
}

pub fn results_dir() -> PathBuf {
    data_dir().join("results")
}

/// 把 base64 / 字节写入 results/ 并返回相对路径引用（如 `results/{id}-0.png`）
pub fn save_result_bytes(
    id: &str,
    index: usize,
    ext: &str,
    bytes: &[u8],
) -> Result<String, GenError> {
    if bytes.len() > MAX_RESULT_BYTES {
        return Err(GenError::new(
            crate::error::code::PARSE,
            format!("结果文件过大（{} 字节），已拒绝落盘", bytes.len()),
        ));
    }
    let dir = results_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| GenError::storage(format!("创建结果目录失败: {e}")))?;
    // id 由本地 uuid 生成，仍对扩展名做一次白名单清洗，避免路径穿越
    let safe_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect();
    let safe_ext = if safe_ext.is_empty() {
        "bin".to_string()
    } else {
        safe_ext
    };
    let rel = format!("results/{id}-{index}.{safe_ext}");
    atomic_write(&dir.join(format!("{id}-{index}.{safe_ext}")), bytes)
        .map_err(|e| GenError::storage(format!("写入结果文件失败: {e}")))?;
    Ok(rel)
}

/// 从 `data:image/png;base64,....` 解出字节与扩展名
///
/// 解析逻辑在能力层 cap-img 0.2.0（`decode_data_url` + `ext_for_mime`），
/// 这里只保留 aigen 侧的签名 `(bytes, ext)`，三个调用方不用改。
/// 与旧实现的唯一差异：payload 无 padding 也能解（旧的直接 None），输入全部来自本仓自产的
/// data URL（恒带 padding），实际可达面不变。
pub fn decode_data_url(url: &str) -> Option<(Vec<u8>, String)> {
    let d = cap_img::decode_data_url(url)?;
    let ext = cap_img::ext_for_mime(&d.mime);
    Some((d.bytes, ext))
}

/// 文件是否停在"没有换行结尾"的状态（即上一行是被截断的）。
/// 必须以**只读**方式另开一次：append 模式打开的句柄读不了末尾字节（会直接 EBADF）。
fn ends_without_newline(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    let Ok(meta) = f.metadata() else { return false };
    if meta.len() == 0 {
        return false;
    }
    let mut buf = [0u8; 1];
    f.seek(SeekFrom::End(-1)).is_ok() && f.read(&mut buf).unwrap_or(0) == 1 && buf[0] != b'\n'
}

/// JSONL 历史存储
pub struct Store {
    path: PathBuf,
    items: Vec<Record>,
    dropped_lines: usize,
}

impl Default for Store {
    fn default() -> Self {
        Self::open()
    }
}

impl Store {
    pub fn open() -> Self {
        Self::load_from(&history_path())
    }

    /// 文件内行序恒为**时间正序**（追加友好），内存序为**新→旧**（UI 友好）。
    pub fn load_from(path: &Path) -> Self {
        let mut chronological = Vec::new();
        let mut dropped = 0usize;
        if path.exists() {
            match std::fs::read_to_string(path) {
                Err(_) => dropped += 1,
                Ok(text) => {
                    for line in text.lines().take(HISTORY_LIMIT * 10) {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Record>(line) {
                            Ok(r) => chronological.push(r),
                            // 半截行（断电）直接跳过，不影响其余记录
                            Err(_) => dropped += 1,
                        }
                    }
                }
            }
            if dropped > 0 {
                let _ = std::fs::copy(path, path.with_extension("jsonl.bak"));
            }
        }
        chronological.reverse();
        chronological.truncate(HISTORY_LIMIT);
        Self {
            path: path.to_path_buf(),
            items: chronological,
            dropped_lines: dropped,
        }
    }

    /// 读取时跳过的坏行数，供 UI/日志提示历史受损
    pub fn dropped_lines(&self) -> usize {
        self.dropped_lines
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 仅供测试断言读取顺序
    /// 按 id 查一条记录（导出与迭代要用）
    pub fn find(&self, id: &str) -> Option<Record> {
        self.items.iter().find(|r| r.id == id).cloned()
    }

    #[cfg(test)]
    pub fn records(&self) -> &[Record] {
        &self.items
    }

    /// 追加一条：新→旧排列，落盘为 append；超过阈值再压实。
    pub fn push(&mut self, record: Record) -> Result<(), GenError> {
        let line = serde_json::to_string(&record)
            .map_err(|e| GenError::storage(format!("序列化历史失败: {e}")))?;
        self.append_line(&line)?;
        self.items.insert(0, record);
        if self.items.len() > HISTORY_LIMIT * 2 {
            self.compact()?;
        }
        Ok(())
    }

    /// 故障注入用：只写半行就停，模拟追加途中掉电。
    /// JSONL 的追加本身不是原子的，所以这条要证明的是"坏行可恢复"，不是"不会出坏行"。
    #[cfg(test)]
    pub fn append_torn_line_for_test(&self, line: &str) -> std::io::Result<()> {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        let half = &line[..line.len() / 2];
        f.write_all(half.as_bytes())?;
        f.flush()?;
        Ok(())
    }

    fn append_line(&self, line: &str) -> Result<(), GenError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| GenError::storage(format!("创建历史目录失败: {e}")))?;
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| GenError::storage(format!("打开历史文件失败: {e}")))?;
        // 上一次若崩在追加中途，文件结尾会缺一行结束符；不补换行就会把新记录
        // 直接接在残缺行后面 —— 那不止丢一条，而是**此后每条都跟着一起丢**。
        if ends_without_newline(&self.path) {
            f.write_all(b"\n")
                .map_err(|e| GenError::storage(format!("修复残缺行结尾失败: {e}")))?;
        }
        f.write_all(line.as_bytes())
            .and_then(|_| f.write_all(b"\n"))
            .and_then(|_| f.sync_all())
            .map_err(|e| GenError::storage(format!("追加历史失败: {e}")))
    }

    /// 压实：按时间正序重写文件，只保留最近 HISTORY_LIMIT 条（原子替换）
    pub fn compact(&mut self) -> Result<(), GenError> {
        self.items.truncate(HISTORY_LIMIT);
        let mut buf = String::new();
        for r in self.items.iter().rev() {
            let line = serde_json::to_string(r)
                .map_err(|e| GenError::storage(format!("序列化历史失败: {e}")))?;
            buf.push_str(&line);
            buf.push('\n');
        }
        atomic_write(&self.path, buf.as_bytes())
            .map_err(|e| GenError::storage(format!("压实历史失败: {e}")))
    }

    /// 原地更新收藏位并重写文件。
    /// 不能复用 delete+push：delete 会连带删除该记录的结果文件。
    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<bool, GenError> {
        let mut found = false;
        for r in self.items.iter_mut() {
            if r.id == id {
                r.favorite = favorite;
                found = true;
            }
        }
        if found {
            self.compact()?;
        }
        Ok(found)
    }

    pub fn delete(&mut self, id: &str) -> Result<bool, GenError> {
        let before = self.items.len();
        // 被删记录的本地结果文件一并清理，避免孤儿文件堆积
        let orphan_refs: Vec<String> = self
            .items
            .iter()
            .filter(|r| r.id == id)
            .flat_map(|r| r.result_refs.clone())
            .collect();
        self.items.retain(|r| r.id != id);
        let removed = self.items.len() != before;
        if removed {
            self.compact()?;
            for rel in orphan_refs {
                let _ = std::fs::remove_file(data_dir().join(rel));
            }
        }
        Ok(removed)
    }

    pub fn clear(&mut self) -> Result<(), GenError> {
        for r in &self.items {
            for rel in &r.result_refs {
                let _ = std::fs::remove_file(data_dir().join(rel));
            }
        }
        self.items.clear();
        atomic_write(&self.path, b"").map_err(|e| GenError::storage(format!("清空历史失败: {e}")))
    }

    /// 按 kind + 关键词过滤并分页（02 §5）
    pub fn query(
        &self,
        kind: Option<&str>,
        keyword: Option<&str>,
        page: usize,
        size: usize,
    ) -> (Vec<Record>, usize) {
        let kw = keyword
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase());
        let matched: Vec<&Record> = self
            .items
            .iter()
            .filter(|r| kind.map(|k| r.kind == k).unwrap_or(true))
            .filter(|r| match &kw {
                None => true,
                Some(k) => {
                    r.prompt.to_ascii_lowercase().contains(k)
                        || r.text_result
                            .as_deref()
                            .unwrap_or("")
                            .to_ascii_lowercase()
                            .contains(k)
                }
            })
            .collect();
        let total = matched.len();
        let size = size.clamp(1, 200);
        let start = page.saturating_mul(size);
        let page_items = matched
            .into_iter()
            .skip(start)
            .take(size)
            .cloned()
            .collect();
        (page_items, total)
    }

    /// 结果引用 → 绝对路径（供 UI 打开 / asset 协议转换）
    pub fn resolve_ref(rel: &str) -> PathBuf {
        data_dir().join(rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::test_sandbox::Sandbox;

    fn record(id: &str, kind: &str, prompt: &str) -> Record {
        Record {
            id: id.to_string(),
            kind: kind.to_string(),
            prompt: prompt.to_string(),
            model: Some("gpt-4o".into()),
            params: serde_json::Map::new(),
            result_refs: vec![],
            text_result: None,
            status: "succeeded".into(),
            created_at: now_iso8601(),
            usage: None,
            favorite: false,
        }
    }

    #[test]
    fn records_survive_restart() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        store.push(record("a", "text", "第一条")).unwrap();
        store.push(record("b", "image", "第二条")).unwrap();

        // 重新打开 = 重启进程
        let reopened = Store::open();
        assert_eq!(reopened.len(), 2);
        // 新→旧
        assert_eq!(reopened.records()[0].id, "b");
        assert_eq!(reopened.records()[1].prompt, "第一条");
    }

    /// 验收 #16 相关：created_at 必须是可读 ISO8601（B5）
    #[test]
    fn timestamps_are_iso8601() {
        let ts = now_iso8601();
        assert!(ts.ends_with('Z'), "非 UTC ISO8601: {ts}");
        assert_eq!(ts.matches('-').count(), 2, "非日期形状: {ts}");
        assert!(
            chrono::DateTime::parse_from_rfc3339(&ts).is_ok(),
            "无法按 RFC3339 解析: {ts}"
        );
    }

    #[test]
    fn corrupt_line_is_skipped_and_backup_kept() {
        let _sb = Sandbox::new();
        let path = history_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // 最后一行半截，模拟写入中断电
        std::fs::write(
            &path,
            format!(
                "{}\n{{\"id\":\"broken\",\"kind\":\n",
                serde_json::to_string(&record("ok", "text", "完好行")).unwrap()
            ),
        )
        .unwrap();

        let store = Store::load_from(&path);
        assert_eq!(store.len(), 1, "完好记录不应因坏行丢失");
        assert_eq!(store.dropped_lines(), 1);
        assert!(
            path.with_extension("jsonl.bak").exists(),
            "受损历史应留 .bak"
        );
    }

    #[test]
    fn query_filters_by_kind_and_keyword_with_paging() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        for i in 0..30 {
            let kind = if i % 2 == 0 { "image" } else { "text" };
            let mut r = record(&format!("id{i}"), kind, &format!("橘猫 关键词{i}"));
            if i % 2 == 1 {
                r.text_result = Some(format!("正文{i}"));
            }
            store.push(r).unwrap();
        }
        let (images, total_images) = store.query(Some("image"), None, 0, 100);
        assert_eq!(total_images, 15);
        assert!(images.iter().all(|r| r.kind == "image"));

        let (hits, hits_total) = store.query(None, Some("关键词12"), 0, 10);
        assert_eq!(hits_total, 1);
        assert_eq!(hits[0].id, "id12");

        // 文本正文也参与检索
        let (_, body_total) = store.query(Some("text"), Some("正文13"), 0, 10);
        assert_eq!(body_total, 1);

        let (p1, _) = store.query(None, None, 1, 10);
        assert_eq!(p1.len(), 10);
        let (oob, total) = store.query(None, None, 99, 10);
        assert!(oob.is_empty());
        assert_eq!(total, 30);
    }

    #[test]
    fn compaction_bounds_growth_and_reloads() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        for i in 0..(HISTORY_LIMIT * 2 + 5) {
            store.push(record(&format!("x{i}"), "text", "p")).unwrap();
        }
        // 压实是"超过 2×上限才重写文件"，所以内存条数被约束在 2×上限附近
        assert!(
            store.len() <= HISTORY_LIMIT * 2 + 1,
            "增长未受控: {}",
            store.len()
        );
        let reopened = Store::open();
        assert_eq!(reopened.len(), HISTORY_LIMIT, "重开后应收敛到上限");
        assert_eq!(
            reopened.records()[0].id,
            format!("x{}", HISTORY_LIMIT * 2 + 4)
        );
    }

    #[test]
    fn delete_removes_record_and_result_files() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        let rel = save_result_bytes("d1", 0, "png", b"fake-bytes").unwrap();
        let mut r = record("d1", "image", "p");
        r.result_refs = vec![rel.clone()];
        store.push(r).unwrap();
        assert!(Store::resolve_ref(&rel).exists());

        assert!(store.delete("d1").unwrap());
        assert_eq!(store.len(), 0);
        assert!(!Store::resolve_ref(&rel).exists(), "结果文件成为孤儿");
        assert!(!store.delete("missing").unwrap());
        // 删除后重开仍为空
        assert_eq!(Store::open().len(), 0);
    }

    #[test]
    fn clear_wipes_records_and_files() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        let rel = save_result_bytes("c1", 0, "png", b"x").unwrap();
        let mut r = record("c1", "image", "p");
        r.result_refs = vec![rel.clone()];
        store.push(r).unwrap();
        store.clear().unwrap();
        assert_eq!(store.len(), 0);
        assert_eq!(Store::open().len(), 0);
        assert!(!Store::resolve_ref(&rel).exists());
        assert!(history_path().exists(), "清空应保留空文件而非删除");
    }

    #[test]
    fn data_url_decodes_to_file_with_extension() {
        let _sb = Sandbox::new();
        let png = "data:image/png;base64,iVBORw0KGgo=";
        let (bytes, ext) = decode_data_url(png).unwrap();
        assert_eq!(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(ext, "png");
        let rel = save_result_bytes("img1", 1, &ext, &bytes).unwrap();
        assert_eq!(rel, "results/img1-1.png");
        assert_eq!(std::fs::read(Store::resolve_ref(&rel)).unwrap(), bytes);

        assert_eq!(
            decode_data_url("data:image/jpeg;base64,AA==").unwrap().1,
            "jpg"
        );
        assert_eq!(
            decode_data_url("data:image/svg+xml;base64,AA==").unwrap().1,
            "svg"
        );
        assert!(decode_data_url("https://cdn/x.png").is_none());
        assert!(decode_data_url("data:image/png,notbase64").is_none());
        assert!(decode_data_url("data:image/png;base64,!!!not-b64!!!").is_none());
    }

    #[test]
    fn oversized_result_is_rejected() {
        let _sb = Sandbox::new();
        let big = vec![0u8; MAX_RESULT_BYTES + 1];
        let err = save_result_bytes("huge", 0, "png", &big).expect_err("must reject");
        assert!(err.message.contains("过大"));
    }

    #[test]
    fn extension_is_sanitized_against_traversal() {
        let _sb = Sandbox::new();
        let rel = save_result_bytes("t1", 0, "../../etc/sh", b"x").unwrap();
        assert!(!rel.contains(".."), "扩展名带入路径穿越: {rel}");
        assert!(rel.starts_with("results/t1-0."), "{rel}");
    }

    /// 收藏必须是原地更新：走 delete+push 会连带删掉结果文件
    #[test]
    fn favorite_update_keeps_result_files_and_ordering() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        let rel = save_result_bytes("f1", 0, "png", b"png-bytes").unwrap();
        let mut r = record("f1", "image", "p");
        r.result_refs = vec![rel.clone()];
        store.push(r).unwrap();
        store.push(record("f2", "text", "later")).unwrap();

        assert!(store.set_favorite("f1", true).unwrap());
        assert!(Store::resolve_ref(&rel).exists(), "收藏操作误删结果文件");
        assert!(!store.set_favorite("nope", true).unwrap());

        let reopened = Store::open();
        assert_eq!(reopened.records()[0].id, "f2", "重开后新→旧顺序被打乱");
        assert_eq!(reopened.records()[1].id, "f1");
        assert!(reopened.records()[1].favorite);
        assert_eq!(reopened.records()[1].result_refs, vec![rel]);
    }

    /// 压实后重开的顺序必须与未压实一致
    #[test]
    fn ordering_is_stable_across_compaction() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        for i in 0..(HISTORY_LIMIT + 3) {
            store.push(record(&format!("o{i}"), "text", "p")).unwrap();
        }
        store.compact().unwrap();
        let reopened = Store::open();
        let newest: Vec<String> = reopened
            .records()
            .iter()
            .take(3)
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(
            newest,
            vec![
                format!("o{}", HISTORY_LIMIT + 2),
                format!("o{}", HISTORY_LIMIT + 1),
                format!("o{}", HISTORY_LIMIT)
            ]
        );
        assert_eq!(reopened.len(), HISTORY_LIMIT, "最旧的若干条应被压实掉");
    }

    #[test]
    fn append_is_ordered_newest_first_after_reload() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        store.push(record("1", "text", "a")).unwrap();
        store.push(record("2", "text", "b")).unwrap();
        store.push(record("3", "text", "c")).unwrap();
        let reopened = Store::open();
        let ids: Vec<&str> = reopened.records().iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["3", "2", "1"]);
    }

    /// 06 #13 的 JSONL 半边：崩溃留下一行残缺记录后，完好记录一条不丢、能读到备份、之后还能继续写
    #[test]
    fn torn_last_append_line_is_skipped_and_backup_kept() {
        let _sb = Sandbox::new();
        let mut store = Store::open();
        for i in 0..3 {
            store
                .push(record(&format!("t{i}"), "text", "完好记录"))
                .unwrap();
        }
        let before = std::fs::read_to_string(history_path()).unwrap();
        assert_eq!(before.lines().count(), 3);

        store
            .append_torn_line_for_test(r#"{"id":"torn","kind":"text","prompt":"半截"#)
            .unwrap();
        let torn = std::fs::read_to_string(history_path()).unwrap();
        assert_eq!(torn.lines().count(), 4, "应多出一行残缺行");

        let reopened = Store::open();
        assert_eq!(reopened.len(), 3, "完好记录必须全部读回");
        assert_eq!(reopened.dropped_lines(), 1);
        assert!(
            history_path().with_extension("jsonl.bak").exists(),
            "受损历史要留 .bak"
        );
        assert_eq!(reopened.records()[0].id, "t2", "重开后仍是新→旧");

        let mut after = reopened;
        after.push(record("t3", "text", "崩溃后的新记录")).unwrap();
        assert_eq!(Store::open().len(), 4, "恢复后要继续可写可读");

        after.compact().unwrap();
        let cleaned = std::fs::read_to_string(history_path()).unwrap();
        assert_eq!(cleaned.lines().count(), 4, "压实后不该再留残缺行");
        for line in cleaned.lines() {
            serde_json::from_str::<Record>(line).expect("压实后每行都必须是完整 JSON");
        }
    }
}
