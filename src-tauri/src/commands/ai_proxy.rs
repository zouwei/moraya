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

// Reads distinguish "nothing stored yet" (`Ok(None)`, fresh install) from
// "the store exists but could not be read" (`Err`: keychain locked after
// sleep, `security` timing out right after boot, a denied prompt …). The two
// must never be conflated: all secrets live in ONE serialized entry, so
// treating a failed read as empty and then persisting the next write would
// overwrite — i.e. destroy — every other stored secret.

/// macOS `security` exit status for errSecItemNotFound.
#[cfg(target_os = "macos")]
const SECURITY_ITEM_NOT_FOUND: i32 = 44;

#[cfg(target_os = "macos")]
fn read_os_secrets() -> Result<Option<String>, String> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s", SERVICE_NAME,
            "-a", SECRETS_KEY,
            "-w",
        ])
        .output()
        .map_err(|_| "Failed to access keychain".to_string())?;

    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map(|s| Some(s.trim_end().to_string()))
            .map_err(|_| "Keychain returned invalid data".to_string());
    }
    if output.status.code() == Some(SECURITY_ITEM_NOT_FOUND) {
        return Ok(None);
    }
    Err("Keychain is unavailable".to_string())
}

#[cfg(target_os = "macos")]
fn write_os_secrets(json: &str) -> Result<(), String> {
    // Delete, then re-add with -A (allow all applications). Never update in
    // place with `add-generic-password -U … -A`: on an existing item `-A` is
    // an ACL change, and macOS demands the login-keychain password for every
    // ACL change ("security wants to change access permissions …") — i.e. a
    // password prompt on every secret write. Delete + add never prompts.
    let _ = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-s", SERVICE_NAME,
            "-a", SECRETS_KEY,
        ])
        .output();

    // The entry is now absent, so retry a failed add once rather than leave
    // the secrets unpersisted.
    for _ in 0..2 {
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
            return Ok(());
        }
    }
    Err("Failed to store in keychain".to_string())
}

#[cfg(not(target_os = "macos"))]
fn read_os_secrets() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, SECRETS_KEY)
        .map_err(|_| "Failed to access keychain".to_string())?;
    match entry.get_password() {
        Ok(json) => Ok(Some(json)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Keychain is unavailable".to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn write_os_secrets(json: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, SECRETS_KEY)
        .map_err(|_| "Failed to access keychain".to_string())?;
    entry
        .set_password(json)
        .map_err(|_| "Failed to store in keychain".to_string())
}

fn read_dev_secrets() -> Result<Option<String>, String> {
    let Some(path) = dev_secrets_path() else { return Ok(None) };
    match std::fs::read_to_string(path) {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Failed to read dev secrets file".to_string()),
    }
}

/// Decode the stored secrets blob. `security -w` prints the password as hex
/// when it is not plain printable ASCII, so fall back to hex-decoding before
/// giving up. `None` = unreadable — never to be mistaken for "no secrets".
fn parse_secrets(raw: &str) -> Option<HashMap<String, String>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Some(HashMap::new());
    }
    if let Ok(map) = serde_json::from_str(raw) {
        return Some(map);
    }
    let bytes = hex::decode(raw).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Read and decode the whole stored secrets map (dev file or OS keychain).
/// Blocking. `Ok(empty)` when nothing is stored yet; `Err` when the store
/// exists but could not be read or decoded.
fn read_stored_secrets() -> Result<HashMap<String, String>, String> {
    let raw = if cfg!(debug_assertions) { read_dev_secrets() } else { read_os_secrets() }?;
    match raw {
        None => Ok(HashMap::new()),
        Some(json) => parse_secrets(&json).ok_or_else(|| "Stored secrets are unreadable".to_string()),
    }
}

/// Minimum gap between re-reads of the store on a cache miss.
const SECRETS_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

/// After a failed load, wait this long before touching the keychain again so
/// a locked keychain isn't hammered (or re-prompted) on every request.
const SECRETS_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Default)]
struct SecretsLoadState {
    loaded: bool,
    last_failed_attempt: Option<std::time::Instant>,
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
    /// Guards the keychain load. tokio::sync::Mutex ensures concurrent callers
    /// wait for an in-flight load instead of racing it.
    secrets_load: tokio::sync::Mutex<SecretsLoadState>,
    /// Serializes persists: each snapshots the cache and rewrites the single
    /// entry, so two overlapping writes could otherwise land out of order and
    /// drop a just-saved secret.
    persist_lock: tokio::sync::Mutex<()>,
    /// The stored map as this process last read or wrote it. Diffing the cache
    /// against it isolates THIS process's own changes, so a persist can apply
    /// just those on top of a fresh read — never clobbering secrets another
    /// Moraya process saved in the meantime (all secrets share one entry).
    secrets_base: Mutex<HashMap<String, String>>,
    last_refresh: Mutex<Option<std::time::Instant>>,
}

impl AIProxyState {
    pub fn new() -> Self {
        Self {
            abort_flags: Mutex::new(HashMap::new()),
            key_cache: Mutex::new(HashMap::new()),
            secrets_load: tokio::sync::Mutex::new(SecretsLoadState::default()),
            persist_lock: tokio::sync::Mutex::new(()),
            secrets_base: Mutex::new(HashMap::new()),
            last_refresh: Mutex::new(None),
        }
    }

    /// Whether the stored secrets have been loaded successfully. Until then a
    /// missing key means "store unreadable", not "never saved".
    pub(crate) async fn secrets_available(&self) -> bool {
        self.secrets_load.lock().await.loaded
    }

    /// Load all secrets on first successful access; later calls are no-ops.
    /// A failed load is NOT marked loaded — it is retried (rate-limited) and,
    /// until it succeeds, `persist_secrets` refuses to write.
    /// The OS keychain read runs in a blocking thread so it never stalls
    /// the Tauri async runtime (macOS `security` CLI / Windows keyring can
    /// block for hundreds of milliseconds on cold start or when the keychain
    /// daemon is initializing after a system reboot).
    pub(crate) async fn ensure_secrets_loaded(&self) {
        let mut state = self.secrets_load.lock().await;
        if state.loaded {
            return;
        }
        if let Some(at) = state.last_failed_attempt {
            if at.elapsed() < SECRETS_RETRY_INTERVAL {
                return;
            }
        }

        // Dev mode reads a local file (no keychain prompts) — see read_stored_secrets.
        let read = tokio::task::spawn_blocking(read_stored_secrets)
            .await
            .unwrap_or_else(|_| Err("Keychain task failed".to_string()));
        let Ok(map) = read else {
            eprintln!("[secrets] keychain read failed; secrets stay read-only until it succeeds");
            state.last_failed_attempt = Some(std::time::Instant::now());
            return;
        };

        if let Ok(mut base) = self.secrets_base.lock() {
            *base = map.clone();
        }
        if let Ok(mut cache) = self.key_cache.lock() {
            // Values set in memory while the store was unreadable are newer.
            for (k, v) in map {
                cache.entry(k).or_insert(v);
            }
        }
        state.loaded = true;
        state.last_failed_attempt = None;
    }

    /// Persist this process's secret changes. Read-merge-write: re-reads the
    /// stored map and applies only the keys this process added, changed or
    /// removed since it last read/wrote the store (cache vs `secrets_base`),
    /// so secrets saved by another Moraya process survive. Refuses while the
    /// store is unreadable — writing then would replace it with a partial map.
    /// Keychain I/O runs in a blocking thread for the same reason as
    /// `ensure_secrets_loaded`.
    pub(crate) async fn persist_secrets(&self) -> Result<(), String> {
        const UNAVAILABLE: &str =
            "Keychain is unavailable — secrets were not saved. Unlock the keychain and try again.";
        if !self.secrets_load.lock().await.loaded {
            return Err(UNAVAILABLE.to_string());
        }
        let _guard = self.persist_lock.lock().await;

        let fresh = tokio::task::spawn_blocking(read_stored_secrets)
            .await
            .unwrap_or_else(|_| Err("Keychain task failed".to_string()))
            .map_err(|_| UNAVAILABLE.to_string())?;

        let merged = {
            let cache = self.key_cache.lock().map_err(|_| "Lock error".to_string())?;
            let base = self.secrets_base.lock().map_err(|_| "Lock error".to_string())?;
            merge_local_changes(fresh, &base, &cache)
        };
        let json = serde_json::to_string(&merged)
            .map_err(|_| "Failed to serialize secrets".to_string())?;

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
            tokio::task::spawn_blocking(move || write_os_secrets(&json))
                .await
                .unwrap_or_else(|_| Err("Keychain task failed".to_string()))?;
        }

        // The store now holds `merged`: adopt it as both cache and base, which
        // also picks up whatever other processes had written.
        if let Ok(mut cache) = self.key_cache.lock() {
            *cache = merged.clone();
        }
        if let Ok(mut base) = self.secrets_base.lock() {
            *base = merged;
        }
        Ok(())
    }

    /// Pull in secrets other processes wrote since we last read the store,
    /// without disturbing this process's own unsaved changes. Rate-limited;
    /// used on a cache miss (e.g. a key saved from another Moraya instance).
    pub(crate) async fn refresh_secrets(&self) {
        if !self.secrets_load.lock().await.loaded {
            return;
        }
        if let Ok(mut last) = self.last_refresh.lock() {
            if last.is_some_and(|at| at.elapsed() < SECRETS_REFRESH_INTERVAL) {
                return;
            }
            *last = Some(std::time::Instant::now());
        }
        let _guard = self.persist_lock.lock().await;
        let Ok(Ok(fresh)) = tokio::task::spawn_blocking(read_stored_secrets).await else {
            return;
        };
        let (Ok(mut cache), Ok(mut base)) = (self.key_cache.lock(), self.secrets_base.lock()) else {
            return;
        };
        *cache = merge_local_changes(fresh.clone(), &base, &cache);
        *base = fresh;
    }
}

/// Three-way merge: start from the freshly read store and re-apply the keys
/// this process changed relative to `base` (added/updated → its value,
/// removed → removed). Keys it did not touch take the store's current value.
fn merge_local_changes(
    fresh: HashMap<String, String>,
    base: &HashMap<String, String>,
    cache: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut merged = fresh;
    for (k, v) in cache {
        if base.get(k) != Some(v) {
            merged.insert(k.clone(), v.clone());
        }
    }
    for k in base.keys() {
        if !cache.contains_key(k) {
            merged.remove(k);
        }
    }
    merged
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
async fn resolve_api_key(
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

    state.ensure_secrets_loaded().await;

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
    ).await?;
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
    let api_key = resolve_api_key(&state, &config_id, None, api_key_override.as_deref()).await?;
    let client = build_client()?;
    let hdrs = headers.unwrap_or_default();
    let req = build_request(&client, &provider, &api_key, &url, &body, &hdrs, "POST");

    // Register abort flag
    let abort_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.abort_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(request_id.clone(), abort_flag.clone());
    }

    // Liveness heartbeat ticker for the WHOLE request lifetime — crucially
    // including the initial `req.send().await` wait, before any SSE byte
    // arrives. A slow first token (large tool lists, reasoning models that
    // buffer, or a provider under load) can exceed the frontend's 120s
    // stall-watchdog while the request is perfectly healthy. This background
    // task sends a heartbeat (\x01, which the frontend renders nothing for)
    // every 15s so the watchdog tracks true request liveness. It stops on
    // user-abort (flag) or when the request finishes (handle aborted below).
    let hb_handle = {
        let ch = on_event.clone();
        let abort = abort_flag.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                if abort.load(Ordering::SeqCst) {
                    break;
                }
                if ch.send("\u{1}".to_string()).is_err() {
                    break; // channel closed — receiver gone
                }
            }
        })
    };

    let result = do_stream(&on_event, &provider, req, &abort_flag).await;

    hb_handle.abort();

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
        if bytes.is_empty() {
            continue;
        }
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete lines
        let events_before = events_sent;
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].to_string();
            buffer = buffer[pos + 1..].to_string();

            if let Some(text) = extract_sse_event(provider, &line) {
                events_sent += 1;
                let _ = on_event.send(text);
            } else if let Some(err) = extract_sse_error(&line) {
                last_sse_error = Some(err);
            } else if line.contains("data") {
                eprintln!("[ai_proxy] SSE line not parsed: {}", safe_truncate(&line, 200));
            }
        }

        // Liveness heartbeat: this chunk carried real bytes but produced no
        // forwarded content event (e.g. reasoning/thinking deltas, `ping`,
        // message_start, keepalive comments, or a partial line). Send a
        // heartbeat so the frontend's stall-watchdog knows the stream is alive
        // — otherwise a model that streams non-text output (extended thinking)
        // for >120s would be wrongly aborted with "Stream stalled". The
        // frontend treats HEARTBEAT (\x01) as liveness-only and renders nothing.
        if events_sent == events_before {
            let _ = on_event.send("\u{1}".to_string());
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
            eprintln!("[ai_proxy] SSE buffer not parsed: {}", safe_truncate(&buffer, 200));
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

/// Truncate a UTF-8 string to at most `max_bytes` bytes, ensuring the cut
/// lands on a char boundary (never splits a multi-byte character).
fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
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
            let truncated = if m.len() > 300 { format!("{}...", safe_truncate(m, 300)) } else { m.to_string() };
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

#[cfg(test)]
mod secrets_merge_tests {
    use super::merge_local_changes;
    use std::collections::HashMap;

    fn m(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn keeps_a_key_another_process_saved() {
        // We loaded {ai}; another process then saved the Picora key; we now
        // update the AI key. The Picora key must survive our write.
        let base = m(&[("ai-key:c1", "old")]);
        let cache = m(&[("ai-key:c1", "new")]);
        let fresh = m(&[("ai-key:c1", "old"), ("picora-api-key:t1", "sk_1")]);
        let merged = merge_local_changes(fresh, &base, &cache);
        assert_eq!(merged, m(&[("ai-key:c1", "new"), ("picora-api-key:t1", "sk_1")]));
    }

    #[test]
    fn applies_local_deletes_only() {
        let base = m(&[("a", "1"), ("b", "2")]);
        let cache = m(&[("a", "1")]); // we deleted b
        let fresh = m(&[("a", "1"), ("b", "2"), ("c", "3")]);
        assert_eq!(merge_local_changes(fresh, &base, &cache), m(&[("a", "1"), ("c", "3")]));
    }

    #[test]
    fn untouched_keys_take_the_stored_value() {
        // Another process re-saved the Picora key; we did not touch it.
        let base = m(&[("picora-api-key:t1", "sk_old")]);
        let cache = base.clone();
        let fresh = m(&[("picora-api-key:t1", "sk_new")]);
        assert_eq!(merge_local_changes(fresh, &base, &cache), m(&[("picora-api-key:t1", "sk_new")]));
    }
}

#[cfg(test)]
mod secrets_parse_tests {
    use super::parse_secrets;

    #[test]
    fn parses_plain_json() {
        let map = parse_secrets(r#"{"picora-api-key:t1":"sk_1"}"#).unwrap();
        assert_eq!(map.get("picora-api-key:t1").map(String::as_str), Some("sk_1"));
    }

    #[test]
    fn parses_hex_output_from_security_cli() {
        // `security -w` hex-encodes passwords that are not plain ASCII.
        let json = r#"{"git-username:c1":"张三","picora-api-key:t1":"sk_1"}"#;
        let map = parse_secrets(&hex::encode(json)).unwrap();
        assert_eq!(map.get("git-username:c1").map(String::as_str), Some("张三"));
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn unreadable_blob_is_not_treated_as_empty() {
        assert!(parse_secrets("not-json-not-hex").is_none());
        assert!(parse_secrets("{\"truncated\":").is_none());
    }

    #[test]
    fn empty_blob_is_empty_map() {
        assert!(parse_secrets("").unwrap().is_empty());
    }
}
