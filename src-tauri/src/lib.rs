mod ai_client;
mod assistant;
mod commands;
mod error;
mod export;
mod history;
mod secret;
mod stream;
mod templates;

use ai_client::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::generate_image,
            commands::generate_text,
            commands::generate_text_stream,
            commands::generate_video,
            commands::poll_video,
            commands::generate_ppt,
            commands::cancel_generation,
            commands::list_history,
            commands::delete_history,
            commands::clear_history,
            commands::set_history_favorite,
            commands::save_api_config,
            commands::load_api_config,
            commands::delete_provider,
            commands::set_active_provider,
            commands::test_provider,
            commands::list_templates,
            commands::save_template,
            commands::delete_template,
            commands::set_template_favorite,
            commands::render_template,
            commands::assist_generation,
            commands::save_export,
            commands::data_dir_path,
        ])
        .setup(|app| {
            // 启动即从加密存储载入密钥：渲染进程从不调用也能生成（P0-0）
            let state = app.state::<AppState>();
            if let Err(e) = state.load_config() {
                // 配置损坏不应阻止应用启动，用户可在配置弹窗重新保存
                eprintln!("[aigen] 载入 API 配置失败（{}）：使用默认配置", e.code);
            }
            let dropped = state
                .history
                .lock()
                .map(|h| h.dropped_lines())
                .unwrap_or_default();
            if dropped > 0 {
                eprintln!(
                    "[aigen] 历史文件存在 {dropped} 行损坏，已跳过并备份为 history.jsonl.bak"
                );
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
