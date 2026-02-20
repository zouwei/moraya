use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

/// Maximum line length for MCP responses (64 KB)
const MAX_LINE_LENGTH: usize = 64 * 1024;
/// Maximum iterations when reading MCP responses
const MAX_READ_ITERATIONS: usize = 1000;

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

/// A managed MCP stdio process with persistent buffered I/O handles.
struct MCPProcess {
    child: Child,
    reader: BufReader<ChildStdout>,
    stdin: ChildStdin,
    stderr: ChildStderr,
}

/// Manages stdio-based MCP server processes.
///
/// The Mutex is held only briefly for HashMap insert/remove operations.
/// Blocking I/O (read_line) is performed OUTSIDE the Mutex by temporarily
/// removing the MCPProcess from the HashMap ("take out, read, put back").
/// This eliminates deadlocks between mcp_send_request and mcp_disconnect.
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

/// Kill an entire process group by PID (Unix only).
/// npx spawns grandchild processes; killing only the direct child leaves
/// grandchildren alive, keeping pipes open and causing read_line to block.
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // SAFETY: kill(-pgid, SIGKILL) sends SIGKILL to all processes in the group.
    // The PID came from a child we spawned with process_group(0), so the PGID == PID.
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {
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
        .stderr(Stdio::piped());

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

    let reader = BufReader::new(stdout);

    // Store PID in separate mutex for deadlock-free disconnect
    if let Ok(mut pids) = state.pids.lock() {
        pids.insert(server_id.clone(), pid);
    }

    processes.insert(
        server_id,
        MCPProcess {
            child,
            reader,
            stdin,
            stderr,
        },
    );

    Ok(())
}

/// Send a JSON-RPC request to an MCP server via stdio.
///
/// Uses "take out, read, put back" pattern: the MCPProcess is removed from the
/// HashMap before blocking I/O, so the Mutex is NOT held during `read_line`.
/// This allows `mcp_disconnect` to always acquire the Mutex immediately.
#[tauri::command]
pub fn mcp_send_request(
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

        // Remove from HashMap so the Mutex can be released during blocking read
        processes
            .remove(&server_id)
            .ok_or("MCP server not connected")?
    };
    // Mutex is now released — other commands (including disconnect) can proceed

    // Step 2: Blocking read OUTSIDE the Mutex
    let result = read_response(&mut proc);

    // Step 3: Put the process back (unless disconnect already cleaned up)
    match &result {
        Ok(_) => {
            // Success — put the process back for future requests
            let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
            processes.insert(server_id, proc);
        }
        Err(_) => {
            // Error (EOF, process died, etc.) — clean up instead of putting back
            let _ = proc.child.kill();
            let _ = proc.child.wait();
            if let Ok(mut pids) = state.pids.lock() {
                pids.remove(&server_id);
            }
        }
    }

    result
}

/// Read a JSON response line from an MCP process. Called WITHOUT holding the Mutex.
fn read_response(proc: &mut MCPProcess) -> Result<String, String> {
    let mut iterations = 0;
    loop {
        iterations += 1;
        if iterations > MAX_READ_ITERATIONS {
            return Err("MCP response exceeded iteration limit".to_string());
        }

        let mut line = String::new();
        let bytes_read = proc
            .reader
            .read_line(&mut line)
            .map_err(|_| "Failed to read from MCP server".to_string())?;

        if bytes_read == 0 {
            let stderr_msg = try_read_stderr(&mut proc.stderr);
            return if stderr_msg.is_empty() {
                Err("MCP server process ended unexpectedly".to_string())
            } else {
                Err(format!("MCP server error: {}", stderr_msg))
            };
        }

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
/// Since `mcp_send_request` releases the Mutex during blocking I/O,
/// this function can always acquire the lock without deadlock.
#[tauri::command]
pub fn mcp_disconnect(
    state: State<'_, MCPProcessManager>,
    server_id: String,
) -> Result<(), String> {
    // Kill the process group first to ensure all children are dead
    if let Ok(mut pids) = state.pids.lock() {
        if let Some(pid) = pids.remove(&server_id) {
            kill_process_group(pid);
        }
    }

    // Clean up the process entry. The Mutex is never held during blocking I/O,
    // so this lock will succeed promptly.
    if let Ok(mut processes) = state.processes.lock() {
        if let Some(mut proc) = processes.remove(&server_id) {
            let _ = proc.child.kill();
            let _ = proc.child.wait();
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
