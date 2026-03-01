import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getJson } from '../lib/s3';
import { ok, notFound, badRequest, serverError } from '../lib/response';

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const jobId = event.pathParameters?.jobId;
  if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
    return badRequest('Invalid job ID');
  }

  try {
    const job = await getJson<Record<string, unknown>>(`jobs/${jobId}.json`);
    if (!job) {
      return notFound('Job not found');
    }

    const status = job.status as string;

    if (status === 'complete') {
      return ok({ jobId, status, scorecard: job.scorecard });
    }

    if (status === 'failed') {
      return ok({ jobId, status, error: job.error });
    }

    return ok({ jobId, status });
  } catch (err) {
    console.error('getScoreResult error:', err instanceof Error ? err.message : JSON.stringify(err));
    return serverError();
  }
}
