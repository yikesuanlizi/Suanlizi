import type { MemoryRecord, MemoryRecordScope, MemoryRecordType, ThreadId, TurnId } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type { MemoryRecord } from '@suanlizi/protocol';

export interface MemorySettings {
  memoryEnabled: boolean;
  autoExtractMemories: boolean;
  useColdMemories: boolean;
  memoryInjectLimit: number;
  memoryTokenBudget: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  memoryEnabled: true,
  autoExtractMemories: true,
  useColdMemories: true,
  memoryInjectLimit: 6,
  memoryTokenBudget: 1200,
};

export interface MemoryCandidate {
  id: string;
  type: MemoryRecordType;
  text: string;
  scope: MemoryRecordScope;
  sourceThreadId: ThreadId;
  sourceTurnIds: TurnId[];
  workspaceRoot?: string;
  tags: string[];
  confidence: number;
  createdAt: string;
}

export interface MemorySearchResult {
  score: number;
  reason: string;
  record: MemoryRecord;
}

export interface ExtractMemoryCandidateInput {
  threadId: ThreadId;
  turnId: TurnId;
  workspaceRoot?: string;
  userText: string;
  assistantText: string;
  now?: Date;
}

export interface SearchColdMemoryOptions {
  workspaceRoot?: string;
  limit?: number;
  tokenBudget?: number;
  now?: Date;
}

export interface PruneColdMemoryOptions {
  maxAgeDays?: number;
  minConfidence?: number;
  now?: Date;
}

export interface PruneColdMemoryResult {
  deleted: string[];
  kept: string[];
}

export async function getMemorySettings(store: ThreadStore): Promise<MemorySettings> {
  return normalizeMemorySettings(await store.getSetting<Partial<MemorySettings>>('memory.settings.v1'));
}

export async function setMemorySettings(store: ThreadStore, patch: Partial<MemorySettings>): Promise<MemorySettings> {
  const next = normalizeMemorySettings({ ...(await getMemorySettings(store)), ...patch });
  await store.setSetting('memory.settings.v1', next);
  return next;
}

export function normalizeMemorySettings(input: Partial<MemorySettings> | null | undefined): MemorySettings {
  return {
    memoryEnabled: input?.memoryEnabled ?? DEFAULT_MEMORY_SETTINGS.memoryEnabled,
    autoExtractMemories: input?.autoExtractMemories ?? DEFAULT_MEMORY_SETTINGS.autoExtractMemories,
    useColdMemories: input?.useColdMemories ?? DEFAULT_MEMORY_SETTINGS.useColdMemories,
    memoryInjectLimit: clampInteger(input?.memoryInjectLimit, 1, 20, DEFAULT_MEMORY_SETTINGS.memoryInjectLimit),
    memoryTokenBudget: clampInteger(input?.memoryTokenBudget, 200, 4000, DEFAULT_MEMORY_SETTINGS.memoryTokenBudget),
  };
}

export function extractMemoryCandidates(input: ExtractMemoryCandidateInput): MemoryCandidate[] {
  const now = input.now ?? new Date();
  const text = `${input.userText}\n${input.assistantText}`.replace(/\s+/g, ' ').trim();
  if (text.length < 8) return [];
  const candidates: MemoryCandidate[] = [];
  const userText = input.userText.trim();

  if (/(偏好|喜欢|以后|默认|保持|请一直|总是|不要|prefer|always|default|remember)/i.test(userText)) {
    candidates.push(candidate(input, 'preference', compactSentence(userText), 'global', ['preference'], 0.86, now));
  }

  if (/(只允许|必须|项目|目录|路径|配置|命令|工具链|测试命令|workspace|repo|repository|AGENTS\.md|Suanlizi\/|codex\/|pnpm|npm|yarn|bun|vitest|pytest|eslint|prettier)/i.test(userText)) {
    candidates.push(candidate(input, 'project_fact', compactSentence(userText), 'workspace', ['project'], 0.84, now));
  }

  if (/(流程|步骤|先.+再|每次|工作流|workflow|pattern|checklist|TDD|失败测试|测试先行)/i.test(userText)) {
    candidates.push(candidate(input, 'workflow_pattern', compactSentence(userText), 'workspace', ['workflow'], 0.82, now));
  }

  if (/(本机|系统|环境|shell|PowerShell|Windows|macOS|Linux|node|python|路径根目录|环境变量|env)/i.test(userText)) {
    candidates.push(candidate(input, 'environment_note', compactSentence(userText), 'workspace', ['environment'], 0.8, now));
  }

  if (/(失败|报错|根因|修复|workaround|failed|error|fix|原因)/i.test(text) && input.assistantText.trim().length > 12) {
    candidates.push(candidate(
      input,
      'failure_lesson',
      compactSentence(`${userText} -> ${input.assistantText.trim()}`),
      'workspace',
      ['lesson'],
      0.78,
      now,
    ));
  }

  return dedupeCandidates(candidates).filter((item) => item.confidence >= 0.7 && item.text.length >= 8);
}

export async function mergeMemoryCandidate(
  store: ThreadStore,
  candidateInput: MemoryCandidate,
  now: Date = new Date(),
): Promise<MemoryRecord> {
  if (!store.listMemoryRecords || !store.upsertMemoryRecord) {
    throw new Error('ThreadStore does not support cold memories');
  }
  const existing = (await store.listMemoryRecords({
    workspaceRoot: candidateInput.workspaceRoot,
    types: [candidateInput.type],
  })).find((record) => (
    record.type === candidateInput.type
    && normalizeMemoryText(record.text) === normalizeMemoryText(candidateInput.text)
  ));
  const record: MemoryRecord = existing
    ? {
        ...existing,
        sourceTurnIds: unique([...existing.sourceTurnIds, ...candidateInput.sourceTurnIds]),
        tags: unique([...existing.tags, ...candidateInput.tags]),
        confidence: Math.max(existing.confidence, candidateInput.confidence),
        updatedAt: now.toISOString(),
      }
    : {
        id: `mem_${now.getTime()}_${candidateInput.type}_${hashText(candidateInput.text)}`,
        type: candidateInput.type,
        text: candidateInput.text,
        status: 'active',
        scope: candidateInput.scope,
        sourceThreadId: candidateInput.sourceThreadId,
        sourceTurnIds: candidateInput.sourceTurnIds,
        workspaceRoot: candidateInput.workspaceRoot,
        tags: candidateInput.tags,
        confidence: candidateInput.confidence,
        usageCount: 0,
        lastUsedAt: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
  await store.upsertMemoryRecord(record);
  return record;
}

export async function searchColdMemories(
  store: ThreadStore,
  query: string,
  options: SearchColdMemoryOptions = {},
): Promise<MemorySearchResult[]> {
  const records = store.listMemoryRecords
    ? await store.listMemoryRecords({ workspaceRoot: options.workspaceRoot })
    : [];
  const queryTokens = expandTokens(tokenize(query));
  const now = options.now ?? new Date();
  const ranked = records
    .map((record) => scoreMemory(record, queryTokens, options.workspaceRoot, now))
    .filter((result) => result.score > 0 && isRelevantMemoryResult(result))
    .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));
  const limited: MemorySearchResult[] = [];
  let usedChars = 0;
  const maxChars = Math.max(80, Math.floor((options.tokenBudget ?? DEFAULT_MEMORY_SETTINGS.memoryTokenBudget) * 4));
  for (const result of ranked) {
    if (limited.length >= (options.limit ?? DEFAULT_MEMORY_SETTINGS.memoryInjectLimit)) break;
    usedChars += result.record.text.length;
    if (usedChars > maxChars && limited.length > 0) break;
    limited.push(result);
  }
  return limited;
}

export async function pruneColdMemories(
  store: ThreadStore,
  options: PruneColdMemoryOptions = {},
): Promise<PruneColdMemoryResult> {
  if (!store.listMemoryRecords || !store.upsertMemoryRecord) return { deleted: [], kept: [] };
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? 180;
  const minConfidence = options.minConfidence ?? 0.65;
  const records = await store.listMemoryRecords();
  const deleted: string[] = [];
  const kept: string[] = [];

  for (const record of records) {
    const lastTouchedAt = record.lastUsedAt ?? record.updatedAt ?? record.createdAt;
    const ageDays = Math.max(0, (now.getTime() - Date.parse(lastTouchedAt)) / 86_400_000);
    const lowValue = record.confidence < minConfidence || (record.usageCount === 0 && record.type === 'environment_note');
    const protectedByUse = record.usageCount > 0 || Boolean(record.lastUsedAt);
    if (!protectedByUse && lowValue && ageDays >= maxAgeDays) {
      await store.upsertMemoryRecord({
        ...record,
        status: 'deleted',
        updatedAt: now.toISOString(),
      });
      deleted.push(record.id);
    } else {
      kept.push(record.id);
    }
  }

  return { deleted, kept };
}

export async function exportMemoryArtifacts(store: ThreadStore, outputDir: string): Promise<{ writtenFiles: string[] }> {
  const records = store.listMemoryRecords ? await store.listMemoryRecords() : [];
  const active = records.filter((record) => record.status === 'active');
  const rolloutDir = path.join(outputDir, 'rollout_summaries');
  await fs.mkdir(rolloutDir, { recursive: true });
  const memoryPath = path.join(outputDir, 'MEMORY.md');
  const rawPath = path.join(outputDir, 'raw_memories.md');
  const writtenFiles = [memoryPath, rawPath];

  await fs.writeFile(memoryPath, renderMemoryIndex(active), 'utf8');
  await fs.writeFile(rawPath, renderRawMemories(active), 'utf8');
  for (const [threadId, grouped] of groupByThread(active)) {
    const file = path.join(rolloutDir, `${safeFileName(threadId)}.md`);
    await fs.writeFile(file, renderRolloutSummary(threadId, grouped), 'utf8');
    writtenFiles.push(file);
  }
  return { writtenFiles };
}

function candidate(
  input: ExtractMemoryCandidateInput,
  type: MemoryRecordType,
  text: string,
  scope: MemoryRecordScope,
  tags: string[],
  confidence: number,
  now: Date,
): MemoryCandidate {
  return {
    id: `candidate_${now.getTime()}_${hashText(`${type}:${text}`)}`,
    type,
    text,
    scope,
    sourceThreadId: input.threadId,
    sourceTurnIds: [input.turnId],
    workspaceRoot: input.workspaceRoot,
    tags,
    confidence,
    createdAt: now.toISOString(),
  };
}

function scoreMemory(record: MemoryRecord, queryTokens: string[], workspaceRoot: string | undefined, now: Date): MemorySearchResult {
  const haystack = expandTokens(tokenize(`${record.type} ${record.text} ${record.tags.join(' ')} ${record.workspaceRoot ?? ''}`));
  const matches = queryTokens.filter((token) => haystack.includes(token)).length;
  const workspaceBoost = workspaceRoot && record.workspaceRoot === workspaceRoot ? 2 : record.scope === 'global' ? 0.75 : 0;
  const usageBoost = Math.min(2, record.usageCount * 0.25);
  const ageDays = Math.max(0, (now.getTime() - Date.parse(record.updatedAt)) / 86_400_000);
  const recencyBoost = Math.max(0, 1.5 - ageDays / 30);
  const score = matches * 3 + workspaceBoost + usageBoost + recencyBoost + record.confidence;
  const reasons = [
    matches > 0 ? 'query' : '',
    workspaceBoost > 0 ? 'workspace' : '',
    usageBoost > 0 ? 'usage' : '',
    recencyBoost > 0 ? 'recency' : '',
  ].filter(Boolean);
  return { score, reason: reasons.join(', ') || 'baseline', record };
}

function isRelevantMemoryResult(result: MemorySearchResult): boolean {
  return result.reason.includes('query') || result.reason.includes('usage');
}

function renderMemoryIndex(records: MemoryRecord[]): string {
  return ['# Suanlizi Memory', '', ...records.map((record) => `- [${record.type}] ${record.text} (${record.id})`), ''].join('\n');
}

function renderRawMemories(records: MemoryRecord[]): string {
  if (records.length === 0) return '# Raw Memories\n\nNo active memories.\n';
  return ['# Raw Memories', '', ...records.map((record) => [
    `## ${record.id}`,
    `type: ${record.type}`,
    `scope: ${record.scope}`,
    `source_thread_id: ${record.sourceThreadId ?? 'unknown'}`,
    `workspace_root: ${record.workspaceRoot ?? 'global'}`,
    `confidence: ${record.confidence}`,
    '',
    record.text,
    '',
  ].join('\n'))].join('\n');
}

function renderRolloutSummary(threadId: string, records: MemoryRecord[]): string {
  return [`# ${threadId}`, '', ...records.map((record) => `- ${record.text}`), ''].join('\n');
}

function groupByThread(records: MemoryRecord[]): Array<[string, MemoryRecord[]]> {
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = record.sourceThreadId ?? 'unknown';
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const byKey = new Map<string, MemoryCandidate>();
  for (const item of candidates) byKey.set(`${item.type}:${normalizeMemoryText(item.text)}`, item);
  return [...byKey.values()];
}

function compactSentence(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 420);
}

function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function tokenize(text: string): string[] {
  const ascii = text.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [];
  const cjk = (text.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((segment) => {
    const tokens = [segment];
    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.push(segment.slice(index, index + 2));
    }
    return tokens;
  });
  return unique([...ascii, ...cjk]);
}

const TOKEN_SYNONYMS: Record<string, string[]> = {
  permission: ['权限'],
  permissions: ['权限'],
  auth: ['权限', '认证'],
  authorization: ['权限'],
  problem: ['问题', '错误', '报错'],
  issue: ['问题', '错误', '报错'],
  error: ['错误', '报错'],
  failure: ['失败'],
  fix: ['修复', '解决'],
  fixed: ['修复', '解决'],
  solve: ['解决'],
  solved: ['解决'],
  resolve: ['解决'],
  resolved: ['解决'],
  test: ['测试'],
  command: ['命令'],
};

function expandTokens(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const synonym of TOKEN_SYNONYMS[token] ?? []) {
      expanded.add(synonym);
    }
  }
  return [...expanded];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96) || 'unknown';
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}
