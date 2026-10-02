import * as os from 'node:os';
import * as path from 'node:path';
import type { ThreadId, ThreadMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { describe, expect, it } from 'vitest';
import { createConfigRepository, defaultConfig, publicRunConfig, publicWebProviderConfig, resolveConfig, resolveWebProviderRuntimeConfig, THREAD_CONFIG_OVERRIDES_KEY_PREFIX, THREAD_CONFIG_OVERRIDES_META_KEY_PREFIX } from './config.js';

class FakeThreadStore {
  settings = new Map<string, unknown>();
  threads = new Map<ThreadId, ThreadMeta>();

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T) ?? null;
  }

  async setSetting<T = unknown>(key: string, value: T): Promise<void> {
    this.settings.set(key, value);
  }

  async getThread(threadId: ThreadId): Promise<ThreadMeta | null> {
    return this.threads.get(threadId) ?? null;
  }

  async updateThreadMetadata(threadId: ThreadId, patch: Partial<ThreadMeta>): Promise<void> {
    const current = this.threads.get(threadId);
    if (current) this.threads.set(threadId, { ...current, ...patch });
  }
}

function fakeThread(threadId: ThreadId, patch: Partial<ThreadMeta> = {}): ThreadMeta {
  const now = new Date().toISOString();
  return {
    threadId,
    title: 'Test thread',
    workspaceRoot: '',
    status: 'active',
    turnCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ephemeral: false,
    tags: {},
    ...patch,
  };
}

describe('AgentRunConfig skillsRoot', () => {
  it('defaults skillsRoot to the current user home directory', () => {
    expect(defaultConfig.skillsRoot).toBe(path.join(os.homedir(), '.suanlizi', 'skills'));
  });

  it('resolves configured skillsRoot to an absolute path', () => {
    expect(resolveConfig({ skillsRoot: '.suanlizi/skills' }).skillsRoot).toBe(
      path.resolve('.suanlizi/skills'),
    );
  });

  it('treats an empty stored skillsRoot as unset', () => {
    expect(resolveConfig({ skillsRoot: '' }).skillsRoot).toBe(defaultConfig.skillsRoot);
  });
});

describe('AgentRunConfig runProfile', () => {
  it('defaults to the long-running Runtime OS profile', () => {
    expect(defaultConfig.runProfile).toBe('runtime_os');
  });

  it('accepts cache_first and falls back invalid values to runtime_os', () => {
    expect(resolveConfig({ runProfile: 'cache_first' }).runProfile).toBe('cache_first');
    expect(resolveConfig({ runProfile: 'bad-value' as never }).runProfile).toBe('runtime_os');
  });

  it('legacy harness profile auto-downgrades to runtime_os', () => {
    // harness 不再是 RunProfile，已降级为 runtime 底座能力
    expect(resolveConfig({ runProfile: 'harness' as never }).runProfile).toBe('runtime_os');
  });
});


describe('AgentRunConfig compactionThreshold', () => {
  it('defaults to 0.8 and normalizes persisted values', () => {
    expect(defaultConfig.compactionThreshold).toBe(0.8);
    expect(resolveConfig({ compactionThreshold: 0.6 }).compactionThreshold).toBe(0.6);
  });

  it('clamps out-of-range thresholds instead of accepting them', () => {
    expect(resolveConfig({ compactionThreshold: 0.1 }).compactionThreshold).toBe(0.3);
    expect(resolveConfig({ compactionThreshold: 5 }).compactionThreshold).toBe(0.95);
  });

  it('round-trips through the public config used for persistence', () => {
    const resolved = resolveConfig({ compactionThreshold: 0.55 });
    expect(publicRunConfig(resolved).compactionThreshold).toBe(0.55);
  });
});

describe('AgentRunConfig model token limits', () => {
  it('keeps explicit model token limits when configured', () => {
    expect(resolveConfig({
      modelContextTokens: 1_000_000,
      modelMaxOutputTokens: 128_000,
    } as never)).toMatchObject({
      modelContextTokens: 1_000_000,
      modelMaxOutputTokens: 128_000,
    });
  });

  it('does not invent a fixed model context window in stored config', () => {
    expect(resolveConfig({} as never)).not.toHaveProperty('modelContextTokens');
  });

  it('drops invalid model token limits', () => {
    expect(resolveConfig({
      modelContextTokens: -1,
      modelMaxOutputTokens: 0,
    } as never)).not.toHaveProperty('modelContextTokens');
  });
});

describe('AgentRunConfig themeMode', () => {
  it('defaults to light and falls back invalid values to light', () => {
    expect(defaultConfig.themeMode).toBe('light');
    expect(resolveConfig({ themeMode: 'dark' }).themeMode).toBe('dark');
    expect(resolveConfig({ themeMode: 'system' }).themeMode).toBe('system');
    expect(resolveConfig({ themeMode: 'bad-value' as never }).themeMode).toBe('light');
  });
});

describe('AgentRunConfig runtime limits and monitor migration', () => {
  it('uses bounded runtime defaults and hard-clamps subagent depth', () => {
    expect(defaultConfig.maxActiveTasks).toBe(4);
    expect(defaultConfig.maxParallelReadonlyTools).toBe(2);
    expect(defaultConfig.maxSubagentDepth).toBe(1);
    expect(resolveConfig({ maxActiveTasks: 999, maxParallelReadonlyTools: 99, maxSubagentDepth: 99 })).toMatchObject({
      maxActiveTasks: 64,
      maxParallelReadonlyTools: 16,
      maxSubagentDepth: 2,
    });
  });

  it('normalizes the model response timeout independently from tool timeout', () => {
    expect(defaultConfig.modelTimeoutSeconds).toBe(120);
    expect(resolveConfig({ modelTimeoutSeconds: 2 } as never).modelTimeoutSeconds).toBe(10);
    expect(resolveConfig({ modelTimeoutSeconds: 9_999 } as never).modelTimeoutSeconds).toBe(3600);
  });

  it('migrates the legacy monitor switch without enabling data collection by default', () => {
    expect(resolveConfig({}).systemMonitorSamplingEnabled).toBe(false);
    expect(resolveConfig({}).systemMonitorGuardEnabled).toBe(false);
    expect(resolveConfig({ systemMonitorEnabled: true })).toMatchObject({
      systemMonitorSamplingEnabled: true,
      systemMonitorGuardEnabled: true,
      systemMonitorEnabled: true,
    });
  });

  it('normalizes threshold values on the server', () => {
    expect(resolveConfig({
      systemMonitorThresholds: { cpuLight: -1, cpuModerate: 101, cpuSevere: Number.NaN, memLight: 50, memModerate: 60, memSevere: 70, diskSevereBytes: 10 ** 30 },
    }).systemMonitorThresholds).toMatchObject({
      cpuLight: 1,
      cpuModerate: 100,
      cpuSevere: 97,
      memLight: 50,
      diskSevereBytes: 1024 ** 5,
    });
  });
});

describe('AgentRunConfig web provider', () => {
  it('defaults to local native fetch and accepts Firecrawl as explicit enhanced mode', () => {
    expect(defaultConfig.webProvider).toBe('native_fetch');
    expect(defaultConfig.webProviderKeySource).toBe('config');
    expect(resolveConfig({ webProvider: 'firecrawl' }).webProvider).toBe('firecrawl');
    expect(resolveConfig({ webProvider: 'bad_provider' as never }).webProvider).toBe('native_fetch');
  });

  it('resolves Firecrawl key from project config before falling back to env mode', () => {
    const fromConfig = resolveWebProviderRuntimeConfig(
      { webProvider: 'firecrawl', webProviderKeySource: 'config' },
      { firecrawlApiKey: 'stored-key' },
      { FIRECRAWL_API_KEY: 'env-key' },
    );
    expect(fromConfig.firecrawl.apiKey).toBe('stored-key');
    expect(fromConfig.source).toBe('config');

    const fromEnv = resolveWebProviderRuntimeConfig(
      { webProvider: 'firecrawl', webProviderKeySource: 'env' },
      { firecrawlApiKey: 'stored-key' },
      { FIRECRAWL_API_KEY: 'env-key' },
    );
    expect(fromEnv.firecrawl.apiKey).toBe('env-key');
    expect(fromEnv.source).toBe('env');
  });

  it('masks Firecrawl key in public settings output', () => {
    const publicConfig = publicWebProviderConfig(
      { firecrawlApiKey: 'fc-1234567890' },
      { FIRECRAWL_API_KEY: 'env-key' },
    );
    expect(publicConfig.firecrawl.configured).toBe(true);
    expect(publicConfig.firecrawl.source).toBe('config');
    expect(publicConfig.firecrawl.masked).toBe('fc-1...7890');
    expect(JSON.stringify(publicConfig)).not.toContain('fc-1234567890');
  });
});

describe('AgentRunConfig access policy', () => {
  it('normalizes access policy from workspace defaults', () => {
    const config = resolveConfig({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
    });

    expect(config.accessPolicy).toMatchObject({
      mode: 'workspace',
      workspaceRoot: path.resolve('E:\\langchain\\Suanlizi'),
      persistentRules: [],
      temporaryGrants: [],
    });
  });

  it('maps legacy read_only permissions to chat-like read policy without writing legacy permissions as source of truth', () => {
    const config = resolveConfig({
      permissions: 'read_only',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
    });

    expect(config.accessPolicy.mode).toBe('chat');
    expect(config.permissions).toBe('read_only');
  });

  it('public config removes temporary grants', () => {
    const config = resolveConfig({
      accessPolicy: {
        mode: 'workspace',
        workspaceRoot: 'E:\\langchain\\Suanlizi',
        persistentRules: [],
        temporaryGrants: [
          {
            id: 'temp-1',
            effect: 'allow',
            access: 'read',
            target: { kind: 'path', path: 'E:\\secret' },
            scope: 'session',
            createdAt: '2026-07-27T00:00:00.000Z',
          },
        ],
      },
    });

    expect(publicRunConfig(config).accessPolicy.temporaryGrants).toEqual([]);
  });
});

describe('thread appearance persistence', () => {
  it('ignores legacy thread-level themeMode and resolves from global defaults', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-1' as ThreadId;

    store.threads.set(threadId, fakeThread(threadId, {
      tags: {
        runConfig: JSON.stringify({ model: 'thread-model', themeMode: 'light' }),
      },
    }));
    await repo.saveDefaultRunConfig({ themeMode: 'dark' });

    const config = await repo.getThreadRunConfig(threadId);

    expect(config.model).toBe('thread-model');
    expect(config.themeMode).toBe('dark');
  });

  it('does not persist UI-only appearance fields into thread metadata when saving thread config', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-2' as ThreadId;

    store.threads.set(threadId, fakeThread(threadId, {
      tags: {},
    }));
    await repo.saveDefaultRunConfig({
      themeMode: 'dark',
      userAvatarId: 'asteroid',
      customUserAvatarDataUrl: 'data:image/png;base64,abc',
    } as never);
    await repo.saveThreadRunConfig(threadId, { model: 'thread-model' });

    const saved = store.threads.get(threadId)?.tags?.runConfig;

    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved ?? '{}');
    expect(parsed).not.toHaveProperty('themeMode');
    expect(parsed).not.toHaveProperty('userAvatarId');
    expect(parsed).not.toHaveProperty('customUserAvatarDataUrl');
  });

  it('ignores a legacy full thread snapshot so it cannot override the global context window', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-legacy-context' as ThreadId;

    store.threads.set(threadId, fakeThread(threadId, {
      tags: {
        runConfig: JSON.stringify({
          workspaceRoot: 'D:\\legacy',
          provider: 'llama_cpp',
          model: 'local-model',
          modelContextTokens: 24_576,
          permissions: 'workspace',
        }),
      },
    }));
    await repo.saveDefaultRunConfig({ modelContextTokens: 65_536 });

    await expect(repo.getThreadRunConfig(threadId)).resolves.toMatchObject({
      modelContextTokens: 65_536,
    });
  });
});

describe('model preset persistence', () => {
  it('stores model capability overrides with the preset', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);

    const { preset } = await repo.upsertModelPreset({
      name: 'OpenAI',
      config: {
        provider: 'openai',
        model: 'gpt-5',
        baseUrl: 'https://example.test/v1',
        modelContextTokens: 128_000,
        modelMaxOutputTokens: 16_000,
        permissions: 'danger_full_access',
        workspaceRoot: 'E:/secret',
        memoryEnabled: false,
      },
    });

    expect(preset.config).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test/v1',
      modelContextTokens: 128_000,
      modelMaxOutputTokens: 16_000,
    });
  });

  it('rejects presets without provider or model', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);

    await expect(repo.upsertModelPreset({
      config: { provider: '', model: '' },
    })).rejects.toThrow('provider and model are required');
  });
});

describe('thread config overrides', () => {
  it('returns empty object by default', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-overrides-1' as ThreadId;

    const overrides = await repo.getThreadConfigOverrides(threadId);

    expect(overrides).toEqual({});
  });

  it('filters input to supported thread choices', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-overrides-2' as ThreadId;

    const overrides = await repo.updateThreadConfigOverrides(threadId, {
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test/v1',
      permissions: 'danger_full_access',
      workspaceRoot: 'E:/secret',
      memoryEnabled: false,
      extraField: 'should-be-stripped',
    });

    expect(overrides).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test/v1',
      permissions: 'danger_full_access',
    });
  });

  it('persists model and execution choices', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-overrides-3' as ThreadId;

    await repo.updateThreadConfigOverrides(threadId, {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      baseUrl: 'https://api.anthropic.com',
      permissions: 'workspace',
      reasoningEffort: 'high',
      runProfile: 'runtime_os',
    });

    const stored = await repo.getThreadConfigOverrides(threadId);
    expect(stored).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      baseUrl: 'https://api.anthropic.com',
      permissions: 'workspace',
      reasoningEffort: 'high',
      runProfile: 'runtime_os',
    });
  });

  it('merges concurrent partial updates instead of dropping fields', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-overrides-concurrent' as ThreadId;

    const [permissions, reasoning] = await Promise.all([
      repo.updateThreadConfigOverrides(threadId, { permissions: 'read_only' }),
      repo.updateThreadConfigOverrides(threadId, { reasoningEffort: 'no' }),
    ]);

    expect(permissions).toMatchObject({ permissions: 'read_only' });
    expect(reasoning).toMatchObject({ permissions: 'read_only', reasoningEffort: 'no' });
    await expect(repo.getThreadConfigOverrides(threadId)).resolves.toEqual({
      permissions: 'read_only',
      reasoningEffort: 'no',
    });
  });

  it('uses the thread workspace as the runtime root for non-chat threads', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-workspace-root' as ThreadId;
    store.threads.set(threadId, fakeThread(threadId, {
      mode: 'ops',
      workspaceRoot: 'E:/thread-workspace',
      tags: {},
    }));
    await repo.saveDefaultRunConfig({ workspaceRoot: 'E:/global-workspace' });

    const config = await repo.getThreadRunConfig(threadId);

    expect(config.workspaceRoot).toBe(path.resolve('E:/thread-workspace'));
    expect(config.accessPolicy.workspaceRoot).toBe(path.resolve('E:/thread-workspace'));
  });

  it('normalizes legacy reasoning effort presets', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-overrides-effort-normalized' as ThreadId;

    await repo.updateThreadConfigOverrides(threadId, { reasoningEffort: 'low' });
    await expect(repo.getThreadRunConfig(threadId)).resolves.toMatchObject({ reasoningEffort: 'no' });

    await repo.updateThreadConfigOverrides(threadId, { reasoningEffort: 'ultra' });
    await expect(repo.getThreadRunConfig(threadId)).resolves.toMatchObject({ reasoningEffort: 'max' });
  });

  it('merges overrides into thread run config', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-overrides-4' as ThreadId;

    store.threads.set(threadId, fakeThread(threadId, { tags: {} }));
    await repo.saveDefaultRunConfig({ provider: 'ollama', model: 'qwen2.5-coder:7b' });
    await repo.updateThreadConfigOverrides(threadId, {
      provider: 'openai',
      model: 'gpt-5',
      permissions: 'danger_full_access',
      reasoningEffort: 'high',
      runProfile: 'runtime_os',
    });

    const config = await repo.getThreadRunConfig(threadId);

    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-5');
    expect(config.permissions).toBe('danger_full_access');
    expect(config.reasoningEffort).toBe('high');
    expect(config.runProfile).toBe('runtime_os');
  });

  it('drops legacy model limits that were written without an explicit marker', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-overrides-legacy-window' as ThreadId;
    store.settings.set(`${THREAD_CONFIG_OVERRIDES_KEY_PREFIX}${threadId}`, {
      provider: 'llama_cpp',
      model: 'local-model',
      modelContextTokens: 24_576,
    });

    await expect(repo.getThreadConfigOverrides(threadId)).resolves.toEqual({
      provider: 'llama_cpp',
      model: 'local-model',
    });
    expect(store.settings.get(`${THREAD_CONFIG_OVERRIDES_KEY_PREFIX}${threadId}`)).toEqual({
      provider: 'llama_cpp',
      model: 'local-model',
    });
  });

  it('keeps a model window only after an explicit thread setting and clears its marker on unset', async () => {
    const store = new FakeThreadStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-overrides-explicit-window' as ThreadId;

    await repo.updateThreadConfigOverrides(threadId, { modelContextTokens: 65_536 });
    await expect(repo.getThreadConfigOverrides(threadId)).resolves.toMatchObject({ modelContextTokens: 65_536 });
    expect(store.settings.get(`${THREAD_CONFIG_OVERRIDES_META_KEY_PREFIX}${threadId}`)).toEqual({ modelContextTokens: true });

    await repo.updateThreadConfigOverrides(threadId, { modelContextTokens: null });
    await expect(repo.getThreadConfigOverrides(threadId)).resolves.not.toHaveProperty('modelContextTokens');
    expect(store.settings.get(`${THREAD_CONFIG_OVERRIDES_META_KEY_PREFIX}${threadId}`)).toEqual({});
  });
});
