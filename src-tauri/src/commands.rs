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

fn record_params(
    items: &[(&str, serde_json::Value)],
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    for (k, v) in items {
        map.insert((*k).to_string(), v.clone());
    }
    map
}

/// 写入历史。失败只在日志留痕，不让已成功的生成结果对用户变成失败。
fn commit_record(state: &AppState, record: Record) {
    if let Err(e) = state
        .history
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(record)
    {
        eprintln!("[aigen] 历史落盘失败（{}）: {}", e.code, e.message);
    }
}

/// AI图片生成命令（T-B1：model/size 透传上游；T-Provider：按能力路由）
#[tauri::command]
pub async fn generate_image(
    state: State<'_, AppState>,
    request_id: String,
    prompt: String,
    count: Option<u32>,
    model: Option<String>,
    size: Option<String>,
    provider_id: Option<String>,
) -> Result<Vec<String>, GenError> {
    let (token, _guard) = start_task(&state, &request_id);
    let (cfg, provider, model) =
        state.resolved("image", provider_id.as_deref(), model.as_deref())?;
    // 03 §8：全局并发闸门，批量提交时靠它排队而不是同时打上游
    let _permit = state.acquire(&token).await?;
    let n = count.unwrap_or(1);
    let urls = ai_client::generate_image_api(
        &state.client,
        &cfg,
        &prompt,
        n,
        model.as_deref(),
        size.as_deref(),
        &token,
        ai_client::IMAGE_TIMEOUT,
    )
    .await?;

    // B6：base64 / 远端图都落盘成文件，历史只存引用
    let id = uuid_str();
    let mut refs = Vec::new();
    for (i, url) in urls.iter().enumerate() {
        let saved = if let Some((bytes, ext)) = history::decode_data_url(url) {
            history::save_result_bytes(&id, i, &ext, &bytes)
        } else {
            match ai_client::fetch_bytes(&state.client, url, &token, ai_client::IMAGE_TIMEOUT).await
            {
                Ok(bytes) => {
                    let ext = image_ext(url);
                    history::save_result_bytes(&id, i, &ext, &bytes)
                }
                // 留存失败不推翻生成结果：退化存远端 URL（仍是引用，不是内联）
                Err(e) => {
                    eprintln!("[aigen] 图片留存失败，保留远端引用: {}", e.code);
                    Ok(url.clone())
                }
            }
        };
        match saved {
            Ok(r) => refs.push(r),
            Err(e) => eprintln!("[aigen] 图片写入结果目录失败: {}", e.message),
        }
    }

    commit_record(
        &state,
        Record {
            id,
            kind: "image".to_string(),
            prompt: prompt.clone(),
            model: model.clone(),
            params: record_params(&[
                ("count", serde_json::json!(n)),
                (
                    "size",
                    serde_json::json!(size.clone().unwrap_or_else(|| "1024x1024".into())),
                ),
                ("provider_id", serde_json::json!(provider)),
            ]),
            result_refs: refs,
            text_result: None,
            status: "succeeded".to_string(),
            created_at: history::now_iso8601(),
            usage: None,
            favorite: false,
        },
    );

    Ok(urls)
}

/// 从 URL 猜图片扩展名（去掉查询串）
fn image_ext(url: &str) -> String {
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

/// AI文本生成命令
#[tauri::command]
pub async fn generate_text(
    state: State<'_, AppState>,
    request_id: String,
    prompt: String,
    model: Option<String>,
    provider_id: Option<String>,
    opts: Option<ai_client::TextOptions>,
) -> Result<String, GenError> {
    let (token, _guard) = start_task(&state, &request_id);
    let (cfg, provider, model) =
        state.resolved("text", provider_id.as_deref(), model.as_deref())?;
    // 03 §8：全局并发闸门，批量提交时靠它排队而不是同时打上游
    let _permit = state.acquire(&token).await?;
    let model_name = model.unwrap_or_else(|| "gpt-4o-mini".to_string());
    let content = ai_client::generate_text_api(
        &state.client,
        &cfg,
        &prompt,
        &model_name,
        &opts.unwrap_or_default(),
        &token,
        ai_client::TEXT_TIMEOUT,
    )
    .await?;

    commit_record(
        &state,
        Record {
            id: uuid_str(),
            kind: "text".to_string(),
            prompt: prompt.clone(),
            model: Some(model_name),
            params: record_params(&[("provider_id", serde_json::json!(provider))]),
            result_refs: vec![],
            text_result: Some(content.0.clone()),
            status: "succeeded".to_string(),
            created_at: history::now_iso8601(),
            usage: content.1,
            favorite: false,
        },
    );

    Ok(content.0)
}

/// 文本流式生成（T-Stream）。
///
/// 增量通过事件 `aigen://stream/{request_id}` 推给前端，命令本身仍返回全文：
/// 这样取消、错误契约与历史写入都沿用非流式那条路（偏差说明见 05）。
#[tauri::command]
pub async fn generate_text_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    prompt: String,
    model: Option<String>,
    provider_id: Option<String>,
    opts: Option<ai_client::TextOptions>,
) -> Result<String, GenError> {
    use tauri::Emitter;

    let (token, _guard) = start_task(&state, &request_id);
    let (cfg, provider, model) =
        state.resolved("text", provider_id.as_deref(), model.as_deref())?;
    // 03 §8：全局并发闸门，批量提交时靠它排队而不是同时打上游
    let _permit = state.acquire(&token).await?;
    let model_name = model.unwrap_or_else(|| "gpt-4o-mini".to_string());
    let options = opts.unwrap_or_default().normalized()?;

    let topic = request_id.clone();
    let emitter = move |ev: crate::stream::StreamEvent| {
        let _ = app.emit(&format!("aigen://stream/{topic}"), ev.clone());
    };

    let (content, usage) = ai_client::generate_text_stream_api(
        &state.client,
        &cfg,
        &prompt,
        &model_name,
        &options,
        &token,
        emitter,
    )
    .await?;

    commit_record(
        &state,
        Record {
            id: uuid_str(),
            kind: "text".to_string(),
            prompt: prompt.clone(),
            model: Some(model_name),
            params: record_params(&[
                ("stream", serde_json::json!(true)),
                ("provider_id", serde_json::json!(provider)),
                ("temperature", serde_json::json!(options.temperature)),
                ("max_tokens", serde_json::json!(options.max_tokens)),
                ("with_system", serde_json::json!(options.system.is_some())),
            ]),
            result_refs: vec![],
            text_result: Some(content.clone()),
            status: "succeeded".to_string(),
            created_at: history::now_iso8601(),
            usage,
            favorite: false,
        },
    );

    Ok(content)
}

/// AI视频生成命令
#[tauri::command]
pub async fn generate_video(
    state: State<'_, AppState>,
    request_id: String,
    prompt: String,
    duration: String,
    resolution: String,
    provider_id: Option<String>,
    model: Option<String>,
) -> Result<String, GenError> {
    let (token, _guard) = start_task(&state, &request_id);
    let (cfg, provider, model) =
        state.resolved("video", provider_id.as_deref(), model.as_deref())?;
    // 03 §8：全局并发闸门，批量提交时靠它排队而不是同时打上游
    let _permit = state.acquire(&token).await?;
    let video_url = ai_client::generate_video_api(
        &state.client,
        &cfg,
        &prompt,
        &duration,
        &resolution,
        &token,
        ai_client::VIDEO_TIMEOUT,
    )
    .await?;

    // B2：异步任务模式下拿到的是 `task:xxx` 占位，标记为 polling 而不是谎报成功
    let polling = video_url.starts_with("task:");
    commit_record(
        &state,
        Record {
            id: uuid_str(),
            kind: "video".to_string(),
            prompt: prompt.clone(),
            model,
            params: record_params(&[
                ("duration", serde_json::json!(duration)),
                ("resolution", serde_json::json!(resolution)),
                ("provider_id", serde_json::json!(provider)),
            ]),
            result_refs: vec![video_url.clone()],
            text_result: None,
            status: if polling {
                "polling".to_string()
            } else {
                "succeeded".to_string()
            },
            created_at: history::now_iso8601(),
            usage: None,
            favorite: false,
        },
    );

    Ok(video_url)
}

/// 轮询已提交的视频任务（T-B2）。进度走 `aigen://progress/{request_id}`。
#[tauri::command]
pub async fn poll_video(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    task_id: String,
) -> Result<String, GenError> {
    use tauri::Emitter;

    let (cfg, _provider, _model) = state.resolved("video", None, None)?;
    let (token, _guard) = start_task(&state, &request_id);
    let topic = request_id.clone();
    ai_client::poll_video_task(
        &state.client,
        &cfg,
        &task_id,
        &token,
        ai_client::VIDEO_POLL_INTERVAL,
        ai_client::VIDEO_POLL_BUDGET,
        move |percent, stage| {
            let _ = app.emit(
                &format!("aigen://progress/{topic}"),
                serde_json::json!({ "percent": percent, "stage": stage }),
            );
        },
    )
    .await
}

/// PPT生成命令
#[tauri::command]
pub async fn generate_ppt(
    state: State<'_, AppState>,
    request_id: String,
    topic: String,
    template: String,
    slides: u32,
    outline: Vec<ai_client::PptOutlineItem>,
    provider_id: Option<String>,
) -> Result<String, GenError> {
    let (token, _guard) = start_task(&state, &request_id);
    let (cfg, provider, model) = state.resolved("ppt", provider_id.as_deref(), None)?;
    // 03 §8：全局并发闸门，批量提交时靠它排队而不是同时打上游
    let _permit = state.acquire(&token).await?;
    let id = uuid_str();
    let req = ai_client::PptRequest {
        topic: topic.clone(),
        template: template.clone(),
        slides,
        outline: outline.clone(),
    };
    let (abs_path, rel) =
        ai_client::generate_ppt_file(&state.client, &cfg, &id, &req, model.as_deref(), &token)
            .await?;

    commit_record(
        &state,
        Record {
            id,
            kind: "ppt".to_string(),
            prompt: topic.clone(),
            model,
            params: record_params(&[
                ("slides", serde_json::json!(slides)),
                ("template", serde_json::json!(template)),
                ("outline_items", serde_json::json!(outline.len())),
                ("provider_id", serde_json::json!(provider)),
            ]),
            result_refs: vec![rel],
            text_result: None,
            status: "succeeded".to_string(),
            created_at: history::now_iso8601(),
            usage: None,
            favorite: false,
        },
    );

    Ok(abs_path)
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
    fn commit_record_persists_across_state_rebuild() {
        let _sb = Sandbox::new();
        let state = AppState::new();
        commit_record(
            &state,
            Record {
                id: "r1".into(),
                kind: "text".into(),
                prompt: "写一首诗".into(),
                model: Some("gpt-4o".into()),
                params: serde_json::Map::new(),
                result_refs: vec![],
                text_result: Some("床前明月光".into()),
                status: "succeeded".into(),
                created_at: history::now_iso8601(),
                usage: None,
                favorite: false,
            },
        );
        // 新建 AppState == 重启进程
        let reopened = AppState::new();
        let store = reopened.history.lock().unwrap();
        assert_eq!(store.len(), 1);
        assert_eq!(
            store.records()[0].text_result.as_deref(),
            Some("床前明月光")
        );
    }

    #[test]
    fn image_ext_falls_back_safely() {
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
