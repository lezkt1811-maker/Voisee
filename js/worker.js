// TTS worker: loads Kokoro-82M once and generates audio for individual text
// chunks off the main thread so the UI stays responsive while a book is
// being read. Runs entirely locally in the browser - no server, API key, or
// account involved.
//
// Defaults to the WebAssembly backend. WebGPU is opt-in only: this model's
// vocoder relies on signal-processing ops that some phones' WebGPU
// implementations execute incorrectly today, producing garbled/high-pitched
// audio instead of speech (with no error thrown, so we can't auto-detect
// and fall back). WASM is slower but reliably correct everywhere.

import { KokoroTTS } from '../vendor/kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null;
let modelReady = false;
let device = null;
let dtype = null;

// Two-lane queue: voice previews jump ahead of book-chunk generation since
// the user is actively waiting on them.
const chunkQueue = [];
const previewQueue = [];
let processing = false;

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      initModel(!!msg.tryWebGpu);
      break;
    case 'generate':
      if (msg.kind === 'preview') {
        previewQueue.push(msg);
      } else {
        chunkQueue.push(msg);
      }
      processQueue();
      break;
    case 'clearChunkQueue':
      chunkQueue.length = 0;
      break;
    default:
      break;
  }
};

async function initModel(tryWebGpu) {
  const hasWebGPU = tryWebGpu && typeof navigator !== 'undefined' && !!navigator.gpu;
  const attempts = hasWebGPU
    ? [
        { device: 'webgpu', dtype: 'fp32' },
        { device: 'wasm', dtype: 'q8' },
      ]
    : [{ device: 'wasm', dtype: 'q8' }];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: attempt.dtype,
        device: attempt.device,
        progress_callback: (data) => {
          self.postMessage({ type: 'progress', data });
        },
      });
      device = attempt.device;
      dtype = attempt.dtype;
      modelReady = true;
      self.postMessage({ type: 'ready', device, dtype });
      processQueue();
      return;
    } catch (err) {
      lastErr = err;
      self.postMessage({
        type: 'log',
        message: `Voice engine init failed on ${attempt.device}/${attempt.dtype}: ${err && err.message ? err.message : err}`,
      });
    }
  }
  self.postMessage({
    type: 'init-error',
    message: lastErr && lastErr.message ? lastErr.message : String(lastErr),
  });
}

async function processQueue() {
  if (processing || !modelReady) return;
  processing = true;
  try {
    while (previewQueue.length > 0 || chunkQueue.length > 0) {
      const job = previewQueue.length > 0 ? previewQueue.shift() : chunkQueue.shift();
      await runJob(job);
    }
  } finally {
    processing = false;
  }
}

async function runJob(job) {
  try {
    const audio = await tts.generate(job.text, { voice: job.voice, speed: 1 });
    const wavBuffer = audio.toWav();
    const duration = audio.audio.length / audio.sampling_rate;
    self.postMessage(
      {
        type: 'result',
        id: job.id,
        kind: job.kind,
        voice: job.voice,
        duration,
        wavBuffer,
      },
      [wavBuffer]
    );
  } catch (err) {
    self.postMessage({
      type: 'gen-error',
      id: job.id,
      kind: job.kind,
      message: err && err.message ? err.message : String(err),
    });
  }
}
