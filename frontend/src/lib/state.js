const DEBUG = true;
export const log = (...args) => { if (DEBUG) console.log(...args); };

export const state = {
  token: null,
  respondent: null,
  hasSubmission: false,
  rtc: null,
  interviewStartTime: null,
  timerInterval: null,
  transcript: [],
  scorecard: null,
  editLog: [],
  sessionActive: false,
  interviewCompleteSignalled: false,
  audioPlaying: false,
  scoringResult: null,
  currentStatus: 'connecting',
  hasUnsavedEdits: false,
};

export function extractToken() {
  const path = window.location.pathname;
  const match = path.match(/\/r\/([A-Za-z0-9]{12,})/);
  return match ? match[1] : null;
}

export function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');
}
