use crate::ai_client::{self, ApiConfig, HistoryItem, AppState};
use tauri::State;

/// AI图片生成命令
#[tauri::command]
pub async fn generate_image(
    state: State<'_, AppState>,
    prompt: String,
    count: Option<u32>,
) -> Result<Vec<String>, String> {
    let config = {
        let cfg = state.config.lock().map_err(|e| format!("锁配置失败: {}", e))?;
        cfg.clone()
    };

    let n = count.unwrap_or(1);
    let urls = ai_client::generate_image_api(&config, &prompt, n).await?;

    // 添加到历史记录
    let item = HistoryItem {
        id: uuid_str(),
        kind: "image".to_string(),
        prompt: prompt.clone(),
        result: urls.join(", "),
        created_at: now_str(),
    };

    {
        let mut history = state.history.lock().map_err(|e| format!("锁历史失败: {}", e))?;
        history.insert(0, item);
        if history.len() > 100 {
            history.truncate(100);
        }
    }

    Ok(urls)
}

/// AI文本生成命令
#[tauri::command]
pub async fn generate_text(
    state: State<'_, AppState>,
    prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    let config = {
        let cfg = state.config.lock().map_err(|e| format!("锁配置失败: {}", e))?;
        cfg.clone()
    };

    let model_name = model.unwrap_or_else(|| "gpt-4o-mini".to_string());
    let content = ai_client::generate_text_api(&config, &prompt, &model_name).await?;

    // 添加到历史记录
    let item = HistoryItem {
        id: uuid_str(),
        kind: "text".to_string(),
        prompt: prompt.clone(),
        result: content.clone(),
        created_at: now_str(),
    };

    {
        let mut history = state.history.lock().map_err(|e| format!("锁历史失败: {}", e))?;
        history.insert(0, item);
        if history.len() > 100 {
            history.truncate(100);
        }
    }

    Ok(content)
}

/// 获取生成历史
#[tauri::command]
pub fn get_history(state: State<'_, AppState>) -> Result<Vec<HistoryItem>, String> {
    let history = state.history.lock().map_err(|e| format!("锁历史失败: {}", e))?;
    Ok(history.clone())
}

/// 保存API配置
#[tauri::command]
pub fn save_api_config(state: State<'_, AppState>, base_url: String, api_key: String) -> Result<(), String> {
    let config = ApiConfig {
        base_url,
        api_key,
    };
    ai_client::save_config(&config)?;

    let mut cfg = state.config.lock().map_err(|e| format!("锁配置失败: {}", e))?;
    *cfg = config;

    Ok(())
}

/// 加载API配置
#[tauri::command]
pub fn load_api_config(state: State<'_, AppState>) -> Result<ApiConfig, String> {
    // 先尝试从文件加载
    let config = ai_client::load_config()?;

    // 更新到内存
    {
        let mut cfg = state.config.lock().map_err(|e| format!("锁配置失败: {}", e))?;
        *cfg = config.clone();
    }

    Ok(config)
}

/// 生成UUID字符串
fn uuid_str() -> String {
    use getrandom::getrandom;
    let mut buf = [0u8; 16];
    getrandom(&mut buf).ok();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        buf[0], buf[1], buf[2], buf[3],
        buf[4], buf[5],
        buf[6], buf[7],
        buf[8], buf[9],
        buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]
    )
}

/// 当前时间字符串
fn now_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}
