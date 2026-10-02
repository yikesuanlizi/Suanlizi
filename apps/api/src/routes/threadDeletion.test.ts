import { describe, expect, it } from 'vitest';
import type { ThreadStore } from '@suanlizi/storage';
import { DEFAULT_BOT_CONFIG } from '../config/botConfig.js';
import { clearRemoteBotBindingsForDeletedThread } from './threadDeletion.js';

class ThreadDeletionStore implements Partial<ThreadStore> {
  settings = new Map<string, unknown>();

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }
}

describe('thread deletion route helpers', () => {
  it('clears all remote bot bindings when the bound Suanlizi thread is deleted', async () => {
    const store = new ThreadDeletionStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: {
        ...DEFAULT_BOT_CONFIG.weixin,
        enabled: true,
        accountId: 'wx_account',
        activeThreadId: 'thread_bound',
      },
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        clientId: 'ding_client',
        clientSecret: 'ding_secret',
        activeThreadId: 'thread_bound',
      },
    });

    const next = await clearRemoteBotBindingsForDeletedThread(store as unknown as ThreadStore, 'thread_bound');

    expect(next).toMatchObject({
      weixin: {
        enabled: true,
        accountId: 'wx_account',
        activeThreadId: '',
      },
      dingtalk: {
        enabled: true,
        clientId: 'ding_client',
        clientSecret: 'ding_secret',
        activeThreadId: '',
      },
    });
    expect(store.settings.get('bot.config.v1')).toMatchObject({
      weixin: {
        enabled: true,
        accountId: 'wx_account',
        activeThreadId: '',
      },
      dingtalk: {
        enabled: true,
        clientId: 'ding_client',
        clientSecret: 'ding_secret',
        activeThreadId: '',
      },
    });
  });

  it('leaves remote bot bindings alone when a different thread is deleted', async () => {
    const store = new ThreadDeletionStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: {
        ...DEFAULT_BOT_CONFIG.weixin,
        enabled: true,
        accountId: 'wx_account',
        activeThreadId: 'thread_bound',
      },
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        activeThreadId: 'thread_ding',
      },
    });

    const next = await clearRemoteBotBindingsForDeletedThread(store as unknown as ThreadStore, 'thread_other');

    expect(next).toMatchObject({
      weixin: {
        enabled: true,
        accountId: 'wx_account',
        activeThreadId: 'thread_bound',
      },
      dingtalk: {
        enabled: true,
        activeThreadId: 'thread_ding',
      },
    });
    expect(store.settings.get('bot.config.v1')).toMatchObject({
      weixin: {
        enabled: true,
        accountId: 'wx_account',
        activeThreadId: 'thread_bound',
      },
      dingtalk: {
        enabled: true,
        activeThreadId: 'thread_ding',
      },
    });
  });
});
