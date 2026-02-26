use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_READ_TIMEOUT: Duration = Duration::from_secs(10);
const PLUGIN_MAX_LINE: usize = 64 * 1024; // 64 KB

/// Registry index URL (pinned — not user-configurable to prevent hijacking)
const REGISTRY_INDEX_URL: &str =
    "https://raw.githubusercontent.com/moraya-apps/moraya-plugin-registry/main/index.json";
const REGISTRY_BLACKLIST_URL: &str =
    "https://raw.githubusercontent.com/moraya-apps/moraya-plugin-registry/main/blacklist.json";

/// Cache TTL: 30 minutes
const CACHE_TTL_MS: u64 = 30 * 60 * 1000;

/// Permissions that plugins are allowed to declare. Any other value is rejected.
const ALLOWED_PERMISSIONS: &[&str] = &[
    "editor:read",
    "editor:write",
    "ai:chat",
    "ai:image",
    "ai:voice",
    "ai:voice:capture",
    "net:external",
];

/// Dangerous environment variable prefixes — same list as mcp.rs
const BLOCKED_ENV_PREFIXES: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "npm_config_",
    "npm_lifecycle_",
    "npm_package_",
    "NPM_",
    "PNPM_",
];

// ---------------------------------------------------------------------------
// JSON types mirroring frontend plugin/types.ts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub license: String,
    pub api_version: String,
    pub entry: HashMap<String, String>,
    pub protocol: String,
    pub permissions: Vec<String>,
    #[serde(default)]
    pub permission_reasons: HashMap<String, String>,
    pub sandbox_level: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub limits: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateEntry {
    pub id: String,
    pub enabled: bool,
    pub plugin_dir: String,
    pub installed_at: u64,
    pub manifest: PluginManifest,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub valid: bool,
    pub manifest: Option<PluginManifest>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    pub plugin: Option<PluginStateEntry>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Plugin process (mirrors MCPProcess from mcp.rs)
// ---------------------------------------------------------------------------

enum ReadResult {
    Line(String),
    Eof,
    Error(String),
}

struct PluginProcess {
    child: Child,
    stdin: ChildStdin,
    #[allow(dead_code)]
    stderr: ChildStderr,
    line_rx: Receiver<ReadResult>,
}

fn spawn_reader_thread(stdout: ChildStdout) -> Receiver<ReadResult> {
    let (tx, rx): (SyncSender<ReadResult>, Receiver<ReadResult>) =
        std::sync::mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(ReadResult::Eof);
                    break;
                }
                Ok(_) => {
                    if tx.send(ReadResult::Line(line)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(ReadResult::Error(e.to_string()));
                    break;
                }
            }
        }
    });
    rx
}

/// Manages plugin sidecar processes (one per enabled plugin).
pub struct PluginProcessManager {
    processes: Mutex<HashMap<String, PluginProcess>>,
    pids: Mutex<HashMap<String, u32>>,
}

impl PluginProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            pids: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for PluginProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_safe_env_var(key: &str) -> bool {
    !BLOCKED_ENV_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|_| "Failed to read file for hash".to_string())?;
    let hash = Sha256::digest(&bytes);
    Ok(hex::encode(hash))
}

fn current_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x86_64";
    #[cfg(target_os = "windows")]
    return "win32";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64";
    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    )))]
    return "unknown";
}

/// Validate an extracted plugin.json manifest.
/// Returns a list of errors; empty = valid.
fn validate_manifest(manifest: &PluginManifest) -> (Vec<String>, Vec<String>) {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    // id format: ^[a-z][a-z0-9-]{2,63}$
    if manifest.id.is_empty() {
        errors.push("id 不能为空".to_string());
    } else if !manifest
        .id
        .chars()
        .next()
        .map(|c| c.is_ascii_lowercase())
        .unwrap_or(false)
        || !manifest
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || manifest.id.len() < 3
        || manifest.id.len() > 64
    {
        errors.push("id 格式非法（仅小写字母、数字、连字符，长度 3-64）".to_string());
    }

    if manifest.name.trim().is_empty() {
        errors.push("缺少插件名称 (name)".to_string());
    }

    // semver check: x.y.z
    let semver_ok = {
        let parts: Vec<&str> = manifest.version.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| p.parse::<u32>().is_ok())
    };
    if !semver_ok {
        errors.push("版本号格式错误，需为 x.y.z".to_string());
    }

    if manifest.api_version.is_empty() {
        errors.push("缺少 apiVersion".to_string());
    } else if manifest.api_version != "1" {
        errors.push(format!(
            "需要 API v{}，当前 Moraya 支持至 v1，请升级 Moraya",
            manifest.api_version
        ));
    }

    if manifest.protocol != "jsonrpc-stdio" {
        errors.push(format!(
            "不支持的通信协议: {}",
            manifest.protocol
        ));
    }

    if manifest.entry.is_empty() {
        errors.push("缺少 entry 字段".to_string());
    } else {
        // Check entry paths for directory traversal
        for (platform, path) in &manifest.entry {
            if path.contains("..") || path.starts_with('/') || path.starts_with('\\') {
                errors.push(format!(
                    "entry[{}] 路径存在安全风险，拒绝安装",
                    platform
                ));
            }
        }
        // Check current platform is covered
        let platform = current_platform();
        if !manifest.entry.contains_key(platform) {
            errors.push(format!("此插件暂不支持 {}", platform));
        }
    }

    // Permission whitelist check
    for perm in &manifest.permissions {
        if !ALLOWED_PERMISSIONS.contains(&perm.as_str()) {
            errors.push(format!("声明了未知权限: {}，拒绝安装", perm));
        }
    }

    // sandboxLevel warning for system level
    if manifest.sandbox_level == "system" && !manifest.permissions.contains(&"net:external".to_string()) {
        warnings.push("sandboxLevel 为 system 但未声明 net:external 权限".to_string());
    }

    (errors, warnings)
}

/// Extract plugin.json from a zip file (in memory, without writing to disk yet).
fn read_manifest_from_zip(zip_path: &std::path::Path) -> Result<PluginManifest, String> {
    let file = std::fs::File::open(zip_path).map_err(|_| "无法打开 zip 文件".to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| "zip 文件格式无效".to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|_| "读取 zip 条目失败".to_string())?;
        let name = entry.name().to_string();
        // Match plugin.json at the root (not nested)
        if name == "plugin.json" || name.ends_with("/plugin.json") {
            let mut content = String::new();
            use std::io::Read;
            entry
                .read_to_string(&mut content)
                .map_err(|_| "plugin.json 读取失败".to_string())?;
            let manifest: PluginManifest = serde_json::from_str(&content)
                .map_err(|e| format!("plugin.json 格式错误，无法解析: {}", e))?;
            return Ok(manifest);
        }
    }
    Err("zip 中未找到 plugin.json".to_string())
}

/// Extract zip to a target directory with Zip Slip protection.
fn extract_zip_safe(
    zip_path: &std::path::Path,
    target_dir: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|_| "无法打开 zip 文件".to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| "zip 文件格式无效".to_string())?;

    std::fs::create_dir_all(target_dir)
        .map_err(|_| "无法创建插件目录".to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|_| "读取 zip 条目失败".to_string())?;

        let raw_name = entry.name().to_string();

        // Zip Slip protection: reject any path with .. or absolute paths
        if raw_name.contains("..") || raw_name.starts_with('/') || raw_name.starts_with('\\') {
            return Err("zip 文件包含非法路径，拒绝安装".to_string());
        }

        let out_path = target_dir.join(&raw_name);

        // Ensure the resolved path stays inside target_dir
        let canonical_target = target_dir
            .canonicalize()
            .unwrap_or_else(|_| target_dir.to_path_buf());
        if let Ok(canonical_out) = out_path.parent().map(|p| p.to_path_buf()).unwrap_or_default().canonicalize() {
            if !canonical_out.starts_with(&canonical_target) {
                return Err("zip 文件包含路径穿越条目，拒绝安装".to_string());
            }
        }

        if entry.name().ends_with('/') {
            std::fs::create_dir_all(&out_path)
                .map_err(|_| "创建子目录失败".to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|_| "创建父目录失败".to_string())?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|_| "创建文件失败".to_string())?;
            use std::io::Read;
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|_| "读取 zip 内容失败".to_string())?;
            use std::io::Write as IoWrite;
            out_file
                .write_all(&buf)
                .map_err(|_| "写入文件失败".to_string())?;
        }
    }
    Ok(())
}

/// Set executable bit on Unix for the plugin binary.
#[cfg(unix)]
fn set_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(perms.mode() | 0o111);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn set_executable(_path: &std::path::Path) {}

/// Kill a plugin process group (Unix: SIGTERM → wait → SIGKILL).
#[cfg(unix)]
fn kill_plugin(pid: u32) {
    let pgid = -(pid as libc::pid_t);
    unsafe {
        libc::kill(pgid, libc::SIGTERM);
    }
    let start = std::time::Instant::now();
    loop {
        let ret = unsafe {
            let mut status: libc::c_int = 0;
            libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG)
        };
        if ret > 0 {
            return;
        }
        if start.elapsed() >= Duration::from_secs(2) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        libc::kill(pgid, libc::SIGKILL);
        let mut status: libc::c_int = 0;
        libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG);
    }
}

#[cfg(not(unix))]
fn kill_plugin(_pid: u32) {}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Validate a plugin.json manifest from a GitHub URL (raw) or local path.
/// Used for URL-import validation before showing the install confirmation UI.
#[tauri::command]
pub async fn plugin_validate_manifest(source: String) -> Result<ValidationResult, String> {
    let json_str = if source.starts_with("http://") || source.starts_with("https://") {
        // Fetch remote plugin.json
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("Moraya/0.16.0")
            .build()
            .map_err(|_| "HTTP client 初始化失败".to_string())?;
        let resp = client
            .get(&source)
            .send()
            .await
            .map_err(|_| "无法访问插件仓库".to_string())?;
        if !resp.status().is_success() {
            return Ok(ValidationResult {
                valid: false,
                manifest: None,
                errors: vec![format!(
                    "无法获取 plugin.json，HTTP {}",
                    resp.status().as_u16()
                )],
                warnings: vec![],
            });
        }
        resp.text()
            .await
            .map_err(|_| "读取响应失败".to_string())?
    } else {
        // Local file
        std::fs::read_to_string(&source).map_err(|_| "读取本地 plugin.json 失败".to_string())?
    };

    // Parse JSON
    let manifest: PluginManifest = match serde_json::from_str(&json_str) {
        Ok(m) => m,
        Err(e) => {
            return Ok(ValidationResult {
                valid: false,
                manifest: None,
                errors: vec![format!("plugin.json 格式错误，无法解析: {}", e)],
                warnings: vec![],
            });
        }
    };

    let (errors, warnings) = validate_manifest(&manifest);
    let valid = errors.is_empty();
    Ok(ValidationResult {
        valid,
        manifest: if valid { Some(manifest) } else { None },
        errors,
        warnings,
    })
}

/// Install a plugin from a local zip file.
/// Validates SHA256 if expected_sha256 is provided (used during online install).
#[tauri::command]
pub async fn plugin_install_local(
    app: tauri::AppHandle,
    zip_path: String,
    expected_sha256: Option<String>,
) -> Result<InstallResult, String> {
    let zip_p = std::path::Path::new(&zip_path);

    // 1. SHA256 verification (if expected hash provided)
    if let Some(expected) = &expected_sha256 {
        let actual = sha256_file(zip_p)?;
        if actual.to_lowercase() != expected.to_lowercase() {
            return Ok(InstallResult {
                ok: false,
                plugin: None,
                error: Some("文件完整性验证失败，已阻止安装".to_string()),
            });
        }
    }

    // 2. Read and validate plugin.json from zip
    let manifest = match read_manifest_from_zip(zip_p) {
        Ok(m) => m,
        Err(e) => {
            return Ok(InstallResult {
                ok: false,
                plugin: None,
                error: Some(e),
            });
        }
    };

    let (errors, _) = validate_manifest(&manifest);
    if !errors.is_empty() {
        return Ok(InstallResult {
            ok: false,
            plugin: None,
            error: Some(errors.join("；")),
        });
    }

    // 3. Determine plugin directory
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法获取 appData 目录".to_string())?;
    let plugin_dir = app_data.join("plugins").join(&manifest.id);

    // 4. Extract zip to plugin directory
    if plugin_dir.exists() {
        std::fs::remove_dir_all(&plugin_dir).map_err(|_| "无法清除旧版本目录".to_string())?;
    }
    extract_zip_safe(zip_p, &plugin_dir)?;

    // 5. Set executable bit on the platform binary
    let platform = current_platform();
    if let Some(entry_rel) = manifest.entry.get(platform) {
        let bin_path = plugin_dir.join(entry_rel);
        set_executable(&bin_path);
    }

    // 6. Build state entry
    let entry = PluginStateEntry {
        id: manifest.id.clone(),
        enabled: false, // default: disabled after install
        plugin_dir: plugin_dir.to_string_lossy().into_owned(),
        installed_at: epoch_ms(),
        manifest,
    };

    Ok(InstallResult {
        ok: true,
        plugin: Some(entry),
        error: None,
    })
}

/// Download a plugin from a URL, verify SHA256, then install.
#[tauri::command]
pub async fn plugin_install_from_url(
    app: tauri::AppHandle,
    download_url: String,
    expected_sha256: String,
    window: tauri::Window,
) -> Result<InstallResult, String> {
    // 1. Download to a temp file with progress events
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("Moraya/0.16.0")
        .build()
        .map_err(|_| "HTTP client 初始化失败".to_string())?;

    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|_| "下载失败，请检查网络连接".to_string())?;

    if !resp.status().is_success() {
        return Ok(InstallResult {
            ok: false,
            plugin: None,
            error: Some(format!("下载失败，HTTP {}", resp.status().as_u16())),
        });
    }

    let total_size = resp.content_length().unwrap_or(0);

    // Stream to temp file
    let tmp_path = std::env::temp_dir().join(format!("moraya-plugin-{}.zip", epoch_ms()));
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|_| "无法创建临时文件".to_string())?;

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "下载中断".to_string())?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|_| "写入临时文件失败".to_string())?;
        downloaded += chunk.len() as u64;

        // Emit progress event to frontend
        let _ = window.emit(
            "plugin:download_progress",
            serde_json::json!({
                "downloaded": downloaded,
                "total": total_size,
            }),
        );
    }
    drop(file);

    // 2. Delegate to plugin_install_local with SHA256 check
    let tmp_str = tmp_path.to_string_lossy().into_owned();
    let result = plugin_install_local(app, tmp_str, Some(expected_sha256)).await;

    // Cleanup temp file
    let _ = std::fs::remove_file(&tmp_path);

    result
}

/// Start a plugin process.
#[tauri::command]
pub fn plugin_enable(
    app: tauri::AppHandle,
    state: State<'_, PluginProcessManager>,
    entry: PluginStateEntry,
) -> Result<(), String> {
    let platform = current_platform();
    let bin_rel = entry
        .manifest
        .entry
        .get(platform)
        .ok_or_else(|| format!("此插件不支持 {}", platform))?;

    let bin_path = std::path::Path::new(&entry.plugin_dir).join(bin_rel);
    if !bin_path.exists() {
        return Err("插件二进制文件不存在，请重新安装".to_string());
    }

    // Kill existing process if any
    {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        if let Some(mut proc) = processes.remove(&entry.id) {
            let _ = proc.child.kill();
            let _ = proc.child.wait();
        }
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法获取 appData 目录".to_string())?;
    let plugin_data_dir = app_data.join("plugins").join(&entry.id).join("data");
    let _ = std::fs::create_dir_all(&plugin_data_dir);

    let mut cmd = Command::new(&bin_path);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(&plugin_data_dir);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // Filtered environment
    cmd.env_clear();
    for (key, value) in std::env::vars() {
        if is_safe_env_var(&key) {
            cmd.env(&key, &value);
        }
    }
    cmd.env("MORAYA_PLUGIN_ID", &entry.id);
    cmd.env("MORAYA_API_VERSION", "1");

    let mut child = cmd.spawn().map_err(|_| "插件启动失败".to_string())?;
    let pid = child.id();

    let stdin = child.stdin.take().ok_or("无法获取插件 stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取插件 stdout")?;
    let stderr = child.stderr.take().ok_or("无法获取插件 stderr")?;

    let line_rx = spawn_reader_thread(stdout);

    if let Ok(mut pids) = state.pids.lock() {
        pids.insert(entry.id.clone(), pid);
    }

    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    processes.insert(
        entry.id.clone(),
        PluginProcess { child, stdin, stderr, line_rx },
    );

    Ok(())
}

/// Stop a plugin process.
#[tauri::command]
pub fn plugin_disable(
    state: State<'_, PluginProcessManager>,
    plugin_id: String,
) -> Result<(), String> {
    if let Ok(mut pids) = state.pids.lock() {
        if let Some(pid) = pids.remove(&plugin_id) {
            kill_plugin(pid);
        }
    }
    if let Ok(mut processes) = state.processes.lock() {
        if let Some(proc) = processes.remove(&plugin_id) {
            drop(proc);
        }
    }
    Ok(())
}

/// Uninstall a plugin: stop process + delete directory.
#[tauri::command]
pub fn plugin_uninstall(
    app: tauri::AppHandle,
    state: State<'_, PluginProcessManager>,
    plugin_id: String,
) -> Result<(), String> {
    // Stop process first
    let _ = plugin_disable(state, plugin_id.clone());

    // Delete plugin directory
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法获取 appData 目录".to_string())?;
    let plugin_dir = app_data.join("plugins").join(&plugin_id);
    if plugin_dir.exists() {
        std::fs::remove_dir_all(&plugin_dir).map_err(|_| "删除插件目录失败".to_string())?;
    }
    Ok(())
}

/// List running plugin IDs (used to populate processState in frontend).
#[tauri::command]
pub fn plugin_list_running(state: State<'_, PluginProcessManager>) -> Vec<String> {
    state
        .processes
        .lock()
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default()
}

/// Send a JSON-RPC request to a running plugin and return the response.
#[tauri::command]
pub async fn plugin_invoke(
    state: State<'_, PluginProcessManager>,
    plugin_id: String,
    request: String,
) -> Result<String, String> {
    // Write request and take process out of the map (same pattern as mcp_send_request)
    let mut proc = {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        let proc = processes
            .get_mut(&plugin_id)
            .ok_or("插件未运行")?;
        if writeln!(proc.stdin, "{}", request).is_err() {
            return Err("写入插件 stdin 失败".to_string());
        }
        proc.stdin.flush().map_err(|_| "刷新插件 stdin 失败".to_string())?;
        processes.remove(&plugin_id).ok_or("插件未运行")?
    };

    // Read response on a blocking thread
    let (result, returned_proc) = tokio::task::spawn_blocking(move || {
        let result = read_plugin_response(&mut proc);
        (result, proc)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    // Put process back or clean up
    match &result {
        Ok(_) => {
            if let Ok(mut processes) = state.processes.lock() {
                processes.insert(plugin_id, returned_proc);
            }
        }
        Err(_) => {
            let mut proc = returned_proc;
            let _ = proc.child.kill();
            let _ = proc.child.try_wait();
        }
    }

    result
}

fn read_plugin_response(proc: &mut PluginProcess) -> Result<String, String> {
    loop {
        match proc.line_rx.recv_timeout(PLUGIN_READ_TIMEOUT) {
            Ok(ReadResult::Line(line)) => {
                if line.len() > PLUGIN_MAX_LINE {
                    return Err("插件响应超过长度限制".to_string());
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.starts_with('{') {
                    return Ok(trimmed.to_string());
                }
            }
            Ok(ReadResult::Eof) => return Err("插件进程意外退出".to_string()),
            Ok(ReadResult::Error(e)) => return Err(format!("读取插件响应失败: {}", e)),
            Err(_) => return Err("插件响应超时".to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Registry & Market commands
// ---------------------------------------------------------------------------

/// Fetch the plugin registry and GitHub metadata.
/// Returns cached data immediately if fresh enough; fetches in parallel if stale.
#[tauri::command]
pub async fn plugin_registry_fetch(
    app: tauri::AppHandle,
    force_refresh: bool,
) -> Result<serde_json::Value, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法获取 appData 目录".to_string())?;
    let cache_path = app_data.join("plugin-registry-cache.json");

    // Check if cache is still fresh
    if !force_refresh && cache_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&cache_path) {
            if let Ok(cache) = serde_json::from_str::<serde_json::Value>(&content) {
                let fetched_at = cache
                    .get("fetchedAt")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let age_ms = epoch_ms().saturating_sub(fetched_at);
                if age_ms < CACHE_TTL_MS {
                    let mut result = cache.clone();
                    result["fromCache"] = serde_json::Value::Bool(true);
                    return Ok(result);
                }
            }
        }
    }

    // Fetch index.json from registry
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Moraya/0.16.0")
        .build()
        .map_err(|_| "HTTP client 初始化失败".to_string())?;

    let index_resp = client
        .get(REGISTRY_INDEX_URL)
        .send()
        .await
        .map_err(|_| "无法访问插件注册表".to_string())?;

    let index = index_resp
        .json::<serde_json::Value>()
        .await
        .map_err(|_| "注册表 index.json 格式错误".to_string())?;

    let plugins_arr = index
        .get("plugins")
        .and_then(|p: &serde_json::Value| p.as_array())
        .cloned()
        .unwrap_or_default();

    // For each plugin, concurrently fetch GitHub data
    let mut handles = Vec::new();
    for plugin_entry in plugins_arr {
        let client = client.clone();
        let handle = tokio::spawn(async move {
            enrich_plugin_entry(client, plugin_entry).await
        });
        handles.push(handle);
    }

    let mut enriched_plugins = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(Ok(plugin)) => enriched_plugins.push(plugin),
            _ => {} // Skip failed entries (network error, etc.)
        }
    }

    let now = epoch_ms();
    let result = serde_json::json!({
        "fetchedAt": now,
        "plugins": enriched_plugins,
        "fromCache": false,
    });

    // Write cache
    if let Ok(content) = serde_json::to_string(&result) {
        let _ = std::fs::write(&cache_path, content);
    }

    Ok(result)
}

/// Fetch GitHub API data and plugin.json for a single registry entry.
async fn enrich_plugin_entry(
    client: reqwest::Client,
    mut entry: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let repo = entry
        .get("repo")
        .and_then(|r| r.as_str())
        .ok_or("missing repo")?
        .to_string();

    // Fetch repo metadata from GitHub API
    let repo_url = format!("https://api.github.com/repos/{}", repo);
    let releases_url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let (repo_parts, _) = repo.split_once('/').unwrap_or(("", ""));
    let (_, repo_name) = repo.split_once('/').unwrap_or(("", &repo));
    let icon_url = format!(
        "https://raw.githubusercontent.com/{}/main/icon.png",
        format!("moraya-apps/moraya-plugin-registry/main/plugins/{}", repo_name)
    );

    // Concurrent GitHub requests
    let (repo_result, releases_result) = tokio::join!(
        client.get(&repo_url)
            .header("Accept", "application/vnd.github.v3+json")
            .send(),
        client.get(&releases_url)
            .header("Accept", "application/vnd.github.v3+json")
            .send(),
    );

    // Parse repo info
    if let Ok(resp) = repo_result {
        if let Ok(repo_data) = resp.json::<serde_json::Value>().await {
            entry["stars"] = repo_data.get("stargazers_count").cloned().unwrap_or(serde_json::Value::Null);
            entry["description"] = repo_data.get("description").cloned().unwrap_or(serde_json::json!(""));
            entry["license"] = repo_data
                .get("license")
                .and_then(|l: &serde_json::Value| l.get("spdx_id"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            entry["updatedAt"] = repo_data.get("updated_at").cloned().unwrap_or(serde_json::Value::Null);
            entry["name"] = repo_data.get("name").cloned().unwrap_or(serde_json::json!(repo_name));
        }
    }

    // Parse latest release — build downloadUrls map
    if let Ok(resp) = releases_result {
        if let Ok(release_data) = resp.json::<serde_json::Value>().await {
            entry["changelog"] = release_data
                .get("body")
                .cloned()
                .unwrap_or(serde_json::json!(""));

            let mut download_urls = serde_json::Map::new();
            if let Some(assets) = release_data.get("assets").and_then(|a: &serde_json::Value| a.as_array()) {
                for asset in assets {
                    let name = asset.get("name").and_then(|n: &serde_json::Value| n.as_str()).unwrap_or("");
                    let url = asset
                        .get("browser_download_url")
                        .and_then(|u: &serde_json::Value| u.as_str())
                        .unwrap_or("");
                    if name.ends_with("macos-arm64.zip") {
                        download_urls.insert("darwin-aarch64".to_string(), serde_json::json!(url));
                    } else if name.ends_with("macos-x64.zip") {
                        download_urls.insert("darwin-x86_64".to_string(), serde_json::json!(url));
                    } else if name.ends_with("windows.zip") {
                        download_urls.insert("win32".to_string(), serde_json::json!(url));
                    } else if name.ends_with("linux.zip") {
                        download_urls.insert("linux-x86_64".to_string(), serde_json::json!(url));
                    }
                }
            }
            entry["downloadUrls"] = serde_json::Value::Object(download_urls);
        }
    }

    // Fetch plugin.json from raw GitHub
    let pinned_version = entry
        .get("pinnedVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    let raw_url = format!(
        "https://raw.githubusercontent.com/{}/{}/plugin.json",
        repo, pinned_version
    );
    if let Ok(resp) = client.get(&raw_url).send().await {
        if let Ok(text) = resp.text().await {
            if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) {
                entry["manifest"] = manifest;
            }
        }
    }

    entry["iconUrl"] = serde_json::json!(icon_url);
    let _ = repo_parts; // suppress unused warning

    Ok(entry)
}

/// Fetch blacklist and return IDs that should be force-disabled.
#[tauri::command]
pub async fn plugin_fetch_blacklist() -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Moraya/0.16.0")
        .build()
        .map_err(|_| "HTTP client 初始化失败".to_string())?;

    let resp = client
        .get(REGISTRY_BLACKLIST_URL)
        .send()
        .await
        .map_err(|_| String::new())?; // Silently fail — blacklist is best-effort

    let data = resp.json::<serde_json::Value>().await.map_err(|_| String::new())?;
    let ids = data
        .get("blacklist")
        .and_then(|b: &serde_json::Value| b.as_array())
        .map(|arr: &Vec<serde_json::Value>| {
            arr.iter()
                .filter_map(|e: &serde_json::Value| e.get("id").and_then(|id: &serde_json::Value| id.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(ids)
}
