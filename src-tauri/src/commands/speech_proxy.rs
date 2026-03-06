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

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

// ── Session counter ──────────────────────────────────────────────────────────

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

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

fn is_dashscope_ws_endpoint(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("dashscope.aliyuncs.com/api-ws/v1/inference")
        || lower.contains("dashscope-intl.aliyuncs.com/api-ws/v1/inference")
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
    if msg_type.contains("error") || value.get("error").is_some() {
        let err = value
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
            .unwrap_or("Custom STT server error");
        return Some(SpeechEvent::Error {
            session_id: session_id.to_string(),
            error: err.to_string(),
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
        .or_else(|| value.get("data").and_then(|d| d.get("is_final")).and_then(|v| v.as_bool()))
        .or_else(|| value.get("data").and_then(|d| d.get("isFinal")).and_then(|v| v.as_bool()))
        .or_else(|| value.get("data").and_then(|d| d.get("final")).and_then(|v| v.as_bool()))
        .unwrap_or_else(|| {
            if msg_type.contains(".delta") || msg_type.contains("partial") || msg_type.contains("interim") {
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
    Ok(req)
}

// ── Dispatcher: parse provider response text → SpeechEvent ───────────────────

fn dispatch_message(provider: &str, session_id: &str, text: &str) -> Option<SpeechEvent> {
    match provider {
        "deepgram" => parse_deepgram(session_id, text),
        "assemblyai" => parse_assemblyai(session_id, text),
        "gladia" => parse_gladia(session_id, text),
        "custom" => parse_deepgram(session_id, text)
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
    let custom_dashscope_mode = provider == "custom" && is_dashscope_ws_endpoint(&base_url);
    let custom_dashscope_task_id = if custom_dashscope_mode {
        Some(dashscope_task_id())
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

    if custom_dashscope_mode {
        if let Some(task_id) = custom_dashscope_task_id.as_deref() {
            let run_task = build_dashscope_run_task(&model, task_id);
            ws_write
                .send(Message::Text(run_task))
                .await
                .map_err(|e| format!("DashScope run-task send failed: {}", e))?;
        }
    }

    // Audio chunk channel (frontend → writer task → WebSocket)
    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(64);
    // Stop signal (frontend → writer)
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    // Reader-done signal (reader → writer): tells writer to stop when server closes
    let (reader_done_tx, reader_done_rx) = oneshot::channel::<()>();

    // Register session
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        sessions.insert(
            session_id.clone(),
            SpeechSession {
                audio_tx,
                stop_tx: Some(stop_tx),
            },
        );
    }

    // Delay Connected for providers that expose an explicit server-ready event.
    let wait_for_begin = provider == "assemblyai" || custom_dashscope_mode;
    if !wait_for_begin {
        let _ = on_event.send(SpeechEvent::Connected {
            session_id: session_id.clone(),
        });
    }

    let dashscope_finish_msg = custom_dashscope_task_id
        .as_ref()
        .map(|task_id| build_dashscope_finish_task(task_id));
    let dashscope_finish_msg_w = dashscope_finish_msg.clone();
    let custom_dashscope_mode_r = custom_dashscope_mode;

    // ── Writer task: audio chunks → WebSocket Binary frames ──────────────────
    tokio::spawn(async move {
        let mut stop_rx = stop_rx;
        let mut reader_done_rx = reader_done_rx;
        loop {
            tokio::select! {
                biased;
                _ = &mut stop_rx => {
                    if let Some(msg) = dashscope_finish_msg_w.as_ref() {
                        let _ = ws_write.send(Message::Text(msg.clone())).await;
                    }
                    let _ = ws_write.send(Message::Close(None)).await;
                    break;
                }
                // Server closed connection — stop writing silently (reader already reported error)
                _ = &mut reader_done_rx => { break; }
                chunk = audio_rx.recv() => {
                    match chunk {
                        Some(data) => {
                            if ws_write.send(Message::Binary(data)).await.is_err() {
                                break;
                            }
                        }
                        None => {
                            // Channel closed — send graceful close
                            if let Some(msg) = dashscope_finish_msg_w.as_ref() {
                                let _ = ws_write.send(Message::Text(msg.clone())).await;
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
                        // DashScope custom ASR handshake
                        if custom_dashscope_mode_r {
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
    let stop_tx = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        sessions
            .remove(&session_id)
            .and_then(|mut s| s.stop_tx.take())
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
}
