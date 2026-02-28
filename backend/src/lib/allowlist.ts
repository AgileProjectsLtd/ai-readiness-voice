import { getJson } from './s3';

export interface AllowlistEntry {
  token: string;
  respondentName: string;
  companyName: string;
  status: 'active' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt?: string;
  metadata?: Record<string, string>;
}

export interface AllowlistFile {
  entries: AllowlistEntry[];
}

const ALLOWLIST_KEY = 'allowlist/allowlist.json';
const TOKEN_PATTERN = /^[A-Za-z0-9]{12,128}$/;

export function isValidTokenFormat(token: string | undefined | null): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

export async function lookupToken(token: string): Promise<AllowlistEntry | null> {
  const data = await getJson<AllowlistFile>(ALLOWLIST_KEY);
  if (!data?.entries) return null;

  const entry = data.entries.find(e => e.token === token);
  if (!entry) return null;

  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
    return null;
  }

  if (entry.status !== 'active') return null;

  return entry;
}
