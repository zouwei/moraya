use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

pub(crate) const SERVICE_NAME: &str = "com.moraya.app";
const AI_KEY_PREFIX: &str = "ai-key:";
const SECRETS_KEY: &str = "moraya-secrets";
const REQUEST_TIMEOUT_SECS: u64 = 300;

/// File path for dev-mode secrets (avoids OS keychain prompts on unsigned binaries).
fn dev_secrets_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join(SERVICE_NAME).join("dev-secrets.json"))
}

// ---------------------------------------------------------------------------
// Platform-specific keychain helpers (release builds only)
// ---------------------------------------------------------------------------
//
// macOS: the `keyring` crate creates keychain items with an ACL tied to the
// calling binary's code signature.  After an overwrite-install the signature
// changes and macOS shows a password dialog.  To avoid this we use the
// `security` CLI with the `-A` flag ("allow all applications").  The secrets
// are still encrypted at rest inside the login keychain.
//
// Windows / Linux: the `keyring` crate works without ACL issues on updates.

#[cfg(target_os = "macos")]
fn read_os_secrets() -> String {
    std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s", SERVICE_NAME,
            "-a", SECRETS_KEY,
            "-w",
        ])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout)
                    .ok()
                    .map(|s| s.trim_end().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn write_os_secrets(json: &str) -> Result<(), String> {
    // Delete existing entry first (works regardless of old ACL)
    let _ = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-s", SERVICE_NAME,
            "-a", SECRETS_KEY,
        ])
        .output();

    // Add new entry with -A (allow all applications — avoids per-binary ACL)
    let output = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-s", SERVICE_NAME,
            "-a", SECRETS_KEY,
            "-w", json,
            "-A",
        ])
        .output()
        .map_err(|_| "Failed to access keychain".to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err("Failed to store in keychain".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn read_os_secrets() -> String {
    keyring::Entry::new(SERVICE_NAME, SECRETS_KEY)
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn write_os_secrets(json: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, SECRETS_KEY)
        .map_err(|_| "Failed to access keychain".to_string())?;
    entry
        .set_password(json)
        .map_err(|_| "Failed to store in keychain".to_string())
}

/// Shared state for aborting in-flight streaming requests and caching API keys.
///
/// - **Release builds**: secrets stored in OS keychain (`moraya-secrets`).
/// - **Debug builds**: secrets stored in a local JSON file to avoid
///   repeated macOS keychain authorization prompts.
pub struct AIProxyState {
    abort_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// In-memory mirror of secrets.
    pub(crate) key_cache: Mutex<HashMap<String, String>>,
    /// Whether secrets have been loaded into key_cache.
    secrets_loaded: AtomicBool,
}

impl AIProxyState {
    pub fn new() -> Self {
        Self {
            abort_flags: Mutex::new(HashMap::new()),
            key_cache: Mutex::new(HashMap::new()),
            secrets_loaded: AtomicBool::new(false),
        }
    }

    /// Load all secrets on first access. Subsequent calls are no-ops.
    pub(crate) fn ensure_secrets_loaded(&self) {
        if self
            .secrets_loaded
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return; // Already loaded
        }

        let json = if cfg!(debug_assertions) {
            // Dev mode: read from local file (no keychain prompts)
            dev_secrets_path()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .unwrap_or_default()
        } else {
            read_os_secrets()
        };

        if !json.is_empty() {
            if let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&json) {
                if let Ok(mut cache) = self.key_cache.lock() {
                    for (k, v) in map {
                        cache.insert(k, v);
                    }
                }
            }
        }
    }

    /// Persist the entire key cache.
    pub(crate) fn persist_secrets(&self) -> Result<(), String> {
        let json = {
            let cache = self
                .key_cache
                .lock()
                .map_err(|_| "Lock error".to_string())?;
            serde_json::to_string(&*cache)
                .map_err(|_| "Failed to serialize secrets".to_string())?
        };

        if cfg!(debug_assertions) {
            // Dev mode: write to local file
            if let Some(path) = dev_secrets_path() {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&path, &json)
                    .map_err(|_| "Failed to write dev secrets file".to_string())?;
            }
        } else {
            write_os_secrets(&json)?;
        }
        Ok(())
    }
}

impl Default for AIProxyState {
    fn default() -> Self {
        Self::new()
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

/// Resolve the API key: use override if provided, otherwise read from the
/// in-memory secrets cache (populated from the single keychain entry).
fn resolve_api_key(
    state: &AIProxyState,
    config_id: &str,
    key_prefix: Option<&str>,
    api_key_override: Option<&str>,
) -> Result<String, String> {
    if let Some(key) = api_key_override {
        if !key.is_empty() && key != "***" {
            return Ok(key.to_string());
        }
    }

    state.ensure_secrets_loaded();

    let prefix = key_prefix.unwrap_or(AI_KEY_PREFIX);
    let cache_key = format!("{}{}", prefix, config_id);

    if let Ok(cache) = state.key_cache.lock() {
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(cached.clone());
        }
    }

    // No key found — empty string (e.g. Ollama needs no auth)
    Ok(String::new())
}

/// Non-streaming AI API proxy.
/// Frontend builds URL/body/headers (without auth); Rust injects auth from keychain.
#[tauri::command]
pub async fn ai_proxy_fetch(
    state: tauri::State<'_, AIProxyState>,
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
        &state,
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
    let api_key = resolve_api_key(&state, &config_id, None, api_key_override.as_deref())?;
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
