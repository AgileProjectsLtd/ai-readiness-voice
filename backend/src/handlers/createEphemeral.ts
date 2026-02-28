import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { lookupToken, isValidTokenFormat } from '../lib/allowlist';
import { getOpenAIKey } from '../lib/secrets';
import { getJson } from '../lib/s3';
import { ok, notFound, badRequest, serverError } from '../lib/response';
import * as fs from 'fs';
import * as path from 'path';

interface DimensionsConfig {
  categories: Array<{
    id: string;
    label: string;
    prefix?: string;
    dimensions: Array<{ id: string; statement: string }>;
  }>;
}

let cachedDimensions: DimensionsConfig | null = null;

async function loadDimensions(): Promise<DimensionsConfig> {
  if (cachedDimensions) return cachedDimensions;
  const config = await getJson<DimensionsConfig>('config/dimensions.json');
  if (!config?.categories) throw new Error('Dimensions config not found in S3');
  cachedDimensions = config;
  return config;
}

function formatDimensionsBlock(config: DimensionsConfig): string {
  const lines: string[] = [];
  let num = 1;
  for (const cat of config.categories) {
    const prefix = cat.prefix || cat.dimensions[0]?.id.match(/^([a-z]+)_/)?.[1] || '';
    lines.push(`${cat.label} (${prefix}_):`);
    for (const dim of cat.dimensions) {
      lines.push(`${num}. ${dim.id}: ${dim.statement}`);
      num++;
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function buildSystemInstructions(name: string, company: string, dimensions: DimensionsConfig): string {
  const templatePath = path.join(__dirname, '..', 'config', 'systemPrompt.v1.txt');
  let template: string;

  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    template = fs.readFileSync(path.join(__dirname, 'config', 'systemPrompt.v1.txt'), 'utf-8');
  }

  const totalDims = dimensions.categories.reduce((sum, cat) => sum + cat.dimensions.length, 0);

  return template
    .replace('{{RESPONDENT_NAME}}', name)
    .replace('{{COMPANY_NAME}}', company)
    .replace('{{DIMENSIONS_BLOCK}}', formatDimensionsBlock(dimensions))
    .replace(/{{DIMENSION_COUNT}}/g, String(totalDims));
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  let body: { token?: string };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const token = body.token;
  if (!isValidTokenFormat(token)) {
    return badRequest('Invalid token');
  }

  try {
    const entry = await lookupToken(token);
    if (!entry) {
      return notFound('Invalid or expired token');
    }

    const apiKey = await getOpenAIKey();
    const dimensions = await loadDimensions();
    const instructions = buildSystemInstructions(entry.respondentName, entry.companyName, dimensions);

    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          instructions,
          audio: {
            input: {
              transcription: {
                model: 'gpt-4o-mini-transcribe',
              },
            },
            output: {
              voice: 'shimmer',
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI session creation failed:', response.status, errText);
      return serverError('Failed to create realtime session');
    }

    const result = await response.json() as any;

    const secret = result.session?.client_secret ?? result.client_secret ?? result;
    return ok({
      clientSecret: secret.value,
      sessionId: result.id,
      expiresAt: secret.expires_at,
    });
  } catch (err) {
    console.error('createEphemeral error:', JSON.stringify(err));
    return serverError();
  }
}
