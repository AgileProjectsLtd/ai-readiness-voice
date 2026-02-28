import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { lookupToken, isValidTokenFormat } from '../lib/allowlist';
import { getJson } from '../lib/s3';
import { ok, notFound, badRequest, serverError } from '../lib/response';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const token = event.pathParameters?.token;
  if (!isValidTokenFormat(token)) {
    return badRequest('Invalid token format');
  }

  try {
    const entry = await lookupToken(token);
    if (!entry) {
      return notFound('Invalid or expired link');
    }

    const submission = await getJson<any>(`submissions/${token}/latest.json`);
    const hasSubmission = submission !== null;

    return ok({
      respondentName: entry.respondentName,
      companyName: entry.companyName,
      hasSubmission,
      metadata: entry.metadata || {},
    });
  } catch (err) {
    console.error('getRespondent error:', JSON.stringify(err));
    return serverError();
  }
}
