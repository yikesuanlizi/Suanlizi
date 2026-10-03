import { describe, expect, it } from 'vitest';
import {
  configStateReducer,
  effectiveRunConfig,
  globalRuntimePayload,
  initialConfigState,
} from './configState.js';
import { defaultConfig } from '../../config/defaults.js';

describe('configStateReducer', () => {
  it('thread edits should not pollute globalDefaults', () => {
    let state = initialConfigState;
    state = configStateReducer(state, {
      type: 'globals.patched',
      patch: { model: 'global-model', provider: 'global-provider' },
    });
    state = configStateReducer(state, {
      type: 'thread.selected',
      threadId: 'thread-1',
      config: { model: 'thread-model' },
    });
    state = configStateReducer(state, {
      type: 'thread.patched',
      patch: { provider: 'thread-provider' },
    });

    expect(state.globalDefaults.model).toBe('global-model');
    expect(state.globalDefaults.provider).toBe('global-provider');
    expect(state.activeThreadOverrides.model).toBe('thread-model');
    expect(state.activeThreadOverrides.provider).toBe('thread-provider');
  });

  it('appearance patches should not enter globalDefaults', () => {
    let state = initialConfigState;
    state = configStateReducer(state, {
      type: 'appearance.patched',
      patch: { themeMode: 'dark', userAvatarId: 'rocket' },
    });

    expect(state.globalDefaults).toEqual({});
    expect(state.appearance.themeMode).toBe('dark');
    expect(state.appearance.userAvatarId).toBe('rocket');
  });

  it('unset should correctly remove fields', () => {
    let state = initialConfigState;
    state = configStateReducer(state, {
      type: 'thread.selected',
      threadId: 'thread-1',
      config: { model: 'm1', provider: 'p1' },
    });
    state = configStateReducer(state, {
      type: 'thread.unset',
      keys: ['model', 'modelContextTokens'],
    });

    expect(state.activeThreadOverrides.model).toBeUndefined();
    expect(state.activeThreadOverrides.provider).toBe('p1');
    expect(state.activeThreadOverrides.modelContextTokens).toBeUndefined();
  });

  it('new-thread and active-thread overrides should not interfere with each other', () => {
    let state = initialConfigState;
    state = configStateReducer(state, {
      type: 'new-thread.patched',
      patch: { model: 'new-model', reasoningEffort: 'high' },
    });
    state = configStateReducer(state, {
      type: 'thread.selected',
      threadId: 'thread-1',
      config: { model: 'active-model' },
    });
    state = configStateReducer(state, {
      type: 'thread.patched',
      patch: { provider: 'active-provider' },
    });
    state = configStateReducer(state, {
      type: 'new-thread.patched',
      patch: { provider: 'new-provider' },
    });

    expect(state.newThreadOverrides.model).toBe('new-model');
    expect(state.newThreadOverrides.reasoningEffort).toBe('high');
    expect(state.newThreadOverrides.provider).toBe('new-provider');
    expect(state.activeThreadOverrides.model).toBe('active-model');
    expect(state.activeThreadOverrides.provider).toBe('active-provider');
    expect(state.activeThreadOverrides.reasoningEffort).toBeUndefined();
  });

  it('thread.selected should replace active thread overrides and update threadId', () => {
    let state = initialConfigState;
    state = configStateReducer(state, {
      type: 'thread.selected',
      threadId: 'thread-1',
      config: { model: 'm1' },
    });
    state = configStateReducer(state, {
      type: 'thread.selected',
      threadId: 'thread-2',
      config: { provider: 'p2' },
    });

    expect(state.activeThreadId).toBe('thread-2');
    expect(state.activeThreadOverrides).toEqual({ provider: 'p2' });
    expect(state.activeThreadOverrides.model).toBeUndefined();
  });

  it('new-thread.unset should correctly remove fields', () => {
    let state = initialConfigState;
    state = configStateReducer(state, {
      type: 'new-thread.patched',
      patch: { model: 'm1', provider: 'p1', webSearchMode: 'on' },
    });
    state = configStateReducer(state, {
      type: 'new-thread.unset',
      keys: ['webSearchMode'],
    });

    expect(state.newThreadOverrides.model).toBe('m1');
    expect(state.newThreadOverrides.provider).toBe('p1');
    expect(state.newThreadOverrides.webSearchMode).toBeUndefined();
  });

  it('hydrated action should set hydrated flag to true', () => {
    const state = configStateReducer(initialConfigState, { type: 'hydrated' });
    expect(state.hydrated).toBe(true);
  });

  it('globals.loaded should replace globalDefaults', () => {
    let state = initialConfigState;
    state = configStateReducer(state, {
      type: 'globals.patched',
      patch: { model: 'old-model', provider: 'old-provider' },
    });
    state = configStateReducer(state, {
      type: 'globals.loaded',
      config: { model: 'new-model' },
    });

    expect(state.globalDefaults.model).toBe('new-model');
    expect(state.globalDefaults.provider).toBeUndefined();
  });
});

describe('effectiveRunConfig', () => {
  it('should merge defaults, globals, thread overrides, and appearance in correct order', () => {
    const state = {
      globalDefaults: { model: 'global-model', provider: 'global-provider' },
      activeThreadOverrides: { model: 'thread-model' },
      appearance: { themeMode: 'dark' as const },
    };

    const effective = effectiveRunConfig(defaultConfig, state);

    expect(effective.model).toBe('thread-model');
    expect(effective.provider).toBe('global-provider');
    expect(effective.themeMode).toBe('dark');
    expect(effective.reasoningEffort).toBe(defaultConfig.reasoningEffort);
  });
});

describe('globalRuntimePayload', () => {
  it('should exclude appearance fields (themeMode, userAvatarId, customUserAvatarDataUrl)', () => {
    const payload = globalRuntimePayload({
      model: 'my-model',
      themeMode: 'dark',
      userAvatarId: 'rocket',
      customUserAvatarDataUrl: 'data:image/png;base64,xxx',
      provider: 'ollama',
      locale: 'zh',
    });

    expect(payload.model).toBe('my-model');
    expect(payload.provider).toBe('ollama');
    expect(payload.locale).toBe('zh');
    expect((payload as Record<string, unknown>).themeMode).toBeUndefined();
    expect((payload as Record<string, unknown>).userAvatarId).toBeUndefined();
    expect((payload as Record<string, unknown>).customUserAvatarDataUrl).toBeUndefined();
  });

  it('should filter out undefined values', () => {
    const payload = globalRuntimePayload({
      model: 'my-model',
      provider: undefined,
    });

    expect(payload.model).toBe('my-model');
    expect(Object.prototype.hasOwnProperty.call(payload, 'provider')).toBe(false);
  });
});
