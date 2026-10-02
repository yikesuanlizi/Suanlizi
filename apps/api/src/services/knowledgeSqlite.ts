import type { KnowledgeSqlitePort } from '@suanlizi/storage';

const SCHEMA_VERSION = 2;

interface SqliteSnapshotLike {
  chunks?: Array<{
    chunkId: string;
    snapshotId: string;
    workspaceId: string;
    relativePath: string;
    text: string;
  }>;
}

interface SqliteCatalogLike {
  snapshots?: Record<string, SqliteSnapshotLike>;
}

type IndexWriteOptions = {
  /** A receipt write does not change indexed chunks. */
  rebuildIndex?: boolean;
  /** A sync appends only the immutable chunks in this snapshot. */
  appendSnapshotId?: string;
  /** Snapshot retention may remove unreferenced immutable history. */
  removeSnapshotIds?: string[];
};

/** Create the Wiki catalog and FTS5 index inside Suanlizi' existing SQLite file. */
export function ensureKnowledgeSqliteSchema(db: KnowledgeSqlitePort): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_catalogs (
      tenant_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_schema (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      tenant_id UNINDEXED,
      snapshot_id UNINDEXED,
      chunk_id UNINDEXED,
      workspace_id UNINDEXED,
      relative_path,
      text
    );
  `);
  db.run(
    'INSERT OR REPLACE INTO knowledge_schema (version, applied_at) VALUES (?, ?)',
    [SCHEMA_VERSION, new Date().toISOString()],
  );
}

export function readKnowledgeCatalog<T>(db: KnowledgeSqlitePort, tenantId: string): T | null {
  ensureKnowledgeSqliteSchema(db);
  const row = db.get<{ state_json?: string }>(
    'SELECT state_json FROM knowledge_catalogs WHERE tenant_id = ?',
    [tenantId],
  );
  if (!row?.state_json) return null;
  try {
    return JSON.parse(row.state_json) as T;
  } catch {
    return null;
  }
}

export function writeKnowledgeCatalog<T>(db: KnowledgeSqlitePort, tenantId: string, state: T, options: IndexWriteOptions = { rebuildIndex: false }): void {
  ensureKnowledgeSqliteSchema(db);
  const catalog = state as SqliteCatalogLike;
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.run(
      `INSERT INTO knowledge_catalogs (tenant_id, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      [tenantId, JSON.stringify(state), now],
    );
    for (const snapshotId of options.removeSnapshotIds ?? []) {
      db.run('DELETE FROM knowledge_chunks_fts WHERE tenant_id = ? AND snapshot_id = ?', [tenantId, snapshotId]);
    }
    if (options.appendSnapshotId) {
      // Snapshot ids and chunk ids are immutable. Replacing just this id makes
      // a retried sync idempotent without rebuilding unrelated snapshots.
      db.run('DELETE FROM knowledge_chunks_fts WHERE tenant_id = ? AND snapshot_id = ?', [tenantId, options.appendSnapshotId]);
      const snapshot = catalog.snapshots?.[options.appendSnapshotId];
      for (const chunk of snapshot?.chunks ?? []) {
        db.run(
          `INSERT INTO knowledge_chunks_fts
           (tenant_id, snapshot_id, chunk_id, workspace_id, relative_path, text)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [tenantId, chunk.snapshotId, chunk.chunkId, chunk.workspaceId ?? '', chunk.relativePath, chunk.text],
        );
      }
    } else if (options.rebuildIndex !== false) {
      db.run('DELETE FROM knowledge_chunks_fts WHERE tenant_id = ?', [tenantId]);
      for (const snapshot of Object.values(catalog.snapshots ?? {})) {
        for (const chunk of snapshot.chunks ?? []) {
          db.run(
            `INSERT INTO knowledge_chunks_fts
             (tenant_id, snapshot_id, chunk_id, workspace_id, relative_path, text)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [tenantId, chunk.snapshotId, chunk.chunkId, chunk.workspaceId ?? '', chunk.relativePath, chunk.text],
          );
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Return FTS candidates for a normalized query. `null` means the SQLite
 * index could not be used and callers should fall back to the in-memory scan.
 */
export function searchKnowledgeChunkIds(
  db: KnowledgeSqlitePort,
  tenantId: string,
  terms: readonly string[],
): string[] | null {
  if (terms.length === 0) return [];
  ensureKnowledgeSqliteSchema(db);
  const match = terms
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ');
  try {
    const rows = db.all<{ chunk_id: string }>(
      `SELECT chunk_id FROM knowledge_chunks_fts
       WHERE tenant_id = ? AND knowledge_chunks_fts MATCH ?`,
      [tenantId, match],
    );
    return rows.map((row) => row.chunk_id).filter(Boolean);
  } catch {
    return null;
  }
}
