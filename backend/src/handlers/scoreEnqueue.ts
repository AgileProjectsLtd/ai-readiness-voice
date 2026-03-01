import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import { lookupToken, isValidTokenFormat } from '../lib/allowlist';
import { putJson } from '../lib/s3';
import { ok, badRequest, notFound, serverError } from '../lib/response';

const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const sqs = new SQSClient({ region: REGION });
const QUEUE_NAME = process.env.SCORE_QUEUE_NAME || 'ai-readiness-dev-score-queue';

let _queueUrl: string | undefined = process.env.SCORE_QUEUE_URL || undefined;

async function getQueueUrl(): Promise<string> {
  if (_queueUrl) return _queueUrl;
  const res = await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }));
  _queueUrl = res.QueueUrl!;
  return _queueUrl;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {

  let body: { token?: string; transcript?: Array<{ speaker: string; text: string }>; durationSec?: number };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { token, transcript } = body;
  if (!isValidTokenFormat(token)) {
    return badRequest('Invalid token');
  }
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return badRequest('Transcript is required');
  }

  try {
    const entry = await lookupToken(token!);
    if (!entry) {
      return notFound('Invalid or expired token');
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();

    const durationSec = typeof body.durationSec === 'number' ? Math.max(0, Math.round(body.durationSec)) : 0;

    await putJson(`jobs/${jobId}.json`, {
      jobId,
      status: 'pending',
      token,
      transcript,
      durationSec,
      createdAt: now,
    });

    const queueUrl = await getQueueUrl();
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ jobId }),
    }));

    return ok({ jobId, status: 'pending' });
  } catch (err) {
    console.error('scoreEnqueue error:', err instanceof Error ? err.message : JSON.stringify(err));
    return serverError();
  }
}
