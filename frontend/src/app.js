import { initLanding } from './pages/landing.js';
import { startInterview, endInterview, toggleTranscript } from './pages/interview.js';
import {
  setScore,
  setRationale,
  submitScorecard,
  skipToSurvey,
  viewExisting,
  clearAndRestart,
} from './pages/scorecard.js';

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

document.addEventListener('DOMContentLoaded', initLanding);
