import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

vi.mock('../../lib/s3', () => ({
  getJson: vi.fn(),
}));
vi.mock('../../lib/allowlist', () => ({
  isValidTokenFormat: vi.fn(),
  lookupToken: vi.fn(),
}));

import { handler } from '../getSubmission';
import { isValidTokenFormat, lookupToken } from '../../lib/allowlist';
import { getJson } from '../../lib/s3';

const mockIsValid = vi.mocked(isValidTokenFormat);
const mockLookup = vi.mocked(lookupToken);
const mockGetJson = vi.mocked(getJson);

function makeEvent(token = 'validtoken1234'): APIGatewayProxyEvent {
  return {
    pathParameters: { token },
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '',
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

describe('getSubmission handler', () => {
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
  });

  it('returns 200 with submission data when found', async () => {
    const submission = { token: 'validtoken1234', dimensions: [], completedAt: '2025-06-01T00:00:00Z' };
    mockGetJson.mockResolvedValue(submission);

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(submission);
  });

  it('returns 400 for invalid token format', async () => {
    mockIsValid.mockReturnValue(false);
    const result = await handler(makeEvent('bad'));
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when token not in allowlist', async () => {
    mockLookup.mockResolvedValue(null);
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
  });

  it('returns 404 when no submission exists', async () => {
    mockGetJson.mockResolvedValue(null);
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toContain('No submission');
  });

  it('returns 500 on unexpected error', async () => {
    mockGetJson.mockRejectedValue(new Error('boom'));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(500);
  });
});
