import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-southeast-1' });
const cache: Record<string, string> = {};

async function getSecretField(secretName: string, fieldName: string): Promise<string | null> {
  const cacheKey = `${secretName}:${fieldName}`;
  if (cache[cacheKey]) return cache[cacheKey];

  try {
    const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (!resp.SecretString) return null;
    const parsed = JSON.parse(resp.SecretString);
    const value = parsed[fieldName] || null;
    if (value) cache[cacheKey] = value;
    return value;
  } catch (err) {
    console.error(`Failed to retrieve secret ${secretName}:`, err);
    return null;
  }
}

export async function getOpenAIKey(): Promise<string> {
  const secretName = process.env.OPENAI_SECRET_NAME || 'ai-readiness/dev/openai-api-key';
  const key = await getSecretField(secretName, 'OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_API_KEY not found in secret');
  return key;
}

export async function getAdminKey(): Promise<string | null> {
  const secretName = process.env.ADMIN_SECRET_NAME || 'ai-readiness/dev/admin-key';
  return getSecretField(secretName, 'ADMIN_KEY');
}
