import {
  isPinnableWorkbenchTab,
  isTerminalUtilityWorkbenchTab,
  type PinnableWorkbenchTab,
  type UtilityWorkbenchTab,
  type WorkbenchTab,
} from './WorkbenchTabs.js';

export const WORKBENCH_STATE_STORAGE_KEY = 'suanlizi.workbench.state.v1';
export const WORKBENCH_VISIBILITY_STORAGE_KEY = 'suanlizi.workbench.visibility.v1';

function storageKey(scope: string): string {
  return `${WORKBENCH_STATE_STORAGE_KEY}:${encodeURIComponent(scope)}`;
}

function visibilityStorageKey(scope: string): string {
  return `${WORKBENCH_VISIBILITY_STORAGE_KEY}:${encodeURIComponent(scope)}`;
}

export function readStoredWorkbenchVisibility(scope?: string, fallback = true): boolean {
  const normalized = scope?.trim();
  if (!normalized) return false;
  try {
    const stored = localStorage.getItem(visibilityStorageKey(normalized));
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

export function writeStoredWorkbenchVisibility(visible: boolean, scope?: string): void {
  const normalized = scope?.trim();
  if (!normalized) return;
  try {
    localStorage.setItem(visibilityStorageKey(normalized), visible ? '1' : '0');
  } catch {
    // UI state persistence is best effort.
  }
}

export interface PersistedWorkbenchState {
  activeTab: WorkbenchTab;
  openUtilityTabs: UtilityWorkbenchTab[];
  pinnedTabs?: PinnableWorkbenchTab[];
}

const DEFAULT_STATE: PersistedWorkbenchState = {
  activeTab: 'activity',
  openUtilityTabs: [],
  pinnedTabs: ['activity', 'agents'],
};

function normalizeUtilityTab(tab: unknown): UtilityWorkbenchTab | null {
  if (tab === 'files' || tab === 'browser') return tab;
  return typeof tab === 'string' && isTerminalUtilityWorkbenchTab(tab) ? tab : null;
}

export function readStoredWorkbenchState(scope?: string): PersistedWorkbenchState {
  const normalized = scope?.trim();
  // Workbench state is conversation state. Do not revive a global tab while no conversation is selected.
  if (!normalized) return { ...DEFAULT_STATE, openUtilityTabs: [], pinnedTabs: [...(DEFAULT_STATE.pinnedTabs ?? ['activity', 'agents'])] };
  try {
    const raw = localStorage.getItem(storageKey(normalized));
    if (!raw) {
      return { ...DEFAULT_STATE, openUtilityTabs: [], pinnedTabs: [...(DEFAULT_STATE.pinnedTabs ?? ['activity', 'agents'])] };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedWorkbenchState>;
    const openUtilityTabs = Array.isArray(parsed.openUtilityTabs)
      ? parsed.openUtilityTabs.map(normalizeUtilityTab).filter((tab): tab is UtilityWorkbenchTab => tab !== null)
      : [];
    const utilityActiveTab = normalizeUtilityTab(parsed.activeTab);
    const activeTab: WorkbenchTab = utilityActiveTab
      ?? (parsed.activeTab === 'agents' || parsed.activeTab === 'activity' || parsed.activeTab === 'ops' ? parsed.activeTab : 'activity');
    const normalizedTabs = [...new Set(openUtilityTabs)];
    if (utilityActiveTab && !normalizedTabs.includes(utilityActiveTab)) normalizedTabs.push(utilityActiveTab);
    const pinnedTabs = Array.isArray(parsed.pinnedTabs)
      ? parsed.pinnedTabs.filter(isPinnableWorkbenchTab)
      : [...(DEFAULT_STATE.pinnedTabs ?? ['activity', 'agents'])];
    return { activeTab, openUtilityTabs: normalizedTabs, pinnedTabs: [...new Set(pinnedTabs)] };
  } catch {
    return { ...DEFAULT_STATE, openUtilityTabs: [], pinnedTabs: [...(DEFAULT_STATE.pinnedTabs ?? ['activity', 'agents'])] };
  }
}

export function writeStoredWorkbenchState(state: PersistedWorkbenchState, scope?: string): void {
  const normalized = scope?.trim();
  if (!normalized) return;
  try {
    localStorage.setItem(storageKey(normalized), JSON.stringify({
      activeTab: state.activeTab,
      openUtilityTabs: [...new Set(state.openUtilityTabs)],
      pinnedTabs: [...new Set(state.pinnedTabs)],
    }));
  } catch {
    // UI state persistence is best effort.
  }
}
