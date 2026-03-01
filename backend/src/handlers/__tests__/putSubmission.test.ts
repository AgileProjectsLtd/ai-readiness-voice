import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

vi.mock('../../lib/s3', () => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
}));
vi.mock('../../lib/allowlist', () => ({
  isValidTokenFormat: vi.fn(),
  lookupToken: vi.fn(),
}));
vi.mock('../../lib/dimensions', () => ({
  loadDimensions: vi.fn(),
}));
vi.mock('../../lib/submission', () => ({
  writeSubmission: vi.fn(),
}));

import { handler } from '../putSubmission';
import { isValidTokenFormat, lookupToken } from '../../lib/allowlist';
import { loadDimensions } from '../../lib/dimensions';
import { writeSubmission } from '../../lib/submission';

const mockIsValid = vi.mocked(isValidTokenFormat);
const mockLookup = vi.mocked(lookupToken);
const mockLoadDims = vi.mocked(loadDimensions);
const mockWrite = vi.mocked(writeSubmission);

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    pathParameters: { token: 'validtoken1234' },
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'PUT',
    isBase64Encoded: false,
    path: '',
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    ...overrides,
  };
}

const dimensionsConfig = {
  categories: [
    {
      id: 'cat1',
      label: 'Category 1',
      dimensions: [
        { id: 'dim_one', statement: 'Dimension one' },
        { id: 'dim_two', statement: 'Dimension two' },
      ],
    },
  ],
};

describe('putSubmission handler', () => {
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
    mockLoadDims.mockResolvedValue(dimensionsConfig);
    mockWrite.mockResolvedValue(undefined);
  });

  it('returns 201 for a valid submission', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        dimensions: [
          { id: 'dim_one', score: 4, confidence: 0.8, rationale: 'Good', evidence: ['e1'] },
        ],
      }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body).success).toBe(true);
    expect(mockWrite).toHaveBeenCalledOnce();
  });

  it('returns 400 for invalid token format', async () => {
    mockIsValid.mockReturnValue(false);
    const event = makeEvent({ body: '{}' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('token');
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = makeEvent({ body: 'not-json' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('JSON');
  });

  it('returns 400 when dimensions array is missing', async () => {
    const event = makeEvent({ body: JSON.stringify({ something: 'else' }) });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('dimensions');
  });

  it('returns 400 when no valid dimensions after sanitization', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        dimensions: [{ id: 'unknown_dim', score: 3, confidence: 0.5, rationale: 'x', evidence: [] }],
      }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('No valid dimensions');
  });

  it('returns 404 for invalid/expired token', async () => {
    mockLookup.mockResolvedValue(null);
    const event = makeEvent({
      body: JSON.stringify({
        dimensions: [{ id: 'dim_one', score: 3, confidence: 0.5, rationale: 'ok', evidence: [] }],
      }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('deduplicates dimensions by id', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        dimensions: [
          { id: 'dim_one', score: 3, confidence: 0.5, rationale: 'first', evidence: [] },
          { id: 'dim_one', score: 5, confidence: 0.9, rationale: 'dupe', evidence: [] },
        ],
      }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(201);
    const writtenData = mockWrite.mock.calls[0][0];
    expect(writtenData.dimensions).toHaveLength(1);
    expect(writtenData.dimensions[0].rationale).toBe('first');
  });

  it('sanitizes dimension scores (clamps, rounds)', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        dimensions: [
          { id: 'dim_one', score: 3.7, confidence: 1.5, rationale: 'x', evidence: [] },
        ],
      }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(201);
    const dim = mockWrite.mock.calls[0][0].dimensions[0];
    expect(dim.score).toBe(4);
    expect(dim.confidence).toBe(1);
  });

  it('includes optional interview and userEdits when provided', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        dimensions: [{ id: 'dim_one', score: 3, confidence: 0.5, rationale: 'ok', evidence: [] }],
        interview: { turnCount: 10, durationSec: 120, transcript: 'Hello...' },
        userEdits: { edited: true, editLog: [{ ts: 'now', field: 'dim_one.score', from: 3, to: 4 }] },
      }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(201);
    const data = mockWrite.mock.calls[0][0];
    expect(data.interview).toBeDefined();
    expect(data.interview!.turnCount).toBe(10);
    expect(data.userEdits).toBeDefined();
    expect(data.userEdits!.edited).toBe(true);
  });

  it('returns 500 when writeSubmission throws', async () => {
    mockWrite.mockRejectedValue(new Error('S3 down'));
    const event = makeEvent({
      body: JSON.stringify({
        dimensions: [{ id: 'dim_one', score: 3, confidence: 0.5, rationale: 'ok', evidence: [] }],
      }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(500);
  });
});
