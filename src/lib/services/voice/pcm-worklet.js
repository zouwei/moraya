// @ts-nocheck — runs inside AudioWorklet thread (own global scope)
/**
 * AudioWorklet processor: converts Float32 input → Int16 PCM and posts
 * accumulated chunks (~250ms) to the main thread via MessagePort.
 *
 * Runs inside the AudioWorklet thread — no ES module imports allowed.
 */
class PcmSender extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Int16Array[]} */
    this._buffer = [];
    this._sampleCount = 0;
    // ~250ms at 16kHz.  Smaller chunks give real-time streaming feedback from the
    // STT provider.  IPC flooding is prevented by the `sending` guard in
    // speech-service.ts, and the O(n) Base64 encoder keeps the main thread free.
    this._chunkSamples = 4000;
  }

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean}
   */
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    // Convert float32 [-1,1] → int16
    const int16 = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      int16[i] = Math.round(clamped * 32767);
    }

    this._buffer.push(int16);
    this._sampleCount += int16.length;

    if (this._sampleCount >= this._chunkSamples) {
      // Concatenate buffered slices into a single Int16Array
      const merged = new Int16Array(this._sampleCount);
      let offset = 0;
      for (const slice of this._buffer) {
        merged.set(slice, offset);
        offset += slice.length;
      }
      // Transfer ownership to the main thread (zero-copy)
      this.port.postMessage(merged.buffer, [merged.buffer]);
      this._buffer = [];
      this._sampleCount = 0;
    }

    return true;
  }
}

registerProcessor('pcm-sender', PcmSender);
