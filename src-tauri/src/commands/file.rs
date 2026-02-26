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
/// 1. Canonicalize the path (resolve `..` and symlinks) — prevents path traversal attacks
/// 2. Ensure the resolved path is within an allowed root:
///    - User's home directory (all platforms)
///    - /Volumes/* on macOS (external drives, e.g. USB / HDD mounted by the OS)
///    - /media/* or /mnt/* on Linux (external drive mount points)
///    - Any drive letter other than C:\ on Windows is permitted (non-system volumes)
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

    // Always allow paths within the user's home directory
    if canonical.starts_with(&home) {
        return Ok(canonical);
    }

    // macOS: allow external drives mounted under /Volumes/
    // (e.g. /Volumes/MyUSB/notes.md — user selected via native file dialog)
    #[cfg(target_os = "macos")]
    if canonical.starts_with("/Volumes/") {
        return Ok(canonical);
    }

    // Linux: allow external drives mounted under /media/ or /mnt/
    #[cfg(target_os = "linux")]
    if canonical.starts_with("/media/") || canonical.starts_with("/mnt/") {
        return Ok(canonical);
    }

    // Windows: allow non-system drive letters (D:\, E:\, F:\, ...)
    // C:\ is the system drive; other letters are typically data / external drives.
    #[cfg(target_os = "windows")]
    {
        let s = canonical.to_string_lossy();
        if s.len() >= 3 {
            let drive = s.chars().next().unwrap_or('C').to_ascii_uppercase();
            if drive != 'C' && s.chars().nth(1) == Some(':') {
                return Ok(canonical);
            }
        }
    }

    Err("Access denied: path outside allowed directory".to_string())
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

/// Create a new empty Markdown file in the given directory.
/// Automatically appends `.md` if not already present.
#[tauri::command]
pub fn create_markdown_file(dir_path: String, file_name: String) -> Result<String, String> {
    let safe_dir = validate_path(&dir_path)?;
    if !safe_dir.is_dir() {
        return Err("Not a directory".to_string());
    }

    let name = if file_name.ends_with(".md") || file_name.ends_with(".markdown") {
        file_name
    } else {
        format!("{}.md", file_name)
    };

    let file_path = safe_dir.join(&name);
    // Validate the resulting path is also safe
    let safe_file = validate_path(file_path.to_str().unwrap_or(""))?;

    if safe_file.exists() {
        return Err("File already exists".to_string());
    }

    fs::write(&safe_file, "").map_err(sanitize_io_error)?;
    Ok(safe_file.to_string_lossy().to_string())
}

/// Rename a file or directory.
#[tauri::command]
pub fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let safe_old = validate_path(&old_path)?;
    let safe_new = validate_path(&new_path)?;

    if !safe_old.exists() {
        return Err("File not found".to_string());
    }
    if safe_new.exists() {
        return Err("File already exists".to_string());
    }

    fs::rename(&safe_old, &safe_new).map_err(sanitize_io_error)
}

/// Delete a file or directory (recursive for directories).
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let safe_path = validate_path(&path)?;

    if !safe_path.exists() {
        return Err("File not found".to_string());
    }

    if safe_path.is_dir() {
        fs::remove_dir_all(&safe_path).map_err(sanitize_io_error)
    } else {
        fs::remove_file(&safe_path).map_err(sanitize_io_error)
    }
}

#[derive(Serialize)]
pub struct FilePreview {
    pub path: String,
    pub name: String,
    pub preview: String,
    pub modified: f64, // seconds since UNIX epoch
}

/// Batch-read file previews: first line of content (stripped of Markdown markers) + modification time.
#[tauri::command]
pub fn read_file_previews(
    paths: Vec<String>,
    max_chars: Option<usize>,
) -> Result<Vec<FilePreview>, String> {
    let limit = max_chars.unwrap_or(100);
    let mut previews = Vec::with_capacity(paths.len());

    for p in paths {
        let safe_path = match validate_path(&p) {
            Ok(sp) => sp,
            Err(_) => continue,
        };
        if !safe_path.is_file() {
            continue;
        }

        let name = safe_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let modified = safe_path
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64()
            })
            .unwrap_or(0.0);

        // Read preview: extract title from frontmatter, or first content line
        let preview = match fs::read_to_string(&safe_path) {
            Ok(content) => {
                // Strip BOM if present
                let content = content.strip_prefix('\u{FEFF}').unwrap_or(&content);
                let mut result = String::new();

                // Strategy: scan first 30 lines for a title: field
                let mut found_title = false;
                let mut first_content = String::new();
                let mut in_frontmatter = false;

                for (i, line) in content.lines().enumerate() {
                    if i >= 30 { break; }
                    let trimmed = line.trim();

                    // Detect frontmatter boundaries
                    if i == 0 && trimmed.starts_with("---") {
                        in_frontmatter = true;
                        continue;
                    }
                    if in_frontmatter && trimmed.starts_with("---") {
                        in_frontmatter = false;
                        continue;
                    }

                    // Look for title: in frontmatter
                    if in_frontmatter && !found_title {
                        if let Some(val) = trimmed.strip_prefix("title:") {
                            let val = val.trim().trim_matches('"').trim_matches('\'');
                            if !val.is_empty() {
                                found_title = true;
                                result = val.to_string();
                            }
                        }
                        continue;
                    }

                    // After frontmatter or no frontmatter: grab first non-empty content line
                    if !in_frontmatter && first_content.is_empty() && !trimmed.is_empty() {
                        first_content = trimmed
                            .trim_start_matches('#')
                            .trim_start_matches('>')
                            .trim_start_matches('-')
                            .trim_start_matches('*')
                            .trim()
                            .to_string();
                    }

                    // If we have both, stop early
                    if found_title && !first_content.is_empty() { break; }
                }

                // Prefer frontmatter title, fall back to first content line
                if result.is_empty() {
                    result = first_content;
                }

                if result.chars().count() > limit {
                    let truncated: String = result.chars().take(limit).collect();
                    format!("{}...", truncated)
                } else {
                    result
                }
            }
            Err(_) => String::new(),
        };

        previews.push(FilePreview {
            path: safe_path.to_string_lossy().to_string(),
            name,
            preview,
            modified,
        });
    }

    Ok(previews)
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

    // Sort: directories first, then files, both alphabetically descending
    result.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            b.name.to_lowercase().cmp(&a.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(result)
}

/// Recursively copy directory contents from `src` into `dst`, skipping symlinks.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(sanitize_io_error)?;
    let entries = fs::read_dir(src).map_err(sanitize_io_error)?;
    for entry in entries {
        let entry = entry.map_err(sanitize_io_error)?;
        let meta = entry.metadata().map_err(sanitize_io_error)?;
        if meta.is_symlink() {
            continue; // skip symlinks per security policy
        }
        let dst_path = dst.join(entry.file_name());
        if meta.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            fs::copy(entry.path(), &dst_path).map_err(sanitize_io_error)?;
        }
    }
    Ok(())
}

/// Migrate voice profile sample files from one directory to another.
/// Called when the user changes the Voice Profile Sync Directory in settings.
/// Both directories must reside within an allowed path (home dir or external mount).
#[tauri::command]
pub fn migrate_voice_profiles_dir(old_dir: String, new_dir: String) -> Result<(), String> {
    let old_path = validate_path(&old_dir)?;
    let new_path = validate_path(&new_dir)?;

    if !old_path.exists() {
        // Nothing to migrate; just ensure the new directory exists.
        fs::create_dir_all(&new_path).map_err(sanitize_io_error)?;
        return Ok(());
    }

    copy_dir_recursive(&old_path, &new_path)
}
