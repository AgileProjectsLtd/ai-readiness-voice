import { describe, it, expect } from 'vitest';
import { DimensionScore, Scorecard } from '../scorecardSchema';

describe('DimensionScore schema', () => {
  const valid = {
    id: 'sv_strategy_linked_to_objectives',
    score: 4,
    confidence: 0.85,
    rationale: 'Clear strategic alignment',
    evidence: ['mentioned OKR framework'],
  };

  it('accepts a valid dimension score', () => {
    expect(() => DimensionScore.parse(valid)).not.toThrow();
  });

  it('accepts null score', () => {
    const result = DimensionScore.parse({ ...valid, score: null });
    expect(result.score).toBeNull();
  });

  it('rejects score below 1', () => {
    expect(() => DimensionScore.parse({ ...valid, score: 0 })).toThrow();
  });

  it('rejects score above 5', () => {
    expect(() => DimensionScore.parse({ ...valid, score: 6 })).toThrow();
  });

  it('rejects non-integer scores', () => {
    expect(() => DimensionScore.parse({ ...valid, score: 3.5 })).toThrow();
  });

  it('rejects confidence below 0', () => {
    expect(() => DimensionScore.parse({ ...valid, confidence: -0.1 })).toThrow();
  });

  it('rejects confidence above 1', () => {
    expect(() => DimensionScore.parse({ ...valid, confidence: 1.1 })).toThrow();
  });

  it('rejects missing id', () => {
    const { id, ...rest } = valid;
    expect(() => DimensionScore.parse(rest)).toThrow();
  });
});

describe('Scorecard schema', () => {
  const validScorecard = {
    type: 'final_scorecard',
    dimensions: [
      {
        id: 'dim1',
        score: 3,
        confidence: 0.7,
        rationale: 'Some rationale',
        evidence: ['evidence 1'],
      },
    ],
  };

  it('accepts a valid scorecard', () => {
    expect(() => Scorecard.parse(validScorecard)).not.toThrow();
  });

  it('rejects wrong type literal', () => {
    expect(() => Scorecard.parse({ ...validScorecard, type: 'draft' })).toThrow();
  });

  it('rejects missing dimensions', () => {
    expect(() => Scorecard.parse({ type: 'final_scorecard' })).toThrow();
  });

  it('accepts empty dimensions array', () => {
    expect(() => Scorecard.parse({ type: 'final_scorecard', dimensions: [] })).not.toThrow();
  });
});
