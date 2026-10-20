/**
 * Picora Knowledge Base sync commands.
 *
 * All HTTP calls go through reqwest in this module so the frontend CSP
 * `connect-src` remains locked to IPC only. Credentials are passed as
 * (apiBase, apiKey) from the frontend — they are retrieved by the frontend
 * from the imageHostTargets store (same pattern as image_hosting_picora.rs).
 *
 * Security:
 *  - validate_relative_path() enforces path safety on all caller-supplied
 *    relative_path values before any file I/O.
 *  - Error messages are sanitized (no Bearer tokens, no absolute paths).
 */

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::command;

use super::util::current_epoch_ms;
// Picora HTTP + KB types come from the shared crate now (the http_client /
// build_error / api_url helpers this file used to carry live there). The local
// `validate_relative_path` + fs-scan/trash commands below are Moraya-desktop
// specific and stay here.
use picora_sdk::{Kb, ManifestEntry, PicoraClient, SyncOp};

const MAX_RELATIVE_PATH_LEN: usize = 1024;

// ── Types ──────────────────────────────────────────────────────────────
// KB/sync types (PicoraKb→Kb, ManifestEntry, SyncOp, ConflictEntry,
// SyncBatchResult) now come from the `picora-sdk` crate. Only the local
// filesystem-scan type is defined here.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileScanEntry {
    pub path: String,
    pub relative_path: String,
    pub size: u64,
    pub mtime: u64,
    pub sha256: String,
}

// ── Path validation ────────────────────────────────────────────────────

/// Validate that a caller-supplied relative path is safe:
///   - not empty
///   - does not contain `..` segments
///   - does not start with `/`
///   - no backslashes (must be POSIX-style)
///   - length ≤ 1024
pub fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Relative path must not be empty".to_string());
    }
    if path.len() > MAX_RELATIVE_PATH_LEN {
        return Err(format!(
            "Relative path exceeds maximum length of {}",
            MAX_RELATIVE_PATH_LEN
        ));
    }
    if path.starts_with('/') {
        return Err("Relative path must not start with '/'".to_string());
    }
    if path.contains('\\') {
        return Err("Relative path must use forward slashes only".to_string());
    }
    for segment in path.split('/') {
        if segment == ".." {
            return Err("Relative path must not contain '..' segments".to_string());
        }
    }
    Ok(())
}

// ── Commands ──────────────────────────────────────────────────────────
//
// The Picora KB commands below are thin wrappers over `picora-sdk`
// (`PicoraClient`), which owns the HTTP client, error sanitization (including
// the plan-limit-403→quota reclassification), URL joining, and path/nanoid
// validation that used to be duplicated here. `.map_err(|e| e.to_string())`
// yields the same user-facing strings the frontend already renders.

/// Build a client from the frontend-supplied credentials.
fn kb_client(api_base: &str, api_key: &str) -> Result<PicoraClient, String> {
    PicoraClient::new(api_base, api_key).map_err(|e| e.to_string())
}

/// List all Knowledge Bases for the authenticated user.
#[command]
pub async fn picora_kb_list(api_base: String, api_key: String) -> Result<Vec<Kb>, String> {
    kb_client(&api_base, &api_key)?.kb_list().await.map_err(|e| e.to_string())
}

/// Create a new Knowledge Base on Picora.
#[command]
pub async fn picora_kb_create(
    api_base: String,
    api_key: String,
    name: String,
    slug: Option<String>,
) -> Result<Kb, String> {
    if name.trim().is_empty() {
        return Err("KB name must not be empty".to_string());
    }
    let slug = slug.as_deref().map(str::trim).filter(|s| !s.is_empty());
    kb_client(&api_base, &api_key)?
        .kb_create(name.trim(), slug)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch the full manifest for a KB (all active docs with hashes).
#[command]
pub async fn picora_kb_manifest(
    api_base: String,
    api_key: String,
    kb_id: String,
) -> Result<Vec<ManifestEntry>, String> {
    kb_client(&api_base, &api_key)?.kb_manifest(&kb_id).await.map_err(|e| e.to_string())
}

/// Batch sync operations (upsert + delete) against a KB.
///
/// Returns the server's `data` object verbatim — `applied` / `conflicts` /
/// `skipped`, each a list of objects carrying the server-side `updatedAt` /
/// `sourceHash` snapshot. Deliberately NOT the SDK's typed `kb_sync_batch`:
/// its `SyncBatchResult` (picora-sdk rust-v0.1.0) models `applied` as
/// `Vec<String>` and conflicts in a legacy shape, so both deserialize to empty
/// and the frontend never learned which uploads landed — its last-synced
/// manifest went stale and the next incremental edit was misreported as a
/// conflict.
#[command]
pub async fn picora_kb_sync_batch(
    api_base: String,
    api_key: String,
    kb_id: String,
    ops: Vec<SyncOp>,
) -> Result<serde_json::Value, String> {
    for op in &ops {
        picora_sdk::validate_relative_path(&op.relative_path).map_err(|e| e.to_string())?;
    }
    let client = kb_client(&api_base, &api_key)?;
    let body = serde_json::json!({ "ops": ops });
    let req = client.post(&format!("/v1/kbs/{kb_id}/sync")).json(&body);
    let v: serde_json::Value = client
        .http()
        .send_json(req, "sync-batch")
        .await
        .map_err(|e| e.to_string())?;
    Ok(picora_sdk::http::unwrap_data(&v).clone())
}

/// Fetch raw content of a single doc by relativePath.
#[command]
pub async fn picora_kb_raw(
    api_base: String,
    api_key: String,
    kb_id: String,
    relative_path: String,
) -> Result<String, String> {
    kb_client(&api_base, &api_key)?
        .kb_raw(&kb_id, &relative_path)
        .await
        .map_err(|e| e.to_string())
}

/// Scan a local KB directory, returning file stat + SHA-256 hash for each file.
/// This is the Rust-side counterpart to buildLocalManifest() on the frontend.
#[command]
pub async fn kb_sync_scan_dir(
    root_path: String,
    scope: String,
    exclude_patterns: Vec<String>,
) -> Result<Vec<FileScanEntry>, String> {
    use sha2::{Digest, Sha256};
    use std::fs;

    let root = Path::new(&root_path);
    if !root.is_dir() {
        return Err("KB root directory not found".to_string());
    }

    let mut results = Vec::new();
    scan_dir_recursive(root, root, &scope, &exclude_patterns, &mut results)
        .map_err(|_| "Failed to scan KB directory".to_string())?;

    // Compute SHA-256 for each file
    let mut entries = Vec::with_capacity(results.len());
    for (abs_path, rel_path, meta) in results {
        let data = match fs::read(&abs_path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let hash = format!("{:x}", Sha256::digest(&data));
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        entries.push(FileScanEntry {
            path: abs_path.to_string_lossy().into_owned(),
            relative_path: rel_path,
            size: meta.len(),
            mtime,
            sha256: hash,
        });
    }

    Ok(entries)
}

fn scan_dir_recursive(
    root: &Path,
    current: &Path,
    scope: &str,
    excludes: &[String],
    results: &mut Vec<(PathBuf, String, std::fs::Metadata)>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let meta = entry.metadata()?;

        // Skip symlinks
        if meta.is_symlink() {
            continue;
        }

        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        // Apply exclude patterns (simple prefix/suffix matching)
        if matches_any_exclude(&rel, excludes) {
            continue;
        }

        // Skip hidden directories unless scope allows it
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();

        if meta.is_dir() {
            let is_hidden = file_name.starts_with('.');
            if is_hidden && scope != "all-including-hidden" {
                continue;
            }
            scan_dir_recursive(root, &path, scope, excludes, results)?;
        } else if meta.is_file() {
            if should_include_file(&rel, &file_name, scope) {
                results.push((path, rel, meta));
            }
        }
    }
    Ok(())
}

fn should_include_file(rel: &str, file_name: &str, scope: &str) -> bool {
    let lower = file_name.to_lowercase();
    let is_md = lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx");
    let is_rule = file_name == "MORAYA.md" || file_name == "CLAUDE.md";

    match scope {
        "markdown-only" => is_md,
        "markdown-plus-rules" => is_md || is_rule,
        "all-including-hidden" => {
            // Skip known binary extensions
            !is_known_binary(rel)
        }
        _ => is_md,
    }
}

fn is_known_binary(rel: &str) -> bool {
    let binary_exts = [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
        ".mp3", ".mp4", ".wav", ".ogg", ".flac",
        ".pdf", ".zip", ".tar", ".gz", ".7z",
        ".exe", ".dll", ".so", ".dylib",
        ".woff", ".woff2", ".ttf", ".otf",
    ];
    let lower = rel.to_lowercase();
    binary_exts.iter().any(|ext| lower.ends_with(ext))
}

fn matches_any_exclude(rel: &str, excludes: &[String]) -> bool {
    for pattern in excludes {
        // Simple glob: "**" means any depth, "*" means no slash
        if glob_match(pattern, rel) {
            return true;
        }
    }
    false
}

fn glob_match(pattern: &str, path: &str) -> bool {
    if pattern.ends_with("/**") {
        let prefix = &pattern[..pattern.len() - 3];
        return path.starts_with(prefix) || path == prefix;
    }
    if pattern.starts_with("**/") {
        let suffix = &pattern[3..];
        return path.ends_with(suffix) || path == suffix;
    }
    if pattern.contains('*') {
        // Simple wildcard: split on * and check starts_with/ends_with
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 2 {
            return path.starts_with(parts[0]) && path.ends_with(parts[1]);
        }
    }
    // Exact match or filename match
    path == pattern || path.ends_with(&format!("/{}", pattern))
}

/// Move a file to the trash directory (creates parent dirs as needed).
#[command]
pub async fn kb_sync_move_to_trash(
    src_path: String,
    dest_path: String,
) -> Result<(), String> {
    let src = Path::new(&src_path);
    if !src.exists() {
        return Ok(()); // Already gone
    }

    let dest = Path::new(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "Failed to create trash directory".to_string())?;
    }

    std::fs::rename(src, dest)
        .or_else(|_| {
            // Fallback: cross-device copy + delete
            std::fs::copy(src, dest).map(|_| ())?;
            std::fs::remove_file(src)
        })
        .map_err(|_| "Failed to move file to trash".to_string())
}

// ── Trash UX (v0.68.0) ─────────────────────────────────────────────────
//
// Trash layout: ~/.moraya/trash/{localKbId}/{ts}/{relativePath}
//   - localKbId : Moraya-side KB id (matches files-store)
//   - ts        : RFC3339-like timestamp at deletion (filename-safe)
//   - relativePath : original path within the KB
//
// Security:
//   - All ops resolved to canonical paths and verified to stay inside
//     ~/.moraya/trash/ (path traversal protection).
//   - Restore target is validated against the caller-supplied kb_root and
//     must be a canonical descendant; the relative_path is re-validated.
//   - No symlinks followed when walking trash (skipped silently).

const TRASH_DIR_NAME: &str = "trash";
const MORAYA_DIR_NAME: &str = ".moraya";
const DEFAULT_LIST_LIMIT: usize = 200;
const DEFAULT_PURGE_DAYS: u32 = 7;

#[derive(Debug, Serialize)]
pub struct TrashEntry {
    #[serde(rename = "kbId")]
    pub kb_id: String,
    /// Filename-safe timestamp segment as written by the frontend at delete time
    #[serde(rename = "deletedAt")]
    pub deleted_at: String,
    /// Unix epoch ms parsed from deleted_at if possible; 0 otherwise
    #[serde(rename = "deletedAtMs")]
    pub deleted_at_ms: u64,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "absoluteTrashPath")]
    pub absolute_trash_path: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RestoreResult {
    Restored {
        #[serde(rename = "targetPath")]
        target_path: String,
    },
    ConflictExists {
        #[serde(rename = "existingSize")]
        existing_size: u64,
    },
}

#[derive(Debug, Serialize, Default)]
pub struct PurgeReport {
    #[serde(rename = "purgedFiles")]
    pub purged_files: usize,
    #[serde(rename = "purgedDirs")]
    pub purged_dirs: usize,
    #[serde(rename = "freedBytes")]
    pub freed_bytes: u64,
}

fn trash_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not available".to_string())?;
    Ok(home.join(MORAYA_DIR_NAME).join(TRASH_DIR_NAME))
}

/// Ensure a path stays within the trash root after canonicalization.
/// Trash root itself does not need to exist for an empty result, but if the
/// caller asks us to operate on a specific path it must canonicalize within.
fn assert_under_trash_root(path: &Path) -> Result<(), String> {
    let root = trash_root()?;
    // Resolve both sides; if the target doesn't exist yet (e.g. restore
    // destination), canonicalize the existing prefix instead.
    let canonical_path = path.canonicalize().map_err(|_| "Path not accessible".to_string())?;
    let canonical_root = root.canonicalize().map_err(|_| "Trash root not accessible".to_string())?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("Path outside trash root".to_string());
    }
    Ok(())
}

/// Parse the timestamp segment back to epoch ms. Accepts any of:
///   - "2026-05-27T18-42-03.123Z"  (`:` replaced with `-` for filename safety)
///   - "1716800000000"             (plain ms)
/// Returns 0 if unparseable (still surfaces entry to user).
fn parse_ts_segment(ts: &str) -> u64 {
    // Try plain numeric ms first
    if let Ok(n) = ts.parse::<u64>() {
        return n;
    }
    // Reverse the filename-safe substitution
    let mut s = ts.to_string();
    // Reconstruct "T??:??:??" — only the time portion uses `-` we replaced
    if let Some(t_idx) = s.find('T') {
        let date = &s[..t_idx];
        let rest = &s[t_idx + 1..];
        // Replace first two `-` in the time portion back to `:`
        let mut buf = String::with_capacity(rest.len());
        let mut replaced = 0;
        for ch in rest.chars() {
            if ch == '-' && replaced < 2 {
                buf.push(':');
                replaced += 1;
            } else {
                buf.push(ch);
            }
        }
        s = format!("{}T{}", date, buf);
    }
    // Parse via chrono if available — we don't depend on it here; fall back to
    // a coarse-grained parser based on `Date::parse` would need extra crates,
    // so accept failure and return 0.
    match httpdate_like_parse(&s) {
        Some(ms) => ms,
        None => 0,
    }
}

/// Minimal RFC3339 → epoch ms parser (subset) — avoids adding chrono dep here.
/// Accepts "YYYY-MM-DDTHH:MM:SS[.fff]Z" only.
fn httpdate_like_parse(s: &str) -> Option<u64> {
    let bytes = s.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    let minute: u32 = s.get(14..16)?.parse().ok()?;
    let second: u32 = s.get(17..19)?.parse().ok()?;

    if !(1970..=9999).contains(&year) { return None; }
    if !(1..=12).contains(&month) { return None; }
    if !(1..=31).contains(&day) { return None; }
    if hour > 23 || minute > 59 || second > 60 { return None; }

    // Civil-from-days algorithm (Howard Hinnant, public domain)
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as u64;
    let d = day as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch = era * 146097 + doe as i64 - 719468;
    let secs = days_since_epoch * 86400 + (hour as i64) * 3600 + (minute as i64) * 60 + (second as i64);
    if secs < 0 { return None; }
    Some((secs as u64) * 1000)
}

/// List trash entries, newest first.
///
/// `kb_id` = None → list all KBs; otherwise filter to one KB folder.
/// `limit` = None → DEFAULT_LIST_LIMIT (200).
#[command]
pub async fn kb_sync_list_trash(
    kb_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<TrashEntry>, String> {
    let root = trash_root()?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let cap = limit.unwrap_or(DEFAULT_LIST_LIMIT);
    let mut entries = Vec::new();

    let kb_iter = match &kb_id {
        Some(id) => {
            let p = root.join(id);
            if !p.exists() { return Ok(Vec::new()); }
            vec![p]
        }
        None => std::fs::read_dir(&root)
            .map_err(|_| "Cannot read trash root".to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.metadata().map(|m| m.is_dir() && !m.is_symlink()).unwrap_or(false)
            })
            .map(|e| e.path())
            .collect(),
    };

    for kb_dir in kb_iter {
        let kb_id_str = kb_dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let ts_iter = match std::fs::read_dir(&kb_dir) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for ts_entry in ts_iter.filter_map(|e| e.ok()) {
            match ts_entry.metadata() {
                Ok(m) if m.is_dir() && !m.is_symlink() => {}
                _ => continue,
            }
            let ts_path = ts_entry.path();
            let ts_name = ts_path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            collect_files_recursive(&ts_path, &ts_path, &kb_id_str, &ts_name, &mut entries);
            if entries.len() >= cap * 4 {
                // hard ceiling; we'll truncate after sort
                break;
            }
        }
    }

    entries.sort_by(|a, b| b.deleted_at_ms.cmp(&a.deleted_at_ms).then(a.relative_path.cmp(&b.relative_path)));
    if entries.len() > cap {
        entries.truncate(cap);
    }
    Ok(entries)
}

fn collect_files_recursive(
    base: &Path,
    cursor: &Path,
    kb_id: &str,
    ts_segment: &str,
    out: &mut Vec<TrashEntry>,
) {
    let iter = match std::fs::read_dir(cursor) {
        Ok(it) => it,
        Err(_) => return,
    };
    for entry in iter.filter_map(|e| e.ok()) {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_symlink() {
            continue; // never follow symlinks
        }
        if meta.is_dir() {
            collect_files_recursive(base, &path, kb_id, ts_segment, out);
        } else if meta.is_file() {
            let rel = match path.strip_prefix(base) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            out.push(TrashEntry {
                kb_id: kb_id.to_string(),
                deleted_at: ts_segment.to_string(),
                deleted_at_ms: parse_ts_segment(ts_segment),
                relative_path: rel,
                size_bytes: meta.len(),
                absolute_trash_path: path.to_string_lossy().to_string(),
            });
        }
    }
}

/// Restore a single trashed file back to the KB.
///
/// Frontend supplies `kb_root` (the original KB absolute path) and the
/// (kb_id, deleted_at, relative_path) triple from a previous list_trash call.
/// Returns ConflictExists when the destination is already present and
/// `overwrite=false`.
#[command]
pub async fn kb_sync_restore_from_trash(
    kb_id: String,
    deleted_at: String,
    relative_path: String,
    kb_root: String,
    overwrite: Option<bool>,
) -> Result<RestoreResult, String> {
    validate_relative_path(&relative_path)?;
    let overwrite = overwrite.unwrap_or(false);

    let trash_file = trash_root()?
        .join(&kb_id)
        .join(&deleted_at)
        .join(&relative_path);
    // assert_under_trash_root canonicalizes — file must currently exist
    if !trash_file.exists() {
        return Err("Trash entry not found".to_string());
    }
    assert_under_trash_root(&trash_file)?;

    let kb_root_path = PathBuf::from(&kb_root);
    let kb_root_canonical = kb_root_path
        .canonicalize()
        .map_err(|_| "KB root not accessible".to_string())?;
    // Build the would-be destination, then verify after canonicalize-of-parent
    let target = kb_root_canonical.join(&relative_path);
    // Verify target stays under kb_root_canonical
    let mut probe = target.clone();
    let canonical_parent = loop {
        if let Some(parent) = probe.parent() {
            if parent.exists() {
                break parent.canonicalize().map_err(|_| "Path not accessible".to_string())?;
            }
            probe = parent.to_path_buf();
        } else {
            return Err("Invalid restore destination".to_string());
        }
    };
    if !canonical_parent.starts_with(&kb_root_canonical) {
        return Err("Restore target escapes KB root".to_string());
    }

    if target.exists() && !overwrite {
        let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        return Ok(RestoreResult::ConflictExists { existing_size: size });
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Failed to create directory".to_string())?;
    }
    std::fs::rename(&trash_file, &target)
        .or_else(|_| {
            std::fs::copy(&trash_file, &target).map(|_| ())?;
            std::fs::remove_file(&trash_file)
        })
        .map_err(|_| "Failed to restore file".to_string())?;

    Ok(RestoreResult::Restored {
        target_path: target.to_string_lossy().to_string(),
    })
}

/// Purge trash entries older than the threshold (default 7 days).
#[command]
pub async fn kb_sync_purge_trash(
    kb_id: Option<String>,
    older_than_days: Option<u32>,
) -> Result<PurgeReport, String> {
    let root = trash_root()?;
    if !root.exists() {
        return Ok(PurgeReport::default());
    }
    let days = older_than_days.unwrap_or(DEFAULT_PURGE_DAYS) as u64;
    let cutoff_ms = current_epoch_ms().saturating_sub(days * 86_400_000);

    let mut report = PurgeReport::default();
    let kb_iter = match &kb_id {
        Some(id) => vec![root.join(id)],
        None => std::fs::read_dir(&root)
            .map_err(|_| "Cannot read trash root".to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.metadata().map(|m| m.is_dir() && !m.is_symlink()).unwrap_or(false)
            })
            .map(|e| e.path())
            .collect(),
    };

    for kb_dir in kb_iter {
        if !kb_dir.exists() { continue; }
        let ts_iter = match std::fs::read_dir(&kb_dir) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for ts_entry in ts_iter.filter_map(|e| e.ok()) {
            match ts_entry.metadata() {
                Ok(m) if m.is_dir() && !m.is_symlink() => {}
                _ => continue,
            }
            let ts_path = ts_entry.path();
            let ts_name = ts_path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let ts_ms = parse_ts_segment(&ts_name);
            if ts_ms == 0 || ts_ms >= cutoff_ms {
                continue;
            }
            // Belt-and-braces: confirm we're still inside the trash root before remove
            if assert_under_trash_root(&ts_path).is_err() {
                continue;
            }
            // Sum sizes recursively before delete
            sum_dir_sizes(&ts_path, &mut report);
            if std::fs::remove_dir_all(&ts_path).is_ok() {
                report.purged_dirs += 1;
            }
        }
    }
    Ok(report)
}

fn sum_dir_sizes(dir: &Path, report: &mut PurgeReport) {
    let iter = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return,
    };
    for entry in iter.filter_map(|e| e.ok()) {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            sum_dir_sizes(&entry.path(), report);
        } else if meta.is_file() {
            report.purged_files += 1;
            report.freed_bytes += meta.len();
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Error sanitization + plan-limit-403 reclassification now live in the
    // `picora-sdk` crate (with their own tests there). The local tests below
    // cover the Moraya-desktop-specific `validate_relative_path` + fs helpers.

    #[test]
    fn validate_relative_path_accepts_valid() {
        assert!(validate_relative_path("notes/foo.md").is_ok());
        assert!(validate_relative_path("MORAYA.md").is_ok());
        assert!(validate_relative_path(".moraya/index.json").is_ok());
        assert!(validate_relative_path("a/b/c/d.md").is_ok());
        assert!(validate_relative_path("notes/2026/04/foo bar.md").is_ok());
    }

    #[test]
    fn validate_relative_path_rejects_dotdot() {
        assert!(validate_relative_path("../secret.md").is_err());
        assert!(validate_relative_path("notes/../secret.md").is_err());
        assert!(validate_relative_path("notes/..").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_absolute() {
        assert!(validate_relative_path("/etc/passwd").is_err());
        assert!(validate_relative_path("/Users/onela/secret").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_backslash() {
        assert!(validate_relative_path("notes\\foo.md").is_err());
        assert!(validate_relative_path("a\\b\\c").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_empty() {
        assert!(validate_relative_path("").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_too_long() {
        let long_path = "a/".repeat(600);
        assert!(validate_relative_path(&long_path).is_err());
    }

    #[test]
    fn glob_match_double_star() {
        assert!(glob_match("node_modules/**", "node_modules/foo/bar.js"));
        assert!(glob_match("node_modules/**", "node_modules"));
        assert!(!glob_match("node_modules/**", "src/node_modules_copy/a.js"));
    }

    #[test]
    fn glob_match_extension_wildcard() {
        assert!(glob_match("*.tmp", "foo.tmp"));
        assert!(glob_match("*.tmp", "subdir/foo.tmp"));
        assert!(!glob_match("*.tmp", "foo.ts"));
    }

    #[test]
    fn glob_match_exact() {
        assert!(glob_match(".DS_Store", ".DS_Store"));
        assert!(glob_match(".DS_Store", "subdir/.DS_Store"));
    }

    // KB-list response-shape parsing (3 wrappers) + status sanitization moved
    // to the picora-sdk crate (`extract_items` + error tests).

    #[test]
    fn sync_op_upsert_first_sync_omits_base_updated_at() {
        // First-time upsert: no baseUpdatedAt. Picora rejects `null` for
        // string fields, so the serialized JSON must omit the key entirely.
        let op = SyncOp {
            op: "upsert".to_string(),
            relative_path: "notes/foo.md".to_string(),
            content: Some("# hello".to_string()),
            source_hash: Some("abc123".to_string()),
            base_updated_at: None,
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json["op"], "upsert");
        assert_eq!(json["relativePath"], "notes/foo.md");
        assert_eq!(json["content"], "# hello");
        assert_eq!(json["sourceHash"], "abc123");
        assert!(
            json.get("baseUpdatedAt").is_none(),
            "baseUpdatedAt must be absent (not null) when None: {}",
            json
        );
        // Verify no field anywhere in the JSON is null
        let s = serde_json::to_string(&op).unwrap();
        assert!(!s.contains("null"), "serialized op must contain no null values: {s}");
    }

    #[test]
    fn sync_op_upsert_subsequent_sync_includes_base_updated_at() {
        let op = SyncOp {
            op: "upsert".to_string(),
            relative_path: "notes/foo.md".to_string(),
            content: Some("# updated".to_string()),
            source_hash: Some("def456".to_string()),
            base_updated_at: Some("2026-04-30T12:00:00Z".to_string()),
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json["baseUpdatedAt"], "2026-04-30T12:00:00Z");
    }

    #[test]
    fn sync_op_delete_omits_all_optional_fields() {
        // Delete ops carry only op + relativePath. None of the three optional
        // fields should appear in the wire format.
        let op = SyncOp {
            op: "delete".to_string(),
            relative_path: "notes/old.md".to_string(),
            content: None,
            source_hash: None,
            base_updated_at: None,
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json["op"], "delete");
        assert_eq!(json["relativePath"], "notes/old.md");
        assert!(json.get("content").is_none(), "delete must omit content: {json}");
        assert!(json.get("sourceHash").is_none(), "delete must omit sourceHash: {json}");
        assert!(json.get("baseUpdatedAt").is_none(), "delete must omit baseUpdatedAt: {json}");
        let s = serde_json::to_string(&op).unwrap();
        assert!(!s.contains("null"), "serialized delete op must contain no null values: {s}");
    }

    // ── Trash UX tests (v0.68.0) ──────────────────────────────────────

    #[test]
    fn parse_ts_segment_numeric_ms() {
        assert_eq!(parse_ts_segment("1716800000000"), 1_716_800_000_000);
    }

    #[test]
    fn parse_ts_segment_filename_safe_rfc3339() {
        // 2026-05-27T18:42:03Z → filename-safe → 2026-05-27T18-42-03Z
        let ms = parse_ts_segment("2026-05-27T18-42-03Z");
        assert_eq!(ms, 1_779_907_323_000);
    }

    #[test]
    fn parse_ts_segment_filename_safe_rfc3339_with_fraction() {
        // Fractional seconds after `.` — parser ignores the fraction
        let ms = parse_ts_segment("2026-05-27T18-42-03.500Z");
        assert_eq!(ms, 1_779_907_323_000);
    }

    #[test]
    fn parse_ts_segment_returns_zero_on_invalid_month() {
        assert_eq!(parse_ts_segment("2026-13-01T00-00-00Z"), 0);
        assert_eq!(parse_ts_segment("2026-00-01T00-00-00Z"), 0);
    }

    #[test]
    fn parse_ts_segment_returns_zero_on_garbage() {
        assert_eq!(parse_ts_segment(""), 0);
        assert_eq!(parse_ts_segment("not-a-timestamp"), 0);
        assert_eq!(parse_ts_segment("9999-99-99T99-99-99Z"), 0);
    }

    #[test]
    fn restore_result_serializes_with_kind_tag() {
        let r = RestoreResult::Restored { target_path: "/x/y.md".to_string() };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"kind\":\"restored\""), "{s}");
        assert!(s.contains("\"targetPath\":\"/x/y.md\""), "{s}");

        let c = RestoreResult::ConflictExists { existing_size: 42 };
        let s = serde_json::to_string(&c).unwrap();
        assert!(s.contains("\"kind\":\"conflict-exists\""), "{s}");
        assert!(s.contains("\"existingSize\":42"), "{s}");
    }

    #[test]
    fn trash_entry_serializes_with_camelcase() {
        let e = TrashEntry {
            kb_id: "kb-1".to_string(),
            deleted_at: "ts".to_string(),
            deleted_at_ms: 1,
            relative_path: "a.md".to_string(),
            size_bytes: 7,
            absolute_trash_path: "/p".to_string(),
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains("\"kbId\""), "{s}");
        assert!(s.contains("\"deletedAt\""), "{s}");
        assert!(s.contains("\"deletedAtMs\""), "{s}");
        assert!(s.contains("\"relativePath\""), "{s}");
        assert!(s.contains("\"sizeBytes\""), "{s}");
        assert!(s.contains("\"absoluteTrashPath\""), "{s}");
    }

    #[test]
    fn purge_report_default_is_zero() {
        let p = PurgeReport::default();
        assert_eq!(p.purged_files, 0);
        assert_eq!(p.purged_dirs, 0);
        assert_eq!(p.freed_bytes, 0);
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"purgedFiles\":0"), "{s}");
    }

}
