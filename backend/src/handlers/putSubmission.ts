import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { lookupToken, isValidTokenFormat } from '../lib/allowlist';
import { getJson, putJson } from '../lib/s3';
import { created, notFound, badRequest, serverError } from '../lib/response';

const MAX_RATIONALE_LENGTH = 2000;
const MAX_TRANSCRIPT_LENGTH = 500_000;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_LENGTH = 1000;
const MAX_EDIT_LOG_ENTRIES = 200;

interface DimensionsConfig {
  categories: Array<{
    dimensions: Array<{ id: string }>;
  }>;
}

let validDimensionIds: Set<string> | null = null;

async function loadValidDimensionIds(): Promise<Set<string>> {
  if (validDimensionIds) return validDimensionIds;

  const config = await getJson<DimensionsConfig>('config/dimensions.json');
  if (!config?.categories) throw new Error('Dimensions config not found in S3');

  const ids = new Set<string>();
  for (const cat of config.categories) {
    for (const dim of cat.dimensions) {
      ids.add(dim.id);
    }
  }
  validDimensionIds = ids;
  return ids;
}

function sanitizeDimension(
  dim: any,
  allowedIds: Set<string>,
): { id: string; score: number | null; confidence: number; rationale: string; evidence: string[] } | null {
  if (!dim || typeof dim.id !== 'string' || !allowedIds.has(dim.id)) return null;

  const score = dim.score === null ? null : (typeof dim.score === 'number' && dim.score >= 1 && dim.score <= 5 ? Math.round(dim.score) : null);
  const confidence = typeof dim.confidence === 'number' ? Math.max(0, Math.min(1, dim.confidence)) : 0;
  const rationale = typeof dim.rationale === 'string' ? dim.rationale.slice(0, MAX_RATIONALE_LENGTH) : '';
  const evidence = Array.isArray(dim.evidence)
    ? dim.evidence
        .filter((e: unknown) => typeof e === 'string')
        .slice(0, MAX_EVIDENCE_ITEMS)
        .map((e: string) => e.slice(0, MAX_EVIDENCE_LENGTH))
    : [];

  return { id: dim.id, score, confidence, rationale, evidence };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const token = event.pathParameters?.token;
  if (!isValidTokenFormat(token)) {
    return badRequest('Invalid token format');
  }

  let body: any;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  if (!body.dimensions || !Array.isArray(body.dimensions)) {
    return badRequest('Missing dimensions array');
  }

  const allowedIds = await loadValidDimensionIds();
  const sanitizedDimensions = [];
  const seenIds = new Set<string>();

  for (const raw of body.dimensions) {
    const dim = sanitizeDimension(raw, allowedIds);
    if (!dim) continue;
    if (seenIds.has(dim.id)) continue;
    seenIds.add(dim.id);
    sanitizedDimensions.push(dim);
  }

  if (sanitizedDimensions.length === 0) {
    return badRequest('No valid dimensions provided');
  }

  const interview = body.interview && typeof body.interview === 'object' ? {
    turnCount: typeof body.interview.turnCount === 'number' ? Math.max(0, Math.round(body.interview.turnCount)) : 0,
    durationSec: typeof body.interview.durationSec === 'number' ? Math.max(0, Math.round(body.interview.durationSec)) : 0,
    transcript: typeof body.interview.transcript === 'string' ? body.interview.transcript.slice(0, MAX_TRANSCRIPT_LENGTH) : '',
  } : undefined;

  const userEdits = body.userEdits && typeof body.userEdits === 'object' ? {
    edited: !!body.userEdits.edited,
    editLog: Array.isArray(body.userEdits.editLog)
      ? body.userEdits.editLog.slice(0, MAX_EDIT_LOG_ENTRIES).map((e: any) => ({
          ts: typeof e.ts === 'string' ? e.ts.slice(0, 30) : '',
          field: typeof e.field === 'string' ? e.field.slice(0, 100) : '',
          from: e.from ?? null,
          to: e.to ?? null,
        }))
      : [],
  } : undefined;

  try {
    const entry = await lookupToken(token);
    if (!entry) {
      return notFound('Invalid or expired token');
    }

    const now = new Date().toISOString();
    const submission = {
      token,
      respondent: {
        name: entry.respondentName,
        company: entry.companyName,
      },
      completedAt: now,
      dimensions: sanitizedDimensions,
      ...(interview && { interview }),
      ...(userEdits && { userEdits }),
      version: '1.0',
    };

    const ts = now.replace(/[:.]/g, '-');

    await putJson(`submissions/${token}/final/${ts}.json`, submission);
    await putJson(`submissions/${token}/latest.json`, submission);

    return created({ success: true, completedAt: now });
  } catch (err) {
    console.error('putSubmission error:', JSON.stringify(err));
    return serverError();
  }
}
