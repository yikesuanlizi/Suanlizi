import type {
  EpisodeLifecycle,
  EpisodeRecord,
  EpisodeSearchOptions,
  ThreadId,
  TurnId,
} from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { createHash, randomUUID } from 'node:crypto';

// ─── Episode Memory Settings ────────────────────────────────────────────────

export interface EpisodeMemorySettings {
  episodeMemoryEnabled: boolean;
  episodeInjectLimit: number;
  episodeTokenBudget: number;
  episodeSwitchCooldownTurns: number;
  episodeSealIdleMinutes: number;
  episodeColdAfterDays: number;
  episodeFtsCandidateLimit: number;
  episodeRerankEnabled: boolean;
}

export const DEFAULT_EPISODE_MEMORY_SETTINGS: EpisodeMemorySettings = {
  episodeMemoryEnabled: true,
  episodeInjectLimit: 2,
  episodeTokenBudget: 800,
  episodeSwitchCooldownTurns: 2,
  episodeSealIdleMinutes: 20,
  episodeColdAfterDays: 7,
  episodeFtsCandidateLimit: 40,
  episodeRerankEnabled: false,
};

export async function getEpisodeMemorySettings(store: ThreadStore): Promise<EpisodeMemorySettings> {
  return normalizeEpisodeMemorySettings(
    await store.getSetting<Partial<EpisodeMemorySettings>>('episode.memory.settings.v1'),
  );
}

export async function setEpisodeMemorySettings(
  store: ThreadStore,
  patch: Partial<EpisodeMemorySettings>,
): Promise<EpisodeMemorySettings> {
  const next = normalizeEpisodeMemorySettings({
    ...(await getEpisodeMemorySettings(store)),
    ...patch,
  });
  await store.setSetting('episode.memory.settings.v1', next);
  return next;
}

export function normalizeEpisodeMemorySettings(
  input: Partial<EpisodeMemorySettings> | null | undefined,
): EpisodeMemorySettings {
  return {
    episodeMemoryEnabled: input?.episodeMemoryEnabled ?? DEFAULT_EPISODE_MEMORY_SETTINGS.episodeMemoryEnabled,
    episodeInjectLimit: clampInteger(
      input?.episodeInjectLimit,
      0,
      10,
      DEFAULT_EPISODE_MEMORY_SETTINGS.episodeInjectLimit,
    ),
    episodeTokenBudget: clampInteger(
      input?.episodeTokenBudget,
      200,
      4000,
      DEFAULT_EPISODE_MEMORY_SETTINGS.episodeTokenBudget,
    ),
    episodeSwitchCooldownTurns: clampInteger(
      input?.episodeSwitchCooldownTurns,
      0,
      20,
      DEFAULT_EPISODE_MEMORY_SETTINGS.episodeSwitchCooldownTurns,
    ),
    episodeSealIdleMinutes: clampInteger(
      input?.episodeSealIdleMinutes,
      1,
      1440,
      DEFAULT_EPISODE_MEMORY_SETTINGS.episodeSealIdleMinutes,
    ),
    episodeColdAfterDays: clampInteger(
      input?.episodeColdAfterDays,
      1,
      365,
      DEFAULT_EPISODE_MEMORY_SETTINGS.episodeColdAfterDays,
    ),
    episodeFtsCandidateLimit: clampInteger(
      input?.episodeFtsCandidateLimit,
      10,
      200,
      DEFAULT_EPISODE_MEMORY_SETTINGS.episodeFtsCandidateLimit,
    ),
    episodeRerankEnabled:
      input?.episodeRerankEnabled ?? DEFAULT_EPISODE_MEMORY_SETTINGS.episodeRerankEnabled,
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

// ─── Episode Construction & Update ──────────────────────────────────────────

export interface CreateEpisodeInput {
  workspaceRoot: string;
  sourceThreadId: ThreadId;
  sourceTurnStart: TurnId;
  sourceTurnEnd: TurnId;
  sourceTurnStartIndex: number;
  sourceTurnEndIndex: number;
  title?: string;
  objective?: string;
}

export function createEpisodeRecord(input: CreateEpisodeInput, now = new Date()): EpisodeRecord {
  const objective = (input.objective ?? '').trim() || 'Current task segment';
  const record: EpisodeRecord = {
    tenantId: undefined,
    id: `ep_${now.getTime()}_${randomUUID().slice(0, 8)}`,
    workspaceRoot: input.workspaceRoot,
    sourceThreadId: input.sourceThreadId,
    sourceTurnStart: input.sourceTurnStart,
    sourceTurnEnd: input.sourceTurnEnd,
    sourceTurnStartIndex: input.sourceTurnStartIndex,
    sourceTurnEndIndex: input.sourceTurnEndIndex,
    lifecycle: 'open',
    temperature: 'warm',
    title: (input.title ?? '').trim() || objective.slice(0, 80),
    objective,
    summary: '',
    facts: [],
    decisions: [],
    artifacts: [],
    openTasks: [],
    entities: [],
    keywords: [],
    boundaryReason: 'opened',
    fingerprint: '',
    topicKey: '',
    usageCount: 0,
    lastActivatedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  record.topicKey = computeEpisodeTopicKey(record);
  record.fingerprint = computeEpisodeFingerprint(record);
  return record;
}

export function updateEpisodeFromTurn(
  episode: EpisodeRecord,
  turnId: TurnId,
  turnIndex: number,
  userText: string,
  assistantText: string,
  items: { type: string; text?: string; path?: string; items?: Array<{ text: string; completed: boolean }> }[],
  now = new Date(),
): EpisodeRecord {
  const next: EpisodeRecord = {
    ...episode,
    sourceTurnEnd: turnId,
    sourceTurnEndIndex: turnIndex,
    updatedAt: now.toISOString(),
  };

  // Extract simple facts from user statements and assistant answers
  const combinedText = `${userText}\n${assistantText}`;
  const factCandidates = extractListItems(combinedText, /[-*]\s*(.+)/g).slice(0, 8);
  next.facts = unique([...next.facts, ...factCandidates].map((s) => compact(s)).filter(Boolean));

  // Extract decisions: lines that look like conclusions or agreements
  const decisionCandidates = extractListItems(combinedText, /(?:decided|决定|采用|使用|将|will| agreed to|use)\s+(.+?)(?:[。！.!]|$)/gi);
  next.decisions = unique([...next.decisions, ...decisionCandidates].map((s) => compact(s)).filter(Boolean));

  // Extract entities: quoted terms, file paths, code symbols
  const entities = new Set(next.entities);
  const quoted = combinedText.match(/"([^"]{2,80})"/g) ?? [];
  for (const q of quoted) entities.add(q.replace(/"/g, ''));
  const paths = combinedText.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}/g) ?? [];
  for (const p of paths) entities.add(p);
  next.entities = [...entities].slice(0, 20);

  // Extract artifacts and open tasks from structured items
  const artifacts = new Set(next.artifacts);
  const openTasks = new Set(next.openTasks);
  for (const item of items) {
    if (item.type === 'file_change' && item.path) artifacts.add(item.path);
    if (item.type === 'todo_list' && Array.isArray(item.items)) {
      for (const t of item.items) {
        if (!t.completed) openTasks.add(t.text);
      }
    }
  }
  next.artifacts = [...artifacts].slice(0, 20);
  next.openTasks = [...openTasks].slice(0, 10);

  // Keywords: significant words plus entities
  next.keywords = deriveKeywords(next.title, next.objective, next.facts, next.decisions, next.entities).slice(0, 20);

  // Summary: compact overview
  next.summary = buildEpisodeSummary(next);

  // Recompute stable keys
  next.topicKey = computeEpisodeTopicKey(next);
  next.fingerprint = computeEpisodeFingerprint(next);
  return next;
}

export function sealEpisode(episode: EpisodeRecord, reason: string, now = new Date()): EpisodeRecord {
  if (episode.lifecycle !== 'open') return episode;
  return {
    ...episode,
    lifecycle: 'sealed',
    temperature: 'warm',
    boundaryReason: reason,
    summary: episode.summary || buildEpisodeSummary(episode),
    updatedAt: now.toISOString(),
  };
}

// ─── Persistence Helpers ────────────────────────────────────────────────────

export async function getOpenEpisodeForThread(
  store: ThreadStore,
  threadId: ThreadId,
): Promise<EpisodeRecord | null> {
  if (!store.listEpisodeRecords) return null;
  const rows = await store.listEpisodeRecords({
    threadId,
    lifecycle: ['open'],
    limit: 1,
  });
  return rows[0] ?? null;
}

export async function saveEpisodeRecord(store: ThreadStore, episode: EpisodeRecord): Promise<void> {
  if (!store.upsertEpisodeRecord) throw new Error('ThreadStore does not support episode memories');
  await store.upsertEpisodeRecord(episode);
}

export async function recordEpisodeUsage(store: ThreadStore, episodeId: string, usedAt: string): Promise<void> {
  if (!store.recordEpisodeUsage) return;
  await store.recordEpisodeUsage(episodeId, usedAt);
}

export async function listEpisodeRecords(
  store: ThreadStore,
  options: EpisodeSearchOptions = {},
): Promise<EpisodeRecord[]> {
  if (!store.listEpisodeRecords) return [];
  return store.listEpisodeRecords(options);
}

export async function searchEpisodeRecords(
  store: ThreadStore,
  query: string,
  options: EpisodeSearchOptions = {},
): Promise<EpisodeRecord[]> {
  if (!store.searchEpisodeRecords) return [];
  return store.searchEpisodeRecords(query, options);
}

// ─── Rollback Invalidation ──────────────────────────────────────────────────

export interface InvalidatedEpisodes {
  rolledBack: string[];
  stale: string[];
}

export interface PruneStaleEpisodeOptions {
  staleAfterDays?: number;
  now?: Date;
}

export async function invalidateEpisodesByTurnRange(
  store: ThreadStore,
  threadId: ThreadId,
  newTurnCount: number,
): Promise<InvalidatedEpisodes> {
  if (!store.listEpisodeRecords || !store.upsertEpisodeRecord) return { rolledBack: [], stale: [] };
  const episodes = await store.listEpisodeRecords({ threadId });
  const rolledBack: string[] = [];
  const stale: string[] = [];
  const now = new Date().toISOString();
  for (const episode of episodes) {
    if (episode.lifecycle === 'rolled_back') continue;
    if (episode.sourceThreadId !== threadId) continue;
    const start = episode.sourceTurnStartIndex;
    const end = episode.sourceTurnEndIndex;
    let nextLifecycle: EpisodeLifecycle | undefined;
    if (start >= newTurnCount) {
      nextLifecycle = 'rolled_back';
      rolledBack.push(episode.id);
    } else if (end >= newTurnCount) {
      nextLifecycle = 'stale';
      stale.push(episode.id);
    }
    if (nextLifecycle) {
      await store.upsertEpisodeRecord({
        ...episode,
        lifecycle: nextLifecycle,
        updatedAt: now,
      });
    }
  }
  return { rolledBack, stale };
}

export async function pruneStaleEpisodes(
  store: ThreadStore,
  options: PruneStaleEpisodeOptions = {},
): Promise<{ rolledBack: string[]; kept: string[] }> {
  if (!store.listEpisodeRecords || !store.upsertEpisodeRecord) return { rolledBack: [], kept: [] };
  const now = options.now ?? new Date();
  const staleAfterDays = options.staleAfterDays ?? 180;
  const threshold = new Date(now.getTime() - staleAfterDays * 86_400_000).toISOString();
  const candidates = await store.listEpisodeRecords({
    lifecycle: ['stale'],
    temperature: ['cold', 'warm'],
  });
  const rolledBack: string[] = [];
  const kept: string[] = [];

  for (const episode of candidates) {
    const lastTouchedAt = episode.lastActivatedAt ?? episode.updatedAt;
    const isOld = lastTouchedAt <= threshold;
    const protectedByUse = episode.usageCount > 0 || Boolean(episode.lastActivatedAt);
    if (isOld && !protectedByUse && episode.openTasks.length === 0) {
      await store.upsertEpisodeRecord({
        ...episode,
        lifecycle: 'rolled_back',
        updatedAt: now.toISOString(),
      });
      rolledBack.push(episode.id);
    } else {
      kept.push(episode.id);
    }
  }

  return { rolledBack, kept };
}

// ─── Temperature Migration ──────────────────────────────────────────────────

export async function demoteColdEpisodes(store: ThreadStore, coldAfterDays: number, now = new Date()): Promise<number> {
  if (!store.listEpisodeRecords || !store.upsertEpisodeRecord) return 0;
  const threshold = new Date(now.getTime() - coldAfterDays * 86_400_000).toISOString();
  const candidates = await store.listEpisodeRecords({
    lifecycle: ['sealed'],
    temperature: ['warm'],
  });
  let demoted = 0;
  for (const episode of candidates) {
    if (episode.openTasks.length > 0) continue;
    if (episode.lastActivatedAt && episode.lastActivatedAt > threshold) continue;
    if (episode.updatedAt > threshold) continue;
    await store.upsertEpisodeRecord({
      ...episode,
      temperature: 'cold',
      updatedAt: now.toISOString(),
    });
    demoted++;
  }
  return demoted;
}

export async function promoteEpisodeToWarm(store: ThreadStore, episodeId: string, now = new Date()): Promise<void> {
  if (!store.upsertEpisodeRecord) return;
  const episode = await store.getEpisodeRecord?.(episodeId);
  if (!episode || episode.temperature !== 'cold') return;
  await store.upsertEpisodeRecord({
    ...episode,
    temperature: 'warm',
    lastActivatedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}

// ─── Prompt Block ───────────────────────────────────────────────────────────

export function buildEpisodePromptBlock(episodes: EpisodeRecord[]): string {
  if (episodes.length === 0) return '';
  const lines = episodes.map((episode) => {
    const parts = [
      `episodeId=${episode.id}`,
      `sourceTurnRange=${episode.sourceTurnStartIndex}-${episode.sourceTurnEndIndex}`,
      `lifecycle=${episode.lifecycle}`,
      `temperature=${episode.temperature}`,
    ];
    const body = [
      episode.title && `title: ${episode.title}`,
      episode.objective && `objective: ${episode.objective}`,
      episode.summary && `summary: ${episode.summary}`,
      episode.facts.length > 0 && `facts: ${episode.facts.join('; ')}`,
      episode.decisions.length > 0 && `decisions: ${episode.decisions.join('; ')}`,
      episode.artifacts.length > 0 && `artifacts: ${episode.artifacts.join(', ')}`,
      episode.openTasks.length > 0 && `openTasks: ${episode.openTasks.join('; ')}`,
      episode.entities.length > 0 && `entities: ${episode.entities.join(', ')}`,
      episode.keywords.length > 0 && `keywords: ${episode.keywords.join(', ')}`,
    ].filter(Boolean);
    return `- [${parts.join(' ')}]\n${body.map((b) => `  ${b}`).join('\n')}`;
  });
  return [
    '## Episode Recall',
    'Previously sealed task segments that may be relevant to the current turn. Prefer them only when they match the current objective; each entry is source-marked for audit.',
    ...lines,
  ].join('\n');
}

// ─── Stable Keys ────────────────────────────────────────────────────────────

function computeEpisodeFingerprint(episode: EpisodeRecord): string {
  const normalizedDecisions = [...episode.decisions].sort().join('|').toLowerCase().trim();
  const normalizedArtifacts = [...episode.artifacts].sort().join('|').trim();
  const sourceRange = `${episode.sourceTurnStartIndex}-${episode.sourceTurnEndIndex}`;
  const payload = `${episode.objective.trim().toLowerCase()}\n${normalizedDecisions}\n${normalizedArtifacts}\n${sourceRange}`;
  return sha256(payload);
}

function computeEpisodeTopicKey(episode: EpisodeRecord): string {
  const normalizedDecisions = [...episode.decisions].sort().join('|').toLowerCase().trim();
  const normalizedArtifacts = [...episode.artifacts].sort().join('|').trim();
  const payload = `${episode.objective.trim().toLowerCase()}\n${normalizedDecisions}\n${normalizedArtifacts}`;
  return sha256(payload);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

// ─── Text Helpers ───────────────────────────────────────────────────────────

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function extractListItems(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    out.push(match[1] ?? match[0]);
  }
  return out;
}

function deriveKeywords(
  title: string,
  objective: string,
  facts: string[],
  decisions: string[],
  entities: string[],
): string[] {
  const raw = `${title} ${objective} ${facts.join(' ')} ${decisions.join(' ')} ${entities.join(' ')}`;
  const ascii = raw.toLowerCase().match(/[a-z0-9_./:-]{3,}/g) ?? [];
  const cjk = (raw.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((seg) => {
    const tokens = [seg];
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    return tokens;
  });
  return unique([...ascii, ...cjk]);
}

function buildEpisodeSummary(episode: EpisodeRecord): string {
  const parts = [
    episode.objective,
    episode.facts.slice(0, 3).join('; '),
    episode.decisions.slice(0, 3).join('; '),
    episode.openTasks.length > 0 ? `open: ${episode.openTasks.slice(0, 3).join('; ')}` : '',
  ].filter(Boolean);
  return compact(parts.join(' | '));
}
