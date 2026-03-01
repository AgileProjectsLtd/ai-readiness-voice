import { SQSEvent } from 'aws-lambda';
import { getOpenAIKey } from '../lib/secrets';
import { getJson, putJson } from '../lib/s3';
import { Scorecard, scorecardJsonSchema } from '../lib/scorecardSchema';
import { DimensionsConfig, loadDimensions, formatDimensionsBlock, totalDimensionCount } from '../lib/dimensions';
import { lookupToken } from '../lib/allowlist';
import { writeSubmission } from '../lib/submission';
import { sendScoreEmail } from '../lib/email';

interface ScoringJob {
  jobId: string;
  status: string;
  token: string;
  transcript: Array<{ speaker: string; text: string }>;
  durationSec?: number;
  createdAt: string;
}

function buildScoringPrompt(dimensions: DimensionsConfig): string {
  const count = totalDimensionCount(dimensions);

  return `You are an AI readiness scoring specialist. Given an interview transcript, score each dimension on a 1-5 Likert scale.

SCORING FRAMEWORK:
1 = Strongly Disagree / None — No evidence, not in place, informal or absent.
2 = Mostly Disagree / Ad-hoc — Isolated or inconsistent activity; informal; not repeatable.
3 = Neutral / Emerging — Partial; emerging structure; limited adoption; inconsistent execution.
4 = Mostly Agree / Established — Defined, repeatable, measurable; clear ownership.
5 = Strongly Agree / Mature — Enterprise-wide, measured, continuously improved; strong governance and integration.

SCORING RULES:
- Every score must be supported by explicit evidence from the conversation.
- If evidence is unclear or inferred, reduce confidence.
- If policies exist but are not followed, cap score at 3.
- If respondent truly cannot answer, set score to null and confidence low.
- "We're starting" without specifics should cap at 2-3 depending on clarity.
- Do not inflate scores without operational detail.

CONFIDENCE GUIDANCE:
- 0.8-1.0 = explicit, concrete, consistent evidence
- 0.6-0.79 = mostly explicit but partial
- 0.3-0.59 = inferred or incomplete
- <0.3 = weak evidence or unanswered

CONSISTENCY CHECKS:
- If contradictions appear, reduce confidence.
- Do not silently average contradictions.

THE ${count} DIMENSIONS TO SCORE:

${formatDimensionsBlock(dimensions)}

INSTRUCTIONS:
- Score ALL ${count} dimensions. Use the exact dimension IDs listed above.
- Keep rationale under 20 words.
- Evidence should be max 1 short string per dimension.
- Set type to "final_scorecard".`;
}

async function resolveRespondent(token: string): Promise<{ name: string; company: string }> {
  const entry = await lookupToken(token);
  return entry
    ? { name: entry.respondentName, company: entry.companyName }
    : { name: 'Unknown', company: 'Unknown' };
}

async function autoSaveSubmission(job: ScoringJob, scorecard: any, completedAt: string, respondent: { name: string; company: string }): Promise<void> {
  try {
    await writeSubmission({
      token: job.token,
      respondent,
      completedAt,
      dimensions: scorecard.dimensions,
      interview: {
        turnCount: job.transcript.length,
        durationSec: job.durationSec || 0,
        transcript: job.transcript.map(t => `[${t.speaker}] ${t.text}`).join('\n'),
      },
      userEdits: { edited: false, editLog: [] },
      version: '1.0',
    });
    console.log(`Submission auto-saved for token ${job.token}`);
  } catch (err) {
    console.error('Failed to auto-save submission:', err instanceof Error ? err.message : String(err));
  }
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { jobId } = JSON.parse(record.body) as { jobId: string };
    const jobKey = `jobs/${jobId}.json`;

    try {
      const job = await getJson<ScoringJob>(jobKey);
      if (!job) {
        console.error(`Job not found in S3: ${jobId}`);
        return;
      }

      const apiKey = await getOpenAIKey();
      const dimensions = await loadDimensions();
      const systemPrompt = buildScoringPrompt(dimensions);

      const formattedTranscript = job.transcript
        .map(t => `[${t.speaker === 'ai' ? 'Interviewer' : 'Respondent'}] ${t.text}`)
        .join('\n');

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Score the following interview transcript:\n\n${formattedTranscript}` },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'scorecard',
              strict: true,
              schema: scorecardJsonSchema,
            },
          },
          temperature: 0.3,
          max_completion_tokens: 4096,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('OpenAI scoring failed:', response.status, errText);
        await putJson(jobKey, { ...job, status: 'failed', error: `OpenAI ${response.status}`, failedAt: new Date().toISOString() });
        return;
      }

      const result = await response.json() as any;
      const content = result.choices?.[0]?.message?.content;
      if (!content) {
        console.error('No content in scoring response:', JSON.stringify(result));
        await putJson(jobKey, { ...job, status: 'failed', error: 'No content in response', failedAt: new Date().toISOString() });
        return;
      }

      const parsed = JSON.parse(content);
      const validated = Scorecard.parse(parsed);

      const now = new Date().toISOString();

      await putJson(jobKey, {
        jobId: job.jobId,
        status: 'complete',
        token: job.token,
        createdAt: job.createdAt,
        completedAt: now,
        scorecard: validated,
      });

      const respondent = await resolveRespondent(job.token);
      await autoSaveSubmission(job, validated, now, respondent);
      await sendScoreEmail({
        respondent,
        completedAt: now,
        dimensions: validated.dimensions,
        dimensionsConfig: dimensions,
      });
    } catch (err) {
      console.error('scoreWorker error:', err instanceof Error ? err.message : JSON.stringify(err));
      try {
        const job = await getJson<ScoringJob>(jobKey);
        if (job) {
          await putJson(jobKey, { ...job, status: 'failed', error: String(err), failedAt: new Date().toISOString() });
        }
      } catch { /* best effort */ }
    }
  }
}
