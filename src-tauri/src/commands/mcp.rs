use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

/// Manages stdio-based MCP server processes
pub struct MCPProcessManager {
    processes: Mutex<HashMap<String, Child>>,
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
    if let Some(mut child) = processes.remove(&server_id) {
        let _ = child.kill();
    }

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in &env {
        cmd.env(key, value);
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to start MCP server: {}", e))?;
    processes.insert(server_id, child);

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

    let child = processes
        .get_mut(&server_id)
        .ok_or_else(|| format!("MCP server not found: {}", server_id))?;

    // Write request to stdin
    let stdin = child
        .stdin
        .as_mut()
        .ok_or("Failed to access MCP server stdin")?;

    writeln!(stdin, "{}", request).map_err(|e| format!("Failed to write to MCP server: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush MCP server stdin: {}", e))?;

    // Read response from stdout
    let stdout = child
        .stdout
        .as_mut()
        .ok_or("Failed to access MCP server stdout")?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("Failed to read from MCP server: {}", e))?;

    Ok(line.trim().to_string())
}

/// Disconnect from an MCP server
#[tauri::command]
pub fn mcp_disconnect(
    state: State<'_, MCPProcessManager>,
    server_id: String,
) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = processes.remove(&server_id) {
        let _ = child.kill();
    }

    Ok(())
}
