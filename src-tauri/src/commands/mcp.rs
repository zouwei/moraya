use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

/// Maximum line length for MCP responses (256 KB).
/// Servers like git-mcp-server register 28+ tools, producing large tools/list responses.
const MAX_LINE_LENGTH: usize = 256 * 1024;
/// Maximum iterations when reading MCP responses
const MAX_READ_ITERATIONS: usize = 1000;
/// Timeout for waiting on a single line from the MCP server
const READ_LINE_TIMEOUT: Duration = Duration::from_secs(20);
/// Total wall-clock cap per request — prevents indefinite wait when a server
/// outputs many non-JSON progress lines (each line would otherwise reset READ_LINE_TIMEOUT)
const TOTAL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(25);

/// How long a `--version` probe may run before we give up and kill it. Long
/// enough for a cold `npx` resolve, short enough that a hung binary cannot
/// stall the MCP panel.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Wait for `child`, killing it and returning `Ok(None)` once `deadline` passes.
///
/// `Child::wait_with_output` has no timeout, so a command that never exits would
/// hold the caller forever. Polling with `try_wait` keeps the bound while still
/// collecting the pipes on the normal path.
fn wait_with_deadline(
    child: &mut Child,
    deadline: Duration,
) -> Result<Option<std::process::Output>, String> {
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_end(&mut stdout);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_end(&mut stderr);
                }
                return Ok(Some(std::process::Output { status, stdout, stderr }));
            }
            Ok(None) => {
                if started.elapsed() >= deadline {
                    let _ = child.kill();
                    // Reap it, so a timed-out probe does not leave a zombie.
                    let _ = child.wait();
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err("Version check failed".to_string()),
        }
    }
}

/// Dangerous or interfering environment variable prefixes that must not be passed to child processes
const BLOCKED_ENV_PREFIXES: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    // npm/pnpm internal vars leak from parent process and cause "Unknown env config" warnings
    "npm_config_",
    "npm_lifecycle_",
    "npm_package_",
    "NPM_",
    "PNPM_",
];

/// A line read from MCP server stdout by the reader thread.
enum ReadResult {
    Line(String),
    Eof,
    Error(String),
}

/// A managed MCP stdio process.
///
/// The reader thread runs in the background, continuously reading lines from stdout
/// and sending them to `line_rx`. This ensures no Tauri command thread ever blocks
/// on pipe I/O — they only block on channel receives (with timeout).
struct MCPProcess {
    child: Child,
    stdin: ChildStdin,
    stderr: ChildStderr,
    line_rx: Receiver<ReadResult>,
}

/// Manages stdio-based MCP server processes.
///
/// The `processes` Mutex is held only briefly for HashMap operations and stdin writes.
/// Blocking reads go through a channel from a background reader thread, with timeout.
/// This eliminates deadlocks and ensures `mcp_disconnect` always completes promptly.
pub struct MCPProcessManager {
    processes: Mutex<HashMap<String, MCPProcess>>,
    pids: Mutex<HashMap<String, u32>>,
}

impl MCPProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            pids: Mutex::new(HashMap::new()),
        }
    }

    /// Whether the given server_id currently has a live stdio subprocess.
    /// Used by the LAN bridge to reject exposing non-stdio (http/sse) servers,
    /// which are not proxyable — the bridge only forwards to stdio children.
    pub fn is_running(&self, server_id: &str) -> bool {
        self.processes
            .lock()
            .map(|p| p.contains_key(server_id))
            .unwrap_or(false)
    }
}

impl Default for MCPProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Validate that a command is a simple executable name (no paths, no shell metacharacters).
fn validate_command(command: &str) -> Result<(), String> {
    if command.is_empty() {
        return Err("Command must not be empty".to_string());
    }
    for c in command.chars() {
        if !c.is_alphanumeric() && c != '-' && c != '_' && c != '.' {
            return Err("Invalid command: must be a simple executable name".to_string());
        }
    }
    Ok(())
}

/// Check if an environment variable name is safe to pass to child processes.
fn is_safe_env_var(key: &str) -> bool {
    !BLOCKED_ENV_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

/// Set a file descriptor to non-blocking mode (Unix only).
/// This prevents stderr reads from blocking indefinitely while holding the Mutex.
#[cfg(unix)]
fn set_nonblocking(stderr: &ChildStderr) {
    use std::os::unix::io::AsRawFd;
    // SAFETY: fcntl F_GETFL/F_SETFL on a valid fd is safe.
    // We only set O_NONBLOCK which is a standard flag.
    unsafe {
        let fd = stderr.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags >= 0 {
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }
}

#[cfg(not(unix))]
fn set_nonblocking(_stderr: &ChildStderr) {
    // Non-blocking stderr is not critical; reads may block on non-Unix
}

/// Gracefully terminate an entire process group: SIGTERM → wait → SIGKILL.
///
/// Sends SIGTERM first so Node.js servers can flush buffers and clean up child
/// processes (e.g. git-mcp-server spawns git commands). Falls back to SIGKILL
/// after a timeout to guarantee termination.
#[cfg(unix)]
fn graceful_kill_process_group(pid: u32) {
    let pgid = -(pid as libc::pid_t);

    // SAFETY: kill(-pgid, SIGTERM) sends SIGTERM to all processes in the group.
    // The PID came from a child we spawned with process_group(0), so PGID == PID.
    unsafe {
        libc::kill(pgid, libc::SIGTERM);
    }

    // Poll for up to 2 seconds for the leader process to exit
    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(2);
    loop {
        // SAFETY: waitpid with WNOHANG on our child's PID is safe.
        let ret = unsafe {
            let mut status: libc::c_int = 0;
            libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG)
        };
        if ret > 0 {
            return; // Process exited and was reaped
        }
        if start.elapsed() >= timeout {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    // Process did not exit in time — force kill the entire group
    // SAFETY: kill(-pgid, SIGKILL) is safe; process group is one we own.
    unsafe {
        libc::kill(pgid, libc::SIGKILL);
    }

    // Reap to prevent zombie (non-blocking — best effort)
    unsafe {
        let mut status: libc::c_int = 0;
        libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG);
    }
}

#[cfg(not(unix))]
fn graceful_kill_process_group(_pid: u32) {
    // On non-Unix, child.kill() handles this
}

/// Try to read available stderr (non-blocking). Returns sanitized message or empty string.
fn try_read_stderr(stderr: &mut ChildStderr) -> String {
    let mut buf = vec![0u8; 4096];
    match stderr.read(&mut buf) {
        Ok(n) if n > 0 => sanitize_stderr(
            &String::from_utf8_lossy(&buf[..n]).trim().to_string(),
        ),
        _ => String::new(),
    }
}

/// Max stderr bytes surfaced in an error message. Kept generous so the real
/// failure line is visible past any leading `npm warn` noise (e.g. EBADENGINE
/// warnings that precede the actual fatal error).
const MAX_STDERR_BYTES: usize = 1500;

/// Truncate and sanitize stderr output for error messages.
/// Strips home directory paths for privacy but preserves overall message structure.
fn sanitize_stderr(stderr_msg: &str) -> String {
    // Boundary-safe truncation: slicing a &str at a raw byte index PANICS when
    // the index lands mid-UTF-8-character. MCP servers emit non-ASCII stderr
    // (e.g. the Chinese 文颜/wenyan tool), so a raw `&stderr_msg[..N]` could
    // abort the entire app — the release profile is `panic = "abort"`. Walk
    // back to the nearest char boundary before slicing.
    let truncated = if stderr_msg.len() > MAX_STDERR_BYTES {
        let mut end = MAX_STDERR_BYTES;
        while end > 0 && !stderr_msg.is_char_boundary(end) {
            end -= 1;
        }
        &stderr_msg[..end]
    } else {
        stderr_msg
    };
    // Strip home directory absolute paths for privacy, keep the rest readable
    let mut result = String::with_capacity(truncated.len());
    let mut chars = truncated.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '/' {
            // Check for /Users/ or /home/ prefix — redact the full path token
            let rest: String = chars.clone().take(6).collect();
            if rest.starts_with("Users") || rest.starts_with("home/") {
                result.push_str("<path>");
                // Skip until whitespace or end
                while let Some(&nc) = chars.peek() {
                    if nc.is_whitespace() || nc == ':' || nc == '"' || nc == '\'' {
                        break;
                    }
                    chars.next();
                }
                continue;
            }
        }
        result.push(c);
    }
    result.trim().to_string()
}

/// Spawn a background thread that reads lines from stdout and sends them to a channel.
/// The thread exits when the pipe returns EOF or an error (e.g., process killed).
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

/// Connect to an MCP server via stdio transport
///
/// `async` on purpose: Tauri runs synchronous commands on the MAIN thread, and
/// spawning a server blocks on process startup plus the JSON-RPC handshake. As a
/// plain `fn` this froze the window on every launch that reconnected servers.
/// The body itself never awaits, so no lock is held across a suspension point.
#[tauri::command]
pub async fn mcp_connect_stdio(
    state: State<'_, MCPProcessManager>,
    server_id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let _ = (&state, &server_id, &command, &args, &env);
        return Err("stdio transport is not available on iPad".to_string());
    }

    #[cfg(not(target_os = "ios"))]
    validate_command(&command)?;

    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    // Kill existing process if any, and wait to prevent zombies
    if let Some(mut proc) = processes.remove(&server_id) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Use temp dir as CWD to prevent servers from writing files into src-tauri/
        // (e.g. git-mcp-server creates logs/ in CWD)
        .current_dir(std::env::temp_dir());

    // Create a new process group so we can kill the entire tree on disconnect
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // Filter environment variables: remove dangerous prefixes
    cmd.env_clear();
    for (key, value) in std::env::vars() {
        if is_safe_env_var(&key) {
            cmd.env(&key, &value);
        }
    }
    for (key, value) in &env {
        if is_safe_env_var(key) {
            cmd.env(key, value);
        }
    }

    // Prevent expired/invalid npm auth tokens in ~/.npmrc from breaking npx
    // by pointing npm's user config to a non-existent file
    cmd.env("npm_config_userconfig", "/dev/null");

    let mut child = cmd
        .spawn()
        .map_err(|_| "Failed to start MCP server".to_string())?;

    let pid = child.id();

    let stdin = child
        .stdin
        .take()
        .ok_or("Failed to capture MCP server stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture MCP server stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture MCP server stderr")?;

    // Set stderr to non-blocking so diagnostic reads never block while holding the Mutex
    set_nonblocking(&stderr);

    // Spawn a background reader thread for stdout — blocking read_line runs on this
    // dedicated thread instead of on Tauri command threads
    let line_rx = spawn_reader_thread(stdout);

    // Store PID in separate mutex for deadlock-free disconnect
    if let Ok(mut pids) = state.pids.lock() {
        pids.insert(server_id.clone(), pid);
    }

    processes.insert(
        server_id,
        MCPProcess {
            child,
            stdin,
            stderr,
            line_rx,
        },
    );

    Ok(())
}

/// Send a JSON-RPC request to an MCP server via stdio.
///
/// Uses "take out, channel read, put back" pattern:
/// 1. Lock Mutex briefly to write the request and remove the process from HashMap
/// 2. Read response from the channel (background reader thread) WITHOUT holding the Mutex
/// 3. Re-lock Mutex to put the process back (or clean up on error)
///
/// **Must be `async`** so the blocking channel read runs on a dedicated thread
/// (via `spawn_blocking`) instead of the Tauri IPC handler thread. A synchronous
/// command would freeze the entire UI — menu events, other invoke calls, abort —
/// for up to 60 seconds while waiting for the MCP server response.
#[tauri::command]
pub async fn mcp_send_request(
    state: State<'_, MCPProcessManager>,
    server_id: String,
    request: String,
) -> Result<String, String> {
    // Step 1 (fast, sync): write the request and take the process out of the map.
    let mut proc = take_proc_after_write(&state, &server_id, &request)?;

    // Step 2: Read response on a blocking thread so we don't freeze the Tauri IPC handler.
    // MCPProcess is Send (Child, ChildStdin, etc. are Send), so it can move across threads.
    let (result, returned_proc) = tokio::task::spawn_blocking(move || {
        let result = read_response_channel(&mut proc);
        (result, proc)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    // Step 3: put the process back on success, or clean up on error.
    return_or_cleanup(&state, &server_id, &result, returned_proc);
    result
}

/// Synchronous shared core of the take-out → channel-read → put-back flow.
///
/// Used by the async `mcp_send_request` command (wrapped in `spawn_blocking`)
/// AND by the LAN bridge (`mcp_lan_bridge.rs`), whose tiny_http handler already
/// runs on a dedicated blocking thread so it can call this directly. Behavior is
/// identical to the original `mcp_send_request` body.
pub fn forward_request_blocking(
    mgr: &MCPProcessManager,
    server_id: &str,
    request: &str,
) -> Result<String, String> {
    let mut proc = take_proc_after_write(mgr, server_id, request)?;
    let result = read_response_channel(&mut proc);
    return_or_cleanup(mgr, server_id, &result, proc);
    result
}

/// Step 1: lock briefly, write the JSON-RPC line to the child's stdin, flush,
/// then remove the process from the map so the Mutex isn't held during the read.
fn take_proc_after_write(
    mgr: &MCPProcessManager,
    server_id: &str,
    request: &str,
) -> Result<MCPProcess, String> {
    let mut processes = mgr.processes.lock().map_err(|e| e.to_string())?;

    let proc = processes
        .get_mut(server_id)
        .ok_or("MCP server not connected")?;

    if writeln!(proc.stdin, "{}", request).is_err() {
        let stderr_msg = try_read_stderr(&mut proc.stderr);
        return if stderr_msg.is_empty() {
            Err("Failed to write to MCP server (process may have exited)".to_string())
        } else {
            Err(format!("MCP server error: {}", stderr_msg))
        };
    }
    proc.stdin
        .flush()
        .map_err(|_| "Failed to flush MCP server stdin".to_string())?;

    processes
        .remove(server_id)
        .ok_or_else(|| "MCP server not connected".to_string())
}

/// Step 3: on success re-insert the process for reuse; on error kill + reap it
/// and drop its pid entry.
fn return_or_cleanup(
    mgr: &MCPProcessManager,
    server_id: &str,
    result: &Result<String, String>,
    returned_proc: MCPProcess,
) {
    match result {
        Ok(_) => {
            if let Ok(mut processes) = mgr.processes.lock() {
                processes.insert(server_id.to_string(), returned_proc);
            }
        }
        Err(_) => {
            let mut proc = returned_proc;
            let _ = proc.child.kill();
            let _ = proc.child.try_wait();
            drop(proc);
            if let Ok(mut pids) = mgr.pids.lock() {
                pids.remove(server_id);
            }
        }
    }
}

/// Read a JSON response from the channel (fed by the background reader thread).
/// Uses recv_timeout (per-line) and a total wall-clock cap to ensure this never blocks forever.
fn read_response_channel(proc: &mut MCPProcess) -> Result<String, String> {
    let start = std::time::Instant::now();
    let mut iterations = 0;
    loop {
        iterations += 1;
        if iterations > MAX_READ_ITERATIONS {
            return Err("MCP response exceeded iteration limit".to_string());
        }

        // Total wall-clock cap: prevents indefinite wait when the server outputs many
        // non-JSON lines (e.g. progress logs), each of which would otherwise reset READ_LINE_TIMEOUT
        if start.elapsed() > TOTAL_RESPONSE_TIMEOUT {
            return Err("MCP response timeout".to_string());
        }

        match proc.line_rx.recv_timeout(READ_LINE_TIMEOUT) {
            Ok(ReadResult::Line(line)) => {
                if line.len() > MAX_LINE_LENGTH {
                    return Err("MCP response line exceeded size limit".to_string());
                }

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if trimmed.starts_with('{') {
                    return Ok(trimmed.to_string());
                }
            }
            Ok(ReadResult::Eof) => {
                let stderr_msg = try_read_stderr(&mut proc.stderr);
                return if stderr_msg.is_empty() {
                    Err("MCP server process ended unexpectedly".to_string())
                } else {
                    Err(format!("MCP server error: {}", stderr_msg))
                };
            }
            Ok(ReadResult::Error(e)) => {
                return Err(format!("Failed to read from MCP server: {}", e));
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err("MCP response timeout".to_string());
            }
            Err(RecvTimeoutError::Disconnected) => {
                let stderr_msg = try_read_stderr(&mut proc.stderr);
                return if stderr_msg.is_empty() {
                    Err("MCP server process ended unexpectedly".to_string())
                } else {
                    Err(format!("MCP server error: {}", stderr_msg))
                };
            }
        }
    }
}

/// Send a JSON-RPC notification (no response expected) to an MCP server via stdio
#[tauri::command]
pub fn mcp_send_notification(
    state: State<'_, MCPProcessManager>,
    server_id: String,
    notification: String,
) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    let proc = processes
        .get_mut(&server_id)
        .ok_or("MCP server not connected")?;

    if let Err(_) = writeln!(proc.stdin, "{}", notification) {
        let stderr_msg = try_read_stderr(&mut proc.stderr);
        return if stderr_msg.is_empty() {
            Err("Failed to write to MCP server (process may have exited)".to_string())
        } else {
            Err(format!("MCP server error: {}", stderr_msg))
        };
    }
    proc.stdin
        .flush()
        .map_err(|_| "Failed to flush MCP server stdin".to_string())?;

    Ok(())
}

/// Disconnect from an MCP server.
///
/// Uses graceful shutdown (SIGTERM → wait → SIGKILL) via the process group,
/// then cleans up the MCPProcess entry. Dropping MCPProcess closes the channel
/// receiver, which causes the reader thread to exit on its next send attempt.
/// `async` for the same reason as `mcp_connect_stdio`: graceful shutdown is
/// SIGTERM → wait → SIGKILL, and that wait must not happen on the main thread.
#[tauri::command]
pub async fn mcp_disconnect(
    state: State<'_, MCPProcessManager>,
    server_id: String,
) -> Result<(), String> {
    // Gracefully terminate the process group (SIGTERM → wait → SIGKILL)
    if let Ok(mut pids) = state.pids.lock() {
        if let Some(pid) = pids.remove(&server_id) {
            graceful_kill_process_group(pid);
        }
    }

    // Clean up the process entry. The Mutex is never held during blocking I/O,
    // so this lock will succeed promptly.
    if let Ok(mut processes) = state.processes.lock() {
        if let Some(proc) = processes.remove(&server_id) {
            // Process was already killed above; just drop to close pipes & channel
            drop(proc);
        }
    }

    Ok(())
}

/// Check if an external command exists and return its --version output
///
/// `async` + bounded. This runs for every configured stdio server at startup,
/// and `--version` is not always fast or even terminating — `npx` may resolve or
/// download a package first. On the main thread with no deadline that is a hung
/// window, which is what "freezes every launch" was.
#[tauri::command]
pub async fn check_command_exists(command: String) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let _ = &command;
        return Err("Command execution is not available on iPad".to_string());
    }

    #[cfg(not(target_os = "ios"))]
    {
        validate_command(&command)?;

        tauri::async_runtime::spawn_blocking(move || {
            let mut child = Command::new(&command)
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|_| format!("Command '{}' not found", command))?;

            let output = match wait_with_deadline(&mut child, VERSION_PROBE_TIMEOUT)? {
                Some(o) => o,
                None => return Err(format!("Command '{}' timed out", command)),
            };

            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(if !stdout.is_empty() {
                stdout
            } else {
                String::from_utf8_lossy(&output.stderr).trim().to_string()
            })
        })
        .await
        .map_err(|_| "Version check failed".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_with_deadline_collects_output_from_a_fast_command() {
        let mut child = Command::new("echo")
            .arg("v1.2.3")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn echo");
        let out = wait_with_deadline(&mut child, Duration::from_secs(5))
            .expect("no error")
            .expect("should not time out");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "v1.2.3");
    }

    #[test]
    fn wait_with_deadline_kills_a_command_that_never_exits() {
        // Before the deadline existed this ran on the main thread with no bound,
        // which is what froze the window while probing MCP commands at startup.
        let mut child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sleep");
        let started = std::time::Instant::now();
        let out = wait_with_deadline(&mut child, Duration::from_millis(300)).expect("no error");
        assert!(out.is_none(), "should report a timeout");
        assert!(started.elapsed() < Duration::from_secs(5), "must not wait for the child");
        // Killed AND reaped — no zombie left behind.
        assert!(child.try_wait().is_ok());
    }

    #[test]
    fn sanitize_stderr_does_not_panic_on_multibyte_at_boundary() {
        // A long non-ASCII stderr whose byte length exceeds the cap and whose
        // cap index lands mid-character. Before the fix, `&s[..1500]` panicked
        // here → with panic=abort the whole app aborted ("restart").
        let s = "文".repeat(1000); // 3 bytes each = 3000 bytes; byte 1500 is mid-char
        let out = sanitize_stderr(&s);
        // Must return a valid (boundary-safe) truncation, not panic.
        assert!(out.len() <= MAX_STDERR_BYTES);
        assert!(!out.is_empty());
    }

    #[test]
    fn sanitize_stderr_preserves_short_ascii() {
        let s = "npm warn EBADENGINE Unsupported engine";
        assert_eq!(sanitize_stderr(s), s);
    }

    #[test]
    fn sanitize_stderr_redacts_home_paths() {
        let s = "error at /Users/alice/project/index.js line 3";
        let out = sanitize_stderr(s);
        assert!(!out.contains("/Users/alice"));
        assert!(out.contains("<path>"));
    }

    #[test]
    fn sanitize_stderr_truncates_long_ascii_to_cap() {
        let s = "x".repeat(5000);
        let out = sanitize_stderr(&s);
        assert!(out.len() <= MAX_STDERR_BYTES);
    }
}
