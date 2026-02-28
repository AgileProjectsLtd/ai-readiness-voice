import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getJson } from '../lib/s3';
import { ok, serverError } from '../lib/response';

interface DimensionsConfig {
  version?: string;
  scale?: unknown;
  categories: Array<{
    id: string;
    label: string;
    prefix?: string;
    dimensions: Array<{ id: string; statement: string }>;
  }>;
}

let cached: DimensionsConfig | null = null;

export async function handler(_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!cached) {
      cached = await getJson<DimensionsConfig>('config/dimensions.json');
    }
    if (!cached?.categories) {
      return serverError('Dimensions config not found — upload config/dimensions.json to S3');
    }
    return ok(cached);
  } catch (err) {
    console.error('getConfig error:', JSON.stringify(err));
    return serverError();
  }
}
