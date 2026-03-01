import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiGet, apiPost, apiPut } from '../api.js';

describe('api module', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('apiGet', () => {
    it('fetches from /api + path and returns JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: 'hello' }),
      });

      const result = await apiGet('/config/dimensions');
      expect(mockFetch).toHaveBeenCalledWith('/api/config/dimensions');
      expect(result).toEqual({ data: 'hello' });
    });

    it('throws on non-ok response with error message', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      });

      await expect(apiGet('/missing')).rejects.toThrow('Not found');
    });

    it('throws with HTTP status when error JSON is unparseable', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => { throw new Error('bad json'); },
      });

      await expect(apiGet('/broken')).rejects.toThrow('HTTP 500');
    });
  });

  describe('apiPost', () => {
    it('sends POST with JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await apiPost('/score', { token: 'abc' });
      expect(mockFetch).toHaveBeenCalledWith('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'abc' }),
      });
      expect(result).toEqual({ success: true });
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Bad request' }),
      });

      await expect(apiPost('/score', {})).rejects.toThrow('Bad request');
    });
  });

  describe('apiPut', () => {
    it('sends PUT with JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      await apiPut('/submission/token123', { dimensions: [] });
      expect(mockFetch).toHaveBeenCalledWith('/api/submission/token123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dimensions: [] }),
      });
    });
  });
});
