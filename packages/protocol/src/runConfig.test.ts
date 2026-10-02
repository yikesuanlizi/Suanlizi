import { describe, expect, it } from 'vitest';
import {
  modelPresetConfigFrom,
  normalizeReasoningEffort,
  threadRunConfigOverridesFrom,
  activeRunConfig,
  parseCompositeConfigSnapshot,
  defaultGlobalRunConfigDefaults,
  defaultAppearanceConfig,
  defaultCompositeConfigSnapshot,
} from './runConfig.js';

describe('modelPresetConfigFrom', () => {
  it('keeps model routing and explicit capability overrides only', () => {
    expect(modelPresetConfigFrom({
      provider: ' openai ',
      model: '\tgpt-5 ',
      baseUrl: ' https://example.test/v1 ',
      modelContextTokens: 16_384,
      modelMaxOutputTokens: 4_096,
      permissions: 'danger_full_access',
      workspaceRoot: 'E:/secret',
      memoryEnabled: false,
    })).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test/v1',
      modelContextTokens: 16_384,
      modelMaxOutputTokens: 4_096,
    });
  });

  it('projects only fields that may override a thread', () => {
    expect(threadRunConfigOverridesFrom({
      workspaceRoot: 'E:/repo',
      provider: ' openai ',
      model: '\tgpt-5 ',
      baseUrl: ' ',
      modelContextTokens: 16_384,
      modelMaxOutputTokens: 4_096,
      permissions: 'workspace',
      webSearchMode: 'auto',
      reasoningEffort: 'high',
      runProfile: 'runtime_os',
      memoryEnabled: false,
      dataDir: 'E:/private',
    })).toEqual({
      workspaceRoot: 'E:/repo',
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: '',
      modelContextTokens: 16_384,
      modelMaxOutputTokens: 4_096,
      permissions: 'workspace',
      webSearchMode: 'auto',
      reasoningEffort: 'high',
      runProfile: 'runtime_os',
    });
  });

  it('rejects a preset without provider or model', () => {
    expect(() => modelPresetConfigFrom({ provider: '', model: '' }))
      .toThrow('provider and model are required');
  });

  it('rejects an output limit larger than the context window', () => {
    expect(() => modelPresetConfigFrom({
      provider: 'llama_cpp',
      model: 'local-model',
      modelContextTokens: 16_384,
      modelMaxOutputTokens: 32_768,
    })).toThrow('modelMaxOutputTokens cannot exceed modelContextTokens');
  });
});

describe('activeRunConfig', () => {
  it('thread override overrides global default', () => {
    const composite = {
      globalDefaults: {
        ...defaultGlobalRunConfigDefaults,
        provider: 'openai',
        model: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
      },
      appearance: defaultAppearanceConfig,
      newThreadDefaults: {},
      activeThreadOverrides: {
        provider: 'anthropic',
        model: 'claude-3-opus',
      },
    };
    const resolved = activeRunConfig(composite);
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.model).toBe('claude-3-opus');
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('uses global defaults when no overrides', () => {
    const composite = {
      globalDefaults: {
        ...defaultGlobalRunConfigDefaults,
        provider: 'openai',
        model: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        temperature: 0.5,
      },
      appearance: defaultAppearanceConfig,
      newThreadDefaults: {},
      activeThreadOverrides: {},
    };
    const resolved = activeRunConfig(composite);
    expect(resolved.provider).toBe('openai');
    expect(resolved.model).toBe('gpt-4o');
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1');
    expect(resolved.temperature).toBe(0.5);
  });
});

describe('parseCompositeConfigSnapshot', () => {
  it('fills in defaults when fields are missing', () => {
    const parsed = parseCompositeConfigSnapshot({});
    expect(parsed.globalDefaults.provider).toBe('openai');
    expect(parsed.globalDefaults.model).toBe('gpt-4o');
    expect(parsed.appearance.themeMode).toBe('auto');
    expect(parsed.appearance.themePrimaryColor).toBe('6366f1');
    expect(parsed.activeThreadOverrides).toEqual({});
    expect(parsed.newThreadDefaults).toEqual({});
  });

  it('ignores extra fields (injection protection)', () => {
    const rawInput = {
      globalDefaults: {
        provider: 'custom-provider',
        injectedField: 'malicious',
      },
      appearance: {
        themeMode: 'dark',
        extraThemeSetting: true,
      },
      newThreadDefaults: {
        model: 'custom-model',
        unknownKey: 'should-be-ignored',
      },
      activeThreadOverrides: {
        baseUrl: 'https://custom.example.com',
        evilSetting: 'pwned',
      },
      unexpectedTopLevel: 'should be stripped',
    };
    const parsed = parseCompositeConfigSnapshot(rawInput) as unknown as Record<string, Record<string, unknown>>;

    expect(parsed.globalDefaults.provider).toBe('custom-provider');
    expect(parsed.globalDefaults.injectedField).toBeUndefined();
    expect(parsed.appearance.themeMode).toBe('dark');
    expect(parsed.appearance.extraThemeSetting).toBeUndefined();
    expect(parsed.newThreadDefaults.model).toBe('custom-model');
    expect(parsed.newThreadDefaults.unknownKey).toBeUndefined();
    expect(parsed.activeThreadOverrides.baseUrl).toBe('https://custom.example.com');
    expect(parsed.activeThreadOverrides.evilSetting).toBeUndefined();
    expect(parsed.unexpectedTopLevel).toBeUndefined();
  });

  it('produces a valid default composite snapshot', () => {
    const parsed = parseCompositeConfigSnapshot({});
    expect(parsed).toEqual(defaultCompositeConfigSnapshot);
  });
});

describe('normalizeReasoningEffort', () => {
  it('maps legacy and new reasoning presets without treating low as enabled', () => {
    expect(normalizeReasoningEffort(' low ')).toBe('no');
    expect(normalizeReasoningEffort('NONE')).toBe('no');
    expect(normalizeReasoningEffort('ultra')).toBe('max');
    expect(normalizeReasoningEffort('x-high')).toBe('xhigh');
    expect(normalizeReasoningEffort('unknown')).toBeUndefined();
  });
});
