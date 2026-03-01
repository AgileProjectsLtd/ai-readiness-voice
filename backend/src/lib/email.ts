import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { DimensionsConfig } from './dimensions';

const ses = new SESClient({ region: process.env.SES_REGION || process.env.AWS_REGION || 'ap-southeast-1' });

interface ScoreEmailOpts {
  respondent: { name: string; company: string };
  completedAt: string;
  dimensions: Array<{ id: string; score: number | null; confidence: number; rationale: string; evidence: string[] }>;
  dimensionsConfig: DimensionsConfig;
}

function buildDimensionLookup(config: DimensionsConfig): Map<string, { statement: string; category: string }> {
  const map = new Map<string, { statement: string; category: string }>();
  for (const cat of config.categories) {
    for (const dim of cat.dimensions) {
      map.set(dim.id, { statement: dim.statement, category: cat.label });
    }
  }
  return map;
}

function scoreColor(score: number | null): string {
  if (score === null) return '#999';
  if (score >= 4) return '#2e7d32';
  if (score >= 3) return '#f9a825';
  return '#c62828';
}

function buildHtml(opts: ScoreEmailOpts): string {
  const lookup = buildDimensionLookup(opts.dimensionsConfig);
  const completedDate = new Date(opts.completedAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const categoryRows: string[] = [];
  let currentCategory = '';

  for (const dim of opts.dimensions) {
    const info = lookup.get(dim.id);
    const category = info?.category || 'Other';
    const label = info?.statement || dim.id;

    if (category !== currentCategory) {
      currentCategory = category;
      categoryRows.push(`
        <tr>
          <td colspan="4" style="background:#f0f0f0;padding:10px 12px;font-weight:bold;font-size:14px;border-bottom:2px solid #ccc;">
            ${category}
          </td>
        </tr>`);
    }

    const color = scoreColor(dim.score);
    categoryRows.push(`
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${label}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;color:${color};">${dim.score ?? '—'}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;font-size:13px;">${Math.round(dim.confidence * 100)}%</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;color:#555;">${dim.rationale}</td>
        </tr>`);
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:20px;background:#fafafa;">
  <div style="max-width:800px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1a237e;color:#fff;padding:24px;">
      <h1 style="margin:0;font-size:20px;">AI Readiness Scorecard</h1>
      <p style="margin:8px 0 0;opacity:0.85;font-size:14px;">${opts.respondent.name} — ${opts.respondent.company}</p>
    </div>
    <div style="padding:20px;">
      <p style="margin:0 0 16px;font-size:13px;color:#666;">Completed: ${completedDate}</p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#fafafa;">
            <th style="text-align:left;padding:10px 12px;border-bottom:2px solid #ddd;font-size:13px;">Dimension</th>
            <th style="text-align:center;padding:10px 12px;border-bottom:2px solid #ddd;font-size:13px;width:60px;">Score</th>
            <th style="text-align:center;padding:10px 12px;border-bottom:2px solid #ddd;font-size:13px;width:80px;">Confidence</th>
            <th style="text-align:left;padding:10px 12px;border-bottom:2px solid #ddd;font-size:13px;">Rationale</th>
          </tr>
        </thead>
        <tbody>${categoryRows.join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

export async function sendScoreEmail(opts: ScoreEmailOpts): Promise<void> {
  const recipient = process.env.NOTIFICATION_EMAIL;
  if (!recipient) return;

  try {
    const html = buildHtml(opts);
    await ses.send(new SendEmailCommand({
      Source: recipient,
      Destination: { ToAddresses: [recipient] },
      Message: {
        Subject: { Data: `AI Readiness Score: ${opts.respondent.name} (${opts.respondent.company})` },
        Body: { Html: { Data: html } },
      },
    }));
    console.log(`Score email sent to ${recipient} for ${opts.respondent.name}`);
  } catch (err) {
    console.error('Failed to send score email:', err instanceof Error ? err.message : String(err));
  }
}
