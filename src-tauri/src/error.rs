//! 统一错误契约（doc/优化方案/03 §7）。
//!
//! 约束：`message` 面向用户，绝不含 api_key / Authorization 头 / 上游原始 body。

use serde::{Deserialize, Serialize};

pub mod code {
    /// 未配置 base_url 或 key
    pub const NO_CONFIG: &str = "NO_CONFIG";
    /// 401/403 密钥无效
    pub const AUTH: &str = "AUTH";
    /// 429 限流
    pub const RATE_LIMIT: &str = "RATE_LIMIT";
    /// 上游服务错误
    pub const UPSTREAM_5XX: &str = "UPSTREAM_5XX";
    /// 请求超时
    pub const TIMEOUT: &str = "TIMEOUT";
    /// 响应结构异常
    pub const PARSE: &str = "PARSE";
    /// 内容审核拒绝
    pub const CONTENT_POLICY: &str = "CONTENT_POLICY";
    /// 用户取消
    pub const CANCELLED: &str = "CANCELLED";
    /// 网络层失败（DNS/连接）
    pub const NETWORK: &str = "NETWORK";
    /// 本地参数校验不通过（03 §7 矩阵之外的本地短路）
    pub const INVALID_PARAM: &str = "INVALID_PARAM";
    /// 其它上游 4xx
    pub const UPSTREAM: &str = "UPSTREAM";
    /// 本地 IO/存储失败
    pub const STORAGE: &str = "STORAGE";
    /// 目标文件已存在，需用户确认覆盖（04 §6 破坏性操作）
    pub const CONFLICT: &str = "CONFLICT";
}

/// 前端可据 `code` 分支降级；`retryable` 决定是否展示"重试"。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GenError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// 用户可见消息上限，避免把上游长响应带进 IPC。
const MAX_MESSAGE_CHARS: usize = 280;

impl GenError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn cancelled() -> Self {
        Self::new(code::CANCELLED, "已取消生成")
    }

    pub fn no_config() -> Self {
        Self::new(
            code::NO_CONFIG,
            "尚未配置 API 密钥，请先在「API 配置」中填写",
        )
    }

    pub fn parse(what: &str) -> Self {
        Self::new(
            code::PARSE,
            format!("{what}返回的内容无法解析，可能是模型输出格式变化"),
        )
    }

    pub fn storage(detail: impl Into<String>) -> Self {
        Self::new(
            code::STORAGE,
            format!("本地存储读写失败：{}", detail.into()),
        )
    }

    pub fn conflict(path: &str) -> Self {
        Self::new(code::CONFLICT, format!("目标文件已存在：{path}"))
    }

    /// 网络层错误映射。reqwest 的错误 Display 可能带 URL，统一收敛为固定文案。
    pub fn from_reqwest(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            Self::new(code::TIMEOUT, "请求超时，请检查网络或稍后重试").retryable()
        } else if e.is_connect() {
            Self::new(code::NETWORK, "无法连接到 API 服务，请检查 Base URL 或网络").retryable()
        } else {
            Self::new(code::NETWORK, "请求 API 服务时网络异常").retryable()
        }
    }

    /// 按上游状态码分级。`body` 仅用于识别审核拒绝，不进入返回的消息文本。
    pub fn from_status(status: u16, body: &str) -> Self {
        if is_content_policy(body) {
            return Self::new(
                code::CONTENT_POLICY,
                "提示词被上游内容安全策略拒绝，请调整描述后重试（不会自动重试）",
            );
        }
        match status {
            401 | 403 => Self::new(
                code::AUTH,
                format!("鉴权失败（{status}），请检查 API 密钥是否有效"),
            ),
            429 => Self::new(code::RATE_LIMIT, "触发上游限流（429），请稍后再试").retryable(),
            400..=499 => Self::new(
                code::UPSTREAM,
                format!("上游拒绝了本次请求（{status}），请检查模型或参数是否可用"),
            ),
            _ => Self::new(
                code::UPSTREAM_5XX,
                format!("上游服务暂时不可用（{status}），请稍后重试"),
            )
            .retryable(),
        }
    }

    /// 兜底脱敏：抹掉可能出现在任意上游文本片段里的密钥形态。
    pub fn scrub(s: &str, secrets: &[&str]) -> String {
        let mut out = s.to_string();
        for sec in secrets {
            if !sec.is_empty() && sec.len() >= 6 {
                out = out.replace(sec, "***");
            }
        }
        // 用游标跳过已掩码区间：否则 "sk-" 前缀会被反复命中而死循环
        for pat in ["sk-", "Bearer "] {
            let mut cursor = 0usize;
            while let Some(rel) = out[cursor..].find(pat) {
                let start = cursor + rel + pat.len();
                let rest = &out[start..];
                let end = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                    .unwrap_or(rest.len());
                out.replace_range(start..start + end, "***");
                cursor = start + "***".len();
            }
        }
        let mut trimmed: String = out.chars().take(MAX_MESSAGE_CHARS).collect();
        if out.chars().count() > MAX_MESSAGE_CHARS {
            trimmed.push('…');
        }
        trimmed
    }
}

/// 只重试"未产生计费"的失败：限流与网络层（04 §8.4）。
/// 5xx 不自动重试——上游可能已实际执行生成并计费，交由用户决定。
pub fn auto_retryable(e: &GenError) -> bool {
    matches!(
        e.code.as_str(),
        code::RATE_LIMIT | code::TIMEOUT | code::NETWORK
    )
}

fn is_content_policy(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    [
        "content_policy",
        "content policy",
        "content_filter",
        "moderation",
        "safety",
        "prohibited",
        "违规",
        "审核不通过",
    ]
    .iter()
    .any(|k| lower.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_maps_to_codes() {
        assert_eq!(GenError::from_status(401, "").code, code::AUTH);
        assert_eq!(GenError::from_status(403, "").code, code::AUTH);
        assert_eq!(GenError::from_status(429, "").code, code::RATE_LIMIT);
        assert!(GenError::from_status(429, "").retryable);
        assert_eq!(GenError::from_status(503, "").code, code::UPSTREAM_5XX);
        assert_eq!(GenError::from_status(404, "").code, code::UPSTREAM);
        assert!(!GenError::from_status(404, "").retryable);
    }

    #[test]
    fn content_policy_wins_over_status() {
        let e = GenError::from_status(400, "{\"error\":{\"code\":\"content_policy_violation\"}}");
        assert_eq!(e.code, code::CONTENT_POLICY);
        assert!(!e.retryable);
        assert!(!auto_retryable(&e));
    }

    #[test]
    fn auth_error_never_leaks_key_or_body() {
        let key = "sk-TEST-SECRET-abcdef123456";
        let body = format!("invalid api key {key} in header Bearer {key}");
        let e = GenError::from_status(401, &body);
        assert!(
            !e.message.contains(key),
            "message leaked key: {}",
            e.message
        );
        assert!(!e.message.contains("Bearer"), "message leaked auth header");
    }

    #[test]
    fn scrub_redacts_key_shapes_and_truncates() {
        let out = GenError::scrub(
            "auth failed with sk-ABC123DEF456 and Bearer xyz789 tail",
            &[],
        );
        assert!(!out.contains("ABC123DEF456"), "{out}");
        assert!(!out.contains("xyz789"), "{out}");

        let known = "supersecretvalue";
        let out2 = GenError::scrub(&format!("echo {known}"), &[known]);
        assert!(!out2.contains(known), "{out2}");

        let long = GenError::scrub(&"x".repeat(1000), &[]);
        assert!(long.chars().count() <= MAX_MESSAGE_CHARS + 1);
    }

    #[test]
    fn only_unbilled_failures_auto_retry() {
        assert!(auto_retryable(
            &GenError::new(code::RATE_LIMIT, "").retryable()
        ));
        assert!(auto_retryable(
            &GenError::new(code::TIMEOUT, "").retryable()
        ));
        assert!(auto_retryable(
            &GenError::new(code::NETWORK, "").retryable()
        ));
        assert!(!auto_retryable(
            &GenError::new(code::UPSTREAM_5XX, "").retryable()
        ));
        assert!(!auto_retryable(&GenError::new(code::AUTH, "")));
        assert!(!auto_retryable(&GenError::cancelled()));
    }

    #[test]
    fn serializes_to_ipc_contract() {
        let json = serde_json::to_value(GenError::new(code::AUTH, "鉴权失败")).unwrap();
        assert_eq!(json["code"], "AUTH");
        assert_eq!(json["message"], "鉴权失败");
        assert_eq!(json["retryable"], false);
    }
}
