import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Locale } from '@suanlizi/i18n';
import type { ThreadItem, TurnId } from '@suanlizi/protocol';

const execFileAsync = promisify(execFile);

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

export interface SkillMarkdownInput {
  name: string;
  description: string;
  instructions: string;
}

export interface PreparedSkillDraftRequest {
  prompt: string;
  original: string;
  sourceUrl?: string;
  sourceContent?: string;
  sourceError?: string;
}

export interface InstalledSkill {
  name: string;
  path: string;
  sourcePath: string;
}

export interface InstallSkillsResult {
  installed: InstalledSkill[];
  skillsRoot: string;
}

export interface SkillInstallTurnInput {
  turnId: TurnId;
  input: string;
  installUrls?: string[];
  installed: InstalledSkill[];
  skillsRoot: string;
  agentText: string;
  timestamp?: string;
}

export function formatSkillMarkdown(input: SkillMarkdownInput): string {
  return [
    '---',
    `name: ${sanitizeSkillName(input.name)}`,
    `description: ${input.description.trim() || 'Suanlizi skill'}`,
    '---',
    '',
    '# Instructions',
    '',
    input.instructions.trim() || 'Describe the behavior this skill should guide.',
    '',
  ].join('\n');
}

export function buildSkillDraftSystemPrompt(locale: Locale = 'zh'): string {
  const languageRule = locale === 'zh'
    ? '使用中文编写 description 和 instructions；只有 name 保持短 kebab-case id。'
    : 'Write description and instructions in English; only name stays a short kebab-case id.';
  return [
    'Generate a Suanlizi SKILL.md draft from the user request.',
    'Return only JSON with keys: name, description, instructions.',
    'name must be a short kebab-case id. description must be one sentence.',
    'If fetched source content is provided, extract concrete reusable guidance from that content.',
    'Do not write a skill that merely tells the user to visit or use the URL.',
    languageRule,
  ].join(' ');
}

export async function prepareSkillDraftRequest(description: string): Promise<PreparedSkillDraftRequest> {
  const original = description.trim();
  const sourceUrls = extractUrls(original);
  if (sourceUrls.length === 0) {
    return { original, prompt: original };
  }

  let sourceUrl = sourceUrls[0];
  try {
    let sourceContent = '';
    let sourceError = '';
    for (const candidate of sourceUrls) {
      try {
        sourceContent = await fetchSkillSourceContent(candidate);
        sourceUrl = candidate;
        sourceError = '';
        break;
      } catch (error) {
        sourceError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!sourceContent) {
      throw new Error(sourceError || 'No source candidates available');
    }
    return {
      original,
      sourceUrl,
      sourceContent,
      prompt: [
        'User request:',
        original,
        '',
        `Fetched source content from ${sourceUrl}:`,
        sourceContent,
        '',
        'Draft the skill from the fetched source content above.',
        'Do not write a skill that merely tells the user to visit or use the URL; distill the source into actionable instructions.',
      ].join('\n'),
    };
  } catch (error) {
    const sourceError = error instanceof Error ? error.message : String(error);
    return {
      original,
      sourceUrl,
      sourceError,
      prompt: [
        'User request:',
        original,
        '',
        `The URL could not be fetched: ${sourceError}`,
        'Draft only from the user request and do not pretend source content was read.',
      ].join('\n'),
    };
  }
}

export function createTemplateSkillDraft(
  prepared: PreparedSkillDraftRequest,
  locale: Locale = 'zh',
): SkillDraft {
  const name = inferSkillName(prepared);
  const description = inferSkillDescription(prepared, locale);
  const instructions = inferSkillInstructions(prepared, locale);
  return {
    name,
    description,
    body: formatSkillMarkdown({
      name,
      description,
      instructions,
    }),
  };
}

export function safeGeneratedSkillDraft(
  json: Record<string, unknown> | null,
  prepared: PreparedSkillDraftRequest,
  fallback: SkillDraft,
): SkillDraft {
  const modelName = typeof json?.name === 'string' ? sanitizeSkillName(json.name) : fallback.name;
  const modelDescription = typeof json?.description === 'string' ? json.description.trim() : '';
  const modelInstructions = typeof json?.instructions === 'string' ? json.instructions.trim() : '';
  const name = isUrlOnlyText(modelName, prepared) ? fallback.name : modelName;
  const description = isUrlOnlyText(modelDescription, prepared) ? fallback.description : modelDescription || fallback.description;
  const instructions = isUrlOnlyText(modelInstructions, prepared) ? fallback.body : modelInstructions || fallback.body;
  return {
    name,
    description,
    body: formatSkillMarkdown({
      name,
      description,
      instructions,
    }),
  };
}

export async function writeSkillDraft(
  skillsRoot: string,
  draft: SkillDraft,
): Promise<{ name: string; path: string }> {
  const root = path.resolve(skillsRoot);
  const name = sanitizeSkillName(draft.name);
  const dir = path.resolve(root, name);
  const skillPath = path.resolve(dir, 'SKILL.md');
  if (!dir.startsWith(root + path.sep) && dir !== root) {
    throw new Error('Skill path escapes skills root');
  }
  await fs.mkdir(dir, { recursive: true });
  const body = normalizeSkillBody(name, draft.description, draft.body);
  await fs.writeFile(skillPath, body, 'utf-8');
  return { name, path: skillPath };
}

export async function deleteSkill(
  skillsRoot: string,
  value: string,
): Promise<{ name: string; path: string }> {
  const root = path.resolve(skillsRoot);
  const raw = value.trim();
  if (!raw) {
    throw new Error('Skill name is required');
  }
  const name = sanitizeSkillName(raw);
  if (name !== raw) {
    throw new Error('Skill path escapes skills root');
  }
  const dir = path.resolve(root, name);
  if (!dir.startsWith(root + path.sep) && dir !== root) {
    throw new Error('Skill path escapes skills root');
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { name, path: dir };
}

export function createSkillInstallTurnItems(input: SkillInstallTurnInput): ThreadItem[] {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const skillUrl = input.input.replace(/^\/skills\s+add\s+/i, '').trim();
  const installUrls = input.installUrls?.map((url) => url.trim()).filter(Boolean) ?? [];
  const names = input.installed.map((skill) => skill.name);
  const sourcePaths = input.installed.map((skill) => skill.sourcePath);
  const paths = input.installed.map((skill) => skill.path);
  return [
    {
      id: `${input.turnId}_item_0`,
      type: 'user_message',
      turnId: input.turnId,
      text: input.input,
      timestamp,
    },
    {
      id: `${input.turnId}_item_1`,
      type: 'tool_call',
      turnId: input.turnId,
      toolName: 'skills_add',
      arguments: {
        input: skillUrl,
        ...(installUrls.length > 0 ? { urls: installUrls } : {}),
      },
      result: {
        count: input.installed.length,
        names,
        skillsRoot: input.skillsRoot,
        sourcePaths,
        paths,
      },
      status: 'completed',
      timestamp,
    },
    {
      id: `${input.turnId}_item_2`,
      type: 'agent_message',
      turnId: input.turnId,
      text: input.agentText,
      timestamp,
    },
  ];
}

export async function installSkillsFromGitHubUrl(
  skillsRoot: string,
  url: string,
): Promise<InstallSkillsResult> {
  const source = parseGitHubSkillUrl(url);
  let zipError: unknown;
  try {
    return await installSkillsFromGitHubZip(skillsRoot, source);
  } catch (error) {
    zipError = error;
    // Fallback for private repos, download failures, or environments without zip extraction.
    // 私有仓库、下载失败或无 zip 提取环境时的回退处理。
  }

  let tree: GitHubTreeEntry[];
  try {
    tree = await fetchGitHubTree(source);
  } catch (error) {
    const zipMessage = zipError instanceof Error ? zipError.message : String(zipError);
    const fallbackMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub zip install failed: ${zipMessage}; API fallback failed: ${fallbackMessage}`);
  }
  const skillDirs = resolveSkillDirs(source.path, tree);
  if (skillDirs.length === 0) {
    throw new Error('No SKILL.md files found in the GitHub path');
  }

  const root = path.resolve(skillsRoot);
  await fs.mkdir(root, { recursive: true });

  const installed: InstalledSkill[] = [];
  const planned = skillDirs.map((sourcePath) => {
    const name = sanitizeSkillName(path.posix.basename(sourcePath));
    const destDir = path.resolve(root, name);
    if (!destDir.startsWith(root + path.sep) && destDir !== root) {
      throw new Error('Skill install path escapes skills root');
    }
    return { sourcePath, name, destDir };
  });

  for (const plan of planned) {
    try {
      await fs.access(plan.destDir);
      throw new Error(`Destination already exists: ${plan.destDir}`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      if (error instanceof Error && error.message.startsWith('Destination already exists')) throw error;
      throw error;
    }
  }

  for (const plan of planned) {
    const files = tree.filter((entry) => (
      entry.type === 'blob'
      && (entry.path === plan.sourcePath || entry.path.startsWith(`${plan.sourcePath}/`))
    ));
    if (!files.some((entry) => entry.path === `${plan.sourcePath}/SKILL.md`)) {
      throw new Error(`SKILL.md not found in selected skill directory: ${plan.sourcePath}`);
    }
    for (const file of files) {
      const relativePath = file.path.slice(plan.sourcePath.length + 1);
      const destPath = path.resolve(plan.destDir, ...relativePath.split('/'));
      if (!destPath.startsWith(plan.destDir + path.sep) && destPath !== plan.destDir) {
        throw new Error('GitHub file path escapes skill directory');
      }
      const bytes = await fetchGitHubFile(source, file);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, bytes);
    }
    installed.push({ name: plan.name, path: plan.destDir, sourcePath: plan.sourcePath });
  }

  return { installed, skillsRoot: root };
}

export async function installSkillsFromGitHubUrls(
  skillsRoot: string,
  urls: string[],
): Promise<InstallSkillsResult> {
  const uniqueUrls = urls.map((url) => url.trim()).filter(Boolean)
    .filter((url, index, current) => current.indexOf(url) === index);
  if (uniqueUrls.length === 0) {
    throw new Error('Skill URL is required');
  }
  const installed: InstalledSkill[] = [];
  let resolvedRoot = path.resolve(skillsRoot);
  for (const url of uniqueUrls) {
    try {
      const result = await installSkillsFromGitHubUrl(skillsRoot, url);
      resolvedRoot = result.skillsRoot;
      installed.push(...result.installed);
    } catch (error) {
      if (uniqueUrls.length > 1 && isDestinationAlreadyExistsError(error)) {
        continue;
      }
      throw error;
    }
  }
  return { installed, skillsRoot: resolvedRoot };
}

function isDestinationAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Destination already exists:');
}

async function installSkillsFromGitHubZip(
  skillsRoot: string,
  source: GitHubSkillSource,
): Promise<InstallSkillsResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-skill-install-'));
  try {
    const zipPath = path.join(tmpDir, 'repo.zip');
    const extractDir = path.join(tmpDir, 'repo');
    await fs.mkdir(extractDir, { recursive: true });

    const response = await fetchWithRetry(
      `https://codeload.github.com/${source.owner}/${source.repo}/zip/${encodeURIComponent(source.ref)}`,
      { headers: { 'user-agent': 'Suanlizi/0.1' } },
    );
    if (!response.ok) {
      throw new Error(`GitHub zip download failed: HTTP ${response.status}`);
    }
    await fs.writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
    await extractZip(zipPath, extractDir);
    const repoRoot = await findSingleExtractedRoot(extractDir);
    const localEntries = await listLocalRepoEntries(repoRoot);
    const skillDirs = resolveSkillDirs(source.path, localEntries);
    if (skillDirs.length === 0) {
      throw new Error('No SKILL.md files found in the GitHub path');
    }
    return await copyLocalSkillDirs(skillsRoot, repoRoot, skillDirs);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function copyLocalSkillDirs(
  skillsRoot: string,
  repoRoot: string,
  skillDirs: string[],
): Promise<InstallSkillsResult> {
  const root = path.resolve(skillsRoot);
  await fs.mkdir(root, { recursive: true });
  const planned = skillDirs.map((sourcePath) => {
    const name = sanitizeSkillName(path.posix.basename(sourcePath));
    const destDir = path.resolve(root, name);
    if (!destDir.startsWith(root + path.sep) && destDir !== root) {
      throw new Error('Skill install path escapes skills root');
    }
    return { sourcePath, name, destDir };
  });

  for (const plan of planned) {
    try {
      await fs.access(plan.destDir);
      throw new Error(`Destination already exists: ${plan.destDir}`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  const installed: InstalledSkill[] = [];
  for (const plan of planned) {
    const srcDir = path.resolve(repoRoot, ...plan.sourcePath.split('/'));
    const skillMd = path.join(srcDir, 'SKILL.md');
    await fs.access(skillMd);
    await fs.cp(srcDir, plan.destDir, { recursive: true, errorOnExist: true, force: false });
    installed.push({ name: plan.name, path: plan.destDir, sourcePath: plan.sourcePath });
  }

  return { installed, skillsRoot: root };
}

export function sanitizeSkillName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'new-skill';
}

interface GitHubSkillSource {
  owner: string;
  repo: string;
  ref: string;
  path: string | null;
}

interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | string;
  sha?: string;
}

function parseGitHubSkillUrl(url: string): GitHubSkillSource {
  const parsed = new URL(url);
  if (parsed.hostname !== 'github.com') {
    throw new Error('Only GitHub URLs are supported for skill install');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Invalid GitHub URL');
  const [owner, repo, marker, ref, ...rest] = parts;
  if ((marker === 'tree' || marker === 'blob') && ref) {
    const rawPath = rest.join('/');
    return {
      owner,
      repo,
      ref,
      path: marker === 'blob' && rawPath.endsWith('/SKILL.md')
        ? rawPath.replace(/\/SKILL\.md$/, '')
        : rawPath || null,
    };
  }
  return {
    owner,
    repo,
    ref: 'main',
    path: parts.length > 2 ? parts.slice(2).join('/') : null,
  };
}

async function fetchGitHubTree(source: GitHubSkillSource): Promise<GitHubTreeEntry[]> {
  const apiUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`;
  const response = await fetchWithRetry(apiUrl, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'Suanlizi/0.1',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub tree fetch failed: HTTP ${response.status}`);
  }
  const data = await response.json() as { tree?: GitHubTreeEntry[] };
  return Array.isArray(data.tree) ? data.tree : [];
}

function resolveSkillDirs(requestedPath: string | null, tree: GitHubTreeEntry[]): string[] {
  const skillMdPaths = tree
    .filter((entry) => entry.type === 'blob' && entry.path.endsWith('/SKILL.md'))
    .map((entry) => entry.path.replace(/\/SKILL\.md$/, ''));
  if (requestedPath) {
    const normalized = requestedPath.replace(/^\/+|\/+$/g, '');
    if (skillMdPaths.includes(normalized)) return [normalized];
    return skillMdPaths.filter((skillPath) => skillPath.startsWith(`${normalized}/`));
  }
  const underSkills = skillMdPaths.filter((skillPath) => skillPath.startsWith('skills/'));
  const selected = underSkills.length > 0 ? underSkills : skillMdPaths.filter((skillPath) => !skillPath.split('/').some((part) => part.startsWith('.')));
  return [...new Set(selected)].sort();
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (process.platform === 'win32') {
    const scriptPath = path.join(path.dirname(zipPath), 'expand-archive.ps1');
    await fs.writeFile(
      scriptPath,
      [
        'param([string]$ZipPath, [string]$DestinationPath)',
        'Expand-Archive -LiteralPath $ZipPath -DestinationPath $DestinationPath -Force',
        '',
      ].join('\n'),
      'utf-8',
    );
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      zipPath,
      destDir,
    ]);
    return;
  }
  await execFileAsync('unzip', ['-q', zipPath, '-d', destDir]);
}

async function findSingleExtractedRoot(extractDir: string): Promise<string> {
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length !== 1) {
    throw new Error('Unexpected GitHub zip layout');
  }
  return path.join(extractDir, dirs[0]!.name);
}

async function listLocalRepoEntries(repoRoot: string): Promise<GitHubTreeEntry[]> {
  const entries: GitHubTreeEntry[] = [];
  await walkLocalRepo(repoRoot, '', entries);
  return entries;
}

async function walkLocalRepo(root: string, relativeDir: string, entries: GitHubTreeEntry[]): Promise<void> {
  const dir = path.join(root, ...relativeDir.split('/').filter(Boolean));
  const dirEntries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of dirEntries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      entries.push({ path: relativePath, type: 'tree' });
      await walkLocalRepo(root, relativePath, entries);
    } else if (entry.isFile()) {
      entries.push({ path: relativePath, type: 'blob' });
    }
  }
}

async function fetchGitHubFile(source: GitHubSkillSource, file: GitHubTreeEntry): Promise<Buffer> {
  if (file.sha) {
    const blobUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/git/blobs/${file.sha}`;
    const response = await fetchWithRetry(blobUrl, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Suanlizi/0.1',
      },
    });
    if (response.ok) {
      const data = await response.json() as { content?: string; encoding?: string };
      if (data.encoding === 'base64' && typeof data.content === 'string') {
        return Buffer.from(data.content.replace(/\s+/g, ''), 'base64');
      }
    }
  }

  return fetchGitHubRawFile(source, file.path);
}

async function fetchGitHubRawFile(source: GitHubSkillSource, filePath: string): Promise<Buffer> {
  const rawUrl = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(source.ref)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetchWithRetry(rawUrl, {
    headers: { 'user-agent': 'Suanlizi/0.1' },
  });
  if (!response.ok) {
    throw new Error(`GitHub file fetch failed for ${filePath}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || response.status < 500 || attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function normalizeSkillBody(name: string, description: string, body: string): string {
  const trimmed = body.trim();
  if (/^---\n[\s\S]*?\n---\n/.test(trimmed)) {
    return `${trimmed}\n`;
  }
  return formatSkillMarkdown({
    name,
    description,
    instructions: trimmed,
  });
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return [...new Set(matches.map(stripUrlPunctuation).filter(Boolean))];
}

function stripUrlPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/g, '').trim();
}

function inferSkillName(prepared: PreparedSkillDraftRequest): string {
  if (prepared.sourceUrl) {
    try {
      const parsed = new URL(prepared.sourceUrl);
      if (parsed.hostname === 'github.com') {
        const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
        if (owner && repo) return sanitizeSkillName(`${owner}-${repo}`);
      }
      const tail = parsed.pathname.split('/').filter(Boolean).at(-1);
      if (tail) return sanitizeSkillName(tail);
      return sanitizeSkillName(parsed.hostname.replace(/^www\./, ''));
    } catch {
      // fall through to source heading/original text
    }
  }
  const heading = prepared.sourceContent?.match(/^#\s+(.+)$/m)?.[1];
  return sanitizeSkillName(heading ?? prepared.original.split(/\s+/).slice(0, 5).join('-') ?? 'new-skill');
}

function inferSkillDescription(prepared: PreparedSkillDraftRequest, locale: Locale): string {
  const content = prepared.sourceContent;
  if (content) {
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (prepared.sourceUrl?.includes('github.com/anthropics/skills')) {
      return locale === 'zh'
        ? '基于 Anthropic Skills 仓库内容创建和改进可复用 Skill。'
        : 'Create and improve reusable Skills from the Anthropic Skills repository.';
    }
    if (heading) {
      return locale === 'zh'
        ? `基于 ${heading} 内容创建和改进可复用 Skill。`
        : `Create and improve reusable Skills from ${heading}.`;
    }
    const firstLine = sourceContentLines(content)[0];
    if (firstLine) return truncateSentence(firstLine, 120);
  }
  if (prepared.sourceError && prepared.sourceUrl) {
    return locale === 'zh'
      ? `根据用户提供的 ${prepared.sourceUrl} 生成 Skill 草稿。`
      : `Draft a Skill from the user-provided ${prepared.sourceUrl}.`;
  }
  return prepared.original;
}

function inferSkillInstructions(prepared: PreparedSkillDraftRequest, locale: Locale): string {
  const content = prepared.sourceContent;
  if (!content) {
    return prepared.original;
  }
  const lines = sourceContentLines(content).slice(0, 14);
  const intro = locale === 'zh'
    ? [
        '基于已抓取的来源内容整理 Skill。不要把来源 URL 当作指令本身；应提炼其中的能力定义、适用场景、操作流程和约束。',
        '',
        '## Source Notes',
      ]
    : [
        'Draft the Skill from the fetched source content. Do not treat the source URL as the instruction itself; distill capabilities, triggers, workflow, and constraints.',
        '',
        '## Source Notes',
      ];
  return [...intro, ...lines].join('\n');
}

function sourceContentLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[') && !/^!\[/.test(line));
}

function truncateSentence(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function isUrlOnlyText(value: string, prepared: PreparedSkillDraftRequest): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (prepared.sourceUrl && trimmed === prepared.sourceUrl) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (prepared.sourceUrl) {
    const urlSlug = sanitizeSkillName(prepared.sourceUrl);
    if (sanitizeSkillName(trimmed) === urlSlug) return true;
  }
  return false;
}

async function fetchSkillSourceContent(url: string): Promise<string> {
  const failures: string[] = [];
  for (const candidate of candidateSourceUrls(url)) {
    try {
      const response = await fetch(candidate, {
        headers: {
          accept: 'text/plain,text/markdown,text/html,application/json',
          'user-agent': 'Suanlizi/0.1',
        },
      });
      if (!response.ok) {
        failures.push(`${candidate}: HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      const cleaned = cleanSourceText(text);
      if (cleaned) return cleaned.slice(0, 16_000);
      failures.push(`${candidate}: empty content`);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(failures.join('; ') || 'No source candidates available');
}

function candidateSourceUrls(url: string): string[] {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'github.com') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const [owner, repo, marker, branch, ...rest] = parts;
      if (owner && repo && marker === 'blob' && branch && rest.length > 0) {
        return [`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join('/')}`, url];
      }
      if (owner && repo && marker === 'tree' && branch && rest.length > 0) {
        const sourceDir = rest.join('/');
        return [
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${sourceDir}/SKILL.md`,
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${sourceDir}/README.md`,
          url,
        ];
      }
      if (owner && repo) {
        return [
          `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
          `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`,
          `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`,
          url,
        ];
      }
    }
  } catch {
    return [url];
  }
  return [url];
}

function cleanSourceText(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
