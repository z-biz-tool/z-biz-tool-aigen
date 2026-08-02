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

/// 调用AI视频生成API
/// 兼容多种视频生成服务的接口格式
pub async fn generate_video_api(
    config: &ApiConfig,
    prompt: &str,
    duration: &str,
    resolution: &str,
) -> Result<String, String> {
    let client = Client::new();

    // 视频生成接口格式因服务商而异,这里采用通用 task 提交模式
    // 先提交任务,轮询状态,返回视频URL
    let body = serde_json::json!({
        "prompt": prompt,
        "duration": duration.parse::<u32>().unwrap_or(5),
        "resolution": resolution,
    });

    let url = format!("{}/video/generations", config.base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求视频生成API失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("视频生成API返回错误 ({}): {}", status, text));
    }

    let resp_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析视频生成响应失败: {}", e))?;

    // 尝试多种常见响应格式
    if let Some(url) = resp_json.get("url").and_then(|u| u.as_str()) {
        return Ok(url.to_string());
    }
    if let Some(data) = resp_json.get("data") {
        if let Some(url) = data.get("url").and_then(|u| u.as_str()) {
            return Ok(url.to_string());
        }
        if let Some(video) = data.get("video").and_then(|v| v.as_str()) {
            return Ok(video.to_string());
        }
    }
    if let Some(task_id) = resp_json.get("task_id").and_then(|t| t.as_str()) {
        // 异步任务模式:返回一个占位 URL,实际应轮询 task 状态
        // 简化处理:直接返回 task_id 作为标识,前端显示"任务已提交"
        return Ok(format!("task:{}", task_id));
    }

    Err("视频生成API未返回有效视频URL".to_string())
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

/// 生成PPT文件: 调用AI生成大纲内容,然后写入本地HTML格式的PPT文件
/// 返回本地文件路径,前端通过 file:// 协议或 Tauri 的文件协议访问
pub async fn generate_ppt_file(
    config: &ApiConfig,
    topic: &str,
    template: &str,
    slides: u32,
    outline: &[PptOutlineItem],
) -> Result<String, String> {
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
        let content = generate_text_api(config, &prompt, "gpt-4o-mini").await?;
        // 尝试解析JSON,失败则降级为简单文本
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(arr) = parsed.get("slides").and_then(|s| s.as_array()) {
                for slide in arr {
                    let title = slide.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    let content = slide.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
                    slides_content.push(PptSlide { title, content });
                }
            }
        }
        if slides_content.is_empty() {
            // 降级:创建基本结构
            slides_content.push(PptSlide { title: topic.to_string(), content: "".to_string() });
            for i in 1..slides {
                slides_content.push(PptSlide {
                    title: format!("第 {} 页", i),
                    content: "（待补充内容）".to_string(),
                });
            }
            slides_content.push(PptSlide { title: "谢谢观看".to_string(), content: "".to_string() });
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

    // 第三步: 写入临时文件
    let ppt_dir = std::env::temp_dir().join("z-biz-tool-aigen");
    std::fs::create_dir_all(&ppt_dir).map_err(|e| format!("创建PPT目录失败: {}", e))?;
    let safe_name = topic.chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect::<String>();
    let filename = format!("{}_{}.html", safe_name, now_timestamp());
    let file_path = ppt_dir.join(filename);
    std::fs::write(&file_path, html).map_err(|e| format!("写入PPT文件失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

/// 当前时间戳字符串
fn now_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

/// 渲染PPT为HTML格式(可浏览器直接打开)
fn render_ppt_html(topic: &str, template: &str, slides: &[PptSlide]) -> String {
    let (bg_color, accent_color, text_color) = match template {
        "tech" => ("#0a1929", "#1677ff", "#ffffff"),
        "creative" => ("#fff0f6", "#eb2f96", "#333333"),
        "academic" => ("#fafafa", "#531dab", "#222222"),
        _ => ("#ffffff", "#1677ff", "#333333"), // business
    };

    let slides_html: String = slides.iter().enumerate().map(|(i, slide)| {
        let content_lines: String = slide.content.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| format!("<li>{}</li>", html_escape(l)))
            .collect();
        let is_cover = i == 0;
        let is_end = i == slides.len() - 1;
        let slide_class = if is_cover { "slide cover" } else if is_end { "slide end" } else { "slide" };
        format!(
            r#"<section class="{}"><div class="slide-content">{}</div></section>"#,
            slide_class,
            if is_cover || is_end {
                format!("<h1>{}</h1>", html_escape(&slide.title))
            } else {
                format!("<h2>{}</h2><ul>{}</ul>", html_escape(&slide.title), content_lines)
            }
        )
    }).collect();

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
