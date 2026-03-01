import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../s3', () => ({
  getJson: vi.fn(),
}));

import { isValidTokenFormat, lookupToken } from '../allowlist';
import { getJson } from '../s3';

const mockedGetJson = vi.mocked(getJson);

describe('isValidTokenFormat', () => {
  it('accepts valid alphanumeric tokens (12-128 chars)', () => {
    expect(isValidTokenFormat('abcdef123456')).toBe(true);
    expect(isValidTokenFormat('A'.repeat(128))).toBe(true);
    expect(isValidTokenFormat('abc123XYZ789')).toBe(true);
  });

  it('rejects tokens that are too short', () => {
    expect(isValidTokenFormat('abc')).toBe(false);
    expect(isValidTokenFormat('12345678901')).toBe(false); // 11 chars
  });

  it('rejects tokens that are too long', () => {
    expect(isValidTokenFormat('A'.repeat(129))).toBe(false);
  });

  it('rejects tokens with special characters', () => {
    expect(isValidTokenFormat('abc-def-12345')).toBe(false);
    expect(isValidTokenFormat('hello world!')).toBe(false);
    expect(isValidTokenFormat('abc_def_12345')).toBe(false);
  });

  it('rejects null/undefined/empty', () => {
    expect(isValidTokenFormat(null)).toBe(false);
    expect(isValidTokenFormat(undefined)).toBe(false);
    expect(isValidTokenFormat('')).toBe(false);
  });
});

describe('lookupToken', () => {
  const activeEntry = {
    token: 'validtoken1234',
    respondentName: 'Alice',
    companyName: 'Acme',
    status: 'active' as const,
    createdAt: '2025-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns entry for a valid active token', async () => {
    mockedGetJson.mockResolvedValue({ entries: [activeEntry] });
    const result = await lookupToken('validtoken1234');
    expect(result).toEqual(activeEntry);
  });

  it('returns null when token is not in allowlist', async () => {
    mockedGetJson.mockResolvedValue({ entries: [activeEntry] });
    const result = await lookupToken('nonexistent1234');
    expect(result).toBeNull();
  });

  it('returns null for revoked tokens', async () => {
    mockedGetJson.mockResolvedValue({
      entries: [{ ...activeEntry, status: 'revoked' }],
    });
    const result = await lookupToken('validtoken1234');
    expect(result).toBeNull();
  });

  it('returns null for expired tokens', async () => {
    mockedGetJson.mockResolvedValue({
      entries: [{ ...activeEntry, expiresAt: '2020-01-01T00:00:00Z' }],
    });
    const result = await lookupToken('validtoken1234');
    expect(result).toBeNull();
  });

  it('returns entry when expiresAt is in the future', async () => {
    mockedGetJson.mockResolvedValue({
      entries: [{ ...activeEntry, expiresAt: '2099-01-01T00:00:00Z' }],
    });
    const result = await lookupToken('validtoken1234');
    expect(result).toEqual({ ...activeEntry, expiresAt: '2099-01-01T00:00:00Z' });
  });

  it('returns null when allowlist data is missing', async () => {
    mockedGetJson.mockResolvedValue(null);
    const result = await lookupToken('validtoken1234');
    expect(result).toBeNull();
  });

  it('returns null when entries array is absent', async () => {
    mockedGetJson.mockResolvedValue({});
    const result = await lookupToken('validtoken1234');
    expect(result).toBeNull();
  });
});
