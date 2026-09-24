import { buildSentences } from './textSplit.js';
import { hashText, saveBook, loadBook, loadSettings, saveSettings } from './db.js';
import { VOICES, DEFAULT_VOICE, PREVIEW_TEXT, voiceById } from './voices.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  bookId: null,
  fullText: '',
  paragraphs: [],
  sentences: [],
  paraToSentenceIndices: [],
  bookRecord: null,
  voice: DEFAULT_VOICE,
  rate: 1,
  playIndex: 0,
  isPlaying: false,
  requestSeq: 0,
  cache: new Map(), // sentenceIndex -> {url, duration}
  pendingIndices: new Set(),
  jobIndexById: new Map(),
  latestRequestIdForIndex: new Map(),
  retryCount: new Map(),
};

const chunkWaiters = new Map(); // sentenceIndex -> [resolve, ...]
const previewCache = new Map(); // voiceId -> {url, duration}
const previewJobs = new Map(); // jobId -> {voiceId, btnEl}
let previewSeq = 0;
let workerInitStarted = false;
let isDraggingSlider = false;
let saveTimer = null;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
let worker = createWorker();

function createWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = handleWorkerMessage;
  w.onerror = (e) => {
    setStatus(`Voice engine crashed: ${e.message || 'unknown error'}. Tap Retry.`, 'error');
    showEngineRetry();
  };
  return w;
}

function ensureWorkerInit() {
  if (workerInitStarted) return;
  workerInitStarted = true;
  const tryWebGpu = !!loadSettings().tryWebGpu;
  els.webgpuCheckbox.disabled = true;
  setStatus('Loading local voice engine (first time only — will be cached)…', 'busy');
  els.engineProgress.classList.remove('hidden');
  worker.postMessage({ type: 'init', tryWebGpu });
}

function retryEngine() {
  try {
    worker.terminate();
  } catch (err) {
    /* ignore */
  }
  worker = createWorker();
  workerInitStarted = false;
  els.engineRetry.classList.add('hidden');

  // Any chunk/preview jobs queued on the terminated worker are lost - drop the
  // "pending" markers so they get re-requested fresh against the new worker.
  state.pendingIndices.clear();
  for (const btnEl of document.querySelectorAll('.voice-preview.loading')) {
    btnEl.classList.remove('loading');
  }
  previewJobs.clear();

  ensureWorkerInit();
  scheduleLookahead();
}

function handleWorkerMessage(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'progress':
      handleProgress(msg.data);
      break;
    case 'ready':
      els.engineProgress.classList.add('hidden');
      setStatus(`Voice engine ready (${msg.device === 'webgpu' ? 'WebGPU' : 'WebAssembly'}).`, 'ready');
      scheduleLookahead();
      break;
    case 'init-error':
      setStatus(`Voice engine failed to load: ${msg.message}`, 'error');
      showEngineRetry();
      break;
    case 'log':
      // eslint-disable-next-line no-console
      console.warn(msg.message);
      break;
    case 'result':
      if (msg.kind === 'preview') handlePreviewResult(msg);
      else handleChunkResult(msg);
      break;
    case 'gen-error':
      if (msg.kind === 'preview') handlePreviewError(msg);
      else handleChunkError(msg);
      break;
    default:
      break;
  }
}

function showEngineRetry() {
  els.engineRetry.classList.remove('hidden');
}

function handleProgress(data) {
  if (!data) return;
  if (data.status === 'progress' && typeof data.progress === 'number') {
    const pct = Math.round(data.progress);
    els.engineProgress.classList.remove('hidden');
    els.engineProgressBar.style.width = `${pct}%`;
    els.engineProgressLabel.textContent = `Downloading voice model… ${pct}%${data.file ? ' (' + data.file + ')' : ''}`;
  } else if (data.status === 'done') {
    els.engineProgressLabel.textContent = 'Preparing voice engine…';
  }
}

function handleChunkResult(msg) {
  const index = state.jobIndexById.get(msg.id);
  state.jobIndexById.delete(msg.id);
  if (index === undefined) return;
  state.pendingIndices.delete(index);
  if (state.latestRequestIdForIndex.get(index) !== msg.id) return; // stale, superseded
  const blob = new Blob([msg.wavBuffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const entry = { url, duration: msg.duration };
  state.cache.set(index, entry);
  state.retryCount.delete(index);
  pruneCache();
  const waiters = chunkWaiters.get(index);
  if (waiters) {
    chunkWaiters.delete(index);
    waiters.forEach((fn) => fn(entry));
  }
  if (index === state.playIndex) updateProgressUI();
  scheduleLookahead();
}

function handleChunkError(msg) {
  const index = state.jobIndexById.get(msg.id);
  state.jobIndexById.delete(msg.id);
  if (index === undefined) return;
  state.pendingIndices.delete(index);
  const retries = (state.retryCount.get(index) || 0) + 1;
  state.retryCount.set(index, retries);
  if (retries <= 3) {
    setStatus(`Retrying sentence ${index + 1}…`, 'error');
    setTimeout(() => ensureGenerated(index), 1200);
  } else {
    setStatus(`Skipped sentence ${index + 1} after repeated errors: ${msg.message}`, 'error');
    const waiters = chunkWaiters.get(index);
    if (waiters) {
      chunkWaiters.delete(index);
      // Resolve waiters with a tiny silent stub so playback can move on.
      waiters.forEach((fn) => fn({ url: null, duration: 0, failed: true }));
    }
  }
}

function handlePreviewResult(msg) {
  const job = previewJobs.get(msg.id);
  previewJobs.delete(msg.id);
  const blob = new Blob([msg.wavBuffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  previewCache.set(msg.voice, { url, duration: msg.duration });
  if (job) job.btnEl.classList.remove('loading');
  els.previewPlayer.src = url;
  els.previewPlayer.playbackRate = 1;
  els.previewPlayer.play().catch(() => {});
}

function handlePreviewError(msg) {
  const job = previewJobs.get(msg.id);
  previewJobs.delete(msg.id);
  if (job) job.btnEl.classList.remove('loading');
  setStatus(`Voice preview failed: ${msg.message}`, 'error');
}

// ---------------------------------------------------------------------------
// Generation / cache management
// ---------------------------------------------------------------------------
const LOOKAHEAD = 10;
const KEEP_BEHIND = 15;
const KEEP_AHEAD = 40;

function ensureGenerated(index) {
  if (index < 0 || index >= state.sentences.length) return;
  if (state.cache.has(index) || state.pendingIndices.has(index)) return;
  const id = ++state.requestSeq;
  state.pendingIndices.add(index);
  state.jobIndexById.set(id, index);
  state.latestRequestIdForIndex.set(index, id);
  ensureWorkerInit();
  worker.postMessage({
    type: 'generate',
    kind: 'chunk',
    id,
    text: state.sentences[index].text,
    voice: state.voice,
  });
}

function scheduleLookahead() {
  const end = Math.min(state.sentences.length, state.playIndex + LOOKAHEAD);
  for (let i = state.playIndex; i < end; i++) ensureGenerated(i);
}

function pruneCache() {
  for (const idx of [...state.cache.keys()]) {
    if (idx < state.playIndex - KEEP_BEHIND || idx > state.playIndex + KEEP_AHEAD) {
      const entry = state.cache.get(idx);
      if (entry.url && entry.url !== els.player.src) {
        URL.revokeObjectURL(entry.url);
      }
      state.cache.delete(idx);
    }
  }
}

function waitForChunk(index) {
  const cached = state.cache.get(index);
  if (cached) return Promise.resolve(cached);
  setStatus(`Generating audio for sentence ${index + 1} of ${state.sentences.length}…`, 'busy');
  ensureGenerated(index);
  return new Promise((resolve) => {
    if (!chunkWaiters.has(index)) chunkWaiters.set(index, []);
    chunkWaiters.get(index).push(resolve);
  });
}

// ---------------------------------------------------------------------------
// Playback engine
// ---------------------------------------------------------------------------
// Browsers only allow audio.play() to start playback without a fresh user
// tap for a short window after a click. playFrom() awaits chunk generation
// first, which can easily take longer than that window (especially the
// first chunk, or the very first use before the engine has warmed up) - so
// play() can be silently blocked by autoplay policy. Surface that clearly
// instead of failing silently: the chunk is already cached at that point,
// so tapping Play again immediately succeeds (it's a fresh gesture).
async function attemptPlay() {
  try {
    await els.player.play();
    state.isPlaying = true;
    return true;
  } catch (err) {
    state.isPlaying = false;
    setStatus('Audio is ready — tap ▶ Play once more to start it (your browser needs a fresh tap).', 'ready');
    return false;
  }
}

async function playFrom(index, offset = 0, autoplay = true) {
  if (!state.sentences.length) return;
  index = Math.max(0, Math.min(state.sentences.length - 1, index));
  state.playIndex = index;
  updateHighlight();
  scheduleLookahead();
  persistPositionThrottled();

  const requestedIndex = index;
  const entry = await waitForChunk(index);
  if (state.playIndex !== requestedIndex) return; // user navigated elsewhere while waiting

  if (entry.failed) {
    // Skip a sentence we could not synthesize after retries.
    if (index + 1 < state.sentences.length) playFrom(index + 1, 0, autoplay);
    return;
  }

  if (els.player.src !== entry.url) {
    els.player.src = entry.url;
  }
  els.player.playbackRate = state.rate;
  const safeOffset = Math.min(Math.max(offset, 0), Math.max(entry.duration - 0.05, 0));
  try {
    els.player.currentTime = safeOffset;
  } catch (err) {
    /* metadata not ready yet on some browsers; ignore */
  }
  if (autoplay) {
    await attemptPlay();
  }
  updateTransportUI();
  updateProgressUI();
}

function onChunkEnded() {
  if (state.playIndex + 1 < state.sentences.length) {
    playFrom(state.playIndex + 1, 0, true);
  } else {
    state.isPlaying = false;
    updateTransportUI();
    setStatus('Finished the book.', 'ready');
    persistPositionThrottled(true);
  }
}

function togglePlayPause() {
  if (!state.sentences.length) return;
  if (state.isPlaying) {
    els.player.pause();
    state.isPlaying = false;
    updateTransportUI();
    persistPositionThrottled(true);
  } else if (els.player.src && !els.player.ended) {
    els.player.playbackRate = state.rate;
    attemptPlay().then(() => updateTransportUI());
  } else {
    playFrom(state.playIndex, 0, true);
  }
}

function stopPlayback() {
  els.player.pause();
  els.player.currentTime = 0;
  state.isPlaying = false;
  updateTransportUI();
  updateProgressUI();
  persistPositionThrottled(true);
}

async function seekRelative(deltaSeconds) {
  if (!state.sentences.length) return;
  const dur = state.cache.get(state.playIndex)?.duration ?? els.player.duration ?? 0;
  const target = (els.player.currentTime || 0) + deltaSeconds;
  if (target < 0) {
    if (state.playIndex <= 0) {
      els.player.currentTime = 0;
      return;
    }
    await playFrom(state.playIndex - 1, 0, state.isPlaying);
    return;
  }
  if (dur && target > dur) {
    const overflow = target - dur;
    if (state.playIndex + 1 < state.sentences.length) {
      await playFrom(state.playIndex + 1, overflow, state.isPlaying);
    } else {
      els.player.currentTime = dur;
    }
    return;
  }
  els.player.currentTime = target;
  updateProgressUI();
}

function prevSentence() {
  playFrom(state.playIndex - 1, 0, true);
}
function nextSentence() {
  playFrom(state.playIndex + 1, 0, true);
}

function prevParagraph() {
  if (!state.sentences.length) return;
  const curPara = state.sentences[state.playIndex].paraIndex;
  let idx = state.playIndex;
  while (idx > 0 && state.sentences[idx - 1].paraIndex === curPara) idx--;
  if (idx > 0) {
    const prevPara = state.sentences[idx - 1].paraIndex;
    while (idx > 0 && state.sentences[idx - 1].paraIndex === prevPara) idx--;
  }
  playFrom(idx, 0, true);
}

function nextParagraph() {
  if (!state.sentences.length) return;
  const curPara = state.sentences[state.playIndex].paraIndex;
  let idx = state.playIndex;
  while (idx < state.sentences.length && state.sentences[idx].paraIndex === curPara) idx++;
  playFrom(Math.min(idx, state.sentences.length - 1), 0, true);
}

function setRate(r) {
  state.rate = r;
  saveSettings({ rate: r });
  els.player.playbackRate = r;
  els.rateLabel.textContent = `${r.toFixed(2)}x`;
}

function setVoice(id) {
  if (state.voice === id) return;
  state.voice = id;
  saveSettings({ voice: id });
  // Drop not-yet-played cached/pending chunks so upcoming audio uses the new voice.
  for (const idx of [...state.cache.keys()]) {
    if (idx > state.playIndex) {
      const entry = state.cache.get(idx);
      if (entry.url) URL.revokeObjectURL(entry.url);
      state.cache.delete(idx);
    }
  }
  state.pendingIndices.clear();
  worker.postMessage({ type: 'clearChunkQueue' });
  updateVoiceUI();
  // Only re-request lookahead audio if playback has already started (and so
  // the engine is already loading/loaded) - just picking a voice shouldn't
  // by itself trigger the one-time engine download.
  if (workerInitStarted) scheduleLookahead();
}

// ---------------------------------------------------------------------------
// Text loading
// ---------------------------------------------------------------------------
function indexParagraphs() {
  state.paraToSentenceIndices = state.paragraphs.map(() => []);
  state.sentences.forEach((s, i) => {
    state.paraToSentenceIndices[s.paraIndex].push(i);
  });
}

function resetPlaybackState() {
  els.player.pause();
  els.player.removeAttribute('src');
  for (const entry of state.cache.values()) {
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  state.cache.clear();
  state.pendingIndices.clear();
  state.jobIndexById.clear();
  state.latestRequestIdForIndex.clear();
  state.retryCount.clear();
  chunkWaiters.clear();
  worker.postMessage({ type: 'clearChunkQueue' });
  state.isPlaying = false;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function loadBookFromText(text, { resume = true } = {}) {
  const trimmed = text.trim();
  if (!trimmed) {
    setStatus('Please paste some text first.', 'error');
    return;
  }
  setStatus('Analyzing text…', 'busy');
  await nextFrame();

  const id = hashText(trimmed);
  const { paragraphs, sentences } = buildSentences(trimmed);
  if (!sentences.length) {
    setStatus('No readable sentences were found in that text.', 'error');
    return;
  }

  resetPlaybackState();
  state.bookId = id;
  state.fullText = trimmed;
  state.paragraphs = paragraphs;
  state.sentences = sentences;
  indexParagraphs();

  let startIndex = 0;
  if (resume) {
    const saved = await loadBook(id).catch(() => null);
    if (saved && typeof saved.sentenceIndex === 'number') {
      startIndex = Math.min(saved.sentenceIndex, sentences.length - 1);
    }
  }
  state.playIndex = startIndex;
  state.bookRecord = {
    id,
    text: trimmed,
    sentenceCount: sentences.length,
    sentenceIndex: startIndex,
    updatedAt: Date.now(),
  };
  await saveBook(state.bookRecord);
  saveSettings({ lastBookId: id });

  showReaderView();
  renderTranscriptWindow();
  updateProgressUI();
  updateTransportUI();
  setStatus(
    startIndex > 0
      ? `Resumed at sentence ${startIndex + 1} of ${sentences.length}. Tap Play to continue.`
      : `Loaded ${sentences.length} sentences across ${paragraphs.length} paragraphs. Tap Play to begin.`,
    'ready'
  );
  // Deliberately not calling scheduleLookahead() here: it triggers the local
  // voice engine's (large, one-time) download, which should only start once
  // the reader explicitly asks for audio (Play or a voice preview).
}

function persistPositionThrottled(immediate = false) {
  if (!state.bookRecord) return;
  const flush = () => {
    state.bookRecord.sentenceIndex = state.playIndex;
    state.bookRecord.updatedAt = Date.now();
    saveBook(state.bookRecord).catch(() => {});
  };
  if (immediate) {
    clearTimeout(saveTimer);
    flush();
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 2500);
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------
const els = {};

function cacheEls() {
  const ids = [
    'textInput',
    'charCount',
    'loadBookBtn',
    'inputView',
    'readerView',
    'newTextBtn',
    'cancelNewTextBtn',
    'transcript',
    'statusDisplay',
    'progressSlider',
    'sentenceLabel',
    'timeLabel',
    'playPauseBtn',
    'stopBtn',
    'rewindBtn',
    'forwardBtn',
    'prevSentenceBtn',
    'nextSentenceBtn',
    'prevParaBtn',
    'nextParaBtn',
    'rateSlider',
    'rateLabel',
    'webgpuCheckbox',
    'voiceGrid',
    'player',
    'previewPlayer',
    'engineProgress',
    'engineProgressBar',
    'engineProgressLabel',
    'engineRetry',
    'engineRetryBtn',
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function setStatus(text, kind = 'ready') {
  els.statusDisplay.textContent = text;
  els.statusDisplay.className = `status status-${kind}`;
}

function showReaderView() {
  els.inputView.classList.add('hidden');
  els.readerView.classList.remove('hidden');
}
function showInputView() {
  els.readerView.classList.add('hidden');
  els.inputView.classList.remove('hidden');
  els.cancelNewTextBtn.classList.toggle('hidden', !state.bookId);
}

function renderTranscriptWindow() {
  if (!state.sentences.length) return;
  const curPara = state.sentences[state.playIndex].paraIndex;
  els.transcript.dataset.paraCenter = String(curPara);
  const paraIndices = [curPara - 1, curPara, curPara + 1].filter(
    (p) => p >= 0 && p < state.paragraphs.length
  );
  els.transcript.innerHTML = '';
  for (const p of paraIndices) {
    const pEl = document.createElement('p');
    pEl.className = 'para' + (p === curPara ? ' para-current' : '');
    for (const i of state.paraToSentenceIndices[p]) {
      const span = document.createElement('span');
      span.textContent = state.sentences[i].text + ' ';
      span.dataset.index = String(i);
      span.className = 'sentence' + (i === state.playIndex ? ' active' : '');
      span.addEventListener('click', () => playFrom(i, 0, true));
      pEl.appendChild(span);
    }
    els.transcript.appendChild(pEl);
  }
  const activeEl = els.transcript.querySelector('.sentence.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function updateHighlight() {
  if (!state.sentences.length) return;
  const curPara = state.sentences[state.playIndex].paraIndex;
  if (Number(els.transcript.dataset.paraCenter) !== curPara) {
    renderTranscriptWindow();
    return;
  }
  const prevActive = els.transcript.querySelector('.sentence.active');
  if (prevActive) prevActive.classList.remove('active');
  const el = els.transcript.querySelector(`[data-index="${state.playIndex}"]`);
  if (el) {
    el.classList.add('active');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateProgressUI() {
  if (!state.sentences.length) return;
  const dur = state.cache.get(state.playIndex)?.duration ?? els.player.duration ?? 0;
  const within = dur > 0 ? els.player.currentTime / dur : 0;
  const frac = (state.playIndex + within) / state.sentences.length;
  if (!isDraggingSlider) els.progressSlider.value = String(Math.round(frac * 1000));
  els.sentenceLabel.textContent = `Sentence ${state.playIndex + 1} / ${state.sentences.length}`;
  els.timeLabel.textContent = `${formatTime(els.player.currentTime || 0)}${
    dur ? ' / ' + formatTime(dur) : ''
  }`;
}

function updateTransportUI() {
  els.playPauseBtn.textContent = state.isPlaying ? '⏸ Pause' : '▶ Play';
  const hasBook = state.sentences.length > 0;
  for (const btn of [
    els.playPauseBtn,
    els.stopBtn,
    els.rewindBtn,
    els.forwardBtn,
    els.prevSentenceBtn,
    els.nextSentenceBtn,
    els.prevParaBtn,
    els.nextParaBtn,
  ]) {
    btn.disabled = !hasBook;
  }
}

function renderVoiceGrid() {
  els.voiceGrid.innerHTML = '';
  for (const v of VOICES) {
    const row = document.createElement('div');
    row.className = 'voice-row';
    row.dataset.voice = v.id;

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'voice-select';
    selectBtn.innerHTML = `<span class="voice-name">${v.emoji ? v.emoji + ' ' : ''}${v.name}</span><span class="voice-meta">${v.lang} · ${v.gender}</span><span class="voice-grade">${v.grade}</span>`;
    selectBtn.addEventListener('click', () => setVoice(v.id));

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'voice-preview';
    previewBtn.title = `Preview ${v.name}`;
    previewBtn.textContent = '🔊';
    previewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playPreview(v.id, previewBtn);
    });

    row.appendChild(selectBtn);
    row.appendChild(previewBtn);
    els.voiceGrid.appendChild(row);
  }
  updateVoiceUI();
}

function updateVoiceUI() {
  for (const row of els.voiceGrid.children) {
    row.classList.toggle('active', row.dataset.voice === state.voice);
  }
}

function playPreview(voiceId, btnEl) {
  const cached = previewCache.get(voiceId);
  if (cached) {
    els.previewPlayer.src = cached.url;
    els.previewPlayer.playbackRate = 1;
    els.previewPlayer.play().catch(() => {});
    return;
  }
  btnEl.classList.add('loading');
  ensureWorkerInit();
  const id = ++previewSeq;
  previewJobs.set(id, { voiceId, btnEl });
  worker.postMessage({ type: 'generate', kind: 'preview', id, text: PREVIEW_TEXT, voice: voiceId });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wireUI() {
  els.textInput.addEventListener('input', () => {
    els.charCount.textContent = String(els.textInput.value.length);
  });

  els.loadBookBtn.addEventListener('click', () => loadBookFromText(els.textInput.value));
  els.newTextBtn.addEventListener('click', () => {
    els.textInput.value = '';
    els.charCount.textContent = '0';
    showInputView();
  });
  els.cancelNewTextBtn.addEventListener('click', () => showReaderView());

  els.playPauseBtn.addEventListener('click', togglePlayPause);
  els.stopBtn.addEventListener('click', stopPlayback);
  els.rewindBtn.addEventListener('click', () => seekRelative(-10));
  els.forwardBtn.addEventListener('click', () => seekRelative(10));
  els.prevSentenceBtn.addEventListener('click', prevSentence);
  els.nextSentenceBtn.addEventListener('click', nextSentence);
  els.prevParaBtn.addEventListener('click', prevParagraph);
  els.nextParaBtn.addEventListener('click', nextParagraph);

  els.rateSlider.addEventListener('input', (e) => setRate(parseFloat(e.target.value)));

  els.webgpuCheckbox.addEventListener('change', (e) => {
    saveSettings({ tryWebGpu: e.target.checked });
  });

  els.engineRetryBtn.addEventListener('click', retryEngine);

  els.progressSlider.addEventListener('input', () => {
    isDraggingSlider = true;
    const frac = Number(els.progressSlider.value) / 1000;
    const idx = Math.min(state.sentences.length - 1, Math.floor(frac * state.sentences.length));
    els.sentenceLabel.textContent = `Seek to sentence ${idx + 1} / ${state.sentences.length}`;
  });
  els.progressSlider.addEventListener('change', () => {
    const frac = Number(els.progressSlider.value) / 1000;
    const idx = Math.min(state.sentences.length - 1, Math.floor(frac * state.sentences.length));
    isDraggingSlider = false;
    playFrom(idx, 0, state.isPlaying);
  });

  els.player.addEventListener('ended', onChunkEnded);
  els.player.addEventListener('timeupdate', () => {
    updateProgressUI();
    persistPositionThrottled();
  });
  els.player.addEventListener('error', () => {
    if (els.player.src) setStatus('Playback error — skipping ahead.', 'error');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistPositionThrottled(true);
  });
  window.addEventListener('beforeunload', () => persistPositionThrottled(true));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  cacheEls();
  wireUI();

  const settings = loadSettings();
  state.voice = voiceById(settings.voice || DEFAULT_VOICE).id;
  state.rate = settings.rate || 1;
  els.rateSlider.value = String(state.rate);
  els.rateLabel.textContent = `${state.rate.toFixed(2)}x`;
  els.webgpuCheckbox.checked = !!settings.tryWebGpu;

  renderVoiceGrid();
  updateTransportUI();

  if (settings.lastBookId) {
    const saved = await loadBook(settings.lastBookId).catch(() => null);
    if (saved && saved.text) {
      const { paragraphs, sentences } = buildSentences(saved.text);
      state.bookId = saved.id;
      state.fullText = saved.text;
      state.paragraphs = paragraphs;
      state.sentences = sentences;
      indexParagraphs();
      state.bookRecord = saved;
      state.playIndex = Math.min(saved.sentenceIndex || 0, Math.max(sentences.length - 1, 0));
      showReaderView();
      renderTranscriptWindow();
      updateProgressUI();
      updateTransportUI();
      setStatus(
        state.playIndex > 0
          ? `Welcome back — resumed at sentence ${state.playIndex + 1} of ${sentences.length}.`
          : 'Ready to read.',
        'ready'
      );
      return;
    }
  }
  showInputView();
  setStatus('Paste text and tap "Load Book" to begin.', 'ready');
}

init();
