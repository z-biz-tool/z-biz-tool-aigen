//! 文本流式（SSE）解析与事件契约（doc/优化方案/03 §2.2，任务 T-Stream）。
//!
//! 单独成模块是为了把分包边界测干净（06 §6 R4：半包 / 多包 / `[DONE]` / 异常终止）。

use crate::history::Usage;
use serde::Serialize;

/// 事件 `aigen://stream/{request_id}` 的负载
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StreamEvent {
    pub delta: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

impl StreamEvent {
    pub fn delta(text: impl Into<String>) -> Self {
        Self {
            delta: text.into(),
            done: false,
            usage: None,
        }
    }

    pub fn done(usage: Option<Usage>) -> Self {
        Self {
            delta: String::new(),
            done: true,
            usage,
        }
    }
}

/// 一条完整 SSE 事件的解析结果
#[derive(Debug, PartialEq, Eq)]
pub enum SseItem {
    /// `data:` 负载（多条 data 行按 SSE 规范以 \n 连接）
    Data(String),
    /// OpenAI 风格的结束标记
    Done,
}

/// 增量 SSE 解析器：喂入任意切分的字节块，吐出已完整成帧的事件。
///
/// 缓冲按**字节**保存：一个中文字被切在两块之间时，残字节留在缓冲区等下一块，
/// 不能提前做有损解码（否则 `你好` 会变成 U+FFFD）。
#[derive(Debug, Default)]
pub struct SseParser {
    pending: Vec<u8>,
    data_lines: Vec<String>,
}

impl SseParser {
    /// 喂入一个网络块
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseItem> {
        self.pending.extend_from_slice(chunk);
        self.drain()
    }

    /// 字符串便捷入口，目前仅测试与用例构造使用
    #[cfg(test)]
    pub fn push_str(&mut self, text: &str) -> Vec<SseItem> {
        self.push(text.as_bytes())
    }

    fn drain(&mut self) -> Vec<SseItem> {
        let mut out = Vec::new();
        // 只在遇到完整行时消费，保留最后一段不完整数据
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.pending.drain(..=pos).collect();
            let body = &raw[..raw.len() - 1]; // 去掉 '\n'
            let body = if body.last() == Some(&b'\r') {
                &body[..body.len() - 1]
            } else {
                body
            };
            let line = String::from_utf8_lossy(body);
            if line.is_empty() {
                if let Some(item) = self.flush_frame() {
                    out.push(item);
                }
                continue;
            }
            if line.starts_with(':') {
                continue; // 注释/心跳
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_ref(), ""),
            };
            // event/id/retry 等字段对本场景无意义
            if field == "data" {
                if value.trim() == "[DONE]" {
                    // 结束标记：先交付已缓冲的帧，再报 Done
                    if let Some(item) = self.flush_frame() {
                        out.push(item);
                    }
                    out.push(SseItem::Done);
                } else {
                    self.data_lines.push(value.to_string());
                }
            }
        }
        out
    }

    fn flush_frame(&mut self) -> Option<SseItem> {
        if self.data_lines.is_empty() {
            return None;
        }
        Some(SseItem::Data(
            std::mem::take(&mut self.data_lines).join("\n"),
        ))
    }

    /// 流结束时的收尾：若上游没给空行/`[DONE]` 就断线，仍把缓冲里的最后一帧交出来
    pub fn finish(&mut self) -> Vec<SseItem> {
        let mut out = Vec::new();
        let tail = std::mem::take(&mut self.pending);
        let tail = String::from_utf8_lossy(&tail);
        let tail = tail.trim_end_matches(['\n', '\r']);
        if let Some((field, value)) = tail.split_once(':') {
            if field == "data" {
                if value.trim() == "[DONE]" {
                    if let Some(item) = self.flush_frame() {
                        out.push(item);
                    }
                    out.push(SseItem::Done);
                    return out;
                }
                self.data_lines
                    .push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
        }
        if let Some(item) = self.flush_frame() {
            out.push(item);
        }
        out
    }
}

/// 从一条 SSE `data:` JSON 里取增量文本与用量
#[derive(Debug, Default)]
pub struct Chunk {
    pub text: String,
    pub usage: Option<Usage>,
}

pub fn parse_chunk(payload: &str) -> Result<Chunk, serde_json::Error> {
    let v: serde_json::Value = serde_json::from_str(payload)?;
    let text = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let usage = v
        .get("usage")
        .and_then(|u| serde_json::from_value::<Usage>(u.clone()).ok());
    Ok(Chunk { text, usage })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(s: &str) -> SseItem {
        SseItem::Data(s.to_string())
    }

    #[test]
    fn parses_well_formed_frames() {
        let mut p = SseParser::default();
        let items = p.push_str("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
        assert_eq!(items, vec![data("{\"a\":1}"), data("{\"b\":2}")]);
        assert!(p.finish().is_empty());
    }

    /// 06 R4：一条 SSE 帧被切在任意字节位置都不能丢内容
    #[test]
    fn handles_split_across_chunks() {
        let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"你好世界\"}}]}\n\n";
        let bytes = raw.as_bytes();
        let mut p = SseParser::default();
        let mut got = Vec::new();
        // 逐字节喂入，最坏的分包情形
        for i in 0..bytes.len() {
            got.extend(p.push(&bytes[i..i + 1]));
        }
        got.extend(p.finish());
        assert_eq!(
            got,
            vec![data(
                "{\"choices\":[{\"delta\":{\"content\":\"你好世界\"}}]}"
            )]
        );
    }

    #[test]
    fn handles_multiple_frames_in_one_chunk() {
        let mut p = SseParser::default();
        let items = p.push_str("data: {\"x\":1}\n\ndata: {\"x\":2}\n\ndata: {\"x\":3}\n\n");
        assert_eq!(items.len(), 3);
        assert_eq!(items[2], data("{\"x\":3}"));
    }

    #[test]
    fn recognizes_done_sentinel() {
        let mut p = SseParser::default();
        let items = p.push_str("data: {\"x\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(items, vec![data("{\"x\":1}"), SseItem::Done]);
    }

    #[test]
    fn done_without_trailing_blank_line() {
        let mut p = SseParser::default();
        // 没有换行的半截行先留在缓冲，收尾时才交付
        assert!(p.push_str("data: [DONE]").is_empty());
        assert_eq!(p.finish(), vec![SseItem::Done]);
    }

    /// 分包点正好落在一个中文字中间时不能出现替换字符
    #[test]
    fn split_inside_multibyte_char_is_lossless() {
        let frame = "{\"choices\":[{\"delta\":{\"content\":\"中文内容测试\"}}]}";
        let raw = format!("data: {frame}\n\n");
        let bytes = raw.as_bytes();
        for cut in [bytes.len() - 4, bytes.len() - 8, bytes.len() - 12] {
            let mut q = SseParser::default();
            let mut items = q.push(&bytes[..cut]);
            items.extend(q.push(&bytes[cut..]));
            items.extend(q.finish());
            assert_eq!(items, vec![data(frame)], "cut={cut} 出现有损解码");
            if let SseItem::Data(payload) = &items[0] {
                assert_eq!(parse_chunk(payload).unwrap().text, "中文内容测试");
            }
        }
    }

    #[test]
    fn joins_multiple_data_lines_per_frame() {
        let mut p = SseParser::default();
        let items = p.push_str("data: line1\ndata: line2\n\n");
        assert_eq!(items, vec![data("line1\nline2")]);
    }

    #[test]
    fn ignores_comments_and_crlf() {
        let mut p = SseParser::default();
        let items = p.push_str(": keep-alive\r\ndata: {\"x\":1}\r\n\r\n");
        assert_eq!(items, vec![data("{\"x\":1}")]);
    }

    /// 异常终止：上游没发空行就断线，最后一帧仍要交付
    #[test]
    fn finish_recovers_unterminated_frame() {
        let mut p = SseParser::default();
        assert!(p.push_str("data: {\"partial\":true}").is_empty());
        let tail = p.finish();
        assert_eq!(tail, vec![data("{\"partial\":true}")]);
        // 再收尾一次不应重复投递
        assert!(p.finish().is_empty());
    }

    #[test]
    fn chunk_extracts_delta_and_usage() {
        let c = parse_chunk(
            "{\"choices\":[{\"delta\":{\"content\":\"Hel\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":7}}",
        )
        .unwrap();
        assert_eq!(c.text, "Hel");
        assert_eq!(
            c.usage.map(|u| (u.prompt_tokens, u.completion_tokens)),
            Some((3, 7))
        );

        // 首帧只有 role，没有 content
        let c2 = parse_chunk("{\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}").unwrap();
        assert_eq!(c2.text, "");
        assert!(c2.usage.is_none());

        assert!(parse_chunk("not json").is_err());
    }

    #[test]
    fn event_serializes_to_ipc_contract() {
        let json = serde_json::to_string(&StreamEvent::delta("abc")).unwrap();
        assert_eq!(json, "{\"delta\":\"abc\",\"done\":false}");
        let done = StreamEvent::done(Some(Usage {
            prompt_tokens: 1,
            completion_tokens: 2,
        }));
        let v: serde_json::Value = serde_json::to_value(&done).unwrap();
        assert_eq!(v["done"], true);
        assert_eq!(v["usage"]["completion_tokens"], 2);
    }
}
