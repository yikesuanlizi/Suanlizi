import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readStoredWorkbenchState,
  readStoredWorkbenchVisibility,
  writeStoredWorkbenchState,
  writeStoredWorkbenchVisibility,
} from './workbenchState.js';

describe('workbenchState thread isolation', () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores dynamic tabs only for the thread that opened them', () => {
    writeStoredWorkbenchState({
      activeTab: 'browser',
      openUtilityTabs: ['files', 'browser', 'terminal:1'],
    }, 'thread-a');

    expect(readStoredWorkbenchState('thread-a')).toEqual({
      activeTab: 'browser',
      openUtilityTabs: ['files', 'browser', 'terminal:1'],
    });
    expect(readStoredWorkbenchState('thread-b')).toEqual({
      activeTab: 'activity',
      openUtilityTabs: [],
    });
  });

  it('ignores unsupported global dynamic tabs', () => {
    values.set('suanlizi.workbench.state.v1', JSON.stringify({
      activeTab: 'browser',
      openUtilityTabs: ['browser'],
    }));
    values.set('suanlizi.rightPane.tab', 'files');

    expect(readStoredWorkbenchState('new-thread')).toEqual({
      activeTab: 'activity',
      openUtilityTabs: [],
    });
    expect(readStoredWorkbenchState()).toEqual({
      activeTab: 'activity',
      openUtilityTabs: [],
    });
  });

  it('persists sidebar visibility only for the selected thread', () => {
    writeStoredWorkbenchVisibility(false, 'thread-a');
    writeStoredWorkbenchVisibility(true, 'thread-b');

    expect(readStoredWorkbenchVisibility('thread-a')).toBe(false);
    expect(readStoredWorkbenchVisibility('thread-b')).toBe(true);
    expect(readStoredWorkbenchVisibility()).toBe(false);
  });
});
