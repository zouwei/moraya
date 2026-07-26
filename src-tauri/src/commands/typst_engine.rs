//! Typst typesetting engine — on-demand download + compile.
//!
//! Moraya's identity is a tiny (~10 MB) binary, so the Typst compiler is NOT
//! linked into the app. Instead the official pre-built `typst` CLI is fetched
//! on first use (HTTPS from the typst/typst GitHub release, cached under
//! `~/.moraya/typst/`) and shelled out to. This mirrors the on-demand
//! `kb_download_ort_runtime` precedent so non-Typst users pay zero bytes.
//!
//! P0 surface: `typst_export_markdown_pdf` renders the current markdown through
//! Typst (via the `cmarker` package) into a genuinely typeset PDF — a quality
//! step up from the html2canvas DOM-screenshot PDF. P1 adds raw `.typ`
//! source compilation for the Typst authoring flavor.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use super::file as file_cmd;

/// Pinned Typst release. Bump together with the asset table below.
const TYPST_VERSION: &str = "0.15.1";

/// cmarker: CommonMark → Typst content, resolved from the Typst package
/// universe on first compile and cached by the CLI. Pinned for reproducibility.
/// 0.1.10+ is required for GFM table rendering (0.1.1 emitted tables as literal
/// text — verified during P0 bring-up).
const CMARKER_VERSION: &str = "0.1.10";

/// Progress for the engine download, emitted on the `typst-engine-download-progress` event.
#[derive(Clone, Serialize, Debug)]
pub struct EngineDownloadProgress {
    pub received: u64,
    pub total: u64,
    pub progress: u32,
}

/// `~/.moraya/typst/` — engine cache directory.
fn typst_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let dir = home.join(".moraya").join("typst");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|_| "Cannot create typst directory".to_string())?;
    }
    Ok(dir)
}

/// Path to the cached `typst` executable for this platform.
fn typst_binary_path() -> Result<PathBuf, String> {
    let dir = typst_dir()?;
    #[cfg(target_os = "windows")]
    let name = "typst.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "typst";
    Ok(dir.join(name))
}

/// Release asset for this platform: (asset file name, is_zip).
/// The archive extracts to `typst-<target>/typst[.exe]`.
fn platform_asset() -> Result<(String, bool), String> {
    // (target-triple stem, is_zip)
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let (stem, is_zip) = ("aarch64-apple-darwin", false);
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let (stem, is_zip) = ("x86_64-apple-darwin", false);
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let (stem, is_zip) = ("x86_64-unknown-linux-musl", false);
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let (stem, is_zip) = ("aarch64-unknown-linux-musl", false);
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    let (stem, is_zip) = ("x86_64-pc-windows-msvc", true);

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    return Err("Typst is not available for this platform".to_string());

    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    ))]
    {
        let ext = if is_zip { "zip" } else { "tar.xz" };
        Ok((format!("typst-{stem}.{ext}"), is_zip))
    }
}

/// Whether the engine is already cached locally.
#[tauri::command]
pub fn typst_engine_status() -> bool {
    typst_binary_path().map(|p| p.exists()).unwrap_or(false)
}

/// Ensure the Typst engine is present, downloading + extracting it on first use.
/// Returns the absolute path to the cached executable.
#[tauri::command]
pub async fn typst_ensure_engine(app: AppHandle) -> Result<String, String> {
    let bin = typst_binary_path()?;
    if bin.exists() {
        return Ok(bin.to_string_lossy().to_string());
    }

    let (asset, is_zip) = platform_asset()?;
    let url = format!(
        "https://github.com/typst/typst/releases/download/v{TYPST_VERSION}/{asset}"
    );

    // Download the archive to a temp file next to the target.
    let tmp = typst_dir()?.join(format!("{asset}.download"));
    download_engine(&app, &url, &tmp).await?;

    let data = std::fs::read(&tmp).map_err(|_| "Failed to read download".to_string())?;
    let _ = std::fs::remove_file(&tmp);

    extract_typst_binary(&data, is_zip, &bin)?;

    if !bin.exists() {
        return Err("Failed to extract the Typst engine from the archive".to_string());
    }

    // Mark executable on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&bin)
            .map_err(|_| "Cannot stat engine".to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bin, perms).map_err(|_| "Cannot chmod engine".to_string())?;
    }

    Ok(bin.to_string_lossy().to_string())
}

/// Export the given markdown as a genuinely typeset PDF via Typst (`cmarker`).
/// `output_path` is validated against the home-dir sandbox before writing.
#[tauri::command]
pub async fn typst_export_markdown_pdf(
    app: AppHandle,
    markdown: String,
    output_path: String,
) -> Result<(), String> {
    let _ = file_cmd::validate_path(&output_path)?;
    let bin = typst_ensure_engine(app).await?;

    // Scratch project: input.md + main.typ (root for #read).
    let work = typst_dir()?.join("work");
    std::fs::create_dir_all(&work).map_err(|_| "Cannot create work dir".to_string())?;
    std::fs::write(work.join("input.md"), markdown.as_bytes())
        .map_err(|_| "Cannot stage markdown".to_string())?;
    std::fs::write(work.join("main.typ"), markdown_wrapper_typ())
        .map_err(|_| "Cannot stage typst".to_string())?;

    compile_to_file(&bin, &work, "main.typ", "pdf", Path::new(&output_path))
}

/// The `main.typ` that renders `input.md` through cmarker.
fn markdown_wrapper_typ() -> String {
    format!(
        "#import \"@preview/cmarker:{CMARKER_VERSION}\"\n\
         #set page(margin: 2.2cm)\n\
         #set text(size: 11pt)\n\
         #cmarker.render(read(\"input.md\"), math: none)\n"
    )
}

/// Result of compiling raw Typst source.
#[derive(Serialize, Debug, Default)]
pub struct TypstCompileResult {
    /// One SVG string per page — populated when `format == "svg"` (live
    /// preview). Empty for `format == "pdf"` (written to `output_path`).
    pub pages: Vec<String>,
}

/// Compile raw `.typ` source (the Typst authoring flavor, P1).
/// - `format == "svg"` → returns per-page SVG for the live preview pane.
/// - `format == "pdf"` → writes a PDF to `output_path` (home-dir validated).
///
/// Compilation diagnostics are returned as `Err` so the editor can surface
/// them inline while the user types.
#[tauri::command]
pub async fn typst_compile_source(
    app: AppHandle,
    source: String,
    format: String,
    output_path: Option<String>,
) -> Result<TypstCompileResult, String> {
    let bin = typst_ensure_engine(app).await?;

    let work = typst_dir()?.join("source-work");
    std::fs::create_dir_all(&work).map_err(|_| "Cannot create work dir".to_string())?;
    std::fs::write(work.join("main.typ"), source.as_bytes())
        .map_err(|_| "Cannot stage source".to_string())?;

    match format.as_str() {
        "svg" => {
            let pages = compile_source_to_svg_pages(&bin, &work)?;
            Ok(TypstCompileResult { pages })
        }
        "pdf" => {
            let out = output_path.ok_or("Output path required for PDF")?;
            let _ = file_cmd::validate_path(&out)?;
            compile_to_file(&bin, &work, "main.typ", "pdf", Path::new(&out))?;
            Ok(TypstCompileResult::default())
        }
        // Word: Typst has no .doc writer, but Word opens HTML — the same trick
        // the markdown .doc export uses. Emit HTML, save under the .doc path.
        //
        // Without an output path the HTML comes back in `pages[0]` instead: that
        // is the Typst → Markdown conversion route, where the compiler acts as
        // the evaluator and the caller converts the HTML in-memory.
        "html" | "doc" => {
            let html = compile_html(&bin, &work)?;
            match output_path {
                Some(out) => {
                    let _ = file_cmd::validate_path(&out)?;
                    std::fs::write(&out, html.as_bytes())
                        .map_err(|_| "Cannot write output file".to_string())?;
                    Ok(TypstCompileResult::default())
                }
                None => Ok(TypstCompileResult { pages: vec![html] }),
            }
        }
        "png" => {
            let out = output_path.ok_or("Output path required for PNG")?;
            let _ = file_cmd::validate_path(&out)?;
            let written = compile_png_pages(&bin, &work, Path::new(&out))?;
            Ok(TypstCompileResult { pages: written })
        }
        _ => Err("Unsupported Typst output format".to_string()),
    }
}

/// HTML export. Typst gates this behind `--features html` and warns that the
/// writer is still incomplete, but it produces valid semantic HTML (with MathML
/// for equations), which beats rasterizing for a text-oriented format.
///
/// Returns the HTML rather than writing it: both callers need it in memory —
/// the export path to place it under a user-chosen `.html`/`.doc` name, the
/// conversion path to hand it to `@moraya/core/convert`.
fn compile_html(bin: &str, root: &Path) -> Result<String, String> {
    let out_tmp = root.join("out.html");
    let _ = std::fs::remove_file(&out_tmp);

    let output = std::process::Command::new(bin)
        .arg("compile")
        .arg("--features")
        .arg("html")
        .arg("--root")
        .arg(root)
        .arg("--format")
        .arg("html")
        .arg(root.join("main.typ"))
        .arg(&out_tmp)
        .current_dir(root)
        .output()
        .map_err(|_| "Failed to launch the Typst engine".to_string())?;

    if !output.status.success() {
        return Err(trim_diagnostic(&output.stderr));
    }
    let bytes = std::fs::read(&out_tmp).map_err(|_| "Compiled output missing".to_string())?;
    let _ = std::fs::remove_file(&out_tmp);
    String::from_utf8(bytes).map_err(|_| "Compiled output was not valid text".to_string())
}

/// PNG export, one file per page (Typst cannot merge pages into one raster).
/// A single-page document lands exactly on `dest`; a multi-page document is
/// written as `<stem>-1.png`, `<stem>-2.png`, … next to it. Returns the file
/// names actually written so the UI can report multi-page output.
fn compile_png_pages(bin: &str, root: &Path, dest: &Path) -> Result<Vec<String>, String> {
    let clear = || {
        if let Ok(rd) = std::fs::read_dir(root) {
            for e in rd.flatten() {
                let n = e.file_name();
                let n = n.to_string_lossy();
                if n.starts_with("png-") && n.ends_with(".png") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    };
    clear();

    let output = std::process::Command::new(bin)
        .arg("compile")
        .arg("--root")
        .arg(root)
        .arg("--format")
        .arg("png")
        .arg(root.join("main.typ"))
        .arg(root.join("png-{p}.png"))
        .current_dir(root)
        .output()
        .map_err(|_| "Failed to launch the Typst engine".to_string())?;

    if !output.status.success() {
        return Err(trim_diagnostic(&output.stderr));
    }

    // Collect rendered pages in numeric order.
    let mut rendered: Vec<(u32, std::path::PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let fname = e.file_name();
            let fname = fname.to_string_lossy().to_string();
            if let Some(mid) = fname.strip_prefix("png-").and_then(|s| s.strip_suffix(".png")) {
                if let Ok(n) = mid.parse::<u32>() {
                    rendered.push((n, e.path()));
                }
            }
        }
    }
    rendered.sort_by_key(|(n, _)| *n);
    if rendered.is_empty() {
        return Err("Typst produced no pages".to_string());
    }

    let mut written = Vec::new();
    if rendered.len() == 1 {
        std::fs::copy(&rendered[0].1, dest).map_err(|_| "Cannot write output file".to_string())?;
        written.push(dest.file_name().unwrap_or_default().to_string_lossy().to_string());
    } else {
        let parent = dest.parent().unwrap_or(Path::new("."));
        let stem = dest.file_stem().unwrap_or_default().to_string_lossy().to_string();
        for (n, src) in &rendered {
            let target = parent.join(format!("{stem}-{n}.png"));
            std::fs::copy(src, &target).map_err(|_| "Cannot write output file".to_string())?;
            written.push(target.file_name().unwrap_or_default().to_string_lossy().to_string());
        }
    }
    clear();
    Ok(written)
}

/// Trim a compiler stderr blob into a short, path-free diagnostic.
fn trim_diagnostic(stderr: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr);
    let msg: String = err.lines().take(12).collect::<Vec<_>>().join("\n");
    if msg.trim().is_empty() {
        "Typst compilation failed".to_string()
    } else {
        msg.chars().take(1200).collect()
    }
}

/// Compile `main.typ` to one SVG per page (`page-<n>.svg`), returning them
/// ordered by page number. Stale page files from a previous (longer) render
/// are cleared first so the preview never shows leftover pages.
fn compile_source_to_svg_pages(bin: &str, root: &Path) -> Result<Vec<String>, String> {
    let clear_pages = || {
        if let Ok(rd) = std::fs::read_dir(root) {
            for e in rd.flatten() {
                let name = e.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("page-") && name.ends_with(".svg") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    };
    clear_pages();

    let output = std::process::Command::new(bin)
        .arg("compile")
        .arg("--root")
        .arg(root)
        .arg("--format")
        .arg("svg")
        .arg(root.join("main.typ"))
        .arg(root.join("page-{p}.svg"))
        .current_dir(root)
        .output()
        .map_err(|_| "Failed to launch the Typst engine".to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let msg: String = err.lines().take(12).collect::<Vec<_>>().join("\n");
        let msg = if msg.trim().is_empty() {
            "Typst compilation failed".to_string()
        } else {
            msg.chars().take(1200).collect()
        };
        return Err(msg);
    }

    // Collect page-<n>.svg, numeric-sorted, then clean up.
    let mut pages: Vec<(u32, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let fname = e.file_name();
            let fname = fname.to_string_lossy();
            if let Some(mid) = fname
                .strip_prefix("page-")
                .and_then(|s| s.strip_suffix(".svg"))
            {
                if let Ok(n) = mid.parse::<u32>() {
                    if let Ok(svg) = std::fs::read_to_string(e.path()) {
                        pages.push((n, svg));
                    }
                }
            }
        }
    }
    clear_pages();
    pages.sort_by_key(|(n, _)| *n);
    Ok(pages.into_iter().map(|(_, s)| s).collect())
}

/// Run `typst compile` inside `root`, writing `<format>` output to `dest`.
fn compile_to_file(
    bin: &str,
    root: &Path,
    entry: &str,
    format: &str,
    dest: &Path,
) -> Result<(), String> {
    let out_tmp = root.join(format!("out.{format}"));
    let _ = std::fs::remove_file(&out_tmp);

    let output = std::process::Command::new(bin)
        .arg("compile")
        .arg("--root")
        .arg(root)
        .arg("--format")
        .arg(format)
        .arg(entry)
        .arg(&out_tmp)
        .current_dir(root)
        .output()
        .map_err(|_| "Failed to launch the Typst engine".to_string())?;

    if !output.status.success() {
        // Surface a trimmed compiler diagnostic (no absolute paths).
        let err = String::from_utf8_lossy(&output.stderr);
        let msg: String = err.lines().take(8).collect::<Vec<_>>().join("\n");
        let msg = if msg.trim().is_empty() {
            "Typst compilation failed".to_string()
        } else {
            msg
        };
        return Err(msg.chars().take(600).collect());
    }

    let bytes = std::fs::read(&out_tmp).map_err(|_| "Compiled output missing".to_string())?;
    let _ = std::fs::remove_file(&out_tmp);
    std::fs::write(dest, bytes).map_err(|_| "Cannot write output file".to_string())?;
    Ok(())
}

/// Streaming download of the engine archive with progress events.
async fn download_engine(app: &AppHandle, url: &str, dest: &Path) -> Result<(), String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .user_agent("Moraya/1.0")
        .build()
        .map_err(|_| "HTTP client error".to_string())?;

    let resp = client.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            "Download timed out".to_string()
        } else {
            "Engine download failed".to_string()
        }
    })?;
    if !resp.status().is_success() {
        return Err(format!("Engine download error ({})", resp.status().as_u16()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut received: u64 = 0;
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|_| "Cannot create download file".to_string())?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Download stream error".to_string())?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|_| "Write error".to_string())?;
        received += chunk.len() as u64;
        let progress = if total > 0 {
            (received as f64 / total as f64 * 100.0) as u32
        } else {
            0
        };
        let _ = app.emit(
            "typst-engine-download-progress",
            EngineDownloadProgress {
                received,
                total,
                progress,
            },
        );
    }
    Ok(())
}

/// Extract the `typst[.exe]` binary from the release archive into `dest`.
fn extract_typst_binary(data: &[u8], is_zip: bool, dest: &Path) -> Result<(), String> {
    let bin_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Bad destination")?;

    if is_zip {
        extract_from_zip(data, bin_name, dest)
    } else {
        extract_from_tar_xz(data, bin_name, dest)
    }
}

/// `.tar.xz` (macOS / Linux) — xz-decode (pure Rust) then walk the tar.
fn extract_from_tar_xz(data: &[u8], bin_name: &str, dest: &Path) -> Result<(), String> {
    use std::io::Read;

    let mut xz_reader = std::io::BufReader::new(std::io::Cursor::new(data));
    let mut tar_bytes = Vec::new();
    lzma_rs::xz_decompress(&mut xz_reader, &mut tar_bytes)
        .map_err(|_| "Failed to decompress engine archive".to_string())?;

    let mut archive = tar::Archive::new(std::io::Cursor::new(tar_bytes));
    for entry in archive
        .entries()
        .map_err(|_| "Failed to read archive".to_string())?
    {
        let mut entry = entry.map_err(|_| "Archive entry error".to_string())?;
        let path = entry.path().map_err(|_| "Path error".to_string())?;
        let is_binary = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == bin_name)
            .unwrap_or(false);
        if is_binary {
            let mut out = Vec::new();
            entry
                .read_to_end(&mut out)
                .map_err(|_| "Read error".to_string())?;
            std::fs::write(dest, out).map_err(|_| "Write error".to_string())?;
            return Ok(());
        }
    }
    Err("Engine binary not found in archive".to_string())
}

/// `.zip` (Windows) — walk entries for `typst.exe`.
#[cfg(target_os = "windows")]
fn extract_from_zip(data: &[u8], bin_name: &str, dest: &Path) -> Result<(), String> {
    use std::io::Read;

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data))
        .map_err(|_| "Failed to read zip archive".to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|_| "Zip entry error".to_string())?;
        let ends = entry
            .name()
            .rsplit('/')
            .next()
            .map(|n| n == bin_name)
            .unwrap_or(false);
        if ends {
            let mut out = Vec::new();
            entry
                .read_to_end(&mut out)
                .map_err(|_| "Read error".to_string())?;
            std::fs::write(dest, out).map_err(|_| "Write error".to_string())?;
            return Ok(());
        }
    }
    Err("Engine binary not found in zip".to_string())
}

#[cfg(not(target_os = "windows"))]
fn extract_from_zip(_data: &[u8], _bin_name: &str, _dest: &Path) -> Result<(), String> {
    Err("zip archives are only used on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_asset_matches_pinned_pattern() {
        // On any supported host the asset name follows the release convention.
        if let Ok((asset, is_zip)) = platform_asset() {
            assert!(asset.starts_with("typst-"));
            if is_zip {
                assert!(asset.ends_with(".zip"));
            } else {
                assert!(asset.ends_with(".tar.xz"));
            }
        }
    }

    #[test]
    fn wrapper_references_cmarker_and_input() {
        let w = markdown_wrapper_typ();
        assert!(w.contains("cmarker"));
        assert!(w.contains("input.md"));
    }

    #[test]
    fn binary_name_is_platform_correct() {
        let p = typst_binary_path().unwrap();
        let name = p.file_name().unwrap().to_str().unwrap();
        #[cfg(target_os = "windows")]
        assert_eq!(name, "typst.exe");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(name, "typst");
    }
}
