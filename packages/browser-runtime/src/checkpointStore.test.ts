// 检查点存储单元测试：JSONL 追加 / 加载 / 原子替换 / 损坏行容错 / 目录清理
// — English: checkpoint store unit tests — JSONL append, load, atomic replace,
//   torn-line tolerance and temp-dir cleanup
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, appendFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserTaskEventSchema, type BrowserTaskEvent } from '@suanlizi/protocol';
import { TaskEventStore, taskCheckpointPath } from './checkpointStore.js';

// 根临时目录：每个用例在其下 mkdtemp 独立子目录，互不依赖执行顺序。
// — English: root temp dir; each case mkdtemp's its own sub-dir, so cases are order-independent.
let rootDir: string;

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'checkpoint-store-'));
});

// 测试后清理临时目录
// — English: cleanup the temp dirs after all tests
afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function makeStore(): Promise<{ dir: string; store: TaskEventStore }> {
  const dir = await mkdtemp(join(rootDir, 'case-'));
  return { dir, store: new TaskEventStore({ dir }) };
}

// 构造合法 task.created 事件（严格满足 browserTaskEventSchema）
// — English: build a valid task.created event (satisfies browserTaskEventSchema strictly)
function createdEvent(taskId: string, n: number): BrowserTaskEvent {
  return {
    type: 'task.created',
    taskId,
    goal: `测试目标 ${n}`,
    createdAt: new Date(2000 + n, 0, 1).toISOString(),
  };
}

describe('TaskEventStore append / load / size', () => {
  it('append 3 条 → load 返回 3 条且顺序一致、skipped 0；size 3', async () => {
    const { store } = await makeStore();
    const events = [createdEvent('t1', 1), createdEvent('t1', 2), createdEvent('t1', 3)];
    for (const event of events) {
      await store.append(event);
    }
    const { events: loaded, skipped } = await store.load();
    expect(skipped).toBe(0);
    expect(loaded).toHaveLength(3);
    // 顺序一致：按追加顺序返回（用判别字段收窄，保持 strict 类型安全）
    const createdAtOf = (e: BrowserTaskEvent) => (e.type === 'task.created' ? e.createdAt : '');
    expect(loaded.map(createdAtOf)).toEqual(events.map(createdAtOf));
    expect(await store.size()).toBe(3);
  });

  it('文件不存在 → load 空、size 0', async () => {
    const { store } = await makeStore();
    const { events, skipped } = await store.load();
    expect(events).toEqual([]);
    expect(skipped).toBe(0);
    expect(await store.size()).toBe(0);
  });

  it('非法事件（缺字段的伪造对象）append → 抛错且文件行数不变', async () => {
    const { store } = await makeStore();
    await store.append(createdEvent('t1', 1));
    expect(await store.size()).toBe(1);

    // 伪造对象：type 合法但缺 goal / createdAt 字段
    const forged = { type: 'task.created', taskId: 't1' } as unknown as BrowserTaskEvent;
    await expect(store.append(forged)).rejects.toThrow(/fails browserTaskEventSchema/);

    // 行数不变，已有事件不受影响
    expect(await store.size()).toBe(1);
    const { events, skipped } = await store.load();
    expect(skipped).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('task.created');
  });

  it('损坏行（非 JSON）不阻断恢复：手动写损坏行 + 合法行 → load 合法事件、skipped 1', async () => {
    const { dir, store } = await makeStore();
    const path = taskCheckpointPath(dir);
    // 模拟崩溃半写：第一行是垃圾，第二行是合法事件
    await appendFile(path, 'not json\n', 'utf8');
    await store.append(createdEvent('t1', 9));

    const { events, skipped } = await store.load();
    expect(skipped).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe('t1');
    // size 含校验失败行
    expect(await store.size()).toBe(2);
  });

  it('append 的事件能通过 browserTaskEventSchema 往返', async () => {
    const { store } = await makeStore();
    const events = [
      createdEvent('t1', 1),
      { type: 'task.paused' as const, taskId: 't1', reason: '等待人工', pausedAt: '2026-01-01T00:00:00.000Z' },
    ];
    for (const event of events) {
      await store.append(event);
    }
    const { events: loaded } = await store.load();
    expect(loaded).toHaveLength(2);
    for (const event of loaded) {
      expect(browserTaskEventSchema.safeParse(event).success).toBe(true);
    }
  });
});

describe('TaskEventStore replace 原子截断重写', () => {
  it('replace 后 load 只含新事件；旧内容被原子替换', async () => {
    const { dir, store } = await makeStore();
    const path = taskCheckpointPath(dir);
    await store.append(createdEvent('t1', 1));
    await store.append(createdEvent('t1', 2));

    const replacement = [createdEvent('t1', 7), createdEvent('t1', 8)];
    await store.replace(replacement);

    const { events, skipped } = await store.load();
    expect(skipped).toBe(0);
    expect(events).toHaveLength(2);
    // 只含新事件：createdAt 均为替换后的值（用判别字段收窄）
    const createdAtOf = (e: BrowserTaskEvent) => (e.type === 'task.created' ? e.createdAt : '');
    expect(events.map(createdAtOf)).toEqual(replacement.map(createdAtOf));
    expect(await store.size()).toBe(2);
    // 原子替换完成：临时文件不残留
    await expect(access(`${path}.tmp`)).rejects.toThrow();
  });

  it('replace 空列表 → 清空文件，load 空', async () => {
    const { store } = await makeStore();
    await store.append(createdEvent('t1', 1));
    await store.replace([]);
    const { events, skipped } = await store.load();
    expect(events).toEqual([]);
    expect(skipped).toBe(0);
    expect(await store.size()).toBe(0);
  });

  it('replace 含非法事件 → 整体拒绝抛错，旧内容保持不变', async () => {
    const { store } = await makeStore();
    await store.append(createdEvent('t1', 1));
    const forged = { type: 'action.completed' } as unknown as BrowserTaskEvent;
    await expect(store.replace([forged])).rejects.toThrow(/fails browserTaskEventSchema/);
    // 旧内容未被破坏
    const { events, skipped } = await store.load();
    expect(skipped).toBe(0);
    expect(events).toHaveLength(1);
    expect(await store.size()).toBe(1);
  });
});
