//! 生成助手（doc/优化方案/02 §8、04 §6，任务 T-Agent）。
//!
//! 硬边界（写在这里也测在这里）：
//! - **只产出建议**。本模块不写文件、不改配置、不发起生成；
//!   任何"采纳"动作都由用户在界面上显式点击后，由前端改本地草稿（02 §8 验收：建议采纳前 0 副作用）。
//! - 一次请求最多打上游 **1 次**，且用小 `max_tokens` 控成本；没配服务商时直接走本地启发式，不报错卡住界面。
//! - 审核被拒只给"怎么改写"的中性建议，**不提供任何绕过手段**（04 §4）。

use crate::ai_client::{self, ApiConfig, TextOptions, TEXT_TIMEOUT};
use crate::error::{code, GenError};
use crate::history::Usage;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// 上游建议正文的长度上限（防御异常长的响应）
const MAX_REPLY_CHARS: usize = 6_000;
/// 助手自己占的输出生成预算，刻意给小
const ASSISTANT_MAX_TOKENS: u32 = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantRequest {
    /// 求助的生成类型
    pub kind: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    /// 上一次失败的工具码，用于诊断
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Suggestion {
    /// rewrite | param | diagnose
    pub kind: String,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssistantReply {
    pub suggestions: Vec<Suggestion>,
    /// 改写后的提示词草稿；仅作为前端填入的素材，不自动生效
    pub rewritten: Option<String>,
    /// true = 上游没参与（未配置/失败/解析不出），只给了本地启发式建议
    pub heuristic_only: bool,
    pub usage: Option<Usage>,
}

/// 诊断码 → 可执行建议（03 §7 的降级表面向用户的版本）
pub fn diagnose(error_code: Option<&str>) -> Option<Suggestion> {
    let c = error_code?.trim();
    if c.is_empty() {
        return None;
    }
    let (title, detail) = match c {
        code::NO_CONFIG => ("还没配好服务商", "在「服务商与密钥」里补 Base URL 与密钥后再试；本轮未产生任何上游调用。"),
        code::AUTH => ("密钥无效或权限不足", "换一个密钥，或确认该服务商开放了你选的模型；密钥只在本地加密存储，不会被回显。"),
        code::RATE_LIMIT => ("触发上游限流", "稍等再试；批量任务可以先减少一次提交的条数，或换服务商分担。"),
        code::TIMEOUT => ("请求超时", "缩短提示词、调低「最大字数」，或换更快的模型；网络不稳时避免批量提交。"),
        code::UPSTREAM_5XX => ("上游服务异常", "可稍后重试；若持续失败，在「服务商与密钥」里换一家或换模型。"),
        code::CONTENT_POLICY => ("提示词被内容策略拒绝", "换一种中性、具体的描述方式（例如把人物改成场景与光线描述）。不会提供任何绕过审核的手段。"),
        code::PARSE => ("上游返回结构异常", "多半是该模型不遵守请求格式；换一个模型，或把要求写得更直白。"),
        code::INVALID_PARAM => ("参数被本地拦下", "多为模型不属于当前服务商：在「服务商与密钥」导入模型清单后重选。"),
        code::NETWORK => ("连不上上游", "检查 Base URL 拼写与网络/代理；本地 mock 只允许 http://localhost。"),
        code::STORAGE => ("本地写入失败", "检查磁盘空间与目录权限（配置、历史、产物都写在数据目录内）。"),
        code::CANCELLED => ("上次被取消", "这是你主动中止的结果，直接重新发起即可。"),
        _ => ("上一次失败", "可重试；连续失败请换模型或服务商。"),
    };
    Some(Suggestion {
        kind: "diagnose".to_string(),
        title: title.to_string(),
        // 带上原始码，便于用户贴日志反馈
        detail: format!("{detail}（错误码 {c}）"),
    })
}

/// 本地启发式：不花额度也能给出的提示词与参数建议
pub fn heuristics(req: &AssistantRequest) -> Vec<Suggestion> {
    let mut out = Vec::new();
    let prompt = req.prompt.trim();
    let chars = prompt.chars().count();

    if let Some(d) = diagnose(req.last_error.as_deref()) {
        out.push(d);
    }

    if chars == 0 {
        out.push(Suggestion {
            kind: "rewrite".to_string(),
            title: "先写清要什么".to_string(),
            detail: "提示词为空。至少给主体 + 一个限定条件（场景/风格/长度），生成质量会明显变稳。"
                .to_string(),
        });
        return out;
    }

    if chars < 16 {
        out.push(Suggestion {
            kind: "rewrite".to_string(),
            title: format!("提示词偏短（{chars} 字）"),
            detail: if req.kind == "image" {
                "图片建议补上「主体 + 场景 + 光线/材质 + 风格」四段，例如：一只橘猫、窗台、逆光、胶片质感。".to_string()
            } else {
                "补上主题、目标读者、篇幅与语气四项，模型就不需要自己猜。".to_string()
            },
        });
    }

    let negations = ["不要", "别", "禁止", "不是", "no ", "without ", "avoid "];
    if negations.iter().any(|n| prompt.to_lowercase().contains(n)) {
        out.push(Suggestion {
            kind: "rewrite".to_string(),
            title: "否定式描述往往不生效".to_string(),
            detail: "多数模型不遵守「不要 X」。把 X 换成你想要的正向描述（例如「避免文字」→「纯图像、无文字排版」）。".to_string(),
        });
    }

    if req.kind == "image" {
        let style_words = [
            "风格",
            "写意",
            "写实",
            "水彩",
            "油画",
            "胶片",
            "3d",
            "渲染",
            "minimal",
            "cinematic",
            "lighting",
            "光",
        ];
        if !style_words
            .iter()
            .any(|s| prompt.to_lowercase().contains(s))
        {
            out.push(Suggestion {
                kind: "param".to_string(),
                title: "缺少风格与光线描述".to_string(),
                detail: "加一个风格词（水彩/胶片/3D 渲染）和一个光线词（逆光/柔光箱），比反复加形容词更有效。".to_string(),
            });
        }
    }

    if req.kind == "text" && chars > 1200 {
        out.push(Suggestion {
            kind: "param".to_string(),
            title: "输入很长".to_string(),
            detail: "把要生成的部分与背景材料分开写，或在「最大字数」里给明确上限，避免模型把预算耗在复述上。".to_string(),
        });
    }

    out
}

/// 交给模型的元提示。刻意固定，不掺入任何配置信息或密钥。
fn meta_prompt(req: &AssistantRequest) -> String {
    format!(
        "你是桌面 AI 生成工具的助手。用户正在做「{}」生成，请给出改进建议。\n\
         只输出 JSON，不要任何解释文字或代码块标记，格式：\n\
         {{\"rewritten\":\"改写后的完整提示词\",\"suggestions\":[{{\"title\":\"短标题\",\"detail\":\"一到两句可执行说明\"}}]}}\n\
         要求：suggestions 最多 3 条；不要建议任何规避内容审核的做法；不要提出写文件或删除操作。\n\
         当前提示词：\n\"\"\"\n{}\n\"\"\"",
        req.kind, req.prompt
    )
}

#[derive(Deserialize)]
struct ModelSuggestion {
    #[serde(default)]
    title: String,
    #[serde(default)]
    detail: String,
}

#[derive(Deserialize)]
struct ModelReply {
    #[serde(default)]
    rewritten: Option<String>,
    #[serde(default)]
    suggestions: Vec<ModelSuggestion>,
}

/// 从模型返回里抽 JSON：容忍 ```json 包裹与前后杂字。
fn extract_json(text: &str) -> Option<serde_json::Value> {
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&cleaned) {
        return Some(v);
    }
    let start = cleaned.find('{')?;
    let end = cleaned.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&cleaned[start..=end]).ok()
}

/// 生成建议：本地启发式打底，再叠加一次模型建议（失败则退化为纯启发式）。
pub async fn advise(
    client: &reqwest::Client,
    config: &ApiConfig,
    req: &AssistantRequest,
    cancel: &CancellationToken,
) -> Result<AssistantReply, GenError> {
    let mut suggestions = heuristics(req);
    let mut model_says: Option<String> = None;
    let mut usage = None;
    let mut heuristic_only = false;

    // 没配好服务商也值得给建议，只是不花额度
    if ai_client::validate_config(config).is_ok() {
        let opts = TextOptions {
            system: Some("你只输出 JSON，字段严格按用户要求，不要附加说明。".to_string()),
            temperature: Some(0.4),
            max_tokens: Some(ASSISTANT_MAX_TOKENS),
        };
        match ai_client::generate_text_api(
            client,
            config,
            &meta_prompt(req),
            req.model.as_deref().unwrap_or("gpt-4o-mini"),
            &opts,
            cancel,
            TEXT_TIMEOUT,
        )
        .await
        {
            Ok((text, u)) => {
                usage = u;
                let text = if text.chars().count() > MAX_REPLY_CHARS {
                    text.chars().take(MAX_REPLY_CHARS).collect()
                } else {
                    text
                };
                match extract_json(&text).and_then(|v| serde_json::from_value::<ModelReply>(v).ok())
                {
                    Some(parsed) => {
                        let rewritten = parsed
                            .rewritten
                            .map(|r| r.trim().to_string())
                            .filter(|r| !r.is_empty() && r.chars().count() <= MAX_REPLY_CHARS);
                        model_says = rewritten;
                        for s in parsed.suggestions.into_iter().take(3) {
                            let title = s.title.trim();
                            let detail = s.detail.trim();
                            if title.is_empty() && detail.is_empty() {
                                continue;
                            }
                            suggestions.push(Suggestion {
                                kind: "rewrite".to_string(),
                                title: if title.is_empty() {
                                    "来自模型的建议".to_string()
                                } else {
                                    title.to_string()
                                },
                                detail: detail.to_string(),
                            });
                        }
                    }
                    // 模型没按格式回：不报错，保留本地建议
                    None => heuristic_only = true,
                }
            }
            Err(e) if e.code == code::CANCELLED => return Err(e),
            // 上游失败同样降级：本地建议仍然有用
            Err(_) => heuristic_only = true,
        }
    } else {
        heuristic_only = true;
    }

    Ok(AssistantReply {
        suggestions,
        rewritten: model_says,
        heuristic_only,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn req(kind: &str, prompt: &str, err: Option<&str>) -> AssistantRequest {
        AssistantRequest {
            kind: kind.to_string(),
            prompt: prompt.to_string(),
            model: None,
            last_error: err.map(str::to_string),
        }
    }

    fn titles(list: &[Suggestion]) -> Vec<&str> {
        list.iter().map(|s| s.title.as_str()).collect()
    }

    #[test]
    fn every_diagnostic_code_maps_to_actionable_advice() {
        let codes = [
            code::NO_CONFIG,
            code::AUTH,
            code::RATE_LIMIT,
            code::TIMEOUT,
            code::UPSTREAM_5XX,
            code::CONTENT_POLICY,
            code::PARSE,
            code::INVALID_PARAM,
            code::NETWORK,
            code::STORAGE,
            code::CANCELLED,
            "SOMETHING_NEW",
        ];
        for c in codes {
            let s = diagnose(Some(c)).unwrap_or_else(|| panic!("{c} 没有诊断建议"));
            assert!(!s.detail.trim().is_empty(), "{c} 说明为空");
            assert_eq!(s.kind, "diagnose");
        }
        assert!(diagnose(None).is_none());
        assert!(diagnose(Some("  ")).is_none());
    }

    #[test]
    fn content_policy_advice_offers_no_bypass() {
        let s = diagnose(Some(code::CONTENT_POLICY)).unwrap();
        assert!(
            s.detail.contains("不会提供任何绕过审核的手段"),
            "{}",
            s.detail
        );
    }

    #[test]
    fn heuristics_cover_length_negative_and_style_gaps() {
        let empty = heuristics(&req("text", "   ", None));
        assert_eq!(titles(&empty), vec!["先写清要什么"]);

        let short = heuristics(&req("image", "猫", None));
        assert!(
            titles(&short).contains(&"提示词偏短（1 字）"),
            "{:?}",
            titles(&short)
        );
        assert!(titles(&short).contains(&"缺少风格与光线描述"));

        let negative = heuristics(&req(
            "text",
            "写一篇关于秋天的短文，不要太长，避免夸张修辞",
            None,
        ));
        assert!(
            titles(&negative).contains(&"否定式描述往往不生效"),
            "{:?}",
            titles(&negative)
        );

        // 已经写好风格的图片提示不该再唠叨
        let styled = heuristics(&req(
            "image",
            "一只橘猫坐在窗台，逆光，胶片质感，浅景深",
            None,
        ));
        assert!(
            styled.iter().all(|s| s.kind != "param"),
            "{:?}",
            titles(&styled)
        );

        let with_err = heuristics(&req(
            "text",
            "写一篇关于秋天的散文，面向技术读者，八百字",
            Some(code::RATE_LIMIT),
        ));
        assert_eq!(with_err[0].title, "触发上游限流");
    }

    #[test]
    fn extract_json_tolerates_wrappers_and_noise() {
        assert!(extract_json("{\"rewritten\":\"a\"}").is_some());
        assert!(extract_json("```json\n{\"rewritten\":\"a\"}\n```").is_some());
        assert!(extract_json(
            "好的，这是结果：\n{\"suggestions\":[{\"title\":\"t\",\"detail\":\"d\"}]}\n希望有帮助"
        )
        .is_some());
        assert!(extract_json("完全不是 JSON").is_none());
        assert!(extract_json("{\"unclosed\": 1").is_none());
    }

    #[tokio::test]
    async fn advise_merges_model_suggestions_without_any_side_effect() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "{\"rewritten\":\"一只橘猫在窗台晒太阳，逆光，胶片质感\",\"suggestions\":[{\"title\":\"加一个光线词\",\"detail\":\"逆光能让主体更立体\"},{\"title\":\"\",\"detail\":\"\"}]}"}}],
                "usage": {"prompt_tokens": 30, "completion_tokens": 40}
            })))
            .mount(&server)
            .await;

        let cfg = ApiConfig {
            base_url: format!("{}/v1", server.uri()),
            api_key: "sk-TEST-assistant".into(),
        };
        // 短到会被本地规则吐槽的提示词
        let reply = advise(
            &ai_client::build_client(TEXT_TIMEOUT),
            &cfg,
            &req("image", "猫", None),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(!reply.heuristic_only);
        assert_eq!(
            reply.rewritten.as_deref(),
            Some("一只橘猫在窗台晒太阳，逆光，胶片质感")
        );
        assert!(reply.suggestions.iter().any(|s| s.title == "加一个光线词"));
        // title/detail 全空的垃圾条目被丢掉
        assert!(
            !reply
                .suggestions
                .iter()
                .any(|s| s.title.trim().is_empty() && s.detail.trim().is_empty()),
            "{:?}",
            titles(&reply.suggestions)
        );
        assert_eq!(reply.usage.map(|u| u.completion_tokens), Some(40));
        // 元提示要求过「不要提出写文件或删除操作」，且不把配置内容塞进提示词
        let body: serde_json::Value =
            serde_json::from_slice(&server.received_requests().await.unwrap().remove(0).body)
                .unwrap();
        let sent = serde_json::to_string(&body).unwrap();
        assert!(!sent.contains("sk-TEST-assistant"), "密钥出现在上游请求里");
        assert!(sent.contains("不要提出写文件或删除操作"));
    }

    #[tokio::test]
    async fn advise_degrades_when_model_or_config_unavailable() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();

        // 没配服务商：不打上任何上游，仍给本地建议
        let none = advise(
            &ai_client::build_client(TEXT_TIMEOUT),
            &ApiConfig::default(),
            &req("text", "写点东西", Some(code::NO_CONFIG)),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(none.heuristic_only);
        assert_eq!(none.suggestions[0].title, "还没配好服务商");
        assert!(none.usage.is_none());

        // 上游回了散文 → 保留启发式，不失败
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "我建议你把主体和场景写清楚。"}}]
            })))
            .mount(&server)
            .await;
        let cfg = ApiConfig {
            base_url: format!("{}/v1", server.uri()),
            api_key: "sk-TEST-x".into(),
        };
        let messy = advise(
            &ai_client::build_client(TEXT_TIMEOUT),
            &cfg,
            &req("text", "写一段八百字的随笔，面向工程师", None),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(messy.heuristic_only);
        assert!(messy.rewritten.is_none());
        assert!(!messy.suggestions.is_empty());
    }

    #[tokio::test]
    async fn advise_propagates_cancel() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_secs(10))
                    .set_body_json(serde_json::json!({"choices": []})),
            )
            .mount(&server)
            .await;
        let cfg = ApiConfig {
            base_url: format!("{}/v1", server.uri()),
            api_key: "sk-TEST-x".into(),
        };
        let cancel = CancellationToken::new();
        let early = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            early.cancel();
        });
        let err = advise(
            &ai_client::build_client(TEXT_TIMEOUT),
            &cfg,
            &req("text", "写一段随笔", None),
            &cancel,
        )
        .await
        .expect_err("取消必须透传，不能退化成建议");
        assert_eq!(err.code, code::CANCELLED);
    }
}
