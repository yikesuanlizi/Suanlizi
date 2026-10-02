import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockOsState = vi.hoisted(() => ({ homeDir: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockOsState.homeDir,
  };
});

describe('provider API key environment variables', () => {
  const envName = 'SUANLIZI_TEST_OPENAI_API_KEY';

  beforeEach(() => {
    mockOsState.homeDir = mkdtempSync(join(tmpdir(), 'suanlizi-model-gateway-'));
    delete process.env[envName];
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env[envName];
    if (mockOsState.homeDir) {
      rmSync(mockOsState.homeDir, { recursive: true, force: true });
    }
  });

  it('resolves provider keys from a user-selected env var and persisted runtime env', async () => {
    // Import the TS source directly: this workspace may contain stale untracked
    // src/*.js build artifacts, and this test must exercise the edited source.
    // @ts-expect-error Vitest can load TS source modules in tests.
    const providers = await import('./providers.ts');

    providers.saveProviderApiKeyEnvVar('openai', envName);
    providers.saveRuntimeEnvironmentVariables({ [envName]: 'sk-test-env' });

    expect(providers.resolveProviderApiKeyEnvVar('openai')).toBe(envName);
    expect(providers.resolveApiKey('openai')).toBe('sk-test-env');
    expect(providers.listApiKeyEnvVarCandidates('openai')).toContain(envName);
  });

  it('registers llama.cpp as a local OpenAI-compatible provider', async () => {
    // @ts-expect-error Vitest can load TS source modules in tests.
    const providers = await import('./providers.ts');

    expect(providers.getProvider('llama_cpp')).toMatchObject({
      id: 'llama_cpp',
      name: 'llama.cpp',
      baseUrl: 'http://localhost:8080/v1',
      apiKeyEnvVar: '',
      protocol: 'openai',
      isLocal: true,
    });
    expect(providers.getProvider('llama.cpp')?.id).toBe('llama_cpp');
  });

  it('resolves custom provider keys from a user-selected env var', async () => {
    // @ts-expect-error Vitest can load TS source modules in tests.
    const providers = await import('./providers.ts');

    providers.addCustomProvider({
      id: 'custom_minimax_proxy',
      name: 'MiniMax proxy',
      baseUrl: 'https://minimax.example.test/v1',
      apiKeyEnvVar: '',
      protocol: 'openai',
      isLocal: false,
    });
    providers.saveProviderApiKeyEnvVar('custom_minimax_proxy', envName);
    providers.saveRuntimeEnvironmentVariables({ [envName]: 'sk-custom-env' });

    expect(providers.getProvider('custom_minimax_proxy')?.name).toBe('MiniMax proxy');
    expect(providers.resolveProviderApiKeyEnvVar('custom_minimax_proxy')).toBe(envName);
    expect(providers.resolveApiKey('custom_minimax_proxy')).toBe('sk-custom-env');
    expect(providers.listApiKeyEnvVarCandidates('custom_minimax_proxy')).toContain(envName);
  });

  it('persists custom provider favicon branding', async () => {
    // @ts-expect-error Vitest can load TS source modules in tests.
    const providers = await import('./providers.ts');

    const iconUrl = 'https://provider.example/favicon.svg';
    providers.addCustomProvider({
      id: 'custom_favicon_brand',
      name: 'Favicon brand',
      baseUrl: 'https://provider.example/v1',
      apiKeyEnvVar: '',
      protocol: 'openai',
      isLocal: false,
      iconUrl,
    });

    expect(providers.getProvider('custom_favicon_brand')?.iconUrl).toBe(iconUrl);
    expect(providers.listAllProviders().find((p) => p.id === 'custom_favicon_brand')?.iconUrl).toBe(iconUrl);
  });

  it('deletes a custom vendor and credentials, while refusing to delete built-in vendors', async () => {
    // @ts-expect-error Vitest can load TS source modules in tests.
    const providers = await import('./providers.ts');
    providers.addCustomProvider({
      id: 'custom_disposable', name: 'Disposable', baseUrl: 'https://example.test/v1',
      apiKeyEnvVar: '', protocol: 'openai', isLocal: false,
    });
    providers.saveApiKey('custom_disposable', 'sk-disposable');
    providers.saveProviderApiKeyEnvVar('custom_disposable', envName);
    expect(providers.removeCustomProvider('openai')).toBe(false);
    expect(providers.removeCustomProvider('custom_disposable')).toBe(true);
    expect(providers.listAllProviders().find((provider) => provider.id === 'custom_disposable')).toBeUndefined();
    expect(providers.loadConfig().apiKeys?.custom_disposable).toBeUndefined();
    expect(providers.loadConfig().apiKeyEnvVars?.custom_disposable).toBeUndefined();
    expect(providers.removeCustomProvider('custom_disposable')).toBe(false);
  });

  it('resolves provider keys from canonical and alias env var names', async () => {
    // @ts-expect-error Vitest can load TS source modules in tests.
    const providers = await import('./providers.ts');

    process.env.GOOGLE_API_KEY = 'google-key';
    process.env.DASHSCOPE_API_KEY = 'dashscope-key';
    process.env.MOONSHOT_API_KEY = 'moonshot-key';
    process.env.PPLX_API_KEY = 'pplx-key';

    expect(providers.resolveProviderApiKeyEnvVars('gemini')).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    expect(providers.resolveApiKey('gemini')).toBe('google-key');
    expect(providers.resolveApiKey('google')).toBe('google-key');
    expect(providers.resolveApiKey('qwen')).toBe('dashscope-key');
    expect(providers.resolveApiKey('moonshot')).toBe('moonshot-key');
    expect(providers.resolveApiKey('perplexity')).toBe('pplx-key');
    expect(providers.listApiKeyEnvVarCandidates('gemini')).toEqual(expect.arrayContaining([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
    ]));

    delete process.env.GOOGLE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.PPLX_API_KEY;
  });

  it('rejects env-var binding for unknown providers instead of silently dropping it', async () => {
    // @ts-expect-error Vitest can load TS source modules in tests.
    const providers = await import('./providers.ts');

    expect(() => providers.saveProviderApiKeyEnvVar('custom_missing_provider', envName)).toThrow('Unknown provider');
  });

  it('parses Windows user and system environment registry output', async () => {
    // @ts-expect-error Vitest can load TS source modules in tests.
    const providers = await import('./providers.ts');

    expect(providers.parseWindowsRegistryEnvironmentOutput(`
HKEY_CURRENT_USER\\Environment
    OPENAI_API_KEY    REG_SZ    sk-user
    MINIMAX_API_KEY    REG_EXPAND_SZ    eyJhbGciOiJIUzI1NiJ9
    Path    REG_EXPAND_SZ    C:\\Tools
`)).toEqual({
      OPENAI_API_KEY: 'sk-user',
      MINIMAX_API_KEY: 'eyJhbGciOiJIUzI1NiJ9',
      Path: 'C:\\Tools',
    });
  });
});
