import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api.js', () => ({
  apiGet: vi.fn(),
}));

import { loadDimensions, DIMENSIONS, allDimIds, SCALE_LABELS } from '../dimensions.js';
import { apiGet } from '../../api.js';

const mockApiGet = vi.mocked(apiGet);

const sampleConfig = {
  categories: [
    {
      id: 'strategy',
      label: 'Strategy & Vision',
      dimensions: [
        { id: 'sv_align', statement: 'AI strategy aligned' },
        { id: 'sv_road', statement: 'Roadmap exists' },
      ],
    },
    {
      id: 'data',
      label: 'Data',
      dimensions: [
        { id: 'di_quality', statement: 'Quality enforced' },
      ],
    },
  ],
  scale: {
    labels: { 1: 'Strongly Disagree', 5: 'Strongly Agree' },
  },
};

describe('loadDimensions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<span id="scale-legend"></span>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('fetches config and populates DIMENSIONS map', async () => {
    mockApiGet.mockResolvedValue(sampleConfig);

    await loadDimensions();

    const { DIMENSIONS: dims } = await import('../dimensions.js');
    expect(dims).toHaveProperty('strategy');
    expect(dims.strategy.label).toBe('Strategy & Vision');
    expect(dims.strategy.dims).toHaveLength(2);
    expect(dims.data.dims).toHaveLength(1);
  });

  it('populates allDimIds with all dimension IDs', async () => {
    mockApiGet.mockResolvedValue(sampleConfig);

    await loadDimensions();

    const { allDimIds: ids } = await import('../dimensions.js');
    expect(ids).toEqual(['sv_align', 'sv_road', 'di_quality']);
  });

  it('populates SCALE_LABELS from config', async () => {
    mockApiGet.mockResolvedValue(sampleConfig);

    await loadDimensions();

    const { SCALE_LABELS: labels } = await import('../dimensions.js');
    expect(labels).toEqual({ 1: 'Strongly Disagree', 5: 'Strongly Agree' });
  });

  it('renders scale legend into the DOM element', async () => {
    mockApiGet.mockResolvedValue(sampleConfig);

    await loadDimensions();

    const legend = document.getElementById('scale-legend');
    expect(legend.innerHTML).toContain('<strong>1</strong>');
    expect(legend.innerHTML).toContain('Strongly Disagree');
    expect(legend.innerHTML).toContain('N/A');
  });

  it('handles missing scale-legend element gracefully', async () => {
    document.body.innerHTML = '';
    mockApiGet.mockResolvedValue(sampleConfig);

    await expect(loadDimensions()).resolves.not.toThrow();
  });

  it('defaults SCALE_LABELS to empty object when scale is absent', async () => {
    mockApiGet.mockResolvedValue({
      categories: [{ id: 'c', label: 'C', dimensions: [{ id: 'c_1', statement: 's' }] }],
    });

    await loadDimensions();

    const { SCALE_LABELS: labels } = await import('../dimensions.js');
    expect(labels).toEqual({});
  });
});
