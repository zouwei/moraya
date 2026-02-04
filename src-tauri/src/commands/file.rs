use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    // Ensure parent directory exists
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Write binary data (base64-encoded) to a file.
/// Used for exporting PDF, PNG, and other binary formats.
#[tauri::command]
pub fn write_file_binary(path: String, base64_data: String) -> Result<(), String> {
    use std::io::Write;

    // Ensure parent directory exists
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Strip optional data URL prefix (e.g. "data:image/png;base64,")
    let raw = if let Some(pos) = base64_data.find(",") {
        &base64_data[pos + 1..]
    } else {
        &base64_data
    };

    // Decode base64
    let bytes = base64_decode(raw).map_err(|e| format!("Failed to decode base64: {}", e))?;

    let mut file =
        fs::File::create(&path).map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write file: {}", e))
}

/// Simple base64 decoder (no external dependency needed).
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let input = input.as_bytes();
    let mut buf: Vec<u8> = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;

    for &b in input {
        if b == b'\n' || b == b'\r' || b == b' ' {
            continue;
        }
        if b == b'=' {
            break;
        }
        let val = TABLE
            .iter()
            .position(|&c| c == b)
            .ok_or_else(|| format!("Invalid base64 character: {}", b as char))?
            as u32;
        acc = (acc << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }

    Ok(buf)
}

#[tauri::command]
pub fn read_dir_recursive(path: String, depth: Option<u32>) -> Result<Vec<FileEntry>, String> {
    let max_depth = depth.unwrap_or(3);
    read_dir_inner(&path, 0, max_depth)
}

fn read_dir_inner(path: &str, current_depth: u32, max_depth: u32) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut result: Vec<FileEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and common ignored directories
        if file_name.starts_with('.') || file_name == "node_modules" || file_name == "target" {
            continue;
        }

        let file_path = entry.path();
        let is_dir = file_path.is_dir();

        let children = if is_dir && current_depth < max_depth {
            Some(read_dir_inner(
                file_path.to_str().unwrap_or(""),
                current_depth + 1,
                max_depth,
            )?)
        } else if is_dir {
            Some(Vec::new())
        } else {
            None
        };

        // Only show markdown files and directories
        if is_dir || file_name.ends_with(".md") || file_name.ends_with(".markdown") {
            result.push(FileEntry {
                name: file_name,
                path: file_path.to_string_lossy().to_string(),
                is_dir,
                children,
            });
        }
    }

    // Sort: directories first, then files, both alphabetically
    result.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(result)
}
