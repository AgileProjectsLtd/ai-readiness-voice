import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ok, serverError } from '../lib/response';
import { loadDimensions } from '../lib/dimensions';

export async function handler(_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const config = await loadDimensions();
    return ok(config);
  } catch (err) {
    console.error('getConfig error:', JSON.stringify(err));
    return serverError();
  }
}
