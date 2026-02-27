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
/// Supports abort via optional `request_id` — same mechanism as streaming.
#[tauri::command]
pub async fn ai_proxy_fetch(
    state: tauri::State<'_, AIProxyState>,
    request_id: Option<String>,
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

    // Register abort flag when request_id is provided
    let abort_flag = if let Some(ref rid) = request_id {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut flags) = state.abort_flags.lock() {
            flags.insert(rid.clone(), flag.clone());
        }
        Some(flag)
    } else {
        None
    };

    let result = if let Some(ref flag) = abort_flag {
        let flag_clone = flag.clone();
        let abort_checker = async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if flag_clone.load(Ordering::SeqCst) {
                    return;
                }
            }
        };
        tokio::select! {
            res = do_fetch(req) => res,
            _ = abort_checker => Err("Aborted by user".to_string()),
        }
    } else {
        do_fetch(req).await
    };

    // Cleanup abort flag
    if let Some(ref rid) = request_id {
        if let Ok(mut flags) = state.abort_flags.lock() {
            flags.remove(rid);
        }
    }

    result
}

async fn do_fetch(req: reqwest::RequestBuilder) -> Result<String, String> {
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
        return Err(truncate_api_error(status, &err_body));
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
        return Err(truncate_api_error(status, &err_body));
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut events_sent: u32 = 0;
    let mut last_sse_error: Option<String> = None;

    // Per-chunk read timeout: if no data arrives within this window, treat the
    // stream as stalled and exit.  This prevents indefinite hangs when the AI
    // provider drops the SSE connection without sending [DONE] or closing.
    const CHUNK_READ_TIMEOUT_SECS: u64 = 30;

    loop {
        // Race the next chunk against the abort flag AND a read timeout so we
        // never block longer than CHUNK_READ_TIMEOUT_SECS without data.
        let chunk_opt = {
            let abort_wait = async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    if abort_flag.load(Ordering::SeqCst) {
                        return;
                    }
                }
            };
            let read_timeout = tokio::time::sleep(
                std::time::Duration::from_secs(CHUNK_READ_TIMEOUT_SECS),
            );
            tokio::select! {
                c = stream.next() => c,
                _ = abort_wait => None,
                _ = read_timeout => {
                    eprintln!("[ai_proxy] Stream read timeout: no data for {}s", CHUNK_READ_TIMEOUT_SECS);
                    None
                },
            }
        };

        let chunk = match chunk_opt {
            Some(c) => c,
            None => break, // stream ended, aborted, or timed out
        };

        let bytes = chunk.map_err(|_| "Stream read error".to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete lines
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].to_string();
            buffer = buffer[pos + 1..].to_string();

            if let Some(text) = extract_sse_event(provider, &line) {
                events_sent += 1;
                let _ = on_event.send(text);
            } else if let Some(err) = extract_sse_error(&line) {
                last_sse_error = Some(err);
            } else if line.contains("data") {
                eprintln!("[ai_proxy] SSE line not parsed: {}", &line[..line.len().min(200)]);
            }
        }
    }

    // Flush remaining buffer
    if !buffer.is_empty() {
        if let Some(text) = extract_sse_event(provider, &buffer) {
            events_sent += 1;
            let _ = on_event.send(text);
        } else if let Some(err) = extract_sse_error(&buffer) {
            last_sse_error = Some(err);
        } else if buffer.contains("data") {
            eprintln!("[ai_proxy] SSE buffer not parsed: {}", &buffer[..buffer.len().min(200)]);
        }
    }

    // If no valid events were sent but an error was found in the SSE stream, report it
    if events_sent == 0 {
        if let Some(err) = last_sse_error {
            return Err(err);
        }
    }

    Ok(())
}

/// Truncate API error body to keep error messages readable.
/// Extracts the "message" field from JSON errors when possible.
fn truncate_api_error(status: u16, body: &str) -> String {
    // Try to extract a concise error message from JSON
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        // Common patterns: { "error": { "message": "..." } } or { "message": "..." }
        let msg = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str())
            .or_else(|| v.get("message").and_then(|m| m.as_str()));
        if let Some(m) = msg {
            let truncated = if m.len() > 300 { format!("{}...", &m[..300]) } else { m.to_string() };
            return format!("API error ({}): {}", status, truncated);
        }
    }
    // Fallback: truncate raw body
    let max = 500;
    if body.len() > max {
        format!("API error ({}): {}...", status, &body[..max])
    } else {
        format!("API error ({}): {}", status, body)
    }
}

/// Extract content from an SSE data line.
///
/// Returns plain text for text-content events, or `\x02` + raw JSON for
/// tool-call / metadata events so the JS side can distinguish them.
fn extract_sse_event(provider: &str, line: &str) -> Option<String> {
    let trimmed = line.trim();
    // SSE spec: space after colon is optional ("data: value" and "data:value" are both valid)
    let data = trimmed.strip_prefix("data: ")
        .or_else(|| trimmed.strip_prefix("data:"))?;
    if data == "[DONE]" {
        return None;
    }

    let v: serde_json::Value = serde_json::from_str(data).ok()?;

    match provider {
        "claude" => {
            let event_type = v.get("type")?.as_str()?;
            match event_type {
                "content_block_delta" => {
                    let delta = v.get("delta")?;
                    match delta.get("type")?.as_str()? {
                        "text_delta" => delta.get("text")?.as_str().map(String::from),
                        // Tool call argument fragments
                        "input_json_delta" => Some(format!("\x02{}", data)),
                        _ => None,
                    }
                }
                // Tool block start (id + name), block stop, message-level metadata
                "content_block_start" | "content_block_stop" | "message_delta" => {
                    Some(format!("\x02{}", data))
                }
                _ => None,
            }
        }
        _ => {
            // OpenAI-compatible SSE format
            let choices = v.get("choices")?.get(0)?;

            // Extract delta (may be absent in the final event from some providers)
            if let Some(delta) = choices.get("delta") {
                // Priority: tool_calls (non-empty array) > text content
                // Many OpenAI-compatible providers (e.g. Doubao/VolcEngine) include
                // "tool_calls": null in every SSE delta. We must only match when it's
                // a non-empty array containing actual tool call data.
                if delta
                    .get("tool_calls")
                    .and_then(|v| v.as_array())
                    .map_or(false, |a| !a.is_empty())
                {
                    return Some(format!("\x02{}", data));
                }
                if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                    if !content.is_empty() {
                        return Some(content.to_string());
                    }
                }
            }

            // finish_reason is on choices level, NOT inside delta.
            // Some providers omit delta entirely in the final event, so this
            // check must be outside the delta block to avoid being skipped.
            if choices.get("finish_reason").and_then(|f| f.as_str()).is_some() {
                return Some(format!("\x02{}", data));
            }
            None
        }
    }
}

/// Detect error objects inside SSE data lines.
/// Some providers return 200 OK but embed errors in the SSE stream body,
/// e.g. `data: {"error":{"message":"model not found","code":"404"}}`.
fn extract_sse_error(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let data = trimmed.strip_prefix("data: ")
        .or_else(|| trimmed.strip_prefix("data:"))?;
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    // Check for { "error": { "message": "..." } } or { "error": "..." }
    let error = v.get("error")?;
    let msg = error.get("message").and_then(|m| m.as_str())
        .or_else(|| error.as_str());
    let code_str = error.get("code").and_then(|c| c.as_str()).map(String::from);
    let code_num = error.get("code").and_then(|c| c.as_u64()).map(|n| n.to_string());
    let code = code_str.as_deref().or(code_num.as_deref());
    match (msg, code) {
        (Some(m), Some(c)) => Some(format!("API error ({}): {}", c, m)),
        (Some(m), None) => Some(format!("API error: {}", m)),
        _ => Some(format!("API error: {}", error)),
    }
}
