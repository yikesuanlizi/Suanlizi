import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildPlainChatThreads,
  buildWorkspaceThreadGroups,
  compactWorkspaceRoots,
  forgetWorkspaceRoot,
  rememberWorkspaceRoots,
  threadsInWorkspace,
  WORKSPACE_ROOTS_STORAGE_KEY,
} from './workspaces.js';
import type { ThreadMeta } from '../../shared/types.js';

function thread(threadId: string, workspaceRoot?: string, parentThreadId?: string): ThreadMeta {
  return {
    threadId,
    title: threadId,
    workspaceRoot,
    status: 'idle',
    turnCount: 1,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: `2026-06-10T00:0${threadId.length}:00.000Z`,
    parentThreadId,
  };
}

function stubLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace root memory', () => {
  it('dedupes normalized roots and keeps the newest roots first', () => {
    expect(compactWorkspaceRoots(['E:/langchain/', 'e:\\langchain', 'D:/work'])).toEqual([
      'E:/langchain',
      'D:/work',
    ]);
  });

  it('persists remembered workspace roots and removes only the local memory entry', () => {
    const storage = stubLocalStorage();
    const remembered = rememberWorkspaceRoots(['D:/old'], ['E:/langchain']);
    expect(remembered).toEqual(['E:/langchain', 'D:/old']);
    expect(JSON.parse(storage.get(WORKSPACE_ROOTS_STORAGE_KEY) ?? '[]')).toEqual(remembered);
    expect(forgetWorkspaceRoot(remembered, 'e:/LANGCHAIN')).toEqual(['D:/old']);
  });
});

describe('threadsInWorkspace', () => {
  it('selects the matching root, its descendants, and leaves other workspaces', () => {
    const selected = threadsInWorkspace([
      thread('parent', 'E:/langchain'),
      thread('child', 'D:/elsewhere', 'parent'),
      thread('grandchild', '', 'child'),
      thread('other', 'D:/work'),
      thread('other-child', 'D:/work', 'other'),
      thread('plain', ''),
    ], 'e:\\langchain\\');

    expect(selected.map((item) => item.threadId)).toEqual(['parent', 'child', 'grandchild']);
  });
});

describe('buildWorkspaceThreadGroups', () => {
  it('groups root threads by workspace without moving a selected workspace to the top', () => {
    const groups = buildWorkspaceThreadGroups({
      currentWorkspaceRoot: 'D:/active',
      rememberedRoots: ['E:/remembered'],
      threads: [
        thread('child', 'D:/active', 'parent'),
        { ...thread('plain', ''), tags: { conversationKind: 'chat' } },
        thread('other', 'E:/remembered'),
        thread('parent', 'D:/active'),
      ],
    });

    expect(groups.map((group) => [group.workspaceRoot, group.threads.map((item) => item.threadId)])).toEqual([
      ['D:/active', ['parent']],
      ['E:/remembered', ['other']],
    ]);
  });

  it('builds the plain chat module from empty workspace or chat-kind threads', () => {
    const chats = buildPlainChatThreads({
      threads: [
        thread('project', 'E:/langchain'),
        thread('empty', ''),
        { ...thread('tagged', 'E:/hidden'), tags: { conversationKind: 'chat' } },
        thread('child', '', 'empty'),
      ],
    });

    expect(chats.map((item) => item.threadId)).toEqual(['tagged', 'empty']);
  });

  it('shows remembered empty workspaces only outside search and searches title/path/label', () => {
    const base = {
      currentWorkspaceRoot: 'E:/langchain',
      rememberedRoots: ['D:/empty'],
      threads: [thread('部署说明', 'E:/langchain')],
    };

    expect(buildWorkspaceThreadGroups(base).map((group) => group.workspaceRoot)).toEqual(['D:/empty', 'E:/langchain']);
    expect(buildWorkspaceThreadGroups({ ...base, searchQuery: 'empty' }).map((group) => group.workspaceRoot)).toEqual(['D:/empty']);
    expect(buildWorkspaceThreadGroups({ ...base, searchQuery: '部署' })[0]?.threads.map((item) => item.threadId)).toEqual(['部署说明']);
  });
});
