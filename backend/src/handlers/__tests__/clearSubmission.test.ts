import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

vi.mock('../../lib/s3', () => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
  copyObject: vi.fn(),
}));
vi.mock('../../lib/allowlist', () => ({
  isValidTokenFormat: vi.fn(),
  lookupToken: vi.fn(),
}));

import { handler } from '../clearSubmission';
import { isValidTokenFormat, lookupToken } from '../../lib/allowlist';
import { getJson, putJson, copyObject } from '../../lib/s3';

const mockIsValid = vi.mocked(isValidTokenFormat);
const mockLookup = vi.mocked(lookupToken);
const mockGetJson = vi.mocked(getJson);
const mockPutJson = vi.mocked(putJson);
const mockCopyObject = vi.mocked(copyObject);

function makeEvent(token = 'validtoken1234'): APIGatewayProxyEvent {
  return {
    pathParameters: { token },
    body: null,
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

describe('clearSubmission handler', () => {
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

  it('archives existing submission and writes tombstone', async () => {
    mockGetJson.mockResolvedValue({ completedAt: '2025-06-01T00:00:00Z', dimensions: [] });

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).success).toBe(true);

    expect(mockCopyObject).toHaveBeenCalledOnce();
    expect(mockCopyObject.mock.calls[0][0]).toBe('submissions/validtoken1234/latest.json');
    expect(mockCopyObject.mock.calls[0][1]).toMatch(/^submissions\/validtoken1234\/archived\//);

    expect(mockPutJson).toHaveBeenCalledOnce();
    const tombstone = mockPutJson.mock.calls[0][1] as any;
    expect(tombstone.cleared).toBe(true);
    expect(tombstone.token).toBe('validtoken1234');
  });

  it('returns 400 for invalid token', async () => {
    mockIsValid.mockReturnValue(false);
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when token not in allowlist', async () => {
    mockLookup.mockResolvedValue(null);
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
  });

  it('returns 404 when no submission exists to clear', async () => {
    mockGetJson.mockResolvedValue(null);
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toContain('No submission');
  });

  it('returns 500 on unexpected error', async () => {
    mockGetJson.mockRejectedValue(new Error('S3 error'));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(500);
  });
});
