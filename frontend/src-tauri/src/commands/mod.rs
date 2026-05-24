use std::collections::HashSet;
use tauri::State;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use rand::seq::SliceRandom;

use crate::db::models::{Board, Node, Edge, BoardFlowProject};
use crate::services::flow_client::FlowClient;

pub struct AppState {
    pub db_pool: SqlitePool,
    pub flow_client: FlowClient,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BoardDetail {
    pub board: Board,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GroupResponse {
    pub group: Node,
    pub children: Vec<Node>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UngroupResponse {
    pub deleted_group_id: i64,
    pub children: Vec<Node>,
}

// ─── Short ID Generator ─────────────────────────────────────

fn generate_short_id() -> String {
    let alphabet: Vec<char> = "0123456789abcdefghijklmnopqrstuvwxyz".chars().collect();
    let mut rng = &mut rand::thread_rng();
    (0..4)
        .map(|_| *alphabet.choose(&mut rng).unwrap())
        .collect()
}

async fn generate_unique_short_id(pool: &SqlitePool, board_id: i64) -> Result<String, String> {
    for _ in 0..16 {
        let candidate = generate_short_id();
        let existing = sqlx::query_as::<_, Node>(
            "SELECT * FROM node WHERE board_id = ? AND short_id = ? LIMIT 1"
        )
        .bind(board_id)
        .bind(&candidate)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

        if existing.is_none() {
            return Ok(candidate);
        }
    }
    Err("short_id space exhausted after 16 attempts".to_string())
}

// ─── Board Commands ─────────────────────────────────────────

#[tauri::command]
pub async fn list_boards(state: State<'_, AppState>) -> Result<Vec<Board>, String> {
    sqlx::query_as::<_, Board>("SELECT * FROM board ORDER BY created_at DESC")
        .fetch_all(&state.db_pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_board(state: State<'_, AppState>, name: String) -> Result<Board, String> {
    sqlx::query_as::<_, Board>(
        "INSERT INTO board (name, created_at) VALUES (?, datetime('now')) RETURNING *"
    )
    .bind(name)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_board(state: State<'_, AppState>, id: i64) -> Result<BoardDetail, String> {
    let board = sqlx::query_as::<_, Board>("SELECT * FROM board WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "board not found".to_string())?;

    let nodes = sqlx::query_as::<_, Node>("SELECT * FROM node WHERE board_id = ?")
        .bind(id)
        .fetch_all(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?;

    let edges = sqlx::query_as::<_, Edge>("SELECT * FROM edge WHERE board_id = ?")
        .bind(id)
        .fetch_all(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(BoardDetail { board, nodes, edges })
}

#[tauri::command]
pub async fn patch_board(state: State<'_, AppState>, id: i64, name: String) -> Result<Board, String> {
    sqlx::query_as::<_, Board>(
        "UPDATE board SET name = ? WHERE id = ? RETURNING *"
    )
    .bind(name)
    .bind(id)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_board(state: State<'_, AppState>, id: i64) -> Result<Value, String> {
    let res = sqlx::query("DELETE FROM board WHERE id = ?")
        .bind(id)
        .execute(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({ "deleted": res.rows_affected() }))
}

// ─── Node Commands ──────────────────────────────────────────

#[derive(Deserialize)]
pub struct NodeCreateInput {
    pub board_id: i64,
    pub r#type: String,
    pub x: f64,
    pub y: f64,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub data: Option<Value>,
    pub status: Option<String>,
    pub parent_id: Option<i64>,
}

#[tauri::command]
pub async fn create_node(
    state: State<'_, AppState>,
    input: NodeCreateInput,
) -> Result<Node, String> {
    // Check board existence
    let board_exists = sqlx::query_as::<_, Board>("SELECT * FROM board WHERE id = ? LIMIT 1")
        .bind(input.board_id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?
        .is_some();

    if !board_exists {
        return Err("board not found".to_string());
    }

    if let Some(pid) = input.parent_id {
        let parent = sqlx::query_as::<_, Node>("SELECT * FROM node WHERE id = ? LIMIT 1")
            .bind(pid)
            .fetch_optional(&state.db_pool)
            .await
            .map_err(|e| e.to_string())?;

        match parent {
            Some(p) if p.board_id != input.board_id => {
                return Err("parent_id does not belong to this board".to_string());
            }
            None => return Err("parent_id not found".to_string()),
            _ => {}
        }
    }

    let short_id = generate_unique_short_id(&state.db_pool, input.board_id).await?;
    let w = input.w.unwrap_or(240.0);
    let h = input.h.unwrap_or(160.0);
    let data = input.data.unwrap_or(json!({}));
    let status = input.status.unwrap_or_else(|| "idle".to_string());

    sqlx::query_as::<_, Node>(
        "INSERT INTO node (board_id, short_id, type, x, y, w, h, data, status, parent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING *"
    )
    .bind(input.board_id)
    .bind(short_id)
    .bind(input.r#type)
    .bind(input.x)
    .bind(input.y)
    .bind(w)
    .bind(h)
    .bind(data)
    .bind(status)
    .bind(input.parent_id)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct NodeUpdateInput {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub data: Option<Value>,
    pub status: Option<String>,
    pub parent_id: Option<Option<i64>>, // Double option for clearing vs omitting
}

#[tauri::command]
pub async fn patch_node(
    state: State<'_, AppState>,
    id: i64,
    patch: NodeUpdateInput,
) -> Result<Node, String> {
    // 1. Fetch current node
    let node = sqlx::query_as::<_, Node>("SELECT * FROM node WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "node not found".to_string())?;

    // 2. Perform shallow merge on data
    let mut current_data = match node.data {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };

    if let Some(Value::Object(patch_map)) = patch.data {
        for (k, v) in patch_map {
            if v.is_null() {
                current_data.remove(&k);
            } else {
                current_data.insert(k, v);
            }
        }
    }

    let final_data = Value::Object(current_data);

    // 3. Resolve columns to update
    let final_x = patch.x.unwrap_or(node.x);
    let final_y = patch.y.unwrap_or(node.y);
    let final_w = patch.w.unwrap_or(node.w);
    let final_h = patch.h.unwrap_or(node.h);
    let final_status = patch.status.unwrap_or(node.status);
    let final_parent_id = match patch.parent_id {
        Some(opt) => opt,
        None => node.parent_id,
    };

    // 4. Update
    sqlx::query_as::<_, Node>(
        "UPDATE node SET x = ?, y = ?, w = ?, h = ?, data = ?, status = ?, parent_id = ?
         WHERE id = ? RETURNING *"
    )
    .bind(final_x)
    .bind(final_y)
    .bind(final_w)
    .bind(final_h)
    .bind(final_data)
    .bind(final_status)
    .bind(final_parent_id)
    .bind(id)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_node(state: State<'_, AppState>, id: i64) -> Result<Value, String> {
    let node = sqlx::query_as::<_, Node>("SELECT * FROM node WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "node not found".to_string())?;

    let mut deleted_child_ids = Vec::new();
    let mut deleted_edge_ids = Vec::new();

    let mut tx = state.db_pool.begin().await.map_err(|e| e.to_string())?;

    if node.r#type == "group" {
        let children = sqlx::query_as::<_, Node>("SELECT * FROM node WHERE parent_id = ?")
            .bind(id)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

        for child in children {
            let cid = child.id;
            // Delete edges
            let child_edges = sqlx::query_as::<_, Edge>(
                "SELECT * FROM edge WHERE source_id = ? OR target_id = ?"
            )
            .bind(cid)
            .bind(cid)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

            for e in child_edges {
                sqlx::query("DELETE FROM edge WHERE id = ?").bind(e.id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                deleted_edge_ids.push(e.id);
            }

            // Delete requests, assets, and child
            sqlx::query("DELETE FROM request WHERE node_id = ?").bind(cid).execute(&mut *tx).await.map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM asset WHERE node_id = ?").bind(cid).execute(&mut *tx).await.map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM node WHERE id = ?").bind(cid).execute(&mut *tx).await.map_err(|e| e.to_string())?;
            deleted_child_ids.push(cid);
        }
    }

    // Delete node's own edges, requests, assets, and node
    let own_edges = sqlx::query_as::<_, Edge>(
        "SELECT * FROM edge WHERE source_id = ? OR target_id = ?"
    )
    .bind(id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    for e in own_edges {
        sqlx::query("DELETE FROM edge WHERE id = ?").bind(e.id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        deleted_edge_ids.push(e.id);
    }

    sqlx::query("DELETE FROM request WHERE node_id = ?").bind(id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM asset WHERE node_id = ?").bind(id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM node WHERE id = ?").bind(id).execute(&mut *tx).await.map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(json!({
        "ok": true,
        "deleted_edges": deleted_edge_ids,
        "deleted_child_ids": deleted_child_ids
    }))
}

// ─── Grouping Commands ──────────────────────────────────────

#[derive(Deserialize)]
pub struct GroupCreateInput {
    pub board_id: i64,
    pub child_ids: Vec<i64>,
    pub title: Option<String>,
    pub color: Option<String>,
    pub locked: Option<bool>,
    pub x: f64,
    pub y: f64,
    pub w: Option<f64>,
    pub h: Option<f64>,
}

#[tauri::command]
pub async fn group_nodes(
    state: State<'_, AppState>,
    input: GroupCreateInput,
) -> Result<GroupResponse, String> {
    let board_exists = sqlx::query_as::<_, Board>("SELECT * FROM board WHERE id = ? LIMIT 1")
        .bind(input.board_id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?
        .is_some();

    if !board_exists {
        return Err("board not found".to_string());
    }

    if input.child_ids.is_empty() {
        return Err("child_ids must contain at least one node".to_string());
    }

    let mut tx = state.db_pool.begin().await.map_err(|e| e.to_string())?;

    // Load children
    let mut children = Vec::new();
    let unique_child_ids: HashSet<i64> = input.child_ids.iter().cloned().collect();

    for cid in unique_child_ids {
        let child = sqlx::query_as::<_, Node>("SELECT * FROM node WHERE id = ?")
            .bind(cid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("child node {} not found", cid))?;

        if child.board_id != input.board_id {
            return Err("child belongs to a different board".to_string());
        }
        if child.parent_id.is_some() {
            return Err("nested groups are not supported".to_string());
        }
        if child.r#type == "group" {
            return Err("cannot nest a group inside another group".to_string());
        }
        children.push(child);
    }

    let short_id = generate_unique_short_id(&state.db_pool, input.board_id).await?;
    let title = input.title.unwrap_or_else(|| "Group".to_string());
    let color = input.color.unwrap_or_else(|| "#7c5cff".to_string());
    let locked = input.locked.unwrap_or(false);

    let group_data = json!({
        "title": title,
        "groupColor": color,
        "locked": locked
    });

    let group = sqlx::query_as::<_, Node>(
        "INSERT INTO node (board_id, short_id, type, x, y, w, h, data, status, created_at)
         VALUES (?, ?, 'group', ?, ?, ?, ?, ?, 'idle', datetime('now')) RETURNING *"
    )
    .bind(input.board_id)
    .bind(short_id)
    .bind(input.x)
    .bind(input.y)
    .bind(input.w.unwrap_or(320.0))
    .bind(input.h.unwrap_or(200.0))
    .bind(group_data)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let group_id = group.id;
    let mut updated_children = Vec::new();

    for mut child in children {
        let child_data = child.data.clone();
        let new_x = (child.x - input.x).round();
        let new_y = (child.y - input.y).round();

        let updated = sqlx::query_as::<_, Node>(
            "UPDATE node SET x = ?, y = ?, parent_id = ?, data = ? WHERE id = ? RETURNING *"
        )
        .bind(new_x)
        .bind(new_y)
        .bind(group_id)
        .bind(child_data)
        .bind(child.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        updated_children.push(updated);
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(GroupResponse {
        group,
        children: updated_children,
    })
}

#[tauri::command]
pub async fn ungroup_nodes(state: State<'_, AppState>, group_id: i64) -> Result<UngroupResponse, String> {
    let mut tx = state.db_pool.begin().await.map_err(|e| e.to_string())?;

    let group = sqlx::query_as::<_, Node>("SELECT * FROM node WHERE id = ?")
        .bind(group_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "group not found".to_string())?;

    if group.r#type != "group" {
        return Err("node is not a group".to_string());
    }

    let gx = group.x;
    let gy = group.y;

    let children = sqlx::query_as::<_, Node>("SELECT * FROM node WHERE parent_id = ?")
        .bind(group_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    let mut updated_children = Vec::new();

    for mut child in children {
        let child_data = child.data.clone();
        let new_x = (child.x + gx).round();
        let new_y = (child.y + gy).round();

        let updated = sqlx::query_as::<_, Node>(
            "UPDATE node SET x = ?, y = ?, parent_id = NULL, data = ? WHERE id = ? RETURNING *"
        )
        .bind(new_x)
        .bind(new_y)
        .bind(child_data)
        .bind(child.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        updated_children.push(updated);
    }

    // Delete edges to group node if any
    sqlx::query("DELETE FROM edge WHERE source_id = ? OR target_id = ?")
        .bind(group_id)
        .bind(group_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    // Delete group node
    sqlx::query("DELETE FROM node WHERE id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(UngroupResponse {
        deleted_group_id: group_id,
        children: updated_children,
    })
}

// ─── Edge Commands ──────────────────────────────────────────

#[derive(Deserialize)]
pub struct EdgeCreateInput {
    pub board_id: i64,
    pub source_id: i64,
    pub target_id: i64,
    pub kind: Option<String>,
    pub source_handle: Option<String>,
    pub target_handle: Option<String>,
    pub source_variant_idx: Option<i64>,
}

#[tauri::command]
pub async fn create_edge(
    state: State<'_, AppState>,
    input: EdgeCreateInput,
) -> Result<Edge, String> {
    let kind = input.kind.unwrap_or_else(|| "ref".to_string());

    sqlx::query_as::<_, Edge>(
        "INSERT INTO edge (board_id, source_id, target_id, kind, source_handle, target_handle, source_variant_idx)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .bind(input.board_id)
    .bind(input.source_id)
    .bind(input.target_id)
    .bind(kind)
    .bind(input.source_handle)
    .bind(input.target_handle)
    .bind(input.source_variant_idx)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn patch_edge(
    state: State<'_, AppState>,
    id: i64,
    source_variant_idx: Option<Option<i64>>,
) -> Result<Edge, String> {
    let edge = sqlx::query_as::<_, Edge>("SELECT * FROM edge WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "edge not found".to_string())?;

    let final_idx = match source_variant_idx {
        Some(opt) => opt,
        None => edge.source_variant_idx,
    };

    sqlx::query_as::<_, Edge>(
        "UPDATE edge SET source_variant_idx = ? WHERE id = ? RETURNING *"
    )
    .bind(final_idx)
    .bind(id)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_edge(state: State<'_, AppState>, id: i64) -> Result<Value, String> {
    sqlx::query("DELETE FROM edge WHERE id = ?")
        .bind(id)
        .execute(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({ "ok": true }))
}

// ─── Project Sidebar & Auth ──────────────────────────────────

#[tauri::command]
pub async fn get_auth_me(state: State<'_, AppState>) -> Result<Value, String> {
    let flow_client = &state.flow_client;
    let inner = flow_client.inner.lock().unwrap();

    let email = inner.user_info.as_ref().and_then(|u| u.get("email").and_then(|e| e.as_str()).map(|s| s.to_string()));
    let name = inner.user_info.as_ref().and_then(|u| u.get("name").and_then(|e| e.as_str()).map(|s| s.to_string()));
    let picture = inner.user_info.as_ref().and_then(|u| u.get("picture").and_then(|e| e.as_str()).map(|s| s.to_string()));
    let verified = inner.user_info.as_ref().and_then(|u| u.get("verified_email").and_then(|e| e.as_bool()));

    Ok(json!({
        "email": email,
        "name": name,
        "picture": picture,
        "verified_email": verified,
        "paygate_tier": inner.paygate_tier,
        "sku": inner.sku,
        "credits": inner.credits
    }))
}

#[tauri::command]
pub async fn scan_extension(state: State<'_, AppState>) -> Result<Value, String> {
    let flow_client = &state.flow_client;
    let ws_connected = flow_client.is_connected();

    let mut has_user_info = false;
    let mut has_paygate_tier = false;
    let mut userinfo_nudged = false;

    if ws_connected {
        let has_info = {
            let inner = flow_client.inner.lock().unwrap();
            has_user_info = inner.user_info.is_some();
            has_paygate_tier = inner.paygate_tier.is_some();
            has_user_info
        };

        if !has_info {
            // Nudge extension to resend userinfo
            let welcome = json!({
                "type": "please_resend_userinfo"
            });
            let _ = flow_client.notify(welcome).await;
            userinfo_nudged = true;
        }
    }

    Ok(json!({
        "extension_connected": ws_connected,
        "has_user_info": has_user_info,
        "has_paygate_tier": has_paygate_tier,
        "userinfo_nudged": userinfo_nudged,
        "tier_fetched": false
    }))
}

#[tauri::command]
pub async fn logout_extension(state: State<'_, AppState>) -> Result<Value, String> {
    let flow_client = &state.flow_client;
    let notified = flow_client.notify(json!({ "type": "logout" })).await;

    // Clear local cache
    let mut inner = flow_client.inner.lock().unwrap();
    inner.user_info = None;
    inner.flow_key = None;
    inner.flow_key_present = false;
    inner.paygate_tier = None;
    inner.sku = None;
    inner.credits = None;

    Ok(json!({
        "ok": true,
        "extension_notified": notified
    }))
}

#[tauri::command]
pub async fn get_board_project(state: State<'_, AppState>, board_id: i64) -> Result<Value, String> {
    let board_exists = sqlx::query_as::<_, Board>("SELECT * FROM board WHERE id = ? LIMIT 1")
        .bind(board_id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?
        .is_some();

    if !board_exists {
        return Err("board not found".to_string());
    }

    let project = sqlx::query_as::<_, BoardFlowProject>("SELECT * FROM boardflowproject WHERE board_id = ?")
        .bind(board_id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?;

    match project {
        Some(p) => Ok(json!({ "flow_project_id": p.flow_project_id, "created": false })),
        None => Err("no project bound to this board".to_string()),
    }
}

#[tauri::command]
pub async fn ensure_board_project(state: State<'_, AppState>, board_id: i64) -> Result<Value, String> {
    let board = sqlx::query_as::<_, Board>("SELECT * FROM board WHERE id = ?")
        .bind(board_id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "board not found".to_string())?;

    let existing = sqlx::query_as::<_, BoardFlowProject>("SELECT * FROM boardflowproject WHERE board_id = ?")
        .bind(board_id)
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(p) = existing {
        return Ok(json!({ "flow_project_id": p.flow_project_id, "created": false }));
    }

    // Call FlowSDK to create project
    let board_name = if board.name.is_empty() { "Untitled" } else { &board.name };
    let payload = json!({
        "json": {
            "projectTitle": board_name,
            "toolName": "PINHOLE"
        }
    });

    let trpc_url = "https://labs.google/fx/api/trpc/project.createProject";
    let headers = json!({
        "content-type": "application/json",
        "accept": "*/*"
    });

    let resp = state.flow_client.trpc_request(trpc_url, "POST", Some(headers), Some(payload), None).await;

    if resp.get("error").is_some() {
        return Err(format!("Flow project bootstrap failed: {:?}", resp.get("error")));
    }

    // Extract project ID
    let project_id = resp
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("data"))
        .and_then(|d| d.get("json"))
        .and_then(|j| j.get("result"))
        .and_then(|r| r.get("projectId"))
        .and_then(|p| p.as_str())
        .ok_or_else(|| "no project_id in Flow response".to_string())?;

    // Check project ID validation: standard alphanumeric/hyphen/underscore
    let valid_id = !project_id.is_empty()
        && project_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');

    if !valid_id {
        return Err("invalid project_id shape from Flow".to_string());
    }

    // Persist
    let bound = sqlx::query_as::<_, BoardFlowProject>(
        "INSERT INTO boardflowproject (board_id, flow_project_id, created_at) VALUES (?, ?, datetime('now')) RETURNING *"
    )
    .bind(board_id)
    .bind(project_id)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(json!({ "flow_project_id": bound.flow_project_id, "created": true }))
}

#[derive(Deserialize)]
pub struct RequestCreateInput {
    pub node_id: Option<i64>,
    pub r#type: String,
    pub params: Value,
}

#[tauri::command]
pub async fn create_request(
    state: State<'_, AppState>,
    input: RequestCreateInput,
) -> Result<crate::db::models::Request, String> {
    let pool = &state.db_pool;
    let req = sqlx::query_as::<_, crate::db::models::Request>(
        "INSERT INTO request (node_id, type, params, status, result, created_at)
         VALUES (?, ?, ?, 'queued', '{}', datetime('now')) RETURNING *"
    )
    .bind(input.node_id)
    .bind(input.r#type)
    .bind(input.params)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(req)
}

#[tauri::command]
pub async fn get_request(
    state: State<'_, AppState>,
    id: i64,
) -> Result<crate::db::models::Request, String> {
    sqlx::query_as::<_, crate::db::models::Request>(
        "SELECT * FROM request WHERE id = ?"
    )
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "request not found".to_string())
}
