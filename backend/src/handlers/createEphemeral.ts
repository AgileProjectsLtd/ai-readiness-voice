import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { lookupToken, isValidTokenFormat } from '../lib/allowlist';
import { getOpenAIKey } from '../lib/secrets';
import { ok, notFound, badRequest, serverError } from '../lib/response';
import { DimensionsConfig, loadDimensions, formatDimensionsBlock, totalDimensionCount } from '../lib/dimensions';
import * as fs from 'fs';
import * as path from 'path';

function buildSystemInstructions(name: string, company: string, dimensions: DimensionsConfig): string {
  const templatePath = path.join(__dirname, '..', 'config', 'systemPrompt.v1.txt');
  let template: string;

  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    template = fs.readFileSync(path.join(__dirname, 'config', 'systemPrompt.v1.txt'), 'utf-8');
  }

  return template
    .replace('{{RESPONDENT_NAME}}', name)
    .replace('{{COMPANY_NAME}}', company)
    .replace('{{DIMENSIONS_BLOCK}}', formatDimensionsBlock(dimensions))
    .replace(/{{DIMENSION_COUNT}}/g, String(totalDimensionCount(dimensions)));
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
        session: { type: 'realtime', model: 'gpt-realtime-1.5' },
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
      instructions,
    });
  } catch (err) {
    console.error('createEphemeral error:', JSON.stringify(err));
    return serverError();
  }
}
