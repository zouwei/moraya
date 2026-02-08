use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

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

/// Connect to an MCP server via stdio transport
#[tauri::command]
pub fn mcp_connect_stdio(
    state: State<'_, MCPProcessManager>,
    server_id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    // Kill existing process if any
    if let Some(mut proc) = processes.remove(&server_id) {
        let _ = proc.child.kill();
    }

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in &env {
        cmd.env(key, value);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start MCP server: {}", e))?;

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

    processes.insert(server_id, MCPProcess { child, reader, stdin, stderr });

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
        .ok_or_else(|| format!("MCP server not found: {}", server_id))?;

    // Write request to stdin
    writeln!(proc.stdin, "{}", request)
        .map_err(|e| format!("Failed to write to MCP server: {}", e))?;
    proc.stdin
        .flush()
        .map_err(|e| format!("Failed to flush MCP server stdin: {}", e))?;

    // Read response from stdout, skipping empty lines
    loop {
        let mut line = String::new();
        let bytes_read = proc
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read from MCP server: {}", e))?;

        if bytes_read == 0 {
            // Process exited — try to capture stderr for diagnostics
            let mut stderr_buf = vec![0u8; 4096];
            let stderr_msg = match proc.stderr.read(&mut stderr_buf) {
                Ok(n) if n > 0 => {
                    String::from_utf8_lossy(&stderr_buf[..n]).trim().to_string()
                }
                _ => String::new(),
            };
            return if stderr_msg.is_empty() {
                Err("MCP server process ended unexpectedly (EOF)".to_string())
            } else {
                Err(format!("MCP server crashed: {}", stderr_msg))
            };
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Only return lines that look like JSON (start with '{')
        if trimmed.starts_with('{') {
            return Ok(trimmed.to_string());
        }
        // Skip non-JSON output (e.g. npx download messages)
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
        .ok_or_else(|| format!("MCP server not found: {}", server_id))?;

    writeln!(proc.stdin, "{}", notification)
        .map_err(|e| format!("Failed to write to MCP server: {}", e))?;
    proc.stdin
        .flush()
        .map_err(|e| format!("Failed to flush MCP server stdin: {}", e))?;

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
    }

    Ok(())
}
