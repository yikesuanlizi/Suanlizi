import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT_CONFIG } from '../config/botConfig.js';
import { BOT_CONFIG_KEY } from '../config/botConfig.js';
import { DINGTALK_TOOL_NAME } from '../services/dingtalkForwardTool.js';
import { createLlamaSlotLeaseManager, createTenantToolRegistry, resolveEffectiveContextTokens } from './tenantRuntime.js';

describe('tenant runtime tools', () => {
  it('adds the DingTalk group forwarding connector to ordinary Suanlizi agents', async () => {
    const store = {
      async getSetting<T>(key: string): Promise<T | null> {
        if (key !== BOT_CONFIG_KEY) return null;
        return {
          ...DEFAULT_BOT_CONFIG,
          dingtalk: {
            ...DEFAULT_BOT_CONFIG.dingtalk,
            enabled: true,
            clientId: 'ding_app_key',
            clientSecret: 'ding_secret',
            robotCode: 'ding_robot',
            targetGroupConversationId: 'cid_group_target',
          },
        } as T;
      },
    };

    const registry = createTenantToolRegistry(store as never);

    expect(registry.get(DINGTALK_TOOL_NAME)).toBeTruthy();
    expect(registry.get('dingtalk_send_group_message')).toBeUndefined();
    expect(registry.get('read_file')).toBeTruthy();
  });
});

describe('tenant runtime llama slot configuration', () => {
  it('uses the server context as a hard ceiling while preserving smaller explicit settings', () => {
    expect(resolveEffectiveContextTokens(undefined, 65_536, 262_144)).toBe(65_536);
    expect(resolveEffectiveContextTokens(32_768, 65_536, 262_144)).toBe(32_768);
    expect(resolveEffectiveContextTokens(131_072, 65_536, 262_144)).toBe(65_536);
    expect(resolveEffectiveContextTokens(undefined, undefined, 262_144)).toBe(262_144);
  });

  it('leaves slot selection to llama.cpp when capacity is unknown', () => {
    expect(createLlamaSlotLeaseManager(undefined)).toBeUndefined();
    expect(createLlamaSlotLeaseManager(null)).toBeUndefined();
    expect(createLlamaSlotLeaseManager(0)).toBeUndefined();
    expect(createLlamaSlotLeaseManager(Number.NaN)).toBeUndefined();
  });

  it('creates a bounded lease manager only for an explicit positive capacity', () => {
    const manager = createLlamaSlotLeaseManager(1);

    expect(manager?.acquire({
      threadId: 'thread-a',
      fingerprint: 'llama-a',
      epoch: 'epoch-1',
    })).toMatchObject({ slotId: 0 });
    expect(manager?.acquire({
      threadId: 'thread-b',
      fingerprint: 'llama-a',
      epoch: 'epoch-1',
    })).toBeNull();
  });

  it('normalizes invalid explicit capacity to the safe single-slot default', () => {
    expect(createLlamaSlotLeaseManager(-1)).toBeUndefined();
    expect(createLlamaSlotLeaseManager(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
