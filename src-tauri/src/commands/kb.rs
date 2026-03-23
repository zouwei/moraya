use anndists::dist::distances::DistCosine;
use hnsw_rs::api::AnnT;
use hnsw_rs::hnsw::Hnsw;
use hnsw_rs::hnswio::HnswIo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;

use super::ai_proxy::AIProxyState;
use super::file::validate_path;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChunkMeta {
    pub id: usize,
    pub file_path: String,
    pub heading: Option<String>,
    pub offset: usize,
    pub length: usize,
    pub preview: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct IndexMeta {
    pub version: u32,
    pub model_id: String,
    pub dimensions: u32,
    pub chunk_count: usize,
    pub file_hashes: HashMap<String, String>,
    pub last_updated: String,
    pub embedding_source: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchResult {
    pub file_path: String,
    pub heading: Option<String>,
    pub preview: String,
    pub score: f32,
    pub offset: usize,
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct IndexStatus {
    pub indexed: bool,
    pub chunk_count: usize,
    pub file_count: usize,
    pub model_id: String,
    pub dimensions: u32,
    pub last_updated: Option<String>,
    pub stale_files: Vec<String>,
}

#[derive(Clone, Serialize, Debug)]
pub struct IndexProgress {
    pub phase: String,
    pub current: u32,
    pub total: u32,
    pub file_name: String,
}

// ---------------------------------------------------------------------------
// BM25 Index
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug)]
pub struct BM25Index {
    /// term → Vec<(chunk_id, term_frequency)>
    inverted: HashMap<String, Vec<(usize, f32)>>,
    doc_lengths: Vec<f32>,
    avg_doc_length: f32,
    total_docs: usize,
}

const BM25_K1: f32 = 1.2;
const BM25_B: f32 = 0.75;

impl BM25Index {
    pub fn build(texts: &[String]) -> Self {
        let total_docs = texts.len();
        let mut inverted: HashMap<String, Vec<(usize, f32)>> = HashMap::new();
        let mut doc_lengths = Vec::with_capacity(total_docs);
        let mut total_length: f32 = 0.0;

        for (doc_id, text) in texts.iter().enumerate() {
            let tokens = tokenize(text);
            let doc_len = tokens.len() as f32;
            doc_lengths.push(doc_len);
            total_length += doc_len;

            // Count term frequencies in this document
            let mut tf_map: HashMap<&str, u32> = HashMap::new();
            for token in &tokens {
                *tf_map.entry(token.as_str()).or_insert(0) += 1;
            }

            for (term, count) in tf_map {
                inverted
                    .entry(term.to_string())
                    .or_default()
                    .push((doc_id, count as f32));
            }
        }

        let avg_doc_length = if total_docs > 0 {
            total_length / total_docs as f32
        } else {
            1.0
        };

        Self {
            inverted,
            doc_lengths,
            avg_doc_length,
            total_docs,
        }
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<(usize, f32)> {
        let query_tokens = tokenize(query);
        let mut scores: HashMap<usize, f32> = HashMap::new();

        for token in &query_tokens {
            if let Some(postings) = self.inverted.get(token.as_str()) {
                let df = postings.len() as f32;
                let idf = ((self.total_docs as f32 - df + 0.5) / (df + 0.5) + 1.0).ln();
                if idf <= 0.0 {
                    continue;
                }

                for &(doc_id, tf) in postings {
                    let doc_len = self.doc_lengths.get(doc_id).copied().unwrap_or(1.0);
                    let numerator = tf * (BM25_K1 + 1.0);
                    let denominator =
                        tf + BM25_K1 * (1.0 - BM25_B + BM25_B * doc_len / self.avg_doc_length);
                    let bm25_score = idf * numerator / denominator;
                    *scores.entry(doc_id).or_insert(0.0) += bm25_score;
                }
            }
        }

        let mut results: Vec<(usize, f32)> = scores.into_iter().collect();
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(top_k);
        results
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(self).map_err(|e| format!("BM25 serialize error: {}", e))
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(data).map_err(|_| "BM25 index corrupted".to_string())
    }
}

/// Simple tokenizer: split on whitespace and punctuation, lowercase, filter short tokens.
/// Handles CJK by treating each CJK character as a separate token.
fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in lower.chars() {
        if is_cjk(ch) {
            // Flush any accumulated ASCII token
            if current.len() >= 2 {
                tokens.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
            // Each CJK character is its own token
            tokens.push(ch.to_string());
        } else if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else {
            // Whitespace or punctuation — flush
            if current.len() >= 2 {
                tokens.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.len() >= 2 {
        tokens.push(current);
    }

    tokens
}

fn is_cjk(ch: char) -> bool {
    matches!(ch,
        '\u{4E00}'..='\u{9FFF}' |    // CJK Unified Ideographs
        '\u{3400}'..='\u{4DBF}' |    // CJK Extension A
        '\u{F900}'..='\u{FAFF}' |    // CJK Compatibility Ideographs
        '\u{3000}'..='\u{303F}' |    // CJK Symbols and Punctuation
        '\u{3040}'..='\u{309F}' |    // Hiragana
        '\u{30A0}'..='\u{30FF}' |    // Katakana
        '\u{AC00}'..='\u{D7AF}'      // Hangul Syllables
    )
}

// ---------------------------------------------------------------------------
// Document chunking
// ---------------------------------------------------------------------------

struct TextChunk {
    heading: Option<String>,
    offset: usize,
    text: String,
}

/// Find the largest byte index <= pos that is a valid char boundary.
fn floor_char_boundary(s: &str, pos: usize) -> usize {
    if pos >= s.len() { return s.len(); }
    let mut i = pos;
    while i > 0 && !s.is_char_boundary(i) { i -= 1; }
    i
}

/// Find the smallest byte index >= pos that is a valid char boundary.
fn ceil_char_boundary(s: &str, pos: usize) -> usize {
    if pos >= s.len() { return s.len(); }
    let mut i = pos;
    while i < s.len() && !s.is_char_boundary(i) { i += 1; }
    i
}

/// Safely truncate a string to at most `max_bytes`, aligned to a char boundary.
fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    &s[..floor_char_boundary(s, max_bytes)]
}

/// Maximum chunk size in characters (approximately 512 tokens).
const MAX_CHUNK_CHARS: usize = 2000;
/// Overlap in characters for sliding window fallback.
const CHUNK_OVERLAP_CHARS: usize = 300;
/// For files > 1MB, use smaller chunks.
const LARGE_FILE_CHUNK_CHARS: usize = 1000;
/// Maximum chunks per file.
const MAX_CHUNKS_PER_FILE: usize = 200;

/// Chunk a document into embedding-ready segments.
/// Strategy: heading-based primary, fixed-size sliding window fallback.
fn chunk_document(content: &str, _file_path: &str) -> Vec<TextChunk> {
    let content = strip_frontmatter(content);
    let is_large = content.len() > 1_000_000;
    let max_chars = if is_large {
        LARGE_FILE_CHUNK_CHARS
    } else {
        MAX_CHUNK_CHARS
    };

    // Try heading-based chunking first
    let chunks = chunk_by_headings(&content, max_chars);

    // If no headings found, fall back to sliding window
    let chunks = if chunks.is_empty() {
        chunk_by_window(&content, max_chars, CHUNK_OVERLAP_CHARS)
    } else {
        chunks
    };

    // Enforce per-file limit
    if chunks.len() > MAX_CHUNKS_PER_FILE {
        chunks.into_iter().take(MAX_CHUNKS_PER_FILE).collect()
    } else {
        chunks
    }
}

/// Strip YAML frontmatter (between --- delimiters at start of file).
fn strip_frontmatter(content: &str) -> String {
    if !content.starts_with("---") {
        return content.to_string();
    }
    if let Some(end) = content[3..].find("\n---") {
        let after = end + 3 + 4; // skip past closing ---\n
        if after < content.len() {
            return content[after..].trim_start().to_string();
        }
    }
    content.to_string()
}

fn chunk_by_headings(content: &str, max_chars: usize) -> Vec<TextChunk> {
    let mut chunks = Vec::new();
    let mut current_heading: Option<String> = None;
    let mut current_text = String::new();
    let mut current_offset: usize = 0;
    let mut line_offset: usize = 0;

    for line in content.lines() {
        let is_heading = line.starts_with('#') && {
            let trimmed = line.trim_start_matches('#');
            trimmed.starts_with(' ') || trimmed.is_empty()
        };

        if is_heading {
            // Flush previous chunk
            let text = current_text.trim().to_string();
            if !text.is_empty() {
                // Split if too large
                if text.len() > max_chars {
                    let sub_chunks =
                        chunk_by_window(&text, max_chars, CHUNK_OVERLAP_CHARS);
                    for mut sc in sub_chunks {
                        sc.heading = current_heading.clone();
                        sc.offset += current_offset;
                        chunks.push(sc);
                    }
                } else {
                    chunks.push(TextChunk {
                        heading: current_heading.clone(),
                        offset: current_offset,
                        text,
                    });
                }
            }

            // Extract heading text
            let heading_text = line.trim_start_matches('#').trim().to_string();
            current_heading = if heading_text.is_empty() {
                None
            } else {
                Some(safe_truncate(&heading_text, 200).to_string())
            };
            current_text = String::new();
            current_offset = line_offset;
        } else {
            if !current_text.is_empty() {
                current_text.push('\n');
            }
            current_text.push_str(line);
        }

        line_offset += line.len() + 1; // +1 for newline
    }

    // Flush last chunk
    let text = current_text.trim().to_string();
    if !text.is_empty() {
        if text.len() > max_chars {
            let sub_chunks = chunk_by_window(&text, max_chars, CHUNK_OVERLAP_CHARS);
            for mut sc in sub_chunks {
                sc.heading = current_heading.clone();
                sc.offset += current_offset;
                chunks.push(sc);
            }
        } else {
            chunks.push(TextChunk {
                heading: current_heading.clone(),
                offset: current_offset,
                text,
            });
        }
    }

    chunks
}

fn chunk_by_window(content: &str, max_chars: usize, overlap: usize) -> Vec<TextChunk> {
    let mut chunks = Vec::new();
    let len = content.len();
    let mut start = 0;

    while start < len {
        let mut end = floor_char_boundary(content, std::cmp::min(start + max_chars, len));

        // Try to break at a sentence or paragraph boundary
        if end < len {
            let search_start = floor_char_boundary(content, if end > 100 { end - 100 } else { start });
            let window = &content[search_start..end];
            if let Some(pos) = window.rfind("\n\n") {
                end = search_start + pos;
            } else if let Some(pos) = window.rfind('\n') {
                end = search_start + pos;
            } else if let Some(pos) = window.rfind(". ") {
                end = search_start + pos + 1;
            }
        }

        // Ensure end is on a char boundary and past start
        end = ceil_char_boundary(content, end);
        if end <= start {
            end = ceil_char_boundary(content, std::cmp::min(start + max_chars, len));
        }
        if end > len { end = len; }

        let text = content[start..end].trim().to_string();
        if !text.is_empty() {
            chunks.push(TextChunk {
                heading: None,
                offset: start,
                text,
            });
        }

        if end >= len {
            break;
        }

        // Advance with overlap, aligned to char boundary
        let raw_start = if end > overlap { end - overlap } else { end };
        start = ceil_char_boundary(content, raw_start);
    }

    chunks
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/// Text file extensions to index.
const INDEXABLE_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "json", "yaml", "yml", "csv", "xml", "html", "htm", "rst", "org",
    "toml", "ini", "cfg", "conf", "log", "tex", "adoc",
];

/// Directories to skip during collection.
const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", "__pycache__", ".venv", "dist", "build"];

/// Collect all indexable text files from a knowledge base directory.
fn collect_indexable_files(kb_path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_files_recursive(kb_path, kb_path, &mut files, 0, 10)?;
    Ok(files)
}

fn collect_files_recursive(
    root: &Path,
    dir: &Path,
    files: &mut Vec<PathBuf>,
    depth: usize,
    max_depth: usize,
) -> Result<(), String> {
    if depth > max_depth {
        return Ok(());
    }

    let entries = std::fs::read_dir(dir).map_err(|_| "Failed to read directory".to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs and known non-content dirs
        if file_name.starts_with('.') || SKIP_DIRS.contains(&file_name.as_str()) {
            continue;
        }

        // Skip symlinks
        if entry
            .metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
        {
            continue;
        }

        if path.is_dir() {
            collect_files_recursive(root, &path, files, depth + 1, max_depth)?;
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if INDEXABLE_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                    files.push(path);
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ---------------------------------------------------------------------------
// Index persistence helpers
// ---------------------------------------------------------------------------

fn indexes_dir(kb_path: &Path) -> PathBuf {
    kb_path.join(".moraya").join("indexes")
}

fn ensure_indexes_dir(kb_path: &Path) -> Result<PathBuf, String> {
    let dir = indexes_dir(kb_path);
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                "Cannot create index directory: permission denied".to_string()
            }
            _ => "Cannot create index directory".to_string(),
        })?;
    }
    Ok(dir)
}

fn load_meta(kb_path: &Path) -> Option<IndexMeta> {
    let path = indexes_dir(kb_path).join("meta.json");
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_meta(kb_path: &Path, meta: &IndexMeta) -> Result<(), String> {
    let dir = ensure_indexes_dir(kb_path)?;
    let data =
        serde_json::to_string_pretty(meta).map_err(|_| "Failed to serialize meta".to_string())?;
    std::fs::write(dir.join("meta.json"), data).map_err(|_| "Failed to write meta".to_string())
}

fn save_chunks(kb_path: &Path, chunks: &[ChunkMeta]) -> Result<(), String> {
    let dir = ensure_indexes_dir(kb_path)?;
    let mut lines = String::new();
    for chunk in chunks {
        let line =
            serde_json::to_string(chunk).map_err(|_| "Failed to serialize chunk".to_string())?;
        lines.push_str(&line);
        lines.push('\n');
    }
    std::fs::write(dir.join("chunks.jsonl"), lines)
        .map_err(|_| "Failed to write chunks".to_string())
}

fn load_chunks(kb_path: &Path) -> Result<Vec<ChunkMeta>, String> {
    let path = indexes_dir(kb_path).join("chunks.jsonl");
    let data = std::fs::read_to_string(path).map_err(|_| "No chunks file found".to_string())?;
    let mut chunks = Vec::new();
    for line in data.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let chunk: ChunkMeta =
            serde_json::from_str(line).map_err(|_| "Chunk data corrupted".to_string())?;
        chunks.push(chunk);
    }
    Ok(chunks)
}

fn save_bm25(kb_path: &Path, bm25: &BM25Index) -> Result<(), String> {
    let dir = ensure_indexes_dir(kb_path)?;
    let data = bm25.to_bytes()?;
    std::fs::write(dir.join("bm25.bin"), data).map_err(|_| "Failed to write BM25 index".to_string())
}

fn load_bm25(kb_path: &Path) -> Result<BM25Index, String> {
    let path = indexes_dir(kb_path).join("bm25.bin");
    let data = std::fs::read(path).map_err(|_| "No BM25 index found".to_string())?;
    BM25Index::from_bytes(&data)
}

/// Save embeddings as raw f32 binary (4 bytes per float, concatenated)
fn save_embeddings(kb_path: &Path, embeddings: &[Vec<f32>]) -> Result<(), String> {
    let dir = ensure_indexes_dir(kb_path)?;
    let mut data: Vec<u8> = Vec::with_capacity(embeddings.len() * embeddings.first().map_or(0, |e| e.len()) * 4);
    for emb in embeddings {
        for &f in emb {
            data.extend_from_slice(&f.to_le_bytes());
        }
    }
    std::fs::write(dir.join("vectors.bin"), data)
        .map_err(|_| "Failed to write vectors".to_string())
}

/// Load embeddings from raw f32 binary (used for HNSW rebuild in Phase 4)
#[allow(dead_code)]
fn load_embeddings(kb_path: &Path, count: usize, dim: usize) -> Result<Vec<Vec<f32>>, String> {
    let path = indexes_dir(kb_path).join("vectors.bin");
    let data = std::fs::read(path).map_err(|_| "No vectors file found".to_string())?;
    let expected = count * dim * 4;
    if data.len() < expected {
        return Err("Vectors file corrupted".to_string());
    }
    let mut embeddings = Vec::with_capacity(count);
    for i in 0..count {
        let start = i * dim * 4;
        let mut vec = Vec::with_capacity(dim);
        for j in 0..dim {
            let offset = start + j * 4;
            let bytes: [u8; 4] = data[offset..offset + 4]
                .try_into()
                .map_err(|_| "Vectors file corrupted".to_string())?;
            vec.push(f32::from_le_bytes(bytes));
        }
        embeddings.push(vec);
    }
    Ok(embeddings)
}

/// Build HNSW index from embeddings and dump to disk
fn build_and_save_hnsw(
    kb_path: &Path,
    embeddings: &[Vec<f32>],
) -> Result<(), String> {
    if embeddings.is_empty() {
        return Ok(());
    }
    let _dim = embeddings[0].len();
    let nb_elem = embeddings.len();

    let hnsw = Hnsw::<f32, DistCosine>::new(
        16,               // max_nb_connection
        nb_elem,          // max_elements
        16,               // max_layer
        200,              // ef_construction
        DistCosine,
    );

    // Insert all vectors
    for (id, emb) in embeddings.iter().enumerate() {
        hnsw.insert((emb, id));
    }

    // Dump to disk
    let dir = ensure_indexes_dir(kb_path)?;
    hnsw.file_dump(&dir, "hnsw")
        .map_err(|e| format!("Failed to save HNSW: {}", e))?;

    Ok(())
}

/// Load HNSW index from disk and search
fn search_hnsw(
    kb_path: &Path,
    query: &[f32],
    top_k: usize,
    ef_search: usize,
) -> Result<Vec<(usize, f32)>, String> {
    let dir = indexes_dir(kb_path);
    let graph_path = dir.join("hnsw.hnsw.graph");
    if !graph_path.exists() {
        return Err("No HNSW index found".to_string());
    }

    let mut reloader = HnswIo::new(&dir, "hnsw");
    let hnsw: Hnsw<f32, DistCosine> = reloader
        .load_hnsw::<f32, DistCosine>()
        .map_err(|e| format!("Failed to load HNSW: {}", e))?;

    let neighbours = hnsw.search(query, top_k, ef_search);
    Ok(neighbours
        .iter()
        .map(|n| (n.d_id, n.distance))
        .collect())
}

/// Check if HNSW index files exist on disk
fn has_hnsw_index(kb_path: &Path) -> bool {
    indexes_dir(kb_path).join("hnsw.hnsw.graph").exists()
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

#[allow(dead_code)]
struct LoadedIndex {
    chunks: Vec<ChunkMeta>,
    chunk_texts: Vec<String>,
    meta: IndexMeta,
    bm25: BM25Index,
    has_hnsw: bool,
}

pub struct KBIndexState {
    indexes: Mutex<HashMap<String, LoadedIndex>>,
    indexing: Mutex<HashMap<String, bool>>,
}

impl KBIndexState {
    pub fn new() -> Self {
        Self {
            indexes: Mutex::new(HashMap::new()),
            indexing: Mutex::new(HashMap::new()),
        }
    }
}

// ---------------------------------------------------------------------------
// Embedding API
// ---------------------------------------------------------------------------

/// Call embedding API via the existing ai_proxy HTTP infrastructure.
/// Batches texts (max 20 per request) to minimize API calls.
/// Used in Phase 2 when HNSW vector search is added.
async fn embed_texts_via_api(
    ai_state: &AIProxyState,
    config_id: &str,
    key_prefix: Option<&str>,
    provider: &str,
    model: &str,
    dimensions: u32,
    base_url: Option<&str>,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    // Resolve API key
    ai_state.ensure_secrets_loaded().await;
    let prefix = key_prefix.unwrap_or("ai-key:");
    let cache_key = format!("{}{}", prefix, config_id);
    let api_key = if let Ok(cache) = ai_state.key_cache.lock() {
        cache.get(&cache_key).cloned().unwrap_or_default()
    } else {
        String::new()
    };

    let default_base = default_embedding_base_url(provider);
    let base = base_url.unwrap_or(&default_base);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "Failed to create HTTP client".to_string())?;

    let mut all_embeddings: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    let batch_size = 20;

    for batch_start in (0..texts.len()).step_by(batch_size) {
        let batch_end = std::cmp::min(batch_start + batch_size, texts.len());
        let batch = &texts[batch_start..batch_end];

        let embeddings =
            call_embedding_api(&client, provider, &api_key, base, model, dimensions, batch)
                .await?;

        all_embeddings.extend(embeddings);
    }

    Ok(all_embeddings)
}

fn default_embedding_base_url(provider: &str) -> String {
    match provider {
        "openai" => "https://api.openai.com".to_string(),
        "gemini" => "https://generativelanguage.googleapis.com".to_string(),
        "ollama" => "http://localhost:11434".to_string(),
        "glm" => "https://open.bigmodel.cn/api/paas/v4".to_string(),
        "doubao" => "https://ark.cn-beijing.volces.com/api/v3".to_string(),
        _ => String::new(),
    }
}

async fn call_embedding_api(
    client: &reqwest::Client,
    provider: &str,
    api_key: &str,
    base_url: &str,
    model: &str,
    dimensions: u32,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let base = base_url.trim_end_matches('/');

    match provider {
        "gemini" => call_gemini_embedding(client, api_key, base, model, dimensions, texts).await,
        "ollama" => call_ollama_embedding(client, base, model, texts).await,
        // OpenAI-compatible: openai, glm, doubao, custom, deepseek, etc.
        _ => call_openai_embedding(client, api_key, base, model, dimensions, texts).await,
    }
}

/// Build the embedding endpoint URL.
/// If the base URL already contains a version path (/v1, /v2, /v3, /v4),
/// just append /embeddings. Otherwise prepend /v1.
fn embedding_endpoint(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    // Check for existing version path segment
    let has_version = ["/v1", "/v2", "/v3", "/v4"]
        .iter()
        .any(|v| base.contains(v));
    if has_version {
        format!("{}/embeddings", base)
    } else {
        format!("{}/v1/embeddings", base)
    }
}

async fn call_openai_embedding(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    model: &str,
    dimensions: u32,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let url = embedding_endpoint(base_url);

    let mut body = serde_json::json!({
        "model": model,
        "input": texts,
        "encoding_format": "float",
    });
    // Only include dimensions for models that support it
    if dimensions > 0 {
        body["dimensions"] = serde_json::json!(dimensions);
    }

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string());

    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "Embedding request timed out".to_string()
        } else {
            "Embedding request failed".to_string()
        }
    })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| "Failed to read response".to_string())?;

    if !status.is_success() {
        return Err(format!("Embedding API error ({})", status.as_u16()));
    }

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "Invalid embedding response".to_string())?;

    let data = json["data"]
        .as_array()
        .ok_or("Missing 'data' in response")?;

    let mut embeddings: Vec<(usize, Vec<f32>)> = Vec::with_capacity(data.len());
    for item in data {
        let index = item["index"].as_u64().unwrap_or(0) as usize;
        let embedding = item["embedding"]
            .as_array()
            .ok_or("Missing 'embedding'")?
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0) as f32)
            .collect();
        embeddings.push((index, embedding));
    }
    embeddings.sort_by_key(|(i, _)| *i);
    Ok(embeddings.into_iter().map(|(_, e)| e).collect())
}

async fn call_gemini_embedding(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    model: &str,
    dimensions: u32,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    // Gemini batchEmbedContents
    let model_path = if model.starts_with("models/") {
        model.to_string()
    } else {
        format!("models/{}", model)
    };
    let url = format!(
        "{}/v1beta/{}:batchEmbedContents?key={}",
        base_url, model_path, api_key
    );

    let requests: Vec<serde_json::Value> = texts
        .iter()
        .map(|text| {
            let mut req = serde_json::json!({
                "model": &model_path,
                "content": { "parts": [{ "text": text }] },
            });
            if dimensions > 0 {
                req["outputDimensionality"] = serde_json::json!(dimensions);
            }
            req
        })
        .collect();

    let body = serde_json::json!({ "requests": requests });

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| "Gemini embedding request failed".to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| "Failed to read response".to_string())?;

    if !status.is_success() {
        return Err(format!("Gemini embedding API error ({})", status.as_u16()));
    }

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "Invalid Gemini response".to_string())?;

    let embeddings_arr = json["embeddings"]
        .as_array()
        .ok_or("Missing 'embeddings' in Gemini response")?;

    let embeddings: Vec<Vec<f32>> = embeddings_arr
        .iter()
        .map(|item| {
            item["values"]
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                .collect()
        })
        .collect();

    Ok(embeddings)
}

async fn call_ollama_embedding(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let url = format!("{}/api/embed", base_url);

    let body = serde_json::json!({
        "model": model,
        "input": texts,
    });

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| "Ollama embedding request failed".to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| "Failed to read response".to_string())?;

    if !status.is_success() {
        return Err(format!("Ollama embedding API error ({})", status.as_u16()));
    }

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "Invalid Ollama response".to_string())?;

    let embeddings: Vec<Vec<f32>> = json["embeddings"]
        .as_array()
        .ok_or("Missing 'embeddings' in Ollama response")?
        .iter()
        .map(|arr| {
            arr.as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                .collect()
        })
        .collect();

    Ok(embeddings)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Index all (or specified) text files in a knowledge base directory.
#[tauri::command]
pub async fn kb_index_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, KBIndexState>,
    ai_state: tauri::State<'_, AIProxyState>,
    kb_path: String,
    config_id: String,
    key_prefix: Option<String>,
    provider: String,
    model: String,
    dimensions: u32,
    base_url: Option<String>,
    file_paths: Option<Vec<String>>,
) -> Result<IndexStatus, String> {
    let kb = validate_path(&kb_path)?;

    // Check concurrent indexing
    {
        let mut indexing = state.indexing.lock().map_err(|_| "Lock error".to_string())?;
        if indexing.get(&kb_path).copied().unwrap_or(false) {
            return Err("Indexing already in progress".to_string());
        }
        indexing.insert(kb_path.clone(), true);
    }

    let result = do_index_files(
        &app,
        &ai_state,
        &kb,
        &kb_path,
        &config_id,
        key_prefix.as_deref(),
        &provider,
        &model,
        dimensions,
        base_url.as_deref(),
        file_paths.as_deref(),
    )
    .await;

    // Clear indexing flag
    {
        if let Ok(mut indexing) = state.indexing.lock() {
            indexing.remove(&kb_path);
        }
    }

    // On success, cache the loaded index
    if let Ok(ref status) = result {
        if status.indexed {
            if let Ok(chunks) = load_chunks(&kb) {
                if let Ok(bm25) = load_bm25(&kb) {
                    if let Some(meta) = load_meta(&kb) {
                        // Read chunk texts for search
                        let chunk_texts = chunks
                            .iter()
                            .map(|c| c.preview.clone())
                            .collect();
                        let hnsw_exists = has_hnsw_index(&kb);
                        if let Ok(mut indexes) = state.indexes.lock() {
                            indexes.insert(
                                kb_path,
                                LoadedIndex {
                                    chunks,
                                    chunk_texts,
                                    meta,
                                    bm25,
                                    has_hnsw: hnsw_exists,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    result
}

async fn do_index_files(
    app: &tauri::AppHandle,
    ai_state: &AIProxyState,
    kb: &Path,
    _kb_path_str: &str,
    config_id: &str,
    key_prefix: Option<&str>,
    provider: &str,
    model: &str,
    dimensions: u32,
    base_url: Option<&str>,
    file_paths: Option<&[String]>,
) -> Result<IndexStatus, String> {
    // Load existing meta for incremental indexing
    let existing_meta = load_meta(kb);

    // Phase 1: Scan files
    let _ = app.emit("kb-index-progress", IndexProgress {
        phase: "scanning".to_string(),
        current: 0,
        total: 0,
        file_name: String::new(),
    });

    let all_files = if let Some(paths) = file_paths {
        paths
            .iter()
            .filter_map(|p| validate_path(p).ok())
            .collect()
    } else {
        collect_indexable_files(kb)?
    };

    let total_files = all_files.len() as u32;
    if total_files == 0 {
        return Ok(IndexStatus {
            indexed: false,
            chunk_count: 0,
            file_count: 0,
            model_id: model.to_string(),
            dimensions,
            last_updated: None,
            stale_files: Vec::new(),
        });
    }

    // Phase 2: Chunk files (with hash-based skip)
    let mut all_chunks: Vec<ChunkMeta> = Vec::new();
    let mut all_texts: Vec<String> = Vec::new();
    let mut file_hashes: HashMap<String, String> = HashMap::new();
    let mut chunk_id = 0usize;

    // Run chunking in spawn_blocking to avoid async runtime issues
    let kb_owned = kb.to_path_buf();
    let model_owned = model.to_string();
    let existing_meta_clone = existing_meta;

    struct ChunkResult {
        chunks: Vec<ChunkMeta>,
        texts: Vec<String>,
        file_hashes: HashMap<String, String>,
    }

    let chunk_result = {
        let app_clone = app.clone();
        let total = total_files;
        let dims = dimensions;
        tokio::task::spawn_blocking(move || {
            // Load existing chunks for incremental indexing (carry over unchanged files)
            let existing_chunks = load_chunks(&kb_owned).unwrap_or_default();

            let mut all_chunks: Vec<ChunkMeta> = Vec::new();
            let mut all_texts: Vec<String> = Vec::new();
            let mut file_hashes: HashMap<String, String> = HashMap::new();
            let mut chunk_id = 0usize;

            for (i, file_path) in all_files.iter().enumerate() {
                let rel_path = file_path
                    .strip_prefix(&kb_owned)
                    .unwrap_or(file_path)
                    .to_string_lossy()
                    .to_string();

                let file_name = file_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let _ = app_clone.emit("kb-index-progress", IndexProgress {
                    phase: "chunking".to_string(),
                    current: i as u32 + 1,
                    total,
                    file_name: file_name.clone(),
                });

                let content = match std::fs::read_to_string(file_path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let content_hash = hash_content(&content);

                // Skip if unchanged and model/dimensions match — carry over existing chunks
                if let Some(ref existing) = existing_meta_clone {
                    if existing.model_id == model_owned
                        && existing.dimensions == dims
                        && existing.file_hashes.get(&rel_path) == Some(&content_hash)
                    {
                        file_hashes.insert(rel_path.clone(), content_hash);
                        // Carry over existing chunks for this file
                        for ec in &existing_chunks {
                            if ec.file_path == rel_path {
                                let mut carried = ec.clone();
                                carried.id = chunk_id;
                                all_texts.push(carried.preview.clone());
                                all_chunks.push(carried);
                                chunk_id += 1;
                            }
                        }
                        continue;
                    }
                }

                file_hashes.insert(rel_path.clone(), content_hash);

                let doc_chunks = chunk_document(&content, &rel_path);
                for tc in doc_chunks {
                    let preview = safe_truncate(&tc.text, 200).to_string();

                    all_chunks.push(ChunkMeta {
                        id: chunk_id,
                        file_path: rel_path.clone(),
                        heading: tc.heading,
                        offset: tc.offset,
                        length: tc.text.len(),
                        preview,
                    });
                    all_texts.push(tc.text);
                    chunk_id += 1;
                }
            }

            ChunkResult { chunks: all_chunks, texts: all_texts, file_hashes }
        })
        .await
        .map_err(|e| format!("Chunking task failed: {}", e))?
    };

    let all_chunks = chunk_result.chunks;
    let all_texts = chunk_result.texts;
    let file_hashes = chunk_result.file_hashes;

    // Phase 3: Embed texts via API (per-batch progress)
    let mut all_embeddings: Vec<Vec<f32>> = Vec::new();
    if !all_texts.is_empty() {
        let total_texts = all_texts.len();
        let batch_size = 20usize;
        let mut embedding_failed = false;

        // Resolve API key and build client once
        ai_state.ensure_secrets_loaded().await;
        let prefix = key_prefix.unwrap_or("ai-key:");
        let cache_key = format!("{}{}", prefix, config_id);
        let api_key = if let Ok(cache) = ai_state.key_cache.lock() {
            cache.get(&cache_key).cloned().unwrap_or_default()
        } else {
            String::new()
        };
        let default_base = default_embedding_base_url(provider);
        let base = base_url.unwrap_or(&default_base);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap();

        for batch_start in (0..total_texts).step_by(batch_size) {
            let batch_end = std::cmp::min(batch_start + batch_size, total_texts);
            let batch = &all_texts[batch_start..batch_end];

            let _ = app.emit("kb-index-progress", IndexProgress {
                phase: "embedding".to_string(),
                current: batch_end as u32,
                total: total_texts as u32,
                file_name: String::new(),
            });
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;

            match call_embedding_api(&client, provider, &api_key, base, model, dimensions, batch)
                .await
            {
                Ok(embeddings) => {
                    all_embeddings.extend(embeddings);
                }
                Err(e) => {
                    eprintln!("[KB] Embedding batch failed: {}", e);
                    let _ = app.emit("kb-index-progress", IndexProgress {
                        phase: "error".to_string(),
                        current: 0,
                        total: 0,
                        file_name: e.clone(),
                    });
                    embedding_failed = true;
                    break;
                }
            }
        }

        if embedding_failed {
            eprintln!("[KB] Falling back to BM25-only index");
            all_embeddings.clear();
        }
    }

    // Phase 4: Build BM25 + HNSW indexes
    let _ = app.emit("kb-index-progress", IndexProgress {
        phase: "indexing".to_string(),
        current: 0,
        total: 1,
        file_name: String::new(),
    });

    let bm25 = BM25Index::build(&all_texts);

    // Build HNSW if embeddings are available
    let has_vectors = all_embeddings.len() == all_chunks.len() && !all_embeddings.is_empty();
    if has_vectors {
        save_embeddings(kb, &all_embeddings)?;
        build_and_save_hnsw(kb, &all_embeddings)?;
    }

    // Phase 5: Persist
    let now = chrono::Utc::now().to_rfc3339();
    let file_count = file_hashes.len();

    let meta = IndexMeta {
        version: 1,
        model_id: model.to_string(),
        dimensions,
        chunk_count: all_chunks.len(),
        file_hashes,
        last_updated: now.clone(),
        embedding_source: format!("api:{}", provider),
    };

    save_meta(kb, &meta)?;
    save_chunks(kb, &all_chunks)?;
    save_bm25(kb, &bm25)?;

    let _ = app.emit("kb-index-progress", IndexProgress {
        phase: "done".to_string(),
        current: 1,
        total: 1,
        file_name: String::new(),
    });

    Ok(IndexStatus {
        indexed: true,
        chunk_count: all_chunks.len(),
        file_count,
        model_id: model.to_string(),
        dimensions,
        last_updated: Some(now),
        stale_files: Vec::new(),
    })
}

/// Search the knowledge base using hybrid vector + BM25 search with RRF ranking.
#[tauri::command]
pub async fn kb_search(
    state: tauri::State<'_, KBIndexState>,
    ai_state: tauri::State<'_, AIProxyState>,
    kb_path: String,
    query: String,
    config_id: String,
    key_prefix: Option<String>,
    provider: String,
    model: String,
    dimensions: u32,
    base_url: Option<String>,
    top_k: Option<usize>,
    mode: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let kb = validate_path(&kb_path)?;
    let k = top_k.unwrap_or(10);
    let search_mode = mode.as_deref().unwrap_or("hybrid");

    // Load chunks and BM25 (from cache or disk)
    let chunks = load_chunks(&kb)?;
    let bm25 = load_bm25(&kb)?;
    let hnsw_available = has_hnsw_index(&kb);

    // BM25 search
    let bm25_results = if search_mode != "vector" {
        bm25.search(&query, k * 2)
    } else {
        Vec::new()
    };

    // Vector search (if HNSW available and mode allows)
    let vector_results = if hnsw_available && search_mode != "bm25" {
        // Embed the query
        match embed_texts_via_api(
            &ai_state,
            &config_id,
            key_prefix.as_deref(),
            &provider,
            &model,
            dimensions,
            base_url.as_deref(),
            &[query.clone()],
        )
        .await
        {
            Ok(embeddings) if !embeddings.is_empty() => {
                match search_hnsw(&kb, &embeddings[0], k * 2, 50) {
                    Ok(results) => results,
                    Err(_) => Vec::new(),
                }
            }
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };

    // Hybrid ranking using Reciprocal Rank Fusion (RRF)
    let search_results = if search_mode == "hybrid" && !vector_results.is_empty() && !bm25_results.is_empty() {
        rrf_merge(&chunks, &kb, &bm25_results, &vector_results, k, &query)
    } else if !vector_results.is_empty() {
        // Vector-only results
        vector_results
            .into_iter()
            .take(k)
            .filter_map(|(chunk_id, distance)| {
                chunks.get(chunk_id).map(|chunk| SearchResult {
                    file_path: kb.join(&chunk.file_path).to_string_lossy().to_string(),
                    heading: chunk.heading.clone(),
                    preview: keyword_snippet(&kb, chunk, &query),
                    score: 1.0 - distance.min(1.0),
                    offset: chunk.offset,
                    source: "vector".to_string(),
                })
            })
            .collect()
    } else {
        // BM25-only results
        bm25_results
            .into_iter()
            .take(k)
            .filter_map(|(chunk_id, score)| {
                chunks.get(chunk_id).map(|chunk| SearchResult {
                    file_path: kb.join(&chunk.file_path).to_string_lossy().to_string(),
                    heading: chunk.heading.clone(),
                    preview: keyword_snippet(&kb, chunk, &query),
                    score,
                    offset: chunk.offset,
                    source: "bm25".to_string(),
                })
            })
            .collect()
    };

    // Cache index for subsequent searches
    if let Some(meta) = load_meta(&kb) {
        let chunk_texts = chunks.iter().map(|c| c.preview.clone()).collect();
        if let Ok(mut indexes) = state.indexes.lock() {
            indexes.insert(
                kb_path,
                LoadedIndex {
                    chunks,
                    chunk_texts,
                    meta,
                    bm25,
                    has_hnsw: hnsw_available,
                },
            );
        }
    }

    Ok(search_results)
}

/// Reciprocal Rank Fusion: merge BM25 and vector results.
/// RRF_score(d) = Σ 1/(k + rank) with k=60
/// Generate a keyword-aware snippet from the source file.
/// Reads the chunk text and returns ~200 chars centered on the first keyword match.
fn keyword_snippet(kb: &Path, chunk: &ChunkMeta, query: &str) -> String {
    let max_snippet = 200;
    // Try to read the actual chunk text from the source file
    let full_text = match std::fs::read_to_string(kb.join(&chunk.file_path)) {
        Ok(content) => {
            let start = chunk.offset.min(content.len());
            let end = (chunk.offset + chunk.length).min(content.len());
            let start = ceil_char_boundary(&content, start);
            let end = floor_char_boundary(&content, end);
            if start < end {
                content[start..end].to_string()
            } else {
                return chunk.preview.clone();
            }
        }
        Err(_) => return chunk.preview.clone(),
    };

    // Find the first keyword occurrence.
    // Strategy: try full query first, then whitespace-split words, then individual CJK chars.
    let lower = full_text.to_lowercase();
    let query_lower = query.to_lowercase();

    let mut search_terms: Vec<String> = Vec::new();
    // 1. Full query as a single search term
    if query_lower.len() >= 2 {
        search_terms.push(query_lower.clone());
    }
    // 2. Whitespace-split words
    for word in query_lower.split_whitespace() {
        if word.len() >= 2 && !search_terms.contains(&word.to_string()) {
            search_terms.push(word.to_string());
        }
    }
    // 3. Individual CJK characters (since BM25 tokenizes each CJK char separately)
    for ch in query_lower.chars() {
        if is_cjk(ch) {
            let s = ch.to_string();
            if !search_terms.contains(&s) {
                search_terms.push(s);
            }
        }
    }

    let mut best_pos: Option<usize> = None;
    for term in &search_terms {
        if let Some(pos) = lower.find(term.as_str()) {
            best_pos = Some(pos);
            break; // Use the first match from highest-priority term
        }
    }

    match best_pos {
        Some(pos) => {
            // Center a window around the keyword
            let half = max_snippet / 2;
            let raw_start = if pos > half { pos - half } else { 0 };
            let raw_end = (raw_start + max_snippet).min(full_text.len());
            let start = ceil_char_boundary(&full_text, raw_start);
            let end = floor_char_boundary(&full_text, raw_end);
            if start < end {
                let snippet = full_text[start..end].trim();
                if start > 0 {
                    format!("...{}", snippet)
                } else {
                    snippet.to_string()
                }
            } else {
                safe_truncate(&full_text, max_snippet).to_string()
            }
        }
        None => {
            // No keyword found — use first N chars
            safe_truncate(&full_text, max_snippet).to_string()
        }
    }
}

fn rrf_merge(
    chunks: &[ChunkMeta],
    kb: &Path,
    bm25_results: &[(usize, f32)],
    vector_results: &[(usize, f32)],
    top_k: usize,
    query: &str,
) -> Vec<SearchResult> {
    const RRF_K: f32 = 60.0;
    let mut scores: HashMap<usize, (f32, &str)> = HashMap::new();

    // BM25 contributions
    for (rank, &(chunk_id, _)) in bm25_results.iter().enumerate() {
        let rrf = 1.0 / (RRF_K + rank as f32 + 1.0);
        scores
            .entry(chunk_id)
            .and_modify(|(s, _)| *s += rrf)
            .or_insert((rrf, "bm25"));
    }

    // Vector contributions
    for (rank, &(chunk_id, _)) in vector_results.iter().enumerate() {
        let rrf = 1.0 / (RRF_K + rank as f32 + 1.0);
        scores
            .entry(chunk_id)
            .and_modify(|(s, src)| {
                *s += rrf;
                *src = "hybrid";
            })
            .or_insert((rrf, "vector"));
    }

    let mut ranked: Vec<(usize, f32, &str)> = scores
        .into_iter()
        .map(|(id, (score, src))| (id, score, src))
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(top_k);

    ranked
        .into_iter()
        .filter_map(|(chunk_id, score, source)| {
            chunks.get(chunk_id).map(|chunk| SearchResult {
                file_path: kb.join(&chunk.file_path).to_string_lossy().to_string(),
                heading: chunk.heading.clone(),
                preview: keyword_snippet(kb, chunk, query),
                score,
                offset: chunk.offset,
                source: source.to_string(),
            })
        })
        .collect()
}

/// Get the current index status for a knowledge base.
#[tauri::command]
pub fn kb_get_index_status(
    _state: tauri::State<'_, KBIndexState>,
    kb_path: String,
) -> Result<IndexStatus, String> {
    let kb = validate_path(&kb_path)?;

    let meta = match load_meta(&kb) {
        Some(m) => m,
        None => {
            return Ok(IndexStatus {
                indexed: false,
                chunk_count: 0,
                file_count: 0,
                model_id: String::new(),
                dimensions: 0,
                last_updated: None,
                stale_files: Vec::new(),
            })
        }
    };

    // Check for stale files
    let files = collect_indexable_files(&kb).unwrap_or_default();
    let mut stale_files = Vec::new();

    for file_path in &files {
        let rel_path = file_path
            .strip_prefix(&kb)
            .unwrap_or(file_path)
            .to_string_lossy()
            .to_string();

        if let Ok(content) = std::fs::read_to_string(file_path) {
            let current_hash = hash_content(&content);
            match meta.file_hashes.get(&rel_path) {
                Some(stored_hash) if stored_hash == &current_hash => {}
                _ => stale_files.push(rel_path),
            }
        }
    }

    // Also check for deleted files (in meta but not on disk)
    for rel_path in meta.file_hashes.keys() {
        let abs_path = kb.join(rel_path);
        if !abs_path.exists() {
            if !stale_files.contains(rel_path) {
                stale_files.push(rel_path.clone());
            }
        }
    }

    Ok(IndexStatus {
        indexed: true,
        chunk_count: meta.chunk_count,
        file_count: meta.file_hashes.len(),
        model_id: meta.model_id,
        dimensions: meta.dimensions,
        last_updated: Some(meta.last_updated),
        stale_files,
    })
}

/// Delete the index for a knowledge base.
#[tauri::command]
pub fn kb_delete_index(
    state: tauri::State<'_, KBIndexState>,
    kb_path: String,
) -> Result<(), String> {
    let kb = validate_path(&kb_path)?;
    let dir = indexes_dir(&kb);

    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|_| "Failed to delete index".to_string())?;
    }

    // Clear cache
    if let Ok(mut indexes) = state.indexes.lock() {
        indexes.remove(&kb_path);
    }

    Ok(())
}

/// Index a single file (for auto-index on save).
#[tauri::command]
pub async fn kb_index_single_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, KBIndexState>,
    ai_state: tauri::State<'_, AIProxyState>,
    kb_path: String,
    file_path: String,
    config_id: String,
    key_prefix: Option<String>,
    provider: String,
    model: String,
    dimensions: u32,
    base_url: Option<String>,
) -> Result<(), String> {
    let kb = validate_path(&kb_path)?;
    let file = validate_path(&file_path)?;

    let rel_path = file
        .strip_prefix(&kb)
        .map_err(|_| "File is not within knowledge base".to_string())?
        .to_string_lossy()
        .to_string();

    let file_name = file
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let _ = app.emit("kb-index-progress", IndexProgress {
        phase: "indexing".to_string(),
        current: 0,
        total: 1,
        file_name: file_name.clone(),
    });

    // Read current content and hash
    let content =
        std::fs::read_to_string(&file).map_err(|_| "Failed to read file".to_string())?;
    let content_hash = hash_content(&content);

    // Load existing meta
    let mut meta = load_meta(&kb).ok_or("No existing index found. Run full index first.")?;

    // Check if file actually changed
    if meta.file_hashes.get(&rel_path) == Some(&content_hash) {
        let _ = app.emit("kb-index-progress", IndexProgress {
            phase: "done".to_string(),
            current: 1,
            total: 1,
            file_name: file_name.clone(),
        });
        return Ok(()); // No change
    }

    // Load existing chunks, remove old ones for this file
    let mut chunks = load_chunks(&kb).unwrap_or_default();
    chunks.retain(|c| c.file_path != rel_path);

    // Re-chunk the file
    let doc_chunks = chunk_document(&content, &rel_path);
    let mut new_chunk_id = chunks.iter().map(|c| c.id).max().unwrap_or(0) + 1;
    let mut all_texts: Vec<String> = chunks.iter().map(|c| c.preview.clone()).collect();

    for tc in doc_chunks {
        let preview = safe_truncate(&tc.text, 200).to_string();

        chunks.push(ChunkMeta {
            id: new_chunk_id,
            file_path: rel_path.clone(),
            heading: tc.heading,
            offset: tc.offset,
            length: tc.text.len(),
            preview,
        });
        all_texts.push(tc.text);
        new_chunk_id += 1;
    }

    // Rebuild BM25 index
    let bm25 = BM25Index::build(&all_texts);

    // Rebuild HNSW if vectors were previously available
    if has_hnsw_index(&kb) {
        // Re-embed all chunk texts (full rebuild since hnsw_rs is append-only)
        if let Ok(embeddings) = embed_texts_via_api(
            &ai_state,
            &config_id,
            key_prefix.as_deref(),
            &provider,
            &model,
            dimensions,
            base_url.as_deref(),
            &all_texts,
        )
        .await
        {
            if embeddings.len() == all_texts.len() {
                let _ = save_embeddings(&kb, &embeddings);
                let _ = build_and_save_hnsw(&kb, &embeddings);
            }
        }
    }

    // Update meta
    meta.file_hashes.insert(rel_path, content_hash);
    meta.chunk_count = chunks.len();
    meta.last_updated = chrono::Utc::now().to_rfc3339();

    // Persist
    save_meta(&kb, &meta)?;
    save_chunks(&kb, &chunks)?;
    save_bm25(&kb, &bm25)?;

    // Invalidate cache
    if let Ok(mut indexes) = state.indexes.lock() {
        indexes.remove(&kb_path);
    }

    let _ = app.emit("kb-index-progress", IndexProgress {
        phase: "done".to_string(),
        current: 1,
        total: 1,
        file_name: file_name,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_english() {
        let tokens = tokenize("Hello, World! This is a test.");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
        assert!(tokens.contains(&"this".to_string()));
        assert!(tokens.contains(&"test".to_string()));
        // Single char tokens should be filtered
        assert!(!tokens.contains(&"a".to_string()));
    }

    #[test]
    fn test_tokenize_cjk() {
        let tokens = tokenize("你好世界 Hello");
        assert!(tokens.contains(&"你".to_string()));
        assert!(tokens.contains(&"好".to_string()));
        assert!(tokens.contains(&"世".to_string()));
        assert!(tokens.contains(&"界".to_string()));
        assert!(tokens.contains(&"hello".to_string()));
    }

    #[test]
    fn test_bm25_basic() {
        let texts = vec![
            "The quick brown fox jumps over the lazy dog".to_string(),
            "A lazy cat sleeps on the mat".to_string(),
            "The fox is quick and clever".to_string(),
        ];
        let bm25 = BM25Index::build(&texts);

        let results = bm25.search("quick fox", 3);
        assert!(!results.is_empty());
        // Doc 0 and doc 2 should rank higher (both contain "quick" and/or "fox")
        let top_id = results[0].0;
        assert!(top_id == 0 || top_id == 2);
    }

    #[test]
    fn test_bm25_serialization() {
        let texts = vec!["Hello world".to_string(), "Goodbye world".to_string()];
        let bm25 = BM25Index::build(&texts);
        let bytes = bm25.to_bytes().unwrap();
        let restored = BM25Index::from_bytes(&bytes).unwrap();
        assert_eq!(restored.total_docs, 2);

        let results = restored.search("hello", 1);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, 0);
    }

    #[test]
    fn test_strip_frontmatter() {
        let content = "---\ntitle: Test\ndate: 2024-01-01\n---\n\n# Hello\n\nContent here.";
        let stripped = strip_frontmatter(content);
        assert!(stripped.starts_with("# Hello"));
        assert!(!stripped.contains("title: Test"));
    }

    #[test]
    fn test_strip_frontmatter_none() {
        let content = "# No frontmatter\n\nJust content.";
        let stripped = strip_frontmatter(content);
        assert_eq!(stripped, content);
    }

    #[test]
    fn test_chunk_by_headings() {
        let content = "# Introduction\n\nSome intro text.\n\n## Details\n\nDetail content here.\n\n## Conclusion\n\nFinal words.";
        let chunks = chunk_by_headings(content, MAX_CHUNK_CHARS);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].heading, Some("Introduction".to_string()));
        assert_eq!(chunks[1].heading, Some("Details".to_string()));
        assert_eq!(chunks[2].heading, Some("Conclusion".to_string()));
    }

    #[test]
    fn test_chunk_by_window() {
        let content = "A ".repeat(500); // ~1000 chars
        let chunks = chunk_by_window(&content, 400, 50);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn test_chunk_cjk_no_panic() {
        // Chinese text: each char is 3 bytes. ~2100 bytes > MAX_CHUNK_CHARS.
        let content = "这是一段测试内容，用于验证中文分块不会在多字节字符中间截断。".repeat(50);
        let chunks = chunk_document(&content, "test.md");
        assert!(!chunks.is_empty());
        // Verify all chunk texts are valid UTF-8 (would have panicked if slicing was wrong)
        for c in &chunks {
            assert!(c.text.is_char_boundary(c.text.len()));
            // Verify safe_truncate works on this text
            let _ = safe_truncate(&c.text, 200);
        }
    }

    #[test]
    fn test_safe_truncate_cjk() {
        let s = "你好世界Hello"; // 你(3) 好(3) 世(3) 界(3) H(1) e(1) l(1) l(1) o(1) = 16 bytes
        assert_eq!(safe_truncate(s, 100), s); // no truncation
        assert_eq!(safe_truncate(s, 6), "你好"); // exactly 6 bytes = 2 CJK chars
        assert_eq!(safe_truncate(s, 7), "你好"); // 7 is inside '世', floor to 6
        assert_eq!(safe_truncate(s, 3), "你");
        assert_eq!(safe_truncate(s, 1), ""); // 1 is inside '你', floor to 0
    }

    #[test]
    fn test_chunk_document_no_headings() {
        let content = "No headings here.\nJust plain text.\nMultiple lines.";
        let chunks = chunk_document(content, "test.txt");
        assert!(!chunks.is_empty());
        assert!(chunks[0].heading.is_none());
    }

    #[test]
    fn test_hash_content() {
        let hash1 = hash_content("hello");
        let hash2 = hash_content("hello");
        let hash3 = hash_content("world");
        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }

    #[test]
    fn test_embedding_endpoint() {
        // OpenAI: no version in base → prepend /v1
        assert_eq!(
            embedding_endpoint("https://api.openai.com"),
            "https://api.openai.com/v1/embeddings"
        );
        // Doubao: has /v3 → just append /embeddings
        assert_eq!(
            embedding_endpoint("https://ark.cn-beijing.volces.com/api/v3"),
            "https://ark.cn-beijing.volces.com/api/v3/embeddings"
        );
        // GLM: has /v4 → just append /embeddings
        assert_eq!(
            embedding_endpoint("https://open.bigmodel.cn/api/paas/v4"),
            "https://open.bigmodel.cn/api/paas/v4/embeddings"
        );
        // OpenAI with /v1 already in base
        assert_eq!(
            embedding_endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/embeddings"
        );
        // Trailing slash
        assert_eq!(
            embedding_endpoint("https://ark.cn-beijing.volces.com/api/v3/"),
            "https://ark.cn-beijing.volces.com/api/v3/embeddings"
        );
    }
}
