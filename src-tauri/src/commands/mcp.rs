use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

/// Maximum line length for MCP responses (64 KB)
const MAX_LINE_LENGTH: usize = 64 * 1024;
/// Maximum iterations when reading MCP responses
const MAX_READ_ITERATIONS: usize = 1000;

/// Dangerous environment variable prefixes that must not be passed to child processes
const BLOCKED_ENV_PREFIXES: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
];

/// A managed MCP stdio process with persistent buffered I/O handles.
struct MCPProcess {
    child: Child,
    reader: BufReader<ChildStdout>,
    stdin: ChildStdin,
    stderr: ChildStderr,
}

/// Manages stdio-based MCP server processes
pub struct MCPProcessManager {
    processes: Mutex<HashMap<String, MCPProcess>>,
}

impl MCPProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
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

/// Truncate and sanitize stderr output for error messages.
fn sanitize_stderr(stderr_msg: &str) -> String {
    let truncated = if stderr_msg.len() > 200 {
        &stderr_msg[..200]
    } else {
        stderr_msg
    };
    truncated
        .replace(|c: char| c == '/' || c == '\\', " ")
        .trim()
        .to_string()
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

    let mut child = cmd
        .spawn()
        .map_err(|_| "Failed to start MCP server".to_string())?;

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
    let reader = BufReader::new(stdout);

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

/// Send a JSON-RPC request to an MCP server via stdio
#[tauri::command]
pub fn mcp_send_request(
    state: State<'_, MCPProcessManager>,
    server_id: String,
    request: String,
) -> Result<String, String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    let proc = processes
        .get_mut(&server_id)
        .ok_or("MCP server not connected")?;

    writeln!(proc.stdin, "{}", request)
        .map_err(|_| "Failed to write to MCP server".to_string())?;
    proc.stdin
        .flush()
        .map_err(|_| "Failed to flush MCP server stdin".to_string())?;

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
            let mut stderr_buf = vec![0u8; 4096];
            let stderr_msg = match proc.stderr.read(&mut stderr_buf) {
                Ok(n) if n > 0 => sanitize_stderr(
                    &String::from_utf8_lossy(&stderr_buf[..n]).trim().to_string(),
                ),
                _ => String::new(),
            };
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

    writeln!(proc.stdin, "{}", notification)
        .map_err(|_| "Failed to write to MCP server".to_string())?;
    proc.stdin
        .flush()
        .map_err(|_| "Failed to flush MCP server stdin".to_string())?;

    Ok(())
}

/// Disconnect from an MCP server
#[tauri::command]
pub fn mcp_disconnect(
    state: State<'_, MCPProcessManager>,
    server_id: String,
) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    if let Some(mut proc) = processes.remove(&server_id) {
        let _ = proc.child.kill();
        let _ = proc.child.wait(); // Prevent zombie processes
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
