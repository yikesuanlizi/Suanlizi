import type { ThreadItem, ThreadMeta, ThreadRuntimeState, ThreadSpawnEdge, TurnMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';

export interface ThreadChildInfo {
  thread: ThreadMeta;
  edge: ThreadSpawnEdge;
  state: ThreadRuntimeState;
  latestTurn: TurnMeta | null;
  latestCollabItem: ThreadItem | null;
  items: ThreadItem[];
}

export async function buildThreadChildInfos(options: {
  parentThreadId: string;
  recursive: boolean;
  store: ThreadStore;
  getRuntimeState(threadId: string): Promise<ThreadRuntimeState>;
}): Promise<ThreadChildInfo[]> {
  const edges = options.recursive
    ? await options.store.listThreadSpawnDescendants(options.parentThreadId)
    : await options.store.listThreadSpawnChildren(options.parentThreadId);
  const result: ThreadChildInfo[] = [];

  for (const edge of edges) {
    const thread = await options.store.getThread(edge.childThreadId);
    if (!thread) continue;
    const [state, turns, parentItems, childItems] = await Promise.all([
      options.getRuntimeState(edge.childThreadId),
      options.store.getTurns(edge.childThreadId),
      options.store.getItems(edge.parentThreadId),
      options.store.getItems(edge.childThreadId),
    ]);
    result.push({
      thread,
      edge,
      state,
      latestTurn: latestTurn(turns),
      latestCollabItem: latestCollabItem(parentItems, edge.childThreadId),
      items: childItems.slice(-80),
    });
  }

  return result;
}

function latestTurn(turns: TurnMeta[]): TurnMeta | null {
  return [...turns].sort((a, b) => {
    const byIndex = Number(b.index ?? 0) - Number(a.index ?? 0);
    if (byIndex !== 0) return byIndex;
    return String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''));
  })[0] ?? null;
}

function latestCollabItem(items: ThreadItem[], childThreadId: string): ThreadItem | null {
  return [...items].reverse().find((item) => (
    item.type === 'collab_tool_call'
    && (item.receiverThreadId === childThreadId || item.newThreadId === childThreadId)
  )) ?? null;
}
