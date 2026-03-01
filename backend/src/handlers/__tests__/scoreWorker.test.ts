import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

vi.mock('../../lib/s3', () => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
}));
vi.mock('../../lib/secrets', () => ({
  getOpenAIKey: vi.fn(),
}));
vi.mock('../../lib/dimensions', () => ({
  loadDimensions: vi.fn(),
  formatDimensionsBlock: vi.fn(),
  totalDimensionCount: vi.fn(),
}));
vi.mock('../../lib/allowlist', () => ({
  lookupToken: vi.fn(),
}));
vi.mock('../../lib/submission', () => ({
  writeSubmission: vi.fn(),
}));
vi.mock('../../lib/email', () => ({
  sendScoreEmail: vi.fn(),
}));

import { handler } from '../scoreWorker';
import { getJson, putJson } from '../../lib/s3';
import { getOpenAIKey } from '../../lib/secrets';
import { loadDimensions, formatDimensionsBlock, totalDimensionCount } from '../../lib/dimensions';
import { lookupToken } from '../../lib/allowlist';
import { writeSubmission } from '../../lib/submission';
import { sendScoreEmail } from '../../lib/email';

const mockGetJson = vi.mocked(getJson);
const mockPutJson = vi.mocked(putJson);
const mockGetKey = vi.mocked(getOpenAIKey);
const mockLoadDims = vi.mocked(loadDimensions);
const mockFormatDims = vi.mocked(formatDimensionsBlock);
const mockTotalDims = vi.mocked(totalDimensionCount);
const mockLookup = vi.mocked(lookupToken);
const mockWriteSub = vi.mocked(writeSubmission);
const mockSendEmail = vi.mocked(sendScoreEmail);

const validScorecard = {
  type: 'final_scorecard',
  dimensions: [
    { id: 'dim1', score: 4, confidence: 0.8, rationale: 'Good', evidence: ['evidence'] },
  ],
};

function makeSqsEvent(jobId: string): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        receiptHandle: 'handle',
        body: JSON.stringify({ jobId }),
        attributes: {} as any,
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

const sampleJob = {
  jobId: 'job-123',
  status: 'pending',
  token: 'validtoken1234',
  transcript: [{ speaker: 'ai', text: 'Hello' }, { speaker: 'user', text: 'Hi there' }],
  durationSec: 60,
  createdAt: '2025-06-01T00:00:00Z',
};

describe('scoreWorker handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJson.mockResolvedValue(sampleJob);
    mockGetKey.mockResolvedValue('sk-test-key');
    mockLoadDims.mockResolvedValue({ categories: [] });
    mockFormatDims.mockReturnValue('dim list');
    mockTotalDims.mockReturnValue(1);
    mockLookup.mockResolvedValue({
      token: 'validtoken1234',
      respondentName: 'Alice',
      companyName: 'Acme',
      status: 'active',
      createdAt: '2025-01-01',
    });
    mockWriteSub.mockResolvedValue(undefined);
    mockSendEmail.mockResolvedValue(undefined);
  });

  it('scores successfully, auto-saves submission, and sends email', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(validScorecard) } }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await handler(makeSqsEvent('job-123'));

    expect(mockFetch).toHaveBeenCalledOnce();
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.model).toBe('gpt-4o-mini');

    expect(mockPutJson).toHaveBeenCalled();
    const completedJob = mockPutJson.mock.calls.find(
      (c) => (c[1] as any).status === 'complete',
    );
    expect(completedJob).toBeDefined();
    expect((completedJob![1] as any).scorecard).toBeDefined();

    expect(mockWriteSub).toHaveBeenCalledOnce();

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({
      respondent: { name: 'Alice', company: 'Acme' },
      dimensions: validScorecard.dimensions,
    });
  });

  it('does not send email when scoring fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    }));

    await handler(makeSqsEvent('job-123'));

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('marks job as failed when OpenAI returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    }));

    await handler(makeSqsEvent('job-123'));

    const failedCall = mockPutJson.mock.calls.find(
      (c) => (c[1] as any).status === 'failed',
    );
    expect(failedCall).toBeDefined();
    expect((failedCall![1] as any).error).toContain('429');
  });

  it('marks job as failed when OpenAI returns no content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: {} }] }),
    }));

    await handler(makeSqsEvent('job-123'));

    const failedCall = mockPutJson.mock.calls.find(
      (c) => (c[1] as any).status === 'failed',
    );
    expect(failedCall).toBeDefined();
    expect((failedCall![1] as any).error).toContain('No content');
  });

  it('handles missing job gracefully', async () => {
    mockGetJson.mockResolvedValue(null);
    await handler(makeSqsEvent('missing-job'));
    expect(mockPutJson).not.toHaveBeenCalled();
  });

  it('marks job failed on Zod validation error', async () => {
    const badScorecard = { type: 'final_scorecard', dimensions: [{ id: 'x', score: 99 }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(badScorecard) } }],
      }),
    }));

    await handler(makeSqsEvent('job-123'));

    const failedCall = mockPutJson.mock.calls.find(
      (c) => (c[1] as any).status === 'failed',
    );
    expect(failedCall).toBeDefined();
  });
});
