mod ai_client;
mod assistant;
mod commands;
mod error;
mod export;
mod history;
mod job;
pub mod pptx;
pub mod reference;
mod secret;
mod stream;
mod templates;

use ai_client::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 深链队列。Arc 是必须的：既要 manage 出去给命令用，又要在下面的 setup 闭包里
    // 拿去 seed 冷启动那一条 —— 两处必须指向同一份队列。
    let zbiz_pending = cap_hub::receiver::SharedPending::default();

    tauri::Builder::default()
        // 单实例（2026-10-26 分发底座）：第二次启动聚焦已有窗口，不再开新进程。
        // 必须作为第一个注册的插件（tauri-plugin-single-instance 官方要求）。
        //
        // 2026-10-30：此前这里是 `_argv`（丢弃），box 发过来的深链收到了但没处理。
        // 现在交给 cap-hub 收口。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            cap_hub::receiver::handle_second_instance(app, &argv);
        }))
        .manage(AppState::default())
        // 深链队列：冷启动 seed 与 second-instance 转发都写它
        .manage(zbiz_pending.clone())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：前端 UpdaterGate 延时 check()，endpoint/pubkey 见 tauri.conf.json
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新安装完成后的「立即重启」
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::submit_generation,
            commands::get_generation,
            commands::list_generations,
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
            commands::prepare_reference_image,
            commands::data_dir_path,
            commands::zbiz_take_pending,
        ])
        .setup(move |app| {
            // 冷启动时 argv 里就可能带着深链。必须早于前端挂监听，
            // 否则那次信号会丢 —— 队列先存着，前端 mount 后主动 take 一次。
            cap_hub::receiver::seed_cold_start(app.handle(), &zbiz_pending);

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
