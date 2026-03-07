//! Real-time speech transcription WebSocket proxy (v0.15.0)
//!
//! Architecture:
//!   Frontend AudioWorklet (PCM 16kHz/16-bit)
//!     → speech_proxy_send_audio (Tauri IPC binary)
//!     → tokio mpsc → WebSocket Binary frame → STT provider
//!     → JSON response → parse → Tauri Channel → TranscriptionPanel
//!
//! Security: API keys are resolved from the OS Keychain via AIProxyState.
//! The frontend passes a config_id; Rust looks up the actual secret.
//! API keys never transit the network from the frontend.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use super::macos_system_audio::NativeSystemAudioCapture;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

// ── Session counter ──────────────────────────────────────────────────────────

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
const PCM_MIX_CHUNK_SAMPLES: usize = 4_000;
const PCM_MIX_INTERVAL_MS: u64 = 250;

fn new_session_id() -> String {
    let count = SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("speech-{}-{}", ts, count)
}

// ── Shared state ─────────────────────────────────────────────────────────────

struct SpeechSession {
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_tx: Option<oneshot::Sender<()>>,
    native_system_capture: Option<NativeSystemAudioCapture>,
}

pub struct SpeechProxyState {
    sessions: Mutex<HashMap<String, SpeechSession>>,
}

impl SpeechProxyState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

fn append_pcm16_chunk(buffer: &mut VecDeque<i16>, chunk: &[u8]) {
    for pair in chunk.chunks_exact(2) {
        buffer.push_back(i16::from_le_bytes([pair[0], pair[1]]));
    }
}

fn mix_pcm16_chunk(
    mic_buffer: &mut VecDeque<i16>,
    system_buffer: &mut VecDeque<i16>,
    sample_count: usize,
) -> Option<Vec<u8>> {
    if mic_buffer.is_empty() && system_buffer.is_empty() {
        return None;
    }

    let mut out = Vec::with_capacity(sample_count * 2);
    for _ in 0..sample_count {
        let mic = mic_buffer.pop_front().unwrap_or(0) as i32;
        let system = system_buffer.pop_front().unwrap_or(0) as i32;
        let mixed = match (mic, system) {
            (0, 0) => 0,
            (0, s) => s,
            (m, 0) => m,
            (m, s) => ((m + s) / 2).clamp(i16::MIN as i32, i16::MAX as i32),
        } as i16;
        out.extend_from_slice(&mixed.to_le_bytes());
    }
    Some(out)
}

fn spawn_pcm_mixer(
    mut mic_rx: mpsc::Receiver<Vec<u8>>,
    mut system_rx: mpsc::Receiver<Vec<u8>>,
    mixed_tx: mpsc::Sender<Vec<u8>>,
) {
    tokio::spawn(async move {
        let mut mic_buffer = VecDeque::<i16>::new();
        let mut system_buffer = VecDeque::<i16>::new();
        let mut mic_open = true;
        let mut system_open = true;
        let mut tick = tokio::time::interval(Duration::from_millis(PCM_MIX_INTERVAL_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                chunk = mic_rx.recv(), if mic_open => {
                    match chunk {
                        Some(bytes) => append_pcm16_chunk(&mut mic_buffer, &bytes),
                        None => mic_open = false,
                    }
                }
                chunk = system_rx.recv(), if system_open => {
                    match chunk {
                        Some(bytes) => append_pcm16_chunk(&mut system_buffer, &bytes),
                        None => system_open = false,
                    }
                }
                _ = tick.tick() => {
                    if let Some(chunk) = mix_pcm16_chunk(
                        &mut mic_buffer,
                        &mut system_buffer,
                        PCM_MIX_CHUNK_SAMPLES,
                    ) {
                        if mixed_tx.send(chunk).await.is_err() {
                            break;
                        }
                    } else if !mic_open && !system_open {
                        break;
                    }
                }
            }

            if !mic_open && !system_open && mic_buffer.is_empty() && system_buffer.is_empty() {
                break;
            }
        }
    });
}

// ── Event types (sent to frontend via Tauri Channel) ─────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSegmentData {
    pub speaker_id: String,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub confidence: f64,
    pub is_final: bool,
    /// True only when the speaker has finished the current utterance (VAD endpoint).
    /// Deepgram: maps to the `speech_final` field in the JSON response.
    /// Other providers: set equal to `is_final` (they only emit utterance-boundary results).
    pub speech_final: bool,
}

/// All events share the same `session_id` and carry a discriminant `type`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SpeechEvent {
    Connected {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Transcript {
        #[serde(rename = "sessionId")]
        session_id: String,
        segment: SpeechSegmentData,
    },
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        error: String,
    },
    #[allow(dead_code)]
    Disconnected {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

// ── Deepgram JSON parsing ─────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct DgWord {
    speaker: Option<u32>,
    _start: Option<f64>,
    _end: Option<f64>,
    _confidence: Option<f64>,
}

#[derive(Deserialize, Debug)]
struct DgAlternative {
    transcript: Option<String>,
    confidence: Option<f64>,
    words: Option<Vec<DgWord>>,
}

#[derive(Deserialize, Debug)]
struct DgChannel {
    alternatives: Option<Vec<DgAlternative>>,
}

#[derive(Deserialize, Debug)]
struct DgResult {
    #[serde(rename = "type")]
    result_type: Option<String>,
    channel: Option<DgChannel>,
    start: Option<f64>,
    duration: Option<f64>,
    is_final: Option<bool>,
    speech_final: Option<bool>,
}

fn parse_deepgram(session_id: &str, text: &str) -> Option<SpeechEvent> {
    let result: DgResult = serde_json::from_str(text).ok()?;
    if result.result_type.as_deref() != Some("Results") {
        return None;
    }

    let is_final = result.is_final.unwrap_or(false);
    // `speech_final` = true only when Deepgram's VAD endpoint fires (speaker paused).
    // `is_final` = true means the current chunk is stable but more words may follow.
    // Using speech_final as the utterance-complete signal avoids mid-sentence line breaks.
    let speech_final = result.speech_final.unwrap_or(false);

    let channel = result.channel?;
    let alt = channel.alternatives?.into_iter().next()?;
    let transcript = alt.transcript.unwrap_or_default().trim().to_string();
    if transcript.is_empty() {
        return None;
    }

    // Extract majority speaker from words (most frequently occurring)
    let speaker_id = {
        let words = alt.words.as_deref().unwrap_or(&[]);
        let mut counts: HashMap<u32, usize> = HashMap::new();
        for w in words {
            if let Some(s) = w.speaker {
                *counts.entry(s).or_insert(0) += 1;
            }
        }
        counts
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(s, _)| format!("SPEAKER_{}", s))
            .unwrap_or_else(|| "SPEAKER_0".to_string())
    };

    let start_ms = (result.start.unwrap_or(0.0) * 1000.0) as u64;
    let end_ms = start_ms + (result.duration.unwrap_or(0.0) * 1000.0) as u64;
    let confidence = alt.confidence.unwrap_or(0.0);

    Some(SpeechEvent::Transcript {
        session_id: session_id.to_string(),
        segment: SpeechSegmentData {
            speaker_id,
            text: transcript,
            start_ms,
            end_ms,
            confidence,
            is_final,
            speech_final,
        },
    })
}

// ── AssemblyAI Universal Streaming v3 JSON parsing ───────────────────────────
// New endpoint: wss://streaming.assemblyai.com/v3/ws
// Response types: "Begin" (session start), "Turn" (final utterance), partial transcripts

#[derive(Deserialize, Debug)]
struct AaiV3Message {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    transcript: Option<String>,          // utterance text (primary field)
    text: Option<String>,                // formatted text (fallback if transcript absent)
    end_of_turn: Option<bool>,           // true = final utterance; false = partial/streaming
    end_of_turn_confidence: Option<f64>, // model's confidence that the turn ended
    words: Option<Vec<AaiV3Word>>,
    // Error fields — server sends these in a text frame before Close
    error: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize, Debug)]
struct AaiV3Word {
    start: Option<f64>, // milliseconds
    end: Option<f64>,   // milliseconds
}

fn parse_assemblyai(session_id: &str, text: &str) -> Option<SpeechEvent> {
    let msg: AaiV3Message = serde_json::from_str(text).ok()?;

    // Surface server error messages (sent before Close frame, otherwise silently dropped)
    let is_error_type = msg.msg_type.as_deref()
        .map(|t| t.eq_ignore_ascii_case("error"))
        .unwrap_or(false);
    if is_error_type || msg.error.is_some() {
        let err = msg.error.as_deref()
            .or(msg.message.as_deref())
            .unwrap_or("Server error");
        let detail = if is_error_type {
            msg.message.as_deref().map(|m| format!(": {}", m)).unwrap_or_default()
        } else {
            String::new()
        };
        return Some(SpeechEvent::Error {
            session_id: session_id.to_string(),
            error: format!("{}{}", err, detail),
        });
    }

    // Handle "Turn" (partial + final) and "PartialTranscript" message types.
    // "Begin" and others are ignored (captured by last_server_text for diagnostics).
    let msg_type_str = msg.msg_type.as_deref().unwrap_or("(none)");
    let is_turn = msg_type_str == "Turn";
    let is_partial = msg_type_str == "PartialTranscript";
    if !is_turn && !is_partial {
        #[cfg(debug_assertions)]
        eprintln!("[speech_proxy:assemblyai] ignored msg type={}", msg_type_str);
        return None;
    }

    // Use `transcript` first; fall back to `text` (formatted/punctuated version).
    let transcript_val = msg.transcript.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let text_val = msg.text.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let text = match transcript_val.or(text_val) {
        Some(t) => t.to_string(),
        None => {
            // Turn arrived but both transcript and text fields are empty — likely silence
            #[cfg(debug_assertions)]
            eprintln!("[speech_proxy:assemblyai] {} with empty text (end_of_turn={:?})",
                msg_type_str, msg.end_of_turn);
            return None;
        }
    };

    // For "Turn": is_final = end_of_turn (defaults true if absent — safe for older v3 schemas).
    // For "PartialTranscript": always non-final.
    let is_final = if is_partial { false } else { msg.end_of_turn.unwrap_or(true) };

    let start_ms = msg.words.as_ref()
        .and_then(|ws| ws.first())
        .and_then(|w| w.start)
        .map(|s| s as u64)
        .unwrap_or(0);
    let end_ms = msg.words.as_ref()
        .and_then(|ws| ws.last())
        .and_then(|w| w.end)
        .map(|e| e as u64)
        .unwrap_or(0);

    Some(SpeechEvent::Transcript {
        session_id: session_id.to_string(),
        segment: SpeechSegmentData {
            speaker_id: "SPEAKER_0".to_string(), // v3 basic mode has no speaker diarization
            text,
            start_ms,
            end_ms,
            confidence: msg.end_of_turn_confidence.unwrap_or(1.0),
            is_final,
            speech_final: is_final, // AssemblyAI only emits complete utterances
        },
    })
}

// ── Gladia JSON parsing ───────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct GladiaLegacyMessage {
    event: Option<String>,
    #[serde(rename = "type")]
    msg_type: Option<String>,
    transcription: Option<String>,
    confidence: Option<f64>,
    time_begin: Option<f64>,
    time_end: Option<f64>,
    speaker: Option<serde_json::Value>,
}

fn parse_gladia_speaker(value: Option<&Value>) -> String {
    match value {
        Some(v) if v.is_number() => {
            let idx = v.as_u64().unwrap_or(0);
            format!("SPEAKER_{}", idx)
        }
        Some(v) if v.is_string() => {
            let s = v.as_str().unwrap_or_default().trim();
            if s.is_empty() {
                "SPEAKER_0".to_string()
            } else if s.starts_with("SPEAKER_") {
                s.to_string()
            } else if let Ok(idx) = s.parse::<u64>() {
                format!("SPEAKER_{}", idx)
            } else {
                s.to_string()
            }
        }
        _ => "SPEAKER_0".to_string(),
    }
}

fn parse_gladia(session_id: &str, text: &str) -> Option<SpeechEvent> {
    let value: Value = serde_json::from_str(text).ok()?;

    // ── V2 format ──
    if let Some(msg_type) = value.get("type").and_then(|v| v.as_str()) {
        if msg_type.eq_ignore_ascii_case("error") {
            let err = value
                .get("error")
                .and_then(|v| v.as_str())
                .or_else(|| value.get("message").and_then(|v| v.as_str()))
                .or_else(|| {
                    value
                        .get("data")
                        .and_then(|d| d.get("error"))
                        .and_then(|v| v.as_str())
                })
                .or_else(|| {
                    value
                        .get("data")
                        .and_then(|d| d.get("message"))
                        .and_then(|v| v.as_str())
                })
                .unwrap_or("Gladia server error");
            return Some(SpeechEvent::Error {
                session_id: session_id.to_string(),
                error: err.to_string(),
            });
        }

        if msg_type == "transcript" {
            let data = value.get("data")?;
            let utterance = data.get("utterance")?;
            let transcript = utterance
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if transcript.is_empty() {
                return None;
            }

            let is_final = data
                .get("is_final")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let confidence = data
                .get("confidence")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let start_ms = (utterance
                .get("start")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                * 1000.0) as u64;
            let end_ms = (utterance
                .get("end")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                * 1000.0) as u64;
            let speaker_id = parse_gladia_speaker(utterance.get("channel"));

            return Some(SpeechEvent::Transcript {
                session_id: session_id.to_string(),
                segment: SpeechSegmentData {
                    speaker_id,
                    text: transcript,
                    start_ms,
                    end_ms,
                    confidence,
                    is_final,
                    speech_final: is_final,
                },
            });
        }

        // Legacy v1 uses `type: final|interim|partial` on transcript events.
        // Allow those through to the legacy parser below.
        if !matches!(msg_type, "final" | "interim" | "partial") {
            return None;
        }
    }

    // ── Legacy v1 format (kept for compatibility with explicit legacy endpoints) ──
    let msg: GladiaLegacyMessage = serde_json::from_value(value).ok()?;
    if msg.msg_type.as_deref().map(|t| t.eq_ignore_ascii_case("error")).unwrap_or(false) {
        return Some(SpeechEvent::Error {
            session_id: session_id.to_string(),
            error: "Gladia server error".to_string(),
        });
    }
    if msg.event.as_deref() != Some("transcript") {
        return None;
    }

    let msg_type = msg.msg_type.as_deref().unwrap_or("final");
    let is_final = !matches!(msg_type, "interim" | "partial");
    let transcript = msg.transcription.unwrap_or_default().trim().to_string();
    if transcript.is_empty() {
        return None;
    }
    let speaker_id = parse_gladia_speaker(msg.speaker.as_ref());

    Some(SpeechEvent::Transcript {
        session_id: session_id.to_string(),
        segment: SpeechSegmentData {
            speaker_id,
            text: transcript,
            start_ms: (msg.time_begin.unwrap_or(0.0) * 1000.0) as u64,
            end_ms: (msg.time_end.unwrap_or(0.0) * 1000.0) as u64,
            confidence: msg.confidence.unwrap_or(0.0),
            is_final,
            speech_final: is_final,
        },
    })
}

fn parse_json_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_i64().map(|n| n as f64))
            .or_else(|| v.as_u64().map(|n| n as f64))
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CustomWsMode {
    RawBinary,
    DashScopeFunAsr,
    TencentAsrV2,
    IflytekIatV2,
    OpenAiRealtime,
    VolcengineRealtime,
}

fn normalize_ws_url(url: &str) -> Option<reqwest::Url> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    reqwest::Url::parse(trimmed).ok()
}

fn ws_url_host(url: &str) -> String {
    normalize_ws_url(url)
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .unwrap_or_else(|| url.to_lowercase())
}

fn ws_url_path(url: &str) -> String {
    normalize_ws_url(url)
        .map(|u| u.path().trim_end_matches('/').to_lowercase())
        .unwrap_or_else(|| url.to_lowercase())
}

fn is_dashscope_ws_endpoint(url: &str) -> bool {
    let host = ws_url_host(url);
    let path = ws_url_path(url);
    (host.contains("dashscope") && path.ends_with("/api-ws/v1/inference"))
        || url
            .to_lowercase()
            .contains("dashscope.aliyuncs.com/api-ws/v1/inference")
        || url
            .to_lowercase()
            .contains("dashscope-intl.aliyuncs.com/api-ws/v1/inference")
}

fn is_tencent_asr_ws_endpoint(url: &str) -> bool {
    let host = ws_url_host(url);
    let path = ws_url_path(url);
    (path.contains("/asr/v2/") && (host.contains("tencent") || host.contains("qcloud")))
        || url.to_lowercase().contains("asr.cloud.tencent.com/asr/v2/")
}

fn is_iflytek_iat_ws_endpoint(url: &str) -> bool {
    let host = ws_url_host(url);
    let path = ws_url_path(url);
    (host.contains("iat-api") && path.ends_with("/v2/iat"))
        || (url.to_lowercase().contains("iat-api") && url.to_lowercase().contains("/v2/iat"))
}

fn is_volcengine_realtime_ws_endpoint(url: &str) -> bool {
    let host = ws_url_host(url);
    let path = ws_url_path(url);
    path.ends_with("/v1/realtime")
        && (host.contains("volces") || host.contains("volcengine") || host.contains("byteplus"))
}

fn is_openai_realtime_ws_endpoint(url: &str) -> bool {
    let host = ws_url_host(url);
    let path = ws_url_path(url);
    path.ends_with("/v1/realtime") && host.contains("openai")
}

fn detect_custom_ws_mode(url: &str, model: &str) -> CustomWsMode {
    let model_lc = model.trim().to_lowercase();
    if is_dashscope_ws_endpoint(url) || model_lc.starts_with("fun-asr") {
        CustomWsMode::DashScopeFunAsr
    } else if is_tencent_asr_ws_endpoint(url) {
        CustomWsMode::TencentAsrV2
    } else if is_iflytek_iat_ws_endpoint(url) {
        CustomWsMode::IflytekIatV2
    } else if is_volcengine_realtime_ws_endpoint(url) {
        CustomWsMode::VolcengineRealtime
    } else if url.to_lowercase().contains("/v1/realtime") {
        // OpenAI-compatible realtime servers typically use this path.
        CustomWsMode::OpenAiRealtime
    } else {
        CustomWsMode::RawBinary
    }
}

fn extract_url_query_param(url: &str, key: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    for (k, v) in parsed.query_pairs() {
        if k.eq_ignore_ascii_case(key) {
            return Some(v.into_owned());
        }
    }
    None
}

fn resolve_iflytek_app_id(base_url: &str, model: &str) -> String {
    extract_url_query_param(base_url, "app_id")
        .or_else(|| extract_url_query_param(base_url, "appid"))
        .or_else(|| {
            let from_model = model.trim();
            if from_model.is_empty() {
                None
            } else {
                Some(from_model.to_string())
            }
        })
        .unwrap_or_default()
}

fn iflytek_language_params(language: &str) -> (&'static str, &'static str) {
    match language {
        "en" => ("en_us", "mandarin"),
        "ja" => ("ja_jp", "mandarin"),
        "ko" => ("ko_kr", "mandarin"),
        "fr" => ("fr_fr", "mandarin"),
        "de" => ("de_de", "mandarin"),
        "es" => ("es_es", "mandarin"),
        "zh" | "auto" | "multi" => ("zh_cn", "mandarin"),
        _ => ("zh_cn", "mandarin"),
    }
}

fn build_iflytek_audio_frame(app_id: &str, language: &str, audio: &[u8], status: i32) -> String {
    let encoded_audio = BASE64_STANDARD.encode(audio);
    let data = serde_json::json!({
        "status": status,
        "format": "audio/L16;rate=16000",
        "encoding": "raw",
        "audio": encoded_audio
    });
    if status == 0 {
        let (lang, accent) = iflytek_language_params(language);
        serde_json::json!({
            "common": { "app_id": app_id },
            "business": {
                "language": lang,
                "domain": "iat",
                "accent": accent
            },
            "data": data
        })
        .to_string()
    } else {
        serde_json::json!({ "data": data }).to_string()
    }
}

fn build_iflytek_end_frame() -> String {
    serde_json::json!({
        "data": {
            "status": 2
        }
    })
    .to_string()
}

fn build_tencent_end_signal() -> String {
    serde_json::json!({ "type": "end" }).to_string()
}

fn build_realtime_audio_append(audio: &[u8]) -> String {
    serde_json::json!({
        "type": "input_audio_buffer.append",
        "audio": BASE64_STANDARD.encode(audio)
    })
    .to_string()
}

fn build_realtime_audio_commit() -> String {
    serde_json::json!({ "type": "input_audio_buffer.commit" }).to_string()
}

fn build_openai_realtime_session_update(model: &str) -> String {
    let selected_model = if model.trim().is_empty() {
        "gpt-4o-mini-transcribe"
    } else {
        model.trim()
    };
    serde_json::json!({
        "type": "session.update",
        "session": {
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": 16000 },
                    "transcription": { "model": selected_model },
                    "turn_detection": { "type": "server_vad" }
                }
            }
        }
    })
    .to_string()
}

fn build_volcengine_realtime_session_update() -> String {
    serde_json::json!({
        "type": "transcription_session.update",
        "session": {
            "input_audio_format": "pcm",
            "input_audio_codec": "raw",
            "input_audio_sample_rate": 16000,
            "input_audio_bits": 16,
            "input_audio_channel": 1,
            "result_type": 0,
            "turn_detection": {
                "type": "server_vad_text_mode",
                "text_interval": 300
            }
        }
    })
    .to_string()
}

fn is_openai_realtime_ready(text: &str) -> bool {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return false,
    };
    matches!(
        value.get("type").and_then(|t| t.as_str()),
        Some("session.updated") | Some("session.created") | Some("transcription_session.updated")
    )
}

fn is_volcengine_realtime_ready(text: &str) -> bool {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return false,
    };
    value.get("type").and_then(|t| t.as_str()) == Some("transcription_session.updated")
}

fn parse_generic_custom_error(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let msg_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_lowercase();
    if !msg_type.contains("error") && value.get("error").is_none() {
        return None;
    }
    Some(
        value
            .get("error")
            .and_then(|e| {
                e.get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| e.as_str())
            })
            .or_else(|| value.get("message").and_then(|m| m.as_str()))
            .or_else(|| {
                value
                    .get("data")
                    .and_then(|d| d.get("error"))
                    .and_then(|e| e.get("message").and_then(|m| m.as_str()).or_else(|| e.as_str()))
            })
            .or_else(|| {
                value
                    .get("data")
                    .and_then(|d| d.get("message"))
                    .and_then(|m| m.as_str())
            })
            .unwrap_or("Custom STT server error")
            .to_string(),
    )
}

fn dashscope_task_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = SESSION_COUNTER.fetch_add(1, Ordering::SeqCst) as u128;
    let mut id = format!("{:x}{:x}", ts, counter).replace('-', "");
    if id.len() < 32 {
        id.push_str(&"0".repeat(32 - id.len()));
    }
    id.chars().take(32).collect()
}

fn build_dashscope_run_task(model: &str, task_id: &str) -> String {
    let selected_model = if model.trim().is_empty() {
        "fun-asr-realtime"
    } else {
        model.trim()
    };
    serde_json::json!({
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": selected_model,
            "parameters": {
                "format": "pcm",
                "sample_rate": 16000
            },
            "input": {}
        }
    })
    .to_string()
}

fn build_dashscope_finish_task(task_id: &str) -> String {
    serde_json::json!({
        "header": {
            "action": "finish-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": {
            "input": {}
        }
    })
    .to_string()
}

fn is_dashscope_task_started(text: &str) -> bool {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return false,
    };
    value
        .get("header")
        .and_then(|h| h.get("event"))
        .and_then(|e| e.as_str())
        == Some("task-started")
}

fn parse_dashscope_task_failed(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value
        .get("header")
        .and_then(|h| h.get("event"))
        .and_then(|e| e.as_str())
        != Some("task-failed")
    {
        return None;
    }
    Some(
        value
            .get("header")
            .and_then(|h| h.get("error_message"))
            .and_then(|m| m.as_str())
            .or_else(|| {
                value
                    .get("payload")
                    .and_then(|p| p.get("message"))
                    .and_then(|m| m.as_str())
            })
            .unwrap_or("DashScope task failed")
            .to_string(),
    )
}

fn parse_tencent_asr(session_id: &str, text: &str) -> Option<SpeechEvent> {
    let value: Value = serde_json::from_str(text).ok()?;
    let code = parse_json_number(value.get("code")).unwrap_or(0.0) as i64;
    if code != 0 {
        let err = value
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Tencent ASR server error");
        return Some(SpeechEvent::Error {
            session_id: session_id.to_string(),
            error: err.to_string(),
        });
    }

    // Final completion marker may carry no transcript payload.
    if value
        .get("final")
        .and_then(|v| v.as_i64())
        .map(|v| v == 1)
        .unwrap_or(false)
    {
        return None;
    }

    let result = value.get("result")?;
    let transcript = result
        .get("voice_text_str")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if transcript.is_empty() {
        return None;
    }

    let start_ms = parse_json_number(result.get("start_time")).unwrap_or(0.0) as u64;
    let end_ms = parse_json_number(result.get("end_time")).unwrap_or(0.0) as u64;
    let is_final = result
        .get("slice_type")
        .and_then(|v| v.as_i64())
        .map(|v| v == 2)
        .unwrap_or(false);

    Some(SpeechEvent::Transcript {
        session_id: session_id.to_string(),
        segment: SpeechSegmentData {
            speaker_id: "SPEAKER_0".to_string(),
            text: transcript,
            start_ms,
            end_ms,
            confidence: 0.0,
            is_final,
            speech_final: is_final,
        },
    })
}

fn parse_iflytek_iat(session_id: &str, text: &str) -> Option<SpeechEvent> {
    let value: Value = serde_json::from_str(text).ok()?;
    let code = parse_json_number(value.get("code")).unwrap_or(0.0) as i64;
    if code != 0 {
        let err = value
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("iFLYTEK server error");
        return Some(SpeechEvent::Error {
            session_id: session_id.to_string(),
            error: err.to_string(),
        });
    }

    let data = value.get("data")?;
    let result = data.get("result")?;
    let ws = result.get("ws").and_then(|v| v.as_array())?;

    let mut transcript = String::new();
    for token in ws {
        if let Some(word) = token
            .get("cw")
            .and_then(|v| v.as_array())
            .and_then(|cw| cw.first())
            .and_then(|best| best.get("w"))
            .and_then(|w| w.as_str())
        {
            transcript.push_str(word);
        }
    }

    let transcript = transcript.trim().to_string();
    if transcript.is_empty() {
        return None;
    }

    let is_final = data
        .get("status")
        .and_then(|v| v.as_i64())
        .map(|v| v == 2)
        .or_else(|| result.get("ls").and_then(|v| v.as_bool()))
        .unwrap_or(false);

    Some(SpeechEvent::Transcript {
        session_id: session_id.to_string(),
        segment: SpeechSegmentData {
            speaker_id: "SPEAKER_0".to_string(),
            text: transcript,
            start_ms: 0,
            end_ms: 0,
            confidence: 0.0,
            is_final,
            speech_final: is_final,
        },
    })
}

fn parse_custom(session_id: &str, text: &str) -> Option<SpeechEvent> {
    let value: Value = serde_json::from_str(text).ok()?;
    let msg_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_lowercase();

    // DashScope event envelope: { header: { event: ... }, payload: ... }
    if let Some(event) = value
        .get("header")
        .and_then(|h| h.get("event"))
        .and_then(|e| e.as_str())
    {
        if event == "task-failed" {
            let err = value
                .get("header")
                .and_then(|h| h.get("error_message"))
                .and_then(|m| m.as_str())
                .or_else(|| {
                    value
                        .get("payload")
                        .and_then(|p| p.get("message"))
                        .and_then(|m| m.as_str())
                })
                .unwrap_or("DashScope task failed");
            return Some(SpeechEvent::Error {
                session_id: session_id.to_string(),
                error: err.to_string(),
            });
        }
        if event == "result-generated" {
            let sentence = value
                .get("payload")
                .and_then(|p| p.get("output"))
                .and_then(|o| o.get("sentence"))?;
            let transcript = sentence
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if transcript.is_empty() {
                return None;
            }
            let start_ms = parse_json_number(sentence.get("begin_time")).unwrap_or(0.0) as u64;
            let end_ms = parse_json_number(sentence.get("end_time")).unwrap_or(0.0) as u64;
            let is_final = sentence
                .get("sentence_end")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return Some(SpeechEvent::Transcript {
                session_id: session_id.to_string(),
                segment: SpeechSegmentData {
                    speaker_id: "SPEAKER_0".to_string(),
                    text: transcript,
                    start_ms,
                    end_ms,
                    confidence: 0.0,
                    is_final,
                    speech_final: is_final,
                },
            });
        }
    }

    // Surface flexible error payloads commonly used by custom STT servers.
    if let Some(err) = parse_generic_custom_error(text) {
        return Some(SpeechEvent::Error {
            session_id: session_id.to_string(),
            error: err,
        });
    }

    // Support several common transcript payload shapes:
    // - { text } / { transcript } / { transcription }
    // - { data: { text|transcript|transcription } }
    // - { data: { utterance: { text } } } (Gladia-like)
    // - OpenAI realtime style: { type: "...audio_transcript.delta", delta: "..." }
    let transcript = value
        .get("text")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("transcript").and_then(|v| v.as_str()))
        .or_else(|| value.get("transcription").and_then(|v| v.as_str()))
        .or_else(|| value.get("delta").and_then(|v| v.as_str()))
        .or_else(|| {
            value
                .get("result")
                .and_then(|r| r.get("voice_text_str"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("segment")
                .and_then(|s| s.get("text"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("data")
                .and_then(|d| d.get("text"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("data")
                .and_then(|d| d.get("transcript"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("data")
                .and_then(|d| d.get("transcription"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("data")
                .and_then(|d| d.get("utterance"))
                .and_then(|u| u.get("text"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("data")
                .and_then(|d| d.get("result"))
                .and_then(|r| r.get("text"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or_default()
        .trim()
        .to_string();

    if transcript.is_empty() {
        return None;
    }

    let speaker_id = parse_gladia_speaker(
        value
            .get("speaker_id")
            .or_else(|| value.get("speakerId"))
            .or_else(|| value.get("speaker"))
            .or_else(|| value.get("channel"))
            .or_else(|| value.get("data").and_then(|d| d.get("speaker_id")))
            .or_else(|| value.get("data").and_then(|d| d.get("speakerId")))
            .or_else(|| value.get("data").and_then(|d| d.get("speaker")))
            .or_else(|| value.get("data").and_then(|d| d.get("channel")))
            .or_else(|| {
                value
                    .get("data")
                    .and_then(|d| d.get("utterance"))
                    .and_then(|u| u.get("channel"))
            }),
    );

    let start_ms = parse_json_number(
        value
            .get("start_ms")
            .or_else(|| value.get("startMs"))
            .or_else(|| value.get("result").and_then(|r| r.get("start_time")))
            .or_else(|| value.get("data").and_then(|d| d.get("start_ms")))
            .or_else(|| value.get("data").and_then(|d| d.get("startMs"))),
    )
    .map(|n| n as u64)
    .or_else(|| {
        parse_json_number(
            value
                .get("start")
                .or_else(|| value.get("time_begin"))
                .or_else(|| value.get("data").and_then(|d| d.get("start")))
                .or_else(|| value.get("data").and_then(|d| d.get("time_begin")))
                .or_else(|| {
                    value
                        .get("data")
                        .and_then(|d| d.get("utterance"))
                        .and_then(|u| u.get("start"))
                }),
        )
        .map(|n| (n * 1000.0) as u64)
    })
    .unwrap_or(0);

    let end_ms = parse_json_number(
        value
            .get("end_ms")
            .or_else(|| value.get("endMs"))
            .or_else(|| value.get("result").and_then(|r| r.get("end_time")))
            .or_else(|| value.get("data").and_then(|d| d.get("end_ms")))
            .or_else(|| value.get("data").and_then(|d| d.get("endMs"))),
    )
    .map(|n| n as u64)
    .or_else(|| {
        parse_json_number(
            value
                .get("end")
                .or_else(|| value.get("time_end"))
                .or_else(|| value.get("data").and_then(|d| d.get("end")))
                .or_else(|| value.get("data").and_then(|d| d.get("time_end")))
                .or_else(|| {
                    value
                        .get("data")
                        .and_then(|d| d.get("utterance"))
                        .and_then(|u| u.get("end"))
                }),
        )
        .map(|n| (n * 1000.0) as u64)
    })
    .unwrap_or(0);

    let confidence = parse_json_number(
        value
            .get("confidence")
            .or_else(|| value.get("data").and_then(|d| d.get("confidence")))
            .or_else(|| value.get("segment").and_then(|s| s.get("confidence"))),
    )
    .unwrap_or(0.0);

    let is_final = value
        .get("is_final")
        .and_then(|v| v.as_bool())
        .or_else(|| value.get("isFinal").and_then(|v| v.as_bool()))
        .or_else(|| value.get("final").and_then(|v| v.as_bool()))
        .or_else(|| value.get("speech_final").and_then(|v| v.as_bool()))
        .or_else(|| value.get("end_of_turn").and_then(|v| v.as_bool()))
        .or_else(|| {
            value
                .get("result")
                .and_then(|r| r.get("slice_type"))
                .and_then(|v| v.as_i64())
                .map(|slice| slice == 2)
        })
        .or_else(|| value.get("data").and_then(|d| d.get("is_final")).and_then(|v| v.as_bool()))
        .or_else(|| value.get("data").and_then(|d| d.get("isFinal")).and_then(|v| v.as_bool()))
        .or_else(|| value.get("data").and_then(|d| d.get("final")).and_then(|v| v.as_bool()))
        .unwrap_or_else(|| {
            if msg_type.contains(".delta")
                || msg_type.ends_with(".result")
                || msg_type.contains("partial")
                || msg_type.contains("interim")
            {
                false
            } else {
                true
            }
        });

    Some(SpeechEvent::Transcript {
        session_id: session_id.to_string(),
        segment: SpeechSegmentData {
            speaker_id,
            text: transcript,
            start_ms,
            end_ms,
            confidence,
            is_final,
            speech_final: is_final,
        },
    })
}

// ── WebSocket request builders ────────────────────────────────────────────────

type WsRequest = tokio_tungstenite::tungstenite::http::Request<()>;

fn deepgram_request(base_url: &str, api_key: &str, model: &str, language: &str) -> Result<WsRequest, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let host = if base_url.is_empty() { "wss://api.deepgram.com" } else { base_url.trim_end_matches('/') };
    let url = format!(
        "{}/v1/listen?model={}&language={}&diarize=true&encoding=linear16&sample_rate=16000&interim_results=true&endpointing=500",
        host, model, language
    );
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "Authorization",
        format!("Token {}", api_key).parse().map_err(|_| "Invalid API key".to_string())?,
    );
    Ok(req)
}

fn build_gladia_ws_request(ws_url: &str, api_key: Option<&str>) -> Result<WsRequest, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let normalized_url = if ws_url.starts_with("https://") {
        format!("wss://{}", &ws_url["https://".len()..])
    } else if ws_url.starts_with("http://") {
        format!("ws://{}", &ws_url["http://".len()..])
    } else {
        ws_url.to_string()
    };
    let mut req = normalized_url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    if let Some(key) = api_key {
        req.headers_mut().insert(
            "X-Gladia-Key",
            key.parse().map_err(|_| "Invalid API key".to_string())?,
        );
    }
    Ok(req)
}

fn normalize_gladia_http_base(base_url: &str) -> String {
    let raw = if base_url.trim().is_empty() {
        "wss://api.gladia.io"
    } else {
        base_url.trim()
    };
    let trimmed = raw.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{}", rest)
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{}", rest)
    } else {
        trimmed.to_string()
    }
}

async fn gladia_request(
    base_url: &str,
    api_key: &str,
    model: &str,
    language: &str,
) -> Result<(WsRequest, bool), String> {
    // Explicit legacy endpoint support: users can still point to v1 WS URLs.
    let trimmed = base_url.trim().trim_end_matches('/');
    if !trimmed.is_empty() && trimmed.contains("/audio/text/audio-transcription") {
        let req = build_gladia_ws_request(trimmed, Some(api_key))?;
        return Ok((req, true));
    }

    // Preferred path: Gladia v2 session init over HTTPS, then connect to returned WS URL.
    let http_base = normalize_gladia_http_base(base_url);
    let mut init_url = reqwest::Url::parse(&http_base).map_err(|e| {
        format!("Invalid Gladia base URL: {}", e)
    })?;
    init_url.set_path("/v2/live");
    init_url.set_query(None);

    let language_cfg = if language == "multi" {
        serde_json::json!({ "languages": ["*"], "code_switching": true })
    } else if language == "auto" {
        serde_json::json!({ "languages": ["*"], "code_switching": false })
    } else {
        serde_json::json!({ "languages": [language], "code_switching": false })
    };

    let mut payload = serde_json::json!({
        "encoding": "wav/pcm",
        "sample_rate": 16000,
        "bit_depth": 16,
        "channels": 1,
        "language_config": language_cfg
    });
    if !model.trim().is_empty() {
        payload["model"] = serde_json::json!(model.trim());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    let response = client
        .post(init_url)
        .header("X-Gladia-Key", api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Gladia session init failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Gladia session init error ({}): {}",
            status,
            body.chars().take(400).collect::<String>()
        ));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Gladia response: {}", e))?;
    let json: Value = serde_json::from_str(&body)
        .map_err(|_| "Gladia response is not valid JSON".to_string())?;

    let ws_url = json
        .get("url")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("ws_url").and_then(|v| v.as_str()))
        .or_else(|| json.get("websocket_url").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();

    if ws_url.is_empty() {
        return Err("Gladia did not return a WebSocket URL".to_string());
    }

    let req = build_gladia_ws_request(&ws_url, None)?;
    Ok((req, false))
}

fn gladia_legacy_model(model: &str) -> &str {
    if model == "solaria-1" || model.trim().is_empty() {
        "accurate"
    } else {
        model
    }
}

fn assemblyai_request(base_url: &str, api_key: &str, model: &str, language: &str) -> Result<WsRequest, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    // Universal Streaming v3 endpoint (old /v2/realtime/ws is deprecated)
    let host = if base_url.is_empty() {
        "wss://streaming.assemblyai.com"
    } else {
        base_url.trim_end_matches('/')
    };
    // AssemblyAI v3: speech_model URL param is invalid (causes 1011 for any value).
    // The model tier is determined by the account plan, not a URL parameter.
    // Language is auto-detected by the multilingual model.
    let _ = (model, language); // intentionally unused for v3
    let url = format!("{}/v3/ws?sample_rate=16000&encoding=pcm_s16le", host);
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "Authorization",
        api_key.parse().map_err(|_| "Invalid API key".to_string())?,
    );
    Ok(req)
}

fn azure_speech_request(base_url: &str, api_key: &str, language: &str, region: &str) -> Result<WsRequest, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let effective_region = if region.is_empty() { "eastus" } else { region };
    let host = if base_url.is_empty() {
        format!("wss://{}.stt.speech.microsoft.com", effective_region)
    } else {
        base_url.trim_end_matches('/').to_string()
    };
    let url = format!(
        "{}/speech/recognition/conversation/cognitiveservices/v1?language={}&format=detailed",
        host, language
    );
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "Ocp-Apim-Subscription-Key",
        api_key.parse().map_err(|_| "Invalid API key".to_string())?,
    );
    Ok(req)
}

fn custom_request(base_url: &str, api_key: &str) -> Result<WsRequest, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    if base_url.is_empty() {
        return Err("Custom provider requires a base URL".to_string());
    }
    let mut req = base_url.into_client_request().map_err(|e| e.to_string())?;
    if !api_key.is_empty() {
        req.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", api_key).parse().map_err(|_| "Invalid API key".to_string())?,
        );
    }
    // OpenAI Realtime historically required this beta header; harmless for
    // compatibility with older deployments.
    if is_openai_realtime_ws_endpoint(base_url) {
        req.headers_mut().insert(
            "OpenAI-Beta",
            "realtime=v1"
                .parse()
                .map_err(|_| "Invalid OpenAI beta header".to_string())?,
        );
    }
    Ok(req)
}

// ── Dispatcher: parse provider response text → SpeechEvent ───────────────────

fn dispatch_message(provider: &str, session_id: &str, text: &str) -> Option<SpeechEvent> {
    match provider {
        "deepgram" => parse_deepgram(session_id, text),
        "assemblyai" => parse_assemblyai(session_id, text),
        "gladia" => parse_gladia(session_id, text),
        "custom" => parse_tencent_asr(session_id, text)
            .or_else(|| parse_iflytek_iat(session_id, text))
            .or_else(|| parse_deepgram(session_id, text))
            .or_else(|| parse_assemblyai(session_id, text))
            .or_else(|| parse_gladia(session_id, text))
            .or_else(|| parse_custom(session_id, text)),
        // Azure and AWS Transcribe use text-based JSON similar to Deepgram;
        // full parsing can be added per-provider as needed.
        _ => None,
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Start a transcription session. Returns a session_id for subsequent calls.
///
/// `config_id` is used to look up the API key from the OS Keychain (via AIProxyState).
/// Non-sensitive config (provider, base_url, language, model, region) are passed directly.
#[tauri::command]
pub async fn speech_proxy_start(
    state: tauri::State<'_, SpeechProxyState>,
    key_state: tauri::State<'_, super::ai_proxy::AIProxyState>,
    on_event: Channel<SpeechEvent>,
    config_id: String,
    provider: String,
    base_url: String,
    language: String,
    model: String,
    region: Option<String>,
    source_mode: Option<String>,
) -> Result<String, String> {
    // Resolve API key from OS Keychain cache
    key_state.ensure_secrets_loaded().await;
    let api_key = {
        let cache = key_state
            .key_cache
            .lock()
            .map_err(|_| "Keychain lock poisoned".to_string())?;
        cache
            .get(&format!("speech-key:{}", config_id))
            .cloned()
            .unwrap_or_default()
    };

    let session_id = new_session_id();
    let region = region.unwrap_or_default();
    let custom_ws_mode = if provider == "custom" {
        detect_custom_ws_mode(&base_url, &model)
    } else {
        CustomWsMode::RawBinary
    };
    let custom_dashscope_task_id = if custom_ws_mode == CustomWsMode::DashScopeFunAsr {
        Some(dashscope_task_id())
    } else {
        None
    };
    let custom_iflytek_app_id = if custom_ws_mode == CustomWsMode::IflytekIatV2 {
        let app_id = resolve_iflytek_app_id(&base_url, &model);
        if app_id.is_empty() {
            return Err(
                "iFLYTEK iat requires APPID. Set model=APPID or append ?app_id=... in base URL"
                    .to_string(),
            );
        }
        Some(app_id)
    } else {
        None
    };

    // Build provider-specific WebSocket request (with auth headers)
    let mut gladia_legacy_mode = false;
    let ws_request = match provider.as_str() {
        "deepgram" => deepgram_request(&base_url, &api_key, &model, &language),
        "gladia" => {
            let (req, legacy) = gladia_request(&base_url, &api_key, &model, &language).await?;
            gladia_legacy_mode = legacy;
            Ok(req)
        }
        "assemblyai" => assemblyai_request(&base_url, &api_key, &model, &language),
        "azure-speech" => azure_speech_request(&base_url, &api_key, &language, &region),
        "aws-transcribe" => {
            // AWS Transcribe requires SigV4 pre-signed URL; not yet implemented
            return Err("AWS Transcribe support is not yet implemented".to_string());
        }
        "custom" => custom_request(&base_url, &api_key),
        other => return Err(format!("Unknown provider: {}", other)),
    }?;

    // Connect to the STT WebSocket
    let (ws_stream, _response) = tokio_tungstenite::connect_async(ws_request)
        .await
        .map_err(|e| format!("WebSocket connection failed: {}", e))?;

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // For legacy Gladia v1: send config JSON immediately after handshake.
    // Gladia v2 receives config during HTTPS /v2/live session creation.
    if provider == "gladia" && gladia_legacy_mode {
        let config = serde_json::json!({
            "x_gladia_key": api_key,
            "frames_format": "bytes",
            "sample_rate": 16000,
            "bit_depth": 16,
            "channels": 1,
            "encoding": "wav/pcm",
            "model_type": gladia_legacy_model(&model),
            "language": language,
            "language_behaviour": if language == "auto" || language == "multi" {
                "automatic multiple languages"
            } else {
                "manual"
            }
        });
        ws_write
            .send(Message::Text(config.to_string()))
            .await
            .map_err(|e| format!("Gladia config send failed: {}", e))?;
    }

    if provider == "custom" {
        match custom_ws_mode {
            CustomWsMode::DashScopeFunAsr => {
                if let Some(task_id) = custom_dashscope_task_id.as_deref() {
                    let run_task = build_dashscope_run_task(&model, task_id);
                    ws_write
                        .send(Message::Text(run_task))
                        .await
                        .map_err(|e| format!("DashScope run-task send failed: {}", e))?;
                }
            }
            CustomWsMode::OpenAiRealtime => {
                ws_write
                    .send(Message::Text(build_openai_realtime_session_update(&model)))
                    .await
                    .map_err(|e| format!("OpenAI session.update send failed: {}", e))?;
            }
            CustomWsMode::VolcengineRealtime => {
                ws_write
                    .send(Message::Text(build_volcengine_realtime_session_update()))
                    .await
                    .map_err(|e| format!("Volcengine transcription_session.update send failed: {}", e))?;
            }
            _ => {}
        }
    }

    // Audio chunk channel (frontend → writer task → WebSocket)
    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(64);
    // Stop signal (frontend → writer)
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    // Reader-done signal (reader → writer): tells writer to stop when server closes
    let (reader_done_tx, reader_done_rx) = oneshot::channel::<()>();
    let normalized_source_mode = source_mode
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let use_native_system_capture =
        cfg!(target_os = "macos")
            && matches!(normalized_source_mode.as_str(), "system" | "mixed");
    let use_native_mixed_capture = cfg!(target_os = "macos") && normalized_source_mode == "mixed";

    let (frontend_audio_tx, native_system_capture) = if use_native_mixed_capture {
        let (mic_audio_tx, mic_audio_rx) = mpsc::channel::<Vec<u8>>(64);
        let (system_audio_tx, system_audio_rx) = mpsc::channel::<Vec<u8>>(64);
        spawn_pcm_mixer(mic_audio_rx, system_audio_rx, audio_tx.clone());
        let capture = NativeSystemAudioCapture::start(system_audio_tx, &session_id)?;
        (mic_audio_tx, Some(capture))
    } else if use_native_system_capture {
        let capture = NativeSystemAudioCapture::start(audio_tx.clone(), &session_id)?;
        (audio_tx.clone(), Some(capture))
    } else {
        (audio_tx.clone(), None)
    };

    // Register session
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        sessions.insert(
            session_id.clone(),
            SpeechSession {
                audio_tx: frontend_audio_tx,
                stop_tx: Some(stop_tx),
                native_system_capture,
            },
        );
    }

    // Delay Connected for providers that expose an explicit server-ready event.
    let wait_for_begin = provider == "assemblyai"
        || matches!(
            custom_ws_mode,
            CustomWsMode::DashScopeFunAsr
                | CustomWsMode::OpenAiRealtime
                | CustomWsMode::VolcengineRealtime
        );
    if !wait_for_begin {
        let _ = on_event.send(SpeechEvent::Connected {
            session_id: session_id.clone(),
        });
    }

    let dashscope_finish_msg = custom_dashscope_task_id
        .as_ref()
        .map(|task_id| build_dashscope_finish_task(task_id));
    let dashscope_finish_msg_w = dashscope_finish_msg.clone();
    let custom_ws_mode_w = custom_ws_mode;
    let custom_ws_mode_r = custom_ws_mode;
    let custom_iflytek_app_id_w = custom_iflytek_app_id.clone();
    let language_w = language.clone();

    // ── Writer task: audio chunks → WebSocket Binary frames ──────────────────
    tokio::spawn(async move {
        let mut stop_rx = stop_rx;
        let mut reader_done_rx = reader_done_rx;
        let mut iflytek_first_frame_sent = false;
        loop {
            tokio::select! {
                biased;
                _ = &mut stop_rx => {
                    match custom_ws_mode_w {
                        CustomWsMode::DashScopeFunAsr => {
                            if let Some(msg) = dashscope_finish_msg_w.as_ref() {
                                let _ = ws_write.send(Message::Text(msg.clone())).await;
                            }
                        }
                        CustomWsMode::TencentAsrV2 => {
                            let _ = ws_write.send(Message::Text(build_tencent_end_signal())).await;
                        }
                        CustomWsMode::IflytekIatV2 => {
                            let _ = ws_write.send(Message::Text(build_iflytek_end_frame())).await;
                        }
                        CustomWsMode::OpenAiRealtime | CustomWsMode::VolcengineRealtime => {
                            let _ = ws_write.send(Message::Text(build_realtime_audio_commit())).await;
                        }
                        CustomWsMode::RawBinary => {}
                    }
                    let _ = ws_write.send(Message::Close(None)).await;
                    break;
                }
                // Server closed connection — stop writing silently (reader already reported error)
                _ = &mut reader_done_rx => { break; }
                chunk = audio_rx.recv() => {
                    match chunk {
                        Some(data) => {
                            let send_result = match custom_ws_mode_w {
                                CustomWsMode::IflytekIatV2 => {
                                    let app_id = custom_iflytek_app_id_w.as_deref().unwrap_or_default();
                                    let frame = if !iflytek_first_frame_sent {
                                        iflytek_first_frame_sent = true;
                                        build_iflytek_audio_frame(app_id, &language_w, &data, 0)
                                    } else {
                                        build_iflytek_audio_frame(app_id, &language_w, &data, 1)
                                    };
                                    ws_write.send(Message::Text(frame)).await
                                }
                                CustomWsMode::OpenAiRealtime | CustomWsMode::VolcengineRealtime => {
                                    ws_write
                                        .send(Message::Text(build_realtime_audio_append(&data)))
                                        .await
                                }
                                _ => ws_write.send(Message::Binary(data)).await,
                            };
                            if send_result.is_err() {
                                break;
                            }
                        }
                        None => {
                            // Channel closed — send graceful close
                            match custom_ws_mode_w {
                                CustomWsMode::DashScopeFunAsr => {
                                    if let Some(msg) = dashscope_finish_msg_w.as_ref() {
                                        let _ = ws_write.send(Message::Text(msg.clone())).await;
                                    }
                                }
                                CustomWsMode::TencentAsrV2 => {
                                    let _ = ws_write.send(Message::Text(build_tencent_end_signal())).await;
                                }
                                CustomWsMode::IflytekIatV2 => {
                                    let _ = ws_write.send(Message::Text(build_iflytek_end_frame())).await;
                                }
                                CustomWsMode::OpenAiRealtime | CustomWsMode::VolcengineRealtime => {
                                    let _ = ws_write.send(Message::Text(build_realtime_audio_commit())).await;
                                }
                                CustomWsMode::RawBinary => {}
                            }
                            let _ = ws_write.send(Message::Close(None)).await;
                            break;
                        }
                    }
                }
            }
        }
    });

    let sid_r = session_id.clone();
    let provider_r = provider.clone();

    // ── Reader task: WebSocket messages → SpeechEvent via Channel ────────────
    tokio::spawn(async move {
        // Track the last unrecognized server message (truncated) so we can include
        // it in the Close error message if the server gave no Close reason.
        let mut last_server_text: Option<String> = None;
        // For AssemblyAI: becomes true once we receive the "Begin" handshake.
        let mut connected_emitted = !wait_for_begin;

        while let Some(msg_result) = ws_read.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[speech_proxy:{}] ← {}", provider_r, text.chars().take(200).collect::<String>());

                    // Emit Connected only after server-ready handshake messages.
                    if !connected_emitted {
                        // AssemblyAI v3 handshake
                        if provider_r == "assemblyai" {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                                if val.get("type").and_then(|t| t.as_str()) == Some("Begin") {
                                    let _ = on_event.send(SpeechEvent::Connected {
                                        session_id: sid_r.clone(),
                                    });
                                    connected_emitted = true;
                                    continue; // handshake message, not transcript
                                }
                            }
                        }
                        match custom_ws_mode_r {
                            CustomWsMode::DashScopeFunAsr => {
                                if let Some(err) = parse_dashscope_task_failed(&text) {
                                    let _ = on_event.send(SpeechEvent::Error {
                                        session_id: sid_r.clone(),
                                        error: err,
                                    });
                                    break;
                                }
                                if is_dashscope_task_started(&text) {
                                    let _ = on_event.send(SpeechEvent::Connected {
                                        session_id: sid_r.clone(),
                                    });
                                    connected_emitted = true;
                                    continue; // handshake message, not transcript
                                }
                            }
                            CustomWsMode::OpenAiRealtime => {
                                if let Some(err) = parse_generic_custom_error(&text) {
                                    let _ = on_event.send(SpeechEvent::Error {
                                        session_id: sid_r.clone(),
                                        error: err,
                                    });
                                    break;
                                }
                                if is_openai_realtime_ready(&text) {
                                    let _ = on_event.send(SpeechEvent::Connected {
                                        session_id: sid_r.clone(),
                                    });
                                    connected_emitted = true;
                                    continue; // handshake message, not transcript
                                }
                            }
                            CustomWsMode::VolcengineRealtime => {
                                if let Some(err) = parse_generic_custom_error(&text) {
                                    let _ = on_event.send(SpeechEvent::Error {
                                        session_id: sid_r.clone(),
                                        error: err,
                                    });
                                    break;
                                }
                                if is_volcengine_realtime_ready(&text) {
                                    let _ = on_event.send(SpeechEvent::Connected {
                                        session_id: sid_r.clone(),
                                    });
                                    connected_emitted = true;
                                    continue; // handshake message, not transcript
                                }
                            }
                            _ => {}
                        }
                        // Not ready yet — keep waiting (don't parse as transcript)
                        last_server_text = Some(text.chars().take(300).collect());
                        continue;
                    }

                    match dispatch_message(&provider_r, &sid_r, &text) {
                        Some(event) => { let _ = on_event.send(event); }
                        None => {
                            // Capture last unrecognized message (e.g. partial,
                            // or an error JSON we couldn't parse) for Close diagnostics.
                            last_server_text = Some(text.chars().take(300).collect());
                        }
                    }
                }
                // Server closed the WebSocket — surface reason as an error so the
                // user sees the actual rejection message (e.g. "invalid token")
                // rather than the confusing downstream "Audio send failed".
                Ok(Message::Close(frame)) => {
                    let reason = match &frame {
                        Some(f) if !f.reason.is_empty() => f.reason.to_string(),
                        Some(f) => {
                            let code: u16 = f.code.into();
                            last_server_text
                                .take()
                                .map(|m| format!("Server closed (code {}): {}", code, m))
                                .unwrap_or_else(|| format!("Connection closed by server (code {})", code))
                        }
                        None => last_server_text
                            .take()
                            .map(|m| format!("Server closed: {}", m))
                            .unwrap_or_else(|| "Connection closed by server".to_string()),
                    };
                    let _ = on_event.send(SpeechEvent::Error {
                        session_id: sid_r.clone(),
                        error: reason,
                    });
                    break;
                }
                Err(e) => {
                    let _ = on_event.send(SpeechEvent::Error {
                        session_id: sid_r.clone(),
                        error: format!("WebSocket error: {}", e),
                    });
                    break;
                }
                Ok(Message::Binary(_data)) => {
                    // AssemblyAI should not send binary frames — log if this happens
                    #[cfg(debug_assertions)]
                    eprintln!("[speech_proxy:{}] ← binary frame {} bytes", provider_r, _data.len());
                }
                _ => {}
            }
        }
        // Notify writer so it exits cleanly instead of hitting a write error
        let _ = reader_done_tx.send(());
    });

    Ok(session_id)
}

/// Send a raw PCM audio chunk (base64-encoded) to an active transcription session.
/// Base64 is used instead of a JSON number array because WKWebView deserialises
/// a single JSON string token orders of magnitude faster than N number tokens,
/// preventing the IPC flooding that freezes the UI.
#[tauri::command]
pub async fn speech_proxy_send_audio(
    state: tauri::State<'_, SpeechProxyState>,
    session_id: String,
    audio_b64: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let audio_bytes = STANDARD
        .decode(audio_b64.as_bytes())
        .map_err(|_| "Invalid base64 audio data".to_string())?;

    let tx = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        sessions
            .get(&session_id)
            .map(|s| s.audio_tx.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    tx.send(audio_bytes)
        .await
        .map_err(|_| "Session audio channel closed".to_string())
}

/// Stop a transcription session and close the WebSocket connection.
#[tauri::command]
pub async fn speech_proxy_stop(
    state: tauri::State<'_, SpeechProxyState>,
    session_id: String,
) -> Result<(), String> {
    let (stop_tx, mut native_system_capture) = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        match sessions.remove(&session_id) {
            Some(mut s) => (s.stop_tx.take(), s.native_system_capture.take()),
            None => (None, None),
        }
    };

    if let Some(capture) = native_system_capture.as_mut() {
        capture.stop();
    }

    if let Some(tx) = stop_tx {
        let _ = tx.send(());
    }

    Ok(())
}

// ── Realtime Dialogue (bidirectional voice AI) ────────────────────────────────

/// Events emitted to the frontend during a realtime dialogue session.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RtDialogueEvent {
    Connected {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// Raw JSON text message from the server (protocol-specific).
    Message {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        error: String,
    },
    Disconnected {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

struct RtDialogueSession {
    /// Send text (JSON) messages to the server.
    text_tx: mpsc::Sender<String>,
    /// Send raw binary audio to the server.
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_tx: Option<oneshot::Sender<()>>,
}

pub struct RtDialogueState {
    sessions: Mutex<HashMap<String, RtDialogueSession>>,
}

impl RtDialogueState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

fn rt_session_id() -> String {
    let count = SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("rtd-{}-{}", ts, count)
}

// ── Doubao Binary Protocol ────────────────────────────────────────────────────
//
// Reference: meow2149/meow-ai volc/client.go + volc/protocol.go
//
// Header (4 bytes):
//   byte 0: version(4b) | header_size(4b)  → 0x11 (v1, 4-word header)
//   byte 1: msg_type(4b) | type_flag(4b)
//     FullClient = 0x10, AudioOnlyClient = 0x20
//     WithEvent  = 0x04
//   byte 2: serialization(4b) | compression(4b)
//     JSON = 0x10, Raw = 0x00
//   byte 3: padding 0x00
//
// Body (FullClient + WithEvent + JSON):
//   [event i32 BE][session_id_len u32 BE][session_id bytes][payload_len u32 BE][payload]
//   Events 1 and 2 (StartConnection/FinishConnection) skip the session_id field.
//
// Body (AudioOnlyClient + WithEvent + Raw):
//   [event=200 i32 BE][session_id_len u32 BE][session_id bytes][payload_len u32 BE][pcm]

const DOUBAO_HEADER_V1H4: u8 = 0x11; // Version1 | HeaderSize4
const DOUBAO_FULL_CLIENT_EVENT: u8 = 0x14; // FullClient | WithEvent
const DOUBAO_AUDIO_CLIENT_EVENT: u8 = 0x24; // AudioOnlyClient | WithEvent
const DOUBAO_SER_JSON: u8 = 0x10;
const DOUBAO_SER_RAW: u8 = 0x00;

const DOUBAO_EVENT_START_CONNECTION: i32 = 1;
const DOUBAO_EVENT_FINISH_CONNECTION: i32 = 2;
const DOUBAO_EVENT_START_SESSION: i32 = 100;
const DOUBAO_EVENT_USER_QUERY: i32 = 200;
const DOUBAO_EVENT_CONNECTION_STARTED: i32 = 50;
const DOUBAO_EVENT_SESSION_STARTED: i32 = 150;

// Server message type upper nibbles
const DOUBAO_TYPE_FULL_SERVER: u8 = 0b1001;
const DOUBAO_TYPE_AUDIO_SERVER: u8 = 0b1011;
const DOUBAO_TYPE_ERROR: u8 = 0b1111;

/// Encode a FullClient binary message with JSON payload and optional session ID.
fn doubao_encode_full(event: i32, session_id: &str, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12 + session_id.len() + payload.len());
    buf.push(DOUBAO_HEADER_V1H4);
    buf.push(DOUBAO_FULL_CLIENT_EVENT);
    buf.push(DOUBAO_SER_JSON);
    buf.push(0x00);
    buf.extend_from_slice(&event.to_be_bytes());
    // Events 1 and 2 skip the session_id field.
    if event != DOUBAO_EVENT_START_CONNECTION && event != DOUBAO_EVENT_FINISH_CONNECTION {
        let sid = session_id.as_bytes();
        buf.extend_from_slice(&(sid.len() as u32).to_be_bytes());
        buf.extend_from_slice(sid);
    }
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
    buf
}

/// Encode an AudioOnlyClient binary message (raw PCM, event 200).
fn doubao_encode_audio(session_id: &str, pcm: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12 + session_id.len() + pcm.len());
    buf.push(DOUBAO_HEADER_V1H4);
    buf.push(DOUBAO_AUDIO_CLIENT_EVENT);
    buf.push(DOUBAO_SER_RAW);
    buf.push(0x00);
    buf.extend_from_slice(&DOUBAO_EVENT_USER_QUERY.to_be_bytes());
    let sid = session_id.as_bytes();
    buf.extend_from_slice(&(sid.len() as u32).to_be_bytes());
    buf.extend_from_slice(sid);
    buf.extend_from_slice(&(pcm.len() as u32).to_be_bytes());
    buf.extend_from_slice(pcm);
    buf
}

/// Decoded Doubao server message.
struct DoubaoMsg {
    msg_type: u8,   // upper nibble of byte[1]
    event: i32,
    payload: Vec<u8>,
}

/// Decode a Doubao server binary frame.
fn doubao_decode(data: &[u8]) -> Option<DoubaoMsg> {
    if data.len() < 4 {
        return None;
    }
    let type_and_flag = data[1];
    let msg_type = type_and_flag >> 4;
    let type_flag = type_and_flag & 0x0f;
    let has_sequence = (type_flag & 0b001) != 0 || (type_flag & 0b011 == 0b011);
    let has_event = (type_flag & 0b100) != 0;
    let header_size = ((data[0] & 0x0f) as usize) * 4;
    let mut pos = header_size;

    let mut event: i32 = 0;

    if has_sequence && !has_event {
        // Simple: [sequence i32][payload_len u32][payload]
        if pos + 4 > data.len() {
            return None;
        }
        pos += 4; // skip sequence
    }

    if has_event {
        if pos + 4 > data.len() {
            return None;
        }
        event = i32::from_be_bytes(data[pos..pos + 4].try_into().ok()?);
        pos += 4;

        // Session ID (skip for connection-level events 1, 2, 50, 51, 52)
        match event {
            1 | 2 | 50 | 51 | 52 => {}
            _ => {
                if pos + 4 > data.len() {
                    return None;
                }
                let sid_len = u32::from_be_bytes(data[pos..pos + 4].try_into().ok()?) as usize;
                pos += 4 + sid_len;
            }
        }
        // Connect ID (only for events 50, 51, 52)
        if matches!(event, 50 | 51 | 52) {
            if pos + 4 > data.len() {
                return None;
            }
            let cid_len = u32::from_be_bytes(data[pos..pos + 4].try_into().ok()?) as usize;
            pos += 4 + cid_len;
        }
    }

    // Error message carries a 4-byte error code before payload
    if msg_type == DOUBAO_TYPE_ERROR {
        pos += 4;
    }

    if pos + 4 > data.len() {
        return None;
    }
    let plen = u32::from_be_bytes(data[pos..pos + 4].try_into().ok()?) as usize;
    pos += 4;
    if pos + plen > data.len() {
        return None;
    }
    Some(DoubaoMsg {
        msg_type,
        event,
        payload: data[pos..pos + plen].to_vec(),
    })
}

/// Build a WebSocket request for a realtime dialogue provider, injecting
/// provider-specific auth headers without exposing secrets to the frontend.
fn build_rt_dialogue_request(
    provider: &str,
    base_url: &str,
    api_key: &str,
    app_id: &str,
    secret_key: &str,
    resource_id: &str,
    connect_id: &str,
) -> Result<WsRequest, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    if base_url.is_empty() {
        return Err("Realtime dialogue requires a base URL".to_string());
    }

    let mut req = base_url
        .into_client_request()
        .map_err(|e| format!("Invalid URL: {}", e))?;

    match provider {
        "doubao-realtime" => {
            // Doubao Realtime Dialogue headers (per official docs):
            //   X-Api-App-ID     = appId (App ID from Volcengine console, user-specific)
            //   X-Api-Access-Key = apiKey (Access Token from console, user-specific)
            //   X-Api-App-Key    = FIXED constant "PlgvMymc7f3tQnJ6" (same for all users)
            //   X-Api-Resource-Id = FIXED "volc.speech.dialog"
            if !app_id.is_empty() {
                req.headers_mut().insert(
                    "X-Api-App-ID",
                    app_id.parse().map_err(|_| "Invalid App-ID header".to_string())?,
                );
            }
            if !api_key.is_empty() {
                req.headers_mut().insert(
                    "X-Api-Access-Key",
                    api_key.parse().map_err(|_| "Invalid Access-Key header".to_string())?,
                );
            }
            // X-Api-App-Key is a fixed constant for all Doubao realtime users (per official docs)
            req.headers_mut().insert(
                "X-Api-App-Key",
                "PlgvMymc7f3tQnJ6".parse().map_err(|_| "Invalid App-Key header".to_string())?,
            );
            let effective_resource_id = if resource_id.is_empty() {
                "volc.speech.dialog".to_string()
            } else {
                resource_id.to_string()
            };
            req.headers_mut().insert(
                "X-Api-Resource-Id",
                effective_resource_id.parse().map_err(|_| "Invalid Resource-Id header".to_string())?,
            );
            if !connect_id.is_empty() {
                req.headers_mut().insert(
                    "X-Api-Connect-Id",
                    connect_id.parse().map_err(|_| "Invalid Connect-Id header".to_string())?,
                );
            }
        }
        "openai-realtime" => {
            if !api_key.is_empty() {
                req.headers_mut().insert(
                    "Authorization",
                    format!("Bearer {}", api_key)
                        .parse()
                        .map_err(|_| "Invalid API key".to_string())?,
                );
            }
            req.headers_mut().insert(
                "OpenAI-Beta",
                "realtime=v1".parse().map_err(|_| "header error".to_string())?,
            );
        }
        "gemini-live" => {
            if !api_key.is_empty() {
                // Gemini Live uses query param auth; append if not already present
                if !base_url.contains("key=") {
                    // Modify URL to add the key query param
                    let sep = if base_url.contains('?') { "&" } else { "?" };
                    let new_url = format!("{}{}key={}", base_url, sep, api_key);
                    req = new_url
                        .into_client_request()
                        .map_err(|e| format!("Invalid URL with key: {}", e))?;
                }
            }
        }
        _ => {
            // Generic: Bearer auth
            if !api_key.is_empty() {
                req.headers_mut().insert(
                    "Authorization",
                    format!("Bearer {}", api_key)
                        .parse()
                        .map_err(|_| "Invalid API key".to_string())?,
                );
            }
        }
    }

    Ok(req)
}

/// Start a realtime voice AI dialogue session.
///
/// For `doubao-realtime`: performs the Doubao binary-protocol handshake
/// (StartConnection → ConnectionStarted → StartSession → SessionStarted)
/// before notifying the frontend, then relays binary audio frames.
///
/// For other providers: connects WebSocket and relays JSON text + binary
/// audio using the OpenAI-compatible realtime protocol.
#[tauri::command]
pub async fn rt_dialogue_start(
    state: tauri::State<'_, RtDialogueState>,
    key_state: tauri::State<'_, super::ai_proxy::AIProxyState>,
    on_event: Channel<RtDialogueEvent>,
    config_id: String,
    provider: String,
    base_url: String,
    model: String,
    resource_id: Option<String>,
) -> Result<String, String> {
    // Look up secrets from OS Keychain
    key_state.ensure_secrets_loaded().await;
    let (api_key, app_id, secret_key) = {
        let cache = key_state
            .key_cache
            .lock()
            .map_err(|_| "Keychain lock poisoned".to_string())?;
        let key = cache.get(&format!("ai-rt-key:{}", config_id)).cloned().unwrap_or_default();
        let id = cache.get(&format!("ai-rt-appid:{}", config_id)).cloned().unwrap_or_default();
        let sk = cache.get(&format!("ai-rt-sk:{}", config_id)).cloned().unwrap_or_default();
        (key, id, sk)
    };
    let resource_id = resource_id.unwrap_or_default();
    let session_id = rt_session_id();

    // Generate a per-connection UUID-like ID for Doubao X-Api-Connect-Id
    let connect_id = {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let cnt = SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("{:016x}-{:016x}", ts, cnt)
    };

    let ws_request = build_rt_dialogue_request(
        &provider, &base_url, &api_key, &app_id, &secret_key, &resource_id, &connect_id,
    )?;

    // Connect WebSocket
    let (ws_stream, _response) = tokio_tungstenite::connect_async(ws_request)
        .await
        .map_err(|e| format!("WebSocket connection failed: {}", e))?;

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // ── Doubao binary-protocol path ───────────────────────────────────────────
    if provider == "doubao-realtime" {
        // 1. StartConnection (event 1)
        let start_conn = doubao_encode_full(DOUBAO_EVENT_START_CONNECTION, "", b"{}");
        ws_write
            .send(Message::Binary(start_conn))
            .await
            .map_err(|e| format!("StartConnection send failed: {}", e))?;

        // Wait for ConnectionStarted (event 50)
        loop {
            match ws_read.next().await {
                Some(Ok(Message::Binary(data))) => {
                    if let Some(msg) = doubao_decode(&data) {
                        if msg.event == DOUBAO_EVENT_CONNECTION_STARTED {
                            break;
                        } else if msg.event == 51 {
                            return Err("Doubao: connection rejected".to_string());
                        }
                    }
                }
                Some(Err(e)) => return Err(format!("WS error during connect: {}", e)),
                None => return Err("WS closed before ConnectionStarted".to_string()),
                _ => {}
            }
        }

        // 2. StartSession (event 100)
        // ws_session_id is the Doubao-level session UUID (distinct from our app session_id)
        let ws_session_id = {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as u64;
            format!("{:032x}", ts)
        };

        // Official Doubao O-version speaker IDs (default: vv):
        //   zh_female_vv_jupiter_bigtts, zh_female_xiaohe_jupiter_bigtts,
        //   zh_male_yunzhou_jupiter_bigtts, zh_male_xiaotian_jupiter_bigtts
        // Audio format: pcm_s16le @ 24000 Hz (per official docs)
        let start_sess_payload = serde_json::json!({
            "asr": { "extra": {} },
            "tts": {
                "speaker": "zh_female_vv_jupiter_bigtts",
                "audio_config": { "channel": 1, "format": "pcm_s16le", "sample_rate": 24000 }
            },
            "dialog": {
                "extra": {
                    "model": model,
                    "input_mod": "audio"
                }
            }
        });
        let payload_bytes = serde_json::to_vec(&start_sess_payload)
            .map_err(|e| format!("Serialize StartSession payload: {}", e))?;
        let start_sess = doubao_encode_full(DOUBAO_EVENT_START_SESSION, &ws_session_id, &payload_bytes);
        ws_write
            .send(Message::Binary(start_sess))
            .await
            .map_err(|e| format!("StartSession send failed: {}", e))?;

        // Wait for SessionStarted (event 150)
        loop {
            match ws_read.next().await {
                Some(Ok(Message::Binary(data))) => {
                    if let Some(msg) = doubao_decode(&data) {
                        if msg.event == DOUBAO_EVENT_SESSION_STARTED {
                            break;
                        } else if msg.msg_type == DOUBAO_TYPE_ERROR {
                            let err = String::from_utf8_lossy(&msg.payload).to_string();
                            return Err(format!("Doubao session error: {}", err));
                        }
                    }
                }
                Some(Err(e)) => return Err(format!("WS error during session start: {}", e)),
                None => return Err("WS closed before SessionStarted".to_string()),
                _ => {}
            }
        }

        // Session established — register channels and notify frontend
        let (text_tx, mut _text_rx) = mpsc::channel::<String>(64);
        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(64);
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let (reader_done_tx, reader_done_rx) = oneshot::channel::<()>();

        {
            let mut sessions = state
                .sessions
                .lock()
                .map_err(|_| "State lock poisoned".to_string())?;
            sessions.insert(
                session_id.clone(),
                RtDialogueSession { text_tx, audio_tx, stop_tx: Some(stop_tx) },
            );
        }

        let _ = on_event.send(RtDialogueEvent::Connected { session_id: session_id.clone() });

        let sid_w = session_id.clone();
        let on_event_w = on_event.clone();
        let ws_sid_w = ws_session_id.clone();

        // Writer task: encode PCM as Doubao binary AudioOnlyClient frames
        tokio::spawn(async move {
            let mut stop = stop_rx;
            let mut reader_done = reader_done_rx;
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stop => break,
                    _ = &mut reader_done => break,
                    audio = audio_rx.recv() => {
                        match audio {
                            Some(pcm) => {
                                let frame = doubao_encode_audio(&ws_sid_w, &pcm);
                                if ws_write.send(Message::Binary(frame)).await.is_err() {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
            let _ = ws_write.close().await;
            let _ = on_event_w.send(RtDialogueEvent::Disconnected { session_id: sid_w });
        });

        let sid_r = session_id.clone();

        // Reader task: decode Doubao binary frames and relay to frontend
        tokio::spawn(async move {
            while let Some(msg_result) = ws_read.next().await {
                match msg_result {
                    Ok(Message::Binary(data)) => {
                        if let Some(msg) = doubao_decode(&data) {
                            match msg.msg_type {
                                DOUBAO_TYPE_AUDIO_SERVER => {
                                    // TTS audio from AI → relay as base64
                                    let b64 = BASE64_STANDARD.encode(&msg.payload);
                                    let json = serde_json::json!({
                                        "type": "binary",
                                        "data": b64,
                                    })
                                    .to_string();
                                    let _ = on_event.send(RtDialogueEvent::Message {
                                        session_id: sid_r.clone(),
                                        data: json,
                                    });
                                }
                                DOUBAO_TYPE_ERROR => {
                                    let err = String::from_utf8_lossy(&msg.payload).to_string();
                                    let _ = on_event.send(RtDialogueEvent::Error {
                                        session_id: sid_r.clone(),
                                        error: err,
                                    });
                                }
                                _ => {
                                    // FullServer events (ASR, LLM text, etc.)
                                    if !msg.payload.is_empty() {
                                        let payload_val = serde_json::from_slice::<serde_json::Value>(&msg.payload)
                                            .unwrap_or(serde_json::Value::Null);
                                        let json = serde_json::json!({
                                            "doubaoEvent": msg.event,
                                            "payload": payload_val,
                                        })
                                        .to_string();
                                        let _ = on_event.send(RtDialogueEvent::Message {
                                            session_id: sid_r.clone(),
                                            data: json,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            let _ = reader_done_tx.send(());
        });

        return Ok(session_id);
    }

    // ── OpenAI-compatible path (openai-realtime, gemini-live, etc.) ───────────

    // Channels for frontend → server messages
    let (text_tx, mut text_rx) = mpsc::channel::<String>(64);
    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(64);
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let (reader_done_tx, reader_done_rx) = oneshot::channel::<()>();

    // Store session
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        sessions.insert(
            session_id.clone(),
            RtDialogueSession {
                text_tx,
                audio_tx,
                stop_tx: Some(stop_tx),
            },
        );
    }

    // Notify frontend: connected
    let _ = on_event.send(RtDialogueEvent::Connected { session_id: session_id.clone() });

    let sid_w = session_id.clone();
    let sid_r = session_id.clone();
    let on_event_clone = on_event.clone();

    // Writer task: relay text/audio from frontend to WS
    tokio::spawn(async move {
        let mut stop = stop_rx;
        let mut reader_done = reader_done_rx;
        loop {
            tokio::select! {
                biased;
                _ = &mut stop => break,
                _ = &mut reader_done => break,
                msg = text_rx.recv() => {
                    match msg {
                        Some(json) => {
                            if ws_write.send(Message::Text(json)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                audio = audio_rx.recv() => {
                    match audio {
                        Some(data) => {
                            if ws_write.send(Message::Binary(data)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
        let _ = ws_write.close().await;
        let _ = on_event_clone.send(RtDialogueEvent::Disconnected { session_id: sid_w });
    });

    // Reader task: relay WS messages to frontend
    tokio::spawn(async move {
        while let Some(msg_result) = ws_read.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    let _ = on_event.send(RtDialogueEvent::Message {
                        session_id: sid_r.clone(),
                        data: text,
                    });
                }
                Ok(Message::Binary(data)) => {
                    let b64 = BASE64_STANDARD.encode(&data);
                    let json = serde_json::json!({
                        "type": "binary",
                        "data": b64,
                    })
                    .to_string();
                    let _ = on_event.send(RtDialogueEvent::Message {
                        session_id: sid_r.clone(),
                        data: json,
                    });
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        let _ = reader_done_tx.send(());
    });

    Ok(session_id)
}

/// Send a JSON text message to the server within an active realtime dialogue session.
#[tauri::command]
pub async fn rt_dialogue_send_text(
    state: tauri::State<'_, RtDialogueState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let tx = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        sessions.get(&session_id).map(|s| s.text_tx.clone())
    };
    match tx {
        Some(tx) => tx.send(data).await.map_err(|_| "Session closed".to_string()),
        None => Err(format!("No active rt_dialogue session: {}", session_id)),
    }
}

/// Send a PCM audio chunk (base64-encoded) to the server.
#[tauri::command]
pub async fn rt_dialogue_send_audio(
    state: tauri::State<'_, RtDialogueState>,
    session_id: String,
    audio_b64: String,
) -> Result<(), String> {
    let data = BASE64_STANDARD
        .decode(&audio_b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let tx = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        sessions.get(&session_id).map(|s| s.audio_tx.clone())
    };
    match tx {
        Some(tx) => tx.send(data).await.map_err(|_| "Session closed".to_string()),
        None => Err(format!("No active rt_dialogue session: {}", session_id)),
    }
}

/// Stop a realtime dialogue session.
#[tauri::command]
pub async fn rt_dialogue_stop(
    state: tauri::State<'_, RtDialogueState>,
    session_id: String,
) -> Result<(), String> {
    let stop_tx = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        sessions.remove(&session_id).and_then(|mut s| s.stop_tx.take())
    };
    if let Some(tx) = stop_tx {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_transcript(json: &str) -> SpeechSegmentData {
        match parse_gladia("test-session", json) {
            Some(SpeechEvent::Transcript { segment, .. }) => segment,
            other => panic!("expected transcript event, got {:?}", other.map(|_| "other")),
        }
    }

    fn parse_error(json: &str) -> String {
        match parse_gladia("test-session", json) {
            Some(SpeechEvent::Error { error, .. }) => error,
            other => panic!("expected error event, got {:?}", other.map(|_| "other")),
        }
    }

    #[test]
    fn should_parse_gladia_v2_final_transcript() {
        let json = r#"{
            "type": "transcript",
            "data": {
                "is_final": true,
                "confidence": 0.92,
                "utterance": {
                    "text": "hello world",
                    "start": 1.2,
                    "end": 2.3,
                    "channel": 1
                }
            }
        }"#;

        let seg = parse_transcript(json);
        assert_eq!(seg.speaker_id, "SPEAKER_1");
        assert_eq!(seg.text, "hello world");
        assert_eq!(seg.start_ms, 1200);
        assert_eq!(seg.end_ms, 2300);
        assert_eq!(seg.confidence, 0.92);
        assert!(seg.is_final);
        assert!(seg.speech_final);
    }

    #[test]
    fn should_parse_gladia_v2_interim_transcript() {
        let json = r#"{
            "type": "transcript",
            "data": {
                "is_final": false,
                "confidence": 0.55,
                "utterance": {
                    "text": "partial",
                    "start": 0.5,
                    "end": 0.9,
                    "channel": "2"
                }
            }
        }"#;

        let seg = parse_transcript(json);
        assert_eq!(seg.speaker_id, "SPEAKER_2");
        assert_eq!(seg.text, "partial");
        assert!(!seg.is_final);
        assert!(!seg.speech_final);
    }

    #[test]
    fn should_parse_gladia_v2_error_event() {
        let json = r#"{"type":"error","error":"invalid token"}"#;
        let err = parse_error(json);
        assert_eq!(err, "invalid token");
    }

    #[test]
    fn should_parse_gladia_legacy_final_transcript() {
        let json = r#"{
            "event": "transcript",
            "type": "final",
            "transcription": "legacy final",
            "confidence": 0.88,
            "time_begin": 2.0,
            "time_end": 3.0,
            "speaker": "SPEAKER_7"
        }"#;

        let seg = parse_transcript(json);
        assert_eq!(seg.speaker_id, "SPEAKER_7");
        assert_eq!(seg.text, "legacy final");
        assert_eq!(seg.start_ms, 2000);
        assert_eq!(seg.end_ms, 3000);
        assert!(seg.is_final);
        assert!(seg.speech_final);
    }

    #[test]
    fn should_parse_gladia_legacy_partial_as_non_final() {
        let json = r#"{
            "event": "transcript",
            "type": "partial",
            "transcription": "legacy partial",
            "speaker": 3
        }"#;

        let seg = parse_transcript(json);
        assert_eq!(seg.speaker_id, "SPEAKER_3");
        assert_eq!(seg.text, "legacy partial");
        assert!(!seg.is_final);
        assert!(!seg.speech_final);
    }

    #[test]
    fn should_ignore_non_transcript_control_messages() {
        let json = r#"{"type":"start_session","data":{"session_id":"abc"}}"#;
        let event = parse_gladia("test-session", json);
        assert!(event.is_none());
    }

    #[test]
    fn should_normalize_gladia_http_base_urls() {
        assert_eq!(
            normalize_gladia_http_base("wss://api.gladia.io"),
            "https://api.gladia.io"
        );
        assert_eq!(
            normalize_gladia_http_base("ws://localhost:3000"),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_gladia_http_base("https://custom.example.com/"),
            "https://custom.example.com"
        );
    }

    #[test]
    fn should_map_legacy_solaria_model_to_accurate() {
        assert_eq!(gladia_legacy_model("solaria-1"), "accurate");
        assert_eq!(gladia_legacy_model("fast"), "fast");
    }

    #[test]
    fn should_detect_dashscope_ws_endpoint() {
        assert!(is_dashscope_ws_endpoint(
            "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
        ));
        assert!(is_dashscope_ws_endpoint(
            "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference"
        ));
        assert!(is_dashscope_ws_endpoint(
            "wss://dashscope-cn-beijing.aliyuncs.com/api-ws/v1/inference"
        ));
        assert!(!is_dashscope_ws_endpoint("wss://example.com/realtime"));
    }

    #[test]
    fn should_parse_dashscope_result_generated() {
        let json = r#"{
            "header": { "event": "result-generated" },
            "payload": {
                "output": {
                    "sentence": {
                        "text": "hello world",
                        "begin_time": 120,
                        "end_time": 860,
                        "sentence_end": true
                    }
                }
            }
        }"#;

        let event = parse_custom("test-session", json);
        let segment = match event {
            Some(SpeechEvent::Transcript { segment, .. }) => segment,
            _ => panic!("expected transcript event"),
        };
        assert_eq!(segment.text, "hello world");
        assert_eq!(segment.start_ms, 120);
        assert_eq!(segment.end_ms, 860);
        assert!(segment.is_final);
        assert!(segment.speech_final);
    }

    #[test]
    fn should_parse_dashscope_task_failed_error() {
        let json = r#"{
            "header": {
                "event": "task-failed",
                "error_message": "invalid appkey"
            }
        }"#;
        let event = parse_custom("test-session", json);
        let err = match event {
            Some(SpeechEvent::Error { error, .. }) => error,
            _ => panic!("expected error event"),
        };
        assert_eq!(err, "invalid appkey");
    }

    #[test]
    fn should_detect_custom_ws_modes() {
        assert_eq!(
            detect_custom_ws_mode(
                "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
                "fun-asr-realtime"
            ),
            CustomWsMode::DashScopeFunAsr
        );
        assert_eq!(
            detect_custom_ws_mode(
                "wss://asr.cloud.tencent.com/asr/v2/123?secretid=a",
                ""
            ),
            CustomWsMode::TencentAsrV2
        );
        assert_eq!(
            detect_custom_ws_mode("wss://iat-api-sg.xf-yun.com/v2/iat", ""),
            CustomWsMode::IflytekIatV2
        );
        assert_eq!(
            detect_custom_ws_mode(
                "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-transcribe",
                "gpt-4o-mini-transcribe"
            ),
            CustomWsMode::OpenAiRealtime
        );
        assert_eq!(
            detect_custom_ws_mode("wss://ai-gateway.vei.volces.com/v1/realtime", ""),
            CustomWsMode::VolcengineRealtime
        );
        // Model-based fallback: DashScope regional/custom gateway with same protocol.
        assert_eq!(
            detect_custom_ws_mode("wss://dashscope-cn-beijing.aliyuncs.com/api-ws/v1/inference", ""),
            CustomWsMode::DashScopeFunAsr
        );
        assert_eq!(
            detect_custom_ws_mode("wss://proxy.example.com/asr", "fun-asr-realtime"),
            CustomWsMode::DashScopeFunAsr
        );
    }

    #[test]
    fn should_parse_tencent_asr_transcript() {
        let json = r#"{
            "code": 0,
            "message": "success",
            "result": {
                "slice_type": 2,
                "start_time": 120,
                "end_time": 820,
                "voice_text_str": "hello world"
            }
        }"#;

        let event = parse_tencent_asr("test-session", json);
        let segment = match event {
            Some(SpeechEvent::Transcript { segment, .. }) => segment,
            _ => panic!("expected transcript event"),
        };
        assert_eq!(segment.text, "hello world");
        assert_eq!(segment.start_ms, 120);
        assert_eq!(segment.end_ms, 820);
        assert!(segment.is_final);
    }

    #[test]
    fn should_parse_tencent_asr_error() {
        let json = r#"{"code":4001,"message":"signature invalid"}"#;
        let event = parse_tencent_asr("test-session", json);
        let err = match event {
            Some(SpeechEvent::Error { error, .. }) => error,
            _ => panic!("expected error event"),
        };
        assert_eq!(err, "signature invalid");
    }

    #[test]
    fn should_parse_iflytek_iat_transcript() {
        let json = r#"{
            "code": 0,
            "data": {
                "status": 1,
                "result": {
                    "ws": [
                        { "cw": [ { "w": "hello " } ] },
                        { "cw": [ { "w": "world" } ] }
                    ]
                }
            }
        }"#;

        let event = parse_iflytek_iat("test-session", json);
        let segment = match event {
            Some(SpeechEvent::Transcript { segment, .. }) => segment,
            _ => panic!("expected transcript event"),
        };
        assert_eq!(segment.text, "hello world");
        assert!(!segment.is_final);
    }

    #[test]
    fn should_parse_iflytek_iat_error() {
        let json = r#"{"code":10005,"message":"auth fail"}"#;
        let event = parse_iflytek_iat("test-session", json);
        let err = match event {
            Some(SpeechEvent::Error { error, .. }) => error,
            _ => panic!("expected error event"),
        };
        assert_eq!(err, "auth fail");
    }

    #[test]
    fn should_treat_realtime_result_event_as_non_final() {
        let json = r#"{
            "type": "conversation.item.input_audio_transcription.result",
            "transcript": "partial phrase"
        }"#;

        let event = parse_custom("test-session", json);
        let segment = match event {
            Some(SpeechEvent::Transcript { segment, .. }) => segment,
            _ => panic!("expected transcript event"),
        };
        assert_eq!(segment.text, "partial phrase");
        assert!(!segment.is_final);
        assert!(!segment.speech_final);
    }

    #[test]
    fn should_build_iflytek_first_frame_with_common_and_business() {
        let frame = build_iflytek_audio_frame("appid123", "zh", &[1, 2, 3, 4], 0);
        let json: Value = serde_json::from_str(&frame).expect("iflytek frame should be json");
        assert_eq!(
            json.get("common")
                .and_then(|c| c.get("app_id"))
                .and_then(|v| v.as_str()),
            Some("appid123")
        );
        assert_eq!(
            json.get("business")
                .and_then(|b| b.get("language"))
                .and_then(|v| v.as_str()),
            Some("zh_cn")
        );
        assert_eq!(
            json.get("data")
                .and_then(|d| d.get("status"))
                .and_then(|v| v.as_i64()),
            Some(0)
        );
    }
}
