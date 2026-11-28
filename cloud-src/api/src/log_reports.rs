//! Log reports from the desktop app's Settings → "Send logs" button.
//!
//! The app strips keys, chat text and the user's folder name before sending
//! (sidecar-rust/src/logs_report.rs). This stores the files under a short
//! code the user can read out to us, signed in or not, and keeps them for
//! 30 days. Owners read one back with `GET /api/admin/log-reports/:code`.

use axum::{
    extract::{Json, Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use super::{ensure_gateway_access, ensure_owner_or_service, AppState, GatewayAccess};

const MAX_FILES: usize = 8;
const MAX_TOTAL_BYTES: usize = 1_500_000;
const KEEP_DAYS: i32 = 30;
/// No 0/O or 1/I/L, so a code read out loud or retyped comes back right.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

pub async fn ensure_table(db: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS log_reports (
            code TEXT PRIMARY KEY,
            user_id TEXT,
            app_version TEXT,
            os TEXT,
            files JSONB NOT NULL,
            total_bytes INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_log_reports_created_at ON log_reports(created_at);")
        .execute(db)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct LogFile {
    name: String,
    text: String,
}

#[derive(Deserialize)]
pub struct LogReportBody {
    #[serde(default)]
    app_version: String,
    #[serde(default)]
    os: String,
    files: Vec<LogFile>,
}

fn new_code() -> String {
    let bytes = uuid::Uuid::new_v4();
    let chars: String = bytes.as_bytes()[..6]
        .iter()
        .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
        .collect();
    format!("ZW-{chars}")
}

/// Problems with a report, in words the app can show.
fn check(body: &LogReportBody) -> Result<usize, &'static str> {
    if body.files.is_empty() || body.files.len() > MAX_FILES {
        return Err("expected 1 to 8 files");
    }
    if body.files.iter().any(|f| f.name.is_empty() || f.name.len() > 64) {
        return Err("bad file name");
    }
    if body.app_version.len() > 32 || body.os.len() > 32 {
        return Err("bad app version or os");
    }
    let total: usize = body.files.iter().map(|f| f.text.len()).sum();
    if total > MAX_TOTAL_BYTES {
        return Err("logs too large");
    }
    Ok(total)
}

/// `POST /api/logs/report` → `{ code }`. Sign-in is optional; when present
/// the report is tied to the account so it can be found without the code.
pub async fn submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LogReportBody>,
) -> impl IntoResponse {
    let total = match check(&body) {
        Ok(t) => t,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    };
    let user_id = match ensure_gateway_access(&state, &headers).await {
        Ok(GatewayAccess::DesktopToken(u)) => Some(u.user_id),
        Ok(GatewayAccess::CookieSession(u)) => Some(u.id),
        _ => None,
    };
    let files: Value = body.files.iter().map(|f| json!({ "name": f.name, "text": f.text })).collect();

    let _ = sqlx::query("DELETE FROM log_reports WHERE created_at < NOW() - make_interval(days => $1)")
        .bind(KEEP_DAYS)
        .execute(&state.db)
        .await;

    // A clash in 31^6 codes is rare; retry a couple of times rather than fail.
    for _ in 0..3 {
        let code = new_code();
        let inserted = sqlx::query(
            "INSERT INTO log_reports (code, user_id, app_version, os, files, total_bytes) \
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING",
        )
        .bind(&code)
        .bind(&user_id)
        .bind(&body.app_version)
        .bind(&body.os)
        .bind(&files)
        .bind(total as i32)
        .execute(&state.db)
        .await;
        match inserted {
            Ok(r) if r.rows_affected() == 1 => return (StatusCode::OK, Json(json!({ "code": code }))),
            Ok(_) => continue,
            Err(e) => {
                tracing::error!("log report insert failed: {e}");
                break;
            }
        }
    }
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "could not save the logs" })))
}

/// `GET /api/admin/log-reports/:code` for owners.
pub async fn admin_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    ensure_owner_or_service(&state, &headers).await?;
    let row = sqlx::query(
        "SELECT code, user_id, app_version, os, files, total_bytes, created_at FROM log_reports WHERE code = $1",
    )
    .bind(code.trim().to_ascii_uppercase())
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(json!({
        "code": row.get::<String, _>("code"),
        "user_id": row.get::<Option<String>, _>("user_id"),
        "app_version": row.get::<Option<String>, _>("app_version"),
        "os": row.get::<Option<String>, _>("os"),
        "files": row.get::<Value, _>("files"),
        "total_bytes": row.get::<i32, _>("total_bytes"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(files: Vec<(&str, usize)>) -> LogReportBody {
        LogReportBody {
            app_version: "0.6.1".into(),
            os: "windows".into(),
            files: files.into_iter().map(|(n, len)| LogFile { name: n.into(), text: "x".repeat(len) }).collect(),
        }
    }

    #[test]
    fn codes_are_short_and_unambiguous() {
        let c = new_code();
        assert_eq!(c.len(), 9);
        assert!(c[3..].bytes().all(|b| CODE_ALPHABET.contains(&b)), "{c}");
    }

    #[test]
    fn rejects_empty_too_many_or_too_large() {
        assert_eq!(check(&body(vec![("backend.log", 10), ("agent.jsonl", 5)])), Ok(15));
        assert!(check(&body(vec![])).is_err());
        assert!(check(&body(vec![("a", 1); 9])).is_err());
        assert!(check(&body(vec![("a", MAX_TOTAL_BYTES + 1)])).is_err());
        assert!(check(&body(vec![("", 1)])).is_err());
    }
}
