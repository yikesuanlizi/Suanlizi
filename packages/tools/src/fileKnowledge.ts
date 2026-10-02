import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { FileFingerprint } from '@suanlizi/protocol';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export async function computeFileFingerprint(workspaceRoot: string, inputPath: string): Promise<FileFingerprint> {
  const absolutePath = resolveWorkspacePath(workspaceRoot, inputPath);
  const buffer = await fs.readFile(absolutePath);
  const stat = await fs.stat(absolutePath);
  const root = workspaceRoot ? path.resolve(workspaceRoot) : '';
  const relativePath = root ? path.relative(root, absolutePath).replace(/\\/g, '/') : '';
  return {
    path: absolutePath,
    relativePath: relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
      ? relativePath
      : undefined,
    workspaceRoot: root || undefined,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    contentType: detectContentType(absolutePath),
    observedAt: new Date().toISOString(),
  };
}

export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
  return path.resolve(workspaceRoot, inputPath);
}

export function detectContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.docx':
      return DOCX_TYPE;
    case '.pdf':
      return 'application/pdf';
    case '.xlsx':
      return XLSX_TYPE;
    case '.pptx':
      return PPTX_TYPE;
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.json':
      return 'application/json';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.csv':
      return 'text/csv';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

export function isDocumentFile(filePath: string): boolean {
  return ['.docx', '.pdf', '.xlsx', '.pptx'].includes(path.extname(filePath).toLowerCase());
}

export function artifactRoot(workspaceRoot: string): string {
  const configured = process.env.SUANLIZI_DATA_DIR?.trim();
  return configured
    ? path.join(configured, 'artifacts', path.basename(path.resolve(workspaceRoot)) || 'default')
    : path.join(os.tmpdir(), 'suanlizi', path.basename(path.resolve(workspaceRoot)) || 'default', 'artifacts');
}

export function artifactDocumentsDir(workspaceRoot: string): string {
  return path.join(artifactRoot(workspaceRoot), 'documents');
}

export function artifactIndexPath(workspaceRoot: string): string {
  return path.join(artifactRoot(workspaceRoot), 'index.json');
}

export function relativeToWorkspace(workspaceRoot: string, absolutePath: string): string | undefined {
  const root = path.resolve(workspaceRoot);
  const relativePath = path.relative(root, path.resolve(absolutePath)).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;
  return relativePath;
}
