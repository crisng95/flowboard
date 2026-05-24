use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;
use tokio::sync::mpsc::UnboundedSender;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

pub struct FlowClientInner {
    pub pending: HashMap<String, oneshot::Sender<Value>>,
    pub flow_key_present: bool,
    pub flow_key: Option<String>,
    pub user_info: Option<Value>,
    pub paygate_tier: Option<String>,
    pub sku: Option<String>,
    pub credits: Option<Option<i64>>, // double option for parsed state
    pub observed_captcha_actions: HashMap<String, Value>,
    pub request_count: u64,
    pub success_count: u64,
    pub failed_count: u64,
    pub last_error: Option<String>,
    pub token_captured_at: Option<u64>,
    pub last_tier_fetch_at: Option<u64>,
}

#[derive(Clone)]
pub struct FlowClient {
    pub callback_secret: String,
    pub inner: Arc<Mutex<FlowClientInner>>,
    ws_sender: Arc<Mutex<Option<UnboundedSender<Message>>>>,
}

impl FlowClient {
    pub fn new() -> Self {
        // Generate random URL-safe callback secret
        let callback_secret = Uuid::new_v4().to_string();

        let inner = Arc::new(Mutex::new(FlowClientInner {
            pending: HashMap::new(),
            flow_key_present: false,
            flow_key: None,
            user_info: None,
            paygate_tier: None,
            sku: None,
            credits: None,
            observed_captcha_actions: HashMap::new(),
            request_count: 0,
            success_count: 0,
            failed_count: 0,
            last_error: None,
            token_captured_at: None,
            last_tier_fetch_at: None,
        }));

        Self {
            callback_secret,
            inner,
            ws_sender: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.ws_sender.lock().unwrap().is_some()
    }

    pub fn set_ws_sender(&self, sender: UnboundedSender<Message>) {
        *self.ws_sender.lock().unwrap() = Some(sender);
    }

    pub fn clear_ws_sender(&self) {
        *self.ws_sender.lock().unwrap() = None;
        let mut inner = self.inner.lock().unwrap();
        inner.flow_key_present = false;
        inner.flow_key = None;
        inner.user_info = None;
        inner.paygate_tier = None;
        inner.sku = None;
        inner.credits = None;
        inner.observed_captcha_actions.clear();

        // Clear all pending futures with connection error
        for (_, sender) in inner.pending.drain() {
            let _ = sender.send(json!({
                "error": "extension_disconnected"
            }));
        }
    }

    pub fn get_ws_stats(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let token_age = inner.token_captured_at.map(|t| now.saturating_sub(t));

        let mut observed = json!({});
        for (scope, val) in &inner.observed_captcha_actions {
            if let Some(action) = val.get("action").and_then(|a| a.as_str()) {
                observed[scope] = json!(action);
            }
        }

        json!({
            "connected": self.is_connected(),
            "flow_key_present": inner.flow_key_present,
            "token_age_s": token_age,
            "pending": inner.pending.len(),
            "request_count": inner.request_count,
            "success_count": inner.success_count,
            "failed_count": inner.failed_count,
            "last_error": inner.last_error,
            "observed_captcha_actions": observed
        })
    }

    pub fn handle_inbound_ws_message(&self, msg: Value) {
        let msg_type = match msg.get("type").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => {
                // If it contains "id", it might be an inbound response (legacy path)
                if let Some(id) = msg.get("id").and_then(|i| i.as_str()) {
                    self.resolve_callback(id.to_string(), msg);
                }
                return;
            }
        };

        match msg_type {
            "extension_ready" => {
                let mut inner = self.inner.lock().unwrap();
                inner.flow_key_present = msg.get("flowKeyPresent").and_then(|b| b.as_bool()).unwrap_or(false);
                println!("[Flowboard] extension_ready flowKeyPresent={}", inner.flow_key_present);
            }
            "token_captured" => {
                let mut inner = self.inner.lock().unwrap();
                inner.flow_key_present = true;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                inner.token_captured_at = Some(now);

                if let Some(flow_key) = msg.get("flowKey").and_then(|k| k.as_str()) {
                    let key_changed = inner.flow_key.as_deref() != Some(flow_key);
                    inner.flow_key = Some(flow_key.to_string());

                    let last_fetch = inner.last_tier_fetch_at.unwrap_or(0);
                    if key_changed || (now - last_fetch) > 60 {
                        inner.last_tier_fetch_at = Some(now);
                        println!("[Flowboard] token_captured (len={})", flow_key.len());

                        // Spawn paygate credits check
                        let flow_key_clone = flow_key.to_string();
                        let self_clone = self.clone();
                        tokio::spawn(async move {
                            let _ = self_clone.fetch_paygate_tier(&flow_key_clone).await;
                        });
                    }
                }
            }
            "user_info" => {
                if let Some(info) = msg.get("userInfo") {
                    let mut inner = self.inner.lock().unwrap();
                    // Whitelist profile fields
                    let mut filtered = json!({});
                    for key in &["email", "name", "picture", "verified_email"] {
                        if let Some(val) = info.get(*key) {
                            filtered[*key] = val.clone();
                        }
                    }
                    inner.user_info = Some(filtered);
                    println!("[Flowboard] user_info captured");
                }
            }
            "captcha_action_observed" => {
                let scope = msg.get("scope").and_then(|s| s.as_str());
                let action = msg.get("action").and_then(|a| a.as_str());
                if let (Some(scope), Some(action)) = (scope, action) {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs();
                    let mut inner = self.inner.lock().unwrap();
                    inner.observed_captcha_actions.insert(
                        scope.to_string(),
                        json!({
                            "action": action,
                            "href": msg.get("href"),
                            "observed_at": msg.get("observedAt").and_then(|o| o.as_f64()).unwrap_or(now as f64)
                        }),
                    );
                    println!("[Flowboard] captcha_action_observed scope={} action={}", scope, action);
                }
            }
            "pong" => {}
            _ => {}
        }
    }

    pub fn resolve_callback(&self, id: String, data: Value) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(sender) = inner.pending.remove(&id) {
            // Count metrics
            let status = data.get("status").and_then(|s| s.as_i64()).unwrap_or(200);
            let explicit_error = data.get("error").is_some();
            let http_error = status >= 400;

            if explicit_error || http_error {
                inner.failed_count += 1;
                let mut msg = data.get("error").and_then(|e| e.as_str()).unwrap_or("").to_string();
                if msg.is_empty() && http_error {
                    if let Some(detail) = data.get("data") {
                        msg = detail.to_string();
                    } else {
                        msg = format!("API_{}", status);
                    }
                }
                inner.last_error = Some(msg.chars().take(500).collect());
            } else {
                inner.success_count += 1;
            }

            let _ = sender.send(data);
            true
        } else {
            false
        }
    }

    pub async fn notify(&self, message: Value) -> bool {
        let sender_opt = self.ws_sender.lock().unwrap().clone();
        if let Some(sender) = sender_opt {
            let msg_str = serde_json::to_string(&message).unwrap();
            sender.send(Message::Text(msg_str.into())).is_ok()
        } else {
            false
        }
    }

    pub async fn api_request(
        &self,
        url: &str,
        method: &str,
        headers: Option<Value>,
        body: Option<Value>,
        captcha_action: Option<&str>,
        timeout_sec: Option<f64>,
    ) -> Value {
        let mut params = json!({
            "url": url,
            "method": method,
            "headers": headers.unwrap_or(json!({})),
            "body": body
        });
        if let Some(action) = captcha_action {
            params["captchaAction"] = json!(action);
        }

        self.send_to_extension("api_request", params, timeout_sec).await
    }

    pub async fn trpc_request(
        &self,
        url: &str,
        method: &str,
        headers: Option<Value>,
        body: Option<Value>,
        timeout_sec: Option<f64>,
    ) -> Value {
        let params = json!({
            "url": url,
            "method": method,
            "headers": headers.unwrap_or(json!({})),
            "body": body
        });

        self.send_to_extension("trpc_request", params, timeout_sec).await
    }

    async fn send_to_extension(&self, method: &str, params: Value, timeout_sec: Option<f64>) -> Value {
        let ws_connected = self.is_connected();
        if !ws_connected {
            return json!({ "error": "extension_disconnected" });
        }

        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();

        {
            let mut inner = self.inner.lock().unwrap();
            inner.pending.insert(id.clone(), sender);
            inner.request_count += 1;
        }

        let payload = json!({
            "id": id,
            "method": method,
            "params": params
        });

        let sent = self.notify(payload).await;
        if !sent {
            self.inner.lock().unwrap().pending.remove(&id);
            return json!({ "error": "extension_disconnected" });
        }

        let timeout_duration = std::time::Duration::from_secs_f64(timeout_sec.unwrap_or(180.0));
        match tokio::time::timeout(timeout_duration, receiver).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => {
                let mut inner = self.inner.lock().unwrap();
                inner.pending.remove(&id);
                inner.failed_count += 1;
                inner.last_error = Some("oneshot_cancelled".to_string());
                json!({ "error": "channel_cancelled" })
            }
            Err(_) => {
                let mut inner = self.inner.lock().unwrap();
                inner.pending.remove(&id);
                inner.failed_count += 1;
                inner.last_error = Some("timeout".to_string());
                json!({ "error": "timeout" })
            }
        }
    }

    async fn fetch_paygate_tier(&self, token: &str) -> bool {
        let api_key = "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY";
        let credits_url = "https://aisandbox-pa.googleapis.com/v1/credits";

        let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build() {
            Ok(c) => c,
            Err(_) => return false,
        };

        let resp_res = client.get(credits_url)
            .query(&[("key", api_key)])
            .header("authorization", format!("Bearer {}", token))
            .header("origin", "https://labs.google")
            .header("referer", "https://labs.google/")
            .send()
            .await;

        let resp = match resp_res {
            Ok(r) => r,
            Err(e) => {
                println!("[Flowboard] fetch_paygate_tier transport error: {}", e);
                return false;
            }
        };

        if resp.status() != 200 {
            println!("[Flowboard] fetch_paygate_tier returned HTTP {} (token may be expired)", resp.status());
            return false;
        }

        let data = match resp.json::<Value>().await {
            Ok(j) => j,
            Err(_) => return false,
        };

        let tier = data.get("userPaygateTier").and_then(|t| t.as_str());
        if tier != Some("PAYGATE_TIER_ONE") && tier != Some("PAYGATE_TIER_TWO") {
            println!("[Flowboard] fetch_paygate_tier response missing userPaygateTier (got {:?})", tier);
            return false;
        }

        let mut inner = self.inner.lock().unwrap();
        inner.paygate_tier = tier.map(|t| t.to_string());
        inner.sku = data.get("sku").and_then(|s| s.as_str()).map(|s| s.to_string());
        inner.credits = Some(data.get("credits").and_then(|c| c.as_i64()));

        println!(
            "[Flowboard] fetch_paygate_tier resolved tier={:?} sku={:?} credits={:?}",
            inner.paygate_tier, inner.sku, inner.credits
        );

        true
    }
}
