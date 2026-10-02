import type { Locale } from '../../config/config.js';
import { mergeThreadItems } from './threadView.js';
import type { ThreadItem } from '../../shared/types.js';

export function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
}

export function mergeIncomingItems(current: ThreadItem[], incoming: ThreadItem[]): ThreadItem[] {
  const normalized = incoming.filter((item) => item.type !== 'user_message' || item.text?.trim());
  const hasRealUserMessage = normalized.some((item) => item.type === 'user_message' && !item.id.startsWith('pending_user'));
  const base = hasRealUserMessage
    ? current.filter((item) => !(item.type === 'user_message' && item.id.startsWith('pending_user')))
    : current;
  return orderTurnItems(mergeThreadItems(base, normalized) as ThreadItem[]);
}

export function removeLocalThreadItems(current: ThreadItem[], localItems: ThreadItem[]): ThreadItem[] {
  const localIds = new Set(localItems.map((item) => item.id));
  return current.filter((item) => !localIds.has(item.id));
}

function orderTurnItems(items: ThreadItem[]): ThreadItem[] {
  return [...items].sort((a, b) => {
    if (!a.turnId || a.turnId !== b.turnId) return 0;
    if (a.type === 'user_message' && b.type !== 'user_message') return -1;
    if (b.type === 'user_message' && a.type !== 'user_message') return 1;
    return 0;
  });
}

export function createLocalSkillDraftItems(
  args: string,
  locale: Locale,
  timestamp = new Date().toISOString(),
  mode: 'draft' | 'install' = 'draft',
): { items: ThreadItem[]; statusItemId: string } {
  const id = `skill_draft_${Date.now()}`;
  const statusItemId = `${id}_status`;
  const statusText = mode === 'install'
    ? (locale === 'zh' ? '正在下载并安装 Skill...' : 'Downloading and installing Skill...')
    : (locale === 'zh' ? '正在读取内容并生成 Skill 草稿...' : 'Reading content and drafting Skill...');
  return {
    statusItemId,
    items: [
      {
        id: `${id}_user`,
        type: 'user_message',
        text: `/skills add ${args}`.trim(),
        timestamp,
      },
      {
        id: statusItemId,
        type: 'tool_call',
        toolName: 'skills_add',
        arguments: { input: args, mode },
        result: statusText,
        status: 'in_progress',
        timestamp,
      },
    ],
  };
}

export function completeLocalSkillDraftItem(
  items: ThreadItem[],
  statusItemId: string,
  status: 'completed' | 'failed',
  output: string,
): ThreadItem[] {
  return items.map((item) => {
    if (item.id !== statusItemId) return item;
    const completedAt = new Date().toISOString();
    return {
      ...item,
      status,
      result: output,
      timestamp: new Date().toISOString(),
      completedAt,
    };
  });
}

export function actionTitle(action: 'compact' | 'fork' | 'rollback', locale: Locale): string {
  if (locale !== 'zh') {
    if (action === 'compact') return 'Context compacted';
    if (action === 'fork') return 'Chat forked';
    return 'Rolled back';
  }
  if (action === 'compact') return '上下文压缩完成';
  if (action === 'fork') return '已创建分支对话';
  return '已回退一轮';
}

export function actionDetail(action: 'compact' | 'fork' | 'rollback', data: unknown, locale: Locale): string {
  const zh = locale === 'zh';
  if (action === 'fork' && data && typeof data === 'object' && 'thread' in data) {
    return zh ? '新对话已从当前上下文分支出来。' : 'A new chat was forked from the current context.';
  }
  if (action === 'compact') {
    const result = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const before = Number(result.tokensBefore ?? 0);
    const after = Number(result.tokensAfter ?? 0);
    const turns = Number(result.compactedTurns ?? 0);
    if (before > 0 || after > 0 || turns > 0) {
      const released = Math.max(0, before - after);
      return zh
        ? `已压缩 ${turns} 轮，上下文 ${before.toLocaleString()} -> ${after.toLocaleString()} tokens，释放 ${released.toLocaleString()} tokens。`
        : `Compacted ${turns} turns: ${before.toLocaleString()} -> ${after.toLocaleString()} tokens, releasing ${released.toLocaleString()} tokens.`;
    }
    return zh ? '已生成压缩摘要并写回对话。' : 'A compacted summary was written back to the chat.';
  }
  return zh ? '最近一轮已从对话中移除。' : 'The latest turn was removed from the chat.';
}
