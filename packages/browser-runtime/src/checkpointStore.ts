// 检查点存储：任务事件以 JSONL 追加落盘（append-only）+ 原子截断重写
// — English: checkpoint store — task events persisted as append-only JSONL
//   with atomic truncating rewrite
// 架构依据：架构文档 6.1 lastCheckpointId / 14.2 检查点——状态由事件折叠得到
// 并写入检查点；崩溃后通过事件流判断继续、对账或挂起。本模块是 Phase 2 验收
// 『模拟崩溃后不会重复提交外部写入』的持久化基础：append-only 事件账本保证
// 追加在损坏行之前的有效事件仍然可恢复，杜绝“事件丢失却重放动作”的重复提交。
// — English: per architecture docs 6.1/14.2 — state is derived by folding events
//   into checkpoints; after a crash the event stream decides continue/reconcile/
//   pause. This module is the persistence basis for the Phase 2 acceptance
//   “no duplicate external writes after a simulated crash”: the append-only
//   ledger keeps every valid event before a torn tail recoverable, so actions
//   are never replayed against unknown side effects.
// 文件约定：<dir>/task-events.jsonl，每行一条 JSON 事件（无多余空白）。
// — English: file layout — <dir>/task-events.jsonl, one JSON event per line.
// 并发安全：Phase 1 为单任务单写者模型，本类不额外加锁；多进程/多写者并发
// 由上层（任务隔离目录 + 任务级互斥）保证。
// — English: concurrency — Phase 1 is single-task single-writer; no extra
//   locking here. Cross-process/writer exclusion is the caller's job
//   (per-task dirs + task-level mutex).

import { mkdir, readFile, rename, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserTaskEventSchema, type BrowserTaskEvent } from '@suanlizi/protocol';

// 检查点文件路径约定：任务隔离目录下的固定文件名。
// — English: canonical checkpoint file path inside the per-task isolated dir.
export function taskCheckpointPath(dir: string): string {
  return join(dir, 'task-events.jsonl');
}

export interface CheckpointStoreOptions {
  // 任务隔离目录（调用方保证已创建，如 <data>/browser-tasks/<taskId>）
  // — English: per-task isolated dir (caller guarantees it exists)
  dir: string;
}

// 事件存储：append-only JSONL 账本，崩溃后按行恢复。
// — English: event store — append-only JSONL ledger, recovered line by line.
export class TaskEventStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(options: CheckpointStoreOptions) {
    this.dir = options.dir;
    this.path = taskCheckpointPath(options.dir);
  }

  // 追加一条事件（JSONL append + 写盘同步 flush）；schema 校验失败抛 Error 且不落盘。
  // — English: append one event (JSONL append, flushed write). Events failing
  //   browserTaskEventSchema throw an Error and are NOT persisted.
  async append(event: BrowserTaskEvent): Promise<void> {
    const parsed = browserTaskEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(
        `checkpoint append rejected: event fails browserTaskEventSchema (${describeIssue(parsed.error.issues[0])})`,
      );
    }
    // 目录不存在时自动创建（幂等；调用方通常已创建）。
    // — English: create the dir on demand (idempotent; callers normally create it).
    await mkdir(this.dir, { recursive: true });
    // appendFile 返回即表示数据已同步交给操作系统；单写者下追加顺序即事件顺序。
    // — English: once appendFile resolves the bytes are handed to the OS; under
    //   the single-writer model append order equals event order.
    await appendFile(this.path, `${JSON.stringify(parsed.data)}\n`, 'utf8');
  }

  // 读取全部事件（按行解析）；schema 校验失败的行按 append 侧错误行策略：
  // 跳过并计数（返回 { events, skipped }）。文件不存在 → { events: [], skipped: 0 }。
  // — English: load all events, parsing line by line. Schema-invalid lines are
  //   skipped and counted per the append-side error-line policy, returning
  //   { events, skipped }. A missing file yields { events: [], skipped: 0 }.
  async load(): Promise<{ events: BrowserTaskEvent[]; skipped: number }> {
    const content = await this.readOrEmpty();
    const events: BrowserTaskEvent[] = [];
    let skipped = 0;
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line === '') continue; // 空行（含文件尾换行）不算损坏
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        skipped += 1; // 非 JSON 行（如崩溃半写）不阻断恢复
        continue;
      }
      const parsed = browserTaskEventSchema.safeParse(value);
      if (parsed.success) {
        events.push(parsed.data);
      } else {
        skipped += 1; // JSON 合法但缺字段/字段非法
      }
    }
    return { events, skipped };
  }

  // 截断重写：恢复后若事件流被重放/修正，原子写临时文件再 rename。
  // 任一事件校验失败则整体拒绝，旧文件保持不变。
  // — English: truncating rewrite — used when the event stream is replayed or
  //   repaired after recovery. Writes <path>.tmp then atomically renames it.
  //   If ANY event fails schema validation the whole batch is rejected and
  //   the existing file is left untouched.
  async replace(events: ReadonlyArray<BrowserTaskEvent>): Promise<void> {
    // 先整体校验再落盘，避免写一半失败留下不一致的混合文件。
    // — English: validate everything up-front so a failed batch never leaves a mixed file.
    const validated = events.map((event) => {
      const parsed = browserTaskEventSchema.safeParse(event);
      if (!parsed.success) {
        throw new Error(
          `checkpoint replace rejected: event fails browserTaskEventSchema (${describeIssue(parsed.error.issues[0])})`,
        );
      }
      return parsed.data;
    });
    await mkdir(this.dir, { recursive: true });
    // 唯一临时名：path + '.tmp'；rename 在同一目录内，保证原子替换。
    // — English: unique temp name <path>.tmp; rename stays in the same dir so the swap is atomic.
    const tmpPath = `${this.path}.tmp`;
    const body = validated.length === 0 ? '' : `${validated.map((e) => JSON.stringify(e)).join('\n')}\n`;
    await writeFile(tmpPath, body, 'utf8');
    await rename(tmpPath, this.path);
  }

  // 行数（文件行数，含校验失败行；空行不计）。文件不存在 → 0。
  // — English: line count (includes schema-invalid lines; blank lines excluded).
  //   Missing file → 0.
  async size(): Promise<number> {
    const content = await this.readOrEmpty();
    let count = 0;
    for (const raw of content.split('\n')) {
      if (raw.trim() !== '') count += 1;
    }
    return count;
  }

  private async readOrEmpty(): Promise<string> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return '';
      throw err;
    }
  }
}

// 便捷：从事件序列构造可恢复状态（折叠）——直接复用 taskMachine 的 foldBrowserTaskEvents。
// — English: convenience — fold events into a recoverable state via BrowserTaskMachine's fold.
export { foldBrowserTaskEvents } from './taskMachine.js';

// 格式化 zod 首个 issue 便于定位；无 issue 时退化为通用描述。
// — English: format the first zod issue for locating; falls back to a generic description.
function describeIssue(issue: { path?: PropertyKey[]; message?: string } | undefined): string {
  if (!issue) return 'invalid event';
  const path = issue.path && issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message ?? 'invalid'}`;
}

// 类型守卫：Node 风格 errno 错误（避免依赖全局 NodeJS 命名空间）。
// — English: type guard for Node-style errno errors (no global NodeJS namespace dependency).
function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: unknown }).code === code;
}
