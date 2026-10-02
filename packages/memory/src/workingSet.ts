import type {
  EpisodeRecord,
  EpisodeSearchResult,
  ThreadId,
  ThreadMeta,
  ThreadWorkingSetSnapshot,
  TurnId,
  UserInput,
} from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { createHash } from 'node:crypto';
import {
  buildEpisodePromptBlock,
  createEpisodeRecord,
  demoteColdEpisodes,
  promoteEpisodeToWarm,
  recordEpisodeUsage,
  saveEpisodeRecord,
  sealEpisode,
  type EpisodeMemorySettings,
} from './episode.js';
import { retrieveEpisodesForWorkingSet } from './episodeRetrieval.js';

export interface WorkingSetResult {
  snapshot: ThreadWorkingSetSnapshot;
  activeEpisodes: EpisodeRecord[];
  openEpisode: EpisodeRecord | null;
  rebuilt: boolean;
  switchReason: SwitchReason;
}

export type SwitchReason =
  | 'explicit_user_switch'
  | 'implicit_topic_switch'
  | 'resume_previous_episode'
  | 'new_workspace_scope'
  | 'cooldown_rebuild_only'
  | 'no_switch';

export async function getThreadWorkingSetSnapshot(
  store: ThreadStore,
  threadId: ThreadId,
): Promise<ThreadWorkingSetSnapshot | null> {
  if (!store.getThreadWorkingSet) return null;
  return store.getThreadWorkingSet(threadId);
}

export async function saveThreadWorkingSetSnapshot(
  store: ThreadStore,
  snapshot: ThreadWorkingSetSnapshot,
): Promise<void> {
  if (!store.saveThreadWorkingSet) return;
  await store.saveThreadWorkingSet(snapshot);
}

export async function buildOrReuseWorkingSet(
  store: ThreadStore,
  thread: ThreadMeta,
  userInput: UserInput,
  currentTurnId: TurnId,
  currentTurnIndex: number,
  openEpisode: EpisodeRecord | null,
  settings: EpisodeMemorySettings,
  activeGoal?: string,
  selectedArtifacts?: string[],
): Promise<WorkingSetResult> {
  const workspaceRoot = thread.workspaceRoot;
  const userText = userInputToText(userInput);
  const taskFingerprint = computeTaskFingerprint(userText, activeGoal);
  const existing = await getThreadWorkingSetSnapshot(store, thread.threadId);

  if (
    existing &&
    existing.taskFingerprint === taskFingerprint &&
    existing.builtFromTurnIndex < currentTurnIndex
  ) {
    return {
      snapshot: existing,
      activeEpisodes: [],
      openEpisode,
      rebuilt: false,
      switchReason: 'no_switch',
    };
  }

  // Compute a preliminary identity based on the currently open episode (if any).
  // The canonical identity used for the snapshot is recomputed after the final
  // open episode for this turn is resolved, so first-turn creation also gets a
  // stable identity.
  const preliminaryEpisodeIdentity = computeEpisodeIdentity(openEpisode, activeGoal, selectedArtifacts);

  const switchReason = determineSwitchReason({
    existing,
    taskFingerprint,
    episodeIdentity: preliminaryEpisodeIdentity,
    workspaceRoot,
    userText,
    openEpisode,
    currentTurnIndex,
    settings,
  });

  const sealReasons: SwitchReason[] = [
    'explicit_user_switch',
    'implicit_topic_switch',
    'resume_previous_episode',
    'new_workspace_scope',
  ];
  const shouldSeal = sealReasons.includes(switchReason);

  let nextOpenEpisode = openEpisode;
  if (shouldSeal && openEpisode && openEpisode.lifecycle === 'open') {
    const sealed = sealEpisode(openEpisode, switchReason);
    await saveEpisodeRecord(store, sealed);
    nextOpenEpisode = createEpisodeRecord({
      workspaceRoot,
      sourceThreadId: thread.threadId,
      sourceTurnStart: currentTurnId,
      sourceTurnEnd: currentTurnId,
      sourceTurnStartIndex: currentTurnIndex,
      sourceTurnEndIndex: currentTurnIndex,
      objective: deriveObjective(userInput),
    });
    await saveEpisodeRecord(store, nextOpenEpisode);
  } else if (!nextOpenEpisode) {
    nextOpenEpisode = createEpisodeRecord({
      workspaceRoot,
      sourceThreadId: thread.threadId,
      sourceTurnStart: currentTurnId,
      sourceTurnEnd: currentTurnId,
      sourceTurnStartIndex: currentTurnIndex,
      sourceTurnEndIndex: currentTurnIndex,
      objective: deriveObjective(userInput),
    });
    await saveEpisodeRecord(store, nextOpenEpisode);
  }

  const episodeIdentity = computeEpisodeIdentity(nextOpenEpisode, activeGoal, selectedArtifacts);

  await demoteColdEpisodes(store, settings.episodeColdAfterDays);

  const recalled = await retrieveEpisodesForWorkingSet(
    store,
    {
      threadId: thread.threadId,
      currentTurnId,
      workspaceRoot,
      userInput: userText,
      taskFingerprint,
      activeGoal,
      selectedArtifacts,
      activeEpisodeIds: existing?.activeEpisodeIds ?? [],
      injectedEpisodeIds: existing?.injectedEpisodeIds ?? [],
    },
    {
      ftsCandidateLimit: settings.episodeFtsCandidateLimit,
      injectLimit: settings.episodeInjectLimit,
      tokenBudget: settings.episodeTokenBudget,
      rerankEnabled: settings.episodeRerankEnabled,
    },
  );

  const activeEpisodes = await loadEpisodeRecords(store, recalled);
  const now = new Date().toISOString();
  for (const episode of activeEpisodes) {
    if (episode.temperature === 'cold') {
      await promoteEpisodeToWarm(store, episode.id, new Date(now));
    }
    await recordEpisodeUsage(store, episode.id, now);
  }

  const frozenPromptBlock = buildEpisodePromptBlock(activeEpisodes);
  const nextGeneration = (existing?.generation ?? 0) + 1;
  const snapshot: ThreadWorkingSetSnapshot = {
    threadId: thread.threadId,
    generation: nextGeneration,
    activeEpisodeIds: activeEpisodes.map((e) => e.id),
    injectedEpisodeIds: activeEpisodes.map((e) => e.id),
    frozenPromptBlock,
    builtFromTurnId: currentTurnId,
    builtFromTurnIndex: currentTurnIndex,
    taskFingerprint,
    episodeIdentity,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveThreadWorkingSetSnapshot(store, snapshot);

  return {
    snapshot,
    activeEpisodes,
    openEpisode: nextOpenEpisode,
    rebuilt: true,
    switchReason,
  };
}

export function computeTaskFingerprint(userText: string, activeGoal?: string): string {
  const tokens = tokenize(`${userText} ${activeGoal ?? ''}`);
  const payload = tokens.sort().join(' ');
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export function computeEpisodeIdentity(
  openEpisode: EpisodeRecord | null | undefined,
  activeGoal?: string,
  selectedArtifacts?: string[],
): string {
  if (!openEpisode) return '';
  const artifacts = (selectedArtifacts ?? []).sort().join('|');
  return createHash('sha256')
    .update(`${openEpisode.objective}|${activeGoal ?? ''}|${artifacts}`)
    .digest('hex')
    .slice(0, 24);
}

function userInputToText(input: UserInput): string {
  if (input.type === 'text') return input.text;
  return input.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join(' ');
}

function deriveObjective(input: UserInput): string {
  const text = userInputToText(input).trim();
  if (!text) return 'Current task segment';
  const firstSentence = text.split(/[.。!！?？]/, 1)[0] ?? text;
  return firstSentence.slice(0, 120).trim();
}

function tokenize(text: string): string[] {
  const ascii = text.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [];
  const cjk = (text.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((seg) => {
    const tokens = [seg];
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    return tokens;
  });
  return [...new Set([...ascii, ...cjk])];
}

interface SwitchContext {
  existing: ThreadWorkingSetSnapshot | null;
  taskFingerprint: string;
  episodeIdentity: string;
  workspaceRoot: string;
  userText: string;
  openEpisode: EpisodeRecord | null;
  currentTurnIndex: number;
  settings: EpisodeMemorySettings;
}

function determineSwitchReason(ctx: SwitchContext): SwitchReason {
  const { existing, taskFingerprint, episodeIdentity, userText, openEpisode, currentTurnIndex, settings } = ctx;
  if (!existing) return 'new_workspace_scope';

  if (existing.taskFingerprint === taskFingerprint) return 'no_switch';

  const withinCooldown =
    currentTurnIndex - existing.builtFromTurnIndex < settings.episodeSwitchCooldownTurns;
  if (withinCooldown) return 'no_switch';

  if (isExplicitSwitch(userText)) return 'explicit_user_switch';

  if (episodeIdentity !== existing.episodeIdentity) {
    // A stable identity drift (objective / goal / artifacts) is treated as a task switch.
    return 'explicit_user_switch';
  }

  if (isImplicitTopicSwitch(openEpisode?.objective ?? '', userText)) {
    return 'implicit_topic_switch';
  }

  return 'cooldown_rebuild_only';
}

function isExplicitSwitch(userText: string): boolean {
  const phrases = [
    /\bswitch\s+(?:to|over)\b/i,
    /\bnew\s+task\b/i,
    /\bstart\s+a\s+new\s+(?:task|episode)\b/i,
    /\bmove\s+(?:on|to)\b/i,
    /\bresume\s+(?:the\s+)?(?:previous|old|other)\s+(?:task|episode)\b/i,
    /换个任务/,
    /继续另一个任务/,
    /开始新任务/,
    /切换到/,
  ];
  return phrases.some((pattern) => pattern.test(userText));
}

function isImplicitTopicSwitch(previousText: string, nextText: string): boolean {
  const previousTokens = meaningfulTokens(previousText);
  const nextTokens = meaningfulTokens(nextText);
  if (previousTokens.length < 2 || nextTokens.length < 2) return false;

  const previousSet = new Set(previousTokens);
  const shared = nextTokens.filter((token) => previousSet.has(token)).length;
  const overlapRatio = shared / Math.min(previousTokens.length, nextTokens.length);
  if (overlapRatio >= 0.25) return false;

  const previousIntent = classifyTaskIntent(previousTokens);
  const nextIntent = classifyTaskIntent(nextTokens);
  if (previousIntent !== 'unknown' && nextIntent !== 'unknown' && previousIntent !== nextIntent) {
    return true;
  }

  return previousTokens.length >= 3 && nextTokens.length >= 3 && overlapRatio === 0;
}

function meaningfulTokens(text: string): string[] {
  return tokenize(text)
    .map((token) => TOPIC_SYNONYMS[token] ?? token)
    .filter((token) => token.length >= 2 && !TOPIC_STOP_WORDS.has(token));
}

function classifyTaskIntent(tokens: string[]): string {
  const tokenSet = new Set(tokens);
  if (hasAny(tokenSet, ['fix', 'bug', '修复', '错误', '报错', '问题'])) return 'repair';
  if (hasAny(tokenSet, ['design', 'page', 'ui', 'layout', 'pricing', '页面', '设计', '布局'])) return 'design';
  if (hasAny(tokenSet, ['test', 'vitest', '测试', 'spec'])) return 'test';
  if (hasAny(tokenSet, ['refactor', '重构'])) return 'refactor';
  if (hasAny(tokenSet, ['docs', 'document', '文档'])) return 'docs';
  return 'unknown';
}

function hasAny(tokens: Set<string>, values: string[]): boolean {
  return values.some((value) => tokens.has(value));
}

const TOPIC_SYNONYMS: Record<string, string> = {
  auth: 'login',
  authentication: 'login',
  登录: 'login',
  认证: 'login',
  permission: '权限',
  permissions: '权限',
  pricing: 'pricing',
  价格: 'pricing',
  定价: 'pricing',
};

const TOPIC_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'can',
  'you',
  'please',
  'continue',
  'current',
  'task',
  'work',
  '继续',
  '当前',
  '任务',
  '一下',
  '一个',
  '这个',
]);

async function loadEpisodeRecords(
  store: ThreadStore,
  results: EpisodeSearchResult[],
): Promise<EpisodeRecord[]> {
  if (!store.getEpisodeRecord) return results.map((r) => r.episode);
  const loaded: EpisodeRecord[] = [];
  for (const result of results) {
    const fresh = await store.getEpisodeRecord(result.episode.id);
    loaded.push(fresh ?? result.episode);
  }
  return loaded;
}

export function emptyWorkingSetSnapshot(threadId: ThreadId): ThreadWorkingSetSnapshot {
  const now = new Date().toISOString();
  return {
    threadId,
    generation: 0,
    activeEpisodeIds: [],
    injectedEpisodeIds: [],
    frozenPromptBlock: '',
    builtFromTurnId: '',
    builtFromTurnIndex: -1,
    taskFingerprint: '',
    createdAt: now,
    updatedAt: now,
  };
}
