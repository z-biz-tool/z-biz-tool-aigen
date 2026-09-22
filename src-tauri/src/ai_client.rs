//! AI 上游调用网关（doc/优化方案/03 §2）。
//!
//! 阶段一（P0）改造：
//! - 全局共享 [`reqwest::Client`] + 分级超时（T-C2），替代每请求 `Client::new()`
//! - `CancellationToken` 贯穿发送与读体，取消即丢弃 future 释放连接（T-C3）
//! - 限流/网络层失败指数退避自动重试（03 §2.4，计费风险规避见 04 §8.4）
//! - 图片 `model` / `size` 透传上游（T-B1）
//! - 错误统一为脱敏的 [`GenError`]（T-C4）
//! - key 只从加密存储载入，永不下发渲染进程（T-A2/A3/A4）

use crate::error::{auto_retryable, code, GenError};
use crate::secret;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// 超时目标值取自 03 §2.1。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const TEXT_TIMEOUT: Duration = Duration::from_secs(120);
pub const IMAGE_TIMEOUT: Duration = Duration::from_secs(180);
pub const VIDEO_TIMEOUT: Duration = Duration::from_secs(30);

/// 自动重试：最多 2 次退避（03 §2.4）。
const MAX_RETRIES: u32 = 2;
const BACKOFF_BASE_MS: u64 = 800;

/// 输入上限（04 §4.3：避免异常请求）。
pub const MAX_PROMPT_CHARS: usize = 8_000;
pub const MAX_IMAGE_COUNT: u32 = 10;

/// 单个上游 Provider（03 §3）。密钥只存在于 Rust 侧。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// 支持的能力：text / image / video / ppt。空列表按"全能力"处理（迁移来的旧配置）
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// 该 Provider 可用的模型；空列表表示未知（不做模型白名单校验）
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub api_key: String,
}

impl Provider {
    pub fn supports(&self, kind: &str) -> bool {
        self.capabilities.is_empty() || self.capabilities.iter().any(|c| c == kind)
    }
}

/// 解析后的调用凭据：HTTP 层只认这一对（base_url + key），与 Provider 数量解耦
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ApiConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

/// 多 Provider 配置（T-Provider，修 B4）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppConfig {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub providers: Vec<Provider>,
    /// kind -> provider_id
    #[serde(default)]
    pub active: HashMap<String, String>,
}

pub const DEFAULT_BASE_URL: &str = "https://api.minimax.chat/v1";

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            providers: Vec::new(),
            active: HashMap::new(),
        }
    }
}

/// 当前配置格式版本
pub const CONFIG_VERSION: u32 = 3;

impl AppConfig {
    /// 旧版单 base_url+key 配置 → 单个全能力 Provider（无模型清单，故不做白名单）
    pub fn from_legacy(legacy: &ApiConfig) -> Self {
        let mut active = HashMap::new();
        for kind in ["text", "image", "video", "ppt"] {
            active.insert(kind.to_string(), "default".to_string());
        }
        Self {
            version: CONFIG_VERSION,
            providers: vec![Provider {
                id: "default".to_string(),
                name: "默认服务商".to_string(),
                base_url: if legacy.base_url.trim().is_empty() {
                    DEFAULT_BASE_URL.to_string()
                } else {
                    legacy.base_url.clone()
                },
                capabilities: vec![],
                models: vec![],
                api_key: legacy.api_key.clone(),
            }],
            active,
        }
    }

    pub fn normalize(&mut self) {
        self.version = CONFIG_VERSION;
        self.providers.retain(|p| !p.id.trim().is_empty());
        // 每个 kind 的 active 必须指向存在且支持该能力的 provider，否则清掉以免生成时报错含糊
        for pid in self.active.values_mut() {
            if !self.providers.iter().any(|p| &p.id == pid) {
                pid.clear();
            }
        }
        self.active.retain(|_, v| !v.is_empty());
    }

    /// 按能力路由到具体 Provider（03 §3："杜绝 OpenAI 模型打 MiniMax 端点"）
    pub fn resolve(
        &self,
        kind: &str,
        provider_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<(ApiConfig, String, Option<String>), GenError> {
        let candidates: Vec<&Provider> =
            self.providers.iter().filter(|p| p.supports(kind)).collect();
        if candidates.is_empty() {
            return Err(GenError::new(
                code::NO_CONFIG,
                if self.providers.is_empty() {
                    "尚未配置服务商，请先在「API 配置」中填写 Base URL 与密钥"
                } else {
                    "已配置的服务商都不支持这类生成，请在「API 配置」里给该服务商勾上对应能力"
                },
            ));
        }
        let picked: &Provider = if let Some(pid) = provider_id.filter(|s| !s.trim().is_empty()) {
            candidates.iter().find(|p| p.id == pid).ok_or_else(|| {
                GenError::new(
                    code::INVALID_PARAM,
                    format!("服务商 {pid} 不支持 {kind} 生成"),
                )
            })?
        } else if let Some(pid) = self.active.get(kind) {
            candidates
                .iter()
                .copied()
                .find(|p| &p.id == pid)
                .or((candidates.len() == 1).then(|| candidates[0]))
                .ok_or_else(|| {
                    GenError::new(
                        code::NO_CONFIG,
                        format!("{kind} 的默认服务商不可用，请在「API 配置」里重新选择"),
                    )
                })?
        } else if candidates.len() == 1 {
            candidates[0]
        } else {
            return Err(GenError::new(
                code::NO_CONFIG,
                format!("有多个服务商支持 {kind}，请先在「API 配置」里指定默认服务商"),
            ));
        };

        if picked.api_key.trim().is_empty() {
            return Err(GenError::new(
                code::NO_CONFIG,
                format!("服务商「{}」还没有填写密钥", picked.name),
            ));
        }
        // 模型白名单：仅在服务商声明了模型清单时校验
        let chosen_model = match model.map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => {
                if !picked.models.is_empty() && !picked.models.iter().any(|x| x == m) {
                    return Err(GenError::new(
                        code::INVALID_PARAM,
                        format!(
                            "模型 {m} 不属于服务商「{}」，可选：{}",
                            picked.name,
                            picked.models.join("、")
                        ),
                    ));
                }
                Some(m.to_string())
            }
            None => picked.models.first().cloned(),
        };
        Ok((
            ApiConfig {
                base_url: picked.base_url.clone(),
                api_key: picked.api_key.clone(),
            },
            picked.id.clone(),
            chosen_model,
        ))
    }
}

/// 下发给渲染进程的服务商视图：**不含密钥**，只给存在性与掩码（04 §2.2）
#[derive(Debug, Clone, Serialize)]
pub struct PublicProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub capabilities: Vec<String>,
    pub models: Vec<String>,
    pub has_key: bool,
    pub key_masked: Option<String>,
}

impl PublicProvider {
    pub fn from(p: &Provider) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            base_url: p.base_url.clone(),
            capabilities: p.capabilities.clone(),
            models: p.models.clone(),
            has_key: !p.api_key.is_empty(),
            key_masked: if p.api_key.is_empty() {
                None
            } else {
                mask_key(&p.api_key)
            },
        }
    }
}

/// `load_api_config` 的返回形状（03 §11.1）
#[derive(Debug, Clone, Serialize)]
pub struct ProvidersView {
    pub providers: Vec<PublicProvider>,
    pub active: HashMap<String, String>,
}

impl ProvidersView {
    pub fn from_cfg(cfg: &AppConfig) -> Self {
        Self {
            providers: cfg.providers.iter().map(PublicProvider::from).collect(),
            active: cfg.active.clone(),
        }
    }
}

/// `sk-****abcd`：保留可辨识性，不还原密钥。
pub fn mask_key(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() < 8 {
        return Some("*".repeat(chars.len()));
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    Some(format!("sk-****{tail}"))
}

/// 全局并发上限（03 §8）：批量任务与手滑多点都靠它兜底，避免打爆上游额度与本地带宽。
pub const MAX_CONCURRENT_GENERATIONS: usize = 2;

/// 全局状态
pub struct AppState {
    pub config: Mutex<AppConfig>,
    /// JSONL 落盘历史（T-C1）
    pub history: Mutex<crate::history::Store>,
    /// 提示词模板库（T-Prompt）
    pub templates: Mutex<crate::templates::Store>,
    /// 连接池复用的共享 client（03 §8）
    pub client: Client,
    /// request_id → 取消句柄
    pub tasks: Mutex<HashMap<String, CancellationToken>>,
    /// 生成任务并发闸门
    pub gate: tokio::sync::Semaphore,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            config: Mutex::new(AppConfig::default()),
            history: Mutex::new(crate::history::Store::open()),
            templates: Mutex::new(crate::templates::Store::open()),
            client: build_client(TEXT_TIMEOUT),
            tasks: Mutex::new(HashMap::new()),
            gate: tokio::sync::Semaphore::new(MAX_CONCURRENT_GENERATIONS),
        }
    }

    /// 取一个并发额度；等待期间可被取消（否则会卡住整批任务）。
    pub async fn acquire(
        &self,
        cancel: &CancellationToken,
    ) -> Result<tokio::sync::SemaphorePermit<'_>, GenError> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(GenError::cancelled()),
            r = self.gate.acquire() => r.map_err(|_| GenError::storage("并发闸门已关闭")),
        }
    }

    /// 载入配置：首次调用会把历史明文 config.json 迁移为加密信封。
    pub fn load_config(&self) -> Result<AppConfig, GenError> {
        let cfg = load_config()?;
        *self.config.lock().unwrap_or_else(|e| e.into_inner()) = cfg.clone();
        Ok(cfg)
    }

    /// 解析某类生成应使用的凭据（连同命中的服务商与最终模型）
    pub fn resolved(
        &self,
        kind: &str,
        provider_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<(ApiConfig, String, Option<String>), GenError> {
        let cfg = self
            .config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        cfg.resolve(kind, provider_id, model)
    }
}

/// 带超时与连接池的共享 client。
pub fn build_client(timeout: Duration) -> Client {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(4)
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// 获取配置文件路径
pub fn config_file_path() -> std::path::PathBuf {
    secret::config_path()
}

/// 保存配置（加密落盘，T-A2）
pub fn save_config(config: &AppConfig) -> Result<(), GenError> {
    let dir = secret::data_dir();
    let key = secret::master_key(&dir).map_err(GenError::storage)?;
    let plain = serde_json::to_vec(config)
        .map_err(|e| GenError::storage(format!("序列化配置失败: {e}")))?;
    let env = secret::seal(&key, &plain).map_err(|e| GenError::storage(e.to_string()))?;
    let json = serde_json::to_string_pretty(&env)
        .map_err(|e| GenError::storage(format!("序列化配置失败: {e}")))?;
    // 原子覆盖：旧明文文件（若存在）被同路径的密文信封替换
    secret::atomic_write(&config_file_path(), json.as_bytes()).map_err(GenError::storage)
}

/// 把任意历史形状的配置值收敛为 AppConfig（v3）。
/// 认不出 `providers` 字段的一律按旧的"单 base_url + key"迁移。
fn config_from_value(value: &serde_json::Value) -> Result<AppConfig, GenError> {
    if value.get("providers").is_some() || value.get("version").is_some() {
        let mut cfg: AppConfig = serde_json::from_value(value.clone())
            .map_err(|e| GenError::storage(format!("解析服务商配置失败: {e}")))?;
        cfg.normalize();
        return Ok(cfg);
    }
    let legacy: ApiConfig = serde_json::from_value(value.clone())
        .map_err(|e| GenError::storage(format!("解析配置失败: {e}")))?;
    Ok(AppConfig::from_legacy(&legacy))
}

/// 从文件加载配置。兼容：不存在 / 加密信封（v3 或旧单服务商）/ 历史明文（读取后迁移为加密）。
pub fn load_config() -> Result<AppConfig, GenError> {
    let path = config_file_path();
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let dir = secret::data_dir();
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| GenError::storage(format!("读取配置文件失败: {e}")))?;

    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // 无法解析的配置文件视为损坏：备份后回到默认，不阻塞启动（04 §5 可恢复）
        Err(_) => {
            let _ = std::fs::rename(&path, path.with_extension("json.bak"));
            return Ok(AppConfig::default());
        }
    };

    if value.get("v").and_then(|v| v.as_u64()) == Some(2) {
        let env: secret::Envelope = serde_json::from_value(value)
            .map_err(|e| GenError::storage(format!("配置信封损坏: {e}")))?;
        let key = secret::master_key(&dir).map_err(GenError::storage)?;
        let plain = secret::open(&key, &env).map_err(GenError::storage)?;
        let parsed: serde_json::Value = serde_json::from_slice(&plain)
            .map_err(|e| GenError::storage(format!("解析配置失败: {e}")))?;
        return config_from_value(&parsed);
    }

    // 旧版明文：读出后立刻改写为加密信封，明文随即被覆盖消失
    let cfg = config_from_value(&value)?;
    let has_secret = cfg.providers.iter().any(|p| !p.api_key.is_empty());
    if has_secret {
        save_config(&cfg)?;
    }
    Ok(cfg)
}

/// 端点形状校验：必须 https（本地 mock 例外）
pub fn validate_base_url(base_url: &str) -> Result<(), GenError> {
    if base_url.trim().is_empty() {
        return Err(GenError::new(code::NO_CONFIG, "尚未配置 Base URL"));
    }
    let low = base_url.trim().to_ascii_lowercase();
    let is_https = low.starts_with("https://");
    // mock 上游与本地联调用 http://localhost / 127.0.0.1
    let is_loopback = ["http://localhost", "http://127.0.0.1", "http://[::1]"]
        .iter()
        .any(|p| low.starts_with(p));
    if !is_https && !is_loopback {
        return Err(GenError::new(
            code::INVALID_PARAM,
            "Base URL 必须使用 https（本地联调可用 http://localhost）",
        ));
    }
    Ok(())
}

/// 配置校验：缺 key / 非 https 直接短路，不打上游（03 §7 NO_CONFIG、04 §3 传输安全）
pub fn validate_config(cfg: &ApiConfig) -> Result<(), GenError> {
    validate_base_url(&cfg.base_url)?;
    if cfg.api_key.trim().is_empty() {
        return Err(GenError::no_config());
    }
    Ok(())
}

/// 拉取上游模型清单：既是连通性校验（02 §9），也是模型白名单来源（B4）
pub async fn probe_models(
    client: &Client,
    config: &ApiConfig,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<Vec<String>, GenError> {
    validate_config(config)?;
    let url = format!("{}/models", config.base_url.trim_end_matches('/'));
    let resp = race(
        cancel,
        client
            .get(&url)
            .timeout(timeout)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .send(),
    )
    .await?
    .map_err(GenError::from_reqwest)?;
    let json = ensure_success(resp, cancel, config).await?;
    let items: Vec<serde_json::Value> = json
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| json.as_array())
        .cloned()
        .unwrap_or_default();
    let mut ids: Vec<String> = items
        .iter()
        .filter_map(|m| {
            m.get("id")
                .or_else(|| m.get("model"))
                .and_then(|i| i.as_str())
                .map(str::to_string)
        })
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn check_prompt(prompt: &str) -> Result<(), GenError> {
    let chars = prompt.chars().count();
    if chars == 0 {
        return Err(GenError::new(code::INVALID_PARAM, "提示词不能为空"));
    }
    if chars > MAX_PROMPT_CHARS {
        return Err(GenError::new(
            code::INVALID_PARAM,
            format!("提示词过长（{chars} 字），请精简到 {MAX_PROMPT_CHARS} 字以内"),
        ));
    }
    Ok(())
}

/// 尺寸必须是 `宽x高`（纯数字），否则回退默认值。
fn normalize_size(size: Option<&str>) -> String {
    const DEFAULT: &str = "1024x1024";
    let Some(s) = size.map(str::trim).filter(|s| !s.is_empty()) else {
        return DEFAULT.to_string();
    };
    let mut parts = s.split('x');
    let (Some(w), Some(h), None) = (parts.next(), parts.next(), parts.next()) else {
        return DEFAULT.to_string();
    };
    let ok = [w, h]
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if ok {
        s.to_string()
    } else {
        DEFAULT.to_string()
    }
}

/// 取消优先的执行：future 被 drop 即中止上游请求并释放连接。
async fn race<T, F: Future<Output = T>>(cancel: &CancellationToken, fut: F) -> Result<T, GenError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(GenError::cancelled()),
        r = fut => Ok(r),
    }
}

fn backoff(attempt: u32) -> Duration {
    let exp = BACKOFF_BASE_MS.saturating_mul(1u64 << attempt.min(5));
    let mut jitter = [0u8; 2];
    let _ = getrandom::getrandom(&mut jitter);
    Duration::from_millis(exp + u64::from(u16::from_be_bytes(jitter)) % 200)
}

/// 仅对未产生计费的失败自动重试（RATE_LIMIT / TIMEOUT / NETWORK）。
async fn retry_on<T, F, Fut>(cancel: &CancellationToken, f: &mut F) -> Result<T, GenError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, GenError>>,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if auto_retryable(&e) && attempt < MAX_RETRIES => {
                attempt += 1;
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(GenError::cancelled()),
                    _ = tokio::time::sleep(backoff(attempt)) => {}
                }
            }
            Err(e) => return Err(e),
        }
    }
}

/// 统一处理非 2xx：只取状态码，body 仅用于识别审核拒绝，不入错误消息。
async fn ensure_success(
    resp: reqwest::Response,
    cancel: &CancellationToken,
    cfg: &ApiConfig,
) -> Result<serde_json::Value, GenError> {
    let status = resp.status().as_u16();
    if (200..300).contains(&status) {
        let json = race(cancel, resp.json::<serde_json::Value>())
            .await?
            .map_err(|_| GenError::parse("上游"))?;
        return Ok(json);
    }
    let body = race(cancel, resp.text()).await?.unwrap_or_default();
    let err = GenError::from_status(status, &body);
    // 二次兜底：即使映射文案不含 key，也统一过一遍脱敏
    Err(GenError {
        message: GenError::scrub(&err.message, &[&cfg.api_key]),
        ..err
    })
}

/// 调用AI图片生成API（OpenAI兼容格式）
/// 发送 POST {base_url}/images/generations
// 参数即 03 §2.1/§7 与 T-B1 要求的图片请求全集，拆开反而要再组装一次
#[allow(clippy::too_many_arguments)]
pub async fn generate_image_api(
    client: &Client,
    config: &ApiConfig,
    prompt: &str,
    count: u32,
    model: Option<&str>,
    size: Option<&str>,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<Vec<String>, GenError> {
    validate_config(config)?;
    check_prompt(prompt)?;
    if count == 0 || count > MAX_IMAGE_COUNT {
        return Err(GenError::new(
            code::INVALID_PARAM,
            format!("生成数量需在 1..={MAX_IMAGE_COUNT} 之间"),
        ));
    }

    let mut body = serde_json::json!({
        "prompt": prompt,
        "n": count,
        "size": normalize_size(size),
    });
    // 仅在用户显式选择时下发 model：部分兼容端点会拒绝缺省 model
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        body["model"] = serde_json::Value::String(m.to_string());
    }

    let url = format!(
        "{}/images/generations",
        config.base_url.trim_end_matches('/')
    );
    let resp_json = retry_on(cancel, &mut || {
        image_once(client, config, &url, &body, cancel, timeout)
    })
    .await?;

    let mut urls = Vec::new();
    if let Some(data) = resp_json.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(u) = item.get("url").and_then(|u| u.as_str()) {
                urls.push(u.to_string());
            } else if let Some(b64) = item.get("b64_json").and_then(|u| u.as_str()) {
                urls.push(format!("data:image/png;base64,{}", b64));
            }
        }
    }

    if urls.is_empty() {
        return Err(GenError::parse("图片接口"));
    }

    Ok(urls)
}

async fn image_once(
    client: &Client,
    config: &ApiConfig,
    url: &str,
    body: &serde_json::Value,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<serde_json::Value, GenError> {
    let resp = race(
        cancel,
        client
            .post(url)
            .timeout(timeout)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .json(body)
            .send(),
    )
    .await?
    .map_err(GenError::from_reqwest)?;
    ensure_success(resp, cancel, config).await
}

/// 文本生成的可调用参数（03 §4：不再写死 temperature / system）
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TextOptions {
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

pub const DEFAULT_TEMPERATURE: f64 = 0.7;
pub const MAX_TEMPERATURE: f64 = 2.0;
/// 04 §8.1：输出长度硬上限，避免一次生成打爆额度
pub const MAX_OUTPUT_TOKENS: u32 = 8_000;
pub const MAX_SYSTEM_CHARS: usize = 4_000;

impl TextOptions {
    /// 越界不报错而是收敛到合法区间：这些是成本/风格参数，用户填错不该让生成失败
    pub fn normalized(&self) -> Result<Self, GenError> {
        if let Some(s) = &self.system {
            if s.chars().count() > MAX_SYSTEM_CHARS {
                return Err(GenError::new(
                    code::INVALID_PARAM,
                    format!(
                        "系统提示过长（{} 字），上限 {MAX_SYSTEM_CHARS}",
                        s.chars().count()
                    ),
                ));
            }
        }
        Ok(Self {
            system: self
                .system
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            temperature: Some(
                self.temperature
                    .unwrap_or(DEFAULT_TEMPERATURE)
                    .clamp(0.0, MAX_TEMPERATURE),
            ),
            max_tokens: Some(self.max_tokens.unwrap_or(0).min(MAX_OUTPUT_TOKENS)),
        })
    }

    fn messages(&self, prompt: &str) -> Vec<serde_json::Value> {
        let mut msgs = Vec::new();
        if let Some(s) = &self.system {
            msgs.push(serde_json::json!({"role": "system", "content": s}));
        }
        msgs.push(serde_json::json!({"role": "user", "content": prompt}));
        msgs
    }

    fn body(&self, model: &str, prompt: &str, stream: bool) -> serde_json::Value {
        let mut body = serde_json::json!({
            "model": model,
            "messages": self.messages(prompt),
            "temperature": self.temperature.unwrap_or(DEFAULT_TEMPERATURE),
        });
        if let Some(n) = self.max_tokens.filter(|n| *n > 0) {
            body["max_tokens"] = serde_json::json!(n);
        }
        if stream {
            body["stream"] = serde_json::Value::Bool(true);
        }
        body
    }
}

/// 调用AI文本生成API（OpenAI兼容格式）
/// 发送 POST {base_url}/chat/completions
pub async fn generate_text_api(
    client: &Client,
    config: &ApiConfig,
    prompt: &str,
    model: &str,
    opts: &TextOptions,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<(String, Option<crate::history::Usage>), GenError> {
    validate_config(config)?;
    check_prompt(prompt)?;
    let opts = opts.normalized()?;

    let body = opts.body(model, prompt, false);
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let resp_json = retry_on(cancel, &mut || {
        text_once(client, config, &url, &body, cancel, timeout)
    })
    .await?;

    let content = resp_json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| GenError::parse("文本接口"))?;

    // 04 §8.3：把上游返回的用量带回去入库
    let usage = resp_json
        .get("usage")
        .and_then(|u| serde_json::from_value::<crate::history::Usage>(u.clone()).ok());
    Ok((content.to_string(), usage))
}

async fn text_once(
    client: &Client,
    config: &ApiConfig,
    url: &str,
    body: &serde_json::Value,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<serde_json::Value, GenError> {
    let resp = race(
        cancel,
        client
            .post(url)
            .timeout(timeout)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .json(body)
            .send(),
    )
    .await?
    .map_err(GenError::from_reqwest)?;
    ensure_success(resp, cancel, config).await
}

/// 调用AI视频生成API
/// 兼容多种视频生成服务的接口格式
pub async fn generate_video_api(
    client: &Client,
    config: &ApiConfig,
    prompt: &str,
    duration: &str,
    resolution: &str,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<String, GenError> {
    validate_config(config)?;
    check_prompt(prompt)?;

    // 视频生成接口格式因服务商而异,这里采用通用 task 提交模式
    // 先提交任务,轮询状态,返回视频URL
    let body = serde_json::json!({
        "prompt": prompt,
        "duration": duration.parse::<u32>().unwrap_or(5),
        "resolution": resolution,
    });

    let url = format!(
        "{}/video/generations",
        config.base_url.trim_end_matches('/')
    );
    let resp_json = retry_on(cancel, &mut || {
        video_once(client, config, &url, &body, cancel, timeout)
    })
    .await?;

    // 尝试多种常见响应格式
    if let Some(u) = resp_json.get("url").and_then(|u| u.as_str()) {
        return Ok(u.to_string());
    }
    if let Some(data) = resp_json.get("data") {
        if let Some(u) = data.get("url").and_then(|u| u.as_str()) {
            return Ok(u.to_string());
        }
        if let Some(video) = data.get("video").and_then(|v| v.as_str()) {
            return Ok(video.to_string());
        }
    }
    if let Some(task_id) = resp_json.get("task_id").and_then(|t| t.as_str()) {
        // 异步任务模式:返回一个占位 URL,实际应轮询 task 状态（T-B2，阶段四）
        // 简化处理:直接返回 task_id 作为标识,前端显示"任务已提交"
        return Ok(format!("task:{}", task_id));
    }

    Err(GenError::parse("视频接口"))
}

async fn video_once(
    client: &Client,
    config: &ApiConfig,
    url: &str,
    body: &serde_json::Value,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<serde_json::Value, GenError> {
    let resp = race(
        cancel,
        client
            .post(url)
            .timeout(timeout)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .json(body)
            .send(),
    )
    .await?
    .map_err(GenError::from_reqwest)?;
    ensure_success(resp, cancel, config).await
}

/// 拉取远端结果并落盘（03 §6：结果改为文件引用）。仅允许 http/https，且有体积上限。
///
/// 注意：**不带 Authorization 头**。结果 URL 通常是与 API 端点不同域的 CDN，
/// 把 provider key 发给它会构成密钥外流。
pub async fn fetch_bytes(
    client: &Client,
    url: &str,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<Vec<u8>, GenError> {
    let low = url.to_ascii_lowercase();
    if !low.starts_with("https://") && !low.starts_with("http://") {
        return Err(GenError::new(
            crate::error::code::PARSE,
            "结果地址不是 http(s)，已跳过留存",
        ));
    }
    let resp = race(cancel, client.get(url).timeout(timeout).send())
        .await?
        .map_err(GenError::from_reqwest)?;
    if !resp.status().is_success() {
        return Err(GenError::from_status(resp.status().as_u16(), ""));
    }
    let bytes = race(cancel, resp.bytes())
        .await?
        .map_err(GenError::from_reqwest)?;
    if bytes.len() > crate::history::MAX_RESULT_BYTES {
        return Err(GenError::new(
            crate::error::code::PARSE,
            format!("结果文件过大（{} 字节），未落盘", bytes.len()),
        ));
    }
    Ok(bytes.to_vec())
}

/// 流式请求的总时长上限：比整段返回宽松，因为逐字推送本身耗时。
pub const STREAM_TIMEOUT: Duration = Duration::from_secs(300);

/// 文本流式生成（03 §2.2，T-Stream）。
///
/// `on_event` 每收到一个增量就被调用一次；返回值为累积全文（供历史与最终展示）。
/// 上游若无视 `stream:true` 直接回整段 JSON，则降级为一次性交付，不向用户报错。
pub async fn generate_text_stream_api<E>(
    client: &Client,
    config: &ApiConfig,
    prompt: &str,
    model: &str,
    opts: &TextOptions,
    cancel: &CancellationToken,
    mut on_event: E,
) -> Result<(String, Option<crate::history::Usage>), GenError>
where
    E: FnMut(crate::stream::StreamEvent),
{
    use crate::stream::{parse_chunk, SseItem, StreamEvent};
    use futures_util::StreamExt;

    validate_config(config)?;
    check_prompt(prompt)?;
    let opts = opts.normalized()?;

    let body = opts.body(model, prompt, true);
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let resp = race(
        cancel,
        client
            .post(&url)
            .timeout(STREAM_TIMEOUT)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Accept", "text/event-stream")
            .header("Content-Type", "application/json")
            .json(&body)
            .send(),
    )
    .await?
    .map_err(GenError::from_reqwest)?;

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = race(cancel, resp.text()).await?.unwrap_or_default();
        let err = GenError::from_status(status, &text);
        return Err(GenError {
            message: GenError::scrub(&err.message, &[&config.api_key]),
            ..err
        });
    }

    let mut stream = resp.bytes_stream();
    let mut parser = crate::stream::SseParser::default();
    let mut acc = String::new();
    let mut usage = None;
    let mut saw_frame = false;
    let mut done_seen = false;
    let mut raw_head: Vec<u8> = Vec::new();

    loop {
        let item = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(GenError::cancelled()),
            next = stream.next() => next,
        };
        match item {
            None => break,
            Some(Err(e)) => return Err(GenError::from_reqwest(e)),
            Some(Ok(bytes)) => {
                if raw_head.len() < 64 * 1024 {
                    raw_head.extend_from_slice(&bytes);
                }
                for frame in parser.push(&bytes) {
                    match frame {
                        SseItem::Data(payload) => {
                            saw_frame = true;
                            if let Ok(chunk) = parse_chunk(&payload) {
                                if !chunk.text.is_empty() {
                                    acc.push_str(&chunk.text);
                                    on_event(StreamEvent::delta(chunk.text));
                                }
                                if chunk.usage.is_some() {
                                    usage = chunk.usage;
                                }
                            }
                        }
                        SseItem::Done => {
                            saw_frame = true;
                            done_seen = true;
                            break;
                        }
                    }
                }
                // 收到 [DONE] 就停止读取，尽早释放连接
                if done_seen {
                    break;
                }
            }
        }
    }

    for frame in parser.finish() {
        if let SseItem::Data(payload) = frame {
            if let Ok(chunk) = parse_chunk(&payload) {
                if !chunk.text.is_empty() {
                    acc.push_str(&chunk.text);
                    on_event(StreamEvent::delta(chunk.text));
                }
                if chunk.usage.is_some() {
                    usage = chunk.usage;
                }
            }
        }
    }

    // 降级：上游没按 SSE 回，而是给了整段 JSON
    if !saw_frame && acc.is_empty() {
        let text = String::from_utf8_lossy(&raw_head).to_string();
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(text.trim()) {
            if let Some(content) = json
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            {
                acc = content.to_string();
                on_event(StreamEvent::delta(acc.clone()));
            }
        }
    }

    if acc.is_empty() {
        return Err(GenError::parse("文本流"));
    }
    on_event(StreamEvent::done(usage.clone()));
    Ok((acc, usage))
}

/// 视频异步任务的轮询间隔与总预算（02 §2.3 / T-B2）。
/// 总预算默认 5 分钟，超时归一为 TIMEOUT 交给用户重试。
pub const VIDEO_POLL_INTERVAL: Duration = Duration::from_secs(3);
pub const VIDEO_POLL_BUDGET: Duration = Duration::from_secs(300);

/// 各家服务商的任务查询端点形状不统一（06 §6 R1 / H4 未核对），
/// 这里按候选路径依次尝试，命中即锁定，避免整轮轮询都打在同一个错路径上。
const TASK_ENDPOINTS: [&str; 3] = [
    "/video/generations/{task}",
    "/video/tasks/{task}",
    "/tasks/{task}",
];

/// 从任务查询响应里抽结果 URL 或失败原因
#[derive(Debug)]
pub enum TaskOutcome {
    Ready(String),
    Running { status: String },
    Failed(String),
}

/// 解析任务查询响应（纯函数，便于按真实样本补测试）
pub fn parse_task_response(json: &serde_json::Value) -> TaskOutcome {
    let status = ["status", "state", "task_status"]
        .iter()
        .filter_map(|k| json.get(*k).and_then(|v| v.as_str()))
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    let find_url = |v: &serde_json::Value| -> Option<String> {
        [
            v.get("url").and_then(|u| u.as_str()),
            v.get("video_url").and_then(|u| u.as_str()),
            v.get("output")
                .and_then(|o| o.get("video_url").or_else(|| o.get("url")))
                .and_then(|u| u.as_str()),
            v.get("data")
                .and_then(|d| d.get("url").or_else(|| d.get("video_url")))
                .and_then(|u| u.as_str()),
            v.get("data")
                .and_then(|d| d.get(0))
                .and_then(|d| d.get("url"))
                .and_then(|u| u.as_str()),
        ]
        .into_iter()
        .flatten()
        .map(str::to_string)
        .find(|s| !s.is_empty())
    };

    if let Some(u) = find_url(json) {
        return TaskOutcome::Ready(u);
    }
    if matches!(
        status.as_str(),
        "failed" | "error" | "cancelled" | "canceled" | "timeout" | "expired"
    ) {
        // 错误描述可能带上游原文，统一走脱敏
        let reason = ["error_message", "fail_reason", "message", "error"]
            .iter()
            .filter_map(|k| json.get(*k).and_then(|v| v.as_str()))
            .next()
            .unwrap_or("上游未给出原因");
        return TaskOutcome::Failed(reason.to_string());
    }
    TaskOutcome::Running {
        status: if status.is_empty() {
            "unknown".to_string()
        } else {
            status
        },
    }
}

/// 轮询视频任务直到拿到真实 URL（T-B2）。取消与预算都会及时退出。
pub async fn poll_video_task<P>(
    client: &Client,
    config: &ApiConfig,
    task_id: &str,
    cancel: &CancellationToken,
    interval: Duration,
    budget: Duration,
    mut on_progress: P,
) -> Result<String, GenError>
where
    P: FnMut(u64, &str),
{
    validate_config(config)?;
    let task_id = task_id.trim().trim_start_matches("task:");
    if task_id.is_empty() {
        return Err(GenError::new(
            code::INVALID_PARAM,
            "缺少任务号，无法查询进度",
        ));
    }

    let started = std::time::Instant::now();
    let mut endpoint_idx = 0usize;
    let mut attempts = 0u32;

    loop {
        if started.elapsed() > budget {
            return Err(GenError::new(
                code::TIMEOUT,
                format!("视频任务 {task_id} 在预算内仍未出片，可稍后重试查询"),
            )
            .retryable());
        }
        attempts += 1;
        let template = TASK_ENDPOINTS
            .get(endpoint_idx)
            .copied()
            .unwrap_or(TASK_ENDPOINTS[0]);
        let url = format!(
            "{}{}",
            config.base_url.trim_end_matches('/'),
            template.replace("{task}", task_id)
        );
        let resp = race(
            cancel,
            client
                .get(&url)
                .timeout(VIDEO_TIMEOUT)
                .header("Authorization", format!("Bearer {}", config.api_key))
                .send(),
        )
        .await?
        .map_err(GenError::from_reqwest)?;

        let status = resp.status().as_u16();
        if status == 404 && endpoint_idx + 1 < TASK_ENDPOINTS.len() {
            // 换下一个候选端点形状，不算失败
            endpoint_idx += 1;
            continue;
        }
        let json = ensure_success(resp, cancel, config).await?;
        match parse_task_response(&json) {
            TaskOutcome::Ready(u) => {
                on_progress(100, "已完成");
                return Ok(u);
            }
            TaskOutcome::Failed(reason) => {
                let e = GenError::from_status(500, &reason);
                return Err(GenError {
                    code: if reason.to_ascii_lowercase().contains("policy") {
                        code::CONTENT_POLICY.to_string()
                    } else {
                        e.code
                    },
                    ..e
                });
            }
            TaskOutcome::Running { status } => {
                let pct = (attempts as u64 * 8).min(95);
                on_progress(pct, &status);
            }
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(GenError::cancelled()),
            _ = tokio::time::sleep(interval) => {}
        }
    }
}

/// PPT大纲条目(从前端传入)
#[derive(Debug, Clone, Deserialize)]
pub struct PptOutlineItem {
    pub title: String,
    pub content: String,
}

/// PPT单页内容
struct PptSlide {
    title: String,
    content: String,
}

/// PPT 生成入参
#[derive(Debug, Clone, Deserialize)]
pub struct PptRequest {
    pub topic: String,
    pub template: String,
    pub slides: u32,
    pub outline: Vec<PptOutlineItem>,
}

/// 生成PPT文件: 调用AI生成大纲内容,然后写入本地HTML格式的PPT文件
///
/// 产物落在数据目录 `results/`（不再是会被系统清理的 temp 目录，B3 的一半），
/// 返回（绝对路径, 历史引用相对路径）。
pub async fn generate_ppt_file(
    client: &Client,
    config: &ApiConfig,
    id: &str,
    req: &PptRequest,
    outline_model: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(String, String), GenError> {
    let PptRequest {
        topic,
        template,
        slides,
        outline,
    } = req;
    let slides = *slides;
    let topic = topic.as_str();
    let template = template.as_str();
    validate_config(config)?;
    if topic.trim().is_empty() {
        return Err(GenError::new(code::INVALID_PARAM, "PPT 主题不能为空"));
    }
    let slides = slides.clamp(1, 50);

    // 第一步: 用AI生成每页的详细内容(如果大纲为空或不足)
    let mut slides_content: Vec<PptSlide> = Vec::new();

    if outline.is_empty() {
        // 大纲为空,让AI生成
        let prompt = format!(
            "请为主题「{}」生成{}页PPT大纲。要求:\n\
            - 每页包含标题和3-5个要点\n\
            - 第一页是封面\n\
            - 最后一页是总结\n\
            - 输出JSON格式: {{\"slides\":[{{\"title\":\"标题\",\"content\":\"要点1\\n要点2\"}}]}}",
            topic, slides
        );
        let outline_model = outline_model.unwrap_or("gpt-4o-mini");
        let (content, _usage) = generate_text_api(
            client,
            config,
            &prompt,
            outline_model,
            &TextOptions::default(),
            cancel,
            TEXT_TIMEOUT,
        )
        .await?;
        // 尝试解析JSON,失败则降级为简单文本
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(arr) = parsed.get("slides").and_then(|s| s.as_array()) {
                for slide in arr {
                    let title = slide
                        .get("title")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    let content = slide
                        .get("content")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                    slides_content.push(PptSlide { title, content });
                }
            }
        }
        if slides_content.is_empty() {
            // 降级:创建基本结构
            slides_content.push(PptSlide {
                title: topic.to_string(),
                content: "".to_string(),
            });
            for i in 1..slides {
                slides_content.push(PptSlide {
                    title: format!("第 {} 页", i),
                    content: "（待补充内容）".to_string(),
                });
            }
            slides_content.push(PptSlide {
                title: "谢谢观看".to_string(),
                content: "".to_string(),
            });
        }
    } else {
        // 使用用户提供的大纲
        for item in outline {
            slides_content.push(PptSlide {
                title: item.title.clone(),
                content: item.content.clone(),
            });
        }
    }

    // 第二步: 生成 HTML 格式的 PPT 文件
    let html = render_ppt_html(topic, template, &slides_content);

    // 第三步: 原子写入数据目录 results/，历史只引用相对路径
    let rel = crate::history::save_result_bytes(id, 0, "html", html.as_bytes())?;
    let abs = crate::history::Store::resolve_ref(&rel);
    Ok((abs.to_string_lossy().to_string(), rel))
}

/// 渲染PPT为HTML格式(可浏览器直接打开)
fn render_ppt_html(topic: &str, template: &str, slides: &[PptSlide]) -> String {
    let (bg_color, accent_color, text_color) = match template {
        "tech" => ("#0a1929", "#1677ff", "#ffffff"),
        "creative" => ("#fff0f6", "#eb2f96", "#333333"),
        "academic" => ("#fafafa", "#531dab", "#222222"),
        _ => ("#ffffff", "#1677ff", "#333333"), // business
    };

    let slides_html: String = slides
        .iter()
        .enumerate()
        .map(|(i, slide)| {
            let content_lines: String = slide
                .content
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| format!("<li>{}</li>", html_escape(l)))
                .collect();
            let is_cover = i == 0;
            let is_end = i == slides.len() - 1;
            let slide_class = if is_cover {
                "slide cover"
            } else if is_end {
                "slide end"
            } else {
                "slide"
            };
            format!(
                r#"<section class="{}"><div class="slide-content">{}</div></section>"#,
                slide_class,
                if is_cover || is_end {
                    format!("<h1>{}</h1>", html_escape(&slide.title))
                } else {
                    format!(
                        "<h2>{}</h2><ul>{}</ul>",
                        html_escape(&slide.title),
                        content_lines
                    )
                }
            )
        })
        .collect();

    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{topic}</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; background: #222; }}
.slide {{
  width: 100vw; height: 100vh; min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  background: {bg}; color: {text};
  border-bottom: 1px solid rgba(0,0,0,0.1);
  padding: 60px;
}}
.slide.cover {{ background: linear-gradient(135deg, {bg} 0%, {accent} 100%); color: #fff; }}
.slide.end {{ background: linear-gradient(135deg, {accent} 0%, {bg} 100%); color: #fff; }}
.slide-content {{ max-width: 960px; width: 100%; }}
h1 {{ font-size: 56px; font-weight: 700; text-align: center; }}
h2 {{ font-size: 36px; font-weight: 600; margin-bottom: 32px; color: {accent}; border-bottom: 3px solid {accent}; padding-bottom: 12px; }}
ul {{ list-style: none; }}
li {{ font-size: 22px; line-height: 1.8; padding: 8px 0 8px 32px; position: relative; }}
li::before {{ content: "▸"; position: absolute; left: 0; color: {accent}; }}
@media print {{
  .slide {{ page-break-after: always; }}
}}
</style>
</head>
<body>
{slides_html}
</body>
</html>"#,
        topic = html_escape(topic),
        bg = bg_color,
        accent = accent_color,
        text = text_color,
        slides_html = slides_html,
    )
}

/// HTML转义
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // 测试用宽松超时，避免单测等满 120s 默认值
    const FAST: Duration = Duration::from_secs(5);

    /// 所有测试都指向临时目录与 mock 上游，绝不触碰真实密钥或付费端点（06 §8 R8）。
    /// sandbox 必须共用进程级锁，见 `secret::test_sandbox`。
    use crate::secret::test_sandbox::Sandbox;

    fn cfg(base_url: &str) -> ApiConfig {
        ApiConfig {
            base_url: base_url.into(),
            api_key: "sk-TEST-abcdef123456".into(),
        }
    }

    /// mock 上游的 base_url：与真实 OpenAI 兼容端点一样带 `/v1` 后缀
    fn mock_cfg(server: &MockServer) -> ApiConfig {
        cfg(&format!("{}/v1", server.uri()))
    }

    fn token() -> Arc<CancellationToken> {
        Arc::new(CancellationToken::new())
    }

    #[allow(clippy::too_many_arguments)]
    async fn gen_text_opts(
        client: &Client,
        config: &ApiConfig,
        prompt: &str,
        model: &str,
        opts: &TextOptions,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, GenError> {
        let (text, _) =
            generate_text_api(client, config, prompt, model, opts, cancel, timeout).await?;
        Ok(text)
    }

    /// 默认参数包装：多数测试不关心 system/temperature/max_tokens
    fn nopts() -> TextOptions {
        TextOptions::default()
    }

    #[allow(clippy::too_many_arguments)]
    async fn gen_text(
        client: &Client,
        config: &ApiConfig,
        prompt: &str,
        model: &str,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, GenError> {
        let (text, _) =
            generate_text_api(client, config, prompt, model, &nopts(), cancel, timeout).await?;
        Ok(text)
    }

    #[allow(clippy::too_many_arguments)]
    async fn gen_stream<E: FnMut(crate::stream::StreamEvent)>(
        client: &Client,
        config: &ApiConfig,
        prompt: &str,
        model: &str,
        cancel: &CancellationToken,
        on_event: E,
    ) -> Result<String, GenError> {
        let (text, _) =
            generate_text_stream_api(client, config, prompt, model, &nopts(), cancel, on_event)
                .await?;
        Ok(text)
    }

    /// 验收 #8：图片请求体必须带 model + size
    #[tokio::test]
    async fn image_request_body_carries_model_and_size() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data":[{"url":"https://cdn/x.png"}]})),
            )
            .mount(&server)
            .await;

        let urls = generate_image_api(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "一只橘猫",
            2,
            Some("dall-e-3"),
            Some("1792x1024"),
            &token(),
            FAST,
        )
        .await
        .unwrap();
        assert_eq!(urls, vec!["https://cdn/x.png".to_string()]);

        let req = server.received_requests().await.unwrap().remove(0);
        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["model"], "dall-e-3");
        assert_eq!(body["size"], "1792x1024");
        assert_eq!(body["n"], 2);
        assert_eq!(body["prompt"], "一只橘猫");
        assert_eq!(req.method.as_str(), "POST");
    }

    #[tokio::test]
    async fn image_size_falls_back_when_malformed() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data":[{"b64_json":"AA=="}]})),
            )
            .mount(&server)
            .await;

        let urls = generate_image_api(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "p",
            1,
            None,
            Some("../../etc/passwd"),
            &token(),
            FAST,
        )
        .await
        .unwrap();
        assert!(urls[0].starts_with("data:image/png;base64,"));

        let req = server.received_requests().await.unwrap().remove(0);
        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["size"], "1024x1024");
        assert!(body.get("model").is_none(), "未选择 model 时不应下发该字段");
    }

    #[tokio::test]
    async fn b64_only_response_parses() {
        let _sb = Sandbox::new();
        assert_eq!(normalize_size(Some("512x512")), "512x512");
        assert_eq!(normalize_size(Some("1024x1024x1024")), "1024x1024");
        assert_eq!(normalize_size(Some("big")), "1024x1024");
        assert_eq!(normalize_size(None), "1024x1024");
    }

    /// 验收 #1/#3：超时按 connect_timeout 量级返回 TIMEOUT
    #[tokio::test]
    async fn slow_upstream_times_out_as_timeout_code() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(30))
                    .set_body_json(serde_json::json!({"choices":[]})),
            )
            .mount(&server)
            .await;

        // 请求级超时 120ms 必须生效（验收 #1：外部请求 100% 带 timeout）；
        // TIMEOUT 属自动重试码，重试耗尽后仍归一为 TIMEOUT
        let client = build_client(FAST);
        let started = Instant::now();
        let err = gen_text(
            &client,
            &mock_cfg(&server),
            "hi",
            "gpt-4o-mini",
            &token(),
            Duration::from_millis(120),
        )
        .await
        .expect_err("must fail");
        assert_eq!(err.code, code::TIMEOUT);
        assert!(err.retryable);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "elapsed {:?}",
            started.elapsed()
        );
    }

    /// 验收 #2：取消立即返回 CANCELLED，不再等上游
    #[tokio::test]
    async fn cancel_short_circuits_long_request() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(20))
                    .set_body_json(serde_json::json!({"data":[]})),
            )
            .mount(&server)
            .await;

        let tok = token();
        let client = build_client(TEXT_TIMEOUT);
        let cfg = mock_cfg(&server);
        let cancel = tok.clone();
        let handle = tokio::spawn(async move {
            generate_image_api(
                &client,
                &cfg,
                "p",
                1,
                Some("m"),
                Some("1024x1024"),
                &cancel,
                FAST,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(120)).await;
        let at = Instant::now();
        tok.cancel();
        let err = handle.await.unwrap().expect_err("must be cancelled");
        assert_eq!(err.code, code::CANCELLED);
        assert!(
            at.elapsed() < Duration::from_secs(2),
            "取消未及时返回: {:?}",
            at.elapsed()
        );
    }

    /// 验收 #4：注入一次 429 后退避重试并成功
    #[tokio::test]
    async fn rate_limit_retries_then_succeeds() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_string("too many requests"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "ok after retry"}}]
            })))
            .mount(&server)
            .await;

        let out = gen_text(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "hi",
            "gpt-4o-mini",
            &token(),
            FAST,
        )
        .await
        .unwrap();
        assert_eq!(out, "ok after retry");
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    /// 5xx 不自动重试（04 §8.4 避免重复计费），但标记可重试交由用户决定
    #[tokio::test]
    async fn server_error_is_not_auto_retried() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
            .mount(&server)
            .await;

        let err = gen_text(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "hi",
            "gpt-4o",
            &token(),
            FAST,
        )
        .await
        .expect_err("must fail");
        assert_eq!(err.code, code::UPSTREAM_5XX);
        assert!(err.retryable);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    /// 验收 #9：错误消息 0 次出现 key / Authorization
    #[tokio::test]
    async fn auth_failure_message_is_sanitized() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        let leaky_body = r#"{"error":{"message":"Invalid api_key Bearer sk-TEST-abcdef123456 provided to sk-TEST-abcdef123456"}}"#;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string(leaky_body))
            .mount(&server)
            .await;

        let c = mock_cfg(&server);
        let err = gen_text(&build_client(TEXT_TIMEOUT), &c, "hi", "m", &token(), FAST)
            .await
            .expect_err("must fail");
        assert_eq!(err.code, code::AUTH);
        assert!(!err.retryable);
        assert!(
            !err.message.contains("sk-TEST"),
            "泄漏密钥: {}",
            err.message
        );
        assert!(!err.message.contains("abcdef"), "泄漏密钥: {}", err.message);
        assert!(!err.message.contains("Bearer"));
    }

    #[tokio::test]
    async fn content_policy_maps_to_non_retryable() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_string("Your prompt was flagged by our content policy."),
            )
            .mount(&server)
            .await;

        let err = generate_image_api(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "x",
            1,
            None,
            None,
            &token(),
            FAST,
        )
        .await
        .expect_err("must fail");
        assert_eq!(err.code, code::CONTENT_POLICY);
        assert!(!err.retryable);
    }

    #[tokio::test]
    async fn missing_key_never_hits_upstream() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut c = mock_cfg(&server);
        c.api_key = "  ".into();
        let err = gen_text(&build_client(TEXT_TIMEOUT), &c, "hi", "m", &token(), FAST)
            .await
            .expect_err("must fail");
        assert_eq!(err.code, code::NO_CONFIG);
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn plaintext_http_base_url_is_rejected() {
        let _sb = Sandbox::new();
        let c = cfg("http://example.com/v1");
        let err = validate_config(&c).expect_err("must fail");
        assert_eq!(err.code, code::INVALID_PARAM);
        // 本地 mock 允许
        assert!(validate_config(&cfg("http://127.0.0.1:9999/v1")).is_ok());
        assert!(validate_config(&cfg("https://api.openai.com/v1")).is_ok());
    }

    #[tokio::test]
    async fn oversized_prompt_is_rejected() {
        let _sb = Sandbox::new();
        let c = cfg("https://api.x/v1");
        let long = "字".repeat(MAX_PROMPT_CHARS + 1);
        let err = gen_text(&build_client(TEXT_TIMEOUT), &c, &long, "m", &token(), FAST)
            .await
            .expect_err("must fail");
        assert_eq!(err.code, code::INVALID_PARAM);
    }

    #[tokio::test]
    async fn malformed_success_body_is_parse_error() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>not json</html>"))
            .mount(&server)
            .await;
        let err = generate_image_api(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "x",
            1,
            None,
            None,
            &token(),
            FAST,
        )
        .await
        .expect_err("must fail");
        assert_eq!(err.code, code::PARSE);
    }

    /// 03 §4：参数不再写死；越界值收敛（04 §8.1 参数上限）
    #[test]
    fn text_options_clamp_and_shape_request() {
        let opts = TextOptions {
            system: Some("  ".into()),
            temperature: Some(9.0),
            max_tokens: Some(999_999),
        }
        .normalized()
        .unwrap();
        assert_eq!(opts.system, None, "空白 system 不应进 messages");
        assert_eq!(opts.temperature, Some(MAX_TEMPERATURE));
        assert_eq!(opts.max_tokens, Some(MAX_OUTPUT_TOKENS));

        let body = opts.body("gpt-4o", "hi", true);
        assert_eq!(body["stream"], true);
        assert_eq!(body["temperature"], MAX_TEMPERATURE);
        assert_eq!(body["max_tokens"], MAX_OUTPUT_TOKENS as u64);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1, "空白 system 不该生成 system 消息");
        assert_eq!(msgs[0]["role"], "user");

        let with_system = TextOptions {
            system: Some("你是技术写手".into()),
            temperature: Some(-3.0),
            max_tokens: Some(0),
        }
        .normalized()
        .unwrap();
        assert_eq!(with_system.temperature, Some(0.0));
        let body2 = with_system.body("m", "hi", false);
        assert_eq!(body2["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body2["messages"][0]["role"], "system");
        assert_eq!(body2["messages"][0]["content"], "你是技术写手");
        assert!(body2.get("max_tokens").is_none(), "max_tokens=0 表示不下发");
        assert!(body2.get("stream").is_none());

        let defaults = TextOptions::default().normalized().unwrap();
        assert_eq!(defaults.temperature, Some(DEFAULT_TEMPERATURE));
    }

    #[test]
    fn oversized_system_prompt_is_rejected() {
        let opts = TextOptions {
            system: Some("字".repeat(MAX_SYSTEM_CHARS + 1)),
            temperature: None,
            max_tokens: None,
        };
        let err = opts.normalized().expect_err("must fail");
        assert_eq!(err.code, code::INVALID_PARAM);
        assert!(err.message.contains("系统提示过长"), "{}", err.message);
    }

    #[tokio::test]
    async fn text_request_actually_carries_system_and_params() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "ok"}}]
            })))
            .mount(&server)
            .await;
        let opts = TextOptions {
            system: Some("只回答一个字".into()),
            temperature: Some(0.2),
            max_tokens: Some(64),
        };
        gen_text_opts(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "问题",
            "gpt-4o",
            &opts,
            &token(),
            FAST,
        )
        .await
        .unwrap();
        let req = server.received_requests().await.unwrap().remove(0);
        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["messages"][0]["content"], "只回答一个字");
        assert_eq!(body["messages"][1]["content"], "问题");
        let temp = body["temperature"].as_f64().expect("temperature 应为数字");
        assert!((temp - 0.2).abs() < 1e-9, "f64 温度不应被放大: {temp}");
        assert_eq!(body["max_tokens"], 64);
    }

    #[tokio::test]
    async fn text_request_body_uses_defaults_when_opts_omitted() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "ok"}}]
            })))
            .mount(&server)
            .await;
        gen_text(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "问题",
            "gpt-4o",
            &token(),
            FAST,
        )
        .await
        .unwrap();
        let req = server.received_requests().await.unwrap().remove(0);
        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["temperature"], DEFAULT_TEMPERATURE);
        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn stream_collects_deltas_in_order() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n",
            ": keep-alive\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":9}}\n\n",
            "data: [DONE]\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse),
            )
            .mount(&server)
            .await;

        let mut events = Vec::new();
        let sink = &mut events;
        let text = gen_stream(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "hi",
            "gpt-4o-mini",
            &token(),
            |e| sink.push(e),
        )
        .await
        .unwrap();
        assert_eq!(text, "你好，世界");

        let deltas: Vec<&str> = events
            .iter()
            .filter(|e| !e.done)
            .map(|e| e.delta.as_str())
            .collect();
        assert_eq!(deltas, vec!["你好", "，世界"]);
        let last = events.last().unwrap();
        assert!(last.done, "最后必须是 done 事件");
        assert_eq!(last.usage.as_ref().map(|u| u.completion_tokens), Some(9));

        // 请求体必须带 stream:true
        let req = server.received_requests().await.unwrap().remove(0);
        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["stream"], true);
    }

    /// 降级：上游无视 stream:true 直接回整段 JSON 时不报错（03 §7 PARSE 的降级取向）
    #[tokio::test]
    async fn stream_falls_back_to_plain_json() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "非流式回包"}}]
            })))
            .mount(&server)
            .await;

        let mut events = Vec::new();
        let sink = &mut events;
        let text = gen_stream(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "hi",
            "m",
            &token(),
            |e| sink.push(e),
        )
        .await
        .unwrap();
        assert_eq!(text, "非流式回包");
        assert_eq!(events.len(), 2, "应是一次 delta + 一次 done");
        assert_eq!(events[0].delta, "非流式回包");
        assert!(events[1].done);
    }

    #[tokio::test]
    async fn stream_error_is_sanitized() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(401).set_body_string("bad key sk-TEST-abcdef123456"),
            )
            .mount(&server)
            .await;
        let c = mock_cfg(&server);
        let err = gen_stream(&build_client(TEXT_TIMEOUT), &c, "hi", "m", &token(), |_| {})
            .await
            .expect_err("must fail");
        assert_eq!(err.code, code::AUTH);
        assert!(
            !err.message.contains("sk-TEST"),
            "泄漏密钥: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn stream_cancel_midflight() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(20))
                    .set_body_string("data: [DONE]\n\n"),
            )
            .mount(&server)
            .await;

        let tok = token();
        let client = build_client(TEXT_TIMEOUT);
        let cfg = mock_cfg(&server);
        let cancel = tok.clone();
        let handle =
            tokio::spawn(
                async move { gen_stream(&client, &cfg, "hi", "m", &cancel, |_| {}).await },
            );
        tokio::time::sleep(Duration::from_millis(120)).await;
        let at = Instant::now();
        tok.cancel();
        let err = handle.await.unwrap().expect_err("must be cancelled");
        assert_eq!(err.code, code::CANCELLED);
        assert!(
            at.elapsed() < Duration::from_secs(2),
            "取消未及时: {:?}",
            at.elapsed()
        );
    }

    fn provider(id: &str, url: &str, key: &str, caps: &[&str], models: &[&str]) -> Provider {
        Provider {
            id: id.to_string(),
            name: id.to_string(),
            base_url: url.to_string(),
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            models: models.iter().map(|s| s.to_string()).collect(),
            api_key: key.to_string(),
        }
    }

    fn app_cfg(providers: Vec<Provider>, active: &[(&str, &str)]) -> AppConfig {
        let mut active_map = HashMap::new();
        for (k, v) in active {
            active_map.insert(k.to_string(), v.to_string());
        }
        let mut cfg = AppConfig {
            version: CONFIG_VERSION,
            providers,
            active: active_map,
        };
        cfg.normalize();
        cfg
    }

    /// 03 §8：并发闸门真的卡住超额请求，而不是只装饰
    #[tokio::test]
    async fn gate_limits_concurrent_generations() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let _sb = Sandbox::new();
        let state = AppState::new();
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();

        let state_ref = &state;
        let jobs = (0..(MAX_CONCURRENT_GENERATIONS * 2 + 1)).map(|_| {
            let (running, peak, cancel) = (running.clone(), peak.clone(), cancel.clone());
            async move {
                let _permit = state_ref.acquire(&cancel).await.expect("permit");
                let n = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(25)).await;
                running.fetch_sub(1, Ordering::SeqCst);
            }
        });
        futures_util::future::join_all(jobs).await;
        assert_eq!(
            peak.load(Ordering::SeqCst),
            MAX_CONCURRENT_GENERATIONS,
            "峰值并发不应超过闸门容量"
        );
        assert_eq!(running.load(Ordering::SeqCst), 0, "额度未全部归还");
    }

    #[tokio::test]
    async fn waiting_for_a_permit_is_cancellable() {
        let _sb = Sandbox::new();
        let state = AppState::new();
        let _a = state.acquire(&CancellationToken::new()).await.unwrap();
        let _b = state.acquire(&CancellationToken::new()).await.unwrap();

        let tok = CancellationToken::new();
        let bomber = {
            let tok = tok.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                tok.cancel();
            })
        };
        let err = state.acquire(&tok).await.expect_err("排队中应能被取消");
        assert_eq!(err.code, code::CANCELLED);
        bomber.await.unwrap();

        // 放行后额度可以继续使用
        drop(_a);
        assert!(state.acquire(&CancellationToken::new()).await.is_ok());
    }

    #[test]
    fn parse_task_response_covers_known_shapes() {
        let cases: [(&str, &str); 6] = [
            (
                r#"{"status":"succeeded","url":"https://cdn/a.mp4"}"#,
                "https://cdn/a.mp4",
            ),
            (
                r#"{"status":"ok","data":{"url":"https://cdn/b.mp4"}}"#,
                "https://cdn/b.mp4",
            ),
            (
                r#"{"state":"SUCCESS","output":{"video_url":"https://cdn/c.mp4"}}"#,
                "https://cdn/c.mp4",
            ),
            (
                r#"{"data":[{"url":"https://cdn/d.mp4"}]}"#,
                "https://cdn/d.mp4",
            ),
            (
                r#"{"task_status":"completed","video_url":"https://cdn/e.mp4"}"#,
                "https://cdn/e.mp4",
            ),
            (
                r#"{"url":"https://cdn/f.mp4","status":"processing"}"#,
                "https://cdn/f.mp4",
            ),
        ];
        for (raw, expect) in cases {
            let json: serde_json::Value = serde_json::from_str(raw).unwrap();
            match parse_task_response(&json) {
                TaskOutcome::Ready(u) => assert_eq!(u, expect, "{raw}"),
                other => panic!("{raw} 应为 Ready，实为 {other:?}"),
            }
        }

        let running: serde_json::Value =
            serde_json::from_str(r#"{"status":"processing"}"#).unwrap();
        match parse_task_response(&running) {
            TaskOutcome::Running { status } => assert_eq!(status, "processing"),
            other => panic!("应为 Running，实为 {other:?}"),
        }
        let failed: serde_json::Value =
            serde_json::from_str(r#"{"status":"failed","error_message":"GPU 资源不足"}"#).unwrap();
        match parse_task_response(&failed) {
            TaskOutcome::Failed(r) => assert_eq!(r, "GPU 资源不足"),
            other => panic!("应为 Failed，实为 {other:?}"),
        }
    }

    #[tokio::test]
    async fn poll_returns_url_after_running_state() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/video/generations/t123"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"status":"processing"}"#))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/video/generations/t123"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"status":"succeeded","data":{"url":"https://cdn/final.mp4"}}"#,
            ))
            .mount(&server)
            .await;

        let mut progress = Vec::new();
        let sink = &mut progress;
        let url = poll_video_task(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "t123",
            &token(),
            Duration::from_millis(20),
            Duration::from_secs(5),
            |pct, stage| sink.push((pct, stage.to_string())),
        )
        .await
        .unwrap();
        assert_eq!(url, "https://cdn/final.mp4");
        assert_eq!(progress.last().unwrap().0, 100, "完成时必须报 100%");
        assert!(progress.len() >= 2, "进度事件偏少: {progress:?}");
    }

    /// H4 端点形状不确定时的兜底：404 就换下一个候选路径
    #[tokio::test]
    async fn poll_falls_back_to_next_task_endpoint() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/video/tasks/t9"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"status":"succeeded","url":"https://cdn/ok.mp4"}"#),
            )
            .mount(&server)
            .await;

        let url = poll_video_task(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "task:t9",
            &token(),
            Duration::from_millis(10),
            Duration::from_secs(5),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(url, "https://cdn/ok.mp4");
        let paths: Vec<String> = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|r| r.url.path().to_string())
            .collect();
        assert_eq!(
            paths,
            vec!["/v1/video/generations/t9", "/v1/video/tasks/t9"],
            "应先在第一个候选端点 404，再落到第二个"
        );
    }

    #[tokio::test]
    async fn poll_surfaces_failure_and_budget() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/video/generations/tf"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"status":"failed","message":"content_policy violation"}"#),
            )
            .mount(&server)
            .await;
        let err = poll_video_task(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "tf",
            &token(),
            Duration::from_millis(10),
            Duration::from_secs(2),
            |_, _| {},
        )
        .await
        .expect_err("must fail");
        assert_eq!(err.code, code::CONTENT_POLICY);
        assert!(!err.retryable);

        // 一直 running → 预算耗尽归为 TIMEOUT
        let server2 = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/video/generations/tslow"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"status":"queued"}"#))
            .mount(&server2)
            .await;
        let err = poll_video_task(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server2),
            "tslow",
            &token(),
            Duration::from_millis(30),
            Duration::from_millis(120),
            |_, _| {},
        )
        .await
        .expect_err("must time out");
        assert_eq!(err.code, code::TIMEOUT);
        assert!(err.retryable);
    }

    #[tokio::test]
    async fn poll_respects_cancel() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/video/generations/tc"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"status":"processing"}"#))
            .mount(&server)
            .await;
        let tok = token();
        let client = build_client(TEXT_TIMEOUT);
        let cfg = mock_cfg(&server);
        let cancel = tok.clone();
        let handle = tokio::spawn(async move {
            poll_video_task(
                &client,
                &cfg,
                "tc",
                &cancel,
                Duration::from_millis(200),
                Duration::from_secs(30),
                |_, _| {},
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(120)).await;
        let at = Instant::now();
        tok.cancel();
        let err = handle.await.unwrap().expect_err("must be cancelled");
        assert_eq!(err.code, code::CANCELLED);
        assert!(
            at.elapsed() < Duration::from_millis(250),
            "取消未及时: {:?}",
            at.elapsed()
        );
    }

    #[test]
    fn providers_view_never_exposes_key() {
        let cfg = app_cfg(
            vec![provider(
                "oa",
                "https://api.openai.com/v1",
                "sk-proj-supersecret-9f3a",
                &["text"],
                &["gpt-4o"],
            )],
            &[("text", "oa")],
        );
        let view = ProvidersView::from_cfg(&cfg);
        let wire = serde_json::to_string(&view).unwrap();
        assert!(!wire.contains("supersecret"), "IPC 响应泄漏密钥: {wire}");
        assert_eq!(view.providers[0].key_masked.as_deref(), Some("sk-****9f3a"));
        assert!(view.providers[0].has_key);
        assert_eq!(view.active.get("text").map(String::as_str), Some("oa"));

        let keyless = ProvidersView::from_cfg(&app_cfg(
            vec![provider("x", "https://a/v1", "", &[], &[])],
            &[],
        ));
        assert!(!keyless.providers[0].has_key);
        assert_eq!(keyless.providers[0].key_masked, None);
    }

    #[test]
    fn legacy_single_credential_migrates_to_provider_list() {
        let legacy = ApiConfig {
            base_url: "https://api.minimax.chat/v1".into(),
            api_key: "sk-TEST-legacy".into(),
        };
        let cfg = AppConfig::from_legacy(&legacy);
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].api_key, "sk-TEST-legacy");
        // 旧配置没有能力信息 → 视为全能力，且每类都指向它，保证升级后行为不变
        for kind in ["text", "image", "video", "ppt"] {
            assert!(cfg.providers[0].supports(kind));
            assert_eq!(
                cfg.resolve(kind, None, None).unwrap().0.base_url,
                legacy.base_url
            );
        }
    }

    /// B4 修复：模型必须属于所选服务商，"OpenAI 模型打 MiniMax 端点"要在本地就被挡下
    #[test]
    fn resolve_enforces_provider_capabilities_and_model_ownership() {
        let oa = provider(
            "oa",
            "https://api.openai.com/v1",
            "sk-oa-key",
            &["text", "image"],
            &["gpt-4o", "dall-e-3"],
        );
        let mm = provider(
            "mm",
            "https://api.minimax.chat/v1",
            "sk-mm-key",
            &["text", "video"],
            &["abab6.5s-chat"],
        );
        let cfg = app_cfg(vec![oa, mm], &[("text", "mm"), ("image", "oa")]);

        // 按 kind 路由到不同服务商
        let (t, tid, _) = cfg.resolve("text", None, Some("abab6.5s-chat")).unwrap();
        assert_eq!(
            (tid.as_str(), t.base_url.as_str()),
            ("mm", "https://api.minimax.chat/v1")
        );
        let (i, iid, _) = cfg.resolve("image", None, Some("dall-e-3")).unwrap();
        assert_eq!((iid.as_str(), i.api_key.as_str()), ("oa", "sk-oa-key"));

        // 模型不属于该服务商 → 拒绝，并告知可选清单
        let err = cfg
            .resolve("text", None, Some("gpt-4o"))
            .expect_err("must reject");
        assert_eq!(err.code, code::INVALID_PARAM);
        assert!(
            err.message.contains("abab6.5s-chat"),
            "未给出可选项: {}",
            err.message
        );

        // 该服务商根本不支持这类能力
        let err = cfg
            .resolve("video", Some("oa"), None)
            .expect_err("must reject");
        assert_eq!(err.code, code::INVALID_PARAM);

        // 省略模型时用服务商的第一个模型
        let (_, _, model) = cfg.resolve("text", None, None).unwrap();
        assert_eq!(model.as_deref(), Some("abab6.5s-chat"));
    }

    #[test]
    fn resolve_reports_actionable_errors() {
        // 一个服务商都没有
        let empty = AppConfig::default();
        assert_eq!(
            empty
                .resolve("text", None, None)
                .expect_err("must fail")
                .code,
            code::NO_CONFIG
        );

        // 有服务商但没人支持该能力
        let only_text = app_cfg(
            vec![provider(
                "oa",
                "https://a/v1",
                "sk-key-123456",
                &["text"],
                &[],
            )],
            &[("text", "oa")],
        );
        let err = only_text
            .resolve("image", None, None)
            .expect_err("must fail");
        assert_eq!(err.code, code::NO_CONFIG);
        assert!(err.message.contains("不支持这类生成"), "{}", err.message);

        // 有多个候选但没设默认 → 要求用户选，而不是随便挑一个打错端点
        let two = app_cfg(
            vec![
                provider("a", "https://a/v1", "k-aaaa1", &["text"], &[]),
                provider("b", "https://b/v1", "k-bbbb2", &[], &[]),
            ],
            &[],
        );
        let err = two.resolve("text", None, None).expect_err("must fail");
        assert!(err.message.contains("指定默认服务商"), "{}", err.message);
        // 显式指定就能用
        assert_eq!(
            two.resolve("text", Some("b"), None).unwrap().0.base_url,
            "https://b/v1"
        );

        // 服务商存在但没填密钥
        let nokey = app_cfg(vec![provider("a", "https://a/v1", "", &[], &[])], &[]);
        assert_eq!(
            nokey
                .resolve("text", None, None)
                .expect_err("must fail")
                .code,
            code::NO_CONFIG
        );
    }

    /// 04 §8.3：上游给了 usage 就必须入库；没给则是 None 而不是 0
    #[tokio::test]
    async fn text_api_returns_usage_when_present() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "hi"}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 22}
            })))
            .mount(&server)
            .await;
        let (text, usage) = generate_text_api(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server),
            "hi",
            "m",
            &TextOptions::default(),
            &token(),
            FAST,
        )
        .await
        .unwrap();
        assert_eq!(text, "hi");
        assert_eq!(
            usage.map(|u| (u.prompt_tokens, u.completion_tokens)),
            Some((11, 22))
        );

        // 无 usage 字段 → None
        let server2 = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "hi"}}]
            })))
            .mount(&server2)
            .await;
        let (_, usage2) = generate_text_api(
            &build_client(TEXT_TIMEOUT),
            &mock_cfg(&server2),
            "hi",
            "m",
            &TextOptions::default(),
            &token(),
            FAST,
        )
        .await
        .unwrap();
        assert_eq!(usage2, None);
    }

    #[test]
    fn normalize_drops_dangling_active_and_blank_providers() {
        let mut cfg = AppConfig {
            version: 1,
            providers: vec![
                provider("", "https://ghost/v1", "k", &["text"], &[]),
                provider("real", "https://a/v1", "k", &["text"], &[]),
            ],
            active: HashMap::from([
                ("text".to_string(), "real".to_string()),
                ("image".to_string(), "gone".to_string()),
            ]),
        };
        cfg.normalize();
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.version, CONFIG_VERSION);
        assert_eq!(cfg.active.get("text").map(String::as_str), Some("real"));
        assert!(!cfg.active.contains_key("image"), "悬空 active 必须清掉");
    }

    #[test]
    fn mask_key_handles_short_keys() {
        assert_eq!(mask_key("abc").as_deref(), Some("***"));
        assert_eq!(mask_key("12345678").as_deref(), Some("sk-****5678"));
    }

    #[test]
    fn html_escape_blocks_script_injection() {
        let slides = vec![
            PptSlide {
                title: "cover".into(),
                content: String::new(),
            },
            PptSlide {
                title: "<script>alert(1)</script>".into(),
                content: "a\n<b>x</b>".into(),
            },
        ];
        let html = render_ppt_html("t&opic\"", "tech", &slides);
        assert!(!html.contains("<script>alert"), "未转义的脚本进入产物");
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("t&amp;opic&quot;"));
    }

    /// P0-0 回归：保存过的密钥必须能在"下次启动"（setup 载入）后直接用于生成。
    /// 旧实现里配置走 localStorage、Rust 侧永远拿到空 key，所有生成必然失败。
    #[tokio::test]
    async fn saved_key_reaches_generation_on_next_launch() {
        let _sb = Sandbox::new();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "hi from model"}}]
            })))
            .mount(&server)
            .await;

        // 本次会话：用户保存配置
        let saved = app_cfg(
            vec![provider(
                "local",
                &format!("{}/v1", server.uri()),
                "sk-TEST-abcdef123456",
                &["text"],
                &["gpt-4o-mini"],
            )],
            &[("text", "local")],
        );
        save_config(&saved).unwrap();

        // 下次启动：setup() 只读磁盘，前端不参与
        let state = AppState::new();
        let loaded = state.load_config().unwrap();
        assert_eq!(loaded, saved);
        let (cfg, _pid, model) = state.resolved("text", None, None).unwrap();
        assert_eq!(model.as_deref(), Some("gpt-4o-mini"));

        let out = gen_text(
            &state.client,
            &cfg,
            "hi",
            model.as_deref().unwrap(),
            &CancellationToken::new(),
            FAST,
        )
        .await
        .unwrap();
        assert_eq!(out, "hi from model");

        // 渲染进程侧只看得到掩码与存在性
        let wire = serde_json::to_string(&ProvidersView::from_cfg(&loaded)).unwrap();
        assert!(!wire.contains("sk-TEST"), "IPC 泄漏密钥: {wire}");
    }

    /// 验收 #10 + 迁移：明文 config.json 读取后落盘为密文，磁盘不再含 key
    #[test]
    fn plaintext_config_migrates_to_encrypted_on_disk() {
        let _sb = Sandbox::new();
        let dir = secret::data_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            config_file_path(),
            r#"{"base_url":"https://api.openai.com/v1","api_key":"sk-TEST-legacy-plain"}"#,
        )
        .unwrap();

        let loaded = load_config().unwrap();
        assert_eq!(loaded.providers[0].api_key, "sk-TEST-legacy-plain");

        let on_disk = std::fs::read_to_string(config_file_path()).unwrap();
        let env: secret::Envelope = serde_json::from_str(&on_disk).expect("落盘内容不是加密信封");
        assert_eq!(env.v, 2, "未迁移为加密信封: {on_disk}");
        assert!(
            !on_disk.contains("sk-TEST-legacy-plain"),
            "明文 key 仍留在磁盘"
        );

        // 二次读取走解密路径
        assert_eq!(load_config().unwrap(), loaded);
        // 全目录扫描：0 处明文 key
        for entry in walk(dir) {
            if let Ok(bytes) = std::fs::read(&entry) {
                assert!(
                    !String::from_utf8_lossy(&bytes).contains("sk-TEST-legacy-plain"),
                    "明文 key 出现在 {entry:?}"
                );
            }
        }
    }

    #[test]
    fn encrypted_envelope_survives_v3_roundtrip() {
        let _sb = Sandbox::new();
        let cfg = app_cfg(
            vec![
                provider(
                    "oa",
                    "https://api.openai.com/v1",
                    "sk-OA-one-two-three",
                    &["text", "image"],
                    &["gpt-4o"],
                ),
                provider(
                    "mm",
                    "https://api.minimax.chat/v1",
                    "sk-MM-four-five-six",
                    &["video"],
                    &[],
                ),
            ],
            &[("text", "oa"), ("video", "mm")],
        );
        save_config(&cfg).unwrap();
        let on_disk = std::fs::read_to_string(config_file_path()).unwrap();
        assert!(!on_disk.contains("sk-OA-one-two-three"), "明文 key 落盘");
        assert!(!on_disk.contains("sk-MM-four-five-six"), "明文 key 落盘");
        assert_eq!(load_config().unwrap(), cfg);
    }

    #[test]
    fn corrupt_config_is_backed_up_not_fatal() {
        let _sb = Sandbox::new();
        std::fs::create_dir_all(secret::data_dir()).unwrap();
        std::fs::write(config_file_path(), b"{ this is not json").unwrap();
        let loaded = load_config().unwrap();
        assert!(loaded.providers.is_empty());
        assert!(config_file_path().with_extension("json.bak").exists());
    }

    fn walk(dir: std::path::PathBuf) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return out,
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(p));
            } else {
                out.push(p);
            }
        }
        out
    }
}
