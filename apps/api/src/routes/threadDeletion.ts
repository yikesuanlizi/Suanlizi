import type { ThreadStore } from '@suanlizi/storage';
import {
  BOT_CONFIG_KEY,
  DEFAULT_BOT_CONFIG,
  mergeBotConfig,
  normalizeBotConfig,
  type BotConfig,
} from '../config/botConfig.js';

// 清理已删除线程的远程助手绑定（若被删除的线程恰是机器人活跃线程，则清空其活跃线程 ID）
// — Chinese: clear remote bot bindings for a deleted thread (reset active thread ids when they match)
export async function clearRemoteBotBindingsForDeletedThread(store: ThreadStore, deletedThreadId: string): Promise<BotConfig> {
  const current = await readStoredBotConfig(store);
  const patch: Partial<BotConfig> = {};
  if (current.weixin.activeThreadId === deletedThreadId) {
    patch.weixin = { ...current.weixin, activeThreadId: '' };
  }
  if (current.dingtalk.activeThreadId === deletedThreadId) {
    patch.dingtalk = { ...current.dingtalk, activeThreadId: '' };
  }
  if (!patch.weixin && !patch.dingtalk) return current;
  const next = mergeBotConfig(current, patch);
  await store.setSetting(BOT_CONFIG_KEY, next);
  return next;
}

// 若当前微信活跃线程不存在（为空或已失效），将给定线程绑定为微信活跃线程
// — Chinese: bind given thread as WeChat active thread if current missing or invalid
export async function bindWeixinActiveThreadIfMissing(store: ThreadStore, threadId: string): Promise<BotConfig> {
  const current = await readStoredBotConfig(store);
  const activeThreadId = current.weixin.activeThreadId;
  const activeThread = activeThreadId ? await store.getThread(activeThreadId) : null;
  if (activeThread) return current;
  const next = mergeBotConfig(current, { weixin: { enabled: true, activeThreadId: threadId } });
  await store.setSetting(BOT_CONFIG_KEY, next);
  return next;
}

// 读取存储的机器人配置并规范化（若不存在则用默认）
// — Chinese: read stored bot config normalized (fall back to default if missing)
async function readStoredBotConfig(store: ThreadStore): Promise<BotConfig> {
  return normalizeBotConfig(await store.getSetting<unknown>(BOT_CONFIG_KEY) ?? DEFAULT_BOT_CONFIG);
}
