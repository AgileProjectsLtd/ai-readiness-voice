import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getJson } from '../lib/s3';
import { ok, unauthorized, serverError } from '../lib/response';
import { AllowlistFile } from '../lib/allowlist';
import { getAdminKey } from '../lib/secrets';

interface SubmissionDimension {
  id: string;
  score: number | null;
  confidence?: number;
  rationale?: string;
  evidence?: string[];
}

interface Submission {
  completedAt?: string;
  dimensions?: SubmissionDimension[];
  interview?: { durationSec?: number; turnCount?: number };
  cleared?: boolean;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const adminKey = await getAdminKey();
  if (!adminKey) {
    console.error('ADMIN_KEY not configured in Secrets Manager');
    return serverError('Admin access not configured');
  }

  const providedKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  if (providedKey !== adminKey) {
    return unauthorized('Invalid admin key');
  }

  try {
    const allowlist = await getJson<AllowlistFile>('allowlist/allowlist.json');
    if (!allowlist?.entries) {
      return ok({ respondents: [] });
    }

    const respondents = await Promise.all(
      allowlist.entries.map(async (entry) => {
        const sub = await getJson<Submission>(`submissions/${entry.token}/latest.json`);
        const hasSubmission = !!sub && !sub.cleared && !!sub.dimensions;

        const scores: Record<string, number | null> = {};
        let scoreSum = 0;
        let scoredCount = 0;
        let nullCount = 0;

        if (hasSubmission && sub.dimensions) {
          for (const dim of sub.dimensions) {
            scores[dim.id] = dim.score;
            if (dim.score !== null && dim.score !== undefined) {
              scoreSum += dim.score;
              scoredCount++;
            } else {
              nullCount++;
            }
          }
        }

        return {
          name: entry.respondentName,
          company: entry.companyName,
          tokenPrefix: entry.token.substring(0, 8),
          status: entry.status,
          hasSubmission,
          completedAt: hasSubmission ? sub.completedAt || null : null,
          durationSec: hasSubmission ? sub.interview?.durationSec || null : null,
          scores,
          averageScore: scoredCount > 0 ? Math.round((scoreSum / scoredCount) * 10) / 10 : null,
          scoredCount,
          nullCount,
        };
      })
    );

    return ok({ respondents });
  } catch (err) {
    console.error('adminDashboard error:', JSON.stringify(err));
    return serverError();
  }
}
