use std::time::{SystemTime, UNIX_EPOCH};
use std::fs;
use sqlx::SqlitePool;
use serde_json::{json, Value};
use base64::Engine as _;

use crate::services::flow_client::FlowClient;
use crate::db::models::Request;

fn resolve_image_model(key: Option<&str>) -> &'static str {
    match key {
        Some("NANO_BANANA_PRO") => "GEM_PIX_2",
        Some("NANO_OMNI") => "GEM_OMNI_1",
        Some("NANO_BANANA_2") => "NARWHAL",
        _ => "GEM_PIX_2", // Default to Pro
    }
}

const VIDEO_I2V_URL: &str = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage";
const VIDEO_OMNI_URL: &str = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages";
const VIDEO_POLL_URL: &str = "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus";
const VIDEO_CAPTCHA_ACTION: &str = "VIDEO_GENERATION";
const VIDEO_POLL_INTERVAL_MS: u64 = 10_000;
const VIDEO_POLL_MAX_CYCLES: usize = 30;

fn resolve_video_model(paygate_tier: &str, aspect_ratio: &str, quality: Option<&str>) -> Option<&'static str> {
    let q = quality.unwrap_or("fast").to_ascii_lowercase();
    match paygate_tier {
        "PAYGATE_TIER_TWO" => match q.as_str() {
            "lite" => Some("veo_3_1_i2v_lite"),
            "fast" => match aspect_ratio {
                "VIDEO_ASPECT_RATIO_PORTRAIT" => Some("veo_3_1_i2v_s_fast_portrait_ultra"),
                _ => Some("veo_3_1_i2v_s_fast_ultra"),
            },
            "quality" => match aspect_ratio {
                "VIDEO_ASPECT_RATIO_PORTRAIT" => Some("veo_3_1_i2v_s_portrait"),
                _ => Some("veo_3_1_i2v_s"),
            },
            "lite_relaxed" => Some("veo_3_1_i2v_lite_low_priority"),
            "fast_relaxed" => Some("veo_3_1_i2v_s_fast_ultra_relaxed"),
            _ => match aspect_ratio {
                "VIDEO_ASPECT_RATIO_PORTRAIT" => Some("veo_3_1_i2v_s_fast_portrait_ultra"),
                _ => Some("veo_3_1_i2v_s_fast_ultra"),
            },
        },
        _ => match q.as_str() {
            "lite" => Some("veo_3_1_i2v_lite"),
            "quality" => match aspect_ratio {
                "VIDEO_ASPECT_RATIO_PORTRAIT" => Some("veo_3_1_i2v_s_portrait"),
                _ => Some("veo_3_1_i2v_s"),
            },
            _ => match aspect_ratio {
                "VIDEO_ASPECT_RATIO_PORTRAIT" => Some("veo_3_1_i2v_s_fast_portrait"),
                _ => Some("veo_3_1_i2v_s_fast"),
            },
        },
    }
}

fn resolve_omni_flash_model(duration_s: i64) -> Option<&'static str> {
    match duration_s {
        4 => Some("abra_r2v_4s"),
        6 => Some("abra_r2v_6s"),
        8 => Some("abra_r2v_8s"),
        10 => Some("abra_r2v_10s"),
        _ => None,
    }
}

fn extract_operation_names(resp: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(ops) = resp.get("data").and_then(|d| d.get("operations")).and_then(|o| o.as_array()) {
        for op in ops {
            let name = op
                .get("operation")
                .and_then(|i| i.get("name"))
                .and_then(|n| n.as_str())
                .or_else(|| op.get("name").and_then(|n| n.as_str()));
            if let Some(name) = name {
                out.push(name.to_string());
            }
        }
    }
    if !out.is_empty() {
        return out;
    }
    if let Some(workflows) = resp.get("data").and_then(|d| d.get("workflows")).and_then(|w| w.as_array()) {
        for wf in workflows {
            if let Some(name) = wf.get("name").and_then(|n| n.as_str()) {
                out.push(name.to_string());
            }
        }
    }
    out
}

fn extract_video_workflows(resp: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(workflows) = resp.get("data").and_then(|d| d.get("workflows")).and_then(|w| w.as_array()) {
        for wf in workflows {
            let Some(name) = wf.get("name").and_then(|n| n.as_str()) else { continue };
            let Some(primary) = wf
                .get("metadata")
                .and_then(|m| m.get("primaryMediaId"))
                .and_then(|p| p.as_str())
            else { continue };
            if !name.is_empty() && !primary.is_empty() {
                out.push((name.to_string(), primary.to_string()));
            }
        }
    }
    out
}

fn media_id_from_url(url: Option<&str>) -> Option<String> {
    let url = url?;
    for seg in url.split('/') {
        if seg.len() == 36 {
            let bytes = seg.as_bytes();
            if bytes.get(8) == Some(&b'-')
                && bytes.get(13) == Some(&b'-')
                && bytes.get(18) == Some(&b'-')
                && bytes.get(23) == Some(&b'-')
            {
                return Some(seg.to_string());
            }
        }
    }
    None
}

async fn ingest_inline_video_bytes(
    pool: &SqlitePool,
    media_id: &str,
    bytes: &[u8],
) {
    if bytes.is_empty() {
        return;
    }
    let media_dir = crate::services::http_server::get_storage_dir().join("media");
    let _ = fs::create_dir_all(&media_dir);
    let cache_path = media_dir.join(format!("{}.mp4", media_id));
    if fs::write(&cache_path, bytes).is_err() {
        return;
    }
    let path_str = cache_path.to_string_lossy().to_string();
    let updated = sqlx::query(
        "UPDATE asset SET local_path = ?, mime = ? WHERE uuid_media_id = ?"
    )
    .bind(&path_str)
    .bind("video/mp4")
    .bind(media_id)
    .execute(pool)
    .await;
    if let Ok(done) = updated {
        if done.rows_affected() == 0 {
            let _ = sqlx::query(
                "INSERT INTO asset (kind, uuid_media_id, local_path, mime, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
            )
            .bind("video")
            .bind(media_id)
            .bind(&path_str)
            .bind("video/mp4")
            .execute(pool)
            .await;
        }
    }
}

fn extract_video_operations(resp: &Value, requested: &[String]) -> Vec<Value> {
    use std::collections::HashMap;

    let mut by_name: HashMap<String, Value> = HashMap::new();
    if let Some(ops) = resp.get("data").and_then(|d| d.get("operations")).and_then(|o| o.as_array()) {
        for op in ops {
            let inner = op.get("operation").unwrap_or(op);
            let Some(name) = inner.get("name").and_then(|n| n.as_str()) else { continue };
            let video_meta = inner
                .get("metadata")
                .and_then(|m| m.get("video"))
                .and_then(|v| v.as_object());
            let status = op.get("status").and_then(|s| s.as_str());
            let fife_url = video_meta
                .and_then(|m| m.get("fifeUrl"))
                .and_then(|v| v.as_str());
            let media_id = video_meta
                .and_then(|m| m.get("mediaId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| media_id_from_url(fife_url));
            let op_error = inner
                .get("error")
                .and_then(|e| e.get("message").or_else(|| e.get("status")))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    if status == Some("MEDIA_GENERATION_STATUS_FAILED") {
                        Some("MEDIA_GENERATION_STATUS_FAILED".to_string())
                    } else {
                        None
                    }
                });
            let done = status == Some("MEDIA_GENERATION_STATUS_SUCCESSFUL")
                || status == Some("MEDIA_GENERATION_STATUS_FAILED")
                || inner.get("done").and_then(|v| v.as_bool()).unwrap_or(false)
                || (media_id.is_some() && fife_url.is_some());
            let media_entries = if done && op_error.is_none() {
                if let Some(mid) = &media_id {
                    json!([{ "media_id": mid, "url": fife_url, "mediaType": "video" }])
                } else {
                    json!([])
                }
            } else {
                json!([])
            };
            by_name.insert(name.to_string(), json!({
                "name": name,
                "done": done,
                "media_entries": media_entries,
                "status": status,
                "error": op_error,
            }));
        }
    }
    requested
        .iter()
        .map(|name| by_name.get(name).cloned().unwrap_or_else(|| json!({
            "name": name,
            "done": false,
            "media_entries": [],
        })))
        .collect()
}

async fn poll_video_operations(
    flow_client: &FlowClient,
    pool: &SqlitePool,
    headers: &Value,
    operation_names: &[String],
    workflows: &[(String, String)],
) -> Result<Value, String> {
    for _ in 0..VIDEO_POLL_MAX_CYCLES {
        let workflow_names: std::collections::HashSet<&str> =
            workflows.iter().map(|(name, _)| name.as_str()).collect();
        let old_names: Vec<String> = operation_names
            .iter()
            .filter(|name| !workflow_names.contains(name.as_str()))
            .cloned()
            .collect();

        let mut ops = Vec::new();
        if !old_names.is_empty() {
            let body = json!({
                "operations": old_names.iter().map(|name| json!({
                    "operation": { "name": name }
                })).collect::<Vec<Value>>()
            });
            let resp = flow_client
                .api_request(VIDEO_POLL_URL, "POST", Some(headers.clone()), Some(body), None, None)
                .await;
            if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
                return Err(err.to_string());
            }
            ops.extend(extract_video_operations(&resp, &old_names));
        }

        for (name, primary_media_id) in workflows {
            let url = format!(
                "https://aisandbox-pa.googleapis.com/v1/media/{}?clientContext.tool=PINHOLE",
                primary_media_id
            );
            let resp = flow_client
                .api_request(&url, "GET", Some(headers.clone()), None, None, None)
                .await;
            let status_code = resp.get("status").and_then(|s| s.as_i64());
            if matches!(status_code, Some(code) if code >= 400 && code != 404) {
                let msg = resp
                    .get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("API_{}", status_code.unwrap_or(500)));
                ops.push(json!({
                    "name": name,
                    "done": true,
                    "media_entries": [],
                    "status": Value::Null,
                    "error": msg,
                }));
                continue;
            }
            let encoded = resp
                .get("data")
                .and_then(|d| d.get("video"))
                .and_then(|v| v.get("encodedVideo"))
                .and_then(|e| e.as_str());
            let decoded = encoded.and_then(|encoded| {
                base64::engine::general_purpose::STANDARD.decode(encoded).ok()
            });
            let done = if let Some(bytes) = decoded.as_ref() {
                bytes.len() >= 12 && &bytes[4..8] == b"ftyp"
            } else {
                false
            };
            if done {
                if let Some(bytes) = decoded.as_ref() {
                    ingest_inline_video_bytes(pool, primary_media_id, bytes).await;
                }
            }
            let media_entries = if done {
                json!([{ "media_id": primary_media_id, "url": Value::Null, "mediaType": "video" }])
            } else {
                json!([])
            };
            ops.push(json!({
                "name": name,
                "done": done,
                "media_entries": media_entries,
                "status": Value::Null,
                "error": Value::Null,
            }));
        }

        let mut ordered_ops = Vec::new();
        for name in operation_names {
            if let Some(op) = ops.iter().find(|op| op.get("name").and_then(|n| n.as_str()) == Some(name.as_str())) {
                ordered_ops.push(op.clone());
            } else {
                ordered_ops.push(json!({
                    "name": name,
                    "done": false,
                    "media_entries": [],
                }));
            }
        }
        let mut done = true;
        let mut media_ids = Vec::new();
        let mut media_entries = Vec::new();
        for op in &ordered_ops {
            if let Some(err) = op.get("error").and_then(|e| e.as_str()) {
                return Err(err.to_string());
            }
            if !op.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                done = false;
            }
            if let Some(entries) = op.get("media_entries").and_then(|m| m.as_array()) {
                for entry in entries {
                    if let Some(mid) = entry.get("media_id").cloned() {
                        media_ids.push(mid);
                    }
                    media_entries.push(entry.clone());
                }
            }
        }
        if done {
            ingest_urls(pool, &media_entries).await;
            return Ok(json!({
                "media_ids": media_ids,
                "media_entries": media_entries,
                "operations": ordered_ops,
            }));
        }
        tokio::time::sleep(std::time::Duration::from_millis(VIDEO_POLL_INTERVAL_MS)).await;
    }
    Err("timeout_waiting_video".to_string())
}

fn extract_media_entries(resp: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(data) = resp.get("data") {
        if let Some(media) = data.get("media").and_then(|m| m.as_array()) {
            for m in media {
                if let Some(media_id) = m.get("name").and_then(|n| n.as_str()) {
                    let mut url = None;
                    let mut kind = "image";
                    
                    if let Some(image) = m.get("image") {
                        if let Some(gen) = image.get("generatedImage") {
                            if let Some(fife_url) = gen.get("fifeUrl").and_then(|f| f.as_str()) {
                                url = Some(fife_url);
                            }
                        }
                        kind = "image";
                    } else if let Some(video) = m.get("video") {
                        let gen = video.get("generatedVideo").or_else(|| video.get("generatedImage"));
                        if let Some(fife_url) = gen.and_then(|g| g.get("fifeUrl")).and_then(|f| f.as_str()) {
                            url = Some(fife_url);
                        }
                        kind = "video";
                    }

                    out.push(json!({
                        "media_id": media_id,
                        "url": url,
                        "mediaType": kind
                    }));
                }
            }
        }
    }
    out
}

async fn ingest_urls(pool: &SqlitePool, entries: &[Value]) {
    for entry in entries {
        if let (Some(media_id), Some(url), Some(kind)) = (
            entry.get("media_id").and_then(|m| m.as_str()),
            entry.get("url").and_then(|u| u.as_str()),
            entry.get("mediaType").and_then(|t| t.as_str()),
        ) {
            let existing = sqlx::query(
                "SELECT id FROM asset WHERE uuid_media_id = ? LIMIT 1"
            )
            .bind(media_id)
            .fetch_optional(pool)
            .await;

            if let Ok(None) = existing {
                let _ = sqlx::query(
                    "INSERT INTO asset (kind, uuid_media_id, url, created_at) VALUES (?, ?, ?, datetime('now'))"
                )
                .bind(kind)
                .bind(media_id)
                .bind(url)
                .execute(pool)
                .await;
            }
        }
    }
}

pub async fn run_request_worker(pool: SqlitePool, flow_client: FlowClient) {
    println!("[Flowboard Worker] Request worker spawned and polling...");
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        // Fetch next queued request
        let request_res = sqlx::query_as::<_, Request>(
            "SELECT * FROM request WHERE status = 'queued' ORDER BY id ASC LIMIT 1"
        )
        .fetch_optional(&pool)
        .await;

        let req = match request_res {
            Ok(Some(r)) => r,
            _ => continue,
        };

        let rid = req.id;
        let node_id = req.node_id;

        // Mark as running
        let _ = sqlx::query("UPDATE request SET status = 'running' WHERE id = ?").bind(rid).execute(&pool).await;
        if let Some(nid) = node_id {
            let _ = sqlx::query("UPDATE node SET status = 'running' WHERE id = ?").bind(nid).execute(&pool).await;
        }

        // Process request
        match process_request(&req, &flow_client, &pool).await {
            Ok(res_val) => {
                let result_str = res_val.to_string();
                let _ = sqlx::query(
                    "UPDATE request SET status = 'done', result = ?, finished_at = datetime('now') WHERE id = ?"
                )
                .bind(&result_str)
                .bind(rid)
                .execute(&pool)
                .await;

                if let Some(nid) = node_id {
                    let media_ids = res_val.get("media_ids").cloned().unwrap_or(json!([]));
                    let media_id = media_ids.get(0).cloned().unwrap_or(json!(null));
                    
                    if let Ok(Some(node)) = sqlx::query_as::<_, crate::db::models::Node>(
                        "SELECT * FROM node WHERE id = ?"
                    )
                    .bind(nid)
                    .fetch_optional(&pool)
                    .await
                    {
                        let mut current_data = match node.data {
                            Value::Object(map) => map,
                            _ => serde_json::Map::new(),
                        };
                        
                        current_data.insert("mediaId".to_string(), media_id);
                        current_data.insert("mediaIds".to_string(), media_ids);
                        
                        let now_str = chrono::Utc::now().to_rfc3339();
                        current_data.insert("renderedAt".to_string(), json!(now_str));
                        
                        let final_data = Value::Object(current_data);
                        let final_data_str = final_data.to_string();

                        let _ = sqlx::query(
                            "UPDATE node SET status = 'done', data = ? WHERE id = ?"
                        )
                        .bind(&final_data_str)
                        .bind(nid)
                        .execute(&pool)
                        .await;
                    }
                }
            }
            Err(err_msg) => {
                println!("[Flowboard Worker] Request {} failed: {}", rid, err_msg);
                let _ = sqlx::query(
                    "UPDATE request SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?"
                )
                .bind(&err_msg)
                .bind(rid)
                .execute(&pool)
                .await;

                if let Some(nid) = node_id {
                    if let Ok(Some(node)) = sqlx::query_as::<_, crate::db::models::Node>(
                        "SELECT * FROM node WHERE id = ?"
                    )
                    .bind(nid)
                    .fetch_optional(&pool)
                    .await
                    {
                        let mut current_data = match node.data {
                            Value::Object(map) => map,
                            _ => serde_json::Map::new(),
                        };
                        current_data.insert("error".to_string(), json!(err_msg));
                        let final_data = Value::Object(current_data).to_string();

                        let _ = sqlx::query(
                            "UPDATE node SET status = 'error', data = ? WHERE id = ?"
                        )
                        .bind(&final_data)
                        .bind(nid)
                        .execute(&pool)
                        .await;
                    }
                }
            }
        }
    }
}

async fn process_request(
    req: &Request,
    flow_client: &FlowClient,
    pool: &SqlitePool,
) -> Result<Value, String> {
    let params = &req.params;
    let req_type = &req.r#type;

    let project_id = params.get("project_id").and_then(|p| p.as_str()).ok_or("missing project_id")?;
    let paygate_tier = params.get("paygate_tier").and_then(|t| t.as_str()).unwrap_or("PAYGATE_TIER_ONE");
    let aspect_ratio = params.get("aspect_ratio").and_then(|a| a.as_str()).unwrap_or("IMAGE_ASPECT_RATIO_LANDSCAPE");
    let prompt = params.get("prompt").and_then(|p| p.as_str()).unwrap_or("");

    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let ctx = json!({
        "projectId": project_id,
        "recaptchaContext": {
            "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
            "token": ""
        },
        "sessionId": format!(";{}", ts),
        "tool": "PINHOLE",
        "userPaygateTier": paygate_tier
    });

    let headers = json!({
        "content-type": "text/plain;charset=UTF-8",
        "accept": "*/*",
        "origin": "https://labs.google",
        "referer": "https://labs.google/"
    });

    if req_type == "gen_image" {
        let variant_count = params.get("variant_count").and_then(|v| v.as_i64()).unwrap_or(1);
        let n = variant_count.clamp(1, 4);
        let image_model = params.get("image_model").and_then(|m| m.as_str());
        let model_name = resolve_image_model(image_model);
        let prompts = params.get("prompts").and_then(|p| p.as_array());

        let mut image_inputs_all = Vec::new();
        if let Some(refs) = params.get("ref_media_ids").and_then(|r| r.as_array()) {
            for mid in refs {
                if let Some(mid_str) = mid.as_str() {
                    image_inputs_all.push(mid_str.to_string());
                }
            }
        }

        let mut requests_arr = Vec::new();
        for i in 0..n {
            let idx = i as usize;
            let item_prompt = if let Some(p_arr) = prompts {
                if idx < p_arr.len() {
                    p_arr[idx].as_str().unwrap_or(prompt)
                } else {
                    prompt
                }
            } else {
                prompt
            };

            let seed = (ts + (i as u128) * 9973) % 1_000_000;
            let mut item = json!({
                "clientContext": {
                    "projectId": project_id,
                    "recaptchaContext": {
                        "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
                        "token": ""
                    },
                    "sessionId": format!(";{}", ts + (i as u128)),
                    "tool": "PINHOLE",
                    "userPaygateTier": paygate_tier
                },
                "seed": seed,
                "structuredPrompt": {
                    "parts": [{"text": item_prompt}]
                },
                "imageAspectRatio": aspect_ratio,
                "imageModelName": model_name
            });

            let mut item_inputs = Vec::new();
            if !image_inputs_all.is_empty() {
                if let Some(p_arr) = prompts {
                    if p_arr.len() == image_inputs_all.len() && idx < image_inputs_all.len() {
                        item_inputs.push(json!({
                            "name": image_inputs_all[idx],
                            "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"
                        }));
                    } else {
                        for mid_str in &image_inputs_all {
                            item_inputs.push(json!({
                                "name": mid_str,
                                "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"
                            }));
                        }
                    }
                } else {
                    for mid_str in &image_inputs_all {
                        item_inputs.push(json!({
                            "name": mid_str,
                            "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"
                            }));
                    }
                }
            }

            if !item_inputs.is_empty() {
                item["imageInputs"] = json!(item_inputs);
            }
            requests_arr.push(item);
        }

        let body = json!({
            "clientContext": ctx,
            "mediaGenerationContext": {
                "batchId": uuid::Uuid::new_v4().to_string()
            },
            "useNewMedia": true,
            "requests": requests_arr
        });

        let url = format!("https://aisandbox-pa.googleapis.com/v1/projects/{}/flowMedia:batchGenerateImages", project_id);
        let resp = flow_client.api_request(&url, "POST", Some(headers), Some(body), Some("IMAGE_GENERATION"), None).await;

        if let Some(err) = resp.get("error") {
            return Err(err.as_str().unwrap_or("Extension API request failed").to_string());
        }

        let entries = extract_media_entries(&resp);
        ingest_urls(pool, &entries).await;

        let media_ids: Vec<Value> = entries.iter().map(|e| e.get("media_id").cloned().unwrap_or(json!(""))).collect();
        Ok(json!({
            "media_ids": media_ids,
            "media_entries": entries
        }))
    } else if req_type == "gen_video" {
        let start_media_ids = params
            .get("start_media_ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        let mut sources = start_media_ids;
        if sources.is_empty() {
            if let Some(mid) = params.get("start_media_id").and_then(|s| s.as_str()) {
                if !mid.is_empty() {
                    sources.push(mid.to_string());
                }
            }
        }
        if sources.is_empty() {
            return Err("missing_start_media_id".to_string());
        }
        let quality = params.get("video_quality").and_then(|q| q.as_str());
        let Some(model_key) = resolve_video_model(paygate_tier, aspect_ratio, quality) else {
            return Err("no_video_model_for_requested_tier_quality_aspect".to_string());
        };
        let mut requests_arr = Vec::new();
        for (i, mid) in sources.iter().enumerate() {
            let seed = (ts + (i as u128) * 9973) % 1_000_000;
            requests_arr.push(json!({
                "aspectRatio": aspect_ratio,
                "seed": seed,
                "textInput": { "structuredPrompt": { "parts": [{"text": prompt}] } },
                "videoModelKey": model_key,
                "startImage": { "mediaId": mid },
                "metadata": { "sceneId": uuid::Uuid::new_v4().to_string() }
            }));
        }
        let body = json!({
            "clientContext": ctx,
            "mediaGenerationContext": {
                "batchId": uuid::Uuid::new_v4().to_string()
            },
            "requests": requests_arr,
            "useV2ModelConfig": true
        });
        let resp = flow_client
            .api_request(VIDEO_I2V_URL, "POST", Some(headers.clone()), Some(body), Some(VIDEO_CAPTCHA_ACTION), None)
            .await;
        if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }
        let operation_names = extract_operation_names(&resp);
        let workflows = extract_video_workflows(&resp);
        if operation_names.is_empty() && workflows.is_empty() {
            return Err("no_operations_in_response".to_string());
        }
        let names = if operation_names.is_empty() {
            workflows.iter().map(|(name, _)| name.clone()).collect::<Vec<String>>()
        } else {
            operation_names
        };
        poll_video_operations(flow_client, pool, &headers, &names, &workflows).await
    } else if req_type == "gen_video_omni" {
        let ref_media_ids = params
            .get("ref_media_ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        if ref_media_ids.is_empty() {
            return Err("missing_ref_media_ids".to_string());
        }
        let duration_s = params.get("duration_s").and_then(|d| d.as_i64()).unwrap_or(4);
        let Some(model_key) = resolve_omni_flash_model(duration_s) else {
            return Err(format!("omni_duration_unsupported_{}", duration_s));
        };
        if aspect_ratio != "VIDEO_ASPECT_RATIO_PORTRAIT" && aspect_ratio != "VIDEO_ASPECT_RATIO_LANDSCAPE" {
            return Err(format!("omni_aspect_unsupported_{}", aspect_ratio));
        }
        let request_item = json!({
            "aspectRatio": aspect_ratio,
            "textInput": { "structuredPrompt": { "parts": [{"text": prompt}] } },
            "videoModelKey": model_key,
            "seed": ts % 1_000_000,
            "metadata": {},
            "referenceImages": ref_media_ids.iter().map(|mid| json!({
                "mediaId": mid,
                "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"
            })).collect::<Vec<Value>>()
        });
        let body = json!({
            "mediaGenerationContext": {
                "batchId": uuid::Uuid::new_v4().to_string(),
                "audioFailurePreference": "BLOCK_SILENCED_VIDEOS"
            },
            "clientContext": {
                "projectId": project_id,
                "recaptchaContext": {
                    "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
                    "token": ""
                },
                "sessionId": format!(";{}", ts),
                "tool": "PINHOLE",
                "userPaygateTier": paygate_tier
            },
            "requests": [request_item],
            "useV2ModelConfig": true
        });
        let resp = flow_client
            .api_request(VIDEO_OMNI_URL, "POST", Some(headers.clone()), Some(body), Some(VIDEO_CAPTCHA_ACTION), None)
            .await;
        if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }
        let operation_names = extract_operation_names(&resp);
        let workflows = extract_video_workflows(&resp);
        if operation_names.is_empty() && workflows.is_empty() {
            return Err("no_operations_in_response".to_string());
        }
        let names = if operation_names.is_empty() {
            workflows.iter().map(|(name, _)| name.clone()).collect::<Vec<String>>()
        } else {
            operation_names
        };
        poll_video_operations(flow_client, pool, &headers, &names, &workflows).await
    } else if req_type == "gen_part" || req_type == "gen_variant" {
        let source_media_id = params.get("source_media_id").and_then(|s| s.as_str()).ok_or("missing source_media_id")?;
        let image_model = params.get("image_model").and_then(|m| m.as_str());
        let model_name = resolve_image_model(image_model);

        let mut image_inputs = vec![
            json!({
                "name": source_media_id,
                "imageInputType": "IMAGE_INPUT_TYPE_BASE_IMAGE"
            })
        ];
        
        if let Some(refs) = params.get("ref_media_ids").and_then(|r| r.as_array()) {
            for mid in refs {
                if let Some(mid_str) = mid.as_str() {
                    image_inputs.push(json!({
                        "name": mid_str,
                        "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"
                    }));
                }
            }
        }

        let n = if req_type == "gen_variant" {
            params.get("variant_count").and_then(|v| v.as_i64()).unwrap_or(1).clamp(1, 4)
        } else {
            1
        };

        let mut requests_arr = Vec::new();
        for i in 0..n {
            let seed = (ts + (i as u128) * 9973) % 1_000_000;
            let item = json!({
                "clientContext": {
                    "projectId": project_id,
                    "recaptchaContext": {
                        "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
                        "token": ""
                    },
                    "sessionId": format!(";{}", ts + (i as u128)),
                    "tool": "PINHOLE",
                    "userPaygateTier": paygate_tier
                },
                "seed": seed,
                "structuredPrompt": {
                    "parts": [{"text": prompt}]
                },
                "imageAspectRatio": aspect_ratio,
                "imageModelName": model_name,
                "imageInputs": image_inputs
            });
            requests_arr.push(item);
        }

        let body = json!({
            "clientContext": ctx,
            "mediaGenerationContext": {
                "batchId": uuid::Uuid::new_v4().to_string()
            },
            "useNewMedia": true,
            "requests": requests_arr
        });

        let url = format!("https://aisandbox-pa.googleapis.com/v1/projects/{}/flowMedia:batchGenerateImages", project_id);
        let resp = flow_client.api_request(&url, "POST", Some(headers), Some(body), Some("IMAGE_GENERATION"), None).await;

        if let Some(err) = resp.get("error") {
            return Err(err.as_str().unwrap_or("Extension API request failed").to_string());
        }

        let entries = extract_media_entries(&resp);
        ingest_urls(pool, &entries).await;

        let media_ids: Vec<Value> = entries.iter().map(|e| e.get("media_id").cloned().unwrap_or(json!(""))).collect();
        Ok(json!({
            "media_ids": media_ids,
            "media_entries": entries
        }))
    } else {
        Err(format!("unsupported request type: {}", req_type))
    }
}
