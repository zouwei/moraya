use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

const SERVICE_NAME: &str = "com.moraya.app";
const AI_KEY_PREFIX: &str = "ai-key:";
const REQUEST_TIMEOUT_SECS: u64 = 180;

/// Shared state for aborting in-flight streaming requests.
pub struct AIProxyState {
    abort_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AIProxyState {
    pub fn new() -> Self {
        Self {
            abort_flags: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for AIProxyState {
    fn default() -> Self {
        Self::new()
    }
}

/// Get API key from OS keychain. Returns empty string if no entry (e.g. Ollama).
fn get_api_key(prefix: &str, config_id: &str) -> Result<String, String> {
    let key_name = format!("{}{}", prefix, config_id);
    let entry = keyring::Entry::new(SERVICE_NAME, &key_name)
        .map_err(|_| "Failed to access keychain".to_string())?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(_) => Err("Failed to retrieve API key".to_string()),
    }
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|_| "Failed to create HTTP client".to_string())
}

/// Build a request with auth header injected based on provider type.
fn build_request(
    client: &reqwest::Client,
    provider: &str,
    api_key: &str,
    url: &str,
    body: &str,
    headers: &HashMap<String, String>,
    method: &str,
) -> reqwest::RequestBuilder {
    // Gemini: append key as query parameter
    let final_url = if provider == "gemini" && !api_key.is_empty() {
        if url.contains('?') {
            format!("{}&key={}", url, api_key)
        } else {
            format!("{}?key={}", url, api_key)
        }
    } else {
        url.to_string()
    };

    let mut req = match method {
        "GET" => client.get(&final_url),
        _ => client
            .post(&final_url)
            .header("Content-Type", "application/json")
            .body(body.to_string()),
    };

    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }

    // Add auth header
    if !api_key.is_empty() {
        match provider {
            "claude" => {
                req = req.header("x-api-key", api_key);
            }
            "gemini" | "ollama" => {} // gemini=query param, ollama=no auth
            _ => {
                req = req.header("Authorization", format!("Bearer {}", api_key));
            }
        }
    }

    req
}

/// Resolve the API key: use override if provided, otherwise look up keychain.
fn resolve_api_key(
    config_id: &str,
    key_prefix: Option<&str>,
    api_key_override: Option<&str>,
) -> Result<String, String> {
    if let Some(key) = api_key_override {
        if !key.is_empty() && key != "***" {
            return Ok(key.to_string());
        }
    }
    let prefix = key_prefix.unwrap_or(AI_KEY_PREFIX);
    get_api_key(prefix, config_id)
}

/// Non-streaming AI API proxy.
/// Frontend builds URL/body/headers (without auth); Rust injects auth from keychain.
#[tauri::command]
pub async fn ai_proxy_fetch(
    config_id: String,
    key_prefix: Option<String>,
    api_key_override: Option<String>,
    provider: String,
    url: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
    method: Option<String>,
) -> Result<String, String> {
    let api_key = resolve_api_key(
        &config_id,
        key_prefix.as_deref(),
        api_key_override.as_deref(),
    )?;
    let client = build_client()?;
    let hdrs = headers.unwrap_or_default();
    let m = method.as_deref().unwrap_or("POST");
    let b = body.as_deref().unwrap_or("{}");
    let req = build_request(&client, &provider, &api_key, &url, b, &hdrs, m);

    let response = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "AI request timed out".to_string()
        } else {
            "AI request failed".to_string()
        }
    })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!("API error ({}): {}", status, err_body));
    }

    response
        .text()
        .await
        .map_err(|_| "Failed to read response".to_string())
}

/// Streaming AI API proxy.
/// Reads SSE stream, extracts text content per provider format, sends via Channel.
#[tauri::command]
pub async fn ai_proxy_stream(
    state: tauri::State<'_, AIProxyState>,
    on_event: Channel<String>,
    request_id: String,
    config_id: String,
    api_key_override: Option<String>,
    provider: String,
    url: String,
    body: String,
    headers: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let api_key = resolve_api_key(&config_id, None, api_key_override.as_deref())?;
    let client = build_client()?;
    let hdrs = headers.unwrap_or_default();
    let req = build_request(&client, &provider, &api_key, &url, &body, &hdrs, "POST");

    // Register abort flag
    let abort_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.abort_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(request_id.clone(), abort_flag.clone());
    }

    let result = do_stream(&on_event, &provider, req, &abort_flag).await;

    // Cleanup
    if let Ok(mut flags) = state.abort_flags.lock() {
        flags.remove(&request_id);
    }

    result
}

/// Abort a streaming request by its ID.
#[tauri::command]
pub fn ai_proxy_abort(
    state: tauri::State<'_, AIProxyState>,
    request_id: String,
) -> Result<(), String> {
    let flags = state.abort_flags.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = flags.get(&request_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

async fn do_stream(
    on_event: &Channel<String>,
    provider: &str,
    req: reqwest::RequestBuilder,
    abort_flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let response = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "AI request timed out".to_string()
        } else {
            "AI request failed".to_string()
        }
    })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!("API error ({}): {}", status, err_body));
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        if abort_flag.load(Ordering::SeqCst) {
            break;
        }

        let bytes = chunk.map_err(|_| "Stream read error".to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete lines
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].to_string();
            buffer = buffer[pos + 1..].to_string();

            if let Some(text) = extract_sse_text(provider, &line) {
                let _ = on_event.send(text);
            }
        }
    }

    // Flush remaining buffer
    if !buffer.is_empty() {
        if let Some(text) = extract_sse_text(provider, &buffer) {
            let _ = on_event.send(text);
        }
    }

    Ok(())
}

/// Extract text content from an SSE data line.
fn extract_sse_text(provider: &str, line: &str) -> Option<String> {
    let data = line.trim().strip_prefix("data: ")?;
    if data == "[DONE]" {
        return None;
    }

    let v: serde_json::Value = serde_json::from_str(data).ok()?;

    match provider {
        "claude" => {
            if v.get("type")?.as_str()? == "content_block_delta" {
                v.get("delta")?.get("text")?.as_str().map(String::from)
            } else {
                None
            }
        }
        _ => {
            // OpenAI-compatible SSE format
            v.get("choices")?
                .get(0)?
                .get("delta")?
                .get("content")?
                .as_str()
                .map(String::from)
        }
    }
}
