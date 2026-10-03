import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ThreadStore } from '@suanlizi/storage';
import {
  buildWikiLinkGraph,
  parseWikiPage,
  searchWikiPages,
  tokenizeWikiQuery,
  type WikiLinkGraph,
  type WikiPageRecord,
} from '@suanlizi/wiki-core';
import {
  ensureKnowledgeSqliteSchema,
  readKnowledgeCatalog,
  searchKnowledgeChunkIds,
  writeKnowledgeCatalog,
} from './knowledgeSqlite.js';
import { SecretRedactor } from '@suanlizi/runtime';
import { DOCUMENT_EXTRACTOR_VERSION, extractDocumentText } from '@suanlizi/tools';
import type { KnowledgeCompileJob } from './knowledgeCompileJob.js';

const STATE_KEY = 'knowledge.catalog.v1';
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BINARY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const CHUNK_SIZE = 2400;
const SNAPSHOT_RETENTION = 8;
const PERSONAL_CATALOG_KEY = 'personal';
const secretRedactor = new SecretRedactor({ detectorVersion: 'suanlizi-secret-redactor-v1' });

const catalogLocks = new Map<string, Promise<void>>();

export async function withCatalogLock<T>(store: ThreadStore, work: () => Promise<T>): Promise<T> {
  const key = `${store.knowledgeSqlite ? 'sqlite' : 'settings'}:${PERSONAL_CATALOG_KEY}`;
  const previous = catalogLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  catalogLocks.set(key, next);
  return previous.then(work).finally(() => {
    release();
    if (catalogLocks.get(key) === next) catalogLocks.delete(key);
  });
}
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js',
  '.json', '.jsx', '.log', '.md', '.mdx', '.mjs', '.py', '.rs', '.scss', '.sql', '.svg',
  '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.csv',
]);
const DOCUMENT_EXTENSIONS = new Set(['.docx', '.pdf', '.xlsx', '.pptx']);

export interface KnowledgeChunkRecord {
  chunkId: string;
  snapshotId: string;
  documentId: string;
  relativePath: string;
  ordinal: number;
  text: string;
  contentHash: string;
  tokenCount: number;
  heading?: string;
  sourceKind?: 'workspace_doc' | 'wiki_page';
  evidenceRole?: 'normative' | 'reference' | 'historical';
}

export interface KnowledgeSourceRecord {
  sourceId: string;
  relativePath: string;
  kind: 'workspace_doc' | 'wiki_page';
  role: 'normative' | 'reference' | 'historical';
  contentHash: string;
  sizeBytes: number;
  sourceUpdatedAt: string;
  recordUpdatedAt: string;
  redactionVersion?: string;
  extractor?: string;
  extractorVersion?: string;
}

export interface KnowledgeDocumentRecord {
  documentId: string;
  sourceId: string;
  relativePath: string;
  revision: string;
  title: string;
  contentHash: string;
  parserVersion: string;
  sourceKind: 'workspace_doc' | 'wiki_page';
  evidenceRole: 'normative' | 'reference' | 'historical';
  extractor?: string;
  extractorVersion?: string;
}

export interface KnowledgeWikiPageRecord {
  pageId: string;
  slug: string;
  title: string;
  relativePath: string;
  documentId: string;
  sourceId: string;
  contentHash: string;
  evidenceRole: 'normative' | 'reference' | 'historical';
  generated: false;
  pageDirectory: WikiPageRecord['pageDirectory'];
  summary: string;
  tags: string[];
  links: string[];
  linkTargets: Array<{ slug: string; display: string }>;
  aliases: string[];
  orphaned: boolean;
  archived: boolean;
  hasFrontmatterBlock: boolean;
  malformedFrontmatter: boolean;
}

export interface KnowledgeSnapshotRecord {
  snapshotId: string;
  knowledgeBaseId: string;
  status: 'building' | 'ready' | 'failed';
  immutable: true;
  contentHash: string;
  indexVersion: string;
  redactionVersion?: string;
  createdAt: string;
  completedAt?: string;
  sources: KnowledgeSourceRecord[];
  documents: KnowledgeDocumentRecord[];
  pages: KnowledgeWikiPageRecord[];
  graph: WikiLinkGraph;
  chunks: KnowledgeChunkRecord[];
  indexStats?: {
    indexedFiles: number;
    indexedBytes: number;
    skippedFiles: number;
    skippedBytes: number;
    truncated: boolean;
    skippedReasons: Array<{ path: string; reason: string; bytes?: number }>;
    redactionFailed: number;
  };
}

export interface KnowledgeBaseRecord {
  knowledgeBaseId: string;
  name: string;
  status: 'active' | 'syncing' | 'blocked' | 'deleted';
  currentSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  source?: { kind: 'directory'; grantId?: string; canonicalPath: string; authorizedAt: string };
}

/**
 * A directory grant is created by the native picker. Public HTTP callers pass
 * this opaque id when creating a base; they never submit an arbitrary path.
 */
export interface KnowledgeSourceGrant {
  grantId: string;
  kind: 'directory';
  canonicalPath: string;
  authorizedAt: string;
  revokedAt?: string;
}

export interface KnowledgeQueryReceipt {
  receiptId: string;
  knowledgeBaseIds: string[];
  snapshotIds: string[];
  normalizedQueryHash: string;
  queryVersion: string;
  indexVersion: string;
  orderedHits: Array<{ chunkId: string; rank: number; score: number }>;
  truncated: boolean;
  truncationReasons: string[];
  maxHits: number;
  createdAt: string;
}

export interface CatalogState {
  bases: Record<string, KnowledgeBaseRecord>;
  snapshots: Record<string, KnowledgeSnapshotRecord>;
  receipts: Record<string, KnowledgeQueryReceipt>;
  grants: Record<string, KnowledgeSourceGrant>;
  jobs: Record<string, KnowledgeCompileJob>;
}

function tenantKey(): string {
  return PERSONAL_CATALOG_KEY;
}

function emptyState(): CatalogState {
  return { bases: {}, snapshots: {}, receipts: {}, grants: {}, jobs: {} };
}

export async function loadState(store: ThreadStore): Promise<CatalogState> {
  const sqlite = store.knowledgeSqlite;
  if (sqlite) {
    ensureKnowledgeSqliteSchema(sqlite);
    const stored = readKnowledgeCatalog<CatalogState>(sqlite, tenantKey());
    if (stored) return normalizeState(stored);
  }
  const raw = await store.getSetting<Partial<CatalogState>>(`${STATE_KEY}:${tenantKey()}`);
  if (!raw || typeof raw !== 'object') return emptyState();
  return normalizeState({
    bases: raw.bases && typeof raw.bases === 'object' ? raw.bases as Record<string, KnowledgeBaseRecord> : {},
    snapshots: raw.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots as Record<string, KnowledgeSnapshotRecord> : {},
    receipts: raw.receipts && typeof raw.receipts === 'object' ? raw.receipts as Record<string, KnowledgeQueryReceipt> : {},
    grants: raw.grants && typeof raw.grants === 'object' ? raw.grants as Record<string, KnowledgeSourceGrant> : {},
    jobs: raw.jobs && typeof raw.jobs === 'object' ? raw.jobs as Record<string, KnowledgeCompileJob> : {},
  });
}

function normalizeState(state: CatalogState): CatalogState {
  return {
    bases: Object.fromEntries(Object.entries(state.bases ?? {}).map(([id, base]) => [id, {
      ...base,
      source: base.source,
    }])),
    snapshots: Object.fromEntries(
      Object.entries(state.snapshots ?? {}).map(([id, snapshot]) => [id, {
        ...snapshot,
        sources: snapshot.sources ?? [],
        documents: snapshot.documents ?? [],
        pages: (snapshot.pages ?? []).map((page) => ({
          ...page,
          pageDirectory: page.pageDirectory ?? 'other',
          summary: page.summary ?? '',
          tags: page.tags ?? [],
          links: page.links ?? [],
          linkTargets: page.linkTargets ?? page.links?.map((slug) => ({ slug, display: slug })) ?? [],
          aliases: page.aliases ?? [],
          orphaned: page.orphaned ?? false,
          archived: page.archived ?? false,
          hasFrontmatterBlock: page.hasFrontmatterBlock ?? false,
          malformedFrontmatter: page.malformedFrontmatter ?? false,
        })),
        graph: snapshot.graph ?? { nodes: [], edges: [] },
        chunks: snapshot.chunks ?? [],
        indexStats: snapshot.indexStats ?? {
          indexedFiles: snapshot.sources?.length ?? 0,
          indexedBytes: snapshot.sources?.reduce((sum, source) => sum + (source.sizeBytes ?? 0), 0) ?? 0,
          skippedFiles: 0,
          skippedBytes: 0,
          truncated: false,
          skippedReasons: [],
          redactionFailed: 0,
        },
      }]),
    ),
    receipts: state.receipts ?? {},
    grants: state.grants ?? {},
    jobs: state.jobs ?? {},
  };
}

export async function saveState(store: ThreadStore, state: CatalogState, options: { rebuildIndex?: boolean; appendSnapshotId?: string; removeSnapshotIds?: string[] } = { rebuildIndex: false }): Promise<void> {
  const sqlite = store.knowledgeSqlite;
  if (sqlite) {
    writeKnowledgeCatalog(sqlite, tenantKey(), state, options);
    return;
  }
  await store.setSetting(`${STATE_KEY}:${tenantKey()}`, state);
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pruneSnapshots(state: CatalogState, knowledgeBaseId: string): string[] {
  const snapshots = Object.values(state.snapshots)
    .filter((snapshot) => snapshot.knowledgeBaseId === knowledgeBaseId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set(snapshots.slice(0, SNAPSHOT_RETENTION).map((snapshot) => snapshot.snapshotId));
  for (const receipt of Object.values(state.receipts)) {
    if (receipt.knowledgeBaseIds.includes(knowledgeBaseId)) {
      for (const snapshotId of receipt.snapshotIds) keep.add(snapshotId);
    }
  }
  const removed = snapshots.filter((snapshot) => !keep.has(snapshot.snapshotId)).map((snapshot) => snapshot.snapshotId);
  for (const snapshotId of removed) delete state.snapshots[snapshotId];
  return removed;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export interface KnowledgeIndexStats {
  skippedFiles: number;
  skippedBytes: number;
  truncated: boolean;
  skippedReasons: Array<{ path: string; reason: string; bytes?: number }>;
  redactionFailed: number;
}

export interface CollectedKnowledgeFile {
  relativePath: string;
  text: string;
  contentHash: string;
  sizeBytes: number;
  indexedBytes: number;
  sourceUpdatedAt: string;
  redactionVersion: string;
  extractor?: string;
  extractorVersion?: string;
}

async function collectTextFiles(root: string): Promise<{ files: CollectedKnowledgeFile[]; stats: KnowledgeIndexStats }> {
  const result: CollectedKnowledgeFile[] = [];
  let totalBytes = 0;
  const stats = { skippedFiles: 0, skippedBytes: 0, truncated: false, skippedReasons: [] as Array<{ path: string; reason: string; bytes?: number }>, redactionFailed: 0 };
  async function visit(directory: string): Promise<void> {
    if (totalBytes >= MAX_TOTAL_BYTES) { stats.truncated = true; return; }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist' ||
        entry.name === 'dist-types' || entry.name === '.llmwiki' || entry.name === '.suanlizi'
      ) { stats.skippedFiles += 1; stats.skippedReasons.push({ path: path.relative(root, path.join(directory, entry.name)).replaceAll(path.sep, '/'), reason: 'excluded_directory' }); continue; }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const isText = TEXT_EXTENSIONS.has(extension);
      const isDocument = DOCUMENT_EXTENSIONS.has(extension);
      if (!isText && !isDocument) { stats.skippedFiles += 1; stats.skippedReasons.push({ path: path.relative(root, absolute).replaceAll(path.sep, '/'), reason: 'unsupported_extension' }); continue; }
      const canonicalFile = await realpath(absolute).catch(() => null);
      if (!canonicalFile || !isWithinRoot(root, canonicalFile)) { stats.skippedFiles += 1; stats.skippedReasons.push({ path: path.relative(root, absolute).replaceAll(path.sep, '/'), reason: 'symlink_outside_root' }); continue; }
      const fileStat = await stat(canonicalFile);
      const maxBytes = isDocument ? MAX_BINARY_FILE_BYTES : MAX_FILE_BYTES;
      if (fileStat.size > maxBytes) { stats.skippedFiles += 1; stats.skippedBytes += fileStat.size; stats.skippedReasons.push({ path: path.relative(root, canonicalFile).replaceAll(path.sep, '/'), reason: isDocument ? 'document_too_large' : 'file_too_large', bytes: fileStat.size }); continue; }
      let raw: string | null;
      let extractor: string | undefined;
      let extractorVersion: string | undefined;
      if (isDocument) {
        try {
          const extracted = await extractDocumentText(canonicalFile);
          raw = extracted.text;
          extractor = extracted.extractor;
          extractorVersion = DOCUMENT_EXTRACTOR_VERSION;
        } catch (error) {
          stats.skippedFiles += 1;
          stats.skippedReasons.push({ path: path.relative(root, canonicalFile).replaceAll(path.sep, '/'), reason: `extraction_failed:${error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'extractor_error'}`, bytes: fileStat.size });
          continue;
        }
      } else {
        raw = await readFile(canonicalFile, 'utf8').catch(() => null);
      }
      if (raw === null) { stats.skippedFiles += 1; stats.skippedReasons.push({ path: path.relative(root, canonicalFile).replaceAll(path.sep, '/'), reason: 'read_failed' }); continue; }
      if (!raw.trim()) { stats.skippedFiles += 1; stats.skippedReasons.push({ path: path.relative(root, canonicalFile).replaceAll(path.sep, '/'), reason: isDocument ? 'extracted_empty' : 'empty' }); continue; }
      const redacted = secretRedactor.redact(raw, { source: { path: path.relative(root, canonicalFile).replaceAll(path.sep, '/') } });
      if (!redacted.ok) { stats.redactionFailed += 1; stats.skippedFiles += 1; stats.skippedReasons.push({ path: path.relative(root, canonicalFile).replaceAll(path.sep, '/'), reason: `redaction_failed:${redacted.reasonCode}` }); continue; }
      const remaining = MAX_TOTAL_BYTES - totalBytes;
      const rawText = redacted.redactedContent;
      const rawBytes = Buffer.byteLength(rawText, 'utf8');
      const text = rawBytes <= remaining
        ? rawText
        : Buffer.from(rawText, 'utf8').subarray(0, remaining).toString('utf8');
      if (rawBytes > remaining) stats.truncated = true;
      totalBytes += Buffer.byteLength(text, 'utf8');
      result.push({
        relativePath: path.relative(root, canonicalFile).replaceAll(path.sep, '/'),
        text,
        contentHash: hash(text),
        sizeBytes: fileStat.size,
        indexedBytes: Buffer.byteLength(text, 'utf8'),
        sourceUpdatedAt: fileStat.mtime.toISOString(),
        redactionVersion: redacted.metadata.detectorVersion,
        ...(extractor ? { extractor } : {}),
        ...(extractorVersion ? { extractorVersion } : {}),
      });
    }
  }
  await visit(root);
  return { files: result.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), stats };
}

function classifySource(relativePath: string): {
  kind: 'workspace_doc' | 'wiki_page';
  role: 'normative' | 'reference' | 'historical';
} {
  const normalized = relativePath.toLowerCase();
  if (/(^|\/)(incident|incidents|postmortem|postmortems)(\/|$)/.test(normalized)) {
    return { kind: 'workspace_doc', role: 'historical' };
  }
  if (/(^|\/)(wiki|runbook|runbooks|docs|handbook)(\/|$)/.test(normalized)) {
    return { kind: 'wiki_page', role: 'normative' };
  }
  return { kind: 'workspace_doc', role: 'reference' };
}

function documentTitle(relativePath: string, text: string): string {
  const heading = text.match(/^\s*#\s+(.+?)\s*$/m)?.[1];
  if (heading) return heading.replace(/[`*_~]/g, '').trim();
  return path.basename(relativePath, path.extname(relativePath)) || relativePath;
}

function pageSlug(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/\.[^/.]+$/, '')
    .replace(/[^\p{L}\p{N}/_-]+/gu, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase();
}

export async function ensureKnowledgeBaseFromSource(
  store: ThreadStore,
  tenantId: string,
  sourceDirectory: string,
  options: { sync?: boolean; create?: boolean; knowledgeBaseId?: string; name?: string; scope?: 'workspace' | 'ops'; sourceGrant?: KnowledgeSourceGrant } = {},
): Promise<{ base: KnowledgeBaseRecord; snapshot: KnowledgeSnapshotRecord }> {
  const canonicalRoot = await realpath(sourceDirectory).catch(() => null);
  if (!canonicalRoot || !(await stat(canonicalRoot).catch(() => null))?.isDirectory()) {
    throw new Error('Knowledge source directory does not exist or is not a directory');
  }
  const state = await loadState(store);
  let base = options.knowledgeBaseId
    ? state.bases[options.knowledgeBaseId]
    : options.create
      ? undefined
      : Object.values(state.bases).find((item) => item.status !== 'deleted' && item.source?.canonicalPath === canonicalRoot);
  if (options.knowledgeBaseId && (!base || base.status === 'deleted')) {
    throw new Error('KnowledgeBase not found');
  }
  if (!base) {
    const now = new Date().toISOString();
    base = {
      knowledgeBaseId: `kb_${randomUUID()}`,
      source: options.sourceGrant
        ? { kind: 'directory', grantId: options.sourceGrant.grantId, canonicalPath: canonicalRoot, authorizedAt: options.sourceGrant.authorizedAt }
        : { kind: 'directory', canonicalPath: canonicalRoot, authorizedAt: new Date().toISOString() },
      name: options.name?.trim() || path.basename(canonicalRoot),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    state.bases[base.knowledgeBaseId] = base;
  }
  if (options.sync === false && base.currentSnapshotId) {
    const current = state.snapshots[base.currentSnapshotId];
    if (current?.status === 'ready' && current.immutable === true) {
      return { base, snapshot: current };
    }
  }
  const collected = await collectTextFiles(canonicalRoot);
  const files = collected.files;
  const snapshotId = `snap_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const sources: KnowledgeSourceRecord[] = [];
  const documents: KnowledgeDocumentRecord[] = [];
  const pages: KnowledgeWikiPageRecord[] = [];
  const parsedPages: Array<WikiPageRecord & { pageId: string }> = [];
  const chunks: KnowledgeChunkRecord[] = [];
  for (const file of files) {
    const sourceId = `source_${hash(`${base.knowledgeBaseId}:${file.relativePath}`).slice(0, 20)}`;
    const documentId = `doc_${hash(`${sourceId}:${file.contentHash}`).slice(0, 20)}`;
    const classification = classifySource(file.relativePath);
    const wikiPage = file.relativePath.toLowerCase().endsWith('.md')
      ? parseWikiPage(file.relativePath, file.text)
      : null;
    const title = wikiPage?.title ?? documentTitle(file.relativePath, file.text);
    sources.push({
      sourceId,
      relativePath: file.relativePath,
      kind: classification.kind,
      role: classification.role,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      sourceUpdatedAt: file.sourceUpdatedAt,
      recordUpdatedAt: createdAt,
      redactionVersion: file.redactionVersion,
      ...(file.extractor ? { extractor: file.extractor } : {}),
      ...(file.extractorVersion ? { extractorVersion: file.extractorVersion } : {}),
    });
    documents.push({
      documentId,
      sourceId,
      relativePath: file.relativePath,
      revision: file.contentHash,
      title,
      contentHash: file.contentHash,
      parserVersion: file.extractor ? `${file.extractor}-${file.extractorVersion ?? DOCUMENT_EXTRACTOR_VERSION}` : 'markdown-source-v1',
      sourceKind: classification.kind,
      evidenceRole: classification.role,
      ...(file.extractor ? { extractor: file.extractor } : {}),
      ...(file.extractorVersion ? { extractorVersion: file.extractorVersion } : {}),
    });
    const pageId = `page_${hash(`${sourceId}:${file.contentHash}`).slice(0, 20)}`;
    pages.push({
      pageId,
      slug: wikiPage?.slug ?? pageSlug(file.relativePath),
      title,
      relativePath: file.relativePath,
      documentId,
      sourceId,
      contentHash: file.contentHash,
      evidenceRole: classification.role,
      generated: false,
      pageDirectory: wikiPage?.pageDirectory ?? 'other',
      summary: wikiPage?.summary ?? '',
      tags: wikiPage?.tags ?? [],
      links: wikiPage?.links ?? [],
      linkTargets: wikiPage?.linkTargets ?? [],
      aliases: wikiPage?.aliases ?? [],
      orphaned: wikiPage?.orphaned ?? false,
      archived: wikiPage?.archived ?? false,
      hasFrontmatterBlock: wikiPage?.parseStatus.hasFrontmatterBlock ?? false,
      malformedFrontmatter: wikiPage?.parseStatus.malformedFrontmatter ?? false,
    });
    if (wikiPage) parsedPages.push({ ...wikiPage, pageId });
    for (let offset = 0, ordinal = 0; offset < file.text.length; offset += CHUNK_SIZE, ordinal += 1) {
      const text = file.text.slice(offset, offset + CHUNK_SIZE);
      chunks.push({
        chunkId: `chunk_${hash(`${snapshotId}:${documentId}:${ordinal}`).slice(0, 20)}`,
        snapshotId,
        documentId,
        relativePath: file.relativePath,
        ordinal,
        text,
        contentHash: hash(text),
        tokenCount: Math.ceil(text.length / 4),
        heading: title,
        sourceKind: classification.kind,
        evidenceRole: classification.role,
      });
    }
  }
  const snapshot: KnowledgeSnapshotRecord = {
    snapshotId,
    knowledgeBaseId: base.knowledgeBaseId,
    status: 'ready',
    immutable: true,
    contentHash: hash([
      ...sources.map((source) => `${source.relativePath}:${source.contentHash}`),
      ...pages.map((page) => `${page.slug}:${page.contentHash}`),
    ].join('|')),
    indexVersion: `wiki-core-lexical-v1-${hash(chunks.map((chunk) => chunk.contentHash).join('|')).slice(0, 20)}`,
    redactionVersion: files[0]?.redactionVersion ?? secretRedactor.detectorVersion,
    createdAt,
    completedAt: createdAt,
    sources,
    documents,
    pages,
    graph: buildWikiLinkGraph(parsedPages),
    chunks,
    indexStats: {
      indexedFiles: files.length,
      indexedBytes: files.reduce((sum, file) => sum + file.indexedBytes, 0),
      skippedFiles: collected.stats.skippedFiles,
      skippedBytes: collected.stats.skippedBytes,
      truncated: collected.stats.truncated,
      skippedReasons: collected.stats.skippedReasons,
      redactionFailed: collected.stats.redactionFailed,
    },
  };
  state.snapshots[snapshotId] = snapshot;
  const removedSnapshotIds = pruneSnapshots(state, base.knowledgeBaseId);
  base.currentSnapshotId = snapshotId;
  base.updatedAt = new Date().toISOString();
  base.version += 1;
  state.bases[base.knowledgeBaseId] = base;
  await saveState(store, state, { appendSnapshotId: snapshotId, removeSnapshotIds: removedSnapshotIds });
  return { base, snapshot };
}

/** Ops callers must select an explicit knowledge base. */
export async function ensureOpsKnowledgeBase(
  store: ThreadStore,
  tenantId: string,
  options: object = {},
): Promise<{ base: KnowledgeBaseRecord; snapshot: KnowledgeSnapshotRecord }> {
  void store;
  void tenantId;
  void options;
  throw new Error('Knowledge base selection is required; no default Ops knowledge base is created');
}

/** Persist a directory selected by the native picker as an explicit local grant. */
export async function authorizeKnowledgeDirectory(
  store: ThreadStore,
  tenantId: string,
  selectedDirectory: string,
): Promise<KnowledgeSourceGrant> {
  const canonicalPath = await realpath(selectedDirectory).catch(() => null);
  if (!canonicalPath || !(await stat(canonicalPath).catch(() => null))?.isDirectory()) {
    throw new Error('Selected knowledge directory does not exist or is not a directory');
  }
  return withCatalogLock(store, async () => {
    const state = await loadState(store);
    const existing = Object.values(state.grants).find((grant) => !grant.revokedAt && grant.canonicalPath === canonicalPath);
    if (existing) return existing;
    const grant: KnowledgeSourceGrant = {
      grantId: `knowledge_directory_${randomUUID()}`,
      kind: 'directory',
      canonicalPath,
      authorizedAt: new Date().toISOString(),
    };
    state.grants[grant.grantId] = grant;
    await saveState(store, state, { rebuildIndex: false });
    return grant;
  });
}

/** Explicitly creates a personal KnowledgeBase from a native-picker directory grant. */
export async function createKnowledgeBase(
  store: ThreadStore,
  tenantId: string,
  input: { name: string; sourceGrantId?: string },
): Promise<{ base: KnowledgeBaseRecord; snapshot: KnowledgeSnapshotRecord }> {
  const name = input.name.trim();
  if (!name) throw new Error('KnowledgeBase name is required');
  const sourceGrantId = input.sourceGrantId?.trim();
  if (!sourceGrantId) throw new Error('A native-picker directory grant is required');
  return withCatalogLock(store, async () => {
    const state = await loadState(store);
    const grant = state.grants[sourceGrantId];
    if (!grant || grant.revokedAt) throw new Error('Knowledge directory authorization is unavailable');
    return ensureKnowledgeBaseFromSource(store, tenantId, grant.canonicalPath, { create: true, name, sourceGrant: grant });
  });
}

/** Synchronizes an explicitly selected KnowledgeBase; never creates one from a workspace path. */
export async function syncKnowledgeBase(
  store: ThreadStore,
  tenantId: string,
  knowledgeBaseId: string,
): Promise<{ base: KnowledgeBaseRecord; snapshot: KnowledgeSnapshotRecord }> {
  return withCatalogLock(store, async () => {
    const state = await loadState(store);
    const base = state.bases[knowledgeBaseId];
    if (!base || base.status === 'deleted') throw new Error('KnowledgeBase not found');
    const grantId = base.source?.grantId;
    const grant = grantId ? state.grants[grantId] : undefined;
    const sourceRoot = grant?.canonicalPath ?? (!grantId ? base.source?.canonicalPath : undefined);
    if (!sourceRoot || (grantId && (!grant || grant.revokedAt))) {
      throw new Error('Knowledge directory authorization is unavailable');
    }
    return ensureKnowledgeBaseFromSource(store, tenantId, sourceRoot, {
      knowledgeBaseId,
      sync: true,
      name: base.name,
      ...(grant ? { sourceGrant: grant } : {}),
    });
  });
}

export async function renameKnowledgeBase(store: ThreadStore, tenantId: string, knowledgeBaseId: string, name: string): Promise<KnowledgeBaseRecord> {
  const nextName = name.trim();
  if (!nextName) throw new Error('KnowledgeBase name is required');
  return withCatalogLock(store, async () => {
    const state = await loadState(store);
    const base = state.bases[knowledgeBaseId];
    if (!base || base.status === 'deleted') throw new Error('KnowledgeBase not found');
    const updated = { ...base, name: nextName, updatedAt: new Date().toISOString(), version: base.version + 1 };
    state.bases[knowledgeBaseId] = updated;
    await saveState(store, state);
    return updated;
  });
}

export async function deleteKnowledgeBase(store: ThreadStore, tenantId: string, knowledgeBaseId: string): Promise<void> {
  await withCatalogLock(store, async () => {
    const state = await loadState(store);
    const base = state.bases[knowledgeBaseId];
    if (!base || base.status === 'deleted') throw new Error('KnowledgeBase not found');
    const deletedAt = new Date().toISOString();
    for (const [jobId, job] of Object.entries(state.jobs)) {
      if (job.knowledgeBaseId === knowledgeBaseId && !['completed', 'cancelled', 'failed'].includes(job.status)) {
        state.jobs[jobId] = { ...job, status: 'cancelled', stage: 'cancelled', requestedAction: undefined, currentFile: undefined, updatedAt: deletedAt, completedAt: deletedAt };
      }
    }
    state.bases[knowledgeBaseId] = { ...base, status: 'deleted', updatedAt: deletedAt, version: base.version + 1 };
    await saveState(store, state);
  });
}

export async function listKnowledgeBases(store: ThreadStore, tenantId?: string): Promise<KnowledgeBaseRecord[]> {
  const state = await loadState(store);
  // The personal catalog has one owner and one list.
  return Object.values(state.bases).filter((item) => item.status !== 'deleted');
}

export async function getKnowledgeBase(store: ThreadStore, id: string, tenantId?: string): Promise<KnowledgeBaseRecord | null> {
  const state = await loadState(store);
  const base = state.bases[id] ?? null;
  return base && base.status !== 'deleted' ? base : null;
}

export async function getSnapshot(store: ThreadStore, id: string, tenantId?: string): Promise<KnowledgeSnapshotRecord | null> {
  const state = await loadState(store);
  const snapshot = state.snapshots[id] ?? null;
  return snapshot ?? null;
}

export async function getKnowledgeReceipt(store: ThreadStore, id: string, tenantId?: string): Promise<KnowledgeQueryReceipt | null> {
  const state = await loadState(store);
  const receipt = state.receipts[id] ?? null;
  return receipt ?? null;
}

export async function listKnowledgePages(
  store: ThreadStore,
  knowledgeBaseId: string,
  tenantId: string,
): Promise<KnowledgeWikiPageRecord[]> {
  const state = await loadState(store);
  const base = state.bases[knowledgeBaseId];
  if (!base || !base.currentSnapshotId) return [];
  const snapshot = state.snapshots[base.currentSnapshotId];
  if (!snapshot || snapshot.status !== 'ready') return [];
  return snapshot.pages ?? [];
}

export async function getKnowledgePage(
  store: ThreadStore,
  knowledgeBaseId: string,
  pageId: string,
  tenantId: string,
): Promise<(KnowledgeWikiPageRecord & { body: string }) | null> {
  const state = await loadState(store);
  const base = state.bases[knowledgeBaseId];
  if (!base || !base.currentSnapshotId) return null;
  const snapshot = state.snapshots[base.currentSnapshotId];
  if (!snapshot || snapshot.status !== 'ready') return null;
  const page = snapshot.pages.find((item) => item.pageId === pageId);
  if (!page) return null;
  const rawContent = snapshot.chunks
    .filter((chunk) => chunk.documentId === page.documentId)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((chunk) => chunk.text)
    .join('');
  const body = page.relativePath.toLowerCase().endsWith('.md')
    ? parseWikiPage(page.relativePath, rawContent).body
    : rawContent;
  return { ...page, body };
}

export async function queryKnowledge(
  store: ThreadStore,
  tenantId: string,
  input: { knowledgeBaseIds: string[]; snapshotIds?: string[]; query: string; maxHits?: number },
): Promise<{ receipt: KnowledgeQueryReceipt; hits: KnowledgeChunkRecord[] }> {
  return withCatalogLock(store, async () => {
  const state = await loadState(store);
  const bases = input.knowledgeBaseIds.map((id) => state.bases[id]).filter((item): item is KnowledgeBaseRecord => Boolean(
    item && item.status !== 'deleted',
  ));
  if (bases.length !== new Set(input.knowledgeBaseIds).size) throw new Error('One or more selected knowledge bases are unavailable');
  const requestedSnapshotIds = input.snapshotIds?.length
    ? input.snapshotIds
    : bases.map((base) => base.currentSnapshotId).filter((id): id is string => Boolean(id));
  const allowedBaseIds = new Set(bases.map((base) => base.knowledgeBaseId));
  const snapshotIds = requestedSnapshotIds.filter((id) => {
    const snapshot = state.snapshots[id];
    return Boolean(snapshot && snapshot.status === 'ready' && allowedBaseIds.has(snapshot.knowledgeBaseId));
  });
  if (snapshotIds.length !== requestedSnapshotIds.length) throw new Error('One or more selected knowledge snapshots are unavailable');
  const terms = tokenizeWikiQuery(input.query);
  const candidates = snapshotIds.flatMap((id) => state.snapshots[id]?.chunks ?? []);
  const ftsIds = terms.length > 0 && store.knowledgeSqlite
    ? searchKnowledgeChunkIds(store.knowledgeSqlite, PERSONAL_CATALOG_KEY, terms)
    : null;
  const indexedCandidates = ftsIds === null
    ? candidates
    : candidates.filter((chunk) => ftsIds.includes(chunk.chunkId));
  const chunksByDocument = new Map<string, KnowledgeChunkRecord[]>();
  for (const chunk of indexedCandidates) {
    const chunks = chunksByDocument.get(chunk.documentId) ?? [];
    chunks.push(chunk);
    chunksByDocument.set(chunk.documentId, chunks);
  }
  for (const chunks of chunksByDocument.values()) chunks.sort((a, b) => a.ordinal - b.ordinal);
  const pagesByDocument = new Map<string, KnowledgeWikiPageRecord>();
  for (const snapshotId of snapshotIds) {
    for (const page of state.snapshots[snapshotId]?.pages ?? []) {
      if (chunksByDocument.has(page.documentId)) pagesByDocument.set(page.documentId, page);
    }
  }
  const lexical = searchWikiPages(
    [...pagesByDocument.entries()].map(([documentId, page]) => ({
      id: documentId,
      title: page.title,
      body: (chunksByDocument.get(documentId) ?? []).map((chunk) => chunk.text).join(''),
      sortKey: page.relativePath,
    })),
    input.query,
  );
  const scored = lexical.results
    .flatMap((result) => (chunksByDocument.get(result.id) ?? []).map((chunk) => ({
      chunk,
      score: result.score,
    })));
  const maxHits = Math.max(1, Math.min(input.maxHits ?? 20, 100));
  const selected = scored.slice(0, maxHits);
  const indexVersions = snapshotIds.map((id) => state.snapshots[id]?.indexVersion).filter((value): value is string => Boolean(value));
  const indexVersion = indexVersions.length === 1 ? indexVersions[0] : hash(indexVersions.sort().join('|')).slice(0, 24);
  const receipt: KnowledgeQueryReceipt = {
    receiptId: `receipt_${randomUUID()}`,
    knowledgeBaseIds: bases.map((base) => base.knowledgeBaseId),
    snapshotIds,
    normalizedQueryHash: hash(terms.join(' ')),
    queryVersion: 'wiki-core-lexical-v1',
    indexVersion,
    orderedHits: selected.map((item, index) => ({ chunkId: item.chunk.chunkId, rank: index + 1, score: item.score })),
    truncated: scored.length > selected.length,
    truncationReasons: scored.length > selected.length ? ['max_hits'] : [],
    maxHits,
    createdAt: new Date().toISOString(),
  };
  state.receipts[receipt.receiptId] = receipt;
  await saveState(store, state, { rebuildIndex: false });
  return { receipt, hits: selected.map((item) => item.chunk) };
  });
}

/**
 * Replays a persisted receipt without running the search again. This keeps a
 * task's knowledge references stable when a newer snapshot is published.
 */
export async function replayKnowledgeReceipt(
  store: ThreadStore,
  tenantId: string,
  receiptId: string,
): Promise<{ receipt: KnowledgeQueryReceipt; hits: KnowledgeChunkRecord[] } | null> {
  const state = await loadState(store);
  const receipt = state.receipts[receiptId];
  if (!receipt) return null;
  const chunksById = new Map<string, KnowledgeChunkRecord>();
  for (const snapshotId of receipt.snapshotIds) {
    const snapshot = state.snapshots[snapshotId];
    if (!snapshot || snapshot.status !== 'ready') continue;
    for (const chunk of snapshot.chunks) chunksById.set(chunk.chunkId, chunk);
  }
  const hits = [...receipt.orderedHits]
    .sort((a, b) => a.rank - b.rank)
    .map((hit) => chunksById.get(hit.chunkId))
    .filter((chunk): chunk is KnowledgeChunkRecord => Boolean(chunk));
  return { receipt, hits };
}
