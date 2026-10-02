import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { sendError, sendJson } from '../shared/http.js';

// 忽略的目录列表（构建产物/缓存等） — Chinese: ignored directories (build artifacts, caches)
const IGNORED_DIRS = new Set([
  '.suanlizi',
  '.cache',
  '.git',
  '.mypy_cache',
  '.next',
  '.pytest_cache',
  '.ruff_cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'env',
  'node_modules',
  'out',
  'target',
  'venv',
]);
const MAX_ENTRIES = 400; // 目录条目上限 — Chinese: max directory entries
const MAX_SEARCH_RESULTS = 1000; // 搜索结果上限 — Chinese: max search results
const MAX_PREVIEW_BYTES = 96 * 1024; // 预览字节上限 — Chinese: max preview bytes

// 预览类型 — Chinese: preview types
type PreviewType = 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'office' | 'binary';

// Markdown 扩展名集合 — Chinese: markdown extensions
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
// HTML 扩展名集合 — Chinese: HTML extensions
const HTML_EXTENSIONS = new Set(['html', 'htm']);
// 图片 MIME 类型映射 — Chinese: image MIME type map
const IMAGE_MIME_TYPES = new Map([
  ['apng', 'image/apng'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['gif', 'image/gif'],
  ['ico', 'image/x-icon'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
]);
// Office MIME 类型映射 — Chinese: office MIME type map
const OFFICE_MIME_TYPES = new Map([
  ['csv', 'text/csv; charset=utf-8'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);
// 支持预览的 Office 扩展名 — Chinese: office extensions supported for preview
const OFFICE_PREVIEW_EXTENSIONS = new Set(['csv', 'docx', 'xls', 'xlsx']);
// 文件类型别名（中英文混合，便于模糊搜索匹配） — Chinese: file type aliases (mixed Chinese/English for fuzzy search)
const FILE_TYPE_ALIASES = new Map([
  ['csv', 'excel spreadsheet sheet table office 表格 电子表格'],
  ['doc', 'word document office 文档'],
  ['docx', 'word document office 文档'],
  ['odp', 'powerpoint presentation slides office 演示 幻灯片'],
  ['ods', 'excel spreadsheet sheet table office 表格 电子表格'],
  ['odt', 'word document office 文档'],
  ['pdf', 'pdf document report paper 报告 文档'],
  ['ppt', 'powerpoint presentation slides office 演示 幻灯片'],
  ['pptx', 'powerpoint presentation slides office 演示 幻灯片'],
  ['rtf', 'word document office 文档'],
  ['xls', 'excel spreadsheet sheet table office 表格 电子表格'],
  ['xlsx', 'excel spreadsheet sheet table office 表格 电子表格'],
]);
for (const extension of IMAGE_MIME_TYPES.keys()) {
  FILE_TYPE_ALIASES.set(extension, `image picture photo ${extension} 图片 图像 照片`);
}

// 工作区文件条目（目录或文件） — Chinese: workspace file entry (directory or file)
export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  size: number;
  updatedAt: string;
  extension?: string;
}

// 工作区搜索结果 — Chinese: workspace search result
interface WorkspaceSearchResult {
  entries: WorkspaceFileEntry[];
  entriesByPath: Record<string, WorkspaceFileEntry[]>;
  expandedPaths: string[];
}

// 将根目录与相对路径解析成绝对路径，并防止路径逃逸
// — Chinese: resolve root + relative path into absolute path (prevents escaping the workspace root)
function resolveWorkspacePath(root: string | null, relativePath: string | null): { root: string; target: string; relativePath: string } {
  const rootInput = root?.trim();
  if (!rootInput) throw new Error('Workspace root is required');
  const resolvedRoot = path.resolve(rootInput);
  const cleanRelative = (relativePath ?? '').replace(/^[\\/]+/, '');
  const target = path.resolve(resolvedRoot, cleanRelative);
  const resolvedRelative = path.relative(resolvedRoot, target);
  if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) throw new Error('Path escapes workspace root');
  return { root: resolvedRoot, target, relativePath: resolvedRelative.replace(/\\/g, '/') };
}

// 判断缓冲区是否大概率为可打印文本（无 NUL 字节，前 4096 字节中非法字符少于 8 个）
// — Chinese: check if buffer is printable text (no NUL bytes, fewer than 8 non-printable chars in first 4096)
function isProbablyText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  return sample.replace(/[\t\n\r -~\u00a0-\uffff]/g, '').length < 8;
}

// 获取文件扩展名（小写，去除点） — Chinese: get file extension lowercased without the dot
function getExtension(target: string): string {
  return path.extname(target).slice(1).toLowerCase();
}

// 根据扩展名推导 MIME 类型 — Chinese: derive MIME type from extension
function getMimeType(extension: string): string {
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'text/markdown; charset=utf-8';
  if (IMAGE_MIME_TYPES.has(extension)) return IMAGE_MIME_TYPES.get(extension)!;
  if (extension === 'pdf') return 'application/pdf';
  if (OFFICE_MIME_TYPES.has(extension)) return OFFICE_MIME_TYPES.get(extension)!;
  if (['json', 'jsonl'].includes(extension)) return 'application/json; charset=utf-8';
  if (['html', 'htm'].includes(extension)) return 'text/html; charset=utf-8';
  if (extension === 'css') return 'text/css; charset=utf-8';
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs') return 'text/javascript; charset=utf-8';
  if (extension === 'ts' || extension === 'tsx' || extension === 'jsx') return 'text/plain; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

// 拼接原始文件预览 URL — Chinese: build raw file preview URL
function rawUrl(root: string, relativePath: string): string {
  return `/api/workspaces/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relativePath)}`;
}

// 对文件名进行 URI 安全编码（额外处理引号/括号等） — Chinese: URI-encode filename for headers (escape quotes/parens too)
function encodeHeaderFilename(name: string): string {
  return encodeURIComponent(name)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

// 生成 ASCII 回退文件名（用下划线替换非 ASCII 字符） — Chinese: generate ASCII-only fallback filename with underscores
function asciiHeaderFilename(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '').trim();
  return fallback || 'file';
}

// 构建一个工作区文件条目（目录或文件） — Chinese: build one workspace file entry (directory or file)
async function buildFileEntry(root: string, absolute: string, kind: 'directory' | 'file'): Promise<WorkspaceFileEntry> {
  const entryStat = await fs.stat(absolute);
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  return {
    name: path.basename(absolute),
    path: relative,
    kind,
    size: entryStat.size,
    updatedAt: entryStat.mtime.toISOString(),
    extension: kind === 'file' ? path.extname(absolute).slice(1).toLowerCase() : undefined,
  };
}

// tryBuildFileEntry：捕获异常并返回 null — Chinese: try build file entry, swallowing errors
async function tryBuildFileEntry(root: string, absolute: string, kind: 'directory' | 'file'): Promise<WorkspaceFileEntry | null> {
  try {
    return await buildFileEntry(root, absolute, kind);
  } catch {
    return null;
  }
}

// 判断文件条目是否与查询字符串匹配（名称/路径/扩展名/别名 之一匹配）
// — Chinese: match file entry against query string (name/path/extension/aliases)
function matchesFileQuery(entry: WorkspaceFileEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const extension = entry.extension ? `.${entry.extension}\n${entry.extension}` : '';
  const aliases = entry.extension ? FILE_TYPE_ALIASES.get(entry.extension) ?? '' : '';
  return `${entry.name}\n${entry.path}\n${extension}\n${aliases}`.toLowerCase().includes(normalized);
}

// 生成相对路径的所有父级路径（含空根） — Chinese: generate all parent paths for a relative path (including empty root)
function parentPathsForEntry(relativePath: string): string[] {
  const parts = relativePath.split('/').filter(Boolean);
  const parents = [''];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join('/'));
  }
  return parents;
}

// 安全读取目录：忽略异常，返回空列表 — Chinese: safely read directory, ignore errors, return empty list
async function safeReadDir(target: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

// 条目排序：先目录后文件，再按名称本地化比较 — Chinese: sort entries: directories first, then by name locale-compare
function sortEntries(entries: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  return entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
}

// 在工作区内递归搜索与查询匹配的条目，并返回按路径分组结果及展开路径集合
// — Chinese: recursively search workspace entries, returning path-grouped results + expanded paths
async function searchWorkspaceEntries(root: string, target: string, query: string): Promise<WorkspaceSearchResult> {
  const matches: WorkspaceFileEntry[] = [];
  const scannedByPath = new Map<string, WorkspaceFileEntry[]>();

  async function visit(directory: string): Promise<void> {
    if (matches.length >= MAX_SEARCH_RESULTS) return;
    const parentRelative = path.relative(root, directory).replace(/\\/g, '/');
    const parentKey = parentRelative === '.' ? '' : parentRelative;
    const dirents = await safeReadDir(directory);
    const children: WorkspaceFileEntry[] = [];

    for (const entry of dirents) {
      if (matches.length >= MAX_SEARCH_RESULTS) break;
      if (entry.isSymbolicLink()) continue; // 忽略符号链接 — Chinese: skip symlinks
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const kind = entry.isDirectory() ? 'directory' : 'file';
      const fileEntry = await tryBuildFileEntry(root, absolute, kind);
      if (!fileEntry) continue;
      children.push(fileEntry);
      if (matchesFileQuery(fileEntry, query)) matches.push(fileEntry);
      if (fileEntry.kind === 'directory') await visit(absolute); // 递归子目录 — Chinese: recurse into subdirectories
    }

    scannedByPath.set(parentKey, sortEntries(children));
  }

  await visit(target);
  matches.sort((a, b) => a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1);

  // 推导需要展开以显示匹配项的路径集合 — Chinese: compute expanded path set for displaying matches
  const expandedPathSet = new Set<string>(['']);
  const relevantParentSet = new Set<string>(['']);
  const matchPaths = new Set(matches.map((entry) => entry.path));
  for (const match of matches) {
    for (const parent of parentPathsForEntry(match.path)) {
      expandedPathSet.add(parent);
      relevantParentSet.add(parent);
    }
    if (match.kind === 'directory') {
      expandedPathSet.add(match.path);
      relevantParentSet.add(match.path);
    }
  }

  function isRelevantChild(entry: WorkspaceFileEntry): boolean {
    if (matchPaths.has(entry.path)) return true;
    return matches.some((match) => match.path.startsWith(`${entry.path}/`));
  }

  const entriesByPath: Record<string, WorkspaceFileEntry[]> = {};
  for (const parent of relevantParentSet) {
    entriesByPath[parent] = (scannedByPath.get(parent) ?? []).filter(isRelevantChild);
  }

  return {
    entries: matches,
    entriesByPath,
    expandedPaths: [...expandedPathSet],
  };
}

// 读取文件的前 N 字节（不超过预览上限） — Chinese: read first N bytes of a file (up to preview limit)
async function readPreviewBytes(target: string, size: number): Promise<Buffer> {
  const handle = await fs.open(target, 'r');
  try {
    const length = Math.min(size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

// 提取 Office/表格类型文件的文本预览（docx/csv/xls/xlsx） — Chinese: extract text preview for office/spreadsheet files
async function extractOfficePreviewText(target: string, extension: string): Promise<string> {
  if (extension === 'docx') {
    const result = await mammoth.extractRawText({ path: target });
    return result.value.trimEnd();
  }
  if (extension === 'csv') {
    const buffer = await readPreviewBytes(target, MAX_PREVIEW_BYTES);
    return buffer.toString('utf8');
  }
  const workbook = XLSX.readFile(target, { cellDates: true });
  return workbook.SheetNames.slice(0, 3)
    .map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      return [`# ${sheetName}`, csv.trimEnd()].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

// 将二进制内容以原始文件的方式写入响应（带 Content-Disposition 下载头）
// — Chinese: write binary content to response as raw file (with Content-Disposition headers)
function sendRawFile(res: ServerResponse, buffer: Buffer, name: string, mimeType: string): void {
  const safeName = asciiHeaderFilename(name);
  const encodedName = encodeHeaderFilename(name);
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': buffer.length,
    'Content-Disposition': `inline; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
  });
  res.end(buffer);
}

// 工作区文件路由主入口（/api/workspaces/files、/api/workspaces/preview、/api/workspaces/raw）
// — Chinese: main entry for workspace file routes
export async function handleWorkspaceFilesRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}): Promise<boolean> {
  if (options.req.method !== 'GET') return false;
  if (!['/api/workspaces/files', '/api/workspaces/preview', '/api/workspaces/raw'].includes(options.url.pathname)) return false;

  try {
    const { root, target, relativePath } = resolveWorkspacePath(options.url.searchParams.get('root'), options.url.searchParams.get('path'));
    // /api/workspaces/files：列出目录或进行关键词搜索 — Chinese: /api/workspaces/files — list directory or keyword search
    if (options.url.pathname === '/api/workspaces/files') {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        sendError(options.res, 400, 'Path is not a directory');
        return true;
      }
      const query = options.url.searchParams.get('query')?.trim() ?? '';
      if (query) {
        const searchResult = await searchWorkspaceEntries(root, target, query);
        sendJson(options.res, 200, { root, path: relativePath, query, ...searchResult });
        return true;
      }
      const dirents = await fs.readdir(target, { withFileTypes: true });
      const entries = (await Promise.all(dirents
        .filter((entry) => !entry.isSymbolicLink() && !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)))
        .slice(0, MAX_ENTRIES)
        .map(async (entry): Promise<WorkspaceFileEntry | null> => {
          const absolute = path.join(target, entry.name);
          const kind = entry.isDirectory() ? 'directory' : 'file';
          return tryBuildFileEntry(root, absolute, kind);
        }))).filter((entry): entry is WorkspaceFileEntry => Boolean(entry));
      sortEntries(entries);
      sendJson(options.res, 200, { root, path: relativePath, entries });
      return true;
    }

    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      sendError(options.res, 400, 'Path is not a file');
      return true;
    }

    const extension = getExtension(target);
    const mimeType = getMimeType(extension);
    // /api/workspaces/raw：直接返回二进制原始内容 — Chinese: /api/workspaces/raw — return raw binary content
    if (options.url.pathname === '/api/workspaces/raw') {
      sendRawFile(options.res, await fs.readFile(target), path.basename(target), mimeType);
      return true;
    }

    const basePreview = {
      root,
      path: relativePath,
      name: path.basename(target),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      mimeType,
    };

    // 图片类型：返回 image preview 元数据 + rawUrl — Chinese: image type: return image preview metadata + rawUrl
    if (IMAGE_MIME_TYPES.has(extension)) {
      sendJson(options.res, 200, {
        ...basePreview,
        previewType: 'image' satisfies PreviewType,
        truncated: false,
        text: '',
        binary: true,
        rawUrl: rawUrl(root, relativePath),
      });
      return true;
    }

    // PDF：返回 pdf preview（含 rawUrl） — Chinese: pdf: return pdf preview with rawUrl
    if (extension === 'pdf') {
      sendJson(options.res, 200, {
        ...basePreview,
        previewType: 'pdf' satisfies PreviewType,
        truncated: false,
        text: '',
        binary: true,
        rawUrl: rawUrl(root, relativePath),
      });
      return true;
    }

    // Office/表格：提取文本作为 office preview — Chinese: office/spreadsheet: extract text as office preview
    if (OFFICE_PREVIEW_EXTENSIONS.has(extension)) {
      const text = await extractOfficePreviewText(target, extension);
      sendJson(options.res, 200, {
        ...basePreview,
        previewType: 'office' satisfies PreviewType,
        truncated: false,
        text,
        binary: false,
      });
      return true;
    }

    // 其他：读取前 N 字节，判断是否为文本或二进制
    // — Chinese: others: read first N bytes and decide between text vs binary
    const buffer = await readPreviewBytes(target, stat.size);
    const text = isProbablyText(buffer) ? buffer.toString('utf8') : '';
    const previewType: PreviewType = text
      ? (MARKDOWN_EXTENSIONS.has(extension) ? 'markdown' : HTML_EXTENSIONS.has(extension) ? 'html' : 'text')
      : 'binary';
    sendJson(options.res, 200, {
      ...basePreview,
      previewType,
      truncated: stat.size > MAX_PREVIEW_BYTES,
      text,
      binary: previewType === 'binary',
    });
    return true;
  } catch (error) {
    sendError(options.res, 400, error instanceof Error ? error.message : String(error));
    return true;
  }
}
