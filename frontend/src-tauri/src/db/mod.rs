use std::fs;
use std::path::Path;
use sqlx::{sqlite::SqliteConnectOptions, Row, SqlitePool};

pub mod models;

pub async fn establish_connection(db_path: &str) -> Result<SqlitePool, sqlx::Error> {
    // Ensure parent directory exists
    if let Some(parent) = Path::new(db_path).parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| sqlx::Error::Io(e))?;
        }
    }

    // Connect with foreign keys enabled
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .pragma("foreign_keys", "ON");

    SqlitePool::connect_with(options).await
}

pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    // Create tables
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS board (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS node (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL,
            short_id TEXT NOT NULL,
            type TEXT NOT NULL,
            x REAL NOT NULL DEFAULT 0.0,
            y REAL NOT NULL DEFAULT 0.0,
            w REAL NOT NULL DEFAULT 240.0,
            h REAL NOT NULL DEFAULT 160.0,
            data TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'idle',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            parent_id INTEGER,
            FOREIGN KEY(board_id) REFERENCES board(id) ON DELETE CASCADE,
            FOREIGN KEY(parent_id) REFERENCES node(id) ON DELETE SET NULL
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS edge (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL,
            source_id INTEGER NOT NULL,
            target_id INTEGER NOT NULL,
            kind TEXT NOT NULL DEFAULT 'ref',
            source_handle TEXT,
            target_handle TEXT,
            source_variant_idx INTEGER,
            FOREIGN KEY(board_id) REFERENCES board(id) ON DELETE CASCADE,
            FOREIGN KEY(source_id) REFERENCES node(id) ON DELETE CASCADE,
            FOREIGN KEY(target_id) REFERENCES node(id) ON DELETE CASCADE
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS request (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id INTEGER,
            type TEXT NOT NULL,
            params TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'queued',
            result TEXT NOT NULL DEFAULT '{}',
            error TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at DATETIME,
            FOREIGN KEY(node_id) REFERENCES node(id) ON DELETE SET NULL
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS asset (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id INTEGER,
            kind TEXT NOT NULL,
            uuid_media_id TEXT,
            url TEXT,
            local_path TEXT,
            mime TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(node_id) REFERENCES node(id) ON DELETE SET NULL
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS reference (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id TEXT NOT NULL UNIQUE,
            url TEXT,
            label TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL,
            ai_brief TEXT,
            aspect_ratio TEXT,
            tags TEXT NOT NULL DEFAULT '[]',
            pinned BOOLEAN NOT NULL DEFAULT 0,
            position INTEGER NOT NULL DEFAULT 0,
            source_board_id INTEGER,
            source_node_short_id TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(source_board_id) REFERENCES board(id) ON DELETE SET NULL
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS chatmessage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            mentions TEXT NOT NULL DEFAULT '[]',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(board_id) REFERENCES board(id) ON DELETE CASCADE
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS plan (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL,
            spec TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'draft',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(board_id) REFERENCES board(id) ON DELETE CASCADE
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS planrevision (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            rev_no INTEGER NOT NULL,
            spec TEXT NOT NULL DEFAULT '{}',
            edits TEXT NOT NULL DEFAULT '{}',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(plan_id) REFERENCES plan(id) ON DELETE CASCADE
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pipelinerun (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            started_at DATETIME,
            finished_at DATETIME,
            error TEXT,
            FOREIGN KEY(plan_id) REFERENCES plan(id) ON DELETE CASCADE
        );"
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS boardflowproject (
            board_id INTEGER PRIMARY KEY,
            flow_project_id TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(board_id) REFERENCES board(id) ON DELETE CASCADE
        );"
    )
    .execute(&mut *tx)
    .await?;

    // Create indexes for optimization
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_node_board_id ON node(board_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_node_short_id ON node(short_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_node_parent_id ON node(parent_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_edge_board_id ON edge(board_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_request_node_id ON request(node_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_asset_node_id ON asset(node_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_uuid_media_id ON asset(uuid_media_id) WHERE uuid_media_id IS NOT NULL;").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_reference_source_board_id ON reference(source_board_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_chatmessage_board_id ON chatmessage(board_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_plan_board_id ON plan(board_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_planrevision_plan_id ON planrevision(plan_id);").execute(&mut *tx).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_pipelinerun_plan_id ON pipelinerun(plan_id);").execute(&mut *tx).await?;

    let edge_cols = sqlx::query("PRAGMA table_info(edge);")
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect::<std::collections::HashSet<_>>();
    if !edge_cols.contains("source_variant_idx") {
        sqlx::query("ALTER TABLE edge ADD COLUMN source_variant_idx INTEGER").execute(&mut *tx).await?;
    }
    if !edge_cols.contains("source_handle") {
        sqlx::query("ALTER TABLE edge ADD COLUMN source_handle TEXT").execute(&mut *tx).await?;
    }
    if !edge_cols.contains("target_handle") {
        sqlx::query("ALTER TABLE edge ADD COLUMN target_handle TEXT").execute(&mut *tx).await?;
    }

    tx.commit().await?;
    Ok(())
}
