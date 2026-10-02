export interface McpDraft {
  id: string;
  name: string;
  command: string;
  args: string;
  enabled: boolean;
  sourceKind?: 'command' | 'url';
  sourceUrl?: string;
  sourceHint?: string;
}

export interface PreparedMcpDraftRequest {
  original: string;
  draft: McpDraft;
  sourceUrl?: string;
  sourceContent?: string;
  sourceError?: string;
}

export async function prepareMcpDraftRequest(description: string): Promise<PreparedMcpDraftRequest> {
  const original = description.trim();
  const sourceUrl = extractUrls(original)[0];
  if (!sourceUrl) {
    return { original, draft: mcpDraftFromCommandText(original) };
  }

  try {
    const sourceContent = await fetchMcpSourceContent(sourceUrl);
    const commandLine = extractLaunchCommand(sourceContent);
    return {
      original,
      sourceUrl,
      sourceContent,
      draft: draftFromSource(sourceUrl, original, commandLine),
    };
  } catch (error) {
    return {
      original,
      sourceUrl,
      sourceError: error instanceof Error ? error.message : String(error),
      draft: draftFromSource(sourceUrl, original),
    };
  }
}

function mcpDraftFromCommandText(text: string): McpDraft {
  const [command = '', ...rest] = text.trim().split(/\s+/);
  const args = rest.join(' ');
  return {
    id: '',
    name: inferMcpName(command, args),
    command,
    args,
    enabled: Boolean(command),
    sourceKind: 'command',
  };
}

function draftFromSource(sourceUrl: string, original: string, commandLine?: string): McpDraft {
  const parsed = commandLine ? splitCommandLine(commandLine) : [];
  const [command = '', ...rest] = parsed;
  const args = rest.join(' ');
  return {
    id: '',
    name: inferMcpName(command, args, sourceUrl),
    command,
    args,
    enabled: Boolean(command),
    sourceKind: 'url',
    sourceUrl,
    sourceHint: original,
  };
}

function extractLaunchCommand(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const candidates = lines
    .map(cleanCommandLine)
    .filter(Boolean)
    .filter((line) => startsWithExecutableCommand(line) && hasMcpSignal(line));
  return candidates[0];
}

function cleanCommandLine(line: string): string {
  return line
    .trim()
    .replace(/^```(?:bash|sh|shell|powershell|pwsh|console|text)?\s*/i, '')
    .replace(/^\s*(?:\$|>|PS>|CMD>)\s*/i, '')
    .trim();
}

function startsWithExecutableCommand(text: string): boolean {
  const [first = ''] = text.trim().split(/\s+/);
  return executableCommands.has(first.toLowerCase());
}

function hasMcpSignal(text: string): boolean {
  return /(?:\bmcp\b|modelcontextprotocol|server-)/i.test(text);
}

const executableCommands = new Set([
  'bun',
  'deno',
  'docker',
  'node',
  'npm',
  'npx',
  'pnpm',
  'python',
  'python3',
  'uv',
  'uvx',
  'yarn',
]);

function splitCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of input.trim()) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) result.push(current);
  return result;
}

function inferMcpName(command: string, args: string, url?: string): string {
  const packageName = args.split(/\s+/).find((part) => /(?:mcp|modelcontextprotocol|server-)/i.test(part) && !part.startsWith('-'));
  const raw = packageName ?? command;
  if (raw) return normalizeMcpName(raw);
  if (url) {
    try {
      const parsed = new URL(url);
      const tail = parsed.pathname.split('/').filter(Boolean).at(-1) ?? parsed.hostname;
      return normalizeMcpName(tail);
    } catch {
      return normalizeMcpName(url);
    }
  }
  return 'mcp-server';
}

function normalizeMcpName(value: string): string {
  return value
    .replace(/^https?:\/\//i, '')
    .replace(/^@[^/]+\//, '')
    .replace(/^@/, '')
    .replace(/@[^@\s]+$/, '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/^server-/, '')
    .replace(/^mcp-/, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    || 'mcp-server';
}

async function fetchMcpSourceContent(url: string): Promise<string> {
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
      const cleaned = cleanSourceText(await response.text());
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
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${sourceDir}/README.md`,
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${sourceDir}/package.json`,
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

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return [...new Set(matches.map(stripUrlPunctuation).filter(Boolean))];
}

function stripUrlPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/g, '').trim();
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
