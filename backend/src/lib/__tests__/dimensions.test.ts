import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../s3', () => ({
  getJson: vi.fn(),
}));

import { formatDimensionsBlock, totalDimensionCount } from '../dimensions';
import type { DimensionsConfig } from '../dimensions';

const sampleConfig: DimensionsConfig = {
  categories: [
    {
      id: 'strategy',
      label: 'Strategy & Vision',
      prefix: 'sv',
      dimensions: [
        { id: 'sv_alignment', statement: 'AI strategy is aligned with business goals' },
        { id: 'sv_roadmap', statement: 'A clear AI roadmap exists' },
      ],
    },
    {
      id: 'data',
      label: 'Data & Infrastructure',
      dimensions: [
        { id: 'di_quality', statement: 'Data quality standards are enforced' },
      ],
    },
  ],
};

describe('formatDimensionsBlock', () => {
  it('formats dimensions with category labels and numbered items', () => {
    const result = formatDimensionsBlock(sampleConfig);
    expect(result).toContain('Strategy & Vision (sv_):');
    expect(result).toContain('1. sv_alignment: AI strategy is aligned with business goals');
    expect(result).toContain('2. sv_roadmap: A clear AI roadmap exists');
    expect(result).toContain('3. di_quality: Data quality standards are enforced');
  });

  it('infers prefix from first dimension id when prefix is not provided', () => {
    const result = formatDimensionsBlock(sampleConfig);
    expect(result).toContain('Data & Infrastructure (di_):');
  });

  it('numbers continuously across categories', () => {
    const result = formatDimensionsBlock(sampleConfig);
    const lines = result.split('\n').filter(l => /^\d+\./.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^1\./);
    expect(lines[2]).toMatch(/^3\./);
  });
});

describe('totalDimensionCount', () => {
  it('sums dimensions across all categories', () => {
    expect(totalDimensionCount(sampleConfig)).toBe(3);
  });

  it('returns 0 for empty categories', () => {
    expect(totalDimensionCount({ categories: [] })).toBe(0);
  });
});
