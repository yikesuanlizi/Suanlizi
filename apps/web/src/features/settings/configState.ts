import type { ThreadRunConfigKey, ThreadRunConfigOverrides } from '@suanlizi/protocol';
import type { RunConfig } from '../../config/config.js';

export type AppearanceConfig = Pick<RunConfig,
  'themeMode' | 'userAvatarId' | 'customUserAvatarDataUrl' | 'monitorPanelVisible'>;
export type GlobalRuntimeConfig = Omit<RunConfig, keyof AppearanceConfig>;

export interface ConfigState {
  globalDefaults: Partial<GlobalRuntimeConfig>;
  activeThreadId: string;
  activeThreadOverrides: ThreadRunConfigOverrides;
  newThreadOverrides: ThreadRunConfigOverrides;
  appearance: Partial<AppearanceConfig>;
  hydrated: boolean;
}

export const initialConfigState: ConfigState = {
  globalDefaults: {},
  activeThreadId: '',
  activeThreadOverrides: {},
  newThreadOverrides: {},
  appearance: {},
  hydrated: false,
};

export type ConfigStateAction =
  | { type: 'globals.loaded'; config: Partial<GlobalRuntimeConfig> }
  | { type: 'globals.patched'; patch: Partial<GlobalRuntimeConfig> }
  | { type: 'thread.selected'; threadId: string; config: ThreadRunConfigOverrides }
  | { type: 'thread.patched'; patch: ThreadRunConfigOverrides }
  | { type: 'thread.unset'; keys: ThreadRunConfigKey[] }
  | { type: 'new-thread.patched'; patch: ThreadRunConfigOverrides }
  | { type: 'new-thread.unset'; keys: ThreadRunConfigKey[] }
  | { type: 'appearance.patched'; patch: Partial<AppearanceConfig> }
  | { type: 'hydrated' };

const APPEARANCE_KEYS: Array<keyof AppearanceConfig> = [
  'themeMode',
  'userAvatarId',
  'customUserAvatarDataUrl',
  'monitorPanelVisible',
];

export function configStateReducer(state: ConfigState, action: ConfigStateAction): ConfigState {
  switch (action.type) {
    case 'globals.loaded':
      return {
        ...state,
        globalDefaults: { ...action.config },
      };
    case 'globals.patched':
      return {
        ...state,
        globalDefaults: { ...state.globalDefaults, ...action.patch },
      };
    case 'thread.selected':
      return {
        ...state,
        activeThreadId: action.threadId,
        activeThreadOverrides: { ...action.config },
      };
    case 'thread.patched':
      return {
        ...state,
        activeThreadOverrides: { ...state.activeThreadOverrides, ...action.patch },
      };
    case 'thread.unset': {
      const next = { ...state.activeThreadOverrides };
      for (const key of action.keys) {
        delete next[key];
      }
      return {
        ...state,
        activeThreadOverrides: next,
      };
    }
    case 'new-thread.patched':
      return {
        ...state,
        newThreadOverrides: { ...state.newThreadOverrides, ...action.patch },
      };
    case 'new-thread.unset': {
      const next = { ...state.newThreadOverrides };
      for (const key of action.keys) {
        delete next[key];
      }
      return {
        ...state,
        newThreadOverrides: next,
      };
    }
    case 'appearance.patched':
      return {
        ...state,
        appearance: { ...state.appearance, ...action.patch },
      };
    case 'hydrated':
      return {
        ...state,
        hydrated: true,
      };
    default:
      return state;
  }
}

export function effectiveRunConfig(
  defaults: RunConfig,
  state: Pick<ConfigState, 'globalDefaults' | 'activeThreadOverrides' | 'appearance'>,
): RunConfig {
  return {
    ...defaults,
    ...state.globalDefaults,
    ...state.activeThreadOverrides,
    ...state.appearance,
  };
}

export function globalRuntimePayload(config: Partial<RunConfig>): Partial<GlobalRuntimeConfig> {
  const result: Partial<GlobalRuntimeConfig> = {};
  for (const [key, value] of Object.entries(config)) {
    if ((key === 'modelContextTokens' || key === 'modelMaxOutputTokens') && value === undefined) {
      // `undefined` is dropped by JSON.stringify; use null so the API can
      // intentionally clear a previously configured model-specific limit.
      (result as Record<string, unknown>)[key] = null;
    } else if (!APPEARANCE_KEYS.includes(key as keyof AppearanceConfig) && value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
