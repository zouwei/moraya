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
