import * as path from 'node:path';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { DEFAULT_TENANT_ID, LocalThreadStore, safeTenantId } from './store.js';
import type { ThreadStore } from './store.js';
import { SqliteTaskStore } from './taskStore.js';
export type { RunTraceQuery, RunTraceStore } from './runTraceStore.js';

export { DEFAULT_TENANT_ID, LocalThreadStore, safeTenantId };
export type {
  RunCaller,
  RunEvent,
  RunEventLevel,
  RunFeedback,
  RunKind,
  RunRecord,
  RunStatus,
  ThreadStore,
  KnowledgeSqlitePort,
} from './store.js';

// Goal-task workflow store (plan §6.2 / §11.2 / §14.6). SqliteTaskStore implements the
// @suanlizi/protocol TaskStorePort contract; ensureTaskStoreSchema is the idempotent migration.
export {
  SqliteTaskStore,
  ensureTaskStoreSchema,
  TASK_STORE_MIGRATION_VERSION,
  TASK_STORE_MIGRATION_NAME,
} from './taskStore.js';
export type { SqliteTaskStoreOptions } from './taskStore.js';

export type StorageBackend = 'sqlite';

export interface StorageOptions {
  backend: StorageBackend;
}

/**
 * Create a LocalThreadStore backed by SQLite + JSONL in `dataDir`.
 *
 * Callers should inject a real better-sqlite3 Database instance:
 *   import Database from 'better-sqlite3';
 *   const db = new Database(path.join(dataDir, 'threads.db'));
 *   db.pragma('journal_mode = WAL');
 *   const store = new LocalThreadStore(db as any, dataDir);
 *
 * For testing, `createStore` returns a stub when no dbFactory is given.
 */
// 以 SQLite + JSONL 为后端，在 dataDir 目录下创建 LocalThreadStore
// 调用方应注入真实的 better-sqlite3 Database 实例（见上方示例）
// 测试场景：不传 dbFactory 时 createStore 返回内存 stub 版本
export function createStore(
  dataDir: string,
  db?: unknown,
  _env: Record<string, string | undefined> = process.env,
): { store: ThreadStore; db: unknown; taskStore: SqliteTaskStore } {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!db) {
    try {
      const Database = loadBetterSqlite();
      db = new Database(path.join(dataDir, 'threads.db'));
      (db as { pragma(sql: string): void }).pragma('journal_mode = WAL');
      console.log('[storage] Using SQLite backend');
    } catch {
      console.warn(
        '[storage] better-sqlite3 unavailable, falling back to JSON file backend.\n' +
          '  Install better-sqlite3 for better concurrent-write safety:\n' +
          '  npm install --workspace @suanlizi/storage better-sqlite3',
      );
      db = createFileBackedDb(dataDir);
    }
  }
  const store = new LocalThreadStore(db as never, dataDir);
  // 同一 db 句柄上的目标任务存储（计划 §6.2）：复用 ThreadStore 的 checkpoint 读取入口。
  const taskStore = new SqliteTaskStore(db as never, { threadStore: store });
  return { store, db, taskStore };
}

export function resolveStorageOptions(
  _env: Record<string, string | undefined> = process.env,
): StorageOptions {
  return { backend: 'sqlite' };
}

function loadBetterSqlite(): new (filename: string) => unknown {
  const require = createRequire(__filename);
  const mod = require('better-sqlite3') as
    | { default?: new (filename: string) => unknown }
    | (new (filename: string) => unknown);
  return typeof mod === 'function' ? mod : mod.default!;
}

interface BackendStore {
  threads: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
  settings: Array<Record<string, unknown>>;
  thread_spawn_edges: Array<Record<string, unknown>>;
}

interface DbLike {
  prepare(sql: string): {
    run(...params: unknown[]): void;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

interface RolloutCheckpoint {
  type: '__checkpoint__';
  threadId?: string;
  turnId?: string;
  itemIndex?: number;
  timestamp?: string;
}

function makeRecoveredTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 40) return normalized || 'Recovered thread';
  return `${normalized.slice(0, 40)}...`;
}

function earliestIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function latestIso(left: string, right: string): string {
  return left >= right ? left : right;
}

/**
 * Create an in-process DB backed by a JSON file in `dataDir/threads.json`.
 * Persists synchronously on every mutation (write-through).
 * Not safe for concurrent processes, but survives restarts.
 */
// 进程内数据库：以 `dataDir/threads.json` 为存储
// 每次变更都同步写盘（直写），进程重启后可恢复；但不支持多进程并发写
function createFileBackedDb(dataDir: string) {
  const filePath = path.join(dataDir, 'threads.json');

  // 加载已有数据，或从零开始；英文说明：Load existing data or start fresh
  let store: BackendStore;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as BackendStore;
    store = {
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      turns: Array.isArray(parsed.turns) ? parsed.turns : [],
      settings: Array.isArray(parsed.settings) ? parsed.settings : [],
      thread_spawn_edges: Array.isArray(parsed.thread_spawn_edges) ? parsed.thread_spawn_edges : [],
    };
    console.log(
      `[storage] Loaded ${store.threads.length} thread(s), ${store.turns.length} turn(s) from ${filePath}`,
    );
  } catch {
    store = { threads: [], turns: [], settings: [], thread_spawn_edges: [] };
  }

  // 线程 ID 快速索引；英文说明：Thread lookup by ID for fast access
  const threadById = new Map<string, Record<string, unknown>>();
  for (const row of store.threads) {
    threadById.set(String(row.thread_id), row);
  }
  const settingsByKey = new Map<string, Record<string, unknown>>();
  for (const row of store.settings) {
    settingsByKey.set(String(row.key), row);
  }
  const edgeKey = (parentThreadId: unknown, childThreadId: unknown) =>
    `${String(parentThreadId)}\n${String(childThreadId)}`;
  const edgeByKey = new Map<string, Record<string, unknown>>();
  for (const row of store.thread_spawn_edges) {
    edgeByKey.set(edgeKey(row.parent_thread_id, row.child_thread_id), row);
  }

  function persist(): void {
    store.threads = [...threadById.values()];
    store.settings = [...settingsByKey.values()];
    store.thread_spawn_edges = [...edgeByKey.values()];
    try {
      fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
    } catch (err) {
      console.error('[storage] Failed to persist threads.json:', err);
    }
  }

  return {
    exec(_sql: string) {},
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      return {
        run(...params: unknown[]) {
          if (normalized.startsWith('INSERT INTO threads')) {
            const row: Record<string, unknown> = {
              thread_id: params[0],
              tenant_id: normalized.includes('tenant_id') ? params[1] : 'default',
              title: normalized.includes('tenant_id') ? params[2] : params[1],
              workspace_root: normalized.includes('tenant_id') ? params[3] : params[2],
              status: normalized.includes('tenant_id') ? params[4] : params[3],
              turn_count: normalized.includes('tenant_id') ? params[5] : params[4],
              created_at: normalized.includes('tenant_id') ? params[6] : params[5],
              updated_at: normalized.includes('tenant_id') ? params[7] : params[6],
              archived_at: normalized.includes('tenant_id') ? params[8] : params[7],
              ephemeral: normalized.includes('tenant_id') ? params[9] : params[8],
              tags: normalized.includes('tenant_id') ? params[10] : params[9],
              parent_thread_id:
                (normalized.includes('tenant_id') ? params[11] : params[10]) ?? null,
              agent_nickname: (normalized.includes('tenant_id') ? params[12] : params[11]) ?? null,
              agent_role: (normalized.includes('tenant_id') ? params[13] : params[12]) ?? null,
              mode: (normalized.includes('tenant_id') ? params[14] : params[13]) ?? 'chat',
              task_preset: (normalized.includes('tenant_id') ? params[15] : params[14]) ?? null,
            };
            threadById.set(String(params[0]), row);
            persist();
            return;
          }

          if (normalized.startsWith('UPDATE threads SET')) {
            const hasTenantFilter = normalized.includes('AND tenant_id = ?');
            const threadId = String(params[params.length - (hasTenantFilter ? 2 : 1)]);
            const tenantId = hasTenantFilter ? String(params[params.length - 1]) : null;
            const row = threadById.get(threadId);
            if (tenantId && row?.tenant_id !== tenantId) return;
            if (!row) return;
            const setClause = normalized.slice(
              'UPDATE threads SET '.length,
              normalized.indexOf(' WHERE thread_id'),
            );
            const columns = setClause.split(',').map((part) => part.trim().split(' = ')[0]);
            for (let i = 0; i < columns.length; i++) {
              row[columns[i]] = params[i];
            }
            persist();
            return;
          }

          if (normalized.startsWith('INSERT OR REPLACE INTO turns')) {
            const row: Record<string, unknown> = {
              turn_id: params[0],
              thread_id: params[1],
              turn_index: params[2],
              user_input: params[3],
              status: params[4],
              started_at: params[5],
              completed_at: params[6],
            };
            // replace or append
            const idx = store.turns.findIndex((t) => String(t.turn_id) === String(params[0]));
            if (idx >= 0) {
              store.turns[idx] = row;
            } else {
              store.turns.push(row);
            }
            persist();
            return;
          }

          if (normalized.startsWith('DELETE FROM turns WHERE thread_id = ?')) {
            store.turns = store.turns.filter((row) => row.thread_id !== params[0]);
            persist();
            return;
          }

          if (
            normalized.startsWith(
              'DELETE FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?',
            )
          ) {
            const parent = String(params[0]);
            const child = String(params[1]);
            for (const [key, row] of edgeByKey) {
              if (
                String(row.parent_thread_id) === parent ||
                String(row.child_thread_id) === child
              ) {
                edgeByKey.delete(key);
              }
            }
            persist();
            return;
          }

          if (
            normalized.startsWith(
              'DELETE FROM thread_spawn_edges WHERE tenant_id = ? AND (parent_thread_id = ? OR child_thread_id = ?)',
            )
          ) {
            const tenantId = String(params[0]);
            const parent = String(params[1]);
            const child = String(params[2]);
            for (const [key, row] of edgeByKey) {
              if (
                String(row.tenant_id) === tenantId &&
                (String(row.parent_thread_id) === parent || String(row.child_thread_id) === child)
              ) {
                edgeByKey.delete(key);
              }
            }
            persist();
            return;
          }

          if (normalized.startsWith('DELETE FROM threads WHERE thread_id = ?')) {
            const tid = String(params[0]);
            const tenantId = normalized.includes('AND tenant_id = ?') ? String(params[1]) : null;
            const row = threadById.get(tid);
            if (!tenantId || row?.tenant_id === tenantId) threadById.delete(tid);
            store.turns = store.turns.filter((row) => row.thread_id !== tid);
            persist();
            return;
          }

          if (normalized.startsWith('INSERT OR REPLACE INTO settings')) {
            const row: Record<string, unknown> = {
              key: params[0],
              value: params[1],
              updated_at: params[2],
            };
            settingsByKey.set(String(params[0]), row);
            persist();
            return;
          }

          if (normalized.startsWith('INSERT INTO thread_spawn_edges')) {
            const row: Record<string, unknown> = {
              parent_thread_id: params[0],
              child_thread_id: params[1],
              tenant_id: normalized.includes('tenant_id') ? params[2] : 'default',
              status: normalized.includes('tenant_id') ? params[3] : params[2],
              created_at: normalized.includes('tenant_id') ? params[4] : params[3],
              updated_at: normalized.includes('tenant_id') ? params[5] : params[4],
            };
            edgeByKey.set(edgeKey(params[0], params[1]), row);
            persist();
            return;
          }

          if (normalized.startsWith('UPDATE thread_spawn_edges SET status = ?')) {
            const hasTenantFilter = normalized.includes('AND tenant_id = ?');
            const key = edgeKey(params[2], params[3]);
            const row = edgeByKey.get(key);
            if (hasTenantFilter && row?.tenant_id !== params[4]) return;
            if (!row) return;
            row.status = params[0];
            row.updated_at = params[1];
            persist();
          }
        },
        get(...params: unknown[]) {
          if (normalized.startsWith('SELECT * FROM threads WHERE thread_id = ?')) {
            const row = threadById.get(String(params[0]));
            if (normalized.includes('AND tenant_id = ?') && row?.tenant_id !== params[1])
              return undefined;
            return row;
          }
          if (normalized.startsWith('SELECT value FROM settings WHERE key = ?')) {
            return settingsByKey.get(String(params[0]));
          }
          return undefined;
        },
        all(...params: unknown[]) {
          if (normalized.startsWith('PRAGMA table_info(threads)')) {
            return [
              'thread_id',
              'tenant_id',
              'title',
              'workspace_root',
              'status',
              'turn_count',
              'created_at',
              'updated_at',
              'archived_at',
              'ephemeral',
              'tags',
              'parent_thread_id',
              'agent_nickname',
              'agent_role',
            ].map((name) => ({ name }));
          }

          if (normalized.startsWith('SELECT * FROM turns WHERE thread_id = ?')) {
            return store.turns
              .filter((row) => row.thread_id === params[0])
              .sort((a, b) => Number(a.turn_index) - Number(b.turn_index));
          }

          if (normalized.startsWith('SELECT * FROM threads')) {
            let rows = [...threadById.values()];
            if (normalized.includes('WHERE tenant_id = ?')) {
              rows = rows.filter((row) => row.tenant_id === params[0]);
              if (normalized.includes('AND status = ?')) {
                rows = rows.filter((row) => row.status === params[1]);
              }
            } else if (normalized.includes('WHERE status = ?')) {
              rows = rows.filter((row) => row.status === params[0]);
            }
            rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
            if (normalized.includes('LIMIT ?')) {
              const limit = Number(params[params.length - 1]);
              rows = rows.slice(0, limit);
            }
            return rows;
          }

          if (
            normalized.startsWith(
              'SELECT * FROM thread_spawn_edges WHERE tenant_id = ? AND parent_thread_id = ?',
            )
          ) {
            let rows = [...edgeByKey.values()].filter(
              (row) => row.tenant_id === params[0] && row.parent_thread_id === params[1],
            );
            if (normalized.includes('AND status = ?')) {
              rows = rows.filter((row) => row.status === params[2]);
            }
            rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
            return rows;
          }

          if (
            normalized.startsWith('SELECT * FROM thread_spawn_edges WHERE parent_thread_id = ?')
          ) {
            let rows = [...edgeByKey.values()].filter((row) => row.parent_thread_id === params[0]);
            if (normalized.includes('AND status = ?')) {
              rows = rows.filter((row) => row.status === params[1]);
            }
            rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
            return rows;
          }

          return [];
        },
      };
    },
  };
}

export const STORAGE_VERSION = '0.1.0';
