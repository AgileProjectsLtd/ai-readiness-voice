import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { lookupToken, isValidTokenFormat } from '../lib/allowlist';
import { getJson, putJson, copyObject } from '../lib/s3';
import { ok, notFound, badRequest, serverError } from '../lib/response';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const token = event.pathParameters?.token;
  if (!isValidTokenFormat(token)) {
    return badRequest('Invalid token format');
  }

  try {
    const entry = await lookupToken(token);
    if (!entry) {
      return notFound('Invalid or expired token');
    }

    const existing = await getJson<any>(`submissions/${token}/latest.json`);
    if (!existing) {
      return notFound('No submission to clear');
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await copyObject(
      `submissions/${token}/latest.json`,
      `submissions/${token}/archived/${ts}.json`
    );

    const tombstone = {
      token,
      cleared: true,
      clearedAt: new Date().toISOString(),
      previousCompletedAt: existing.completedAt,
    };
    await putJson(`submissions/${token}/latest.json`, tombstone);

    return ok({ success: true, message: 'Submission archived and cleared' });
  } catch (err) {
    console.error('clearSubmission error:', JSON.stringify(err));
    return serverError();
  }
}
