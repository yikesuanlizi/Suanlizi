import { RUN_TRACE_VERSION } from '@suanlizi/protocol';
import type {
  RunTraceDraft,
  RunTraceEnvelope,
  RunTracePage,
  RunTraceSummary,
  Checkpoint,
  ThreadId,
  ThreadItem,
  MemoryRecord,
  MemorySearchOptions,
  ThreadMeta,
  ThreadSpawnEdge,
  ThreadSpawnEdgeStatus,
  TurnMeta,
  TurnId,
  EpisodeRecord,
  EpisodeSearchOptions,
  ThreadWorkingSetSnapshot,
} from '@suanlizi/protocol';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunTraceQuery } from './runTraceStore.js';
import { ensureTaskStoreSchema } from './taskStore.js';

export const DEFAULT_TENANT_ID = 'default';

export function safeTenantId(value: string | null | undefined): string {
  const tenantId = value?.trim() || DEFAULT_TENANT_ID;
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new Error(`Invalid tenant id: ${value ?? ''}`);
  }
  return tenantId;
}

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'blocked';
export type RunKind =
  | 'turn'
  | 'model'
  | 'tool'
  | 'workflow'
  | 'subagent'
  | 'middleware'
  | 'checkpoint'
  | 'control'
  | 'file';
export type RunCaller = 'lead_agent' | 'subagent' | 'middleware' | 'tool' | 'workflow';
export type RunEventLevel = 'debug' | 'info' | 'warning' | 'error';

export interface RunRecord {
  runId: string;
  tenantId?: string;
  threadId: ThreadId;
  turnId?: TurnId | null;
  parentRunId?: string | null;
  workflowId?: string | null;
  workflowNodeId?: string | null;
  kind: RunKind;
  status: RunStatus;
  title?: string | null;
  caller: RunCaller;
  activeStep?: string | null;
  model?: string | null;
  error?: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  toolCallCount: number;
  modelCallCount: number;
  subagentCount: number;
  middlewareEventCount: number;
  firstHumanMessage?: string | null;
  lastAiMessage?: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  metadata?: Record<string, unknown>;
  traceVersion?: 2 | null;
  traceSummary?: RunTraceSummary | null;
}

export interface RunEvent {
  eventId: string;
  runId: string;
  tenantId?: string;
  threadId: ThreadId;
  turnId?: TurnId | null;
  parentRunId?: string | null;
  workflowId?: string | null;
  workflowNodeId?: string | null;
  sequence: number;
  category: RunKind | 'approval' | 'compaction' | 'rollback' | 'memory' | 'item';
  type: string;
  level: RunEventLevel;
  message: string;
  toolName?: string | null;
  model?: string | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RunFeedback {
  feedbackId: string;
  runId: string;
  tenantId?: string;
  threadId: ThreadId;
  rating: -1 | 0 | 1;
  comment?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RollbackMarker {
  count: number;
  remainingTurnCount: number;
  requestId?: string | null;
  createdAt?: string;
}

/** Abstract SQLite DB handle — callers inject the real better-sqlite3 instance. */
// 抽象 SQLite DB 句柄：由调用方注入真实的 better-sqlite3 实例
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma?(sql: string): unknown;
}

interface SqliteStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Narrow SQL surface exposed to feature stores that live beside thread data. */
export interface KnowledgeSqlitePort {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  get<T = unknown>(sql: string, params?: unknown[]): T | undefined;
  all<T = unknown>(sql: string, params?: unknown[]): T[];
}

// ─── ThreadStore Interface ──────────────────────────────────────────────────
/**
 * The canonical storage boundary for thread metadata and rollout history.
 * - append_items: raw history append — does NOT infer metadata.
 * - update_thread_metadata: the only metadata write path.
 */
// 线程元信息与执行历史的标准存储边界
// - append_items：纯追加原始历史，不推导元信息
// - update_thread_metadata：唯一的元信息写入路径
export interface ThreadStore {
  readonly tenantId?: string;

  /** Dedicated SQLite port for the local Wiki catalog and lexical index. */
  readonly knowledgeSqlite?: KnowledgeSqlitePort;

  scope?(tenantId: string): ThreadStore;

  appendItems(threadId: ThreadId, items: ThreadItem[]): Promise<void>;

  updateThreadMetadata(
    threadId: ThreadId,
    patch: Partial<
      Pick<
        ThreadMeta,
        'title' | 'workspaceRoot' | 'status' | 'turnCount' | 'updatedAt' | 'tags' | 'mode' | 'taskPreset'
      >
    >,
  ): Promise<void>;

  createThread(meta: ThreadMeta): Promise<void>;

  getThread(threadId: ThreadId): Promise<ThreadMeta | null>;

  listThreads(filter?: { status?: ThreadMeta['status']; limit?: number }): Promise<ThreadMeta[]>;

  /** Delete thread metadata, turns, and rollout history. */
  // 删除线程元信息、所有回合与执行历史
  deleteThread(threadId: ThreadId): Promise<void>;

  /**
   * P6.3: 读取 thread 的 items，支持按 runId/turnId/type 严格过滤与 cursor 分页。
   * - runId/turnId/type: 仅返回匹配的 item（用于 run monitor 严格按 run 关联）
   * - afterSequence/beforeSequence: 基于行索引的 cursor 分页（exclusive）
   * - limit: 返回最后 N 个匹配 item（与 timeline.slice(-limit) 行为一致）
   * 不传 filter 时返回全部 active items（保持现有调用方行为）。
   */
  // — Chinese: read thread items with optional run/turn/type filter and cursor pagination
  getItems(
    threadId: ThreadId,
    filter?: {
      runId?: string;
      turnId?: string;
      type?: string;
      limit?: number;
      afterSequence?: number;
      beforeSequence?: number;
    },
  ): Promise<ThreadItem[]>;

  /** Get all turns for a thread. */
  // 获取一个线程的所有回合元信息
  getTurns(threadId: ThreadId): Promise<TurnMeta[]>;

  /** Persist a turn. */
  // 持久化一个回合
  saveTurn(turn: TurnMeta): Promise<void>;

  /** Delete turns at or after the supplied active turn count. */
  // 删除从给定 active turn count 开始及之后的回合，避免回退后复用旧 turn_index。
  deleteTurnsAfter?(threadId: ThreadId, turnCount: number): Promise<void>;

  /** Get recent items for constructing model context. */
  // 获取最近的条目，用于拼装模型上下文
  getRecentItems(threadId: ThreadId, maxItems?: number): Promise<ThreadItem[]>;

  /** Get the last checkpoint written for a thread. */
  // 获取线程最后一次写入的检查点
  getLastCheckpoint(threadId: ThreadId): Promise<Checkpoint | null>;

  /** Write a checkpoint line directly to JSONL (not via item append). */
  // 直接向 JSONL 写入检查点行（不走 item append 路径）
  appendCheckpoint(threadId: ThreadId, ckpt: Checkpoint): Promise<void>;

  /** Write a rollback marker line directly to JSONL (not via item append). */
  // 直接向 JSONL 写入回滚标记行（不走 item append 路径）
  appendRollbackMarker?(threadId: ThreadId, marker: RollbackMarker): Promise<void>;

  /** Read a JSON setting from SQLite. */
  // 从 SQLite 读取一个 JSON 配置
  getSetting<T = unknown>(key: string): Promise<T | null>;

  /** Persist a JSON setting to SQLite. */
  // 把一个 JSON 配置写入 SQLite
  setSetting(key: string, value: unknown): Promise<void>;

  upsertMemoryRecord?(record: MemoryRecord): Promise<void>;

  listMemoryRecords?(filter?: MemorySearchOptions): Promise<MemoryRecord[]>;

  searchMemoryRecords?(query: string, options?: MemorySearchOptions): Promise<MemoryRecord[]>;

  deleteMemoryRecord?(id: string): Promise<void>;

  recordMemoryUsage?(id: string, usedAt: string): Promise<void>;

  upsertEpisodeRecord?(record: EpisodeRecord): Promise<void>;

  getEpisodeRecord?(id: string): Promise<EpisodeRecord | null>;

  listEpisodeRecords?(options?: EpisodeSearchOptions): Promise<EpisodeRecord[]>;

  searchEpisodeRecords?(query: string, options?: EpisodeSearchOptions): Promise<EpisodeRecord[]>;

  recordEpisodeUsage?(id: string, usedAt: string): Promise<void>;

  saveThreadWorkingSet?(snapshot: ThreadWorkingSetSnapshot): Promise<void>;

  getThreadWorkingSet?(threadId: ThreadId): Promise<ThreadWorkingSetSnapshot | null>;

  deleteThreadWorkingSet?(threadId: ThreadId): Promise<void>;

  /** Compact rollout JSONL by removing items before the latest checkpoint item index. */
  // 压缩 rollout JSONL：删除最近检查点索引之前的条目
  compactRollout?(
    threadId: ThreadId,
    options?: { keepLastCheckpoints?: number },
  ): Promise<{
    beforeLines: number;
    afterLines: number;
    removedItems: number;
  }>;

  /** Persist or reopen a parent -> child spawned-agent edge. */
  // 持久化或重新打开一条父线程 → 子代理的派生边
  upsertThreadSpawnEdge(edge: ThreadSpawnEdge): Promise<void>;

  /** Mark a spawned-agent edge open/closed. */
  // 将子代理派生边标记为开放 / 关闭
  setThreadSpawnEdgeStatus(
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): Promise<void>;

  /** List direct spawned children for a parent thread. */
  // 列出父线程直接派生的所有子线程
  listThreadSpawnChildren(
    parentThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): Promise<ThreadSpawnEdge[]>;

  /** Walk the spawned-agent tree beneath a parent thread. */
  // 遍历父线程下的子代理派生树
  listThreadSpawnDescendants(
    parentThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): Promise<ThreadSpawnEdge[]>;

  createRunRecord?(record: RunRecord): Promise<void>;

  updateRunRecord?(runId: string, patch: Partial<RunRecord>): Promise<void>;

  getRunRecord?(runId: string): Promise<RunRecord | null>;

  appendRunEvent?(event: RunEvent): Promise<void>;

  listRunRecords?(filter?: {
    threadId?: ThreadId;
    status?: RunStatus;
    limit?: number;
  }): Promise<RunRecord[]>;

  listRunEvents?(
    runId: string,
    filter?: {
      limit?: number;
      category?: string;
      type?: string;
      afterSequence?: number;
      beforeSequence?: number;
    },
  ): Promise<RunEvent[]>;

  upsertRunFeedback?(feedback: RunFeedback): Promise<void>;

  listRunFeedback?(runId: string): Promise<RunFeedback[]>;
}

// ─── LocalThreadStore (SQLite + JSONL) ──────────────────────────────────────
export class LocalThreadStore implements ThreadStore {
  private db: SqliteDb;
  private dataDir: string;
  private sqlitePath: string;
  readonly tenantId: string;
  readonly knowledgeSqlite?: KnowledgeSqlitePort;

  constructor(db: SqliteDb, dataDir: string, tenantId: string = DEFAULT_TENANT_ID) {
    this.db = db;
    this.dataDir = dataDir;
    this.sqlitePath = path.join(dataDir, 'threads.db');
    this.tenantId = safeTenantId(tenantId);
    // The JSON fallback implements the legacy thread-shaped SQL shim but does
    // not expose pragma(), so it must never be treated as a real SQLite index.
    if (typeof db.pragma === 'function') {
      this.knowledgeSqlite = {
        exec: (sql) => db.exec(sql),
        run: (sql, params = []) => db.prepare(sql).run(...params),
        get: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
        all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
      };
    }
    this.initSchema();
  }

  scope(tenantId: string): LocalThreadStore {
    return new LocalThreadStore(this.db, this.dataDir, tenantId);
  }

  private initSchema(): void {
    const now = new Date().toISOString();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL DEFAULT '',
        workspace_root TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        turn_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '{}',
        parent_thread_id TEXT,
        agent_nickname TEXT,
        agent_role TEXT,
        mode TEXT NOT NULL DEFAULT 'chat',
        task_preset TEXT
      );

      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id),
        turn_index INTEGER NOT NULL,
        user_input TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id, turn_index);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (parent_thread_id, child_thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_thread_spawn_edges_parent
        ON thread_spawn_edges(tenant_id, parent_thread_id, status);

      CREATE TABLE IF NOT EXISTS run_records (
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        parent_run_id TEXT,
        workflow_id TEXT,
        workflow_node_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        caller TEXT NOT NULL,
        active_step TEXT,
        model TEXT,
        error TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        model_call_count INTEGER NOT NULL DEFAULT 0,
        subagent_count INTEGER NOT NULL DEFAULT 0,
        middleware_event_count INTEGER NOT NULL DEFAULT 0,
        first_human_message TEXT,
        last_ai_message TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        trace_version INTEGER,
        trace_summary_json TEXT,
        PRIMARY KEY (tenant_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_records_tenant_thread
        ON run_records(tenant_id, thread_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_run_records_tenant_status
        ON run_records(tenant_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS run_events (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        parent_run_id TEXT,
        workflow_id TEXT,
        workflow_node_id TEXT,
        sequence INTEGER NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        tool_name TEXT,
        model TEXT,
        duration_ms INTEGER,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_tenant_run
        ON run_events(tenant_id, run_id, sequence);

      CREATE TABLE IF NOT EXISTS run_trace_heads (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        run_id TEXT NOT NULL,
        next_sequence INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS run_trace_events (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        category TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, run_id, sequence),
        UNIQUE (tenant_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_trace_events_tenant_run_category
        ON run_trace_events(tenant_id, run_id, category, sequence);

      CREATE TABLE IF NOT EXISTS run_feedback (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        feedback_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        rating INTEGER NOT NULL DEFAULT 0,
        comment TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, feedback_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_feedback_tenant_run
        ON run_feedback(tenant_id, run_id);

      CREATE TABLE IF NOT EXISTS memory_records (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT NOT NULL DEFAULT 'global',
        source_thread_id TEXT,
        source_turn_ids TEXT NOT NULL DEFAULT '[]',
        workspace_root TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_records_tenant_status
        ON memory_records(tenant_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_records_tenant_workspace
        ON memory_records(tenant_id, workspace_root, status);

      CREATE TABLE IF NOT EXISTS episode_records (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        id TEXT NOT NULL,
        workspace_root TEXT NOT NULL DEFAULT '',
        source_thread_id TEXT NOT NULL,
        source_turn_start TEXT NOT NULL,
        source_turn_end TEXT NOT NULL,
        source_turn_start_index INTEGER NOT NULL,
        source_turn_end_index INTEGER NOT NULL,
        lifecycle TEXT NOT NULL,
        temperature TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        objective TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        facts TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        artifacts TEXT NOT NULL DEFAULT '[]',
        open_tasks TEXT NOT NULL DEFAULT '[]',
        entities TEXT NOT NULL DEFAULT '[]',
        keywords TEXT NOT NULL DEFAULT '[]',
        boundary_reason TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL DEFAULT '',
        topic_key TEXT NOT NULL DEFAULT '',
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_activated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_episode_records_tenant_thread
        ON episode_records(tenant_id, source_thread_id, lifecycle, temperature);
      CREATE INDEX IF NOT EXISTS idx_episode_records_tenant_workspace
        ON episode_records(tenant_id, workspace_root, lifecycle, temperature);
      CREATE INDEX IF NOT EXISTS idx_episode_records_fingerprint
        ON episode_records(tenant_id, fingerprint);

      CREATE VIRTUAL TABLE IF NOT EXISTS episode_search USING fts5(episode_id UNINDEXED, search_text);

      CREATE TABLE IF NOT EXISTS thread_working_sets (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        thread_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        active_episode_ids TEXT NOT NULL DEFAULT '[]',
        injected_episode_ids TEXT NOT NULL DEFAULT '[]',
        frozen_prompt_block TEXT NOT NULL DEFAULT '',
        built_from_turn_id TEXT NOT NULL DEFAULT '',
        built_from_turn_index INTEGER NOT NULL DEFAULT -1,
        task_fingerprint TEXT NOT NULL DEFAULT '',
        episode_identity TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_working_sets_tenant
        ON thread_working_sets(tenant_id, thread_id);
    `);
    this.addColumnIfMissing('threads', 'tenant_id', `TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`);
    this.addColumnIfMissing('threads', 'parent_thread_id', 'TEXT');
    this.addColumnIfMissing('threads', 'agent_nickname', 'TEXT');
    this.addColumnIfMissing('threads', 'agent_role', 'TEXT');
    this.addColumnIfMissing('threads', 'mode', "TEXT NOT NULL DEFAULT 'chat'");
    this.addColumnIfMissing('threads', 'task_preset', 'TEXT');
    this.addColumnIfMissing(
      'thread_spawn_edges',
      'tenant_id',
      `TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`,
    );
    this.addColumnIfMissing('run_records', 'trace_version', 'INTEGER');
    this.addColumnIfMissing('run_records', 'trace_summary_json', 'TEXT');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_threads_tenant_updated
        ON threads(tenant_id, updated_at);
    `);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      )
      .run(1, 'initial_thread_store_schema', now);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      )
      .run(2, 'tenant_scoped_thread_store', now);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      )
      .run(3, 'run_monitor_store', now);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      )
      .run(4, 'episode_memory_store', now);
    this.migrateV5IfNeeded();
    this.migrateV6IfNeeded();
    this.migrateTaskStoreIfNeeded();
  }

  /**
   * Mount point for the goal-task workflow store (plan §6.2 / §11.2 / §14.6).
   * Registers the four task tables through the same schema_migrations mechanism and
   * touches no existing thread-store method. DDL lives in ./taskStore.js (single source).
   * — Chinese：目标任务四张表的迁移挂载点；DDL 与幂等版本号统一由 ./taskStore.js 承载。
   */
  private migrateTaskStoreIfNeeded(): void {
    ensureTaskStoreSchema(this.db);
  }

  private migrateV5IfNeeded(): void {
    const versionRow = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('storage.schemaVersion') as { value?: string } | undefined;
    const currentVersion = versionRow
      ? ((JSON.parse(versionRow.value ?? '{}') as { version?: number }).version ?? 0)
      : 0;
    if (currentVersion >= 5) return;

    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_working_sets'")
      .all() as Array<{ name: string }>;
    if (tables.length > 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS thread_working_sets_v5 (
          tenant_id TEXT NOT NULL DEFAULT 'default',
          thread_id TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0,
          active_episode_ids TEXT NOT NULL DEFAULT '[]',
          injected_episode_ids TEXT NOT NULL DEFAULT '[]',
          frozen_prompt_block TEXT NOT NULL DEFAULT '',
          built_from_turn_id TEXT NOT NULL DEFAULT '',
          built_from_turn_index INTEGER NOT NULL DEFAULT -1,
          task_fingerprint TEXT NOT NULL DEFAULT '',
          episode_identity TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, thread_id)
        );
        INSERT OR IGNORE INTO thread_working_sets_v5 (
          tenant_id, thread_id, generation, active_episode_ids, injected_episode_ids,
          frozen_prompt_block, built_from_turn_id, built_from_turn_index, task_fingerprint,
          episode_identity, created_at, updated_at
        )
        SELECT
          tenant_id, thread_id, generation, active_episode_ids, injected_episode_ids,
          frozen_prompt_block, built_from_turn_id, built_from_turn_index, task_fingerprint,
          '', created_at, updated_at
        FROM thread_working_sets;
        DROP TABLE thread_working_sets;
        ALTER TABLE thread_working_sets_v5 RENAME TO thread_working_sets;
        CREATE INDEX IF NOT EXISTS idx_thread_working_sets_tenant
          ON thread_working_sets(tenant_id, thread_id);
      `);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      )
      .run(5, 'thread_working_sets_composite_key', now);
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('storage.schemaVersion', JSON.stringify({ version: 5 }), now);
  }

  private migrateV6IfNeeded(): void {
    const versionRow = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('storage.schemaVersion') as { value?: string } | undefined;
    const currentVersion = versionRow
      ? ((JSON.parse(versionRow.value ?? '{}') as { version?: number }).version ?? 0)
      : 0;
    if (currentVersion >= 6) return;

    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      )
      .run(6, 'run_trace_v2_events', now);
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('storage.schemaVersion', JSON.stringify({ version: 6 }), now);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async createThread(meta: ThreadMeta): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO threads (thread_id, tenant_id, title, workspace_root, status, turn_count, created_at, updated_at, archived_at, ephemeral, tags, parent_thread_id, agent_nickname, agent_role, mode, task_preset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.threadId,
        this.tenantId,
        meta.title,
        meta.workspaceRoot,
        meta.status,
        meta.turnCount,
        meta.createdAt,
        meta.updatedAt,
        meta.archivedAt,
        meta.ephemeral ? 1 : 0,
        JSON.stringify(meta.tags),
        meta.parentThreadId ?? null,
        meta.agentNickname ?? null,
        meta.agentRole ?? null,
        meta.mode ?? 'chat',
        meta.taskPreset ?? null,
      );
  }

  async getThread(threadId: ThreadId): Promise<ThreadMeta | null> {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE thread_id = ? AND tenant_id = ?')
      .get(threadId, this.tenantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToMeta(row);
  }

  async listThreads(filter?: {
    status?: ThreadMeta['status'];
    limit?: number;
  }): Promise<ThreadMeta[]> {
    let sql = 'SELECT * FROM threads WHERE tenant_id = ?';
    const params: unknown[] = [this.tenantId];
    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY updated_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToMeta);
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    const existing = await this.getThread(threadId);
    if (!existing) return;
    this.db
      .prepare(
        'DELETE FROM thread_spawn_edges WHERE tenant_id = ? AND (parent_thread_id = ? OR child_thread_id = ?)',
      )
      .run(this.tenantId, threadId, threadId);
    this.db.prepare('DELETE FROM turns WHERE thread_id = ?').run(threadId);
    this.db
      .prepare('DELETE FROM threads WHERE thread_id = ? AND tenant_id = ?')
      .run(threadId, this.tenantId);
    await fs.rm(this.rolloutPath(threadId), { force: true });
    if (this.tenantId === DEFAULT_TENANT_ID) {
      await fs.rm(this.legacyRolloutPath(threadId), { force: true });
    }
  }

  async updateThreadMetadata(
    threadId: ThreadId,
    patch: Partial<
      Pick<
        ThreadMeta,
        'title' | 'workspaceRoot' | 'status' | 'turnCount' | 'updatedAt' | 'tags' | 'mode' | 'taskPreset'
      >
    >,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.workspaceRoot !== undefined) {
      sets.push('workspace_root = ?');
      params.push(patch.workspaceRoot);
    }
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.turnCount !== undefined) {
      sets.push('turn_count = ?');
      params.push(patch.turnCount);
    }
    if (patch.updatedAt !== undefined) {
      sets.push('updated_at = ?');
      params.push(patch.updatedAt);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(patch.tags));
    }
    if (patch.mode !== undefined) {
      sets.push('mode = ?');
      params.push(patch.mode);
    }
    if (patch.taskPreset !== undefined) {
      sets.push('task_preset = ?');
      params.push(patch.taskPreset);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(threadId);
    params.push(this.tenantId);
    this.db
      .prepare(`UPDATE threads SET ${sets.join(', ')} WHERE thread_id = ? AND tenant_id = ?`)
      .run(...params);
  }

  async appendItems(threadId: ThreadId, items: ThreadItem[]): Promise<void> {
    // Append to JSONL rollout
    const rolloutPath = this.rolloutPath(threadId);
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    const lines = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
    await fs.appendFile(rolloutPath, lines, 'utf-8');
  }

  async getItems(
    threadId: ThreadId,
    filter?: {
      runId?: string;
      turnId?: string;
      type?: string;
      limit?: number;
      afterSequence?: number;
      beforeSequence?: number;
    },
  ): Promise<ThreadItem[]> {
    const thread = await this.getThread(threadId);
    const rolloutPath = await this.readableRolloutPath(threadId);
    let content: string;
    try {
      content = await fs.readFile(rolloutPath, 'utf-8');
    } catch {
      return [];
    }
    const lines = content.split('\n').filter((l) => l.trim());
    // P6.3: 行索引即 sequence，用于 cursor 分页 — Chinese: line index acts as sequence for cursor pagination
    const items: ThreadItem[] = [];
    for (let i = 0; i < lines.length; i++) {
      // afterSequence/beforeSequence 基于 JSONL 行索引做 cursor 分页（exclusive）
      if (filter?.afterSequence !== undefined && i <= filter.afterSequence) continue;
      if (filter?.beforeSequence !== undefined && i >= filter.beforeSequence) continue;
      try {
        const parsed = JSON.parse(lines[i]);
        // Skip control lines - they are not ThreadItems.
        if (parsed.type === '__checkpoint__' || parsed.type === '__rollback__') continue;
        // P6.3: 严格按 runId/turnId/type 过滤 — Chinese: strict run/turn/type filtering
        if (filter?.runId !== undefined && parsed.runId !== filter.runId) continue;
        if (filter?.turnId !== undefined && parsed.turnId !== filter.turnId) continue;
        if (filter?.type !== undefined && parsed.type !== filter.type) continue;
        items.push(parsed as ThreadItem);
      } catch {
        // skip malformed lines
      }
    }
    // limit 取最后 N 个，与 timeline.slice(-limit) 行为一致
    const limited = filter?.limit !== undefined ? items.slice(-filter.limit) : items;
    if (!thread) return limited;
    const activeTurnIds = new Set((await this.getTurns(threadId)).map((turn) => turn.turnId));
    return limited.filter((item) => isActiveThreadItem(item, activeTurnIds, thread.turnCount));
  }

  async getRecentItems(threadId: ThreadId, maxItems: number = 100): Promise<ThreadItem[]> {
    const all = await this.getItems(threadId);
    return all.slice(-maxItems);
  }

  async getTurns(threadId: ThreadId): Promise<TurnMeta[]> {
    const thread = await this.getThread(threadId);
    if (!thread) return [];
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY turn_index')
      .all(threadId) as Record<string, unknown>[];
    return rows.slice(0, thread.turnCount).map((r) => ({
      turnId: r.turn_id as string,
      threadId: r.thread_id as string,
      index: r.turn_index as number,
      userInput: JSON.parse(r.user_input as string),
      status: r.status as TurnMeta['status'],
      startedAt: r.started_at as string,
      completedAt: r.completed_at as string | null,
    }));
  }

  async appendCheckpoint(threadId: ThreadId, ckpt: Checkpoint): Promise<void> {
    const rolloutPath = this.rolloutPath(threadId);
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    const line =
      JSON.stringify({
        type: '__checkpoint__',
        threadId: ckpt.threadId,
        turnId: ckpt.turnId,
        itemIndex: ckpt.itemIndex,
        timestamp: ckpt.timestamp,
        generation: ckpt.generation,
        status: ckpt.status,
        expiresAt: ckpt.expiresAt,
        decisionRequest: ckpt.decisionRequest,
        executionStatus: ckpt.executionStatus,
      }) + '\n';
    await fs.appendFile(rolloutPath, line, 'utf-8');
  }

  async appendRollbackMarker(threadId: ThreadId, marker: RollbackMarker): Promise<void> {
    const rolloutPath = this.rolloutPath(threadId);
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    const line =
      JSON.stringify({
        type: '__rollback__',
        threadId,
        count: marker.count,
        remainingTurnCount: marker.remainingTurnCount,
        requestId: marker.requestId ?? null,
        timestamp: marker.createdAt ?? new Date().toISOString(),
      }) + '\n';
    await fs.appendFile(rolloutPath, line, 'utf-8');
  }

  async getLastCheckpoint(threadId: ThreadId): Promise<Checkpoint | null> {
    const rolloutPath = await this.readableRolloutPath(threadId);
    let content: string;
    try {
      content = await fs.readFile(rolloutPath, 'utf-8');
    } catch {
      return null;
    }
    const lines = content.split('\n');
    // Scan backwards for the last checkpoint line (independent of items)
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type === '__checkpoint__') {
          return {
            threadId: parsed.threadId,
            turnId: parsed.turnId,
            itemIndex: parsed.itemIndex,
            timestamp: parsed.timestamp,
            generation: parsed.generation,
            status: parsed.status,
            expiresAt: parsed.expiresAt,
            decisionRequest: parsed.decisionRequest,
            executionStatus: parsed.executionStatus,
          };
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }

  async saveTurn(turn: TurnMeta): Promise<void> {
    if (!(await this.getThread(turn.threadId))) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turns (turn_id, thread_id, turn_index, user_input, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.turnId,
        turn.threadId,
        turn.index,
        JSON.stringify(turn.userInput),
        turn.status,
        turn.startedAt,
        turn.completedAt,
      );
  }

  async deleteTurnsAfter(threadId: ThreadId, turnCount: number): Promise<void> {
    this.db
      .prepare('DELETE FROM turns WHERE thread_id = ? AND turn_index >= ?')
      .run(threadId, turnCount);
  }

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    const scopedKey = this.settingKey(key);
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(scopedKey) as
      | { value?: string }
      | undefined;
    const fallbackRow =
      !row && this.tenantId === DEFAULT_TENANT_ID && scopedKey !== key
        ? (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
            | { value?: string }
            | undefined)
        : undefined;
    const source = row ?? fallbackRow;
    if (!source?.value) return null;
    try {
      return JSON.parse(source.value) as T;
    } catch {
      return null;
    }
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(this.settingKey(key), JSON.stringify(value), new Date().toISOString());
  }

  async upsertMemoryRecord(record: MemoryRecord): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_records (
        tenant_id, id, type, text, status, scope, source_thread_id, source_turn_ids,
        workspace_root, tags, confidence, usage_count, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.tenantId,
        record.id,
        record.type,
        record.text,
        record.status,
        record.scope,
        record.sourceThreadId ?? null,
        JSON.stringify(record.sourceTurnIds),
        record.workspaceRoot ?? null,
        JSON.stringify(record.tags),
        record.confidence,
        record.usageCount,
        record.lastUsedAt ?? null,
        record.createdAt || now,
        record.updatedAt || now,
      );
  }

  async listMemoryRecords(filter: MemorySearchOptions = {}): Promise<MemoryRecord[]> {
    const params: unknown[] = [this.tenantId];
    let sql = 'SELECT * FROM memory_records WHERE tenant_id = ? AND status = ?';
    params.push('active');
    if (filter.workspaceRoot) {
      sql += ' AND (workspace_root IS NULL OR workspace_root = ?)';
      params.push(filter.workspaceRoot);
    }
    if (filter.types?.length) {
      sql += ` AND type IN (${filter.types.map(() => '?').join(', ')})`;
      params.push(...filter.types);
    }
    sql += ' ORDER BY updated_at DESC';
    if (filter.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToMemoryRecord);
  }

  async searchMemoryRecords(
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<MemoryRecord[]> {
    const filter = query.trim().toLowerCase();
    const records = await this.listMemoryRecords({ ...options, limit: undefined });
    const matched = filter
      ? records.filter((record) =>
          [record.text, record.type, record.workspaceRoot ?? '', ...record.tags]
            .join(' ')
            .toLowerCase()
            .includes(filter),
        )
      : records;
    return matched.slice(0, options.limit ?? matched.length);
  }

  async deleteMemoryRecord(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE memory_records SET status = 'deleted', updated_at = ? WHERE tenant_id = ? AND id = ?`,
      )
      .run(new Date().toISOString(), this.tenantId, id);
  }

  async recordMemoryUsage(id: string, usedAt: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE memory_records SET usage_count = usage_count + 1, last_used_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      )
      .run(usedAt, usedAt, this.tenantId, id);
  }

  async upsertEpisodeRecord(record: EpisodeRecord): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO episode_records (
        tenant_id, id, workspace_root, source_thread_id, source_turn_start, source_turn_end,
        source_turn_start_index, source_turn_end_index, lifecycle, temperature, title, objective,
        summary, facts, decisions, artifacts, open_tasks, entities, keywords, boundary_reason,
        fingerprint, topic_key, usage_count, last_activated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.tenantId,
        record.id,
        record.workspaceRoot,
        record.sourceThreadId,
        record.sourceTurnStart,
        record.sourceTurnEnd,
        record.sourceTurnStartIndex,
        record.sourceTurnEndIndex,
        record.lifecycle,
        record.temperature,
        record.title,
        record.objective,
        record.summary,
        JSON.stringify(record.facts),
        JSON.stringify(record.decisions),
        JSON.stringify(record.artifacts),
        JSON.stringify(record.openTasks),
        JSON.stringify(record.entities),
        JSON.stringify(record.keywords),
        record.boundaryReason,
        record.fingerprint,
        record.topicKey,
        record.usageCount,
        record.lastActivatedAt ?? null,
        record.createdAt || now,
        record.updatedAt || now,
      );
    const searchText = episodeSearchText(record);
    this.db.prepare('DELETE FROM episode_search WHERE episode_id = ?').run(record.id);
    this.db
      .prepare('INSERT INTO episode_search (episode_id, search_text) VALUES (?, ?)')
      .run(record.id, searchText);
  }

  async getEpisodeRecord(id: string): Promise<EpisodeRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM episode_records WHERE tenant_id = ? AND id = ?')
      .get(this.tenantId, id) as Record<string, unknown> | undefined;
    return row ? rowToEpisodeRecord(row) : null;
  }

  async listEpisodeRecords(options: EpisodeSearchOptions = {}): Promise<EpisodeRecord[]> {
    const params: unknown[] = [this.tenantId];
    let sql = 'SELECT * FROM episode_records WHERE tenant_id = ?';
    if (options.workspaceRoot) {
      sql += ' AND workspace_root = ?';
      params.push(options.workspaceRoot);
    }
    if (options.threadId) {
      sql += ' AND source_thread_id = ?';
      params.push(options.threadId);
    }
    if (options.lifecycle?.length) {
      sql += ` AND lifecycle IN (${options.lifecycle.map(() => '?').join(', ')})`;
      params.push(...options.lifecycle);
    }
    if (options.temperature?.length) {
      sql += ` AND temperature IN (${options.temperature.map(() => '?').join(', ')})`;
      params.push(...options.temperature);
    }
    if (options.excludeEpisodeIds?.length) {
      sql += ` AND id NOT IN (${options.excludeEpisodeIds.map(() => '?').join(', ')})`;
      params.push(...options.excludeEpisodeIds);
    }
    sql += ' ORDER BY updated_at DESC';
    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToEpisodeRecord);
  }

  async searchEpisodeRecords(
    query: string,
    options: EpisodeSearchOptions = {},
  ): Promise<EpisodeRecord[]> {
    const safeQuery = buildFtsMatchQuery(query);
    if (!safeQuery) {
      // The query had no searchable tokens, so return nothing rather than
      // falling back to an unbounded list of all episodes.
      return query.trim() ? [] : this.listEpisodeRecords(options);
    }
    let ids: string[];
    try {
      const ftsRows = this.db
        .prepare('SELECT episode_id FROM episode_search WHERE episode_search MATCH ? LIMIT ?')
        .all(safeQuery, options.limit ?? 200) as Array<{ episode_id: string }>;
      ids = ftsRows.map((row) => row.episode_id);
    } catch {
      // FTS syntax errors should not break retrieval; fall back to listing.
      return this.listEpisodeRecords(options);
    }
    if (ids.length === 0) return [];
    const params: unknown[] = [this.tenantId, ...ids];
    let sql = `SELECT * FROM episode_records WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(', ')})`;
    if (options.workspaceRoot) {
      sql += ' AND workspace_root = ?';
      params.push(options.workspaceRoot);
    }
    if (options.threadId) {
      sql += ' AND source_thread_id = ?';
      params.push(options.threadId);
    }
    if (options.lifecycle?.length) {
      sql += ` AND lifecycle IN (${options.lifecycle.map(() => '?').join(', ')})`;
      params.push(...options.lifecycle);
    }
    if (options.temperature?.length) {
      sql += ` AND temperature IN (${options.temperature.map(() => '?').join(', ')})`;
      params.push(...options.temperature);
    }
    if (options.excludeEpisodeIds?.length) {
      sql += ` AND id NOT IN (${options.excludeEpisodeIds.map(() => '?').join(', ')})`;
      params.push(...options.excludeEpisodeIds);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToEpisodeRecord);
  }

  async recordEpisodeUsage(id: string, usedAt: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE episode_records SET usage_count = usage_count + 1, last_activated_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      )
      .run(usedAt, usedAt, this.tenantId, id);
  }

  async saveThreadWorkingSet(snapshot: ThreadWorkingSetSnapshot): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_working_sets (
        tenant_id, thread_id, generation, active_episode_ids, injected_episode_ids,
        frozen_prompt_block, built_from_turn_id, built_from_turn_index, task_fingerprint,
        episode_identity, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.tenantId,
        snapshot.threadId,
        snapshot.generation,
        JSON.stringify(snapshot.activeEpisodeIds),
        JSON.stringify(snapshot.injectedEpisodeIds),
        snapshot.frozenPromptBlock,
        snapshot.builtFromTurnId,
        snapshot.builtFromTurnIndex,
        snapshot.taskFingerprint,
        snapshot.episodeIdentity ?? '',
        snapshot.createdAt || now,
        snapshot.updatedAt || now,
      );
  }

  async getThreadWorkingSet(threadId: ThreadId): Promise<ThreadWorkingSetSnapshot | null> {
    const row = this.db
      .prepare('SELECT * FROM thread_working_sets WHERE tenant_id = ? AND thread_id = ?')
      .get(this.tenantId, threadId) as Record<string, unknown> | undefined;
    return row ? rowToWorkingSet(row) : null;
  }

  async deleteThreadWorkingSet(threadId: ThreadId): Promise<void> {
    this.db
      .prepare('DELETE FROM thread_working_sets WHERE tenant_id = ? AND thread_id = ?')
      .run(this.tenantId, threadId);
  }

  async compactRollout(
    threadId: ThreadId,
    options: { keepLastCheckpoints?: number } = {},
  ): Promise<{
    beforeLines: number;
    afterLines: number;
    removedItems: number;
  }> {
    const rolloutPath = await this.readableRolloutPath(threadId);
    let content: string;
    try {
      content = await fs.readFile(rolloutPath, 'utf-8');
    } catch {
      return { beforeLines: 0, afterLines: 0, removedItems: 0 };
    }

    const rawLines = content.split('\n').filter((line) => line.trim());
    const checkpoints: Array<{ line: string; itemIndex: number; lineIndex: number }> = [];
    const parsedLines = rawLines.map((line, lineIndex) => {
      try {
        const parsed = JSON.parse(line) as { type?: string; itemIndex?: number };
        if (parsed.type === '__checkpoint__' && typeof parsed.itemIndex === 'number') {
          checkpoints.push({ line, itemIndex: parsed.itemIndex, lineIndex });
        }
        return parsed;
      } catch {
        return null;
      }
    });

    const latest = checkpoints.at(-1);
    if (!latest) {
      return { beforeLines: rawLines.length, afterLines: rawLines.length, removedItems: 0 };
    }

    const keepCheckpointCount = Math.max(1, Math.floor(options.keepLastCheckpoints ?? 1));
    const checkpointLines = new Set(
      checkpoints.slice(-keepCheckpointCount).map((checkpoint) => checkpoint.lineIndex),
    );
    const nextLines: string[] = [];
    let itemIndex = 0;
    let removedItems = 0;

    for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
      const parsed = parsedLines[lineIndex];
      if (parsed && parsed.type === '__checkpoint__') {
        if (checkpointLines.has(lineIndex)) nextLines.push(rawLines[lineIndex]);
        continue;
      }
      if (parsed && parsed.type === '__rollback__') {
        nextLines.push(rawLines[lineIndex]);
        continue;
      }

      const currentItemIndex = itemIndex;
      itemIndex += 1;
      if (currentItemIndex >= latest.itemIndex) {
        nextLines.push(rawLines[lineIndex]);
      } else {
        removedItems += 1;
      }
    }

    const writePath = this.rolloutPath(threadId);
    await fs.mkdir(path.dirname(writePath), { recursive: true });
    await fs.writeFile(writePath, nextLines.join('\n') + (nextLines.length ? '\n' : ''), 'utf-8');
    return { beforeLines: rawLines.length, afterLines: nextLines.length, removedItems };
  }

  async upsertThreadSpawnEdge(edge: ThreadSpawnEdge): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, tenant_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(parent_thread_id, child_thread_id)
         DO UPDATE SET tenant_id = excluded.tenant_id, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(
        edge.parentThreadId,
        edge.childThreadId,
        this.tenantId,
        edge.status,
        edge.createdAt,
        edge.updatedAt,
      );
  }

  async setThreadSpawnEdgeStatus(
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE thread_spawn_edges
         SET status = ?, updated_at = ?
         WHERE parent_thread_id = ? AND child_thread_id = ? AND tenant_id = ?`,
      )
      .run(status, new Date().toISOString(), parentThreadId, childThreadId, this.tenantId);
  }

  async listThreadSpawnChildren(
    parentThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): Promise<ThreadSpawnEdge[]> {
    let sql = 'SELECT * FROM thread_spawn_edges WHERE tenant_id = ? AND parent_thread_id = ?';
    const params: unknown[] = [this.tenantId, parentThreadId];
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToSpawnEdge);
  }

  async listThreadSpawnDescendants(
    parentThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): Promise<ThreadSpawnEdge[]> {
    const edges: ThreadSpawnEdge[] = [];
    const visit = async (threadId: ThreadId): Promise<void> => {
      const children = await this.listThreadSpawnChildren(threadId, status);
      for (const child of children) {
        edges.push(child);
        await visit(child.childThreadId);
      }
    };
    await visit(parentThreadId);
    return edges;
  }

  async createRunRecord(record: RunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_records (
        run_id, tenant_id, thread_id, turn_id, parent_run_id, workflow_id, workflow_node_id,
        kind, status, title, caller, active_step, model, error,
        input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
        tool_call_count, model_call_count, subagent_count, middleware_event_count,
        first_human_message, last_ai_message, started_at, updated_at, completed_at, metadata,
        trace_version, trace_summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        this.tenantId,
        record.threadId,
        record.turnId ?? null,
        record.parentRunId ?? null,
        record.workflowId ?? null,
        record.workflowNodeId ?? null,
        record.kind,
        record.status,
        record.title ?? null,
        record.caller,
        record.activeStep ?? null,
        record.model ?? null,
        record.error ?? null,
        record.inputTokens,
        record.cachedInputTokens,
        record.outputTokens,
        record.reasoningOutputTokens,
        record.toolCallCount,
        record.modelCallCount,
        record.subagentCount,
        record.middlewareEventCount,
        record.firstHumanMessage ?? null,
        record.lastAiMessage ?? null,
        record.startedAt,
        record.updatedAt,
        record.completedAt ?? null,
        JSON.stringify(record.metadata ?? {}),
        record.traceVersion ?? null,
        record.traceSummary === undefined ? null : JSON.stringify(record.traceSummary),
      );
  }

  async updateRunRecord(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const columns: Array<[keyof RunRecord, string, unknown]> = [
      ['threadId', 'thread_id', patch.threadId],
      ['turnId', 'turn_id', patch.turnId],
      ['parentRunId', 'parent_run_id', patch.parentRunId],
      ['workflowId', 'workflow_id', patch.workflowId],
      ['workflowNodeId', 'workflow_node_id', patch.workflowNodeId],
      ['kind', 'kind', patch.kind],
      ['status', 'status', patch.status],
      ['title', 'title', patch.title],
      ['caller', 'caller', patch.caller],
      ['activeStep', 'active_step', patch.activeStep],
      ['model', 'model', patch.model],
      ['error', 'error', patch.error],
      ['inputTokens', 'input_tokens', patch.inputTokens],
      ['cachedInputTokens', 'cached_input_tokens', patch.cachedInputTokens],
      ['outputTokens', 'output_tokens', patch.outputTokens],
      ['reasoningOutputTokens', 'reasoning_output_tokens', patch.reasoningOutputTokens],
      ['toolCallCount', 'tool_call_count', patch.toolCallCount],
      ['modelCallCount', 'model_call_count', patch.modelCallCount],
      ['subagentCount', 'subagent_count', patch.subagentCount],
      ['middlewareEventCount', 'middleware_event_count', patch.middlewareEventCount],
      ['firstHumanMessage', 'first_human_message', patch.firstHumanMessage],
      ['lastAiMessage', 'last_ai_message', patch.lastAiMessage],
      ['startedAt', 'started_at', patch.startedAt],
      ['updatedAt', 'updated_at', patch.updatedAt],
      ['completedAt', 'completed_at', patch.completedAt],
      [
        'metadata',
        'metadata',
        patch.metadata === undefined ? undefined : JSON.stringify(patch.metadata ?? {}),
      ],
      ['traceVersion', 'trace_version', patch.traceVersion],
      [
        'traceSummary',
        'trace_summary_json',
        patch.traceSummary === undefined ? undefined : JSON.stringify(patch.traceSummary),
      ],
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [, column, value] of columns) {
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (!sets.some((set) => set.startsWith('updated_at ='))) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
    }
    if (sets.length === 0) return;
    params.push(this.tenantId, runId);
    this.db
      .prepare(`UPDATE run_records SET ${sets.join(', ')} WHERE tenant_id = ? AND run_id = ?`)
      .run(...params);
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_events (
        tenant_id, run_id, event_id, thread_id, turn_id, parent_run_id, workflow_id,
        workflow_node_id, sequence, category, type, level, message, tool_name,
        model, duration_ms, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.tenantId,
        event.runId,
        event.eventId,
        event.threadId,
        event.turnId ?? null,
        event.parentRunId ?? null,
        event.workflowId ?? null,
        event.workflowNodeId ?? null,
        event.sequence,
        event.category,
        event.type,
        event.level,
        event.message,
        event.toolName ?? null,
        event.model ?? null,
        event.durationMs ?? null,
        JSON.stringify(event.metadata ?? {}),
        event.createdAt,
      );
  }

  async listRunRecords(
    filter: { threadId?: ThreadId; status?: RunStatus; limit?: number } = {},
  ): Promise<RunRecord[]> {
    const params: unknown[] = [this.tenantId];
    let sql = 'SELECT * FROM run_records WHERE tenant_id = ?';
    if (filter.threadId) {
      sql += ' AND thread_id = ?';
      params.push(filter.threadId);
    }
    if (filter.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY updated_at DESC';
    if (filter.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToRunRecord);
  }

  async getRunRecord(runId: string): Promise<RunRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM run_records WHERE tenant_id = ? AND run_id = ?')
      .get(this.tenantId, runId) as Record<string, unknown> | undefined;
    return row ? rowToRunRecord(row) : null;
  }

  async listRunEvents(
    runId: string,
    filter: {
      limit?: number;
      category?: string;
      type?: string;
      afterSequence?: number;
      beforeSequence?: number;
    } = {},
  ): Promise<RunEvent[]> {
    const params: unknown[] = [this.tenantId, runId];
    let sql = 'SELECT * FROM run_events WHERE tenant_id = ? AND run_id = ?';
    if (filter.category) {
      sql += ' AND category = ?';
      params.push(filter.category);
    }
    if (filter.type) {
      sql += ' AND type = ?';
      params.push(filter.type);
    }
    if (filter.afterSequence !== undefined) {
      sql += ' AND sequence > ?';
      params.push(filter.afterSequence);
    }
    if (filter.beforeSequence !== undefined) {
      sql += ' AND sequence < ?';
      params.push(filter.beforeSequence);
    }
    sql += ' ORDER BY sequence ASC';
    if (filter.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToRunEvent);
  }

  async appendRunTraceEvent(draft: RunTraceDraft): Promise<RunTraceEnvelope> {
    const run = await this.getRunRecord(draft.runId);
    if (!run) throw new Error('RUN_NOT_FOUND');

    const head = this.db
      .prepare('SELECT next_sequence FROM run_trace_heads WHERE tenant_id = ? AND run_id = ?')
      .get(this.tenantId, draft.runId) as { next_sequence?: number } | undefined;
    const sequence = Number(head?.next_sequence ?? 1);
    if (head) {
      this.db
        .prepare('UPDATE run_trace_heads SET next_sequence = ? WHERE tenant_id = ? AND run_id = ?')
        .run(sequence + 1, this.tenantId, draft.runId);
    } else {
      this.db
        .prepare('INSERT INTO run_trace_heads (tenant_id, run_id, next_sequence) VALUES (?, ?, ?)')
        .run(this.tenantId, draft.runId, sequence + 1);
    }

    const envelope = {
      ...draft,
      version: RUN_TRACE_VERSION,
      eventId: randomUUID(),
      sequence,
    } as RunTraceEnvelope;

    this.db
      .prepare(
        `INSERT INTO run_trace_events (
        tenant_id, run_id, sequence, event_id, thread_id, turn_id,
        category, lifecycle, occurred_at, envelope_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.tenantId,
        envelope.runId,
        envelope.sequence,
        envelope.eventId,
        envelope.threadId,
        envelope.turnId ?? null,
        envelope.category,
        envelope.lifecycle,
        envelope.occurredAt,
        JSON.stringify(envelope),
      );

    return envelope;
  }

  async getRunTraceHead(runId: string): Promise<number> {
    const run = await this.getRunRecord(runId);
    if (!run) return 0;
    const head = this.db
      .prepare('SELECT next_sequence FROM run_trace_heads WHERE tenant_id = ? AND run_id = ?')
      .get(this.tenantId, runId) as { next_sequence?: number } | undefined;
    return Math.max(0, Number(head?.next_sequence ?? 1) - 1);
  }

  async listRunTraceEvents(runId: string, query: RunTraceQuery = {}): Promise<RunTracePage> {
    if (query.before !== undefined && query.after !== undefined) {
      throw new Error('INVALID_CURSOR');
    }
    const run = await this.getRunRecord(runId);
    if (!run) return { events: [], hasMoreBefore: false, hasMoreAfter: false };

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    const filters = this.runTraceWhereClause(runId, query);
    const events = this.selectRunTraceRows(filters.sql, filters.params, query, limit).map(
      rowToRunTraceEnvelope,
    );
    const firstSequence = events[0]?.sequence;
    const lastSequence = events.at(-1)?.sequence;

    return {
      events,
      hasMoreBefore:
        firstSequence === undefined
          ? false
          : this.hasRunTraceBeyond(filters.sql, filters.params, 'before', firstSequence),
      hasMoreAfter:
        lastSequence === undefined
          ? false
          : this.hasRunTraceBeyond(filters.sql, filters.params, 'after', lastSequence),
      nextBefore: firstSequence,
      nextAfter: lastSequence,
    };
  }

  private runTraceWhereClause(
    runId: string,
    query: RunTraceQuery,
  ): { sql: string; params: unknown[] } {
    const clauses = ['tenant_id = ?', 'run_id = ?'];
    const params: unknown[] = [this.tenantId, runId];
    if (query.categories && query.categories.length > 0) {
      clauses.push(`category IN (${query.categories.map(() => '?').join(', ')})`);
      params.push(...query.categories);
    }
    if (query.errorsOnly) {
      clauses.push(`(category = ? OR json_extract(envelope_json, '$.level') = ?)`);
      params.push('error', 'error');
    }
    return { sql: clauses.join(' AND '), params };
  }

  private selectRunTraceRows(
    baseWhere: string,
    baseParams: unknown[],
    query: RunTraceQuery,
    limit: number,
  ): Record<string, unknown>[] {
    if (query.after !== undefined) {
      return this.db
        .prepare(
          `SELECT * FROM run_trace_events WHERE ${baseWhere} AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
        )
        .all(...baseParams, query.after, limit) as Record<string, unknown>[];
    }
    if (query.before !== undefined) {
      return this.db
        .prepare(
          `SELECT * FROM (
          SELECT * FROM run_trace_events WHERE ${baseWhere} AND sequence < ? ORDER BY sequence DESC LIMIT ?
        ) ORDER BY sequence ASC`,
        )
        .all(...baseParams, query.before, limit) as Record<string, unknown>[];
    }
    return this.db
      .prepare(
        `SELECT * FROM (
        SELECT * FROM run_trace_events WHERE ${baseWhere} ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence ASC`,
      )
      .all(...baseParams, limit) as Record<string, unknown>[];
  }

  private hasRunTraceBeyond(
    baseWhere: string,
    baseParams: unknown[],
    direction: 'before' | 'after',
    sequence: number,
  ): boolean {
    const operator = direction === 'before' ? '<' : '>';
    const row = this.db
      .prepare(
        `SELECT sequence FROM run_trace_events WHERE ${baseWhere} AND sequence ${operator} ? LIMIT 1`,
      )
      .get(...baseParams, sequence) as Record<string, unknown> | undefined;
    return Boolean(row);
  }

  async upsertRunFeedback(feedback: RunFeedback): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO run_feedback (tenant_id, feedback_id, run_id, thread_id, rating, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, feedback_id)
       DO UPDATE SET rating = excluded.rating, comment = excluded.comment, updated_at = excluded.updated_at`,
      )
      .run(
        this.tenantId,
        feedback.feedbackId,
        feedback.runId,
        feedback.threadId,
        feedback.rating,
        feedback.comment ?? null,
        feedback.createdAt,
        feedback.updatedAt,
      );
  }

  async listRunFeedback(runId: string): Promise<RunFeedback[]> {
    return (
      this.db
        .prepare(
          'SELECT * FROM run_feedback WHERE tenant_id = ? AND run_id = ? ORDER BY updated_at DESC',
        )
        .all(this.tenantId, runId) as Record<string, unknown>[]
    ).map(rowToRunFeedback);
  }

  private tenantRolloutDir(): string {
    return path.join(this.dataDir, 'tenants', this.tenantId, 'rollouts');
  }

  private rolloutPath(threadId: ThreadId): string {
    return path.join(this.tenantRolloutDir(), `${threadId}.jsonl`);
  }

  private legacyRolloutPath(threadId: ThreadId): string {
    return path.join(this.dataDir, 'rollouts', `${threadId}.jsonl`);
  }

  private async readableRolloutPath(threadId: ThreadId): Promise<string> {
    const current = this.rolloutPath(threadId);
    try {
      await fs.access(current);
      return current;
    } catch {
      return this.tenantId === DEFAULT_TENANT_ID ? this.legacyRolloutPath(threadId) : current;
    }
  }

  private settingKey(key: string): string {
    if (key === 'storage.schemaVersion' || key === 'auth.tokens.v1') return key;
    return `tenant:${this.tenantId}:${key}`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function rowToMeta(row: Record<string, unknown>): ThreadMeta {
  return {
    threadId: row.thread_id as string,
    tenantId: (row.tenant_id as string | null | undefined) ?? DEFAULT_TENANT_ID,
    title: row.title as string,
    workspaceRoot: row.workspace_root as string,
    status: row.status as ThreadMeta['status'],
    turnCount: row.turn_count as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | null,
    ephemeral: !!(row.ephemeral as number),
    tags: JSON.parse(row.tags as string),
    parentThreadId: (row.parent_thread_id as string | null | undefined) ?? null,
    agentNickname: (row.agent_nickname as string | null | undefined) ?? null,
    agentRole: (row.agent_role as string | null | undefined) ?? null,
    mode: (row.mode as ThreadMeta['mode'] | null | undefined) ?? 'chat',
    taskPreset: (row.task_preset as ThreadMeta['taskPreset'] | undefined) ?? null,
  };
}

function rowToSpawnEdge(row: Record<string, unknown>): ThreadSpawnEdge {
  return {
    tenantId: (row.tenant_id as string | null | undefined) ?? DEFAULT_TENANT_ID,
    parentThreadId: row.parent_thread_id as string,
    childThreadId: row.child_thread_id as string,
    status: row.status as ThreadSpawnEdgeStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToRunRecord(row: Record<string, unknown>): RunRecord {
  return {
    runId: row.run_id as string,
    tenantId: (row.tenant_id as string | null | undefined) ?? DEFAULT_TENANT_ID,
    threadId: row.thread_id as string,
    turnId: (row.turn_id as string | null | undefined) ?? null,
    parentRunId: (row.parent_run_id as string | null | undefined) ?? null,
    workflowId: (row.workflow_id as string | null | undefined) ?? null,
    workflowNodeId: (row.workflow_node_id as string | null | undefined) ?? null,
    kind: row.kind as RunKind,
    status: row.status as RunStatus,
    title: (row.title as string | null | undefined) ?? null,
    caller: row.caller as RunCaller,
    activeStep: (row.active_step as string | null | undefined) ?? null,
    model: (row.model as string | null | undefined) ?? null,
    error: (row.error as string | null | undefined) ?? null,
    inputTokens: Number(row.input_tokens ?? 0),
    cachedInputTokens: Number(row.cached_input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    reasoningOutputTokens: Number(row.reasoning_output_tokens ?? 0),
    toolCallCount: Number(row.tool_call_count ?? 0),
    modelCallCount: Number(row.model_call_count ?? 0),
    subagentCount: Number(row.subagent_count ?? 0),
    middlewareEventCount: Number(row.middleware_event_count ?? 0),
    firstHumanMessage: (row.first_human_message as string | null | undefined) ?? null,
    lastAiMessage: (row.last_ai_message as string | null | undefined) ?? null,
    startedAt: row.started_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string | null | undefined) ?? null,
    metadata: parseJsonRecord(row.metadata),
    traceVersion: row.trace_version == null ? null : (Number(row.trace_version) as 2),
    traceSummary: parseNullableJsonRecord(row.trace_summary_json) as RunTraceSummary | null,
  };
}

function rowToRunEvent(row: Record<string, unknown>): RunEvent {
  return {
    tenantId: (row.tenant_id as string | null | undefined) ?? DEFAULT_TENANT_ID,
    runId: row.run_id as string,
    eventId: row.event_id as string,
    threadId: row.thread_id as string,
    turnId: (row.turn_id as string | null | undefined) ?? null,
    parentRunId: (row.parent_run_id as string | null | undefined) ?? null,
    workflowId: (row.workflow_id as string | null | undefined) ?? null,
    workflowNodeId: (row.workflow_node_id as string | null | undefined) ?? null,
    sequence: Number(row.sequence ?? 0),
    category: row.category as RunEvent['category'],
    type: row.type as string,
    level: row.level as RunEventLevel,
    message: row.message as string,
    toolName: (row.tool_name as string | null | undefined) ?? null,
    model: (row.model as string | null | undefined) ?? null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    metadata: parseJsonRecord(row.metadata),
    createdAt: row.created_at as string,
  };
}

function rowToRunTraceEnvelope(row: Record<string, unknown>): RunTraceEnvelope {
  const parsed = JSON.parse(String(row.envelope_json ?? '{}')) as RunTraceEnvelope;
  return parsed;
}

function rowToRunFeedback(row: Record<string, unknown>): RunFeedback {
  return {
    tenantId: (row.tenant_id as string | null | undefined) ?? DEFAULT_TENANT_ID,
    feedbackId: row.feedback_id as string,
    runId: row.run_id as string,
    threadId: row.thread_id as string,
    rating: Number(row.rating ?? 0) as RunFeedback['rating'],
    comment: (row.comment as string | null | undefined) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToMemoryRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    tenantId: (row.tenant_id as string | null | undefined) ?? DEFAULT_TENANT_ID,
    id: String(row.id),
    type: row.type as MemoryRecord['type'],
    text: String(row.text ?? ''),
    status: row.status as MemoryRecord['status'],
    scope: row.scope as MemoryRecord['scope'],
    sourceThreadId: (row.source_thread_id as string | null | undefined) ?? undefined,
    sourceTurnIds: parseJsonArray(row.source_turn_ids),
    workspaceRoot: (row.workspace_root as string | null | undefined) ?? undefined,
    tags: parseJsonArray(row.tags),
    confidence: Number(row.confidence ?? 0),
    usageCount: Number(row.usage_count ?? 0),
    lastUsedAt: (row.last_used_at as string | null | undefined) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function sanitizeFtsInput(text: string): string[] {
  const terms = new Set<string>();
  // Extract path-like strings and colon-pairs; add segments and the basename.
  const pathPattern = /([a-zA-Z]:[\\/][^\s]+)|(\/[^\s]+)|([a-zA-Z0-9_]+:[a-zA-Z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(text)) !== null) {
    const rawPath = match[0];
    const isColonPair = /^[a-zA-Z0-9_]+:[a-zA-Z0-9_]+$/.test(rawPath);
    for (const segment of rawPath
      .split(/[\\/.:]/)
      .filter((s) => s.length >= (isColonPair ? 1 : 2))) {
      terms.add(segment.toLowerCase());
    }
    if (!isColonPair) {
      const basename = rawPath.split(/[\\/]/).pop() ?? '';
      if (basename.length >= 2) terms.add(basename.toLowerCase());
    }
  }

  const withoutPaths = text.replace(pathPattern, ' ');
  const ascii = withoutPaths.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
  for (const token of ascii) terms.add(token);
  const cjk = (withoutPaths.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((seg) => {
    const out = [seg];
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    return out;
  });
  for (const token of cjk) terms.add(token);

  return [...terms];
}

function buildFtsMatchQuery(query: string): string {
  const terms = sanitizeFtsInput(query);
  if (terms.length === 0) return '';
  return terms.map((term) => `"${term}"`).join(' OR ');
}

function episodeSearchText(record: EpisodeRecord): string {
  const raw = [
    record.title,
    record.objective,
    record.summary,
    ...record.facts,
    ...record.decisions,
    ...record.artifacts,
    ...record.openTasks,
    ...record.entities,
    ...record.keywords,
  ]
    .filter(Boolean)
    .join(' ');
  return sanitizeFtsInput(raw).join(' ');
}

function rowToEpisodeRecord(row: Record<string, unknown>): EpisodeRecord {
  return {
    tenantId: (row.tenant_id as string | null | undefined) ?? DEFAULT_TENANT_ID,
    id: String(row.id),
    workspaceRoot: String(row.workspace_root ?? ''),
    sourceThreadId: String(row.source_thread_id),
    sourceTurnStart: String(row.source_turn_start),
    sourceTurnEnd: String(row.source_turn_end),
    sourceTurnStartIndex: Number(row.source_turn_start_index ?? 0),
    sourceTurnEndIndex: Number(row.source_turn_end_index ?? 0),
    lifecycle: row.lifecycle as EpisodeRecord['lifecycle'],
    temperature: row.temperature as EpisodeRecord['temperature'],
    title: String(row.title ?? ''),
    objective: String(row.objective ?? ''),
    summary: String(row.summary ?? ''),
    facts: parseJsonArray(row.facts),
    decisions: parseJsonArray(row.decisions),
    artifacts: parseJsonArray(row.artifacts),
    openTasks: parseJsonArray(row.open_tasks),
    entities: parseJsonArray(row.entities),
    keywords: parseJsonArray(row.keywords),
    boundaryReason: String(row.boundary_reason ?? ''),
    fingerprint: String(row.fingerprint ?? ''),
    topicKey: String(row.topic_key ?? ''),
    usageCount: Number(row.usage_count ?? 0),
    lastActivatedAt: (row.last_activated_at as string | null | undefined) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToWorkingSet(row: Record<string, unknown>): ThreadWorkingSetSnapshot {
  return {
    threadId: String(row.thread_id),
    generation: Number(row.generation ?? 0),
    activeEpisodeIds: parseJsonArray(row.active_episode_ids),
    injectedEpisodeIds: parseJsonArray(row.injected_episode_ids),
    frozenPromptBlock: String(row.frozen_prompt_block ?? ''),
    builtFromTurnId: String(row.built_from_turn_id),
    builtFromTurnIndex: Number(row.built_from_turn_index ?? 0),
    taskFingerprint: String(row.task_fingerprint ?? ''),
    episodeIdentity: String(row.episode_identity ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseNullableJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || value === '') return null;
  const parsed = parseJsonRecord(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function isActiveThreadItem(
  item: ThreadItem,
  activeTurnIds: Set<string>,
  activeTurnCount: number,
): boolean {
  const checkpoint = item as ThreadItem & { turnCount?: unknown };
  if (
    (item.type === 'workflow_checkpoint' ||
      item.type === 'project_checkpoint' ||
      item.type === 'rollback_conflict') &&
    typeof checkpoint.turnCount === 'number'
  ) {
    return checkpoint.turnCount <= activeTurnCount;
  }
  return typeof item.turnId === 'string' && activeTurnIds.has(item.turnId);
}
