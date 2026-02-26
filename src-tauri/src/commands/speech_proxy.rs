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

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
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
    Disconnected {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

// ── Deepgram JSON parsing ─────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct DgWord {
    speaker: Option<u32>,
    start: Option<f64>,
    end: Option<f64>,
    confidence: Option<f64>,
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
struct GladiaMessage {
    event: Option<String>,
    #[serde(rename = "type")]
    msg_type: Option<String>,
    transcription: Option<String>,
    confidence: Option<f64>,
    time_begin: Option<f64>,
    time_end: Option<f64>,
    speaker: Option<serde_json::Value>,
}

fn parse_gladia(session_id: &str, text: &str) -> Option<SpeechEvent> {
    let msg: GladiaMessage = serde_json::from_str(text).ok()?;
    if msg.event.as_deref() != Some("transcript") {
        return None;
    }
    if msg.msg_type.as_deref() != Some("final") {
        return None;
    }
    let transcript = msg.transcription.unwrap_or_default().trim().to_string();
    if transcript.is_empty() {
        return None;
    }
    let speaker_id = msg
        .speaker
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "SPEAKER_0".to_string());

    Some(SpeechEvent::Transcript {
        session_id: session_id.to_string(),
        segment: SpeechSegmentData {
            speaker_id,
            text: transcript,
            start_ms: (msg.time_begin.unwrap_or(0.0) * 1000.0) as u64,
            end_ms: (msg.time_end.unwrap_or(0.0) * 1000.0) as u64,
            confidence: msg.confidence.unwrap_or(0.0),
            is_final: true,
            speech_final: true, // Gladia only emits final utterances
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

fn gladia_request(base_url: &str, api_key: &str) -> Result<WsRequest, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let host = if base_url.is_empty() { "wss://api.gladia.io" } else { base_url.trim_end_matches('/') };
    let url = format!("{}/audio/text/audio-transcription", host);
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "X-Gladia-Key",
        api_key.parse().map_err(|_| "Invalid API key".to_string())?,
    );
    Ok(req)
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
    key_state.ensure_secrets_loaded();
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

    // Build provider-specific WebSocket request (with auth headers)
    let ws_request = match provider.as_str() {
        "deepgram" => deepgram_request(&base_url, &api_key, &model, &language),
        "gladia" => gladia_request(&base_url, &api_key),
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

    // For Gladia: send config JSON immediately after handshake
    if provider == "gladia" {
        let config = serde_json::json!({
            "x_gladia_key": api_key,
            "frames_format": "bytes",
            "sample_rate": 16000,
            "bit_depth": 16,
            "channels": 1,
            "encoding": "WAV/PCM",
            "model_type": model,
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

    // AssemblyAI v3 sends a "Begin" message to confirm the session is ready.
    // Delay our Connected event until then so mic starts only after the server
    // is truly ready to receive audio. All other providers get Connected now.
    let wait_for_begin = provider == "assemblyai";
    if !wait_for_begin {
        let _ = on_event.send(SpeechEvent::Connected {
            session_id: session_id.clone(),
        });
    }

    // ── Writer task: audio chunks → WebSocket Binary frames ──────────────────
    tokio::spawn(async move {
        let mut stop_rx = stop_rx;
        let mut reader_done_rx = reader_done_rx;
        loop {
            tokio::select! {
                biased;
                _ = &mut stop_rx => {
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

                    // AssemblyAI: emit Connected on the "Begin" message so the
                    // mic starts only after the server is ready.
                    if !connected_emitted {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            if val.get("type").and_then(|t| t.as_str()) == Some("Begin") {
                                let _ = on_event.send(SpeechEvent::Connected {
                                    session_id: sid_r.clone(),
                                });
                                connected_emitted = true;
                                continue; // "Begin" is not a transcript event
                            }
                        }
                        // Not a Begin yet — keep waiting (don't parse as transcript)
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
                Ok(Message::Binary(data)) => {
                    // AssemblyAI should not send binary frames — log if this happens
                    #[cfg(debug_assertions)]
                    eprintln!("[speech_proxy:{}] ← binary frame {} bytes", provider_r, data.len());
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
