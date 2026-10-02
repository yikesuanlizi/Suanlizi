import type { ThreadStore } from '@suanlizi/storage';

export const LIGHT_MEMORY_KEY = 'memory.light.v1';

export interface LightMemoryEntry {
  id: string;
  text: string;
  sourceThreadId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LightMemoryState {
  enabled: boolean;
  debounceMs: number;
  maxEntries: number;
  entries: LightMemoryEntry[];
  queue: LightMemoryEntry[];
  nextFlushAt: string | null;
}

export interface QueueLightMemoryOptions {
  enabled?: boolean;
  debounceMs?: number;
  maxEntries?: number;
  now?: Date;
  sourceThreadId?: string;
}

const DEFAULT_STATE: LightMemoryState = {
  enabled: true,
  debounceMs: 30_000,
  maxEntries: 200,
  entries: [],
  queue: [],
  nextFlushAt: null,
};

export async function getLightMemoryState(store: ThreadStore): Promise<LightMemoryState> {
  const stored = await store.getSetting<Partial<LightMemoryState>>(LIGHT_MEMORY_KEY);
  return normalizeState(stored);
}

export async function setLightMemoryEnabled(store: ThreadStore, enabled: boolean): Promise<LightMemoryState> {
  const state = await getLightMemoryState(store);
  const next = { ...state, enabled };
  await store.setSetting(LIGHT_MEMORY_KEY, next);
  return next;
}

export async function queueLightMemory(
  store: ThreadStore,
  text: string,
  options: QueueLightMemoryOptions = {},
): Promise<LightMemoryState> {
  const state = await getLightMemoryState(store);
  const enabled = options.enabled ?? state.enabled;
  const cleanText = text.trim().replace(/\s+/g, ' ');
  if (!enabled || !cleanText) {
    const next = { ...state, enabled };
    await store.setSetting(LIGHT_MEMORY_KEY, next);
    return next;
  }

  const now = options.now ?? new Date();
  const debounceMs = options.debounceMs ?? state.debounceMs;
  const maxEntries = options.maxEntries ?? state.maxEntries;
  const normalized = normalizeMemoryText(cleanText);
  const existingQueue = state.queue.filter((entry) => normalizeMemoryText(entry.text) !== normalized);
  const nextEntry: LightMemoryEntry = {
    id: `mem_${now.getTime()}_${hashText(cleanText)}`,
    text: cleanText,
    sourceThreadId: options.sourceThreadId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const next: LightMemoryState = {
    ...state,
    enabled,
    debounceMs,
    maxEntries,
    queue: [...existingQueue, nextEntry],
    nextFlushAt: new Date(now.getTime() + debounceMs).toISOString(),
  };
  await store.setSetting(LIGHT_MEMORY_KEY, next);
  return next;
}

export async function flushLightMemoryQueue(
  store: ThreadStore,
  now: Date = new Date(),
): Promise<LightMemoryState> {
  const state = await getLightMemoryState(store);
  if (!state.nextFlushAt || Date.parse(state.nextFlushAt) > now.getTime() || state.queue.length === 0) {
    return state;
  }

  const byText = new Map<string, LightMemoryEntry>();
  for (const entry of state.entries) byText.set(normalizeMemoryText(entry.text), entry);
  for (const queued of state.queue) {
    const key = normalizeMemoryText(queued.text);
    const existing = byText.get(key);
    byText.set(key, existing ? { ...existing, updatedAt: queued.updatedAt } : queued);
  }
  const entries = [...byText.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-state.maxEntries);
  const next: LightMemoryState = {
    ...state,
    entries,
    queue: [],
    nextFlushAt: null,
  };
  await store.setSetting(LIGHT_MEMORY_KEY, next);
  return next;
}

export async function listLightMemories(store: ThreadStore): Promise<LightMemoryEntry[]> {
  return (await getLightMemoryState(store)).entries;
}

export async function deleteLightMemory(store: ThreadStore, id: string): Promise<LightMemoryState> {
  const state = await getLightMemoryState(store);
  const next: LightMemoryState = {
    ...state,
    entries: state.entries.filter((entry) => entry.id !== id),
    queue: state.queue.filter((entry) => entry.id !== id),
  };
  await store.setSetting(LIGHT_MEMORY_KEY, next);
  return next;
}

function normalizeState(stored: Partial<LightMemoryState> | null | undefined): LightMemoryState {
  return {
    enabled: stored?.enabled ?? DEFAULT_STATE.enabled,
    debounceMs: stored?.debounceMs ?? DEFAULT_STATE.debounceMs,
    maxEntries: stored?.maxEntries ?? DEFAULT_STATE.maxEntries,
    entries: Array.isArray(stored?.entries) ? stored.entries : [],
    queue: Array.isArray(stored?.queue) ? stored.queue : [],
    nextFlushAt: stored?.nextFlushAt ?? null,
  };
}

function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
