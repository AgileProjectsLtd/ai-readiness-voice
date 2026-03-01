import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: class { send = mockSend; },
  SendEmailCommand: class { constructor(public input: any) {} },
}));

import { sendScoreEmail } from '../email';
import type { DimensionsConfig } from '../dimensions';

const dimensionsConfig: DimensionsConfig = {
  categories: [
    {
      id: 'strategy',
      label: 'Strategy & Vision',
      dimensions: [
        { id: 'sv_align', statement: 'AI strategy is aligned' },
        { id: 'sv_road', statement: 'Roadmap exists' },
      ],
    },
    {
      id: 'data',
      label: 'Data',
      dimensions: [
        { id: 'di_quality', statement: 'Data quality enforced' },
      ],
    },
  ],
};

const baseOpts = {
  respondent: { name: 'Alice', company: 'Acme' },
  completedAt: '2025-06-15T10:30:00.000Z',
  dimensions: [
    { id: 'sv_align', score: 4 as number | null, confidence: 0.9, rationale: 'Strong alignment', evidence: ['OKRs'] },
    { id: 'sv_road', score: 2 as number | null, confidence: 0.5, rationale: 'Informal only', evidence: [] },
    { id: 'di_quality', score: null, confidence: 0.1, rationale: 'No info', evidence: [] },
  ],
  dimensionsConfig,
};

describe('sendScoreEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NOTIFICATION_EMAIL;
  });

  it('does nothing when NOTIFICATION_EMAIL is not set', async () => {
    await sendScoreEmail(baseOpts);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends email via SES when NOTIFICATION_EMAIL is set', async () => {
    process.env.NOTIFICATION_EMAIL = 'admin@example.com';

    await sendScoreEmail(baseOpts);

    expect(mockSend).toHaveBeenCalledOnce();
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Source).toBe('admin@example.com');
    expect(cmd.input.Destination.ToAddresses).toEqual(['admin@example.com']);
    expect(cmd.input.Message.Subject.Data).toContain('Alice');
    expect(cmd.input.Message.Subject.Data).toContain('Acme');
  });

  it('includes dimension scores and categories in the HTML body', async () => {
    process.env.NOTIFICATION_EMAIL = 'admin@example.com';

    await sendScoreEmail(baseOpts);

    const html = mockSend.mock.calls[0][0].input.Message.Body.Html.Data as string;
    expect(html).toContain('Strategy & Vision');
    expect(html).toContain('Data');
    expect(html).toContain('AI strategy is aligned');
    expect(html).toContain('Strong alignment');
    expect(html).toContain('90%'); // 0.9 confidence
    expect(html).toContain('—');  // null score renders as em-dash
  });

  it('applies green color for scores >= 4', async () => {
    process.env.NOTIFICATION_EMAIL = 'admin@example.com';

    await sendScoreEmail(baseOpts);

    const html = mockSend.mock.calls[0][0].input.Message.Body.Html.Data as string;
    expect(html).toContain('#2e7d32'); // green for score 4
  });

  it('applies yellow color for score 3', async () => {
    process.env.NOTIFICATION_EMAIL = 'admin@example.com';
    const opts = {
      ...baseOpts,
      dimensions: [{ id: 'sv_align', score: 3 as number | null, confidence: 0.5, rationale: 'Mid', evidence: [] }],
    };

    await sendScoreEmail(opts);

    const html = mockSend.mock.calls[0][0].input.Message.Body.Html.Data as string;
    expect(html).toContain('#f9a825'); // yellow for score 3
  });

  it('applies red color for scores <= 2', async () => {
    process.env.NOTIFICATION_EMAIL = 'admin@example.com';
    const opts = {
      ...baseOpts,
      dimensions: [{ id: 'sv_align', score: 1 as number | null, confidence: 0.3, rationale: 'Low', evidence: [] }],
    };

    await sendScoreEmail(opts);

    const html = mockSend.mock.calls[0][0].input.Message.Body.Html.Data as string;
    expect(html).toContain('#c62828'); // red for score 1
  });

  it('applies gray color for null scores', async () => {
    process.env.NOTIFICATION_EMAIL = 'admin@example.com';
    const opts = {
      ...baseOpts,
      dimensions: [{ id: 'sv_align', score: null, confidence: 0.1, rationale: 'N/A', evidence: [] }],
    };

    await sendScoreEmail(opts);

    const html = mockSend.mock.calls[0][0].input.Message.Body.Html.Data as string;
    expect(html).toContain('#999'); // gray for null
  });

  it('does not throw when SES send fails', async () => {
    process.env.NOTIFICATION_EMAIL = 'admin@example.com';
    mockSend.mockRejectedValue(new Error('SES quota exceeded'));

    await expect(sendScoreEmail(baseOpts)).resolves.not.toThrow();
  });
});
