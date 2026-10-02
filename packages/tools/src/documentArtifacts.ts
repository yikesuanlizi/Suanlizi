import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  DocumentArtifactRecord,
  DocumentExtractor,
  FileFingerprint,
  FileFreshness,
} from '@suanlizi/protocol';
import {
  artifactDocumentsDir,
  artifactIndexPath,
  computeFileFingerprint,
  relativeToWorkspace,
} from './fileKnowledge.js';
import { extractorForDocumentPath } from './documentExtractors.js';

export interface DocumentArtifactLedger {
  version: 1;
  records: DocumentArtifactRecord[];
}

export const EXTERNAL_SCRIPT_EXTRACTOR_VERSION = 'external-script';

export async function loadDocumentArtifactLedger(workspaceRoot: string): Promise<DocumentArtifactLedger> {
  try {
    const raw = await fs.readFile(artifactIndexPath(workspaceRoot), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DocumentArtifactLedger>;
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
    throw error;
  }
}

export async function saveDocumentArtifactRecord(workspaceRoot: string, record: DocumentArtifactRecord): Promise<void> {
  const indexPath = artifactIndexPath(workspaceRoot);
  const ledger = await loadDocumentArtifactLedger(workspaceRoot);
  const normalizedArtifact = path.resolve(record.artifactPath);
  const withoutPrevious = ledger.records.filter((entry) => path.resolve(entry.artifactPath) !== normalizedArtifact);
  const next: DocumentArtifactLedger = { version: 1, records: [...withoutPrevious, record] };
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(next, null, 2), 'utf-8');
}

export function findArtifactByPath(ledger: DocumentArtifactLedger, artifactPath: string): DocumentArtifactRecord | undefined {
  const normalized = path.resolve(artifactPath);
  return ledger.records.find((entry) => path.resolve(entry.artifactPath) === normalized);
}

export function findArtifactBySource(
  ledger: DocumentArtifactLedger,
  sourcePath: string,
  extractor: DocumentExtractor,
  extractorVersion: string,
): DocumentArtifactRecord | undefined {
  const normalized = path.resolve(sourcePath);
  return ledger.records.find((entry) => (
    path.resolve(entry.sourcePath) === normalized
    && entry.extractor === extractor
    && entry.extractorVersion === extractorVersion
  ));
}

export async function registerExternalDocumentArtifactsFromText(
  workspaceRoot: string,
  text: string,
): Promise<DocumentArtifactRecord[]> {
  const sourcePaths = uniqueResolvedPaths(
    workspaceRoot,
    collectPathsWithExtensions(text, ['.docx', '.pdf', '.xlsx', '.pptx']),
  );
  if (sourcePaths.length !== 1) return [];

  const artifactPaths = uniqueResolvedPaths(
    workspaceRoot,
    collectPathsWithExtensions(text, ['.txt', '.md', '.markdown']),
  ).filter((candidate) => path.resolve(candidate) !== path.resolve(sourcePaths[0]));
  if (artifactPaths.length === 0) return [];

  const source = await computeFileFingerprint(workspaceRoot, sourcePaths[0]);
  const extractor = extractorForDocumentPath(source.path);
  const createdAt = new Date().toISOString();
  const records: DocumentArtifactRecord[] = [];
  const ledger = await loadDocumentArtifactLedger(workspaceRoot);

  for (const artifactPath of artifactPaths) {
    if (findArtifactByPath(ledger, artifactPath)) continue;
    let artifact: FileFingerprint;
    try {
      artifact = await computeFileFingerprint(workspaceRoot, artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const record = artifactRecordForResult({
      workspaceRoot,
      source,
      artifactPath: artifact.path,
      artifactHash: artifact.sha256,
      extractor,
      extractorVersion: EXTERNAL_SCRIPT_EXTRACTOR_VERSION,
      createdAt,
    });
    await saveDocumentArtifactRecord(workspaceRoot, record);
    records.push(record);
  }

  return records;
}

export async function documentArtifactPathForSource(
  workspaceRoot: string,
  source: FileFingerprint,
  extractor: DocumentExtractor,
  extractorVersion: string,
): Promise<string> {
  const key = `${source.path}\n${source.sha256}\n${extractor}\n${extractorVersion}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  const basename = path.basename(source.path, path.extname(source.path)).replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return path.join(artifactDocumentsDir(workspaceRoot), `${basename}.${hash}.md`);
}

export async function assessArtifactFreshness(
  workspaceRoot: string,
  record: DocumentArtifactRecord,
): Promise<FileFreshness> {
  try {
    await fs.stat(record.artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return stale(record, 'artifact_missing');
    }
    throw error;
  }

  let source: FileFingerprint;
  try {
    source = await computeFileFingerprint(workspaceRoot, record.sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return stale(record, 'source_missing');
    }
    throw error;
  }

  if (
    source.sha256 !== record.sourceHash
    || source.sizeBytes !== record.sourceSizeBytes
    || source.mtimeMs !== record.sourceMtimeMs
  ) {
    return stale(record, 'source_hash_changed');
  }

  return {
    status: 'fresh',
    sourcePath: record.sourcePath,
    artifactPath: record.artifactPath,
    recommendedTool: 'read_document',
  };
}

export async function updateArtifactLastUsed(
  workspaceRoot: string,
  artifactPath: string,
  usedAt = new Date().toISOString(),
): Promise<void> {
  const ledger = await loadDocumentArtifactLedger(workspaceRoot);
  const normalized = path.resolve(artifactPath);
  const records = ledger.records.map((entry) => (
    path.resolve(entry.artifactPath) === normalized ? { ...entry, lastUsedAt: usedAt } : entry
  ));
  await fs.mkdir(path.dirname(artifactIndexPath(workspaceRoot)), { recursive: true });
  await fs.writeFile(artifactIndexPath(workspaceRoot), JSON.stringify({ version: 1, records }, null, 2), 'utf-8');
}

export function artifactRecordForResult(input: {
  workspaceRoot: string;
  source: FileFingerprint;
  artifactPath: string;
  artifactHash: string;
  extractor: DocumentExtractor;
  extractorVersion: string;
  createdAt: string;
}): DocumentArtifactRecord {
  return {
    artifactPath: input.artifactPath,
    artifactRelativePath: relativeToWorkspace(input.workspaceRoot, input.artifactPath),
    artifactHash: input.artifactHash,
    artifactKind: 'document_text',
    sourcePath: input.source.path,
    sourceRelativePath: input.source.relativePath,
    sourceHash: input.source.sha256,
    sourceSizeBytes: input.source.sizeBytes,
    sourceMtimeMs: input.source.mtimeMs,
    extractor: input.extractor,
    extractorVersion: input.extractorVersion,
    createdAt: input.createdAt,
  };
}

function stale(record: DocumentArtifactRecord, reason: NonNullable<FileFreshness['reason']>): FileFreshness {
  return {
    status: reason === 'source_missing' ? 'missing' : 'stale',
    sourcePath: record.sourcePath,
    artifactPath: record.artifactPath,
    reason,
    recommendedTool: 'read_document',
  };
}

function collectPathsWithExtensions(text: string, extensions: string[]): string[] {
  const extensionPattern = extensions.map((extension) => extension.replace('.', '\\.')).join('|');
  const quotedPattern = new RegExp(`["']([^"']+(?:${extensionPattern}))["']`, 'giu');
  const unquotedPattern = new RegExp(`(?:[A-Za-z]:[\\\\/][^\\s"'<>|]+|\\.{1,2}[\\\\/][^\\s"'<>|]+|[^\\s"'<>|]+)(?:${extensionPattern})`, 'giu');
  const paths: string[] = [];
  for (const match of text.matchAll(quotedPattern)) {
    if (match[1]) paths.push(cleanPathCandidate(match[1]));
  }
  for (const match of text.matchAll(unquotedPattern)) {
    if (match[0]) paths.push(cleanPathCandidate(match[0]));
  }
  return paths;
}

function cleanPathCandidate(value: string): string {
  return value.replace(/^[`([{]+/u, '').replace(/[，。；、,.!?:;）)\]}`]+$/u, '');
}

function uniqueResolvedPaths(workspaceRoot: string, candidates: string[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(path.isAbsolute(candidate) ? candidate : path.join(workspaceRoot, candidate));
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(resolved);
  }
  return paths;
}
