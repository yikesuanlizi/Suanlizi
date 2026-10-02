import { describe, expect, it, vi } from 'vitest';
import { contextTokensForSelectedModel, fetchModelContextReferences } from './modelContextReferencesClient.js';

const selection = { provider: 'custom_vendor', model: 'glm-5.3-flash', baseUrl: 'https://example.test/v1' };

describe('model context selection', () => {
  it('keeps an explicit model length without probing or reading the reference list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await contextTokensForSelectedModel({ ...selection, modelContextTokens: 131_072 })).toBe(131_072);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('copies a reference value when the provider does not disclose its window', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/model-capabilities'
      ? { source: 'unavailable' }
      : { entries: [{ model: 'glm-5.3-flash', contextTokens: 65_536 }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await contextTokensForSelectedModel(selection)).toBe(65_536);
      expect(await fetchModelContextReferences()).toEqual([{ model: 'glm-5.3-flash', contextTokens: 65_536 }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('prefers server recognition and leaves unmatched models unknown', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ source: 'server', contextTokens: 262_144 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await contextTokensForSelectedModel(selection)).toBe(262_144);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })));
    try { expect(await contextTokensForSelectedModel(selection)).toBeUndefined(); }
    finally { vi.unstubAllGlobals(); }
  });
});
