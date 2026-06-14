// Embedded zbctl WebSocket bridge.
// Replaces the external Python zbctl daemon. The Chrome extension connects
// directly to zWork's backend at ws://127.0.0.1:8787/ws.
//
// Protocol:
//   Agent calls browser_* tools → internal command queue → WS to extension
//   Extension responds with {id: "cmd_N", ok: true/false, ...}
//   Response resolves the pending future → returned to agent as tool result.

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::sync::{mpsc, oneshot, Mutex};

/// A command sent to the browser extension.
struct BridgeState {
    /// Sender to the active extension WebSocket (if connected).
    ws_tx: Option<mpsc::UnboundedSender<String>>,
    /// Monotonic id of the connection that owns `ws_tx`. Used so a stale
    /// disconnect (an old socket closing after a newer one took over) doesn't
    /// clobber the live connection.
    ws_conn_id: u64,
    /// Pending commands waiting for extension responses.
    pending: HashMap<String, oneshot::Sender<Value>>,
    /// Command counter for generating cmd_N IDs.
    counter: u64,
    /// Connection counter for generating ws conn ids.
    conn_counter: u64,
}

fn bridge() -> &'static Mutex<BridgeState> {
    static BRIDGE: OnceLock<Mutex<BridgeState>> = OnceLock::new();
    BRIDGE.get_or_init(|| {
        Mutex::new(BridgeState {
            ws_tx: None,
            ws_conn_id: 0,
            pending: HashMap::new(),
            counter: 0,
            conn_counter: 0,
        })
    })
}

/// Send a command to the browser extension and wait for the response.
/// This is the internal dispatch used by zbctl.rs instead of HTTP POST.
pub async fn send_command(action: &str, params: Value) -> Result<String, String> {
    let (tx, rx) = oneshot::channel();

    let (id, ws_tx) = {
        let mut state = bridge().lock().await;
        state.counter += 1;
        let id = format!("cmd_{}", state.counter);
        state.pending.insert(id.clone(), tx);

        let ws_tx = state.ws_tx.clone()
            .ok_or_else(|| "No browser extension connected. Load the zWork Chrome extension to enable browser control.".to_string())?;

        (id, ws_tx)
    };

    // Build the command message
    let cmd = serde_json::json!({
        "id": id,
        "action": action,
        "params": params,
    });

    // Send to extension via WebSocket
    let cmd_str = serde_json::to_string(&cmd)
        .map_err(|e| format!("Serialization error: {}", e))?;

    if ws_tx.send(cmd_str).is_err() {
        // The extension channel is gone (it disconnected between us grabbing
        // the sender and sending). Drop the pending entry so it isn't leaked
        // until the timeout fires.
        let mut state = bridge().lock().await;
        state.pending.remove(&id);
        return Err("Browser extension disconnected before the command was sent.".to_string());
    }

    // Wait for response (10s timeout)
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(response)) => {
            // Check if response indicates error
            if response.get("ok").and_then(|v| v.as_bool()) == Some(false) {
                let error = response.get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error");
                Err(error.to_string())
            } else {
                Ok(serde_json::to_string(&response)
                    .unwrap_or_else(|_| "{}".to_string()))
            }
        }
        Ok(Err(_)) => Err("Internal error: command response channel closed".to_string()),
        Err(_) => {
            // Timeout — clean up pending entry
            let mut state = bridge().lock().await;
            state.pending.remove(&id);
            Err("Timeout waiting for extension response".to_string())
        }
    }
}

/// Axum WebSocket handler for the Chrome extension connection.
/// Mount at: GET /ws
pub async fn ws_handler(ws: axum::extract::ws::WebSocketUpgrade) -> impl axum::response::IntoResponse {
    ws.on_upgrade(handle_ws_connection)
}

async fn handle_ws_connection(socket: WebSocket) {
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel::<String>();

    // Register this connection as the active one and stamp it with a unique
    // id so a later disconnect can tell whether it still owns the bridge.
    let conn_id = {
        let mut state = bridge().lock().await;
        state.conn_counter += 1;
        state.ws_conn_id = state.conn_counter;
        state.ws_tx = Some(ws_tx);
        state.ws_conn_id
    };

    tracing::info!("[browser-bridge] extension connected (conn={})", conn_id);

    // Spawn a task to forward outgoing messages to the WebSocket
    let (mut ws_sender, mut ws_receiver) = socket.split();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.recv().await {
            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Read incoming messages from the extension
    while let Some(Ok(msg)) = ws_receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                let msg_id = payload.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

                // If this is a response to a pending command, resolve it
                let is_settled = payload.get("type").and_then(|v| v.as_str()) == Some("settled");

                if let Some(ref id) = msg_id {
                    let mut state = bridge().lock().await;
                    if let Some(tx) = state.pending.remove(id) {
                        let _ = tx.send(payload.clone());
                    }
                }

                // Push events (settled snapshots) are logged
                if is_settled {
                    tracing::debug!(
                        "[browser-bridge] page settled: {}",
                        payload.get("url").and_then(|v| v.as_str()).unwrap_or("?")
                    );
                }
            }
        } else if let Message::Close(_) = msg {
            break;
        }
    }

    // Cleanup: only tear down the bridge if this connection still owns it.
    // A newer connection may have already taken over (e.g. the extension
    // reconnected before the old socket fully closed); in that case we leave
    // the live connection and its pending commands untouched.
    send_task.abort();
    let still_owner = {
        let mut state = bridge().lock().await;
        if state.ws_conn_id == conn_id {
            state.ws_tx = None;
            // Fail any commands still waiting on this (now-dead) connection.
            for (_, tx) in state.pending.drain() {
                let _ = tx.send(serde_json::json!({
                    "ok": false,
                    "error": "Browser extension disconnected"
                }));
            }
            true
        } else {
            false
        }
    };

    tracing::info!(
        "[browser-bridge] extension disconnected (conn={}, released={})",
        conn_id, still_owner
    );
}
