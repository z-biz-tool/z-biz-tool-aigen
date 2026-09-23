//! 统一生成入口（doc/优化方案/03 §5、§11.1，任务 T-State / `submit_generation` + `get_generation`）。
//!
//! 取代此前"四个 `generate_*` 命令各写一遍流水线"的分散结构：
//! - `submit_generation` 立即返回 `request_id`，工作在 Rust 侧后台继续，
//!   因此切面板、关面板、并发多条都不影响任务本身（C6 的根因修复）
//! - 状态迁移由调用方以 `aigen://state/{request_id}` 事件推送；`get_generation` 用于对账
//! - 取消仍走 `cancel_generation(request_id)`（同一套 CancellationToken 注册表）
//! - 本模块不依赖 `AppHandle`：`emit` 以闭包注入，所以整条流水线可单测

use crate::ai_client::{self, TextOptions};
use crate::error::{code, GenError};
use crate::history::{self, Record, Usage};
use crate::stream::StreamEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// 03 §5 状态机的七个状态
pub mod status {
    pub const PREPARING: &str = "preparing";
    pub const SUBMITTING: &str = "submitting";
    pub const STREAMING: &str = "streaming";
    pub const POLLING: &str = "polling";
    pub const SUCCEEDED: &str = "succeeded";
    pub const FAILED: &str = "failed";
    pub const CANCELLED: &str = "cancelled";
}

pub fn is_terminal(s: &str) -> bool {
    matches!(s, status::SUCCEEDED | status::FAILED | status::CANCELLED)
}

/// 注册表里最多留多少条任务态（长跑进程不能无界增长）
const REGISTRY_KEEP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GenerationRequest {
    /// text | image | video | ppt
    pub kind: String,
    pub prompt: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    /// count / size / duration / resolution / slides / outline / taskId /
    /// template / system / temperature / maxTokens / stream
    pub params: serde_json::Map<String, serde_json::Value>,
}

impl Default for GenerationRequest {
    fn default() -> Self {
        Self {
            kind: "text".to_string(),
            prompt: String::new(),
            provider_id: None,
            model: None,
            params: serde_json::Map::new(),
        }
    }
}

impl GenerationRequest {
    fn num(&self, key: &str) -> Option<u32> {
        self.params
            .get(key)
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
    }

    fn text(&self, key: &str) -> Option<String> {
        self.params
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }

    fn text_options(&self) -> TextOptions {
        TextOptions {
            system: self.text("system"),
            temperature: self.params.get("temperature").and_then(|v| v.as_f64()),
            max_tokens: self.num("maxTokens"),
        }
    }

    fn streams(&self) -> bool {
        self.params
            .get("stream")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub stage: String,
    pub percent: Option<u8>,
}

/// 前后端共享的任务态（03 §11.3）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GenerationState {
    pub request_id: String,
    #[serde(default)]
    pub kind: String,
    pub status: String,
    /// 本次真正使用的模型（路由后的结果，未必是用户点的那个）
    #[serde(default)]
    pub model: Option<String>,
    /// 流式累积片段
    #[serde(default)]
    pub partial: String,
    pub progress: Option<JobProgress>,
    /// 已落盘的结果引用（相对数据目录）
    #[serde(default)]
    pub result_refs: Vec<String>,
    /// 可直接展示的预览（上游原样给的 URL / data URL），不入库
    pub preview: Vec<String>,
    pub text_result: Option<String>,
    /// 成功时写入的历史记录 id
    #[serde(default)]
    pub record_id: Option<String>,
    #[serde(default)]
    pub usage: Option<Usage>,
    pub error: Option<GenError>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

impl GenerationState {
    pub fn new(request_id: &str, kind: &str) -> Self {
        let now = history::now_iso8601();
        Self {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            status: status::PREPARING.to_string(),
            model: None,
            partial: String::new(),
            progress: None,
            result_refs: Vec::new(),
            preview: Vec::new(),
            text_result: None,
            record_id: None,
            usage: None,
            error: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn touch(&mut self, status: &str) {
        self.status = status.to_string();
        self.updated_at = history::now_iso8601();
    }
}

/// 任务表：`get_generation` 与事件推送都读它
#[derive(Default)]
pub struct Registry {
    inner: Mutex<HashMap<String, GenerationState>>,
}

impl Registry {
    pub fn put(&self, st: GenerationState) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > REGISTRY_KEEP {
            // 先丢最旧的已完成任务，绝不丢在途任务
            let mut done: Vec<(String, String)> = map
                .values()
                .filter(|v| is_terminal(&v.status))
                .map(|v| (v.request_id.clone(), v.updated_at.clone()))
                .collect();
            done.sort_by(|a, b| a.1.cmp(&b.1));
            for (id, _) in done.into_iter().take(map.len() - REGISTRY_KEEP) {
                map.remove(&id);
            }
        }
        map.insert(st.request_id.clone(), st);
    }

    pub fn get(&self, id: &str) -> Option<GenerationState> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn snapshot(&self) -> Vec<GenerationState> {
        let mut v: Vec<GenerationState> = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        v
    }
}

enum Generated {
    Text { text: String, usage: Option<Usage> },
    Urls(Vec<String>),
    Files { preview: String, refs: Vec<String> },
}

/// 执行一次生成的全过程。`emit` 收到每一次状态迁移（生产环境转发为 Tauri 事件）。
pub async fn execute<E>(
    state: &ai_client::AppState,
    request_id: &str,
    req: &GenerationRequest,
    cancel: &CancellationToken,
    mut emit: E,
) -> GenerationState
where
    E: FnMut(&GenerationState),
{
    let mut st = GenerationState::new(request_id, &req.kind);
    st.kind = req.kind.clone();

    let (cfg, _pid, chosen) =
        match state.resolved(&req.kind, req.provider_id.as_deref(), req.model.as_deref()) {
            Ok(v) => v,
            Err(e) => return failed(state, st, req, e, &mut emit),
        };
    let model = chosen.or_else(|| req.model.clone());
    st.model = model.clone();

    if req.kind == "video" && req.text("taskId").is_some() {
        return poll_video(state, st, req, &cfg, cancel, &mut emit).await;
    }

    st.touch(status::SUBMITTING);
    emit(&st);

    let permit = match state.acquire(cancel).await {
        Ok(p) => p,
        Err(e) => return failed(state, st, req, e, &mut emit),
    };

    let outcome = match req.kind.as_str() {
        "image" => ai_client::generate_image_api(
            &state.client,
            &cfg,
            &req.prompt,
            req.num("count").unwrap_or(1),
            model.as_deref(),
            req.text("size").as_deref(),
            cancel,
            ai_client::IMAGE_TIMEOUT,
        )
        .await
        .map(Generated::Urls),

        "video" => ai_client::generate_video_api(
            &state.client,
            &cfg,
            &req.prompt,
            &req.text("duration").unwrap_or_else(|| "5".into()),
            &req.text("resolution").unwrap_or_else(|| "1080p".into()),
            cancel,
            ai_client::VIDEO_TIMEOUT,
        )
        .await
        .map(|u| Generated::Urls(vec![u])),

        "ppt" => {
            let id = new_id();
            let outline = req
                .params
                .get("outline")
                .and_then(|v| {
                    serde_json::from_value::<Vec<ai_client::PptOutlineItem>>(v.clone()).ok()
                })
                .unwrap_or_default();
            let ppt = ai_client::PptRequest {
                topic: req.prompt.clone(),
                template: req.text("template").unwrap_or_else(|| "business".into()),
                slides: req.num("slides").unwrap_or(10),
                outline,
            };
            ai_client::generate_ppt_file(&state.client, &cfg, &id, &ppt, model.as_deref(), cancel)
                .await
                .map(|art| Generated::Files {
                    preview: art.preview,
                    refs: art.refs,
                })
        }

        _ => {
            let opts = req.text_options();
            let model_name = model.unwrap_or_else(|| "gpt-4o-mini".to_string());
            if req.streams() {
                let mut acc = String::new();
                let res = ai_client::generate_text_stream_api(
                    &state.client,
                    &cfg,
                    &req.prompt,
                    &model_name,
                    &opts,
                    cancel,
                    |ev: StreamEvent| {
                        if ev.done || ev.delta.is_empty() {
                            return;
                        }
                        acc.push_str(&ev.delta);
                        let mut s = st.clone();
                        s.touch(status::STREAMING);
                        s.partial = acc.clone();
                        emit(&s);
                    },
                )
                .await;
                res.map(|(text, usage)| Generated::Text { text, usage })
            } else {
                ai_client::generate_text_api(
                    &state.client,
                    &cfg,
                    &req.prompt,
                    &model_name,
                    &opts,
                    cancel,
                    ai_client::TEXT_TIMEOUT,
                )
                .await
                .map(|(text, usage)| Generated::Text { text, usage })
            }
        }
    };
    drop(permit);

    match outcome {
        Err(e) => failed(state, st, req, e, &mut emit),
        Ok(generated) => {
            let record_id = new_id();
            st.record_id = Some(record_id.clone());
            match generated {
                Generated::Text { text, usage } => {
                    st.text_result = Some(text);
                    st.usage = usage;
                }
                Generated::Urls(urls) => {
                    st.preview = urls.clone();
                    st.result_refs = persist_urls(state, &record_id, &urls, cancel).await;
                }
                Generated::Files { preview, refs } => {
                    st.preview = vec![preview];
                    st.result_refs = refs;
                }
            }
            st.progress = Some(JobProgress {
                stage: "已完成".into(),
                percent: Some(100),
            });
            commit(state, req, &st);
            st.touch(status::SUCCEEDED);
            emit(&st);
            st
        }
    }
}

/// 视频任务轮询分支（T-B2）：进度以 polling 状态持续上报
async fn poll_video<E>(
    state: &ai_client::AppState,
    mut st: GenerationState,
    req: &GenerationRequest,
    cfg: &ai_client::ApiConfig,
    cancel: &CancellationToken,
    emit: &mut E,
) -> GenerationState
where
    E: FnMut(&GenerationState),
{
    let task_id = req.text("taskId").unwrap_or_default();
    st.touch(status::POLLING);
    st.progress = Some(JobProgress {
        stage: "queued".into(),
        percent: Some(0),
    });
    emit(&st);

    let permit = match state.acquire(cancel).await {
        Ok(p) => p,
        Err(e) => return failed(state, st, req, e, emit),
    };
    let result = ai_client::poll_video_task(
        &state.client,
        cfg,
        &task_id,
        cancel,
        ai_client::VIDEO_POLL_INTERVAL,
        ai_client::VIDEO_POLL_BUDGET,
        |percent, stage| {
            let mut s = st.clone();
            s.touch(status::POLLING);
            s.progress = Some(JobProgress {
                stage: stage.into(),
                percent: Some(percent.min(100) as u8),
            });
            emit(&s);
        },
    )
    .await;
    drop(permit);

    match result {
        Err(e) => failed(state, st, req, e, emit),
        Ok(url) => {
            let record_id = new_id();
            st.record_id = Some(record_id.clone());
            st.preview = vec![url.clone()];
            st.result_refs = vec![url];
            st.progress = Some(JobProgress {
                stage: "已完成".into(),
                percent: Some(100),
            });
            commit(state, req, &st);
            st.touch(status::SUCCEEDED);
            emit(&st);
            st
        }
    }
}

fn failed<E>(
    _state: &ai_client::AppState,
    mut st: GenerationState,
    _req: &GenerationRequest,
    e: GenError,
    emit: &mut E,
) -> GenerationState
where
    E: FnMut(&GenerationState),
{
    let target = if e.code == code::CANCELLED {
        status::CANCELLED
    } else {
        status::FAILED
    };
    st.error = Some(e);
    st.touch(target);
    emit(&st);
    st
}

/// 结果落盘：base64 解码 / 远端下载；失败退化为"保存远端引用"，不影响本次生成
async fn persist_urls(
    state: &ai_client::AppState,
    record_id: &str,
    urls: &[String],
    cancel: &CancellationToken,
) -> Vec<String> {
    let mut refs = Vec::new();
    for (i, url) in urls.iter().enumerate() {
        let saved = if let Some((bytes, ext)) = history::decode_data_url(url) {
            history::save_result_bytes(record_id, i, &ext, &bytes)
        } else {
            match ai_client::fetch_bytes(&state.client, url, cancel, ai_client::IMAGE_TIMEOUT).await
            {
                Ok(bytes) => history::save_result_bytes(record_id, i, &image_ext(url), &bytes),
                // 留存失败不推翻生成结果：历史仍存可点的远端引用
                Err(_) => Ok(url.clone()),
            }
        };
        match saved {
            Ok(r) => refs.push(r),
            Err(e) => {
                eprintln!("[aigen] 结果留存失败（{}）", e.code);
                refs.push(url.clone());
            }
        }
    }
    refs
}

pub(crate) fn image_ext(url: &str) -> String {
    let path = url.split_once('?').map(|(p, _)| p).unwrap_or(url);
    let tail = path.rsplit('/').next().unwrap_or("");
    match tail.rsplit_once('.') {
        Some((_, ext))
            if (2..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            ext.to_ascii_lowercase()
        }
        _ => "png".to_string(),
    }
}

/// 成功后写历史。记录内容与旧的 `generate_*` 命令保持一致。
fn commit(state: &ai_client::AppState, req: &GenerationRequest, st: &GenerationState) {
    let mut params = req.params.clone();
    params.insert("requested_model".into(), serde_json::json!(req.model));
    let record = Record {
        id: st.record_id.clone().unwrap_or_else(new_id),
        kind: st.kind.clone(),
        prompt: req.prompt.clone(),
        // 记的是实际用的模型，不是"用户点了什么"
        model: st.model.clone(),
        params,
        result_refs: st.result_refs.clone(),
        text_result: st.text_result.clone(),
        status: "succeeded".to_string(),
        created_at: st.updated_at.clone(),
        usage: st.usage.clone(),
        favorite: false,
    };
    if let Err(e) = state
        .history
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(record)
    {
        eprintln!("[aigen] 历史落盘失败（{}）：{}", e.code, e.message);
    }
}

pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let mut buf = [0u8; 16];
    let _ = getrandom::getrandom(&mut buf);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    buf[8..16].copy_from_slice(&seq.to_le_bytes());
    buf.iter()
        .enumerate()
        .fold(String::new(), |mut acc, (i, b)| {
            if matches!(i, 4 | 6 | 8 | 10) {
                acc.push('-');
            }
            acc.push_str(&format!("{b:02x}"));
            acc
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_client::AppState;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn req(kind: &str, prompt: &str) -> GenerationRequest {
        GenerationRequest {
            kind: kind.to_string(),
            prompt: prompt.to_string(),
            provider_id: None,
            model: None,
            params: serde_json::Map::new(),
        }
    }

    fn with_params(mut r: GenerationRequest, key: &str, v: serde_json::Value) -> GenerationRequest {
        r.params.insert(key.to_string(), v);
        r
    }

    fn cfg_for(server: &MockServer) -> ai_client::AppConfig {
        let mut params = serde_json::Map::new();
        params.insert("count".into(), serde_json::json!(1));
        ai_client::AppConfig {
            version: ai_client::CONFIG_VERSION,
            providers: vec![ai_client::Provider {
                id: "mock".into(),
                name: "mock".into(),
                base_url: format!("{}/v1", server.uri()),
                capabilities: vec!["text".into(), "image".into(), "video".into(), "ppt".into()],
                models: vec!["gpt-4o".into(), "dall-e-3".into()],
                api_key: "sk-TEST-job-key".into(),
            }],
            active: HashMap::from([
                ("text".into(), "mock".into()),
                ("image".into(), "mock".into()),
                ("video".into(), "mock".into()),
                ("ppt".into(), "mock".into()),
            ]),
        }
    }

    /// 用一个只读的 state 实例：测试里不共享 AppState，所以手动装配置
    fn state_with(server: &MockServer) -> AppState {
        let state = AppState::new();
        *state.config.lock().unwrap() = cfg_for(server);
        state
    }

    #[tokio::test]
    async fn text_job_reports_states_and_result() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "统一入口的结果"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 7}
            })))
            .mount(&server)
            .await;
        let state = state_with(&server);
        let mut seen = Vec::new();
        let st = execute(
            &state,
            "job-1",
            &req("text", "写点什么"),
            &CancellationToken::new(),
            |s| seen.push(s.clone()),
        )
        .await;

        assert_eq!(st.status, status::SUCCEEDED);
        assert_eq!(st.text_result.as_deref(), Some("统一入口的结果"));
        assert_eq!(st.usage.map(|u| u.completion_tokens), Some(7));
        assert!(st.record_id.is_some());
        assert_eq!(seen.len(), 2, "应只有一次 submitting + 一次 succeeded");
        assert_eq!(seen[0].status, status::SUBMITTING);
        assert!(is_terminal(&seen[1].status));

        // 历史确实入库，且能被 get/query 读到
        let hist = state.history.lock().unwrap();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist.records()[0].kind, "text");
        assert_eq!(hist.records()[0].model.as_deref(), Some("gpt-4o"));
    }

    #[tokio::test]
    async fn stream_job_emits_partial_then_succeeded() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"世界\"}}]}\n\n",
                        "data: [DONE]\n\n",
                    )),
            )
            .mount(&server)
            .await;
        let state = state_with(&server);
        let mut seen = Vec::new();
        let r = with_params(req("text", "写"), "stream", serde_json::json!(true));
        let st = execute(&state, "job-2", &r, &CancellationToken::new(), |s| {
            seen.push(s.clone())
        })
        .await;

        assert_eq!(st.text_result.as_deref(), Some("你好世界"));
        let streamings: Vec<_> = seen
            .iter()
            .filter(|s| s.status == status::STREAMING)
            .collect();
        assert_eq!(streamings.len(), 2, "两段增量应各报一次 streaming");
        assert_eq!(streamings[0].partial, "你好");
        assert_eq!(streamings[1].partial, "你好世界");
        assert_eq!(seen.last().unwrap().status, status::SUCCEEDED);
        // 历史里记的是整段，不是中间态
        assert_eq!(
            state.history.lock().unwrap().records()[0]
                .text_result
                .as_deref(),
            Some("你好世界")
        );
    }

    #[tokio::test]
    async fn image_job_persists_results_as_refs() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"url": format!("{}/pic.png", server.uri())}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/pic.png"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/png")
                    .set_body_bytes(b"\x89PNG-fake".as_slice()),
            )
            .mount(&server)
            .await;

        let state = state_with(&server);
        let r = with_params(req("image", "橘猫"), "size", serde_json::json!("1024x1024"));
        let st = execute(&state, "job-3", &r, &CancellationToken::new(), |_| {}).await;

        assert_eq!(st.status, status::SUCCEEDED);
        assert_eq!(st.preview.len(), 1);
        assert_eq!(st.result_refs.len(), 1, "应落盘成本地引用");
        assert!(
            st.result_refs[0].starts_with("results/"),
            "{}",
            st.result_refs[0]
        );
        assert_eq!(
            std::fs::read(history::Store::resolve_ref(&st.result_refs[0])).unwrap(),
            b"\x89PNG-fake"
        );
        // 预览地址不该进历史（B6）
        let guard = state.history.lock().unwrap();
        let rec = &guard.records()[0];
        assert_eq!(rec.result_refs, st.result_refs);
        assert!(rec.text_result.is_none());
    }

    #[tokio::test]
    async fn failure_becomes_failed_state_with_sanitized_error() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("bad sk-TEST-job-key"))
            .mount(&server)
            .await;
        let state = state_with(&server);
        let mut seen = Vec::new();
        let st = execute(
            &state,
            "job-4",
            &req("text", "x"),
            &CancellationToken::new(),
            |s| seen.push(s.clone()),
        )
        .await;

        assert_eq!(st.status, status::FAILED);
        assert_eq!(st.error.as_ref().map(|e| e.code.as_str()), Some(code::AUTH));
        assert!(!st.error.unwrap().message.contains("sk-TEST-job-key"));
        assert_eq!(state.history.lock().unwrap().len(), 0, "失败不入库");
        assert_eq!(seen.last().unwrap().status, status::FAILED);
    }

    #[tokio::test]
    async fn unresolvable_config_fails_without_calling_upstream() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let state = AppState::new(); // 没有服务商
        let st = execute(
            &state,
            "job-5",
            &req("text", "x"),
            &CancellationToken::new(),
            |_| {},
        )
        .await;

        assert_eq!(st.status, status::FAILED);
        assert_eq!(st.error.map(|e| e.code), Some(code::NO_CONFIG.to_string()));
        assert_eq!(server.received_requests().await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn cancel_during_flight_reports_cancelled() {
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
        let state = state_with(&server);
        let cancel = CancellationToken::new();
        let bomber = {
            let c = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                c.cancel();
            })
        };
        let st = execute(&state, "job-6", &req("text", "x"), &cancel, |_| {}).await;
        bomber.await.unwrap();

        assert_eq!(st.status, status::CANCELLED);
        assert_eq!(st.error.map(|e| e.code), Some(code::CANCELLED.to_string()));
    }

    /// 06 §3「集成」一整条链路串起来：mock 上游 → 结果落盘 → 写历史 → 再导出到用户目录。
    /// 这一步是真的会碰磁盘与历史文件，不是 mock 内部状态。
    #[tokio::test]
    async fn full_pipeline_upstream_to_disk_to_history_to_export() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "url": format!("{}/pic.png", server.uri()) }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/pic.png"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/png")
                    .set_body_bytes(b"\x89PNG-pipeline-bytes".as_slice()),
            )
            .mount(&server)
            .await;

        let state = AppState::new();
        *state.config.lock().unwrap() = cfg_for(&server);
        let req = with_params(req("image", "一只橘猫"), "count", serde_json::json!(1));
        let st = execute(&state, "job-e2e", &req, &CancellationToken::new(), |_| {}).await;
        assert_eq!(st.status, status::SUCCEEDED, "{:?}", st.error);

        // 1) 结果真的落盘，且不是内联 base64
        assert_eq!(st.result_refs.len(), 1);
        let abs = history::Store::resolve_ref(&st.result_refs[0]);
        assert_eq!(std::fs::read(&abs).unwrap(), b"\x89PNG-pipeline-bytes");

        // 2) 历史落盘：可重开读到，且时间戳是 ISO8601
        let reopened = history::Store::open();
        assert_eq!(reopened.len(), 1);
        let rec = reopened.records()[0].clone();
        assert_eq!(rec.kind, "image");
        assert_eq!(rec.prompt, "一只橘猫");
        assert_eq!(rec.result_refs, st.result_refs);
        assert!(
            rec.created_at.ends_with('Z'),
            "时间戳不是 ISO8601: {}",
            rec.created_at
        );
        assert_eq!(rec.status, "succeeded");

        // 3) 导出：从历史记录取引用，写到用户选的目标路径
        let out_dir = tempfile::tempdir().unwrap();
        let target = out_dir.path().join("我的图片.png");
        let exported = crate::export::write_export(
            &state.client,
            Some(&rec),
            Some(0),
            None,
            &target,
            false,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(exported.source, "file");
        assert_eq!(std::fs::read(&target).unwrap(), b"\x89PNG-pipeline-bytes");

        // 4) 覆盖必须显式允许（04 §6）
        let err = crate::export::write_export(
            &state.client,
            Some(&rec),
            Some(0),
            None,
            &target,
            false,
            &CancellationToken::new(),
        )
        .await
        .expect_err("已存在的目标要拦");
        assert_eq!(err.code, code::CONFLICT);
        let again = crate::export::write_export(
            &state.client,
            Some(&rec),
            Some(0),
            None,
            &target,
            true,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(again.bytes, b"\x89PNG-pipeline-bytes".len());
    }

    #[test]
    fn registry_bounded_and_readable() {
        let reg = Registry::default();
        assert!(reg.is_empty());
        for i in 0..(REGISTRY_KEEP + 40) {
            let mut st = GenerationState::new(&format!("r{i}"), "text");
            st.status = status::SUCCEEDED.to_string();
            reg.put(st);
        }
        assert!(
            reg.len() <= REGISTRY_KEEP + 1,
            "注册表未收敛：{}",
            reg.len()
        );
        let snap = reg.snapshot();
        assert!(!snap.is_empty());
        assert!(reg.get(&snap[0].request_id).is_some());
        assert!(reg.get("nope").is_none());
    }

    #[test]
    fn in_flight_jobs_are_never_evicted() {
        let reg = Registry::default();
        // 先塞满已完成任务
        for i in 0..(REGISTRY_KEEP + 5) {
            let mut st = GenerationState::new(&format!("done{i}"), "text");
            st.status = status::SUCCEEDED.to_string();
            reg.put(st);
        }
        let mut live = GenerationState::new("live-1", "text");
        live.status = status::STREAMING.to_string();
        reg.put(live.clone());
        for i in 0..(REGISTRY_KEEP + 5) {
            let mut st = GenerationState::new(&format!("more{i}"), "text");
            st.status = status::SUCCEEDED.to_string();
            reg.put(st);
        }
        assert!(reg.get("live-1").is_some(), "在途任务被回收了");
    }

    #[test]
    fn request_param_accessors_are_forgiving() {
        let r = GenerationRequest::default();
        assert_eq!(r.num("count"), None);
        assert_eq!(r.text("size"), None);
        assert!(!r.streams());
        let typed = with_params(
            with_params(r, "count", serde_json::json!(4)),
            "stream",
            serde_json::json!(true),
        );
        assert_eq!(typed.num("count"), Some(4));
        assert!(typed.streams());
        assert_eq!(typed.text_options().temperature, None);
    }

    /// 前端 jobClient.ts 直接按这些键名读，形状必须先钉住
    #[test]
    fn state_serializes_to_the_camel_case_shape_the_ui_reads() {
        let st = GenerationState::new("req-1", "text");
        let v: serde_json::Value = serde_json::to_value(&st).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "requestId",
            "kind",
            "status",
            "model",
            "partial",
            "progress",
            "resultRefs",
            "preview",
            "textResult",
            "recordId",
            "usage",
            "error",
            "createdAt",
            "updatedAt",
        ] {
            assert!(obj.contains_key(key), "缺少前端要读的键 {key}：{obj:?}");
        }
        // 反过来说明前端不会读到 snake_case
        for bad in ["request_id", "result_refs", "text_result", "record_id"] {
            assert!(!obj.contains_key(bad), "不应出现 {bad}");
        }

        // 请求体形状：前端只发 kind/prompt/providerId/model/params
        let req = GenerationRequest {
            kind: "image".into(),
            prompt: "猫".into(),
            provider_id: Some("oa".into()),
            model: None,
            params: serde_json::Map::new(),
        };
        let back: GenerationRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back, req);
        // 缺字段必须可容忍（前端可能不传 params）
        let minimal: GenerationRequest = serde_json::from_str(r#"{"kind":"text"}"#).unwrap();
        assert_eq!(minimal.prompt, "");
        assert!(minimal.params.is_empty());
        assert!(!minimal.streams());
    }

    #[test]
    fn ids_look_like_uuids_and_are_unique() {
        let ids: Vec<String> = (0..400).map(|_| new_id()).collect();
        let uniq: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(uniq.len(), ids.len());
        assert_eq!(ids[0].chars().filter(|c| *c == '-').count(), 4);
        assert_eq!(ids[0].len(), 36);
    }
}
