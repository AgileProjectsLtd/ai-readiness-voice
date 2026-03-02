import { state, showPage, log } from '../lib/state.js';
import { escapeHtml } from '../lib/utils.js';
import { apiGet, apiPost } from '../api.js';
import { RealtimeSessionController } from '../realtimeSession.js';
import { normalizeDimensions } from '../lib/scorecardHelpers.js';
import { finishWithScorecard } from './scorecard.js';

let currentAssistantBuffer = '';

// ─── Realtime Session ───

export async function startInterview() {
  const micBtn = document.getElementById('mic-btn-start');
  micBtn.disabled = true;

  showPage('page-interview');
  setStatus('connecting', 'Connecting to AI interviewer...');

  try {
    const ephemeral = await apiPost('/realtime/ephemeral', { token: state.token });

    const rtc = new RealtimeSessionController({
      onStatusChange(status, text) {
        setStatus(status, text);
      },
      onAudioStarted() {
        state.audioPlaying = true;
        if (!state.interviewStartTime) startTimer();
      },
      onAudioStopped() {
        state.audioPlaying = false;
        if (state.sessionActive && !state.interviewCompleteSignalled) {
          setStatus('listening', 'Listening...');
        }
      },
      onTranscriptDelta(delta) {
        appendAssistantTranscript(delta);
      },
      onTranscriptDone(text) {
        finalizeAssistantTranscript(text);
      },
      onUserTranscript(text) {
        addUserTranscript(text);
      },
      onInterviewComplete() {
        log('interview_complete tool fired');
        state.interviewCompleteSignalled = true;
        setStatus('speaking', 'Wrapping up and generating scorecard...');
        enqueueScoring();
      },
      onError(error) {
        console.error('Realtime session error:', error);
      },
    });

    state.rtc = rtc;
    await rtc.connect(ephemeral.clientSecret, ephemeral.instructions);

    setStatus('connecting', 'Starting interview...');
    state.sessionActive = true;

  } catch (err) {
    console.error('Failed to start interview:', err);
    setStatus('connecting', 'Connection failed. Please refresh and try again.');
    micBtn.disabled = false;
  }
}

// ─── Scoring pipeline ───

async function enqueueScoring() {
  log('enqueueScoring called — starting backend scoring in parallel with speech');
  try {
    const durationSec = state.interviewStartTime
      ? Math.floor((Date.now() - state.interviewStartTime) / 1000)
      : 0;
    const { jobId } = await apiPost('/score', {
      token: state.token,
      transcript: state.transcript,
      durationSec,
    });
    log('Score job enqueued:', jobId);

    const scorecard = await pollForResult(jobId);
    if (scorecard) {
      scorecard.dimensions = normalizeDimensions(scorecard.dimensions);
      state.scoringResult = scorecard;
      log('Scorecard received:', scorecard.dimensions.length, 'dimensions');
    } else {
      state.scoringResult = 'done';
    }
  } catch (err) {
    console.error('Scoring failed:', err);
    state.scoringResult = 'done';
  }
  maybeFinish();
}

async function maybeFinish() {
  if (!state.scoringResult) return;

  log('Scoring complete — transitioning to scorecard');
  state.sessionActive = false;
  stopTimer();
  showPage('page-generating');
  setTimeout(() => closeSession(), 500);

  if (state.scoringResult !== 'done') {
    state.scorecard = state.scoringResult;
  }

  await finishWithScorecard();
}

async function pollForResult(jobId, intervalMs = 2000, maxMs = 60000) {
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const result = await apiGet(`/score/${jobId}`);
      log('Poll result:', result.status);

      if (result.status === 'complete' && result.scorecard) {
        return result.scorecard;
      }
      if (result.status === 'failed') {
        console.error('Scoring job failed:', result.error);
        return null;
      }
    } catch (err) {
      console.warn('Poll error (will retry):', err);
    }
  }

  console.warn('Scoring poll timed out after', maxMs / 1000, 'seconds');
  return null;
}

// ─── Transcript management ───

function appendAssistantTranscript(delta) {
  currentAssistantBuffer += delta;
  updateTranscriptUI();
}

function finalizeAssistantTranscript(fullText) {
  const text = (fullText || currentAssistantBuffer).trim();
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
    entries.push({ speaker: 'ai', text: currentAssistantBuffer.trim(), ts: Date.now(), partial: true });
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

// ─── Session lifecycle ───

function closeSession() {
  if (state.rtc) {
    state.rtc.close();
    state.rtc = null;
  }
}

export function endInterview() {
  log('endInterview called, transcript entries:', state.transcript.length);
  const userTurns = state.transcript.filter(t => t.speaker === 'user').length;
  if (userTurns === 0) {
    if (!confirm('No conversation has taken place yet. Return to the start screen?')) return;
    state.sessionActive = false;
    state.interviewStartTime = null;
    stopTimer();
    closeSession();
    const micBtn = document.getElementById('mic-btn-start');
    if (micBtn) micBtn.disabled = false;
    showPage('page-landing');
    return;
  }
  state.sessionActive = false;
  stopTimer();
  showPage('page-generating');
  setTimeout(() => closeSession(), 500);
  enqueueScoring();
}

export function toggleTranscript() {
  const panel = document.getElementById('transcript-panel');
  const toggle = document.getElementById('transcript-toggle-text');
  if (!panel) return;
  const hidden = panel.style.display === 'none';
  panel.style.display = hidden ? '' : 'none';
  if (toggle) toggle.textContent = hidden ? 'Hide' : 'Show';
}
