use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

/// Sanitize IO errors to avoid leaking file system paths or OS error details.
fn sanitize_io_error(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "File not found".to_string(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
        std::io::ErrorKind::AlreadyExists => "File already exists".to_string(),
        _ => "Operation failed".to_string(),
    }
}

/// Strip the `\\?\` extended-length path prefix that Windows' `canonicalize` adds.
/// On non-Windows platforms this is a no-op.
fn strip_unc_prefix(p: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    p
}

/// Validate that a path is safe to access:
/// 1. Canonicalize the path (resolve `..` and symlinks)
/// 2. Ensure the resolved path is within the user's home directory
fn validate_path(path: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .or_else(|_| {
            // File may not exist yet (write scenario) — validate parent directory
            let parent = Path::new(path)
                .parent()
                .ok_or_else(|| "Invalid path".to_string())?;
            let canonical_parent =
                std::fs::canonicalize(parent).map_err(|_| "Invalid path".to_string())?;
            Ok(canonical_parent.join(Path::new(path).file_name().unwrap_or_default()))
        })
        .map_err(|e: String| e)?;

    // On Windows, canonicalize returns \\?\C:\... but home_dir returns C:\...
    let canonical = strip_unc_prefix(canonical);

    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;

    if !canonical.starts_with(&home) {
        return Err("Access denied: path outside allowed directory".to_string());
    }

    Ok(canonical)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let safe_path = validate_path(&path)?;
    fs::read_to_string(&safe_path).map_err(sanitize_io_error)
}

/// Return the embedded privacy policy content.
/// The file is included at compile time so no runtime path resolution is needed.
#[tauri::command]
pub fn read_resource_file(name: String) -> Result<String, String> {
    match name.as_str() {
        "privacy-policy.md" => Ok(include_str!("../../resources/privacy-policy.md").to_string()),
        _ => Err("Unknown resource".to_string()),
    }
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let safe_path = validate_path(&path)?;
    if let Some(parent) = safe_path.parent() {
        fs::create_dir_all(parent).map_err(sanitize_io_error)?;
    }
    fs::write(&safe_path, content).map_err(sanitize_io_error)
}

/// Write binary data (base64-encoded) to a file.
/// Used for exporting PDF, PNG, and other binary formats.
#[tauri::command]
pub fn write_file_binary(path: String, base64_data: String) -> Result<(), String> {
    use std::io::Write;

    let safe_path = validate_path(&path)?;
    if let Some(parent) = safe_path.parent() {
        fs::create_dir_all(parent).map_err(sanitize_io_error)?;
    }

    // Strip optional data URL prefix (e.g. "data:image/png;base64,")
    let raw = if let Some(pos) = base64_data.find(",") {
        &base64_data[pos + 1..]
    } else {
        &base64_data
    };

    let bytes = base64_decode(raw).map_err(|_| "Failed to decode data".to_string())?;

    let mut file = fs::File::create(&safe_path).map_err(sanitize_io_error)?;
    file.write_all(&bytes).map_err(sanitize_io_error)
}

/// Simple base64 decoder (no external dependency needed).
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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
            .ok_or_else(|| "Invalid data".to_string())?
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

/// Maximum directory recursion depth
const MAX_DIR_DEPTH: u32 = 10;

#[tauri::command]
pub fn read_dir_recursive(path: String, depth: Option<u32>) -> Result<Vec<FileEntry>, String> {
    let safe_path = validate_path(&path)?;
    let max_depth = depth.unwrap_or(3).min(MAX_DIR_DEPTH);
    read_dir_inner(safe_path.to_str().unwrap_or(""), 0, max_depth)
}

fn read_dir_inner(
    path: &str,
    current_depth: u32,
    max_depth: u32,
) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(path).map_err(sanitize_io_error)?;

    let mut result: Vec<FileEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(sanitize_io_error)?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and common ignored directories
        if file_name.starts_with('.') || file_name == "node_modules" || file_name == "target" {
            continue;
        }

        let file_path = entry.path();

        // Skip symlinks to prevent following links outside allowed directories
        if file_path
            .symlink_metadata()
            .map(|m| m.is_symlink())
            .unwrap_or(false)
        {
            continue;
        }

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
