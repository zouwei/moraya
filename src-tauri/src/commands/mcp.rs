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
const READ_LINE_TIMEOUT: Duration = Duration::from_secs(60);

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

/// Truncate and sanitize stderr output for error messages.
/// Strips home directory paths for privacy but preserves overall message structure.
fn sanitize_stderr(stderr_msg: &str) -> String {
    let truncated = if stderr_msg.len() > 500 {
        &stderr_msg[..500]
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
#[tauri::command]
pub fn mcp_connect_stdio(
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
    // Step 1: Lock Mutex briefly — write request and take out the process
    let mut proc = {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

        let proc = processes
            .get_mut(&server_id)
            .ok_or("MCP server not connected")?;

        if let Err(_) = writeln!(proc.stdin, "{}", request) {
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

        // Remove from HashMap so the Mutex is released during channel read
        processes
            .remove(&server_id)
            .ok_or("MCP server not connected")?
    };
    // Mutex is now released — other commands (including disconnect) can proceed

    // Step 2: Read response on a blocking thread so we don't freeze the Tauri IPC handler.
    // MCPProcess is Send (Child, ChildStdin, etc. are Send), so it can move across threads.
    let (result, returned_proc) = tokio::task::spawn_blocking(move || {
        let result = read_response_channel(&mut proc);
        (result, proc)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    // Step 3: Put the process back or clean up
    match &result {
        Ok(_) => {
            // Success — put the process back for future requests
            if let Ok(mut processes) = state.processes.lock() {
                processes.insert(server_id, returned_proc);
            }
        }
        Err(_) => {
            // Error (EOF, timeout, process died) — clean up
            let mut proc = returned_proc;
            let _ = proc.child.kill();
            let _ = proc.child.try_wait();
            drop(proc);
            if let Ok(mut pids) = state.pids.lock() {
                pids.remove(&server_id);
            }
        }
    }

    result
}

/// Read a JSON response from the channel (fed by the background reader thread).
/// Uses recv_timeout to ensure this never blocks forever.
fn read_response_channel(proc: &mut MCPProcess) -> Result<String, String> {
    let mut iterations = 0;
    loop {
        iterations += 1;
        if iterations > MAX_READ_ITERATIONS {
            return Err("MCP response exceeded iteration limit".to_string());
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
#[tauri::command]
pub fn mcp_disconnect(
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
#[tauri::command]
pub fn check_command_exists(command: String) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let _ = &command;
        return Err("Command execution is not available on iPad".to_string());
    }

    #[cfg(not(target_os = "ios"))]
    {
        validate_command(&command)?;

        let output = Command::new(&command)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|_| format!("Command '{}' not found", command))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if !stdout.is_empty() {
            stdout
        } else {
            String::from_utf8_lossy(&output.stderr).trim().to_string()
        })
    }
}
