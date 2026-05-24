use std::time::{SystemTime, UNIX_EPOCH};
use sqlx::SqlitePool;
use serde_json::{json, Value};

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

        let mut image_inputs = Vec::new();
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

        let mut requests_arr = Vec::new();
        for i in 0..n {
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
                    "parts": [{"text": prompt}]
                },
                "imageAspectRatio": aspect_ratio,
                "imageModelName": model_name
            });

            if !image_inputs.is_empty() {
                item["imageInputs"] = json!(image_inputs);
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
