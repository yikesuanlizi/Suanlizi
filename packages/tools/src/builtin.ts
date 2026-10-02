import * as fs from 'node:fs/promises';
import { Dirent } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { exec, type ChildProcess } from 'node:child_process';
import { terminateProcessTree } from './processTree.js';
import type { ToolDefinition, ToolContext, ToolResult } from './registry.js';
import { browserTools } from './browserTool.js';
import {
  assertCanonicalToolPathStable,
  resolveCanonicalToolPath,
  resolveToolPath,
  resolveToolPathAccess,
  toolResultFromAccessDecision,
} from './accessGuard.js';
import { WebProviderRouter } from './web/provider.js';
import {
  artifactRecordForResult,
  assessArtifactFreshness,
  documentArtifactPathForSource,
  findArtifactByPath,
  findArtifactBySource,
  loadDocumentArtifactLedger,
  saveDocumentArtifactRecord,
  updateArtifactLastUsed,
} from './documentArtifacts.js';
import { computeFileFingerprint, isDocumentFile, relativeToWorkspace } from './fileKnowledge.js';
import { DOCUMENT_EXTRACTOR_VERSION, extractDocumentText, extractorForDocumentPath } from './documentExtractors.js';

// ─── current_time ──────────────────────────────────────────────────────────
// 中文注释：获取当前本地日期和时间。用于简单的时间/日期查询，替代 shell 命令。
export const currentTimeTool: ToolDefinition = {
  name: 'current_time',
  description: 'Get the current local date and time. Use this for simple time/date questions instead of shell commands.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：可选的 BCP-47 语言环境，例如 zh-CN 或 en-US。
      locale: { type: 'string', description: 'Optional BCP-47 locale, e.g. zh-CN or en-US.' },
      // 中文注释：可选的 IANA 时区，例如 Asia/Shanghai。
      timeZone: { type: 'string', description: 'Optional IANA timezone, e.g. Asia/Shanghai.' },
    },
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: true,
  async execute(args): Promise<ToolResult> {
    const now = new Date();
    const locale = typeof args.locale === 'string' && args.locale.trim() ? args.locale : 'zh-CN';
    const timeZone = typeof args.timeZone === 'string' && args.timeZone.trim() ? args.timeZone : 'Asia/Shanghai';
    const formatted = new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone,
    }).format(now);
    return {
      output: `Current time (${timeZone}): ${formatted}`,
      data: {
        iso: now.toISOString(),
        formatted,
        timeZone,
      },
      status: 'completed',
    };
  },
};

// ─── read_file ──────────────────────────────────────────────────────────────
// 中文注释：读取工作区中文件的内容。
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file in the workspace.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：相对于工作区根路径，或绝对路径。
      filePath: { type: 'string', description: 'Path relative to workspace root, or absolute.' },
      // 中文注释：起始行号（从 1 开始计数）。
      offset: { type: 'number', description: 'Line number to start reading from (1-indexed).' },
      // 中文注释：最多读取的行数。
      limit: { type: 'number', description: 'Maximum number of lines to read.' },
    },
    required: ['filePath'],
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: true,
  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = firstString(args.filePath, args.path, args.filename);
    if (!rawPath) {
      return {
        output: 'Missing filePath for read_file',
        status: 'failed',
        error: { message: 'filePath is required', code: 'INVALID_ARGUMENTS' },
      };
    }
    const access = await guardPathAccess(ctx, {
      path: rawPath,
      access: 'read',
      toolName: 'read_file',
      description: `读取文件 ${rawPath}`,
    });
    if (access.denied) return access.denied;
    const filePath = access.filePath;
    const ledger = await loadDocumentArtifactLedger(ctx.workspaceRoot);
    const managedArtifact = findArtifactByPath(ledger, filePath);
    if (managedArtifact) {
      const freshness = await assessArtifactFreshness(ctx.workspaceRoot, managedArtifact);
      if (freshness.status !== 'fresh') {
        return {
          output: `Stale document artifact: ${managedArtifact.artifactPath}. Use read_document on ${managedArtifact.sourcePath}.`,
          status: 'failed',
          error: {
            message: 'Managed document artifact is stale; use read_document to refresh it.',
            code: 'STALE_DOCUMENT_ARTIFACT',
          },
          data: { freshness },
        };
      }
    }
    const file = await computeFileFingerprint(ctx.workspaceRoot, filePath);
    const decoded = decodeTextFile(await fs.readFile(filePath));
    const content = decoded.text;
    const allLines = content.split('\n');
    let lines = allLines;
    const offset = typeof args.offset === 'number' ? Math.max(1, Math.floor(args.offset)) - 1 : 0;
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined;
    if (limit !== undefined) {
      lines = lines.slice(offset, offset + limit);
    } else if (offset > 0) {
      lines = lines.slice(offset);
    }
    const startLine = offset + 1;
    const endLine = Math.min(allLines.length, offset + lines.length);
    const numbered = lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
    const ref = fileSegmentRef(filePath, startLine, endLine, lines.join('\n'));
    return {
      output: numbered,
      status: 'completed',
      data: {
        path: filePath,
        file,
        freshness: managedArtifact
          ? {
              status: 'fresh',
              sourcePath: managedArtifact.sourcePath,
              artifactPath: managedArtifact.artifactPath,
              recommendedTool: 'read_document',
            }
          : unmanagedHelperFreshness(ctx.workspaceRoot, filePath),
        startLine,
        endLine,
        totalLines: allLines.length,
        encoding: decoded.encoding,
        artifactRefs: [ref],
      },
    };
  },
};

export const readDocumentTool: ToolDefinition = {
  name: 'read_document',
  description: 'Extract readable text from docx, pdf, xlsx, or pptx files. Use this instead of read_file for office/PDF documents so Suanlizi can detect stale extracted artifacts.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Document path relative to workspace root, or absolute.' },
    },
    required: ['filePath'],
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: true,
  timeoutMs: 120_000,
  maxOutputLength: 50_000,
  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = firstString(args.filePath, args.path, args.filename);
    if (!rawPath) return failedToolResult('filePath is required', 'INVALID_ARGUMENTS');

    const access = await guardPathAccess(ctx, {
      path: rawPath,
      access: 'read',
      toolName: 'read_document',
      description: `读取文档 ${rawPath}`,
    });
    if (access.denied) return access.denied;
    const filePath = access.filePath;
    if (!isDocumentFile(filePath)) {
      return failedToolResult(`Unsupported document type: ${path.extname(filePath)}`, 'UNSUPPORTED_DOCUMENT_TYPE');
    }

    const extractor = extractorForDocumentPath(filePath);
    let source: Awaited<ReturnType<typeof computeFileFingerprint>>;
    try {
      source = await computeFileFingerprint(ctx.workspaceRoot, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return failedToolResult(`Source document missing: ${rawPath}`, 'SOURCE_MISSING', {
          sourcePath: filePath,
          recommendedTool: 'read_document',
        });
      }
      throw error;
    }

    try {
      const ledger = await loadDocumentArtifactLedger(ctx.workspaceRoot);
      const existing = findArtifactBySource(ledger, filePath, extractor, DOCUMENT_EXTRACTOR_VERSION);

      if (existing) {
        const freshness = await assessArtifactFreshness(ctx.workspaceRoot, existing);
        if (freshness.status === 'fresh') {
          await updateArtifactLastUsed(ctx.workspaceRoot, existing.artifactPath);
          const text = await fs.readFile(existing.artifactPath, 'utf-8');
          return completedDocumentResult({
            source,
            artifactPath: existing.artifactPath,
            artifactHash: existing.artifactHash,
            extractor,
            createdAt: existing.createdAt,
            reused: true,
            stale: false,
            text,
            workspaceRoot: ctx.workspaceRoot,
          });
        }
      }

      const extracted = await extractDocumentText(filePath);
      const artifactPath = await documentArtifactPathForSource(ctx.workspaceRoot, source, extractor, DOCUMENT_EXTRACTOR_VERSION);
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      await fs.writeFile(artifactPath, extracted.text, 'utf-8');
      const artifactHash = createHash('sha256').update(extracted.text).digest('hex');
      const createdAt = new Date().toISOString();
      await saveDocumentArtifactRecord(ctx.workspaceRoot, artifactRecordForResult({
        workspaceRoot: ctx.workspaceRoot,
        source,
        artifactPath,
        artifactHash,
        extractor: extracted.extractor,
        extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
        createdAt,
      }));
      return completedDocumentResult({
        source,
        artifactPath,
        artifactHash,
        extractor: extracted.extractor,
        createdAt,
        reused: false,
        stale: Boolean(existing),
        text: extracted.text,
        workspaceRoot: ctx.workspaceRoot,
      });
    } catch (error) {
      return failedToolResult(`Document extraction failed: ${errorMessage(error)}`, 'EXTRACTION_FAILED', {
        source,
        extractor,
      });
    }
  },
};

function decodeTextFile(buffer: Buffer): { text: string; encoding: 'utf-8' | 'gb18030' } {
  const utf8 = buffer.toString('utf8');
  if (replacementCharCount(utf8) === 0) {
    return { text: stripByteOrderMark(utf8), encoding: 'utf-8' };
  }
  try {
    const gb18030 = new TextDecoder('gb18030', { fatal: false }).decode(buffer);
    if (replacementCharCount(gb18030) < replacementCharCount(utf8)) {
      return { text: stripByteOrderMark(gb18030), encoding: 'gb18030' };
    }
  } catch {
    // Keep UTF-8 fallback when the runtime lacks gb18030.
  }
  return { text: stripByteOrderMark(utf8), encoding: 'utf-8' };
}

function replacementCharCount(value: string): number {
  return [...value].filter((char) => char === '\uFFFD').length;
}

function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

// ─── list_files ─────────────────────────────────────────────────────────────
// 中文注释：列出工作区中的文件和目录。用于在读取文件之前检查目录结构。
export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description:
    'List files and directories in the workspace. Use this to inspect directory structure before reading files.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：要列出的目录，相对于工作区根路径或为绝对路径。默认为工作区根路径。
      path: {
        type: 'string',
        description: 'Directory to list, relative to workspace root or absolute. Defaults to workspace root.',
      },
      // 中文注释：是否递归列出嵌套目录。默认为 false。
      recursive: { type: 'boolean', description: 'Whether to recursively list nested directories. Defaults to false.' },
      // 中文注释：最多返回的条目数，范围 1 到 1000。默认为 200。
      maxEntries: { type: 'number', description: 'Maximum entries to return, from 1 to 1000. Defaults to 200.' },
      // 中文注释：是否包含点文件（隐藏文件）和点目录。默认为 false。
      includeHidden: { type: 'boolean', description: 'Include dotfiles and dot-directories. Defaults to false.' },
    },
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: true,
  timeoutMs: 30_000,
  maxOutputLength: 20_000,
  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = firstString(args.path, args.dir, args.directory, args.filePath) ?? '.';
    const access = await guardPathAccess(ctx, {
      path: rawPath,
      access: 'read',
      toolName: 'list_files',
      description: `列出目录 ${rawPath}`,
    });
    if (access.denied) return access.denied;
    const targetPath = access.filePath;
    const recursive = args.recursive === true;
    const includeHidden = args.includeHidden === true;
    const maxEntriesRaw = Number(args.maxEntries ?? args.limit);
    const maxEntries = Number.isFinite(maxEntriesRaw)
      ? Math.min(1000, Math.max(1, Math.floor(maxEntriesRaw)))
      : 200;

    const entries: ListedFileEntry[] = [];
    await collectFileEntries(targetPath, {
      root: targetPath,
      recursive,
      includeHidden,
      maxEntries,
      entries,
    });

    const relTarget = path.relative(ctx.workspaceRoot, targetPath) || '.';
    if (entries.length === 0) {
      return {
        output: `No files found in ${relTarget}`,
        status: 'completed',
        data: { path: targetPath, entries },
      };
    }

    const output = [
      `Files in ${relTarget}:`,
      ...entries.map((entry) => {
        const marker = entry.kind === 'directory' ? '/' : '';
        const size = entry.kind === 'file' && entry.size !== undefined ? ` ${entry.size} bytes` : '';
        return `${entry.path}${marker}${size}`;
      }),
      entries.length >= maxEntries ? `... [limited to ${maxEntries} entries]` : undefined,
    ].filter((line) => line !== undefined).join('\n');

    return {
      output,
      status: 'completed',
      data: {
        path: targetPath,
        recursive,
        maxEntries,
        entries,
        truncated: entries.length >= maxEntries,
      },
    };
  },
};

// ─── write_file ─────────────────────────────────────────────────────────────
// 中文注释：写入或覆盖工作区中的文件。
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write or overwrite a file in the workspace.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：相对于工作区根路径。
      filePath: { type: 'string', description: 'Path relative to workspace root.' },
      // 中文注释：要写入的文件内容。
      content: { type: 'string', description: 'File content to write.' },
    },
    required: ['filePath', 'content'],
  },
  requiredPolicy: 'workspace_write',
  requiresApproval: true,
  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = firstString(args.filePath, args.path, args.filename);
    if (!rawPath) return failedToolResult('filePath is required', 'INVALID_ARGUMENTS');
    const access = await guardPathAccess(ctx, {
      path: rawPath,
      access: 'write',
      toolName: 'write_file',
      description: `写入文件 ${rawPath}`,
    });
    if (access.denied) return access.denied;
    const filePath = access.filePath;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await assertCanonicalToolPathStable(ctx.workspaceRoot, filePath);
    await fs.writeFile(filePath, String(args.content), 'utf-8');
    return { output: `Wrote ${Buffer.byteLength(String(args.content))} bytes to ${args.filePath}`, status: 'completed' };
  },
};

// ─── shell_command ──────────────────────────────────────────────────────────
// 中文注释：执行 shell 命令。命令在工作区根目录运行，输出将被捕获并返回。
export const shellCommandTool: ToolDefinition = {
  name: 'shell_command',
  description:
    'Run a shell command. The command runs in the workspace root. Output is captured and returned.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：要执行的 shell 命令。
      command: { type: 'string', description: 'The shell command to execute.' },
      // 中文注释：命令的工作目录（相对于工作区或为绝对路径）。
      cwd: {
        type: 'string',
        description: 'Working directory for the command (relative to workspace or absolute).',
      },
    },
    required: ['command'],
  },
  requiredPolicy: 'workspace_write',
  requiresApproval: true,
  maxOutputLength: 20_000,
  timeoutMs: 120_000,
  async execute(args, ctx): Promise<ToolResult> {
    const cmd = String(args.command);
    const accessDecision = await ctx.requestAccess?.({
      access: 'command',
      target: { kind: 'command', command: cmd },
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      toolName: 'shell_command',
      description: `执行命令 ${cmd.slice(0, 120)}`,
    });
    if (accessDecision && accessDecision.decision !== 'allow') {
      return toolResultFromAccessDecision(accessDecision);
    }
    const cwdAccess = await guardPathAccess(ctx, {
      path: args.cwd ? String(args.cwd) : '.',
      access: 'write',
      toolName: 'shell_command',
      description: `在目录执行命令 ${args.cwd ? String(args.cwd) : '.'}`,
    });
    if (cwdAccess.denied) return cwdAccess.denied;
    return runShellCommand(cmd, cwdAccess.filePath, ctx.signal, ctx.onOutputDelta);
  },
};

// ─── gitnexus_analyze ──────────────────────────────────────────────────────
// 中文注释：为指定工作区构建/刷新 GitNexus 索引。
// 这是 CLI/npx 索引运维层的入口，Agent 通过此工具触发索引，不直接裸跑 npx。
export const gitNexusAnalyzeTool: ToolDefinition = {
  name: 'gitnexus_analyze',
  description:
    'Build or refresh the GitNexus code graph index for a workspace. This runs "npx -y gitnexus@latest analyze" under the hood. Use this when GitNexus graph queries (context, impact, trace, graph) are needed and the repository may not be indexed yet. After indexing completes, GitNexus serve and MCP tools can provide structured code analysis. This is an enhancement path; continue using list_files/read_file/search_content if GitNexus is unavailable.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: {
        type: 'string',
        description: 'Path to the repository to index. Defaults to the current workspace root.',
      },
      force: {
        type: 'boolean',
        description: 'Force re-index even if an index already exists.',
      },
    },
    additionalProperties: false,
  },
  requiredPolicy: 'workspace_write',
  requiresApproval: true,
  timeoutMs: 600_000,
  maxOutputLength: 30_000,
  async execute(args, ctx): Promise<ToolResult> {
    const repoPath = typeof args.repoPath === 'string' && args.repoPath.trim()
      ? resolveToolPath(ctx.workspaceRoot, args.repoPath)
      : ctx.workspaceRoot;
    const forceFlag = args.force === true ? ['--force'] : [];
    const command = ['npx', '-y', 'gitnexus@latest', 'analyze', ...forceFlag];
    const { execFile } = await import('node:child_process');

    return new Promise((resolve) => {
      const child = execFile(
        command[0],
        command.slice(1),
        {
          cwd: repoPath,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 600_000,
          windowsHide: true,
          shell: process.platform === 'win32',
        },
        (error, stdout, stderr) => {
          const output = [
            stdout,
            stderr ? `\n[stderr]\n${stderr}` : '',
          ].filter(Boolean).join('\n').trim();
          const exitCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
          const baseData = {
            command,
            cwd: repoPath,
            repoPath,
            exitCode,
          };
          if (error) {
            const message = output || `GitNexus analyze failed: ${error.message}`;
            resolve({
              output: message,
              status: 'failed',
              exitCode,
              data: baseData,
              error: { message: error.message, code: 'GITSUANLIZI_ANALYZE_FAILED' },
            });
            return;
          }
          resolve({
            output: output || 'GitNexus analyze completed.',
            status: 'completed',
            exitCode: 0,
            data: { ...baseData, started: true },
          });
        },
      );
      if (ctx.signal) {
        ctx.signal.addEventListener('abort', () => terminateProcessTree(child), { once: true });
      }
    });
  },
};

// ─── search_content ─────────────────────────────────────────────────────────
// 中文注释：在工作区文件中搜索文本模式（子串或正则表达式）。
export const searchContentTool: ToolDefinition = {
  name: 'search_content',
  description:
    'Search for a text pattern (substring or regex) across files in the workspace.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：要搜索的文本或正则表达式模式。
      pattern: { type: 'string', description: 'Text or regex pattern to search for.' },
      // 中文注释：要搜索的目录（相对于工作区根路径，默认根路径）。
      path: {
        type: 'string',
        description: 'Directory to search in (relative to workspace root, default: root).',
      },
      // 中文注释：逗号分隔的文件扩展名，例如 ".ts,.js"。
      fileTypes: { type: 'string', description: 'Comma-separated file extensions (e.g. ".ts,.js").' },
      // 中文注释：是否区分大小写搜索（默认 false）。
      caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default false).' },
      // 中文注释：每个匹配项周围的上下文行数。
      contextLines: { type: 'number', description: 'Lines of context around each match.' },
    },
    required: ['pattern'],
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: true,
  timeoutMs: 30_000,
  maxOutputLength: 30_000,
  async execute(args, ctx): Promise<ToolResult> {
    const pattern = firstString(args.pattern, args.query, args.search, args.text);
    if (!pattern) {
      return {
        output: 'Missing pattern for search_content',
        status: 'failed',
        error: { message: 'pattern is required', code: 'INVALID_ARGUMENTS' },
      };
    }
    const rawSearchPath = firstString(args.path, args.dir, args.directory);
    const access = await guardPathAccess(ctx, {
      path: rawSearchPath ?? '.',
      access: 'read',
      toolName: 'search_content',
      description: `搜索目录 ${rawSearchPath ?? '.'}`,
    });
    if (access.denied) return access.denied;
    const searchPath = access.filePath;

    // Simple recursive grep using Node
    const results: SearchMatch[] = [];
    await walkAndSearch(
      searchPath,
      pattern,
      {
        caseSensitive: !!args.caseSensitive,
        fileTypes: args.fileTypes ? String(args.fileTypes).split(',').map((s) => s.trim()) : undefined,
        contextLines: typeof args.contextLines === 'number' ? Math.floor(args.contextLines) : 0,
      },
      results,
    );

    if (results.length === 0) {
      return { output: `No matches found for "${pattern}"`, status: 'completed' };
    }
    return {
      output: results.map((result) => result.lines).flat().join('\n'),
      status: 'completed',
      data: {
        pattern,
        matches: results,
        artifactRefs: results.map((result) => result.artifactRef),
      },
    };
  },
};

// ─── web_search ────────────────────────────────────────────────────────────
// 中文注释：Codex 风格的网页访问工具。使用 action="search" 发现网页，action="open_page" 读取指定 URL，action="find_in_page" 在指定 URL 中查找文本。若用户提供了 URL，优先使用 open_page 而非 search。
export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Codex-style web access tool. Use action="search" to discover pages, action="open_page" to read a specific URL, and action="find_in_page" to find text within a specific URL. If the user provides a URL, prefer open_page over search.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：要执行的网页动作。当提供 url 时默认为 open_page，否则为 search。
      action: {
        type: 'string',
        enum: ['search', 'open_page', 'find_in_page'],
        description: 'Web action to perform. Defaults to open_page when url is provided, otherwise search.',
      },
      // 中文注释：action="search" 时的搜索查询。
      query: { type: 'string', description: 'Search query for action="search".' },
      // 中文注释：action="search" 时可选的搜索查询列表。
      queries: {
        type: 'array',
        description: 'Optional list of search queries for action="search".',
        items: { type: 'string' },
      },
      // 中文注释：action="open_page" 或 action="find_in_page" 时的 HTTP/HTTPS URL。
      url: { type: 'string', description: 'HTTP/HTTPS URL for action="open_page" or action="find_in_page".' },
      // 中文注释：action="find_in_page" 时的文本或类正则表达式模式。
      pattern: { type: 'string', description: 'Text or regex-like pattern for action="find_in_page".' },
      // 中文注释：最多返回的结果数，范围 1 到 8。默认为 5。
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return, from 1 to 8. Default is 5.',
      },
    },
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: true,
  timeoutMs: 20_000,
  maxOutputLength: 12_000,
  async execute(args, ctx): Promise<ToolResult> {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    const requestedAction = typeof args.action === 'string' ? args.action : '';
    const action = requestedAction === 'open_page' || requestedAction === 'find_in_page' || requestedAction === 'search'
      ? requestedAction
      : url
        ? (pattern ? 'find_in_page' : 'open_page')
        : 'search';

    if (action === 'open_page') {
      return fetchUrlAsToolResult(url, ctx);
    }
    if (action === 'find_in_page') {
      return findInPageAsToolResult(url, pattern, ctx);
    }

    const queries = collectSearchQueries(args);
    if (queries.length === 0) {
      return {
        output: 'Missing query for web_search',
        status: 'failed',
        error: { message: 'query or queries is required for action="search"', code: 'INVALID_ARGUMENTS' },
      };
    }

    const maxResultsRaw = Number(args.maxResults);
    const maxResults = Number.isFinite(maxResultsRaw)
      ? Math.min(8, Math.max(1, Math.floor(maxResultsRaw)))
      : 5;
    try {
      const router = createWebProviderRouter(ctx);
      const results = dedupeSearchResults((await Promise.all(
        queries.map((query) => router.search({ query, maxResults, signal: ctx.signal })),
      )).flat()).slice(0, maxResults);
      if (results.length === 0) {
        return {
          output: `No web search results found for "${queries.join('", "')}".`,
          status: 'completed',
          data: { action: 'search', query: queries[0] ?? '', queries, results: [] },
        };
      }

      const output = [
        `Web search results for "${queries.join('", "')}":`,
        ...results.map((result, index) =>
          [
            `${index + 1}. ${result.title}`,
            result.url,
            result.snippet ? result.snippet : undefined,
          ].filter(Boolean).join('\n'),
        ),
      ].join('\n\n');

      return {
        output,
        status: 'completed',
        data: { action: 'search', query: queries[0] ?? '', queries, results },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        output: `Web search failed for "${queries.join('", "')}": ${message}`,
        status: 'failed',
        error: { message, code: 'WEB_SEARCH_FAILED' },
      };
    }
  },
};

// ─── web_fetch ─────────────────────────────────────────────────────────────
// 中文注释：从指定的 HTTP/HTTPS URL 获取并提取可读文本。当用户提供 URL 时或在 web_search 找到有希望的结果后使用此工具。
export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch and extract readable text from a specific HTTP/HTTPS URL. Use this when the user provides a URL or after web_search finds a promising result.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：要获取的 HTTP 或 HTTPS URL。
      url: { type: 'string', description: 'The HTTP or HTTPS URL to fetch.' },
    },
    required: ['url'],
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: true,
  timeoutMs: 25_000,
  maxOutputLength: 18_000,
  async execute(args, ctx): Promise<ToolResult> {
    const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
    return fetchUrlAsToolResult(rawUrl, ctx);
  },
};

// ─── apply_patch ────────────────────────────────────────────────────────────
// 中文注释：将统一 diff 格式的补丁应用到工作区文件。每个 hunk 块指定目标文件及变更内容。
export const applyPatchTool: ToolDefinition = {
  name: 'apply_patch',
  description:
    'Apply a unified diff patch to files in the workspace. Each hunk specifies the target file and the changes.',
  parameters: {
    type: 'object',
    properties: {
      // 中文注释：统一 diff 格式的补丁文本。
      patch: { type: 'string', description: 'Unified diff patch text.' },
    },
    required: ['patch'],
  },
  requiredPolicy: 'workspace_write',
  requiresApproval: true,
  async execute(args, ctx): Promise<ToolResult> {
    const patchText = String(args.patch);
    let actions: SuanliziPatchAction[];
    try {
      actions = parseSuanliziPatch(patchText);
      const pathAccess = await guardPatchActions(ctx, actions);
      if ('denied' in pathAccess) return pathAccess.denied;
      const changes = await applySuanliziPatchActions(ctx.workspaceRoot, actions, pathAccess.paths);
      return {
        output: changes.map((change) => `${change.kind} ${change.path} (+${change.addedLines ?? 0}/-${change.removedLines ?? 0})`).join('\n') || 'No changes applied',
        status: 'completed',
        data: { changes },
      };
    } catch (error) {
      const message = `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        output: message,
        status: 'failed',
        error: { message, code: 'APPLY_PATCH_FAILED' },
      };
    }
  },
};

// ─── get_system_status ──────────────────────────────────────────────────────
// 中文注释：查询当前主机系统状态（CPU/内存/磁盘），用于性能感知和限流决策。
// agent 可主动调用此工具了解主机负载，也可在收到监控模块的主动通知后查询详情。
export const getSystemStatusTool: ToolDefinition = {
  name: 'get_system_status',
  description:
    'Query current host system status (CPU / memory / disk usage) and the active throttle level. Use this to check host load before spawning subagents or running parallel tool batches, and after receiving a system-pressure notification.',
  parameters: {
    type: 'object',
    properties: {},
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: true,
  async execute(_args, ctx): Promise<ToolResult> {
    // 中文注释：监控未启用或未注入时返回提示
    if (!ctx.systemMonitor || !ctx.systemMonitor.isEnabled()) {
      return {
        output: 'System monitor is disabled. Host status tracking is not active.',
        data: { enabled: false },
        status: 'completed',
      };
    }
    const status = ctx.systemMonitor.getStatus();
    const s = status.snapshot;
    // 中文注释：格式化磁盘信息
    const diskLines = s.disks.map((d) => {
      const sizeGb = (d.size / 1024 / 1024 / 1024).toFixed(1);
      const availGb = (d.available / 1024 / 1024 / 1024).toFixed(1);
      return `  ${d.mount}: ${d.usage.toFixed(1)}% used (${availGb} GB free / ${sizeGb} GB total)`;
    });
    const memTotalGb = (s.memTotal / 1024 / 1024 / 1024).toFixed(1);
    const memUsedGb = (s.memUsed / 1024 / 1024 / 1024).toFixed(1);
    const output = [
      `System Status [${status.level.toUpperCase()}]`,
      `CPU: ${s.cpuUsage.toFixed(1)}% (${s.cpuCount} cores)`,
      `Memory: ${s.memUsage.toFixed(1)}% (${memUsedGb} GB / ${memTotalGb} GB)`,
      `Disks:`,
      ...diskLines,
      ``,
      `Recommendation: ${status.recommendation}`,
    ].join('\n');
    return {
      output,
      data: status,
      status: 'completed',
    };
  },
};

// ─── request_user_decision ────────────────────────────────────────────────
// 中文注释：由 runtime 接管的只读决策入口；工具本身不执行任何用户内容。
export const requestUserDecisionTool: ToolDefinition = {
  name: 'request_user_decision',
  description: 'Pause the current turn and ask the user to choose one bounded option. This is a readonly, resumable decision request; it does not execute the user response.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: 'Question shown to the user.' },
      options: {
        type: 'array',
        description: 'Bounded choices with stable ids, labels, and optional descriptions.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            action: { type: 'string', enum: ['way_one', 'way_two', 'custom_input', 'confirm'] },
            label: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id', 'action', 'label'],
        },
      },
      allowCustomInput: { type: 'boolean', description: 'Whether the user may provide bounded custom text.' },
    },
    required: ['prompt', 'options', 'allowCustomInput'],
  },
  requiredPolicy: 'readonly',
  supportsParallelToolCalls: false,
  async execute(args, ctx): Promise<ToolResult> {
    const keys = Object.keys(args);
    if (keys.some((key) => !['prompt', 'options', 'allowCustomInput'].includes(key))) {
      return failedToolResult('request_user_decision accepts only prompt, options, and allowCustomInput', 'INVALID_ARGUMENTS');
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const allowCustomInput = args.allowCustomInput === true;
    if (!prompt || prompt.length > 8_000 || rawOptions.length < 1 || rawOptions.length > 8 || typeof args.allowCustomInput !== 'boolean') {
      return failedToolResult('prompt, options (1-8 items), and allowCustomInput are required', 'INVALID_ARGUMENTS');
    }
    const options = rawOptions.map((value) => {
      if (!value || typeof value !== 'object') return null;
      const option = value as Record<string, unknown>;
      const optionKeys = Object.keys(option);
      if (optionKeys.some((key) => !['id', 'action', 'label', 'description'].includes(key))) return null;
      if (typeof option.id !== 'string' || !option.id.trim() || typeof option.label !== 'string' || !option.label.trim()) return null;
      if (!['way_one', 'way_two', 'custom_input', 'confirm'].includes(String(option.action))) return null;
      if (option.description !== undefined && typeof option.description !== 'string') return null;
      return {
        id: option.id.trim(),
        action: option.action as 'way_one' | 'way_two' | 'custom_input' | 'confirm',
        label: option.label.trim(),
        ...(typeof option.description === 'string' && option.description.trim() ? { description: option.description.trim() } : {}),
      };
    });
    if (options.some((option) => option === null) || new Set(options.filter(Boolean).map((option) => option!.id)).size !== options.length) {
      return failedToolResult('Each decision option needs a unique id, action, and label', 'INVALID_ARGUMENTS');
    }
    if (!allowCustomInput && options.some((option) => option?.action === 'custom_input')) {
      return failedToolResult('custom_input options require allowCustomInput=true', 'INVALID_ARGUMENTS');
    }
    if (!ctx.requestUserDecision) {
      return failedToolResult('request_user_decision is unavailable outside an AgentLoop turn', 'DECISION_UNAVAILABLE');
    }
    const response = await ctx.requestUserDecision({
      prompt,
      options: options as Array<{
        id: string;
        action: 'way_one' | 'way_two' | 'custom_input' | 'confirm';
        label: string;
        description?: string;
      }>,
      allowCustomInput,
    });
    return {
      output: JSON.stringify({ action: response.action, optionId: response.optionId, customInput: response.customInput }),
      data: response,
      status: 'completed',
    };
  },
};

// ─── built‑in tool list ─────────────────────────────────────────────────────
export const BUILTIN_TOOLS: ToolDefinition[] = [
  currentTimeTool,
  readFileTool,
  readDocumentTool,
  listFilesTool,
  writeFileTool,
  shellCommandTool,
  gitNexusAnalyzeTool,
  searchContentTool,
  webSearchTool,
  webFetchTool,
  applyPatchTool,
  getSystemStatusTool,
  requestUserDecisionTool,
  ...browserTools,
];

// ─── Helpers ────────────────────────────────────────────────────────────────
function completedDocumentResult(input: {
  source: Awaited<ReturnType<typeof computeFileFingerprint>>;
  artifactPath: string;
  artifactHash: string;
  extractor: ReturnType<typeof extractorForDocumentPath>;
  createdAt: string;
  reused: boolean;
  stale: boolean;
  text: string;
  workspaceRoot: string;
}): ToolResult {
  const preview = input.text.slice(0, 48_000);
  const sourceDisplay = input.source.relativePath ?? input.source.path;
  return {
    output: [
      `Document extracted: ${sourceDisplay}`,
      `Artifact: ${relativeToWorkspace(input.workspaceRoot, input.artifactPath) ?? input.artifactPath}`,
      '',
      preview,
    ].join('\n'),
    status: 'completed',
    data: {
      source: input.source,
      artifact: {
        path: input.artifactPath,
        relativePath: relativeToWorkspace(input.workspaceRoot, input.artifactPath),
        kind: 'document_text',
        sha256: input.artifactHash,
        createdAt: input.createdAt,
        extractor: input.extractor,
        extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
      },
      stale: input.stale,
      reused: input.reused,
      textPreview: preview,
    },
  };
}

function failedToolResult(message: string, code: string, data?: unknown): ToolResult {
  return { output: message, status: 'failed', error: { message, code }, ...(data === undefined ? {} : { data }) };
}

async function guardPathAccess(
  ctx: ToolContext,
  input: {
    path: string;
    access: 'read' | 'write';
    toolName: string;
    description: string;
  },
): Promise<{ filePath: string; denied?: ToolResult }> {
  const canonicalPath = await resolveCanonicalToolPath(ctx.workspaceRoot, input.path);
  const request = resolveToolPathAccess({
    workspaceRoot: ctx.workspaceRoot,
    path: canonicalPath,
    access: input.access,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    toolName: input.toolName,
    description: input.description,
  });
  const decision = await ctx.requestAccess?.(request);
  if (decision && decision.decision !== 'allow') {
    return { filePath: request.target.path ?? '', denied: toolResultFromAccessDecision(decision) };
  }
  return { filePath: request.target.path ?? '' };
}

async function guardPatchActions(
  ctx: ToolContext,
  actions: SuanliziPatchAction[],
): Promise<{ paths: Map<string, string> } | { denied: ToolResult }> {
  const paths = new Set<string>();
  const canonicalPaths = new Map<string, string>();
  for (const action of actions) {
    paths.add(action.path);
    if (action.kind === 'update' && action.moveTo) paths.add(action.moveTo);
  }
  for (const filePath of paths) {
    const access = await guardPathAccess(ctx, {
      path: filePath,
      access: 'write',
      toolName: 'apply_patch',
      description: `应用补丁 ${filePath}`,
    });
    if (access.denied) return { denied: access.denied };
    canonicalPaths.set(filePath, access.filePath);
  }
  return { paths: canonicalPaths };
}

function runShellCommand(command: string, cwd: string, signal?: AbortSignal, onOutputDelta?: (delta: string) => void): Promise<ToolResult> {
  return new Promise((resolve) => {
    let settled = false;
    let removeAbort: (() => void) | undefined;
    let streamedLength = 0;
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      removeAbort?.();
      resolve(result);
    };
    const child = exec(command, {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = [
        String(stdout ?? ''),
        stderr ? `\n[stderr]\n${String(stderr)}` : '',
      ].filter(Boolean).join('').trim();
      if (error) {
        const exitCode = typeof error.code === 'number' ? error.code : 1;
        finish({
          output: output || error.message,
          status: 'failed',
          exitCode,
          data: { command, cwd, exitCode },
          error: { message: error.message, code: 'SHELL_COMMAND_FAILED' },
        });
        return;
      }
      finish({
        output,
        status: 'completed',
        exitCode: 0,
        data: { command, cwd, exitCode: 0 },
      });
    });
    // 流式输出：stdout/stderr 增量通过 onOutputDelta 推给运行时，
    // 供前端"终端式"实时预览（长命令几秒到几十分钟都能看到进度）。
    // — Chinese: stream stdout/stderr deltas via onOutputDelta for live preview.
    if (onOutputDelta) {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = String(chunk);
        streamedLength += text.length;
        onOutputDelta(text);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = String(chunk);
        streamedLength += text.length;
        onOutputDelta(text);
      });
    }
    const cancel = (): void => {
      terminateShellProcess(child);
      finish({
        output: 'Shell command cancelled',
        status: 'failed',
        error: { message: 'Shell command cancelled', code: 'TOOL_CANCELLED' },
        data: { command, cwd },
      });
    };
    if (signal?.aborted) {
      cancel();
    } else if (signal) {
      signal.addEventListener('abort', cancel, { once: true });
      removeAbort = () => signal.removeEventListener('abort', cancel);
    }
  });
}

function terminateShellProcess(child: ChildProcess): void {
  terminateProcessTree(child);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unmanagedHelperFreshness(workspaceRoot: string, filePath: string) {
  const basename = path.basename(filePath).toLowerCase();
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  const directChild = relative
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && !relative.includes(path.sep);
  if (directChild && /^_.*(?:decoded|extract|dump|scratch|temp|tmp).*\.(txt|md|json|xml)$/i.test(basename)) {
    return {
      status: 'unmanaged_warning',
      artifactPath: filePath,
      reason: 'unmanaged_artifact',
      recommendedTool: 'read_document',
    };
  }
  return { status: 'fresh' };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

interface WalkOptions {
  caseSensitive: boolean;
  fileTypes?: string[];
  contextLines: number;
}

async function walkAndSearch(
  dir: string,
  pattern: string,
  opts: WalkOptions,
  results: SearchMatch[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // 预计算：判断 pattern 是否为纯文本（不含正则特殊字符），纯文本用 indexOf 更快
  // — English: pre-compute: check if pattern is plain text (no regex special chars), use indexOf for speed
  const regexSpecialChars = /[.*+?^${}()|[\]\\]/;
  const isPlainText = !regexSpecialChars.test(pattern);
  const searchLower = opts.caseSensitive ? pattern : pattern.toLowerCase();

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || shouldSkipDirectory(entry.name)) continue;
      await walkAndSearch(fullPath, pattern, opts, results);
    } else if (entry.isFile()) {
      if (opts.fileTypes && opts.fileTypes.length > 0) {
        const ext = path.extname(entry.name);
        if (!opts.fileTypes.some((ft) => ext === ft || entry.name.endsWith(ft))) continue;
      }
      try {
        const stat = await fs.stat(fullPath);
        // 跳过大于 1MB 的文件，避免读取大文件导致超时
        // — English: skip files larger than 1MB to avoid timeouts from reading huge files
        if (stat.size > 1024 * 1024) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');

        // 快速二进制检测：如果包含 NUL 字节，跳过
        // — English: quick binary detection: skip if contains NUL bytes
        if (content.includes('\0')) continue;

        if (isPlainText) {
          // 纯文本快速路径：用 indexOf/includes，比正则快很多
          // — English: plain text fast path: much faster than regex
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const found = opts.caseSensitive
              ? line.includes(searchLower)
              : line.toLowerCase().includes(searchLower);
            if (found) {
              addSearchResult(results, fullPath, dir, i, lines, opts.contextLines);
              if (results.length > 200) return;
            }
          }
        } else {
          const flags = opts.caseSensitive ? 'g' : 'gi';
          const regex = safeRegex(pattern, flags);
          if (!regex) continue;

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              // Reset lastIndex for global regex
              regex.lastIndex = 0;
              addSearchResult(results, fullPath, dir, i, lines, opts.contextLines);
              if (results.length > 200) return;
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }
}

function addSearchResult(
  results: SearchMatch[],
  fullPath: string,
  baseDir: string,
  lineIndex: number,
  lines: string[],
  contextLines: number,
) {
  const relPath = path.relative(process.cwd(), fullPath);
  const workspaceRelPath = path.relative(baseDir, fullPath);
  if (contextLines > 0) {
    const start = Math.max(0, lineIndex - contextLines);
    const end = Math.min(lines.length, lineIndex + contextLines + 1);
    const rendered: string[] = [];
    for (let j = start; j < end; j++) {
      rendered.push(`${relPath}:${j + 1}: ${lines[j]}`);
    }
    rendered.push('---');
    results.push({
      path: workspaceRelPath || path.basename(fullPath),
      line: lineIndex + 1,
      text: lines[lineIndex],
      lines: rendered,
      artifactRef: fileSegmentRef(fullPath, start + 1, end, lines.slice(start, end).join('\n')),
    });
  } else {
    const rendered = [`${relPath}:${lineIndex + 1}: ${lines[lineIndex]}`];
    results.push({
      path: workspaceRelPath || path.basename(fullPath),
      line: lineIndex + 1,
      text: lines[lineIndex],
      lines: rendered,
      artifactRef: fileSegmentRef(fullPath, lineIndex + 1, lineIndex + 1, lines[lineIndex]),
    });
  }
}

interface ListedFileEntry {
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

async function collectFileEntries(
  dir: string,
  opts: {
    root: string;
    recursive: boolean;
    includeHidden: boolean;
    maxEntries: number;
    entries: ListedFileEntry[];
  },
): Promise<void> {
  if (opts.entries.length >= opts.maxEntries) return;
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const sorted = dirents
    .filter((entry) => opts.includeHidden || !entry.name.startsWith('.'))
    .filter((entry) => !shouldSkipDirectory(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  for (const entry of sorted) {
    if (opts.entries.length >= opts.maxEntries) return;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(opts.root, fullPath) || entry.name;
    if (entry.isDirectory()) {
      opts.entries.push({ path: relPath, kind: 'directory' });
      if (opts.recursive) {
        await collectFileEntries(fullPath, opts);
      }
    } else if (entry.isFile()) {
      let size: number | undefined;
      try {
        size = (await fs.stat(fullPath)).size;
      } catch {
        size = undefined;
      }
      opts.entries.push({ path: relPath, kind: 'file', size });
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  return (
    name === 'node_modules'
    || name === 'dist'
    || name === 'build'
    || name === 'target'
    || name === '.git'
    || name === '.svn'
    || name === '.hg'
    || name === '.gradle'
    || name === '.idea'
    || name === '.vscode'
    || name === '.next'
    || name === '.nuxt'
    || name === '.cache'
    || name === 'coverage'
    || name === '.turbo'
  );
}

interface SearchMatch {
  path: string;
  line: number;
  text: string;
  lines: string[];
  artifactRef: ReturnType<typeof fileSegmentRef>;
}

function fileSegmentRef(filePath: string, startLine: number, endLine: number, excerpt: string) {
  return {
    kind: 'file_segment' as const,
    path: filePath,
    startLine,
    endLine,
    sha256: createHash('sha256').update(excerpt).digest('hex'),
    excerpt: excerpt.length > 2000 ? `${excerpt.slice(0, 2000)}\n... [truncated]` : excerpt,
  };
}

function safeRegex(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    try {
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch {
      return null;
    }
  }
}

function collectSearchQueries(args: Record<string, unknown>): string[] {
  const queries: string[] = [];
  if (typeof args.query === 'string' && args.query.trim()) {
    queries.push(args.query.trim());
  }
  if (Array.isArray(args.queries)) {
    for (const item of args.queries) {
      if (typeof item === 'string' && item.trim()) {
        queries.push(item.trim());
      }
    }
  }
  return [...new Set(queries.map((query) => query.replace(/\s+/g, ' ')))].slice(0, 4);
}

async function fetchUrlAsToolResult(rawUrl: string, ctx: ToolContext): Promise<ToolResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      output: 'Missing or invalid URL for web_search open_page',
      status: 'failed',
      error: { message: 'url must be a valid HTTP/HTTPS URL', code: 'INVALID_ARGUMENTS' },
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      output: `Unsupported URL protocol for web_search open_page: ${url.protocol}`,
      status: 'failed',
      error: { message: 'only http and https URLs are supported', code: 'INVALID_ARGUMENTS' },
    };
  }

  try {
    const page = await createWebProviderRouter(ctx).openPage({ url: url.toString(), signal: ctx.signal });
    const output = [
      `Opened page: ${page.finalUrl ?? page.url}`,
      page.status !== undefined ? `Status: ${page.status} ${page.statusText ?? ''}`.trim() : undefined,
      page.contentType ? `Content-Type: ${page.contentType}` : undefined,
      `Provider: ${page.provider}`,
      page.title ? `Title: ${page.title}` : undefined,
      '',
      page.text || '[empty response body]',
    ].filter((line) => line !== undefined).join('\n');

    return {
      output,
      status: page.status === undefined || page.status < 400 ? 'completed' : 'failed',
      data: {
        action: 'open_page',
        url: page.url,
        finalUrl: page.finalUrl,
        status: page.status,
        contentType: page.contentType,
        provider: page.provider,
        title: page.title,
        text: page.text,
        truncated: page.truncated,
        metadata: page.metadata,
      },
      error: page.status === undefined || page.status < 400
        ? undefined
        : { message: `HTTP ${page.status} ${page.statusText ?? ''}`.trim(), code: 'WEB_FETCH_FAILED' },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      output: `web_search open_page failed for "${url.toString()}": ${message}`,
      status: 'failed',
      error: { message, code: 'WEB_FETCH_FAILED' },
    };
  }
}

async function findInPageAsToolResult(rawUrl: string, pattern: string, ctx: ToolContext): Promise<ToolResult> {
  if (!pattern) {
    return {
      output: 'Missing pattern for web_search find_in_page',
      status: 'failed',
      error: { message: 'pattern is required for action="find_in_page"', code: 'INVALID_ARGUMENTS' },
    };
  }
  let result: Awaited<ReturnType<WebProviderRouter['findInPage']>>;
  try {
    result = await createWebProviderRouter(ctx).findInPage({ url: rawUrl, pattern, signal: ctx.signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      output: `web_search find_in_page failed for "${rawUrl}": ${message}`,
      status: 'failed',
      error: { message, code: 'WEB_FETCH_FAILED' },
    };
  }
  const output = [
    `Find in page: "${pattern}" in ${result.url}`,
    `Provider: ${result.provider}`,
    result.title ? `Title: ${result.title}` : undefined,
    '',
    result.matches.length > 0
      ? result.matches.map((match) => `${match.lineNumber}: ${match.line}`).join('\n')
      : 'No matches found.',
  ].filter((line) => line !== undefined).join('\n');
  return {
    output,
    status: 'completed',
    data: {
      action: 'find_in_page',
      url: result.url,
      provider: result.provider,
      pattern,
      matches: result.matches,
    },
  };
}

function createWebProviderRouter(ctx: ToolContext): WebProviderRouter {
  return new WebProviderRouter(ctx.webProvider);
}

function dedupeSearchResults<T extends { url: string }>(results: T[]): T[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

type SuanliziPatchAction =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: SuanliziPatchHunk[] };

interface SuanliziPatchHunk {
  lines: Array<{ prefix: ' ' | '+' | '-'; text: string }>;
  // 实际新增的行内容（不含 '+' 前缀），在 parseSuanliziPatch 中按出现顺序收集
  addedLinesContent: string[];
  // 实际删除的行内容（不含 '-' 前缀），在 parseSuanliziPatch 中按出现顺序收集
  removedLinesContent: string[];
}

interface AppliedChange {
  path: string;
  kind: 'add' | 'delete' | 'update';
  addedLines: number;
  removedLines: number;
  hunks: Array<{
    path: string;
    addedLines: number;
    removedLines: number;
    addedLinesContent: string[];
    removedLinesContent: string[];
    startLine?: number;
    endLine?: number;
    summary?: string;
  }>;
  summary: string;
}

function parseSuanliziPatch(patch: string): SuanliziPatchAction[] {
  const lines = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let index = 0;
  if (lines[index] !== '*** Begin Patch') throw new Error('missing "*** Begin Patch"');
  index++;
  const actions: SuanliziPatchAction[] = [];

  while (index < lines.length) {
    const line = lines[index];
    if (line === '*** End Patch' || (line === '' && lines[index + 1] === undefined)) break;
    if (line.startsWith('*** Add File: ')) {
      const filePath = line.slice('*** Add File: '.length).trim();
      index++;
      const addLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith('*** ')) {
        if (!lines[index].startsWith('+')) throw new Error(`add file ${filePath} contains a non-add line`);
        addLines.push(lines[index].slice(1));
        index++;
      }
      actions.push({ kind: 'add', path: filePath, lines: addLines });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      actions.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim() });
      index++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const filePath = line.slice('*** Update File: '.length).trim();
      index++;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith('*** Move to: ')) {
        moveTo = lines[index].slice('*** Move to: '.length).trim();
        index++;
      }
      const hunks: SuanliziPatchHunk[] = [];
      let current: SuanliziPatchHunk | null = null;
      while (index < lines.length && !lines[index].startsWith('*** ')) {
        const hunkLine = lines[index];
        if (hunkLine === '' && index === lines.length - 1) break;
        if (hunkLine.startsWith('@@')) {
          if (current) hunks.push(current);
          current = { lines: [], addedLinesContent: [], removedLinesContent: [] };
          index++;
          continue;
        }
        if (hunkLine === '*** End of File') {
          index++;
          continue;
        }
        if (!current) current = { lines: [], addedLinesContent: [], removedLinesContent: [] };
        const prefix = hunkLine[0];
        if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
          throw new Error(`invalid patch line in ${filePath}: ${hunkLine}`);
        }
        const text = hunkLine.slice(1);
        current.lines.push({ prefix, text });
        // 中文注释：按行类型收集实际新增/删除内容（不含 +/- 前缀）
        if (prefix === '+') current.addedLinesContent.push(text);
        else if (prefix === '-') current.removedLinesContent.push(text);
        index++;
      }
      if (current) hunks.push(current);
      if (!moveTo && hunks.length === 0) throw new Error(`update file ${filePath} has no hunks`);
      actions.push({ kind: 'update', path: filePath, moveTo, hunks });
      continue;
    }
    throw new Error(`unexpected patch line: ${line}`);
  }
  if (!lines.includes('*** End Patch')) throw new Error('missing "*** End Patch"');
  if (actions.length === 0) throw new Error('patch has no file operations');
  return actions;
}

async function applySuanliziPatchActions(
  workspaceRoot: string,
  actions: SuanliziPatchAction[],
  approvedPaths: Map<string, string>,
): Promise<AppliedChange[]> {
  const staged = new Map<string, string | null>();
  const changes: AppliedChange[] = [];

  for (const action of actions) {
    if (action.kind === 'add') {
      const abs = approvedPatchPath(approvedPaths, action.path);
      staged.set(abs, action.lines.join('\n'));
      changes.push({
        path: action.path,
        kind: 'add',
        addedLines: action.lines.length,
        removedLines: 0,
        hunks: [{
          path: action.path,
          addedLines: action.lines.length,
          removedLines: 0,
          // 中文注释：新增文件时，整文件内容即为新增行内容
          addedLinesContent: action.lines.slice(),
          removedLinesContent: [],
        }],
        summary: `add ${action.path}`,
      });
      continue;
    }
    if (action.kind === 'delete') {
      const abs = approvedPatchPath(approvedPaths, action.path);
      const content = await readStagedOrDisk(staged, abs);
      if (content === null) throw new Error(`${action.path}: file not found`);
      staged.set(abs, null);
      const removedLinesContent = splitPatchLines(content);
      const removed = removedLinesContent.length;
      changes.push({
        path: action.path,
        kind: 'delete',
        addedLines: 0,
        removedLines: removed,
        hunks: [{
          path: action.path,
          addedLines: 0,
          removedLines: removed,
          addedLinesContent: [],
          // 中文注释：删除文件时，整文件内容即为被删除行内容
          removedLinesContent,
        }],
        summary: `delete ${action.path}`,
      });
      continue;
    }
    const abs = approvedPatchPath(approvedPaths, action.path);
    const original = await readStagedOrDisk(staged, abs);
    if (original === null) throw new Error(`${action.path}: file not found`);
    const applied = applyUpdateHunks(original, action.path, action.hunks);
    const targetAbs = action.moveTo ? approvedPatchPath(approvedPaths, action.moveTo) : abs;
    staged.set(abs, action.moveTo ? null : applied.content);
    if (action.moveTo) staged.set(targetAbs, applied.content);
    if (action.moveTo) {
      // 中文注释：rename/move 拆分为两个 change：源 delete + 目标 add，
      // 这样 createProjectCheckpointItem 会分别为源路径与目标路径建立快照，
      // rollback 时才能正确删除目标文件并把源文件原内容写回源路径。
      const removedLinesContent = splitPatchLines(original);
      changes.push({
        path: action.path,
        kind: 'delete',
        addedLines: 0,
        removedLines: removedLinesContent.length,
        hunks: [{
          path: action.path,
          addedLines: 0,
          removedLines: removedLinesContent.length,
          addedLinesContent: [],
          removedLinesContent,
        }],
        summary: `delete ${action.path}`,
      });
      const addedLinesContent = splitPatchLines(applied.content);
      changes.push({
        path: action.moveTo,
        kind: 'add',
        addedLines: addedLinesContent.length,
        removedLines: 0,
        hunks: [{
          path: action.moveTo,
          addedLines: addedLinesContent.length,
          removedLines: 0,
          addedLinesContent,
          removedLinesContent: [],
        }],
        summary: `add ${action.moveTo} (moved from ${action.path})`,
      });
    } else {
      changes.push({
        path: action.path,
        kind: 'update',
        addedLines: applied.added,
        removedLines: applied.removed,
        hunks: applied.hunks.map((hunk) => ({ ...hunk, path: action.path })),
        summary: `update ${action.path}`,
      });
    }
  }

  for (const [absPath, content] of staged) {
    if (content === null) {
      await assertCanonicalToolPathStable(workspaceRoot, absPath);
      await fs.rm(absPath, { force: true });
    } else {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await assertCanonicalToolPathStable(workspaceRoot, absPath);
      await fs.writeFile(absPath, content, 'utf-8');
    }
  }
  return changes;
}

function approvedPatchPath(approvedPaths: Map<string, string>, requestedPath: string): string {
  const approvedPath = approvedPaths.get(requestedPath);
  if (!approvedPath) throw new Error(`Patch path was not approved: ${requestedPath}`);
  return approvedPath;
}

async function readStagedOrDisk(staged: Map<string, string | null>, absPath: string): Promise<string | null> {
  if (staged.has(absPath)) return staged.get(absPath) ?? null;
  try {
    return await fs.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
}

function applyUpdateHunks(content: string, filePath: string, hunks: SuanliziPatchHunk[]): {
  content: string;
  added: number;
  removed: number;
  hunks: AppliedChange['hunks'];
} {
  const hadTrailingNewline = content.endsWith('\n');
  let lines = splitPatchLines(content);
  let added = 0;
  let removed = 0;
  const appliedHunks: AppliedChange['hunks'] = [];

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.prefix !== '+').map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.prefix !== '-').map((line) => line.text);
    const index = findLineSequence(lines, oldLines);
    if (index < 0) throw new Error(`${filePath}: hunk context not found`);
    lines = [
      ...lines.slice(0, index),
      ...newLines,
      ...lines.slice(index + oldLines.length),
    ];
    const hunkAdded = hunk.lines.filter((line) => line.prefix === '+').length;
    const hunkRemoved = hunk.lines.filter((line) => line.prefix === '-').length;
    added += hunkAdded;
    removed += hunkRemoved;
    appliedHunks.push({
      path: filePath,
      startLine: index + 1,
      endLine: index + Math.max(oldLines.length, 1),
      addedLines: hunkAdded,
      removedLines: hunkRemoved,
      // 中文注释：透传在 parseSuanliziPatch 阶段收集到的实际行内容
      addedLinesContent: hunk.addedLinesContent.slice(),
      removedLinesContent: hunk.removedLinesContent.slice(),
      summary: `+${hunkAdded}/-${hunkRemoved}`,
    });
  }

  const next = lines.join('\n') + (hadTrailingNewline ? '\n' : '');
  return { content: next, added, removed, hunks: appliedHunks };
}

function splitPatchLines(content: string): string[] {
  const withoutFinalNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
  if (withoutFinalNewline === '') return [];
  return withoutFinalNewline.split('\n');
}

function findLineSequence(lines: string[], target: string[]): number {
  if (target.length === 0) return lines.length;
  for (let i = 0; i <= lines.length - target.length; i++) {
    let matched = true;
    for (let j = 0; j < target.length; j++) {
      if (lines[i + j] !== target[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}
