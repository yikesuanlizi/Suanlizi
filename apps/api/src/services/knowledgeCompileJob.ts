import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ThreadStore } from '@suanlizi/storage';
import { SecretRedactor } from '@suanlizi/runtime';
import { DOCUMENT_EXTRACTOR_VERSION, extractDocumentText } from '@suanlizi/tools';
import {
  buildWikiLinkGraph,
  parseWikiPage,
  type WikiPageRecord,
} from '@suanlizi/wiki-core';
import {
  hash,
  isWithinRoot,
  loadState,
  saveState,
  withCatalogLock,
  type CatalogState,
  type CollectedKnowledgeFile,
  type KnowledgeBaseRecord,
  type KnowledgeChunkRecord,
  type KnowledgeDocumentRecord,
  type KnowledgeIndexStats,
  type KnowledgeSnapshotRecord,
  type KnowledgeSourceGrant,
  type KnowledgeSourceRecord,
  type KnowledgeWikiPageRecord,
} from './knowledgeBase.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_BINARY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const CHUNK_SIZE = 2400;
const SNAPSHOT_RETENTION = 8;
const secretRedactor = new SecretRedactor({ detectorVersion: 'suanlizi-secret-redactor-v1' });
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js',
  '.json', '.jsx', '.log', '.md', '.mdx', '.mjs', '.py', '.rs', '.scss', '.sql', '.svg',
  '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.csv',
]);
const DOCUMENT_EXTENSIONS = new Set(['.docx', '.pdf', '.xlsx', '.pptx']);

export type KnowledgeCompileJobStatus =
  | 'queued'
  | 'scanning'
  | 'extracting'
  | 'indexing'
  | 'finalizing'
  | 'completed'
  | 'paused'
  | 'cancelled'
  | 'failed';

export type KnowledgeCompileJobKind = 'create' | 'sync';
export type KnowledgeCompileJobAction = 'pause' | 'resume' | 'cancel';

export interface KnowledgeCompilePendingFile {
  relativePath: string;
  sizeBytes: number;
  contentHash?: string;
  /** 已脱敏中间结果的编码载荷；禁止在 catalog 中保存明文。 */
  encodedText?: string;
  indexedBytes?: number;
  sourceUpdatedAt?: string;
  redactionVersion?: string;
  extractor?: string;
  extractorVersion?: string;
  stage: 'queued' | 'extracting' | 'indexing' | 'indexed' | 'skipped' | 'failed';
  failure?: string;
}

export interface KnowledgeCompileErrorEvent {
  at: string;
  stage: KnowledgeCompileJobStatus;
  relativePath?: string;
  code: string;
  message: string;
}

export interface KnowledgeCompileJob {
  jobId: string;
  knowledgeBaseId: string;
  kind: KnowledgeCompileJobKind;
  status: KnowledgeCompileJobStatus;
  stage: KnowledgeCompileJobStatus;
  sourceGrantId: string;
  canonicalRoot: string;
  persistPending: boolean;
  currentFile?: string;
  totalFiles: number;
  processedFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  indexedBytes: number;
  skippedBytes: number;
  truncated: boolean;
  errors: KnowledgeCompileErrorEvent[];
  pendingFiles?: KnowledgeCompilePendingFile[];
  requestedAction?: Exclude<KnowledgeCompileJobAction, 'resume'>;
  snapshotId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface KnowledgeJobResult {
  base: KnowledgeBaseRecord;
  job: KnowledgeCompileJob;
}

interface ManifestFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

interface JobRuntime {
  store: ThreadStore;
  tenantId: string;
  jobId: string;
  baseId: string;
  root: string;
  manifest: ManifestFile[];
  files: CollectedKnowledgeFile[];
  stats: KnowledgeIndexStats;
  totalBytes: number;
}

function pendingFileFromCollected(file: CollectedKnowledgeFile, stage: KnowledgeCompilePendingFile['stage'] = 'indexed'): KnowledgeCompilePendingFile {
  return {
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    contentHash: file.contentHash,
    encodedText: Buffer.from(file.text, 'utf8').toString('base64'),
    indexedBytes: file.indexedBytes,
    sourceUpdatedAt: file.sourceUpdatedAt,
    redactionVersion: file.redactionVersion,
    ...(file.extractor ? { extractor: file.extractor } : {}),
    ...(file.extractorVersion ? { extractorVersion: file.extractorVersion } : {}),
    stage,
  };
}

function collectedFromPending(file: KnowledgeCompilePendingFile): CollectedKnowledgeFile | null {
  if (file.stage !== 'indexed' || typeof file.encodedText !== 'string' || !file.contentHash || !file.sourceUpdatedAt || !file.redactionVersion) return null;
  const text = Buffer.from(file.encodedText, 'base64').toString('utf8');
  if (!text) return null;
  return {
    relativePath: file.relativePath,
    text,
    contentHash: file.contentHash,
    sizeBytes: file.sizeBytes,
    indexedBytes: file.indexedBytes ?? Buffer.byteLength(text, 'utf8'),
    sourceUpdatedAt: file.sourceUpdatedAt,
    redactionVersion: file.redactionVersion,
    ...(file.extractor ? { extractor: file.extractor } : {}),
    ...(file.extractorVersion ? { extractorVersion: file.extractorVersion } : {}),
  };
}

class JobControlError extends Error {
  constructor(readonly terminalStatus: 'paused' | 'cancelled') {
    super(`knowledge compile ${terminalStatus}`);
  }
}

const runners = new Map<string, Promise<void>>();
const activeByBase = new Map<string, string>();
let compileTail: Promise<void> = Promise.resolve();
const recoveredStores = new WeakSet<object>();

function now(): string {
  return new Date().toISOString();
}

function emptyStats(): KnowledgeIndexStats {
  return { skippedFiles: 0, skippedBytes: 0, truncated: false, skippedReasons: [], redactionFailed: 0 };
}

function yieldControl(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isTerminal(status: KnowledgeCompileJobStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

function addError(job: KnowledgeCompileJob, stage: KnowledgeCompileJobStatus, code: string, message: string, relativePath?: string): KnowledgeCompileJob {
  const event: KnowledgeCompileErrorEvent = { at: now(), stage, code, message, ...(relativePath ? { relativePath } : {}) };
  return { ...job, errors: [...job.errors, event].slice(-100), updatedAt: event.at };
}

function activeJob(state: CatalogState, baseId: string): KnowledgeCompileJob | null {
  return Object.values(state.jobs).find((job) => job.knowledgeBaseId === baseId && !isTerminal(job.status)) ?? null;
}

async function grantRoot(state: CatalogState, grantId: string): Promise<string> {
  const grant = state.grants[grantId];
  if (!grant || grant.revokedAt) throw new Error('Knowledge directory authorization is unavailable');
  const canonical = await realpath(grant.canonicalPath).catch(() => null);
  if (!canonical || canonical !== grant.canonicalPath || !(await stat(canonical).catch(() => null))?.isDirectory()) {
    throw new Error('Knowledge directory authorization no longer matches its canonical root');
  }
  return canonical;
}

function createBase(grant: KnowledgeSourceGrant, name: string, timestamp: string): KnowledgeBaseRecord {
  return {
    knowledgeBaseId: `kb_${randomUUID()}`,
    source: { kind: 'directory', grantId: grant.grantId, canonicalPath: grant.canonicalPath, authorizedAt: grant.authorizedAt },
    name: name.trim() || path.basename(grant.canonicalPath),
    status: 'syncing',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };
}

function createJob(base: KnowledgeBaseRecord, grant: KnowledgeSourceGrant, root: string, kind: KnowledgeCompileJobKind, persistPending: boolean, timestamp: string): KnowledgeCompileJob {
  return {
    jobId: `knowledge_job_${randomUUID()}`,
    knowledgeBaseId: base.knowledgeBaseId,
    kind,
    status: 'queued',
    stage: 'queued',
    sourceGrantId: grant.grantId,
    canonicalRoot: root,
    persistPending,
    totalFiles: 0,
    processedFiles: 0,
    indexedFiles: 0,
    skippedFiles: 0,
    indexedBytes: 0,
    skippedBytes: 0,
    truncated: false,
    errors: [],
    ...(persistPending ? { pendingFiles: [] } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function publicJob(job: KnowledgeCompileJob): KnowledgeCompileJob {
  return job;
}

async function persistJob(store: ThreadStore, tenantId: string, job: KnowledgeCompileJob, patch: Partial<KnowledgeCompileJob> = {}): Promise<KnowledgeCompileJob> {
  return withCatalogLock(store, async () => {
    const state = await loadState(store, tenantId);
    const current = state.jobs[job.jobId] ?? job;
    if ((current.status === 'paused' || current.status === 'cancelled') && patch.status && patch.status !== current.status) return current;
    const updated = { ...current, ...patch, updatedAt: now() };
    state.jobs[updated.jobId] = updated;
    if (updated.status === 'failed') {
      const base = state.bases[updated.knowledgeBaseId];
      if (base?.status === 'syncing') state.bases[base.knowledgeBaseId] = { ...base, status: base.currentSnapshotId ? 'active' : 'blocked', updatedAt: updated.updatedAt, version: base.version + 1 };
    }
    await saveState(store, state, tenantId, false, { rebuildIndex: false });
    return updated;
  });
}

async function discoverFiles(root: string, onFile: (file: ManifestFile) => Promise<void>, onSkipped: (relativePath: string, reason: string, bytes?: number) => void): Promise<void> {
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolute).replaceAll(path.sep, '/');
      if (['.git', 'node_modules', 'dist', 'dist-types', '.llmwiki', '.suanlizi'].includes(entry.name) && entry.isDirectory()) {
        onSkipped(relativePath, 'excluded_directory');
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension) && !DOCUMENT_EXTENSIONS.has(extension)) {
        onSkipped(relativePath, 'unsupported_extension');
        continue;
      }
      const canonicalFile = await realpath(absolute).catch(() => null);
      if (!canonicalFile || !isWithinRoot(root, canonicalFile)) {
        onSkipped(relativePath, 'symlink_outside_root');
        continue;
      }
      const fileStat = await stat(canonicalFile).catch(() => null);
      if (!fileStat?.isFile()) {
        onSkipped(relativePath, 'file_unavailable');
        continue;
      }
      await onFile({ absolutePath: absolute, relativePath, sizeBytes: fileStat.size });
      await yieldControl();
    }
  }
  await visit(root);
}

function skipFile(runtime: JobRuntime, relativePath: string, reason: string, bytes?: number): void {
  runtime.stats.skippedFiles += 1;
  if (bytes) runtime.stats.skippedBytes += bytes;
  runtime.stats.skippedReasons.push({ path: relativePath, reason, ...(bytes === undefined ? {} : { bytes }) });
}

async function extractFile(runtime: JobRuntime, manifest: ManifestFile): Promise<CollectedKnowledgeFile | null> {
  const extension = path.extname(manifest.relativePath).toLowerCase();
  const isDocument = DOCUMENT_EXTENSIONS.has(extension);
  const canonicalFile = await realpath(manifest.absolutePath).catch(() => null);
  if (!canonicalFile || !isWithinRoot(runtime.root, canonicalFile)) {
    skipFile(runtime, manifest.relativePath, 'symlink_outside_root');
    return null;
  }
  const fileStat = await stat(canonicalFile).catch(() => null);
  if (!fileStat?.isFile()) {
    skipFile(runtime, manifest.relativePath, 'file_unavailable');
    return null;
  }
  const maxBytes = isDocument ? MAX_BINARY_FILE_BYTES : MAX_FILE_BYTES;
  if (fileStat.size > maxBytes) {
    skipFile(runtime, manifest.relativePath, isDocument ? 'document_too_large' : 'file_too_large', fileStat.size);
    return null;
  }
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
      skipFile(runtime, manifest.relativePath, `extraction_failed:${error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'extractor_error'}`, fileStat.size);
      return null;
    }
  } else {
    raw = await readFile(canonicalFile, 'utf8').catch(() => null);
  }
  if (raw === null) {
    skipFile(runtime, manifest.relativePath, 'read_failed');
    return null;
  }
  if (!raw.trim()) {
    skipFile(runtime, manifest.relativePath, isDocument ? 'extracted_empty' : 'empty');
    return null;
  }
  const redacted = secretRedactor.redact(raw, { source: { path: manifest.relativePath } });
  if (!redacted.ok) {
    runtime.stats.redactionFailed += 1;
    skipFile(runtime, manifest.relativePath, `redaction_failed:${redacted.reasonCode}`);
    return null;
  }
  const remaining = MAX_TOTAL_BYTES - runtime.totalBytes;
  const rawText = redacted.redactedContent;
  const rawBytes = Buffer.byteLength(rawText, 'utf8');
  const text = rawBytes <= remaining ? rawText : Buffer.from(rawText, 'utf8').subarray(0, Math.max(0, remaining)).toString('utf8');
  if (rawBytes > remaining) runtime.stats.truncated = true;
  runtime.totalBytes += Buffer.byteLength(text, 'utf8');
  return {
    relativePath: manifest.relativePath,
    text,
    contentHash: hash(text),
    sizeBytes: fileStat.size,
    indexedBytes: Buffer.byteLength(text, 'utf8'),
    sourceUpdatedAt: fileStat.mtime.toISOString(),
    redactionVersion: redacted.metadata.detectorVersion,
    ...(extractor ? { extractor } : {}),
    ...(extractorVersion ? { extractorVersion } : {}),
  };
}

function classifySource(relativePath: string): { kind: 'workspace_doc' | 'wiki_page'; role: 'normative' | 'reference' | 'historical' } {
  const normalized = relativePath.toLowerCase();
  if (/(^|\/)(incident|incidents|postmortem|postmortems)(\/|$)/.test(normalized)) return { kind: 'workspace_doc', role: 'historical' };
  if (/(^|\/)(wiki|runbook|runbooks|docs|handbook)(\/|$)/.test(normalized)) return { kind: 'wiki_page', role: 'normative' };
  return { kind: 'workspace_doc', role: 'reference' };
}

function documentTitle(relativePath: string, text: string): string {
  const heading = text.match(/^\s*#\s+(.+?)\s*$/m)?.[1];
  if (heading) return heading.replace(/[`*_~]/g, '').trim();
  return path.basename(relativePath, path.extname(relativePath)) || relativePath;
}

function pageSlug(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/\.[^/.]+$/, '').replace(/[^\p{L}\p{N}/_-]+/gu, '-').replace(/(^-|-$)/g, '').toLowerCase();
}

function snapshotFromFiles(base: KnowledgeBaseRecord, root: string, files: CollectedKnowledgeFile[], stats: KnowledgeIndexStats, snapshotId: string, createdAt: string): KnowledgeSnapshotRecord {
  const sources: KnowledgeSourceRecord[] = [];
  const documents: KnowledgeDocumentRecord[] = [];
  const pages: KnowledgeWikiPageRecord[] = [];
  const parsedPages: Array<WikiPageRecord & { pageId: string }> = [];
  const chunks: KnowledgeChunkRecord[] = [];
  for (const file of files) {
    const sourceId = `source_${hash(`${base.knowledgeBaseId}:${file.relativePath}`).slice(0, 20)}`;
    const documentId = `doc_${hash(`${sourceId}:${file.contentHash}`).slice(0, 20)}`;
    const classification = classifySource(file.relativePath);
    const wikiPage = file.relativePath.toLowerCase().endsWith('.md') ? parseWikiPage(file.relativePath, file.text) : null;
    const title = wikiPage?.title ?? documentTitle(file.relativePath, file.text);
    sources.push({ sourceId, relativePath: file.relativePath, kind: classification.kind, role: classification.role, contentHash: file.contentHash, sizeBytes: file.sizeBytes, sourceUpdatedAt: file.sourceUpdatedAt, recordUpdatedAt: createdAt, redactionVersion: file.redactionVersion, ...(file.extractor ? { extractor: file.extractor } : {}), ...(file.extractorVersion ? { extractorVersion: file.extractorVersion } : {}) });
    documents.push({ documentId, sourceId, relativePath: file.relativePath, revision: file.contentHash, title, contentHash: file.contentHash, parserVersion: file.extractor ? `${file.extractor}-${file.extractorVersion ?? DOCUMENT_EXTRACTOR_VERSION}` : 'markdown-source-v1', sourceKind: classification.kind, evidenceRole: classification.role, ...(file.extractor ? { extractor: file.extractor } : {}), ...(file.extractorVersion ? { extractorVersion: file.extractorVersion } : {}) });
    const pageId = `page_${hash(`${sourceId}:${file.contentHash}`).slice(0, 20)}`;
    pages.push({ pageId, slug: wikiPage?.slug ?? pageSlug(file.relativePath), title, relativePath: file.relativePath, documentId, sourceId, contentHash: file.contentHash, evidenceRole: classification.role, generated: false, pageDirectory: wikiPage?.pageDirectory ?? 'other', summary: wikiPage?.summary ?? '', tags: wikiPage?.tags ?? [], links: wikiPage?.links ?? [], linkTargets: wikiPage?.linkTargets ?? [], aliases: wikiPage?.aliases ?? [], orphaned: wikiPage?.orphaned ?? false, archived: wikiPage?.archived ?? false, hasFrontmatterBlock: wikiPage?.parseStatus.hasFrontmatterBlock ?? false, malformedFrontmatter: wikiPage?.parseStatus.malformedFrontmatter ?? false });
    if (wikiPage) parsedPages.push({ ...wikiPage, pageId });
    for (let offset = 0, ordinal = 0; offset < file.text.length; offset += CHUNK_SIZE, ordinal += 1) {
      const text = file.text.slice(offset, offset + CHUNK_SIZE);
      chunks.push({ chunkId: `chunk_${hash(`${snapshotId}:${documentId}:${ordinal}`).slice(0, 20)}`, snapshotId, documentId, relativePath: file.relativePath, ordinal, text, contentHash: hash(text), tokenCount: Math.ceil(text.length / 4), heading: title, sourceKind: classification.kind, evidenceRole: classification.role });
    }
  }
  return {
    snapshotId,
    knowledgeBaseId: base.knowledgeBaseId,
    sourceRoot: root,
    status: 'ready',
    immutable: true,
    contentHash: hash([...sources.map((source) => `${source.relativePath}:${source.contentHash}`), ...pages.map((page) => `${page.slug}:${page.contentHash}`)].join('|')),
    indexVersion: `wiki-core-lexical-v1-${hash(chunks.map((chunk) => chunk.contentHash).join('|')).slice(0, 20)}`,
    redactionVersion: files[0]?.redactionVersion ?? secretRedactor.detectorVersion,
    createdAt,
    completedAt: createdAt,
    sources,
    documents,
    pages,
    graph: buildWikiLinkGraph(parsedPages),
    chunks,
    indexStats: { indexedFiles: files.length, indexedBytes: files.reduce((sum, file) => sum + file.indexedBytes, 0), skippedFiles: stats.skippedFiles, skippedBytes: stats.skippedBytes, truncated: stats.truncated, skippedReasons: stats.skippedReasons, redactionFailed: stats.redactionFailed },
  };
}

function pruneSnapshots(state: CatalogState, baseId: string): string[] {
  const snapshots = Object.values(state.snapshots).filter((snapshot) => snapshot.knowledgeBaseId === baseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set(snapshots.slice(0, SNAPSHOT_RETENTION).map((snapshot) => snapshot.snapshotId));
  for (const receipt of Object.values(state.receipts)) {
    if (receipt.knowledgeBaseIds.includes(baseId)) for (const snapshotId of receipt.snapshotIds) keep.add(snapshotId);
  }
  const removed = snapshots.filter((snapshot) => !keep.has(snapshot.snapshotId)).map((snapshot) => snapshot.snapshotId);
  for (const id of removed) delete state.snapshots[id];
  return removed;
}

async function executeJob(runtime: JobRuntime): Promise<void> {
  let job = await getKnowledgeJob(runtime.store, runtime.jobId, runtime.tenantId);
  if (!job || job.status === 'paused' || job.status === 'cancelled') return;
  // A persisted pending checkpoint is content-addressed and can be reused only
  // after the source file's size and mtime are revalidated. This keeps a pause
  // or API restart from needlessly extracting/indexing unchanged documents.
  const checkpointByPath = new Map(
    (job.pendingFiles ?? []).map((file) => [file.relativePath, file] as const),
  );
  try {
    const initialState = await loadState(runtime.store, runtime.tenantId);
    const currentBase = initialState.bases[runtime.baseId];
    if (!currentBase || currentBase.status === 'deleted') {
      await finishJob(runtime.store, runtime.tenantId, job, 'cancelled');
      return;
    }
    const validatedRoot = await grantRoot(initialState, job.sourceGrantId);
    if (validatedRoot !== runtime.root) throw new Error('Knowledge source root changed; compilation was stopped for revalidation');
    job = await persistJob(runtime.store, runtime.tenantId, job, { status: 'scanning', stage: 'scanning', currentFile: undefined });
    if (job.status === 'paused' || job.status === 'cancelled') return;
    const skippedDuringDiscovery: Array<{ path: string; reason: string; bytes?: number }> = [];
    await discoverFiles(runtime.root, async (file) => {
      const live = await getKnowledgeJob(runtime.store, runtime.jobId, runtime.tenantId);
      if (live?.status === 'cancelled' || live?.requestedAction === 'cancel') throw new JobControlError('cancelled');
      if (live?.status === 'paused' || live?.requestedAction === 'pause') throw new JobControlError('paused');
      runtime.manifest.push(file);
    }, (relativePath, reason, bytes) => { runtime.stats.skippedFiles += 1; if (bytes) runtime.stats.skippedBytes += bytes; skippedDuringDiscovery.push({ path: relativePath, reason, ...(bytes === undefined ? {} : { bytes }) }); });
    runtime.stats.skippedReasons.push(...skippedDuringDiscovery);
    if (job.persistPending) {
      const recovered: CollectedKnowledgeFile[] = [];
      for (const manifest of runtime.manifest) {
        const pending = checkpointByPath.get(manifest.relativePath);
        const restored = pending ? collectedFromPending(pending) : null;
        if (restored && restored.sizeBytes === manifest.sizeBytes) {
          const current = await stat(manifest.absolutePath).catch(() => null);
          if (current?.isFile() && current.size === manifest.sizeBytes && current.mtime.toISOString() === restored.sourceUpdatedAt) {
            recovered.push(restored);
          }
        }
      }
      runtime.files.push(...recovered);
      runtime.totalBytes = recovered.reduce((sum, file) => sum + file.indexedBytes, 0);
    }
    job = await persistJob(runtime.store, runtime.tenantId, job, { status: 'extracting', stage: 'extracting', totalFiles: runtime.manifest.length + runtime.stats.skippedFiles, skippedFiles: runtime.stats.skippedFiles, skippedBytes: runtime.stats.skippedBytes, ...(job.persistPending ? { pendingFiles: runtime.manifest.map((file) => {
      const previous = checkpointByPath.get(file.relativePath);
      const restored = previous ? collectedFromPending(previous) : null;
      return restored && restored.sizeBytes === file.sizeBytes ? pendingFileFromCollected(restored) : { relativePath: file.relativePath, sizeBytes: file.sizeBytes, stage: 'queued' as const };
    }) } : {}) });
    if (job.status === 'paused' || job.status === 'cancelled') return;
    for (let index = 0; index < runtime.manifest.length; index += 1) {
      const manifest = runtime.manifest[index]!;
      job = await getKnowledgeJob(runtime.store, runtime.jobId, runtime.tenantId) ?? job;
      if (job.requestedAction === 'cancel' || job.status === 'cancelled') {
        await finishJob(runtime.store, runtime.tenantId, job, 'cancelled');
        return;
      }
      if (job.status === 'paused') return;
      const checkpoint = checkpointByPath.get(manifest.relativePath);
      const restored = checkpoint ? collectedFromPending(checkpoint) : null;
      if (restored && runtime.files.some((item) => item.relativePath === manifest.relativePath && item.contentHash === restored.contentHash)) {
        job = await persistJob(runtime.store, runtime.tenantId, job, {
          status: 'indexing',
          stage: 'indexing',
          indexedFiles: runtime.files.length,
          indexedBytes: runtime.totalBytes,
          processedFiles: index + 1,
          currentFile: undefined,
          ...(job.persistPending ? { pendingFiles: runtime.manifest.map((item) => {
            const saved = checkpointByPath.get(item.relativePath);
            const recoveredFile = saved ? collectedFromPending(saved) : null;
            return recoveredFile && runtime.files.some((entry) => entry.relativePath === item.relativePath && entry.contentHash === recoveredFile.contentHash)
              ? pendingFileFromCollected(recoveredFile)
              : { relativePath: item.relativePath, sizeBytes: item.sizeBytes, stage: 'queued' as const };
          }) } : {}),
        });
        await yieldControl();
        continue;
      }
      job = await persistJob(runtime.store, runtime.tenantId, job, { status: 'extracting', stage: 'extracting', currentFile: manifest.relativePath, processedFiles: index, skippedFiles: runtime.stats.skippedFiles, skippedBytes: runtime.stats.skippedBytes });
      const latestStat = await stat(manifest.absolutePath).catch(() => null);
      if (latestStat?.isFile() && latestStat.size !== manifest.sizeBytes) {
        manifest.sizeBytes = latestStat.size;
        job = addError(job, 'scanning', 'source_changed_requeued', 'Source file changed; the current file was re-queued with its latest metadata.', manifest.relativePath);
        job = await persistJob(runtime.store, runtime.tenantId, job, { errors: job.errors });
      }
      const file = await extractFile(runtime, manifest);
      if (file) {
        runtime.files.push(file);
        job = await persistJob(runtime.store, runtime.tenantId, job, { status: 'indexing', stage: 'indexing', indexedFiles: runtime.files.length, indexedBytes: runtime.files.reduce((sum, item) => sum + item.indexedBytes, 0), truncated: runtime.stats.truncated, ...(job.persistPending ? { pendingFiles: runtime.manifest.map((item, itemIndex) => {
          const prior = itemIndex < index ? checkpointByPath.get(item.relativePath) : undefined;
          const priorFile = prior ? collectedFromPending(prior) : null;
          if (itemIndex === index) return pendingFileFromCollected(file, 'indexing');
          if (priorFile && runtime.files.some((entry) => entry.relativePath === item.relativePath && entry.contentHash === priorFile.contentHash)) return pendingFileFromCollected(priorFile);
          return { relativePath: item.relativePath, sizeBytes: item.sizeBytes, stage: 'queued' as const };
        }) } : {}) });
      } else {
        const skippedReason = runtime.stats.skippedReasons.at(-1)?.reason ?? 'file_skipped';
        job = addError(job, 'extracting', skippedReason.split(':', 1)[0] ?? 'file_skipped', skippedReason, manifest.relativePath);
        job = await persistJob(runtime.store, runtime.tenantId, job, { skippedFiles: runtime.stats.skippedFiles, skippedBytes: runtime.stats.skippedBytes, truncated: runtime.stats.truncated, errors: job.errors, ...(job.persistPending ? { pendingFiles: runtime.manifest.map((item, itemIndex) => ({ relativePath: item.relativePath, sizeBytes: item.sizeBytes, stage: itemIndex <= index ? 'skipped' as const : 'queued' as const, ...(itemIndex === index ? { failure: skippedReason } : {}) })) } : {}) });
      }
      job = await persistJob(runtime.store, runtime.tenantId, job, { processedFiles: index + 1, currentFile: undefined });
      if (job.requestedAction === 'pause') {
        await finishJob(runtime.store, runtime.tenantId, job, 'paused');
        return;
      }
      await yieldControl();
    }
    job = await persistJob(runtime.store, runtime.tenantId, job, { status: 'finalizing', stage: 'finalizing', currentFile: undefined, processedFiles: runtime.manifest.length });
    const snapshotId = `snap_${randomUUID()}`;
    const createdAt = now();
    await withCatalogLock(runtime.store, async () => {
      const state = await loadState(runtime.store, runtime.tenantId);
      const currentJob = state.jobs[runtime.jobId];
      const base = state.bases[runtime.baseId];
      if (!currentJob || currentJob.requestedAction === 'cancel' || currentJob.status === 'cancelled' || !base || base.status === 'deleted') {
        if (currentJob) state.jobs[runtime.jobId] = { ...currentJob, status: 'cancelled', stage: 'cancelled', currentFile: undefined, updatedAt: now(), completedAt: now() };
        await saveState(runtime.store, state, runtime.tenantId, false, { rebuildIndex: false });
        return;
      }
      const snapshot = snapshotFromFiles(base, runtime.root, runtime.files, runtime.stats, snapshotId, createdAt);
      state.snapshots[snapshotId] = snapshot;
      const removed = pruneSnapshots(state, base.knowledgeBaseId);
      const updatedBase = { ...base, status: 'active' as const, currentSnapshotId: snapshotId, updatedAt: now(), version: base.version + 1 };
      state.bases[base.knowledgeBaseId] = updatedBase;
      state.jobs[runtime.jobId] = { ...currentJob, status: 'completed', stage: 'completed', currentFile: undefined, processedFiles: runtime.manifest.length, indexedFiles: runtime.files.length, indexedBytes: snapshot.indexStats?.indexedBytes ?? 0, skippedFiles: snapshot.indexStats?.skippedFiles ?? 0, skippedBytes: snapshot.indexStats?.skippedBytes ?? 0, truncated: snapshot.indexStats?.truncated ?? false, snapshotId, updatedAt: now(), completedAt: now(), ...(currentJob.persistPending ? { pendingFiles: [] } : {}) };
      void removed;
      await saveState(runtime.store, state, runtime.tenantId, false, { appendSnapshotId: snapshotId, removeSnapshotIds: removed });
    });
  } catch (error) {
    if (error instanceof JobControlError) {
      const current = await getKnowledgeJob(runtime.store, runtime.jobId, runtime.tenantId);
      if (current) await finishJob(runtime.store, runtime.tenantId, current, error.terminalStatus);
      return;
    }
    const current = await getKnowledgeJob(runtime.store, runtime.jobId, runtime.tenantId);
    if (current) {
      const failed = addError({ ...current, status: 'failed', stage: 'failed', currentFile: current.currentFile }, 'failed', 'compile_failed', error instanceof Error ? error.message : String(error), current.currentFile);
      await persistJob(runtime.store, runtime.tenantId, failed, { status: 'failed', stage: 'failed', currentFile: undefined, errors: failed.errors, completedAt: now() });
    }
  }
}

async function finishJob(store: ThreadStore, tenantId: string, job: KnowledgeCompileJob, status: 'paused' | 'cancelled'): Promise<void> {
  await persistJob(store, tenantId, job, { status, stage: status, currentFile: undefined, requestedAction: undefined, completedAt: status === 'cancelled' ? now() : undefined });
}

async function launchJob(store: ThreadStore, tenantId: string, job: KnowledgeCompileJob, root: string): Promise<void> {
  if (runners.has(job.jobId)) return;
  const runtime: JobRuntime = { store, tenantId, jobId: job.jobId, baseId: job.knowledgeBaseId, root, manifest: [], files: [], stats: emptyStats(), totalBytes: 0 };
  const runner = executeJob(runtime).finally(() => { runners.delete(job.jobId); if (activeByBase.get(job.knowledgeBaseId) === job.jobId) activeByBase.delete(job.knowledgeBaseId); });
  runners.set(job.jobId, runner);
  activeByBase.set(job.knowledgeBaseId, job.jobId);
  await runner;
}

function scheduleJob(store: ThreadStore, tenantId: string, job: KnowledgeCompileJob, root: string): void {
  // The personal catalog has one SQLite/JSON index. Keep compilation jobs
  // serial even when two bases are queued from separate UI actions.
  compileTail = compileTail.catch(() => undefined).then(async () => {
    const current = await getKnowledgeJob(store, job.jobId, tenantId);
    if (!current || ['paused', 'cancelled', 'completed', 'failed'].includes(current.status)) return;
    await launchJob(store, tenantId, current, root);
  });
}

/** Re-queue non-terminal compile jobs after an API restart. Persisted jobs are
 * the source of truth; a new in-memory runner is attached lazily on the first
 * knowledge route request, so no background service is required at startup. */
export async function recoverKnowledgeCompileJobs(store: ThreadStore, tenantId: string): Promise<void> {
  if (recoveredStores.has(store as object)) return;
  recoveredStores.add(store as object);
  const state = await loadState(store, tenantId);
  for (const job of Object.values(state.jobs)) {
    if (isTerminal(job.status) || job.status === 'paused') continue;
    const root = await grantRoot(state, job.sourceGrantId).catch(() => null);
    if (!root) {
      await persistJob(store, tenantId, job, {
        status: 'failed',
        stage: 'failed',
        errors: addError(job, 'failed', 'source_unavailable', 'Knowledge source authorization is no longer available.').errors,
        completedAt: now(),
      });
      continue;
    }
    scheduleJob(store, tenantId, job, root);
  }
}

export async function startKnowledgeBaseCreateJob(store: ThreadStore, tenantId: string, input: { name: string; sourceGrantId: string; persistPending?: boolean }): Promise<KnowledgeJobResult> {
  return withCatalogLock(store, async () => {
    const state = await loadState(store, tenantId);
    const grant = state.grants[input.sourceGrantId];
    if (!grant || grant.revokedAt) throw new Error('Knowledge directory authorization is unavailable');
    const root = await grantRoot(state, grant.grantId);
    const timestamp = now();
    const base = createBase(grant, input.name, timestamp);
    const job = createJob(base, grant, root, 'create', input.persistPending === true, timestamp);
    state.bases[base.knowledgeBaseId] = base;
    state.jobs[job.jobId] = job;
    await saveState(store, state, tenantId, false, { rebuildIndex: false });
    scheduleJob(store, tenantId, job, root);
    return { base, job: publicJob(job) };
  });
}

export async function startKnowledgeBaseSyncJob(store: ThreadStore, tenantId: string, knowledgeBaseId: string, persistPending = false): Promise<KnowledgeJobResult> {
  return withCatalogLock(store, async () => {
    const state = await loadState(store, tenantId);
    const base = state.bases[knowledgeBaseId];
    if (!base || base.status === 'deleted') throw new Error('KnowledgeBase not found');
    const grantId = base.source?.grantId;
    if (!grantId) throw new Error('Knowledge directory authorization is unavailable');
    const root = await grantRoot(state, grantId);
    const existing = activeJob(state, knowledgeBaseId);
    if (existing) {
      if (existing.status !== 'paused' && !runners.has(existing.jobId)) scheduleJob(store, tenantId, existing, root);
      return { base, job: existing };
    }
    const timestamp = now();
    const updatedBase = { ...base, status: 'syncing' as const, updatedAt: timestamp, version: base.version + 1 };
    const grant = state.grants[grantId]!;
    const job = createJob(updatedBase, grant, root, 'sync', persistPending, timestamp);
    state.bases[knowledgeBaseId] = updatedBase;
    state.jobs[job.jobId] = job;
    await saveState(store, state, tenantId, false, { rebuildIndex: false });
    scheduleJob(store, tenantId, job, root);
    return { base: updatedBase, job: publicJob(job) };
  });
}

export async function getKnowledgeJob(store: ThreadStore, jobId: string, tenantId?: string): Promise<KnowledgeCompileJob | null> {
  const state = await loadState(store, tenantId);
  return state.jobs[jobId] ?? null;
}

export async function getKnowledgeBaseJob(store: ThreadStore, knowledgeBaseId: string, tenantId?: string): Promise<KnowledgeCompileJob | null> {
  const state = await loadState(store, tenantId);
  return Object.values(state.jobs).filter((job) => job.knowledgeBaseId === knowledgeBaseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export async function actOnKnowledgeJob(store: ThreadStore, tenantId: string, jobId: string, action: KnowledgeCompileJobAction): Promise<KnowledgeCompileJob> {
  return withCatalogLock(store, async () => {
    const state = await loadState(store, tenantId);
    const job = state.jobs[jobId];
    if (!job) throw new Error('Knowledge compile job not found');
    if (action === 'pause') {
      if (isTerminal(job.status)) return job;
      if (!runners.has(job.jobId) && job.status === 'queued') {
        const paused = { ...job, status: 'paused' as const, stage: 'paused' as const, updatedAt: now() };
        state.jobs[jobId] = paused;
        await saveState(store, state, tenantId, false, { rebuildIndex: false });
        return paused;
      }
      const requested = { ...job, requestedAction: 'pause' as const, updatedAt: now() };
      state.jobs[jobId] = requested;
      await saveState(store, state, tenantId, false, { rebuildIndex: false });
      return requested;
    }
    if (action === 'cancel') {
      if (isTerminal(job.status)) return job;
      const base = state.bases[job.knowledgeBaseId];
      const cancelled = { ...job, status: 'cancelled' as const, stage: 'cancelled' as const, requestedAction: undefined, currentFile: undefined, updatedAt: now(), completedAt: now() };
      state.jobs[jobId] = cancelled;
      if (base && base.status !== 'deleted') state.bases[base.knowledgeBaseId] = { ...base, status: 'active', updatedAt: now(), version: base.version + 1 };
      await saveState(store, state, tenantId, false, { rebuildIndex: false });
      return cancelled;
    }
    if (job.status !== 'paused') throw new Error('Only a paused knowledge compile job can be resumed');
    const root = await grantRoot(state, job.sourceGrantId);
    const base = state.bases[job.knowledgeBaseId];
    if (!base || base.status === 'deleted') throw new Error('KnowledgeBase not found');
    // Keep the immutable, redacted checkpoint. executeJob revalidates each
    // indexed entry against the source before reusing it; changed entries are
    // re-extracted and replace their checkpoint in place.
    const checkpoint = job.persistPending ? (job.pendingFiles ?? []) : undefined;
    const resumed = { ...job, status: 'queued' as const, stage: 'queued' as const, canonicalRoot: root, requestedAction: undefined, currentFile: undefined, processedFiles: 0, indexedFiles: checkpoint?.filter((file) => file.stage === 'indexed').length ?? 0, indexedBytes: checkpoint?.reduce((sum, file) => sum + (file.indexedBytes ?? 0), 0) ?? 0, skippedFiles: 0, skippedBytes: 0, truncated: false, pendingFiles: checkpoint, updatedAt: now(), completedAt: undefined };
    state.jobs[jobId] = resumed;
    state.bases[base.knowledgeBaseId] = { ...base, status: 'syncing', updatedAt: now(), version: base.version + 1 };
    await saveState(store, state, tenantId, false, { rebuildIndex: false });
    scheduleJob(store, tenantId, resumed, root);
    return resumed;
  });
}

export async function cancelKnowledgeJobsForBase(store: ThreadStore, tenantId: string, knowledgeBaseId: string): Promise<void> {
  const state = await loadState(store, tenantId);
  const jobs = Object.values(state.jobs).filter((job) => job.knowledgeBaseId === knowledgeBaseId && !isTerminal(job.status));
  for (const job of jobs) await actOnKnowledgeJob(store, tenantId, job.jobId, 'cancel');
}
