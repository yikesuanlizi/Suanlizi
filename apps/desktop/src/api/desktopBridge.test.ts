import { afterEach, describe, expect, it } from 'vitest';
import { listBrowserTabFavicons, readActiveBrowserTabFavicon } from './desktopBridge.js';

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

describe('desktop provider tab favicon capture', () => {
  it('uses only matching current-thread site instead of the first visible tab', async () => {
    let requestedThread: string | undefined;
    globalThis.window = { suanliziDesktop: { browser: { listTabs: async (input?: { threadId?: string }) => {
      requestedThread = input?.threadId;
      return [
        { url: 'https://unrelated.example', favicon: 'https://unrelated.example/favicon.ico', visible: true },
        { url: 'https://www.vendor.example', favicon: 'https://vendor.example/favicon.svg', visible: false },
      ];
    } } } } as unknown as Window & typeof globalThis;
    expect(await readActiveBrowserTabFavicon({ threadId: 'thread-1', baseUrl: 'https://api.vendor.example/v1' }))
      .toBe('https://vendor.example/favicon.svg');
    expect(requestedThread).toBe('thread-1');
    expect((await listBrowserTabFavicons({ threadId: 'thread-1' })).length).toBe(2);
    expect(await readActiveBrowserTabFavicon({ threadId: 'thread-1', baseUrl: 'https://other.example/v1' })).toBeNull();
  });
  it('ignores invalid browser favicons', async () => {
    globalThis.window = { suanliziDesktop: { browser: { listTabs: async () => [
      { url: 'https://vendor.example', favicon: 'javascript:alert(1)' },
    ] } } } as unknown as Window & typeof globalThis;
    expect(await listBrowserTabFavicons({ threadId: 'thread-1' })).toEqual([]);
  });
});
