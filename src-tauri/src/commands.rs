//! Tauri command 层（doc/优化方案/05 阶段一、二）。
//!
//! 约定：所有生成命令都接受前端生成的 `request_id`，并登记一个取消句柄；
//! 返回值统一为 [`GenError`]（结构化、脱敏），不再向前端抛裸字符串。
//! 生成成功后写入落盘历史 [`Record`]（T-C1），结果以文件引用入库（B6）。

use crate::ai_client::{self, ApiConfig, AppState, Provider, ProvidersView};
use crate::error::{code, GenError};
use crate::history::{self, Record};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;
use tokio_util::sync::CancellationToken;

/// 任务登记簿的守卫：无论命令以成功还是 `?` 提前返回退出，都摘掉句柄，
/// 避免 request_id 泄漏在表里被后续 cancel 命中。
struct TaskGuard<'a> {
    id: String,
    state: &'a AppState,
}

impl Drop for TaskGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.state.tasks.lock() {
            tasks.remove(&self.id);
        }
    }
}

/// 取出当前配置 + 登记取消句柄。必须在任何 await 之前同步完成登记。
fn start_task<'a>(state: &'a AppState, request_id: &str) -> (CancellationToken, TaskGuard<'a>) {
    let token = CancellationToken::new();
    state
        .tasks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.to_string(), token.clone());
    (
        token,
        TaskGuard {
            id: request_id.to_string(),
            state,
        },
    )
}

/// `submit_generation` 的应答：任务在后台跑，前端靠事件与 `get_generation` 跟进。
/// 必须 camelCase：前端 `jobClient` 读的是 `ack.requestId`，
/// 之前这里是 `request_id`，导致前端拿到 undefined、监听 `aigen://state/undefined`，
/// **所有任务事件全部丢失**（只有真壳 E2E 抓得到，vitest 用的是自己写的假形状）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAck {
    pub request_id: String,
}

#[tauri::command]
pub async fn submit_generation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    req: crate::job::GenerationRequest,
) -> Result<SubmitAck, GenError> {
    use tauri::{Emitter, Manager};

    let request_id = crate::job::new_id();
    let token = CancellationToken::new();
    state
        .tasks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), token.clone());
    state
        .jobs
        .put(crate::job::GenerationState::new(&request_id, &req.kind));

    let registry = state.jobs.clone();
    let id = request_id.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let st = crate::job::execute(&state, &id, &req, &token, |s| {
            registry.put(s.clone());
            let _ = handle.emit(&format!("aigen://state/{id}"), s.clone());
        })
        .await;
        // 收尾即摘取消句柄，避免长会话里 id 表无界增长
        if let Ok(mut tasks) = state.tasks.lock() {
            tasks.remove(&id);
        }
        let _ = st;
    });

    Ok(SubmitAck { request_id })
}

/// 查单个任务态（用于对账、重开应用后找回、以及事件漏收的兜底）
#[tauri::command]
pub async fn get_generation(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<crate::job::GenerationState, GenError> {
    state.jobs.get(&request_id).ok_or_else(|| {
        GenError::new(
            code::INVALID_PARAM,
            format!("任务 {request_id} 不存在或已被回收"),
        )
    })
}

/// 最近任务列表（面板重挂载时一次性补齐）
#[tauri::command]
pub async fn list_generations(
    state: State<'_, AppState>,
) -> Result<Vec<crate::job::GenerationState>, GenError> {
    Ok(state.jobs.snapshot())
}

/// 中止进行中的生成任务（T-C3）。返回 false 表示该 request_id 已不在跑。
#[tauri::command]
pub fn cancel_generation(state: State<'_, AppState>, request_id: String) -> bool {
    let token = state
        .tasks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id);
    match token {
        Some(t) => {
            t.cancel();
            true
        }
        None => false,
    }
}

#[derive(Serialize)]
pub struct HistoryPage {
    pub items: Vec<Record>,
    /// 本次筛选命中的条数
    pub total: usize,
    /// 本地已存的历史总条数（不受筛选影响）
    pub stored: usize,
    /// 载入时跳过的坏行数：>0 说明历史文件曾受损（04 §5）
    pub dropped_lines: usize,
}

/// 分页/筛选读取历史（取代旧 get_history，03 §11.1）
#[tauri::command]
pub async fn list_history(
    state: State<'_, AppState>,
    kind: Option<String>,
    keyword: Option<String>,
    page: Option<usize>,
    size: Option<usize>,
) -> Result<HistoryPage, GenError> {
    let store = state.history.lock().unwrap_or_else(|e| e.into_inner());
    let (items, total) = store.query(
        kind.as_deref(),
        keyword.as_deref(),
        page.unwrap_or(0),
        size.unwrap_or(20),
    );
    Ok(HistoryPage {
        items,
        total,
        stored: store.len(),
        dropped_lines: store.dropped_lines(),
    })
}

/// 删除单条历史（破坏性：前端必须二次确认，04 §6）
#[tauri::command]
pub async fn delete_history(state: State<'_, AppState>, id: String) -> Result<bool, GenError> {
    let mut store = state.history.lock().unwrap_or_else(|e| e.into_inner());
    store.delete(&id)
}

/// 清空历史与本地结果文件（破坏性：前端必须二次确认，04 §6）
#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> Result<(), GenError> {
    let mut store = state.history.lock().unwrap_or_else(|e| e.into_inner());
    store.clear()
}

/// 收藏/取消收藏（02 §5 历史筛选前置能力）
#[tauri::command]
pub async fn set_history_favorite(
    state: State<'_, AppState>,
    id: String,
    favorite: bool,
) -> Result<bool, GenError> {
    let mut store = state.history.lock().unwrap_or_else(|e| e.into_inner());
    store.set_favorite(&id, favorite)
}

/// 保存服务商配置（T-Provider / 04 §2.2）。
///
/// `api_key` 省略或空串时保留该服务商既有密钥（前端只做单向写入）。
/// 返回全量视图，前端一次刷新即可，不再回读任何密钥。
// 参数即 03 §11.1 约定的扁平 IPC 载荷（provider_id/base_url/api_key + 服务商元数据），
// 打包成结构体会改掉前端已经验证过的调用形状
/// 生成助手（T-Agent）：**只返回建议**，不写文件、不改配置、不自动发起生成。
/// 服务商没配好时退化为本地启发式建议，并把该诊断作为第一条建议返回。
#[tauri::command]
pub async fn assist_generation(
    state: State<'_, AppState>,
    request_id: String,
    kind: String,
    prompt: String,
    model: Option<String>,
    provider_id: Option<String>,
    last_error: Option<String>,
) -> Result<crate::assistant::AssistantReply, GenError> {
    let (token, _guard) = start_task(&state, &request_id);

    // 路由失败不阻断求助：带着错误码走本地启发式
    let (req, cfg) = match state.resolved(&kind, provider_id.as_deref(), model.as_deref()) {
        Ok((cfg, _pid, chosen)) => (
            crate::assistant::AssistantRequest {
                kind: kind.clone(),
                prompt: prompt.clone(),
                // 用户显式选的优先，否则用路由定下来的模型
                model: model.clone().or(chosen),
                last_error: last_error.clone(),
            },
            cfg,
        ),
        Err(e) => (
            crate::assistant::AssistantRequest {
                kind,
                prompt,
                model,
                last_error: Some(e.code),
            },
            ApiConfig::default(),
        ),
    };

    // 助手自己也要花额度：纳入同一个并发闸门，并且可被取消
    let _permit = state.acquire(&token).await?;
    crate::assistant::advise(&state.client, &cfg, &req, &token).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn save_api_config(
    state: State<'_, AppState>,
    provider_id: Option<String>,
    base_url: String,
    api_key: Option<String>,
    name: Option<String>,
    capabilities: Option<Vec<String>>,
    models: Option<Vec<String>>,
) -> Result<ProvidersView, GenError> {
    let mut cfg = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let explicit_id = provider_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let pid = match explicit_id {
        Some(id) => id.to_string(),
        // 新建时若名称派生的 id 已存在，必须让 id 唯一：
        // 否则"再加一个同名服务商"会静默覆盖掉已有的那一条
        None => unique_provider_id(&cfg.providers, &slug(name.as_deref().unwrap_or("provider"))),
    };
    let new_key = api_key.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let normalized_base = base_url.trim().to_string();
    if normalized_base.is_empty() {
        return Err(GenError::new(code::INVALID_PARAM, "Base URL 不能为空"));
    }
    let caps_provided = capabilities.is_some();
    let models_provided = models.is_some();
    let caps = capabilities.unwrap_or_default();
    for c in &caps {
        if !["text", "image", "video", "ppt"].contains(&c.as_str()) {
            return Err(GenError::new(
                code::INVALID_PARAM,
                format!("不支持的能力类型：{c}"),
            ));
        }
    }
    let known_models = models.unwrap_or_default();

    let provider = match cfg.providers.iter_mut().find(|p| p.id == pid) {
        Some(existing) => {
            existing.base_url = normalized_base;
            if let Some(k) = new_key {
                existing.api_key = k.to_string();
            }
            if let Some(n) = name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                existing.name = n.to_string();
            }
            if caps_provided {
                existing.capabilities = caps;
            }
            if models_provided {
                existing.models = known_models;
            }
            existing.clone()
        }
        None => {
            let p = Provider {
                id: pid.clone(),
                name: name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| pid.clone()),
                base_url: normalized_base,
                capabilities: caps,
                models: known_models,
                api_key: new_key.unwrap_or("").to_string(),
            };
            cfg.providers.push(p.clone());
            p
        }
    };

    // 还没填密钥也允许先存端点；但端点形状必须合法，否则会静默失败
    ai_client::validate_base_url(&provider.base_url)?;

    // 第一个服务商自动成为各类型的默认，省掉"必须先选一次"的空档
    if cfg.providers.len() == 1 {
        for kind in ["text", "image", "video", "ppt"] {
            if provider.supports(kind) {
                cfg.active.insert(kind.to_string(), pid.clone());
            }
        }
    }
    cfg.normalize();
    ai_client::save_config(&cfg)?;
    *state.config.lock().unwrap_or_else(|e| e.into_inner()) = cfg;
    Ok(ProvidersView::from_cfg(
        &state.config.lock().unwrap_or_else(|e| e.into_inner()),
    ))
}

/// 加载服务商配置：**只回传存在性与掩码**（04 §2.2、03 §11.1）
#[tauri::command]
pub fn load_api_config(state: State<'_, AppState>) -> Result<ProvidersView, GenError> {
    let cfg = state.load_config()?;
    Ok(ProvidersView::from_cfg(&cfg))
}

/// 删除服务商（破坏性：前端必须二次确认，04 §6）
#[tauri::command]
pub fn delete_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<ProvidersView, GenError> {
    let mut cfg = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let before = cfg.providers.len();
    cfg.providers.retain(|p| p.id != provider_id);
    if cfg.providers.len() == before {
        return Err(GenError::new(
            code::INVALID_PARAM,
            format!("服务商 {provider_id} 不存在"),
        ));
    }
    cfg.normalize();
    ai_client::save_config(&cfg)?;
    *state.config.lock().unwrap_or_else(|e| e.into_inner()) = cfg.clone();
    Ok(ProvidersView::from_cfg(&cfg))
}

/// 设定某类生成的默认服务商（修 B4 的操作面）
#[tauri::command]
pub fn set_active_provider(
    state: State<'_, AppState>,
    kind: String,
    provider_id: String,
) -> Result<ProvidersView, GenError> {
    if !["text", "image", "video", "ppt"].contains(&kind.as_str()) {
        return Err(GenError::new(
            code::INVALID_PARAM,
            format!("不支持的类型：{kind}"),
        ));
    }
    let mut cfg = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let provider = cfg
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| GenError::new(code::INVALID_PARAM, "服务商不存在"))?;
    if !provider.supports(&kind) {
        return Err(GenError::new(
            code::INVALID_PARAM,
            format!("服务商「{}」未声明支持 {kind}", provider.name),
        ));
    }
    cfg.active.insert(kind, provider_id);
    ai_client::save_config(&cfg)?;
    *state.config.lock().unwrap_or_else(|e| e.into_inner()) = cfg.clone();
    Ok(ProvidersView::from_cfg(&cfg))
}

/// 连通性校验（02 §9）：拉取上游模型清单，顺带可作为模型来源
#[tauri::command]
pub async fn test_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<String>, GenError> {
    let cfg = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let provider = cfg
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| GenError::new(code::INVALID_PARAM, "服务商不存在"))?;
    if provider.api_key.trim().is_empty() {
        return Err(GenError::new(
            code::NO_CONFIG,
            format!("服务商「{}」还没有填写密钥", provider.name),
        ));
    }
    let credentials = ApiConfig {
        base_url: provider.base_url.clone(),
        api_key: provider.api_key.clone(),
    };
    let token = CancellationToken::new();
    ai_client::probe_models(
        &state.client,
        &credentials,
        &token,
        ai_client::VIDEO_TIMEOUT,
    )
    .await
}

/// 导出结果到用户选定路径（T-Export）。
///
/// 目标路径由前端 `dialog` 插件让用户挑选；覆盖必须显式 `allow_overwrite`（04 §6）。
#[tauri::command]
pub async fn save_export(
    state: State<'_, AppState>,
    target_path: String,
    record_id: Option<String>,
    ref_index: Option<usize>,
    text: Option<String>,
    allow_overwrite: Option<bool>,
) -> Result<crate::export::Exported, GenError> {
    let target = PathBuf::from(target_path.trim());
    let record = match record_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(id) => {
            let store = state.history.lock().unwrap_or_else(|e| e.into_inner());
            let found = store.find(id);
            // 未命中时不静默降级：让用户看到"记录不存在"而不是导出出别的内容
            match found {
                Some(r) => Some(r),
                None => {
                    return Err(GenError::new(
                        code::INVALID_PARAM,
                        format!("历史记录 {id} 不存在，可能被已删除"),
                    ))
                }
            }
        }
        None => None,
    };
    let cancel = CancellationToken::new();
    crate::export::write_export(
        &state.client,
        record.as_ref(),
        ref_index,
        text.as_deref(),
        &target,
        allow_overwrite.unwrap_or(false),
        &cancel,
    )
    .await
}

/// 本地数据目录（历史抽屉展示"结果存在哪"，04 §3 本地留存可控）
#[tauri::command]
pub fn data_dir_path() -> String {
    history::data_dir().to_string_lossy().to_string()
}

#[derive(Serialize)]
pub struct TemplatePage {
    pub items: Vec<crate::templates::PromptTemplate>,
    /// >0 表示模板文件曾受损并已回落到内置种子
    pub corrupted: usize,
}

/// 模板清单（T-Prompt）
#[tauri::command]
pub async fn list_templates(
    state: State<'_, AppState>,
    kind: Option<String>,
    keyword: Option<String>,
) -> Result<TemplatePage, GenError> {
    let store = state.templates.lock().unwrap_or_else(|e| e.into_inner());
    Ok(TemplatePage {
        items: store.search(kind.as_deref(), keyword.as_deref()),
        corrupted: store.dropped_lines(),
    })
}

/// 新增/更新模板。改内置模板会派生成用户模板（不原地改）
#[tauri::command]
pub async fn save_template(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    kind: String,
    body: String,
    favorite: Option<bool>,
) -> Result<crate::templates::PromptTemplate, GenError> {
    let mut store = state.templates.lock().unwrap_or_else(|e| e.into_inner());
    store.upsert(id.as_deref(), &name, &kind, &body, favorite)
}

/// 删除模板（破坏性：前端二次确认；内置模板不可删）
#[tauri::command]
pub async fn delete_template(state: State<'_, AppState>, id: String) -> Result<bool, GenError> {
    let mut store = state.templates.lock().unwrap_or_else(|e| e.into_inner());
    store.delete(&id)
}

#[tauri::command]
pub async fn set_template_favorite(
    state: State<'_, AppState>,
    id: String,
    favorite: bool,
) -> Result<bool, GenError> {
    let mut store = state.templates.lock().unwrap_or_else(|e| e.into_inner());
    store.set_favorite(&id, favorite)
}

/// 填充变量插槽。缺失变量不报错，随 `missing` 返回给 UI 提示补填
#[tauri::command]
pub async fn render_template(
    state: State<'_, AppState>,
    id: String,
    values: Option<HashMap<String, String>>,
) -> Result<crate::templates::Rendered, GenError> {
    let store = state.templates.lock().unwrap_or_else(|e| e.into_inner());
    store.render(&id, &values.unwrap_or_default())
}

/// 保证新建服务商的 id 不与既有服务商撞车
fn unique_provider_id(existing: &[Provider], base: &str) -> String {
    if !existing.iter().any(|p| p.id == base) {
        return base.to_string();
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{base}-{n}");
        if !existing.iter().any(|p| p.id == candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// 由名称生成稳定 id（ASCII 名称直接小写；含中文等字符时退化为随机 id）
fn slug(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else if c == ' ' || c == '_' || c == '-' {
                '_'
            } else {
                '·'
            }
        })
        .filter(|c| *c != '·')
        .take(32)
        .collect();
    let cleaned = cleaned.trim_matches('_').to_string();
    if cleaned.is_empty() {
        format!("p{}", &uuid_str()[..8])
    } else {
        cleaned
    }
}

/// 生成UUID字符串
fn uuid_str() -> String {
    use getrandom::getrandom;
    let mut buf = [0u8; 16];
    // 失败时仍有自增尾缀兜底，保证进程内 id 唯一
    getrandom(&mut buf).ok();
    let seq = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
    buf[8..16].copy_from_slice(&seq.to_le_bytes());
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        buf[0], buf[1], buf[2], buf[3],
        buf[4], buf[5],
        buf[6], buf[7],
        buf[8], buf[9],
        buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]
    )
}

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::test_sandbox::Sandbox;

    #[test]
    fn uuid_is_unique_and_shaped() {
        let ids: Vec<String> = (0..500).map(|_| uuid_str()).collect();
        let uniq: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(uniq.len(), ids.len(), "历史 id 出现重复");
        assert!(ids[0].len() == 36, "非 uuid 形状: {}", ids[0]);
    }

    #[test]
    fn task_guard_deregisters_on_drop() {
        let _sb = Sandbox::new();
        let state = AppState::new();
        {
            let (_token, _guard) = start_task(&state, "req-1");
            assert!(state.tasks.lock().unwrap().contains_key("req-1"));
        }
        assert!(!state.tasks.lock().unwrap().contains_key("req-1"));
    }

    #[test]
    fn slug_produces_usable_provider_ids() {
        assert_eq!(slug("OpenAI"), "openai");
        assert_eq!(slug("  Mini Max "), "mini_max");
        // 纯中文名不能拼进 URL 或路径，退化为 ASCII 随机 id
        let cn = slug("深度求索");
        assert!(cn.starts_with('p') && cn.len() > 3, "{cn}");
        assert!(cn.chars().all(|c| c.is_ascii_alphanumeric()), "{cn}");
    }

    /// 同名服务商必须各自独立，不能静默覆盖掉先建的那条
    #[test]
    fn duplicate_provider_names_get_distinct_ids() {
        let mk = |id: &str| Provider {
            id: id.to_string(),
            name: id.to_string(),
            base_url: "https://a/v1".into(),
            capabilities: vec![],
            models: vec![],
            api_key: "k".into(),
        };
        let existing = vec![mk("openai"), mk("openai-2")];
        assert_eq!(unique_provider_id(&[], "openai"), "openai");
        assert_eq!(unique_provider_id(&existing, "openai"), "openai-3");
        assert_eq!(unique_provider_id(&existing, "minimax"), "minimax");
    }

    #[test]
    fn image_ext_falls_back_safely() {
        use crate::job::image_ext;
        assert_eq!(image_ext("https://cdn/x/y.PNG?v=1"), "png");
        assert_eq!(image_ext("https://cdn/y.webp"), "webp");
        assert_eq!(image_ext("https://cdn/noext"), "png");
        assert_eq!(image_ext("https://cdn/a.b..d"), "png");
    }

    #[test]
    fn data_dir_path_is_absolute() {
        let _sb = Sandbox::new();
        assert!(!data_dir_path().is_empty());
        assert!(std::path::Path::new(&data_dir_path()).is_absolute());
    }
}

#[cfg(test)]
mod ipc_shape_tests {
    use super::*;

    /// serde_json 的 map 是有序的，所以只比"键集合"，不比声明顺序
    fn keys_of<T: serde::Serialize>(v: &T) -> Vec<String> {
        let mut k: Vec<String> = serde_json::to_value(v)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        k.sort();
        k
    }

    fn expect_keys(actual: Vec<String>, mut want: Vec<&str>) {
        let want: Vec<String> = {
            want.sort();
            want.into_iter().map(str::to_string).collect()
        };
        assert_eq!(actual, want);
    }

    /// 前端按字段名直读这些载荷，键名必须逐字对齐（camelCase 的地方不能漏）
    #[test]
    fn frontend_facing_payloads_use_the_keys_the_ui_reads() {
        let ack = SubmitAck {
            request_id: "job-1".into(),
        };
        assert_eq!(
            keys_of(&ack),
            vec!["requestId".to_string()],
            "SubmitAck 形状变了，前端会拿到 undefined"
        );

        let page = HistoryPage {
            items: vec![],
            total: 0,
            stored: 1,
            dropped_lines: 2,
        };
        expect_keys(
            keys_of(&page),
            vec!["items", "total", "stored", "dropped_lines"],
        );

        let exported = crate::export::Exported {
            path: "/tmp/a.png".into(),
            bytes: 12,
            source: "file".into(),
        };
        expect_keys(keys_of(&exported), vec!["path", "bytes", "source"]);

        let templates = TemplatePage {
            items: vec![],
            corrupted: 0,
        };
        expect_keys(keys_of(&templates), vec!["items", "corrupted"]);

        let view = crate::ai_client::ProvidersView {
            providers: vec![],
            active: Default::default(),
        };
        expect_keys(keys_of(&view), vec!["providers", "active"]);

        let provider = crate::ai_client::PublicProvider {
            id: "oa".into(),
            name: "OpenAI".into(),
            base_url: "https://a/v1".into(),
            capabilities: vec![],
            models: vec![],
            has_key: true,
            key_masked: Some("sk-****1".into()),
        };
        expect_keys(
            keys_of(&provider),
            vec![
                "id",
                "name",
                "base_url",
                "capabilities",
                "models",
                "has_key",
                "key_masked",
            ],
        );

        let reply = crate::assistant::AssistantReply {
            suggestions: vec![],
            rewritten: None,
            heuristic_only: true,
            usage: None,
        };
        expect_keys(
            keys_of(&reply),
            vec!["suggestions", "rewritten", "heuristic_only", "usage"],
        );
    }
}
