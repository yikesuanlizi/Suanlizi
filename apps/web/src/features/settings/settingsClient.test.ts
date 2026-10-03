import { describe, expect, it, vi } from 'vitest';
import { saveActiveThreadConfig, saveGlobalDefaults } from './settingsClient.js';

describe('settingsClient', () => {
  const createMockFetcher = (ok = true) => {
    const mockResponse = {
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Internal Server Error',
    } as Response;
    return vi.fn().mockResolvedValue(mockResponse);
  };

  describe('saveGlobalDefaults', () => {
    it('should POST to /api/settings with payload excluding appearance fields', async () => {
      const fetcher = createMockFetcher();
      await saveGlobalDefaults(
        {
          model: 'test-model',
          provider: 'ollama',
          themeMode: 'dark',
          userAvatarId: 'rocket',
          customUserAvatarDataUrl: 'data:image/png;base64,xxx',
        },
        fetcher,
      );

      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, options] = fetcher.mock.calls[0];
      expect(url).toBe('/api/settings');
      expect(options?.method).toBe('PATCH');
      expect(options?.headers).toEqual({ 'Content-Type': 'application/json' });

      const body = JSON.parse(options?.body as string) as {
        config: Record<string, unknown>;
      };
      expect(body.config.model).toBe('test-model');
      expect(body.config.provider).toBe('ollama');
      expect(body.config.themeMode).toBeUndefined();
      expect(body.config.userAvatarId).toBeUndefined();
      expect(body.config.customUserAvatarDataUrl).toBeUndefined();
    });

    it('should throw error on non-2xx response', async () => {
      const fetcher = createMockFetcher(false);
      await expect(saveGlobalDefaults({ model: 'm' }, fetcher)).rejects.toThrow('Failed to patch config: 500');
    });
  });

  describe('saveActiveThreadConfig', () => {
    it('should PATCH to correct thread URL with set and unset fields', async () => {
      const fetcher = createMockFetcher();
      const update = {
        set: { model: 'thread-model', provider: 'thread-provider' },
        unset: ['modelContextTokens' as const],
      };

      await saveActiveThreadConfig('thread-123', update, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, options] = fetcher.mock.calls[0];
      expect(url).toBe('/api/threads/thread-123/config');
      expect(options?.method).toBe('PATCH');
      expect(options?.headers).toEqual({ 'Content-Type': 'application/json' });

      const body = JSON.parse(options?.body as string);
      expect(body.set).toEqual({ model: 'thread-model', provider: 'thread-provider' });
      expect(body.unset).toEqual(['modelContextTokens']);
    });

    it('should throw error on non-2xx response', async () => {
      const fetcher = createMockFetcher(false);
      await expect(
        saveActiveThreadConfig('t1', { set: { model: 'm' } }, fetcher),
      ).rejects.toThrow('Failed to patch thread config: 500');
    });
  });
});
