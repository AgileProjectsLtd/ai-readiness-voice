import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

vi.mock('../../lib/s3', () => ({
  putJson: vi.fn(),
}));
vi.mock('../../lib/allowlist', () => ({
  isValidTokenFormat: vi.fn(),
  lookupToken: vi.fn(),
}));

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = mockSend; },
  SendMessageCommand: class { constructor(public input: any) {} },
  GetQueueUrlCommand: class { constructor(public input: any) {} },
}));

import { handler } from '../scoreEnqueue';
import { isValidTokenFormat, lookupToken } from '../../lib/allowlist';
import { putJson } from '../../lib/s3';

const mockIsValid = vi.mocked(isValidTokenFormat);
const mockLookup = vi.mocked(lookupToken);
const mockPutJson = vi.mocked(putJson);

function makeEvent(body: any): APIGatewayProxyEvent {
  return {
    pathParameters: null,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '',
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

describe('scoreEnqueue handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValid.mockReturnValue(true);
    mockLookup.mockResolvedValue({
      token: 'validtoken1234',
      respondentName: 'Alice',
      companyName: 'Acme',
      status: 'active',
      createdAt: '2025-01-01T00:00:00Z',
    });
    mockSend.mockResolvedValue({ QueueUrl: 'https://sqs.example.com/queue' });
    process.env.SCORE_QUEUE_URL = 'https://sqs.example.com/queue';
  });

  it('returns 200 with jobId for valid request', async () => {
    const event = makeEvent({
      token: 'validtoken1234',
      transcript: [{ speaker: 'ai', text: 'Hello' }],
      durationSec: 60,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.jobId).toBeDefined();
    expect(body.status).toBe('pending');

    expect(mockPutJson).toHaveBeenCalledOnce();
    const jobData = mockPutJson.mock.calls[0][1] as any;
    expect(jobData.status).toBe('pending');
    expect(jobData.transcript).toHaveLength(1);
  });

  it('returns 400 for invalid JSON', async () => {
    const event = makeEvent('not-json');
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for invalid token', async () => {
    mockIsValid.mockReturnValue(false);
    const event = makeEvent({ token: '!bad', transcript: [] });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when transcript is empty', async () => {
    const event = makeEvent({ token: 'validtoken1234', transcript: [] });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('Transcript');
  });

  it('returns 400 when transcript is missing', async () => {
    const event = makeEvent({ token: 'validtoken1234' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 for expired token', async () => {
    mockLookup.mockResolvedValue(null);
    const event = makeEvent({
      token: 'validtoken1234',
      transcript: [{ speaker: 'ai', text: 'Hi' }],
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});
