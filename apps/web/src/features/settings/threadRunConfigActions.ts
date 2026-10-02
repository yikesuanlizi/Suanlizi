import type { ThreadConfigUpdate, ThreadRunConfigKey, ThreadRunConfigOverrides } from '@suanlizi/protocol';
import type { AppearanceConfig, ConfigState, ConfigStateAction, GlobalRuntimeConfig } from './configState.js';
import { saveActiveThreadConfig, saveGlobalDefaults } from './settingsClient.js';

type Dispatch = (action: ConfigStateAction) => void;
type GetState = () => ConfigState;
type Fetcher = typeof fetch;

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const APPEARANCE_STORAGE_KEY = 'suanlizi.appearance';

export interface ThreadRunConfigActions {
  saveGlobal: (patch: Partial<GlobalRuntimeConfig>) => Promise<void>;
  saveThread: (threadId: string, update: ThreadConfigUpdate) => Promise<void>;
  saveNewThread: (patch: ThreadRunConfigOverrides) => void;
  unsetThread: (threadId: string, keys: ThreadRunConfigKey[]) => Promise<void>;
  saveAppearance: (patch: Partial<AppearanceConfig>) => void;
}

interface PendingRequest {
  id: number;
  threadId?: string;
}

export function createThreadRunConfigActions(
  getState: GetState,
  dispatch: Dispatch,
  fetcher: Fetcher = fetch,
  storage: Storage = typeof window !== 'undefined' ? window.localStorage : {
    getItem: () => null,
    setItem: () => {},
  },
): ThreadRunConfigActions {
  let nextRequestId = 0;
  let latestPendingRequest: PendingRequest | null = null;

  function isRequestStale(request: PendingRequest): boolean {
    if (latestPendingRequest?.id !== request.id) {
      return true;
    }
    if (request.threadId !== undefined) {
      const currentThreadId = getState().activeThreadId;
      if (currentThreadId !== request.threadId) {
        return true;
      }
    }
    return false;
  }

  function loadAppearanceFromStorage(): Partial<AppearanceConfig> {
    try {
      const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw) as Partial<AppearanceConfig>;
      }
    } catch {
    }
    return {};
  }

  function saveAppearanceToStorage(patch: Partial<AppearanceConfig>): void {
    try {
      const current = loadAppearanceFromStorage();
      const next = { ...current, ...patch };
      storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
    } catch {
    }
  }

  const initialAppearance = loadAppearanceFromStorage();
  if (Object.keys(initialAppearance).length > 0) {
    dispatch({ type: 'appearance.patched', patch: initialAppearance });
  }

  return {
    async saveGlobal(patch: Partial<GlobalRuntimeConfig>): Promise<void> {
      const requestId = ++nextRequestId;
      const request: PendingRequest = { id: requestId };
      latestPendingRequest = request;

      const currentState = getState();
      const mergedForSaving = { ...currentState.globalDefaults, ...patch };
      try {
        await saveGlobalDefaults(mergedForSaving, fetcher);
        if (isRequestStale(request)) {
          return;
        }
        dispatch({ type: 'globals.patched', patch });
      } catch {
        if (isRequestStale(request)) {
          return;
        }
      }
    },

    async saveThread(threadId: string, update: ThreadConfigUpdate): Promise<void> {
      const requestId = ++nextRequestId;
      const request: PendingRequest = { id: requestId, threadId };
      latestPendingRequest = request;

      try {
        await saveActiveThreadConfig(threadId, update, fetcher);
        if (isRequestStale(request)) {
          return;
        }
        if (update.set) {
          dispatch({ type: 'thread.patched', patch: update.set });
        }
        if (update.unset && update.unset.length > 0) {
          dispatch({ type: 'thread.unset', keys: update.unset });
        }
      } catch {
        if (isRequestStale(request)) {
          return;
        }
      }
    },

    saveNewThread(patch: ThreadRunConfigOverrides): void {
      dispatch({ type: 'new-thread.patched', patch });
    },

    async unsetThread(threadId: string, keys: ThreadRunConfigKey[]): Promise<void> {
      const requestId = ++nextRequestId;
      const request: PendingRequest = { id: requestId, threadId };
      latestPendingRequest = request;

      try {
        await saveActiveThreadConfig(threadId, { unset: keys }, fetcher);
        if (isRequestStale(request)) {
          return;
        }
        dispatch({ type: 'thread.unset', keys });
      } catch {
        if (isRequestStale(request)) {
          return;
        }
      }
    },

    saveAppearance(patch: Partial<AppearanceConfig>): void {
      saveAppearanceToStorage(patch);
      dispatch({ type: 'appearance.patched', patch });
    },
  };
}
