import { state, showPage, log } from '../lib/state.js';
import { escapeHtml } from '../lib/utils.js';
import { DIMENSIONS, allDimIds } from '../lib/dimensions.js';
import { buildDefaultScorecard } from '../lib/scorecardHelpers.js';
import { apiGet, apiPost, apiPut } from '../api.js';

// ─── Post-interview transition ───

export async function finishWithScorecard() {
  if (!state.scorecard || !state.scorecard.dimensions) {
    console.warn('No scorecard received — using default (all N/A)');
    state.scorecard = { type: 'final_scorecard', dimensions: buildDefaultScorecard(allDimIds) };
  }

  state.hasUnsavedEdits = false;
  renderScorecard(state.scorecard.dimensions);
  showPage('page-scorecard');
  updateUpdateButton();
}

// ─── Scorecard rendering ───

function renderScorecard(dimensions) {
  const container = document.getElementById('scorecard-body');
  if (!container) return;

  const dimMap = {};
  dimensions.forEach(d => { dimMap[d.id] = d; });

  const modelIds = dimensions.map(d => d.id);
  const matchedCount = allDimIds.filter(id => dimMap[id]).length;
  log('renderScorecard: model returned', dimensions.length, 'dims, matched', matchedCount, 'of', allDimIds.length);
  if (matchedCount < dimensions.length) {
    log('Model IDs:', modelIds);
    log('Expected IDs:', allDimIds);
    dimensions.forEach(d => {
      if (!allDimIds.includes(d.id)) {
        const closest = allDimIds.find(eid => eid.includes(d.id) || d.id.includes(eid));
        if (closest && !dimMap[closest]) {
          dimMap[closest] = d;
          log('Fuzzy matched:', d.id, '->', closest);
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

// ─── Score editing ───

export function setScore(dimId, value) {
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

export function setRationale(dimId, value) {
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

export async function submitScorecard() {
  const btn = document.getElementById('btn-update-assessment');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';
  }

  try {
    const payload = buildPayload();
    const result = await apiPut(`/submission/${state.token}`, payload);
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

// ─── Alternative flows ───

export function skipToSurvey() {
  state.scorecard = { type: 'manual_entry', dimensions: buildDefaultScorecard(allDimIds) };
  state.editLog = [];
  state.hasUnsavedEdits = false;
  renderScorecard(state.scorecard.dimensions);

  const intro = document.getElementById('scorecard-intro');
  if (intro) intro.textContent = 'Please rate each statement below based on your organisation\'s current state. Click "Update Assessment" when you\'re done.';

  showPage('page-scorecard');
  updateUpdateButton();
}

export async function viewExisting() {
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

export async function clearAndRestart() {
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
