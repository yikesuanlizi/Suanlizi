import { describe, expect, it } from 'vitest';
import type { RuntimeTurnContext } from '@suanlizi/runtime';
import type { ThreadStore } from '@suanlizi/storage';
import { BOT_CONFIG_KEY, DEFAULT_BOT_CONFIG } from '../config/botConfig.js';
import { createDynamicContextProvider } from './dynamicContext.js';

function storeWithBotConfig(config: unknown): ThreadStore {
  return {
    getSetting: async (key: string) => (key === BOT_CONFIG_KEY ? config : null),
  } as never;
}

function runtimeContext(threadId: string): RuntimeTurnContext {
  return { threadId } as RuntimeTurnContext;
}

describe('createDynamicContextProvider', () => {
  it('exposes only public remote bot binding facts for the active thread', async () => {
    const provider = createDynamicContextProvider(storeWithBotConfig({
      weixin: {
        ...DEFAULT_BOT_CONFIG.weixin,
        enabled: true,
        accountId: 'wx_account_123456',
        activeThreadId: 'thread-current',
        syncHistoryOnConnect: false,
      },
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        clientId: 'ding_client_secret_id',
        clientSecret: 'ding_secret_value',
        activeThreadId: 'thread-current',
      },
    }));

    const lines = await provider(runtimeContext('thread-current'));
    const serialized = lines.join('\n');

    expect(serialized).toContain('远程助手绑定状态');
    expect(serialized).toContain('weixin.enabled=true');
    expect(serialized).toContain('weixin.bridgeMode=desktop_managed');
    expect(serialized).toContain('weixin.activeThreadMatched=true');
    expect(serialized).toContain('syncHistoryOnConnect=false');
    expect(serialized).toContain('dingtalk.enabled=true');
    expect(serialized).toContain('dingtalk.configured=true');
    expect(serialized).toContain('dingtalk.activeThreadMatched=true');
    expect(serialized).not.toContain('wx_account_123456');
    expect(serialized).not.toContain('wx_a...3456');
    expect(serialized).not.toContain('ding_client_secret_id');
    expect(serialized).not.toContain('ding_secret_value');
  });

  it('reports activeThreadMatched=false without exposing account identifiers', async () => {
    const provider = createDynamicContextProvider(storeWithBotConfig({
      weixin: {
        ...DEFAULT_BOT_CONFIG.weixin,
        enabled: true,
        accountId: 'wx_short',
        activeThreadId: 'thread-other',
      },
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        clientId: 'ding_short',
        activeThreadId: 'thread-other',
      },
    }));

    const lines = await provider(runtimeContext('thread-current'));
    const serialized = lines.join('\n');

    expect(serialized).toContain('weixin.enabled=true');
    expect(serialized).toContain('weixin.activeThreadMatched=false');
    expect(serialized).toContain('dingtalk.activeThreadMatched=false');
    expect(serialized).not.toContain('wx_short');
    expect(serialized).not.toContain('ding_short');
    expect(serialized).not.toContain('****');
  });
});
