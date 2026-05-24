use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use axum::{
    extract::{Path as AxumPath, State, Multipart},
    http::{StatusCode, HeaderMap, header},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use tower_http::cors::CorsLayer;

use crate::services::flow_client::FlowClient;

#[derive(Clone)]
struct AppState {
    flow_client: FlowClient,
    db_pool: SqlitePool,
}

pub fn get_storage_dir() -> PathBuf {
    if let Ok(storage_env) = std::env::var("FLOWBOARD_STORAGE") {
        PathBuf::from(storage_env)
    } else {
        PathBuf::from("C:\\Frog\\Tool\\Flow_workflow\\flowboard\\storage")
    }
}

pub async fn run_http_server(flow_client: FlowClient, db_pool: SqlitePool) {
    let state = AppState {
        flow_client,
        db_pool,
    };

    let app = Router::new()
        .route("/api/ext/callback", post(ext_callback))
        .route("/api/health", get(get_health))
        .route("/api/media/:media_id/status", get(get_media_status))
        .route("/api/upload", post(upload_image))
        .route("/api/upload-url", post(upload_image_from_url))
        .route("/api/llm/providers", get(get_llm_providers))
        .route("/api/llm/config", get(get_llm_config).put(put_llm_config))
        .route("/api/activity", get(get_activity))
        .route("/api/references", get(get_references))
        .route("/media/*media_path", get(serve_media_bytes))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:8101").await {
        Ok(l) => {
            println!("[Flowboard HTTP] HTTP server listening on http://127.0.0.1:8101");
            l
        }
        Err(e) => {
            eprintln!("[Flowboard HTTP] Failed to bind HTTP server: {}", e);
            return;
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[Flowboard HTTP] HTTP server error: {}", e);
    }
}

// ─── Callback Handler ────────────────────────────────────────

async fn ext_callback(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let secret = headers
        .get("X-Callback-Secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Constant-time check using simple byte comparison
    let client_secret = &state.flow_client.callback_secret;
    let auth_ok = secret.len() == client_secret.len()
        && secret
            .as_bytes()
            .iter()
            .zip(client_secret.as_bytes())
            .all(|(x, y)| x == y);

    if !auth_ok {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "invalid callback secret" })));
    }

    let id = match payload.get("id").and_then(|i| i.as_str()) {
        Some(id_str) => id_str.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "missing id" }))),
    };

    let resolved = state.flow_client.resolve_callback(id, payload);
    (StatusCode::OK, Json(json!({ "ok": resolved })))
}

async fn get_health(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let ws_stats = state.flow_client.get_ws_stats();
    let extension_connected = state.flow_client.is_connected();
    
    (StatusCode::OK, Json(json!({
        "ok": true,
        "extension_connected": extension_connected,
        "ws_stats": ws_stats,
    })))
}

// ─── Media Handlers ──────────────────────────────────────────

fn normalize_media_id(media_id: &str) -> String {
    if media_id.starts_with("media/") {
        media_id.split_once('/').map(|(_, suffix)| suffix).unwrap_or(media_id).to_string()
    } else {
        media_id.to_string()
    }
}

fn is_valid_media_id(media_id: &str) -> bool {
    // Alphanumeric with dashes, length <= 64
    !media_id.is_empty()
        && media_id.len() <= 64
        && media_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn get_cached_path(media_id: &str) -> Option<PathBuf> {
    if !is_valid_media_id(media_id) {
        return None;
    }
    let media_dir = get_storage_dir().join("media");
    if !media_dir.exists() {
        return None;
    }

    if let Ok(entries) = fs::read_dir(media_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if stem == media_id {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

fn mime_from_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        ".jpg" | ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".mp4" => "video/mp4",
        ".webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn ext_from_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "video/mp4" => ".mp4",
        "video/webm" => ".webm",
        _ => ".bin",
    }
}

async fn serve_media_bytes(
    AxumPath(media_path): AxumPath<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let media_id = normalize_media_id(&media_path);
    if !is_valid_media_id(&media_id) {
        return (StatusCode::BAD_REQUEST, "invalid media_id").into_response();
    }

    // Cache hit
    if let Some(path) = get_cached_path(&media_id) {
        if let Ok(bytes) = fs::read(path.clone()) {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let mime = mime_from_ext(&format!(".{}", ext));
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime)],
                bytes,
            )
                .into_response();
        }
    }

    // Cache miss — Query DB
    let asset_row = match sqlx::query_as::<_, crate::db::models::Asset>(
        "SELECT * FROM asset WHERE uuid_media_id = ? LIMIT 1"
    )
    .bind(&media_id)
    .fetch_optional(&state.db_pool)
    .await
    {
        Ok(Some(r)) => r,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };

    let url = match asset_row.url {
        Some(url_str) if !url_str.is_empty() && url_str.starts_with("https://flow-content.google/") => url_str,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };

    // Download from GCS
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build() {
        Ok(c) => c,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let resp = match client.get(&url).send().await {
        Ok(r) if r.status() == 200 => r,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };

    let mime = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    if !(mime.starts_with("image/") || mime.starts_with("video/")) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let bytes = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    // Cache locally
    let ext = ext_from_mime(&mime);
    let media_dir = get_storage_dir().join("media");
    let _ = fs::create_dir_all(&media_dir);
    let cache_path = media_dir.join(format!("{}{}", media_id, ext));

    if fs::write(&cache_path, &bytes).is_ok() {
        let path_str = cache_path.to_string_lossy().to_string();
        let _ = sqlx::query(
            "UPDATE asset SET local_path = ?, mime = ? WHERE uuid_media_id = ?"
        )
        .bind(&path_str)
        .bind(&mime)
        .bind(&media_id)
        .execute(&state.db_pool)
        .await;
    }

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, mime)],
        bytes,
    )
        .into_response()
}

async fn get_media_status(
    AxumPath(media_path): AxumPath<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let media_id = normalize_media_id(&media_path);
    if !is_valid_media_id(&media_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "available": false, "has_url": false, "reason": "invalid_id" })),
        );
    }

    if let Some(path) = get_cached_path(&media_id) {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let mime = mime_from_ext(&format!(".{}", ext));
        return (
            StatusCode::OK,
            Json(json!({ "available": true, "has_url": true, "mime": mime })),
        );
    }

    let asset_row_res = sqlx::query_as::<_, crate::db::models::Asset>(
        "SELECT * FROM asset WHERE uuid_media_id = ? LIMIT 1"
    )
    .bind(&media_id)
    .fetch_optional(&state.db_pool)
    .await;

    match asset_row_res {
        Ok(Some(row)) => {
            if row.url.is_some() && !row.url.unwrap().is_empty() {
                (
                    StatusCode::OK,
                    Json(json!({ "available": false, "has_url": true, "reason": "not_cached_yet" })),
                )
            } else {
                (
                    StatusCode::OK,
                    Json(json!({ "available": false, "has_url": false, "reason": "no_url_yet" })),
                )
            }
        }
        _ => (
            StatusCode::OK,
            Json(json!({ "available": false, "has_url": false, "reason": "unknown_media" })),
        ),
    }
}

// ─── Image Upload Handlers ─────────────────────────────────────

fn sniff_image_mime(raw: &[u8]) -> Option<&'static str> {
    if raw.len() < 12 {
        return None;
    }
    if raw.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if raw.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if raw.starts_with(b"RIFF") && &raw[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if raw.starts_with(b"GIF87a") || raw.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    None
}

fn sniff_image_dimensions(raw: &[u8]) -> Option<(u32, u32)> {
    if raw.len() < 24 {
        return None;
    }
    if raw.starts_with(b"\x89PNG\r\n\x1a\n") {
        let w = u32::from_be_bytes(raw[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(raw[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if raw.starts_with(b"GIF87a") || raw.starts_with(b"GIF89a") {
        let w = u16::from_le_bytes(raw[6..8].try_into().ok()?) as u32;
        let h = u16::from_le_bytes(raw[8..10].try_into().ok()?) as u32;
        return Some((w, h));
    }
    if raw.starts_with(b"RIFF") && &raw[8..12] == b"WEBP" {
        let chunk = &raw[12..16];
        if chunk == b"VP8 " && raw.len() >= 30 {
            let w = (u16::from_le_bytes(raw[26..28].try_into().ok()?) & 0x3FFF) as u32;
            let h = (u16::from_le_bytes(raw[28..30].try_into().ok()?) & 0x3FFF) as u32;
            return Some((w, h));
        }
        if chunk == b"VP8L" && raw.len() >= 25 {
            let w = (((raw[22] & 0x3F) as u32) << 8 | (raw[21] as u32)) + 1;
            let h = (((raw[24] & 0x0F) as u32) << 10 | ((raw[23] as u32) << 2) | (((raw[22] & 0xC0) as u32) >> 6)) + 1;
            return Some((w, h));
        }
        if chunk == b"VP8X" && raw.len() >= 30 {
            let w = (u32::from_le_bytes([raw[24], raw[25], raw[26], 0]) & 0xFFFFFF) + 1;
            let h = (u32::from_le_bytes([raw[27], raw[28], raw[29], 0]) & 0xFFFFFF) + 1;
            return Some((w, h));
        }
    }
    if raw.starts_with(b"\xff\xd8\xff") {
        let mut i = 2;
        let n = raw.len();
        let sof_markers = [0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF];
        while i < n - 9 {
            if raw[i] != 0xFF {
                return None;
            }
            let marker = raw[i + 1];
            if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
                i += 2;
                continue;
            }
            let seg_len = u16::from_be_bytes(raw[i + 2..i + 4].try_into().ok()?) as usize;
            if sof_markers.contains(&marker) {
                let h = u16::from_be_bytes(raw[i + 5..i + 7].try_into().ok()?) as u32;
                let w = u16::from_be_bytes(raw[i + 7..i + 9].try_into().ok()?) as u32;
                return Some((w, h));
            }
            i += 2 + seg_len;
        }
    }
    None
}

fn classify_aspect(width: u32, height: u32) -> &'static str {
    if width == 0 || height == 0 {
        return "IMAGE_ASPECT_RATIO_LANDSCAPE";
    }
    let ratio = width as f64 / height as f64;
    let candidates: [(&str, f64); 5] = [
        ("IMAGE_ASPECT_RATIO_SQUARE", 1.0),
        ("IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE", 4.0 / 3.0),
        ("IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR", 3.0 / 4.0),
        ("IMAGE_ASPECT_RATIO_LANDSCAPE", 16.0 / 9.0),
        ("IMAGE_ASPECT_RATIO_PORTRAIT", 9.0 / 16.0),
    ];

    let log_ratio = ratio.ln();
    let mut best_key = "IMAGE_ASPECT_RATIO_LANDSCAPE";
    let mut min_dist = f64::MAX;

    for (key, val) in candidates {
        let dist = (log_ratio - val.ln()).abs();
        if dist < min_dist {
            min_dist = dist;
            best_key = key;
        }
    }
    best_key
}

async fn ingest_image_bytes(
    raw: &[u8],
    mime: &str,
    project_id: &str,
    file_name: &str,
    node_id: Option<i64>,
    state: &AppState,
) -> Result<Value, StatusCode> {
    let image_b64 = BASE64.encode(raw);
    let upload_url = "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage";

    let headers = json!({
        "content-type": "text/plain;charset=UTF-8",
        "accept": "*/*",
        "origin": "https://labs.google",
        "referer": "https://labs.google/"
    });

    let body = json!({
        "clientContext": {
            "projectId": project_id,
            "tool": "PINHOLE"
        },
        "fileName": file_name,
        "imageBytes": image_b64,
        "isHidden": false,
        "isUserUploaded": true,
        "mimeType": mime
    });

    // Call extension via WebSocket api_request
    let resp = state.flow_client.api_request(upload_url, "POST", Some(headers), Some(body), None, None).await;

    if let Some(err) = resp.get("error") {
        eprintln!("[Flowboard HTTP] Image upload API request failed: {:?}", err);
        return Err(StatusCode::BAD_GATEWAY);
    }

    let media_id_opt = resp.get("media_id").and_then(|m| m.as_str())
        .or_else(|| {
            resp.get("data")
                .and_then(|d| d.get("media"))
                .and_then(|m| m.get("name"))
                .and_then(|n| n.as_str())
        });

    let media_id = match media_id_opt {
        Some(m) if is_valid_media_id(m) => m.to_string(),
        _ => {
            eprintln!("[Flowboard HTTP] Image upload failed: invalid media_id or missing field. Response: {:?}", resp);
            return Err(StatusCode::BAD_GATEWAY);
        }
    };

    let ext = ext_from_mime(mime);
    let media_dir = get_storage_dir().join("media");
    let _ = fs::create_dir_all(&media_dir);
    let cache_path = media_dir.join(format!("{}{}", media_id, ext));

    if fs::write(&cache_path, raw).is_err() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    // Upsert Asset
    let cache_path_str = cache_path.to_string_lossy().to_string();
    let res = sqlx::query_as::<_, crate::db::models::Asset>(
        "SELECT * FROM asset WHERE uuid_media_id = ? LIMIT 1"
    )
    .bind(&media_id)
    .fetch_optional(&state.db_pool)
    .await;

    match res {
        Ok(Some(_)) => {
            let _ = sqlx::query(
                "UPDATE asset SET local_path = ?, mime = ?, node_id = COALESCE(node_id, ?) WHERE uuid_media_id = ?"
            )
            .bind(&cache_path_str)
            .bind(mime)
            .bind(node_id)
            .bind(&media_id)
            .execute(&state.db_pool)
            .await;
        }
        _ => {
            let _ = sqlx::query(
                "INSERT INTO asset (uuid_media_id, kind, local_path, mime, node_id, created_at) VALUES (?, 'image', ?, ?, ?, datetime('now'))"
            )
            .bind(&media_id)
            .bind(&cache_path_str)
            .bind(mime)
            .bind(node_id)
            .execute(&state.db_pool)
            .await;
        }
    }

    let mut out = json!({
        "media_id": media_id,
        "mime": mime,
        "size": raw.len()
    });

    if let Some((w, h)) = sniff_image_dimensions(raw) {
        out["width"] = json!(w);
        out["height"] = json!(h);
        out["aspect_ratio"] = json!(classify_aspect(w, h));
    }

    Ok(out)
}

async fn upload_image(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut project_id = String::new();
    let mut node_id: Option<i64> = None;
    let mut file_bytes = Vec::new();
    let mut file_name = String::new();
    let mut form_mime = String::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "project_id" {
            if let Ok(val) = field.text().await {
                project_id = val;
            }
        } else if name == "node_id" {
            if let Ok(val_str) = field.text().await {
                if let Ok(val) = val_str.parse::<i64>() {
                    node_id = Some(val);
                }
            }
        } else if name == "file" {
            form_mime = field.content_type().unwrap_or("").to_string();
            file_name = field.file_name().unwrap_or("").to_string();
            if let Ok(bytes) = field.bytes().await {
                file_bytes = bytes.to_vec();
            }
        }
    }

    if project_id.is_empty() || file_bytes.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing field").into_response();
    }

    let mime = sniff_image_mime(&file_bytes).unwrap_or(&form_mime).to_string();
    let allowed_mimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if !allowed_mimes.contains(&mime.as_str()) {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported mime").into_response();
    }

    let max_bytes = 10 * 1024 * 1024;
    if file_bytes.len() > max_bytes {
        return (StatusCode::PAYLOAD_TOO_LARGE, "file too large").into_response();
    }

    if file_name.is_empty() {
        file_name = format!("upload{}", ext_from_mime(&mime));
    }

    match ingest_image_bytes(&file_bytes, &mime, &project_id, &file_name, node_id, &state).await {
        Ok(out) => (StatusCode::OK, Json(out)).into_response(),
        Err(status) => status.into_response(),
    }
}

#[derive(Deserialize)]
struct UrlUploadBody {
    url: String,
    project_id: String,
    node_id: Option<i64>,
}

async fn upload_image_from_url(
    State(state): State<AppState>,
    Json(body): Json<UrlUploadBody>,
) -> impl IntoResponse {
    let parsed_url = match reqwest::Url::parse(&body.url) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid url").into_response(),
    };

    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return (StatusCode::BAD_REQUEST, "invalid scheme").into_response();
    }

    let host = parsed_url.host_str().unwrap_or("");
    if host.is_empty() || host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return (StatusCode::BAD_REQUEST, "non-public host").into_response();
    }

    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build() {
        Ok(c) => c,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let resp = match client.get(&body.url).header("User-Agent", "Flowboard/0.1").send().await {
        Ok(r) if r.status() == 200 => r,
        _ => return (StatusCode::BAD_GATEWAY, "fetch failed").into_response(),
    };

    let mut mime = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_string())
        .unwrap_or_default();

    let bytes = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let max_bytes = 10 * 1024 * 1024;
    if bytes.len() > max_bytes {
        return (StatusCode::PAYLOAD_TOO_LARGE, "file too large").into_response();
    }

    let sniffed = sniff_image_mime(&bytes);
    let allowed_mimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];

    if !allowed_mimes.contains(&mime.as_str()) {
        if let Some(s) = sniffed {
            mime = s.to_string();
        } else {
            return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported mime").into_response();
        }
    } else if let Some(s) = sniffed {
        if s != mime {
            mime = s.to_string();
        }
    }

    let mut file_name = parsed_url
        .path()
        .trim_end_matches('/')
        .split('/')
        .last()
        .unwrap_or("image")
        .to_string();

    if !file_name.contains('.') {
        file_name = format!("{}{}", file_name, ext_from_mime(&mime));
    }

    match ingest_image_bytes(&bytes, &mime, &body.project_id, &file_name, body.node_id, &state).await {
        Ok(out) => (StatusCode::OK, Json(out)).into_response(),
        Err(status) => status.into_response(),
    }
}

async fn get_llm_providers() -> impl IntoResponse {
    let providers = json!([
        {
            "name": "claude",
            "supportsVision": true,
            "available": true,
            "configured": true,
            "requiresKey": false,
            "mode": "cli"
        },
        {
            "name": "gemini",
            "supportsVision": true,
            "available": true,
            "configured": true,
            "requiresKey": false,
            "mode": "cli"
        },
        {
            "name": "openai",
            "supportsVision": true,
            "available": true,
            "configured": true,
            "requiresKey": false,
            "mode": "cli"
        }
    ]);
    (StatusCode::OK, Json(providers))
}

async fn get_llm_config() -> impl IntoResponse {
    let config = json!({
        "auto_prompt": "gemini",
        "vision": "gemini",
        "planner": "gemini",
        "chat": "gemini",
        "configured": true
    });
    (StatusCode::OK, Json(config))
}

async fn put_llm_config(Json(_body): Json<Value>) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "ok": true })))
}

async fn get_activity() -> impl IntoResponse {
    let res = json!({
        "items": [],
        "next_before_id": null
    });
    (StatusCode::OK, Json(res))
}

async fn get_references() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}
