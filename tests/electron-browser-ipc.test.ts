import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requireThreadScope,
  validateClick,
  validateCreateTab,
  validateListTabs,
  validateTabId,
  validateTabVisible,
} from '../apps/desktop/electron/ipc/validateIpc.js';

const handlers = new Map<string, (...args: any[]) => unknown>();
let managerRef: { createTab: ReturnType<typeof vi.fn> };

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
  },
}));

import { registerBrowserIpc } from '../apps/desktop/electron/ipc/registerBrowserIpc.js';

describe('browser IPC scope validation', () => {
  it('requires a normalized non-empty thread scope for renderer operations', () => {
    expect(() => requireThreadScope(undefined)).toThrow('threadId');
    expect(() => requireThreadScope('  ')).toThrow('threadId');
    expect(requireThreadScope(' thread-a ')).toBe('thread-a');
  });

  it('keeps optional thread scope only in the input parser for manager-internal callers', () => {
    expect(validateCreateTab({ url: 'about:blank', bounds: { x: 0, y: 0, width: 100, height: 100 } }).threadId).toBeUndefined();
    expect(validateListTabs(undefined)).toEqual({});
    expect(validateListTabs({ threadId: 'thread-a' })).toEqual({ threadId: 'thread-a' });
  });

  it('normalizes scoped tab input and rejects malformed pointer coordinates', () => {
    expect(validateTabId({ tabId: 'tab-1', threadId: ' thread-a ' })).toEqual({ tabId: 'tab-1', threadId: 'thread-a' });
    expect(validateTabVisible({ tabId: 'tab-1', threadId: 'thread-a', visible: false })).toEqual({ tabId: 'tab-1', threadId: 'thread-a', visible: false });
    expect(() => validateClick({ tabId: 'tab-1', x: Number.NaN, y: 2 })).toThrow('有限数字');
  });
});

describe('browser IPC registration', () => {
  beforeEach(() => {
    handlers.clear();
    const manager = {
      createTab: vi.fn((input: unknown) => input),
      hasTab: vi.fn(() => true),
      setBounds: vi.fn(), setVisible: vi.fn(), activateTab: vi.fn(), navigate: vi.fn(),
      back: vi.fn(), forward: vi.fn(), reload: vi.fn(), stop: vi.fn(), focus: vi.fn(),
      toggleDevTools: vi.fn(), assertTabScope: vi.fn(), destroy: vi.fn(), destroyThreadTabs: vi.fn(),
      hideAll: vi.fn(), listTabs: vi.fn(() => []), hasPendingAgentBrowserRequest: vi.fn(() => false),
      pendingAgentBrowserRequestTaskIds: vi.fn(() => []),
    };
    managerRef = manager;
    registerBrowserIpc({ manager: manager as never, adapterFor: vi.fn() as never });
  });

  it('rejects unscoped renderer tab creation and forwards a normalized scope', async () => {
    const handler = handlers.get('browser:createTab');
    expect(() => handler?.({}, { url: 'about:blank', bounds: { x: 0, y: 0, width: 10, height: 10 } })).toThrow('threadId');
    await handler?.({}, { url: 'about:blank', threadId: ' thread-a ', bounds: { x: 0, y: 0, width: 10, height: 10 } });
    expect(managerRef.createTab).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-a' }));
  });
});

describe('browser listTabs renderer contract', () => {
  beforeEach(() => {
    handlers.clear();
    const manager = {
      createTab: vi.fn((input: unknown) => input),
      hasTab: vi.fn(() => true),
      setBounds: vi.fn(), setVisible: vi.fn(), activateTab: vi.fn(), navigate: vi.fn(),
      back: vi.fn(), forward: vi.fn(), reload: vi.fn(), stop: vi.fn(), focus: vi.fn(),
      toggleDevTools: vi.fn(), assertTabScope: vi.fn(), destroy: vi.fn(), destroyThreadTabs: vi.fn(),
      hideAll: vi.fn(), listTabs: vi.fn(() => [
        { tabId: 'tab-1', url: 'https://provider.example', title: 'Provider', visible: true, loading: false, favicon: 'https://provider.example/favicon.ico' },
      ]), hasPendingAgentBrowserRequest: vi.fn(() => false),
      pendingAgentBrowserRequestTaskIds: vi.fn(() => []),
    };
    managerRef = manager;
    registerBrowserIpc({ manager: manager as never, adapterFor: vi.fn() as never });
  });

  it('requires thread scope and exposes favicon data for renderer consumers', async () => {
    const handler = handlers.get('browser:listTabs');
    await expect((async () => handler?.({}, undefined))()).rejects.toThrow('threadId');
    const tabs = await handler?.({}, { threadId: ' thread-a ' }) as Array<{ favicon?: string; visible?: boolean }>;
    expect(managerRef.listTabs).toHaveBeenCalledWith('thread-a');
    expect(tabs[0]?.favicon).toBe('https://provider.example/favicon.ico');
  });
});
