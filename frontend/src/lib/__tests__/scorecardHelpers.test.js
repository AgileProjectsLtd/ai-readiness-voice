import { describe, it, expect } from 'vitest';
import { normalizeDimensions, buildDefaultScorecard } from '../scorecardHelpers.js';

describe('normalizeDimensions', () => {
  it('passes through well-formed dimensions', () => {
    const dims = [{ id: 'd1', score: 4, confidence: 0.8, rationale: 'Good', evidence: ['e'] }];
    const result = normalizeDimensions(dims);
    expect(result).toEqual(dims);
  });

  it('coerces score strings to numbers', () => {
    const dims = [{ id: 'd1', score: '3', confidence: '0.5', rationale: '', evidence: [] }];
    const result = normalizeDimensions(dims);
    expect(result[0].score).toBe(3);
    expect(result[0].confidence).toBe(0.5);
  });

  it('converts null score to null', () => {
    const dims = [{ id: 'd1', score: null, confidence: 0, rationale: '', evidence: [] }];
    expect(normalizeDimensions(dims)[0].score).toBeNull();
  });

  it('converts undefined score to null', () => {
    const dims = [{ id: 'd1', confidence: 0 }];
    expect(normalizeDimensions(dims)[0].score).toBeNull();
  });

  it('defaults missing rationale to empty string', () => {
    const dims = [{ id: 'd1', score: 3, confidence: 0.5 }];
    expect(normalizeDimensions(dims)[0].rationale).toBe('');
  });

  it('defaults non-array evidence to empty array', () => {
    const dims = [{ id: 'd1', score: 3, confidence: 0.5, evidence: 'not-array' }];
    expect(normalizeDimensions(dims)[0].evidence).toEqual([]);
  });

  it('defaults missing confidence to 0', () => {
    const dims = [{ id: 'd1', score: 3 }];
    expect(normalizeDimensions(dims)[0].confidence).toBe(0);
  });
});

describe('buildDefaultScorecard', () => {
  it('builds scorecard entries for given dim IDs', () => {
    const result = buildDefaultScorecard(['d1', 'd2', 'd3']);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 'd1', score: null, confidence: 0, rationale: '', evidence: [] });
    expect(result[2].id).toBe('d3');
  });

  it('returns empty array for no dim IDs', () => {
    expect(buildDefaultScorecard([])).toEqual([]);
  });

  it('sets all scores to null', () => {
    const result = buildDefaultScorecard(['a', 'b']);
    expect(result.every(d => d.score === null)).toBe(true);
  });
});
