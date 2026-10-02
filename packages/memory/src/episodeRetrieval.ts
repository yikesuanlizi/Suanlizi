import type { EpisodeRecord, EpisodeSearchOptions, EpisodeSearchResult, ThreadId, TurnId } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';

export interface RetrievalContext {
  threadId: ThreadId;
  currentTurnId: TurnId;
  workspaceRoot: string;
  userInput: string;
  activeGoal?: string;
  selectedArtifacts?: string[];
  taskFingerprint: string;
  injectedEpisodeIds?: string[];
  activeEpisodeIds?: string[];
}

export async function retrieveEpisodesForWorkingSet(
  store: ThreadStore,
  ctx: RetrievalContext,
  options: {
    ftsCandidateLimit: number;
    injectLimit: number;
    tokenBudget: number;
    rerankEnabled: boolean;
  },
): Promise<EpisodeSearchResult[]> {
  const query = buildQuery(ctx);
  const candidates = await fetchCandidates(store, ctx, query, options.ftsCandidateLimit);
  const scored = scoreEpisodes(candidates, ctx, query);
  const deduped = dedupeByTopicKey(scored);
  const ranked = deduped
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (b.episode.updatedAt.localeCompare(a.episode.updatedAt)));

  let selected = ranked;
  if (options.rerankEnabled && selected.length > 1 && marginBetween(selected[0], selected[1]) < 5) {
    selected = await rerankTop(selected, ctx);
  }

  const limited: EpisodeSearchResult[] = [];
  let usedChars = 0;
  const maxChars = Math.max(80, Math.floor(options.tokenBudget * 4));
  for (const result of selected) {
    if (limited.length >= options.injectLimit) break;
    const size = estimateEpisodeChars(result.episode);
    if (usedChars + size > maxChars && limited.length > 0) break;
    usedChars += size;
    limited.push(result);
  }
  return limited;
}

function buildQuery(ctx: RetrievalContext): string {
  const parts = [ctx.userInput, ctx.activeGoal ?? '', ...(ctx.selectedArtifacts ?? [])];
  return parts.filter(Boolean).join(' ').trim();
}

export function buildEpisodeSearchTerms(text: string): string[] {
  const terms = new Set<string>();
  // Extract path-like or colon-pair strings and add both path segments and the basename.
  const pathPattern = /([a-zA-Z]:[\\/][^\s]+)|(\/[^\s]+)|([a-zA-Z0-9_]+:[a-zA-Z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(text)) !== null) {
    const rawPath = match[0];
    const isColonPair = /^[a-zA-Z0-9_]+:[a-zA-Z0-9_]+$/.test(rawPath);
    for (const segment of rawPath
      .split(/[\\/.:]/)
      .filter((s) => s.length >= (isColonPair ? 1 : 2))) {
      terms.add(segment.toLowerCase());
    }
    if (!isColonPair) {
      const basename = rawPath.split(/[\\/]/).pop() ?? '';
      if (basename.length >= 2) terms.add(basename.toLowerCase());
    }
  }

  const withoutPaths = text.replace(pathPattern, ' ');
  const ascii = withoutPaths.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
  for (const token of ascii) terms.add(token);
  const cjk = (withoutPaths.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((seg) => {
    const out = [seg];
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    return out;
  });
  for (const token of cjk) terms.add(token);

  return [...terms];
}

function buildFtsQuery(query: string): string {
  const terms = buildEpisodeSearchTerms(query);
  if (terms.length === 0) return '';
  return terms.map((term) => `"${term}"`).join(' OR ');
}

async function fetchCandidates(
  store: ThreadStore,
  ctx: RetrievalContext,
  query: string,
  limit: number,
): Promise<EpisodeRecord[]> {
  if (!store.listEpisodeRecords) return [];
  const options: EpisodeSearchOptions = {
    workspaceRoot: ctx.workspaceRoot,
    lifecycle: ['sealed'],
    temperature: ['warm', 'cold'],
    limit,
    excludeEpisodeIds: [
      ...(ctx.injectedEpisodeIds ?? []),
      ...(ctx.activeEpisodeIds ?? []),
    ],
  };
  const safeQuery = buildFtsQuery(query);
  if (store.searchEpisodeRecords && safeQuery) {
    try {
      return await store.searchEpisodeRecords(safeQuery, options);
    } catch {
      // FTS syntax errors should not break retrieval; fall back to listing.
      return store.listEpisodeRecords(options);
    }
  }
  return store.listEpisodeRecords(options);
}

function scoreEpisodes(episodes: EpisodeRecord[], ctx: RetrievalContext, query: string): EpisodeSearchResult[] {
  const queryTokens = tokenize(query);
  const goalTokens = tokenize(ctx.activeGoal ?? '');
  const artifactTokens = tokenize((ctx.selectedArtifacts ?? []).join(' '));
  const currentWorkspace = ctx.workspaceRoot;

  return episodes.map((episode) => {
    const reasons: string[] = [];
    let score = 0;

    // Explicit reference: query directly mentions title / objective / artifact
    const lowerQuery = query.toLowerCase();
    const explicitTarget = [episode.title, episode.objective, ...episode.artifacts, ...episode.keywords]
      .some((s) => s && lowerQuery.includes(s.toLowerCase()));
    if (explicitTarget) {
      score += 10;
      reasons.push('explicit');
    }

    // Workspace match
    if (episode.workspaceRoot && episode.workspaceRoot === currentWorkspace) {
      score += 5;
      reasons.push('workspace');
    }

    // Objective overlap
    const objectiveTokens = tokenize(episode.objective);
    const objectiveOverlap = overlap(queryTokens, objectiveTokens) + overlap(goalTokens, objectiveTokens);
    if (objectiveOverlap > 0) {
      score += 3 * objectiveOverlap;
      reasons.push('objective');
    }

    // Artifact overlap
    const episodeArtifactTokens = tokenize(episode.artifacts.join(' '));
    const artifactOverlap = overlap(artifactTokens, episodeArtifactTokens);
    if (artifactOverlap > 0) {
      score += 4 * artifactOverlap;
      reasons.push('artifact');
    }

    // Entity overlap
    const entityOverlap = overlap(queryTokens, tokenize(episode.entities.join(' ')));
    if (entityOverlap > 0) {
      score += 2 * entityOverlap;
      reasons.push('entity');
    }

    // Open task overlap
    const openTaskOverlap = overlap(queryTokens, tokenize(episode.openTasks.join(' ')));
    if (openTaskOverlap > 0) {
      score += 3 * openTaskOverlap;
      reasons.push('openTask');
    }

    // Keyword overlap
    const keywordOverlap = overlap(queryTokens, episode.keywords);
    if (keywordOverlap > 0) {
      score += 2 * keywordOverlap;
      reasons.push('keyword');
    }

    // Summary/fact/decision overlap
    const summaryOverlap = overlap(queryTokens, tokenize(episode.summary));
    const factOverlap = overlap(queryTokens, tokenize(episode.facts.join(' ')));
    const decisionOverlap = overlap(queryTokens, tokenize(episode.decisions.join(' ')));
    if (summaryOverlap > 0) {
      score += 2 * summaryOverlap;
      reasons.push('summary');
    }
    if (factOverlap > 0) {
      score += 1.5 * factOverlap;
      reasons.push('facts');
    }
    if (decisionOverlap > 0) {
      score += 1.5 * decisionOverlap;
      reasons.push('decisions');
    }

    // Recent success boost
    if (episode.usageCount > 0 && episode.lastActivatedAt) {
      const days = Math.max(0, (Date.now() - Date.parse(episode.lastActivatedAt)) / 86_400_000);
      const recentBoost = Math.max(0, 2 - days / 7);
      score += recentBoost;
      reasons.push('recent');
    }

    // Already injected penalty
    if (ctx.injectedEpisodeIds?.includes(episode.id)) {
      score -= 20;
      reasons.push('already-injected');
    }

    // Same-thread open penalty (open episodes are excluded by query, but guard anyway)
    if (episode.sourceThreadId === ctx.threadId && episode.lifecycle === 'open') {
      score -= 100;
      reasons.push('same-thread-open');
    }

    // Cold temperature slight penalty
    if (episode.temperature === 'cold') {
      score -= 1;
      reasons.push('cold');
    }

    return {
      score: Math.round(score * 100) / 100,
      reason: reasons.join(', ') || 'baseline',
      episode,
    };
  });
}

function dedupeByTopicKey(results: EpisodeSearchResult[]): EpisodeSearchResult[] {
  const seen = new Map<string, EpisodeSearchResult>();
  for (const result of results) {
    const key = result.episode.topicKey;
    const existing = seen.get(key);
    if (!existing || result.episode.updatedAt > existing.episode.updatedAt) {
      seen.set(key, result);
    }
  }
  return [...seen.values()];
}

async function rerankTop(results: EpisodeSearchResult[], _ctx: RetrievalContext): Promise<EpisodeSearchResult[]> {
  // v1 rerank placeholder: keep order but ensure top1 is unique; future can call a small model here.
  if (results.length <= 1) return results;
  const [first, second, ...rest] = results;
  if (first.score - second.score < 1) {
    // tie-break by recency
    const winner = first.episode.updatedAt >= second.episode.updatedAt ? first : second;
    return [winner, ...rest];
  }
  return results;
}

function marginBetween(a: EpisodeSearchResult, b: EpisodeSearchResult): number {
  return Math.abs(a.score - b.score);
}

function overlap(left: string[], right: string[]): number {
  const set = new Set(right);
  return left.filter((token) => set.has(token)).length;
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

function estimateEpisodeChars(episode: EpisodeRecord): number {
  return (
    episode.title.length +
    episode.objective.length +
    episode.summary.length +
    episode.facts.join('').length +
    episode.decisions.join('').length +
    episode.artifacts.join('').length +
    episode.openTasks.join('').length +
    episode.entities.join('').length +
    episode.keywords.join('').length +
    120
  );
}
