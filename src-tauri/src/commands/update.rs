use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: u64,
    progress: u32,
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Download a file from `url` into the user's Downloads folder as `filename`.
/// Emits `download-progress` events with { received, total, progress } payload.
/// Returns the full path of the downloaded file.
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    println!("[update] Starting download: {}", url);
    println!("[update] Filename: {}", filename);

    // Resolve Downloads directory
    let download_dir = dirs::download_dir()
        .ok_or_else(|| "Cannot resolve Downloads directory".to_string())?;
    let dest_path = download_dir.join(&filename);
    println!("[update] Destination: {}", dest_path.display());

    // Build HTTP client with proper User-Agent (GitHub CDN rejects bare requests)
    let client = reqwest::Client::builder()
        .user_agent("Moraya-Updater/1.0")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| {
            let msg = format!("Failed to create HTTP client: {}", e);
            eprintln!("[update] ERROR: {}", msg);
            msg
        })?;

    println!("[update] Sending HTTP request...");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            let msg = format!("HTTP request failed: {}", e);
            eprintln!("[update] ERROR: {}", msg);
            msg
        })?;

    println!("[update] Response status: {}", response.status());
    println!("[update] Response headers: {:?}", response.headers());

    if !response.status().is_success() {
        let msg = format!("Download failed: HTTP {}", response.status());
        eprintln!("[update] ERROR: {}", msg);
        return Err(msg);
    }

    let total = response.content_length().unwrap_or(0);
    println!("[update] Content-Length: {} bytes ({:.2} MB)", total, total as f64 / 1024.0 / 1024.0);

    // Create destination file
    let mut file = tokio::fs::File::create(&dest_path)
        .await
        .map_err(|e| {
            let msg = format!("Failed to create file {}: {}", dest_path.display(), e);
            eprintln!("[update] ERROR: {}", msg);
            msg
        })?;
    println!("[update] File created, starting stream download...");

    // Stream response body directly to disk
    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    let mut last_progress: u32 = 0;
    let mut chunk_count: u64 = 0;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result
            .map_err(|e| {
                let msg = format!("Download stream error at {} bytes (chunk #{}): {}", received, chunk_count, e);
                eprintln!("[update] ERROR: {}", msg);
                msg
            })?;
        file.write_all(&chunk)
            .await
            .map_err(|e| {
                let msg = format!("File write error at {} bytes: {}", received, e);
                eprintln!("[update] ERROR: {}", msg);
                msg
            })?;
        received += chunk.len() as u64;
        chunk_count += 1;

        // Emit progress events (throttle to avoid flooding)
        if total > 0 {
            let progress = ((received as f64 / total as f64) * 100.0) as u32;
            if progress != last_progress {
                last_progress = progress;
                // Print progress every 10%
                if progress % 10 == 0 {
                    println!("[update] Progress: {}% ({}/{} bytes, {} chunks)", progress, received, total, chunk_count);
                }
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress {
                        received,
                        total,
                        progress,
                    },
                );
            }
        }
    }

    println!("[update] Stream finished. Total received: {} bytes in {} chunks", received, chunk_count);

    file.flush()
        .await
        .map_err(|e| {
            let msg = format!("File flush error: {}", e);
            eprintln!("[update] ERROR: {}", msg);
            msg
        })?;

    // Verify file size if content-length was known
    if total > 0 && received != total {
        let msg = format!("Download incomplete: received {} of {} bytes", received, total);
        eprintln!("[update] ERROR: {}", msg);
        return Err(msg);
    }

    let full_path = dest_path.to_string_lossy().into_owned();
    println!("[update] Download complete: {}", full_path);

    // Linux: AppImage files need executable permission before opening
    #[cfg(target_os = "linux")]
    if filename.ends_with(".AppImage") {
        use std::os::unix::fs::PermissionsExt;
        println!("[update] Setting executable permission on AppImage...");
        let _ = std::fs::set_permissions(&dest_path, std::fs::Permissions::from_mode(0o755));
    }

    // Open the installer with the OS default handler (macOS: mounts DMG)
    println!("[update] Opening installer...");
    match open::that(&dest_path) {
        Ok(()) => println!("[update] Installer opened successfully"),
        Err(e) => eprintln!("[update] Failed to open installer: {} (file is in Downloads)", e),
    }

    Ok(full_path)
}
