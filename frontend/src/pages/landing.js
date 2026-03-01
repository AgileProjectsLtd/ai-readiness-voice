import { state, extractToken, showPage } from '../lib/state.js';
import { loadDimensions } from '../lib/dimensions.js';
import { apiGet } from '../api.js';

export async function initLanding() {
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
