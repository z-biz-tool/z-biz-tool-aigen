use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::fs;
use std::path::PathBuf;

/// API 配置：baseUrl + apiKey
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    pub base_url: String,
    pub api_key: String,
}

impl Default for ApiConfig {
    fn default() -> Self {
        ApiConfig {
            base_url: "https://api.minimax.chat/v1".to_string(),
            api_key: String::new(),
        }
    }
}

/// 生成历史记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub kind: String,       // "image" | "text"
    pub prompt: String,
    pub result: String,     // 图片URL 或 文本内容
    pub created_at: String,
}

/// 全局状态
pub struct AppState {
    pub config: Mutex<ApiConfig>,
    pub history: Mutex<Vec<HistoryItem>>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            config: Mutex::new(ApiConfig::default()),
            history: Mutex::new(Vec::new()),
        }
    }
}

/// 获取配置文件路径
fn config_file_path() -> PathBuf {
    let mut path = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()));
    path.push(".z-biz-tool-aigen");
    path.push("config.json");
    path
}

/// 保存API配置到文件
pub fn save_config(config: &ApiConfig) -> Result<(), String> {
    let path = config_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| format!("序列化配置失败: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

/// 从文件加载API配置
pub fn load_config() -> Result<ApiConfig, String> {
    let path = config_file_path();
    if !path.exists() {
        return Ok(ApiConfig::default());
    }
    let json = fs::read_to_string(&path).map_err(|e| format!("读取配置文件失败: {}", e))?;
    let config: ApiConfig = serde_json::from_str(&json).map_err(|e| format!("解析配置文件失败: {}", e))?;
    Ok(config)
}

/// 调用AI图片生成API（OpenAI兼容格式）
/// 发送 POST {base_url}/images/generations
pub async fn generate_image_api(
    config: &ApiConfig,
    prompt: &str,
    count: u32,
) -> Result<Vec<String>, String> {
    let client = Client::new();

    let body = serde_json::json!({
        "prompt": prompt,
        "n": count,
        "size": "1024x1024",
    });

    let url = format!("{}/images/generations", config.base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求图片生成API失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("图片生成API返回错误 ({}): {}", status, text));
    }

    let resp_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析图片生成响应失败: {}", e))?;

    let mut urls = Vec::new();
    if let Some(data) = resp_json.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(url) = item.get("url").and_then(|u| u.as_str()) {
                urls.push(url.to_string());
            } else if let Some(b64) = item.get("b64_json").and_then(|u| u.as_str()) {
                urls.push(format!("data:image/png;base64,{}", b64));
            }
        }
    }

    if urls.is_empty() {
        return Err("图片生成API未返回有效图片数据".to_string());
    }

    Ok(urls)
}

/// 调用AI文本生成API（OpenAI兼容格式）
/// 发送 POST {base_url}/chat/completions
pub async fn generate_text_api(
    config: &ApiConfig,
    prompt: &str,
    model: &str,
) -> Result<String, String> {
    let client = Client::new();

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.7,
    });

    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求文本生成API失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("文本生成API返回错误 ({}): {}", status, text));
    }

    let resp_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析文本生成响应失败: {}", e))?;

    let content = resp_json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or("文本生成API未返回有效内容")?;

    Ok(content.to_string())
}
