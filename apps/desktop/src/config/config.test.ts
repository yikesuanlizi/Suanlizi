import { describe, expect, it } from 'vitest';
import { mergeRunConfigDefaults } from './config.js';

describe('mergeRunConfigDefaults', () => {
  it('keeps saved provider and model when server defaults arrive after refresh', () => {
    const result = mergeRunConfigDefaults(
      {
        workspaceRoot: 'E:/langchain/Suanlizi',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        baseUrl: '',
        permissions: 'workspace',
        dataDir: 'E:/langchain/Suanlizi/.suanlizi',
        skillsRoot: 'C:/Users/Alice/.suanlizi/skills',
        webSearchMode: 'auto',
        webProvider: 'native_fetch',
        webProviderKeySource: 'config',
        reasoningEffort: 'medium',
        runProfile: 'runtime_os',
        themeMode: 'dark',
        userAvatarId: 'rocket',
        customUserAvatarDataUrl: 'data:image/svg+xml;base64,avatar',
        locale: 'zh',
      },
      {
        workspaceRoot: '',
        provider: 'volcengine',
        model: 'doubao-seed-1.6',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        permissions: 'danger_full_access',
        dataDir: '',
        skillsRoot: '',
        webSearchMode: 'auto',
        webProvider: 'firecrawl',
        webProviderKeySource: 'env',
        reasoningEffort: 'medium',
        runProfile: 'runtime_os',
        themeMode: 'dark',
        userAvatarId: 'asteroid',
        customUserAvatarDataUrl: '',
        locale: 'zh',
      },
    );

    expect(result.provider).toBe('volcengine');
    expect(result.model).toBe('doubao-seed-1.6');
    expect(result.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(result.permissions).toBe('danger_full_access');
    expect(result.workspaceRoot).toBe('E:/langchain/Suanlizi');
    expect(result.dataDir).toBe('E:/langchain/Suanlizi/.suanlizi');
    expect(result.skillsRoot).toBe('C:/Users/Alice/.suanlizi/skills');
    expect(result.webProvider).toBe('firecrawl');
    expect(result.webProviderKeySource).toBe('env');
    expect(result.userAvatarId).toBe('asteroid');
    expect(result.customUserAvatarDataUrl).toBe('data:image/svg+xml;base64,avatar');
  });

  it('keeps a user-customized skillsRoot when server defaults arrive after refresh', () => {
    const result = mergeRunConfigDefaults(
      {
        skillsRoot: 'C:/Users/Alice/.suanlizi/skills',
      },
      {
        workspaceRoot: '',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        baseUrl: '',
        permissions: 'workspace',
        dataDir: '',
        skillsRoot: 'D:/shared/skills',
        webSearchMode: 'auto',
        webProvider: 'native_fetch',
        webProviderKeySource: 'config',
        reasoningEffort: 'medium',
        runProfile: 'runtime_os',
        themeMode: 'dark',
        userAvatarId: 'asteroid',
        customUserAvatarDataUrl: '',
        locale: 'zh',
      },
    );

    expect(result.skillsRoot).toBe('D:/shared/skills');
  });

  it('prefers an explicitly stored server context window over stale local state', () => {
    const result = mergeRunConfigDefaults(
      { modelContextTokens: 65_536, modelMaxOutputTokens: 8_192 },
      { modelContextTokens: 24_576, modelMaxOutputTokens: 4_096 },
    );

    expect(result.modelContextTokens).toBe(65_536);
    expect(result.modelMaxOutputTokens).toBe(8_192);
  });

  it('keeps local model limits when the server has no explicit value', () => {
    const result = mergeRunConfigDefaults(
      {},
      { modelContextTokens: 24_576, modelMaxOutputTokens: 4_096 },
    );

    expect(result.modelContextTokens).toBe(24_576);
    expect(result.modelMaxOutputTokens).toBe(4_096);
  });
});
