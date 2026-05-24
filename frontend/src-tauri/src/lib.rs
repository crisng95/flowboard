pub mod db;
pub mod services;
pub mod commands;
pub mod worker;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // 1. Resolve DB path
      let storage_dir = services::http_server::get_storage_dir();
      let db_path = storage_dir.join("flowboard.db");
      let db_path_str = db_path.to_string_lossy().to_string();
      println!("[Flowboard] Database path: {}", db_path_str);

      // 2. Connect to DB and run migrations
      let pool = tauri::async_runtime::block_on(async {
          let p = db::establish_connection(&db_path_str)
              .await
              .expect("Failed to connect to SQLite");
          db::init_db(&p)
              .await
              .expect("Failed to initialize SQLite schemas");
          p
      });

      // 3. Initialize flow client singleton
      let fc = services::flow_client::FlowClient::new();

      // 4. Spawn WS and HTTP background servers
      let fc_ws = fc.clone();
      tauri::async_runtime::spawn(async move {
          services::ws_server::run_ws_server(fc_ws).await;
      });

      let fc_http = fc.clone();
      let pool_http = pool.clone();
      tauri::async_runtime::spawn(async move {
          services::http_server::run_http_server(fc_http, pool_http).await;
      });

      let fc_worker = fc.clone();
      let pool_worker = pool.clone();
      tauri::async_runtime::spawn(async move {
          worker::run_request_worker(pool_worker, fc_worker).await;
      });

      // 5. Manage AppState
      app.manage(commands::AppState {
          db_pool: pool,
          flow_client: fc,
      });

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        commands::list_boards,
        commands::create_board,
        commands::get_board,
        commands::patch_board,
        commands::delete_board,
        commands::create_node,
        commands::patch_node,
        commands::delete_node,
        commands::group_nodes,
        commands::ungroup_nodes,
        commands::create_edge,
        commands::patch_edge,
        commands::delete_edge,
        commands::get_auth_me,
        commands::scan_extension,
        commands::logout_extension,
        commands::get_board_project,
        commands::ensure_board_project,
        commands::create_request,
        commands::get_request,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
