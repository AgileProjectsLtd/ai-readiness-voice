import { putJson } from './s3';

export interface SubmissionDimension {
  id: string;
  score: number | null;
  confidence: number;
  rationale: string;
  evidence: string[];
}

export interface SubmissionInterview {
  turnCount: number;
  durationSec: number;
  transcript: string;
}

export interface SubmissionUserEdits {
  edited: boolean;
  editLog: Array<{ ts: string; field: string; from: unknown; to: unknown }>;
}

export interface SubmissionData {
  token: string;
  respondent: { name: string; company: string };
  completedAt: string;
  dimensions: SubmissionDimension[];
  interview?: SubmissionInterview;
  userEdits?: SubmissionUserEdits;
  version: string;
}

export async function writeSubmission(submission: SubmissionData): Promise<void> {
  const ts = submission.completedAt.replace(/[:.]/g, '-');
  await putJson(`submissions/${submission.token}/final/${ts}.json`, submission);
  await putJson(`submissions/${submission.token}/latest.json`, submission);
}
