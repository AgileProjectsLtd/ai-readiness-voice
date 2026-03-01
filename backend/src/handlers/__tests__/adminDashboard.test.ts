import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

vi.mock('../../lib/s3', () => ({
  getJson: vi.fn(),
}));
vi.mock('../../lib/secrets', () => ({
  getAdminKey: vi.fn(),
}));

import { handler } from '../adminDashboard';
import { getJson } from '../../lib/s3';
import { getAdminKey } from '../../lib/secrets';

const mockGetJson = vi.mocked(getJson);
const mockGetAdminKey = vi.mocked(getAdminKey);

function makeEvent(adminKey?: string): APIGatewayProxyEvent {
  return {
    pathParameters: null,
    body: null,
    headers: adminKey ? { 'x-admin-key': adminKey } : {},
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

describe('adminDashboard handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdminKey.mockResolvedValue('secret-admin-key');
  });

  it('returns 401 when admin key is wrong', async () => {
    const result = await handler(makeEvent('wrong-key'));
    expect(result.statusCode).toBe(401);
  });

  it('returns 401 when admin key header is missing', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(401);
  });

  it('returns 500 when admin key is not configured', async () => {
    mockGetAdminKey.mockResolvedValue(null);
    const result = await handler(makeEvent('anything'));
    expect(result.statusCode).toBe(500);
  });

  it('returns empty respondents when allowlist has no entries', async () => {
    mockGetJson.mockResolvedValue(null);
    const result = await handler(makeEvent('secret-admin-key'));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ respondents: [] });
  });

  it('returns respondent summaries with scores', async () => {
    mockGetJson.mockImplementation(async (key: string) => {
      if (key === 'allowlist/allowlist.json') {
        return {
          entries: [
            { token: 'token123456789', respondentName: 'Alice', companyName: 'Acme', status: 'active', createdAt: '2025-01-01' },
          ],
        };
      }
      if (key.includes('latest.json')) {
        return {
          completedAt: '2025-06-01T00:00:00Z',
          dimensions: [
            { id: 'dim1', score: 4 },
            { id: 'dim2', score: null },
          ],
          interview: { durationSec: 120 },
        };
      }
      return null;
    });

    const result = await handler(makeEvent('secret-admin-key'));
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.respondents).toHaveLength(1);
    const resp = body.respondents[0];
    expect(resp.name).toBe('Alice');
    expect(resp.hasSubmission).toBe(true);
    expect(resp.averageScore).toBe(4);
    expect(resp.scoredCount).toBe(1);
    expect(resp.nullCount).toBe(1);
  });

  it('reports hasSubmission=false for cleared submissions', async () => {
    mockGetJson.mockImplementation(async (key: string) => {
      if (key === 'allowlist/allowlist.json') {
        return {
          entries: [
            { token: 'token123456789', respondentName: 'Bob', companyName: 'Corp', status: 'active', createdAt: '2025-01-01' },
          ],
        };
      }
      return { cleared: true };
    });

    const result = await handler(makeEvent('secret-admin-key'));
    const resp = JSON.parse(result.body).respondents[0];
    expect(resp.hasSubmission).toBe(false);
  });
});
