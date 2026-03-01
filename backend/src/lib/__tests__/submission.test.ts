import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../s3', () => ({
  putJson: vi.fn(),
}));

import { writeSubmission, SubmissionData } from '../submission';
import { putJson } from '../s3';

const mockedPutJson = vi.mocked(putJson);

describe('writeSubmission', () => {
  const submission: SubmissionData = {
    token: 'testtoken123456',
    respondent: { name: 'Alice', company: 'Acme' },
    completedAt: '2025-06-15T10:30:00.000Z',
    dimensions: [
      { id: 'dim1', score: 4, confidence: 0.8, rationale: 'Good', evidence: ['e1'] },
    ],
    version: '1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes both timestamped and latest JSON files', async () => {
    await writeSubmission(submission);

    expect(mockedPutJson).toHaveBeenCalledTimes(2);

    const expectedTs = '2025-06-15T10-30-00-000Z';
    expect(mockedPutJson).toHaveBeenCalledWith(
      `submissions/testtoken123456/final/${expectedTs}.json`,
      submission,
    );
    expect(mockedPutJson).toHaveBeenCalledWith(
      'submissions/testtoken123456/latest.json',
      submission,
    );
  });

  it('replaces colons and dots in the timestamp portion of the key', async () => {
    const sub = { ...submission, completedAt: '2025-12-31T23:59:59.999Z' };
    await writeSubmission(sub);

    const firstCallKey = mockedPutJson.mock.calls[0][0] as string;
    const tsSegment = firstCallKey.replace(/^.*\/final\//, '').replace(/\.json$/, '');
    expect(tsSegment).not.toContain(':');
    expect(tsSegment).not.toContain('.');
    expect(tsSegment).toBe('2025-12-31T23-59-59-999Z');
  });
});
