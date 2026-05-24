use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Board {
    pub id: i64,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Node {
    pub id: i64,
    pub board_id: i64,
    pub short_id: String,
    pub r#type: String, // Use r#type because "type" is a reserved keyword in Rust
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub data: serde_json::Value,
    pub status: String,
    pub created_at: String,
    pub parent_id: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Edge {
    pub id: i64,
    pub board_id: i64,
    pub source_id: i64,
    pub target_id: i64,
    pub kind: String,
    pub source_handle: Option<String>,
    pub target_handle: Option<String>,
    pub source_variant_idx: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Request {
    pub id: i64,
    pub node_id: Option<i64>,
    pub r#type: String,
    pub params: serde_json::Value,
    pub status: String,
    pub result: serde_json::Value,
    pub error: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Asset {
    pub id: i64,
    pub node_id: Option<i64>,
    pub kind: String,
    pub uuid_media_id: Option<String>,
    pub url: Option<String>,
    pub local_path: Option<String>,
    pub mime: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Reference {
    pub id: i64,
    pub media_id: String,
    pub url: Option<String>,
    pub label: String,
    pub kind: String,
    pub ai_brief: Option<String>,
    pub aspect_ratio: Option<String>,
    pub tags: serde_json::Value,
    pub pinned: bool,
    pub position: i64,
    pub source_board_id: Option<i64>,
    pub source_node_short_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ChatMessage {
    pub id: i64,
    pub board_id: i64,
    pub role: String,
    pub content: String,
    pub mentions: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Plan {
    pub id: i64,
    pub board_id: i64,
    pub spec: serde_json::Value,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct PlanRevision {
    pub id: i64,
    pub plan_id: i64,
    pub rev_no: i64,
    pub spec: serde_json::Value,
    pub edits: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct PipelineRun {
    pub id: i64,
    pub plan_id: i64,
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct BoardFlowProject {
    pub board_id: i64,
    pub flow_project_id: String,
    pub created_at: String,
}
