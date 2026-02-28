import { RealtimeAgent, RealtimeSession } from '@openai/agents-realtime';

const API_BASE = '/api';

let DIMENSIONS = {};
let allDimIds = [];
let SCALE_LABELS = {};

// ─── State ───
const state = {
  token: null,
  respondent: null,
  hasSubmission: false,
  session: null,
  interviewStartTime: null,
  timerInterval: null,
  transcript: [],
  scorecard: null,
  editLog: [],
  sessionActive: false,
  currentStatus: 'connecting',
  scorecardRequested: false,
  pendingScorecardRequest: false,
  scorecardTimeout: null,
  aiSpeaking: false,
  echoCooldownUntil: 0,
  hasUnsavedEdits: false,
};

// ─── Routing ───
function extractToken() {
  const path = window.location.pathname;
  const match = path.match(/\/r\/([A-Za-z0-9]{12,})/);
  return match ? match[1] : null;
}

function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');
}

// ─── API helpers ───
async function apiGet(path) {
  const resp = await fetch(`${API_BASE}${path}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function apiPost(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ─── Initialization ───
async function loadDimensions() {
  const config = await apiGet('/config/dimensions');
  const dims = {};
  for (const cat of config.categories) {
    dims[cat.id] = {
      label: cat.label,
      dims: cat.dimensions.map(d => ({ id: d.id, statement: d.statement })),
    };
  }
  DIMENSIONS = dims;
  allDimIds = Object.values(DIMENSIONS).flatMap(cat => cat.dims.map(d => d.id));
  SCALE_LABELS = config.scale?.labels || {};

  const legendEl = document.getElementById('scale-legend');
  if (legendEl) {
    const parts = Object.entries(SCALE_LABELS)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([k, v]) => `<strong>${k}</strong> = ${v}`);
    parts.push('<strong>N/A</strong> = Not sure');
    legendEl.innerHTML = parts.join(' &nbsp; ');
  }
}

async function init() {
  state.token = extractToken();
  if (!state.token) {
    showPage('page-error');
    return;
  }

  try {
    await loadDimensions();
    const data = await apiGet(`/respondent/${state.token}`);
    state.respondent = { name: data.respondentName, company: data.companyName };
    state.hasSubmission = data.hasSubmission;

    document.getElementById('landing-company').textContent = data.companyName;
    document.getElementById('landing-greeting').textContent = `Hello, ${data.respondentName}`;

    if (data.hasSubmission) {
      document.getElementById('submission-banner').classList.remove('d-none');
      document.getElementById('start-section').style.display = 'none';
    }

    showPage('page-landing');
  } catch (err) {
    console.error('Token validation failed:', err);
    showPage('page-error');
  }
}

// ─── Realtime Session (Agents SDK) ───
async function startInterview() {
  const micBtn = document.getElementById('mic-btn-start');
  micBtn.disabled = true;

  showPage('page-interview');
  setStatus('connecting', 'Connecting to AI interviewer...');

  try {
    const ephemeral = await apiPost('/realtime/ephemeral', { token: state.token });

    const agent = new RealtimeAgent({
      name: 'AI Readiness Interviewer',
    });

    const session = new RealtimeSession(agent, {
      model: 'gpt-realtime',
      config: {
        audio: {
          input: {
            noiseReduction: { type: 'near_field' },
            turnDetection: {
              type: 'semantic_vad',
              eagerness: 'medium',
              createResponse: true,
              interruptResponse: false,
            },
          },
        },
      },
    });

    state.session = session;

    session.on('transport_event', (event) => handleRealtimeEvent(event));
    session.on('error', (err) => console.error('Session error:', err));
    await session.connect({ apiKey: ephemeral.clientSecret });

    setStatus('connecting', 'Starting interview...');
    state.sessionActive = true;

    setTimeout(() => {
      if (!state.interviewStartTime && state.session) {
        console.log('No audio yet after 2s — sending response.create to trigger greeting');
        try {
          state.session.transport.sendEvent({ type: 'response.create' });
        } catch (e) {
          console.warn('Failed to send initial response.create:', e);
        }
      }
    }, 2000);

  } catch (err) {
    console.error('Failed to start interview:', err);
    setStatus('connecting', 'Connection failed. Please refresh and try again.');
    micBtn.disabled = false;
  }
}

let textResponseBuffer = '';

function handleRealtimeEvent(event) {
  switch (event.type) {
    case 'output_audio_buffer.started':
      state.aiSpeaking = true;
      if (!state.interviewStartTime) {
        startTimer();
      }
      setStatus('speaking', 'Speaking...');
      break;

    case 'output_audio_buffer.stopped':
      state.aiSpeaking = false;
      state.echoCooldownUntil = Date.now() + 1000;
      try {
        state.session?.transport?.sendEvent({ type: 'input_audio_buffer.clear' });
      } catch (_) { /* ignore if session closed */ }
      if (state.pendingScorecardRequest) {
        state.pendingScorecardRequest = false;
        setStatus('thinking', 'Preparing scorecard...');
        setTimeout(() => requestScorecardViaText(), 1500);
      } else if (state.sessionActive) {
        setStatus('listening', 'Listening...');
      }
      break;

    case 'response.output_audio_transcript.delta':
      appendAssistantTranscript(event.delta);
      break;

    case 'response.output_audio_transcript.done':
      finalizeAssistantTranscript(event.transcript);
      detectInterviewCompletion(event.transcript);
      break;

    case 'response.output_text.delta':
      textResponseBuffer += (event.delta || '');
      break;

    case 'response.output_text.done':
      handleTextResponse(event.text || textResponseBuffer);
      textResponseBuffer = '';
      break;

    case 'conversation.item.input_audio_transcription.completed':
      addUserTranscript(event.transcript);
      break;

    case 'input_audio_buffer.speech_started':
      if (Date.now() < state.echoCooldownUntil) {
        console.log('VAD: speech_started (echo cooldown — ignoring)');
        try {
          state.session?.transport?.sendEvent({ type: 'input_audio_buffer.clear' });
        } catch (_) { /* ignore */ }
        break;
      }
      console.log('VAD: speech_started');
      if (!state.aiSpeaking) {
        setStatus('listening', 'Hearing you...');
      }
      break;

    case 'input_audio_buffer.speech_stopped':
      if (Date.now() < state.echoCooldownUntil) {
        console.log('VAD: speech_stopped (echo cooldown — ignoring)');
        break;
      }
      console.log('VAD: speech_stopped');
      setStatus('thinking', 'Thinking...');
      break;

    case 'response.created':
      if (Date.now() < state.echoCooldownUntil) {
        console.log('Echo cooldown — cancelling echo-triggered response');
        try {
          state.session?.transport?.sendEvent({ type: 'response.cancel' });
        } catch (_) { /* ignore */ }
        break;
      }
      console.log('Response created, current status:', state.currentStatus);
      if (state.currentStatus === 'listening') {
        setStatus('thinking', 'Thinking...');
      }
      break;

    case 'session.created':
      console.log('Session created:', JSON.stringify(event.session?.audio?.input?.turn_detection || 'no turn_detection'));
      break;

    case 'session.updated':
      console.log('Session updated:', JSON.stringify(event.session?.audio?.input?.turn_detection || 'no turn_detection'));
      break;

    case 'error':
      console.error('Realtime error:', event.error);
      break;
  }
}

function extractJsonFromText(text) {
  if (!text) return null;
  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceMatch = trimmed.match(/(\{[\s\S]*"dimensions"\s*:\s*\[[\s\S]*\][\s\S]*\})/);
  if (braceMatch) return braceMatch[1].trim();

  return null;
}

function normalizeDimensions(dimensions) {
  return dimensions.map(d => ({
    ...d,
    score: (d.score === null || d.score === undefined) ? null : Number(d.score),
    confidence: Number(d.confidence) || 0,
    rationale: d.rationale || '',
    evidence: Array.isArray(d.evidence) ? d.evidence : [],
  }));
}

function handleTextResponse(text) {
  if (!text) return;
  console.log('handleTextResponse called, length:', text.length, 'scorecardRequested:', state.scorecardRequested);
  if (!state.scorecardRequested) {
    console.log('Ignoring text response — scorecard not requested');
    return;
  }
  try {
    const jsonStr = extractJsonFromText(text);
    if (!jsonStr) {
      console.warn('Text response did not contain extractable JSON:', text.substring(0, 200));
      return;
    }

    const parsed = JSON.parse(jsonStr);
    if (parsed.dimensions && Array.isArray(parsed.dimensions)) {
      if (!parsed.type) parsed.type = 'final_scorecard';
      parsed.dimensions = normalizeDimensions(parsed.dimensions);
      state.scorecard = parsed;
      const scored = parsed.dimensions.filter(d => d.score !== null).length;
      console.log('Scorecard received:', parsed.dimensions.length, 'dimensions,', scored, 'with scores');
      onInterviewComplete();
      return;
    }
  } catch (err) {
    console.error('Failed to parse text response as scorecard:', err, text.substring(0, 300));
  }
}

function normalizeQuotes(str) {
  return str.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
}

function detectInterviewCompletion(text) {
  if (!text || state.scorecardRequested || state.pendingScorecardRequest) return;
  if (state.transcript.length < 4) return;

  const lower = normalizeQuotes(text.toLowerCase());
  const triggers = [
    "generate your scorecard",
    "prepare your scorecard",
    "produce your scorecard",
    "create your scorecard",
    "build your scorecard",
    "compile your scorecard",
    "now generate the scorecard",
    "now prepare the scorecard",
  ];
  const matched = triggers.find(t => lower.includes(t));
  if (matched) {
    console.log('Interview completion detected via:', matched);
    state.pendingScorecardRequest = true;
  } else if (lower.includes('scorecard')) {
    console.log('Transcript mentions "scorecard" but no trigger matched:', lower.substring(lower.indexOf('scorecard') - 40, lower.indexOf('scorecard') + 40));
  }
}

function requestScorecardViaText() {
  console.log('requestScorecardViaText called, already requested:', state.scorecardRequested, 'session:', !!state.session);
  if (state.scorecardRequested) return;
  state.scorecardRequested = true;
  showPage('page-generating');

  try {
    const idList = allDimIds.join(', ');
    state.session.transport.sendEvent({
      type: 'response.create',
      response: {
        output_modalities: ['text'],
        max_output_tokens: 4096,
        instructions: `Produce the final scorecard JSON. Score each dimension 1-5 (integer), null if no info. Keep rationale under 20 words, evidence max 1 short string. ONLY raw JSON, no preamble. Use EXACT dimension IDs: ${idList}. Format: {"type":"final_scorecard","dimensions":[{"id":"...","score":1,"confidence":0.8,"rationale":"short","evidence":["short"]}]}`,
      },
    });
  } catch (e) {
    console.error('Failed to send scorecard request:', e);
  }

  state.scorecardTimeout = setTimeout(() => {
    if (state.sessionActive && (!state.scorecard || !state.scorecard.dimensions)) {
      console.warn('Scorecard text response timed out after 30s, completing with defaults');
      onInterviewComplete();
    }
  }, 30000);
}

// ─── Transcript management ───
let currentAssistantBuffer = '';

function appendAssistantTranscript(delta) {
  currentAssistantBuffer += delta;
  updateTranscriptUI();
}

function stripScorecardContent(text) {
  let cleaned = text.replace(/\|\|\|SCORECARD_EVENT\|\|\|[\s\S]*?\|\|\|END_SCORECARD_EVENT\|\|\|/g, '');
  cleaned = cleaned.replace(/\{[\s\S]*?"dimensions"\s*:\s*\[[\s\S]*?\]\s*\}/g, '');
  return cleaned.trim();
}

function finalizeAssistantTranscript(fullText) {
  const raw = fullText || currentAssistantBuffer;
  const text = stripScorecardContent(raw);
  if (text) {
    state.transcript.push({ speaker: 'ai', text, ts: Date.now() });
  }
  currentAssistantBuffer = '';
  updateTranscriptUI();
}

function addUserTranscript(text) {
  if (!text || !text.trim()) return;
  state.transcript.push({ speaker: 'user', text: text.trim(), ts: Date.now() });
  currentAssistantBuffer = '';
  updateTranscriptUI();
}

function updateTranscriptUI() {
  const panel = document.getElementById('transcript-panel');
  if (!panel) return;

  const entries = [...state.transcript];
  if (currentAssistantBuffer.trim()) {
    const cleanBuffer = stripScorecardContent(currentAssistantBuffer);
    if (cleanBuffer) {
      entries.push({ speaker: 'ai', text: cleanBuffer, ts: Date.now(), partial: true });
    }
  }

  if (entries.length === 0) {
    panel.innerHTML = '<p class="text-muted small fst-italic mb-0">Conversation will appear here...</p>';
    return;
  }

  panel.innerHTML = entries.map(e => `
    <div class="transcript-entry">
      <div class="speaker ${e.speaker}">${e.speaker === 'ai' ? 'Interviewer' : 'You'}${e.partial ? ' (speaking...)' : ''}</div>
      <div>${escapeHtml(e.text)}</div>
    </div>
  `).join('');

  panel.scrollTop = panel.scrollHeight;
}

// ─── Status + Timer ───
function setStatus(status, text) {
  state.currentStatus = status;
  const el = document.getElementById('status-indicator');
  const txt = document.getElementById('status-text');
  if (!el) return;
  el.className = `status-indicator status-${status}`;
  if (txt) txt.textContent = text;
}

function startTimer() {
  state.interviewStartTime = Date.now();
  state.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.interviewStartTime) / 1000);
    const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const sec = String(elapsed % 60).padStart(2, '0');
    const timerEl = document.getElementById('interview-timer');
    if (timerEl) timerEl.textContent = `${min}:${sec}`;
  }, 1000);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

// ─── Interview end ───
function closeSession() {
  if (state.session) {
    try { state.session.close(); } catch (_) { /* ignore */ }
    state.session = null;
  }
}

function endInterview() {
  console.log('endInterview called, transcript entries:', state.transcript.length, 'sessionActive:', state.sessionActive);
  const userTurns = state.transcript.filter(t => t.speaker === 'user').length;
  if (userTurns === 0) {
    if (!confirm('No conversation has taken place yet. Return to the start screen?')) return;
    state.sessionActive = false;
    state.scorecardRequested = false;
    state.pendingScorecardRequest = false;
    state.interviewStartTime = null;
    state.aiSpeaking = false;
    stopTimer();
    closeSession();
    const micBtn = document.getElementById('mic-btn-start');
    if (micBtn) micBtn.disabled = false;
    showPage('page-landing');
    return;
  }
  showPage('page-generating');
  requestScorecardViaText();
}

async function onInterviewComplete() {
  console.log('onInterviewComplete called, sessionActive:', state.sessionActive, 'hasScorecard:', !!state.scorecard?.dimensions);
  if (!state.sessionActive && document.getElementById('page-scorecard')?.classList.contains('active')) {
    console.log('Already on scorecard page, ignoring');
    return;
  }

  state.sessionActive = false;
  state.aiSpeaking = false;
  stopTimer();

  if (state.scorecardTimeout) {
    clearTimeout(state.scorecardTimeout);
    state.scorecardTimeout = null;
  }

  closeSession();

  if (!state.scorecard || !state.scorecard.dimensions) {
    console.warn('No scorecard received — using default (all N/A)');
    state.scorecard = { type: 'final_scorecard', dimensions: buildDefaultScorecard() };
  }

  await autoSaveScorecard();
  state.hasUnsavedEdits = false;
  renderScorecard(state.scorecard.dimensions);
  showPage('page-scorecard');
  updateUpdateButton();
}

function buildDefaultScorecard() {
  return allDimIds.map(id => ({
    id,
    score: null,
    confidence: 0,
    rationale: '',
    evidence: [],
  }));
}

// ─── Scorecard rendering ───
function renderScorecard(dimensions) {
  const container = document.getElementById('scorecard-body');
  if (!container) return;

  const dimMap = {};
  dimensions.forEach(d => { dimMap[d.id] = d; });

  const modelIds = dimensions.map(d => d.id);
  const matchedCount = allDimIds.filter(id => dimMap[id]).length;
  console.log('renderScorecard: model returned', dimensions.length, 'dims, matched', matchedCount, 'of', allDimIds.length);
  if (matchedCount < dimensions.length) {
    console.log('Model IDs:', modelIds);
    console.log('Expected IDs:', allDimIds);
    dimensions.forEach(d => {
      if (!allDimIds.includes(d.id)) {
        const closest = allDimIds.find(eid => eid.includes(d.id) || d.id.includes(eid));
        if (closest && !dimMap[closest]) {
          dimMap[closest] = d;
          console.log('Fuzzy matched:', d.id, '->', closest);
        }
      }
    });
  }

  let html = '';

  for (const [catId, cat] of Object.entries(DIMENSIONS)) {
    html += `<div class="category-header">${cat.label}</div>`;

    for (const dim of cat.dims) {
      const data = dimMap[dim.id] || { score: null, confidence: 0, rationale: '', evidence: [] };
      html += `
        <div class="dimension-row" data-dim-id="${dim.id}">
          <div class="dimension-statement">${escapeHtml(dim.statement)}</div>
          <div class="row g-2 align-items-start">
            <div class="col-auto">
              <div class="likert-group">
                ${[1, 2, 3, 4, 5].map(v => `
                  <button class="likert-btn ${Number(data.score) === v ? 'selected' : ''}"
                          onclick="app.setScore('${dim.id}', ${v})">${v}</button>
                `).join('')}
                <button class="likert-btn not-sure ${data.score == null ? 'selected' : ''}"
                        onclick="app.setScore('${dim.id}', null)">N/A</button>
              </div>
            </div>
            <div class="col">
              <textarea class="rationale-input" rows="2"
                        placeholder="Notes / rationale"
                        onchange="app.setRationale('${dim.id}', this.value)"
              >${escapeHtml(data.rationale || '')}</textarea>
              ${data.evidence && data.evidence.length > 0 ? `
                <ul class="evidence-list">
                  ${data.evidence.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
                </ul>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }
  }

  container.innerHTML = html;
}

function setScore(dimId, value) {
  if (!state.scorecard || !state.scorecard.dimensions) return;
  const dim = state.scorecard.dimensions.find(d => d.id === dimId);
  if (dim) {
    const oldScore = dim.score;
    dim.score = value;
    state.editLog.push({ ts: new Date().toISOString(), field: `${dimId}.score`, from: oldScore, to: value });
  }

  const row = document.querySelector(`[data-dim-id="${dimId}"]`);
  if (row) {
    row.querySelectorAll('.likert-btn:not(.not-sure)').forEach(btn => {
      const v = parseInt(btn.textContent);
      btn.classList.toggle('selected', v === value);
    });
    const naBtn = row.querySelector('.likert-btn.not-sure');
    if (naBtn) naBtn.classList.toggle('selected', value === null);
  }
  state.hasUnsavedEdits = true;
  updateUpdateButton();
}

function setRationale(dimId, value) {
  if (!state.scorecard || !state.scorecard.dimensions) return;
  const dim = state.scorecard.dimensions.find(d => d.id === dimId);
  if (dim) {
    dim.rationale = value;
    state.editLog.push({ ts: new Date().toISOString(), field: `${dimId}.rationale`, from: null, to: value });
  }
  state.hasUnsavedEdits = true;
  updateUpdateButton();
}

function updateUpdateButton() {
  const btn = document.getElementById('btn-update-assessment');
  if (btn) btn.disabled = !state.hasUnsavedEdits;
}

// ─── Submit / Auto-save ───
function buildPayload() {
  const durationSec = state.interviewStartTime
    ? Math.floor((Date.now() - state.interviewStartTime) / 1000)
    : 0;

  return {
    token: state.token,
    respondent: state.respondent,
    dimensions: state.scorecard.dimensions,
    interview: {
      turnCount: state.transcript.length,
      durationSec,
      transcript: state.transcript.map(t => `[${t.speaker}] ${t.text}`).join('\n'),
    },
    userEdits: {
      edited: state.editLog.length > 0,
      editLog: state.editLog,
    },
    version: '1.0',
  };
}

async function autoSaveScorecard() {
  try {
    const payload = buildPayload();
    const result = await apiPost(`/submission/${state.token}`, payload);
    console.log('Auto-saved scorecard at', result.completedAt);
  } catch (err) {
    console.error('Auto-save failed:', err);
  }
}

async function submitScorecard() {
  const btn = document.getElementById('btn-update-assessment');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';
  }

  try {
    const payload = buildPayload();
    const result = await apiPost(`/submission/${state.token}`, payload);
    state.hasUnsavedEdits = false;

    const timeEl = document.getElementById('confirmation-time');
    if (timeEl) timeEl.textContent = `Last saved at ${new Date(result.completedAt).toLocaleString()}`;

    showPage('page-confirmation');
  } catch (err) {
    console.error('Submission failed:', err);
    alert('Failed to save. Please try again.');
  } finally {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Update Assessment';
    }
  }
}

// ─── Skip interview (manual survey) ───
function skipToSurvey() {
  state.scorecard = { type: 'manual_entry', dimensions: buildDefaultScorecard() };
  state.editLog = [];
  state.hasUnsavedEdits = false;
  renderScorecard(state.scorecard.dimensions);

  const intro = document.getElementById('scorecard-intro');
  if (intro) intro.textContent = 'Please rate each statement below based on your organisation\'s current state. Click "Update Assessment" when you\'re done.';

  showPage('page-scorecard');
  updateUpdateButton();
}

// ─── Revisit flows ───
async function viewExisting() {
  try {
    const sub = await apiGet(`/submission/${state.token}`);
    if (sub.cleared) {
      state.hasSubmission = false;
      document.getElementById('submission-banner').classList.add('d-none');
      document.getElementById('start-section').style.display = '';
      alert('Previous submission was cleared. You can start a new interview.');
      return;
    }
    state.scorecard = { type: 'final_scorecard', dimensions: sub.dimensions };
    state.editLog = [];
    renderScorecard(sub.dimensions);
    state.hasUnsavedEdits = false;
    showPage('page-scorecard');
    updateUpdateButton();
  } catch (err) {
    console.error('Failed to load submission:', err);
    alert('Could not load existing submission.');
  }
}

async function clearAndRestart() {
  if (!confirm('This will archive your existing submission and start a fresh interview. Continue?')) return;

  try {
    await apiPost(`/submission/${state.token}/clear`, {});
    state.hasSubmission = false;
    state.scorecard = null;
    state.transcript = [];
    state.editLog = [];
    document.getElementById('submission-banner').classList.add('d-none');
    document.getElementById('start-section').style.display = '';
    const micBtn = document.getElementById('mic-btn-start');
    if (micBtn) micBtn.disabled = false;
  } catch (err) {
    console.error('Failed to clear submission:', err);
    alert('Failed to clear. Please try again.');
  }
}

function toggleTranscript() {
  const panel = document.getElementById('transcript-panel');
  const toggle = document.getElementById('transcript-toggle-text');
  if (!panel) return;
  const hidden = panel.style.display === 'none';
  panel.style.display = hidden ? '' : 'none';
  if (toggle) toggle.textContent = hidden ? 'Hide' : 'Show';
}

// ─── Utility ───
function escapeHtml(str) {
  if (!str) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, c => map[c]);
}

// ─── Public API (for inline onclick handlers) ───
window.app = {
  startInterview,
  endInterview,
  skipToSurvey,
  viewExisting,
  clearAndRestart,
  setScore,
  setRationale,
  submitScorecard,
  toggleTranscript,
};

document.addEventListener('DOMContentLoaded', init);
