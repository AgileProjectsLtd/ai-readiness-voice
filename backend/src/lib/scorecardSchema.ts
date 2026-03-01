import { z } from 'zod';

export const DimensionScore = z.object({
  id: z.string().describe('The stable dimension ID, e.g. "sv_strategy_linked_to_objectives"'),
  score: z.number().int().min(1).max(5).nullable().describe('1-5 Likert score, null if insufficient info'),
  confidence: z.number().min(0).max(1).describe('0.0-1.0 confidence in the score'),
  rationale: z.string().describe('Brief explanation, max 20 words'),
  evidence: z.array(z.string()).describe('Short evidence snippets from the conversation'),
});

export const Scorecard = z.object({
  type: z.literal('final_scorecard'),
  dimensions: z.array(DimensionScore),
});

export const scorecardJsonSchema = z.toJSONSchema(Scorecard);
