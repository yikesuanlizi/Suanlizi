import * as path from 'node:path';
import type { FileFreshnessReason, ThreadItem } from '@suanlizi/protocol';
import { assessArtifactFreshness, loadDocumentArtifactLedger, registerExternalDocumentArtifactsFromText } from '@suanlizi/tools';

export interface StaleArtifactNotice {
  artifactPath: string;
  sourcePath: string;
  reason: FileFreshnessReason;
}

export interface FreshnessPreflightInput {
  workspaceRoot: string;
  locale: 'zh' | 'en';
  userText: string;
  recentItems: ThreadItem[];
  staleArtifacts?: StaleArtifactNotice[];
}

export interface FreshnessPreflightNotice {
  role: 'user';
  content: string;
  staleArtifacts: StaleArtifactNotice[];
  requiredDocumentPaths?: string[];
}

export function collectMentionedDocumentPaths(text: string): string[] {
  return collectPathsWithExtensions(text, ['.docx', '.pdf', '.xlsx', '.pptx']);
}

export async function buildFreshnessPreflightNotice(input: FreshnessPreflightInput): Promise<FreshnessPreflightNotice | null> {
  await registerCommandDerivedArtifacts(input.workspaceRoot, input.recentItems);
  const staleArtifacts = input.staleArtifacts ?? await findStaleArtifacts(input.workspaceRoot, input.userText, input.recentItems);
  if (staleArtifacts.length > 0) {
    const lines = input.locale === 'zh'
      ? [
          '文件知识新鲜度提醒：以下旧提取内容已经过期，依赖它前必须重新调用 read_document。',
          ...staleArtifacts.map((entry) => `- 源文件：${entry.sourcePath}；旧提取物：${entry.artifactPath}；原因：${entry.reason}`),
        ]
      : [
          'File freshness warning: the following extracted artifacts are stale. Call read_document before relying on them.',
          ...staleArtifacts.map((entry) => `- source: ${entry.sourcePath}; artifact: ${entry.artifactPath}; reason: ${entry.reason}`),
        ];
    return { role: 'user', content: lines.join('\n'), staleArtifacts };
  }

  const requiredDocumentPaths = shouldVerifyRecentDocuments(input.userText)
    ? collectRequiredDocumentPaths(input.workspaceRoot, input.userText, input.recentItems)
    : [];
  if (requiredDocumentPaths.length === 0) return null;
  const lines = input.locale === 'zh'
    ? [
        '文件知识校验提醒：当前问题像是在继续讨论之前的文档。回答前请先调用 read_document 重新读取或复用以下源文件，避免基于旧摘要、旧脚本产物或旧上下文回答。',
        ...requiredDocumentPaths.map((entry) => `- 源文件：${entry}`),
      ]
    : [
        'File knowledge verification: this looks like a follow-up about previously discussed documents. Call read_document before answering so the response is not based on stale summaries, helper artifacts, or old context.',
        ...requiredDocumentPaths.map((entry) => `- source: ${entry}`),
      ];
  return { role: 'user', content: lines.join('\n'), staleArtifacts: [], requiredDocumentPaths };
}

async function findStaleArtifacts(
  workspaceRoot: string,
  userText: string,
  recentItems: ThreadItem[],
): Promise<StaleArtifactNotice[]> {
  const ledger = await loadDocumentArtifactLedger(workspaceRoot);
  const mentioned = new Set(collectMentionedDocumentPaths(userText).map((entry) => normalizePath(workspaceRoot, entry)));
  const recentSources = new Set(recentItems.flatMap(readRecentDocumentPathsFromItem).map((entry) => normalizePath(workspaceRoot, entry)));
  const selected = ledger.records.filter((record) => (
    mentioned.has(normalizePath(workspaceRoot, record.sourcePath))
    || recentSources.has(normalizePath(workspaceRoot, record.sourcePath))
  ));
  const stale: StaleArtifactNotice[] = [];
  for (const record of selected) {
    const freshness = await assessArtifactFreshness(workspaceRoot, record);
    if (freshness.status !== 'fresh' && freshness.reason && freshness.sourcePath && freshness.artifactPath) {
      stale.push({ sourcePath: freshness.sourcePath, artifactPath: freshness.artifactPath, reason: freshness.reason });
    }
  }
  return stale;
}

function readDocumentSourcePathsFromItem(item: ThreadItem): string[] {
  if (item.type !== 'tool_call' || item.toolName !== 'read_document' || item.status === 'failed') return [];
  const result = item.result && typeof item.result === 'object' ? item.result as { source?: { path?: unknown } } : {};
  return typeof result.source?.path === 'string' ? [result.source.path] : [];
}

function shouldVerifyRecentDocuments(userText: string): boolean {
  return collectMentionedDocumentPaths(userText).length > 0
    || /(现在|继续|再看|再分析|适合|开发|评估|评价|判断|总结|更新|最新|改完|版本|v\d+(?:\.\d+)?|now|continue|again|ready|develop|development|review|evaluate|version|latest|current)/i.test(userText);
}

function collectRequiredDocumentPaths(
  workspaceRoot: string,
  userText: string,
  recentItems: ThreadItem[],
): string[] {
  const paths = new Map<string, string>();
  const add = (value: string) => {
    if (!value) return;
    const absolutePath = path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
    paths.set(normalizePath(workspaceRoot, absolutePath), absolutePath);
  };

  for (const mentioned of collectMentionedDocumentPaths(userText)) add(mentioned);
  for (const item of recentItems) {
    for (const sourcePath of readRecentDocumentPathsFromItem(item)) add(sourcePath);
  }
  return [...paths.values()];
}

function readRecentDocumentPathsFromItem(item: ThreadItem): string[] {
  if (item.type === 'tool_call') return readDocumentSourcePathsFromItem(item);
  if (item.type === 'command_execution') {
    return collectMentionedDocumentPaths(`${item.command ?? ''}\n${item.aggregatedOutput ?? ''}`);
  }
  if (item.type === 'file_change') {
    const paths: string[] = [];
    for (const change of item.changes ?? []) {
      if (typeof change.path === 'string') paths.push(...collectMentionedDocumentPaths(change.path));
    }
    for (const hunk of item.hunks ?? []) {
      for (const line of [...(hunk.addedLinesContent ?? []), ...(hunk.removedLinesContent ?? [])]) {
        paths.push(...collectMentionedDocumentPaths(line));
      }
    }
    return paths;
  }
  return [];
}

function normalizePath(workspaceRoot: string, value: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(workspaceRoot, value)).toLowerCase();
}

async function registerCommandDerivedArtifacts(workspaceRoot: string, recentItems: ThreadItem[]): Promise<void> {
  for (const item of recentItems) {
    if (item.type !== 'command_execution' || item.status === 'failed') continue;
    await registerExternalDocumentArtifactsFromText(workspaceRoot, `${item.command ?? ''}\n${item.aggregatedOutput ?? ''}`);
  }
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
  return [...new Set(paths.map(cleanPathCandidate).filter(Boolean))];
}

function cleanPathCandidate(value: string): string {
  return value.replace(/^[`([{]+/u, '').replace(/[，。；、,.!?:;）)\]}`]+$/u, '');
}
