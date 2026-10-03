import type { Locale, WebSearchMode } from '../../config/config.js';

export type SlashCommand =
  | { kind: 'none' }
  | { kind: 'skills.list' }
  | { kind: 'skills.add'; args: string }
  | { kind: 'mcp.list' }
  | { kind: 'mcp.add'; args: string }
  | { kind: 'web_search.mode'; mode: WebSearchMode }
  | { kind: 'compact' }
  | { kind: 'ops'; preset: 'ops'; args: string }
  | { kind: 'goal'; args: string }
  | { kind: 'workflow'; args: string }
  | { kind: 'task.mode'; mode: 'plan' | 'review' | 'debug' | 'frontend'; args: string };

export interface SlashCommandOption {
  id: string;
  command: string;
  title: string;
  detail: string;
}

export const slashCommandOptions: SlashCommandOption[] = [
  {
    id: 'skills',
    command: '/skills',
    title: 'Skills',
    detail: '列出并选择 Skill',
  },
  {
    id: 'skills-add',
    command: '/skills add ',
    title: 'Skills add',
    detail: '用自然语言生成并安装 Skill',
  },
  {
    id: 'mcp',
    command: '/mcp',
    title: 'MCP',
    detail: '列出并启用 MCP',
  },
  {
    id: 'mcp-add',
    command: '/mcp add ',
    title: 'MCP add',
    detail: '添加 MCP server 配置',
  },
  {
    id: 'web-search',
    command: '/web_search auto',
    title: 'Web search',
    detail: '切换联网搜索模式：auto/on/off',
  },
  {
    id: 'plan',
    command: '/plan ',
    title: 'Plan',
    detail: '只规划，不改文件',
  },
  {
    id: 'goal',
    command: '/goal ',
    title: 'Goal',
    detail: '创建带验收与证据追踪的目标任务',
  },
  {
    id: 'workflow',
    command: '/workflow ',
    title: 'Dynamic Workflow',
    detail: '创建待审阅的受限脚本工作流',
  },
  {
    id: 'review',
    command: '/review ',
    title: 'Review',
    detail: '代码审查，优先列问题和风险',
  },
  {
    id: 'debug',
    command: '/debug ',
    title: 'Debug',
    detail: '系统化定位并修复问题',
  },
  {
    id: 'frontend',
    command: '/frontend ',
    title: 'Frontend',
    detail: '前端设计与界面打磨',
  },
  {
    id: 'compact',
    command: '/compact',
    title: 'Compact',
    detail: '压缩当前对话上下文',
  },
  {
    id: 'ops',
    command: '/ops ',
    title: 'Ops',
    detail: '启动只读运维调查并持续记录证据',
  },
];

const localizedSlashDetails: Record<Locale, Record<string, Pick<SlashCommandOption, 'title' | 'detail'>>> = {
  zh: {
    skills: { title: 'Skills', detail: '列出并选择 Skill' },
    'skills-add': { title: 'Skills add', detail: '用自然语言生成并安装 Skill' },
    mcp: { title: 'MCP', detail: '列出并启用 MCP' },
    'mcp-add': { title: 'MCP add', detail: '添加 MCP server 配置' },
    'web-search': { title: 'Web search', detail: '切换联网搜索模式：auto/on/off' },
    plan: { title: '计划', detail: '只规划，不改文件' },
    goal: { title: '目标任务', detail: '创建带验收与证据追踪的目标任务' },
    workflow: { title: '动态工作流', detail: '创建待审阅的受限脚本工作流' },
    review: { title: '代码审查', detail: '优先列问题、风险和缺失测试' },
    debug: { title: '调试', detail: '系统化定位问题，再给出修复' },
    frontend: { title: '前端优化', detail: '按产品界面标准打磨 UI' },
    compact: { title: '压缩上下文', detail: '压缩当前对话上下文' },
    ops: { title: '运维调查', detail: '启动只读运维调查并持续记录证据' },
  },
  en: {
    skills: { title: 'Skills', detail: 'List and select a Skill' },
    'skills-add': { title: 'Skills add', detail: 'Generate and install a Skill from natural language' },
    mcp: { title: 'MCP', detail: 'List and enable MCP servers' },
    'mcp-add': { title: 'MCP add', detail: 'Add an MCP server configuration' },
    'web-search': { title: 'Web search', detail: 'Switch web search mode: auto/on/off' },
    plan: { title: 'Plan', detail: 'Plan only, do not edit files' },
    goal: { title: 'Goal', detail: 'Create a goal with verification and evidence tracking' },
    workflow: { title: 'Dynamic Workflow', detail: 'Create a restricted script workflow for review' },
    review: { title: 'Review', detail: 'Review code and list risks first' },
    debug: { title: 'Debug', detail: 'Reproduce, diagnose, then fix' },
    frontend: { title: 'Frontend', detail: 'Polish UI with product-grade standards' },
    compact: { title: 'Compact', detail: 'Compact this conversation context' },
    ops: { title: 'Ops investigation', detail: 'Start a read-only Ops investigation with evidence' },
  },
};

export function getSlashCommandOptions(locale: Locale): SlashCommandOption[] {
  const labels = localizedSlashDetails[locale] ?? localizedSlashDetails.en;
  return slashCommandOptions.map((option) => ({
    ...option,
    ...(labels[option.id] ?? {}),
  }));
}

export function parseSlashCommand(input: string): SlashCommand {
  const normalized = input;
  if (!normalized.startsWith('/')) return { kind: 'none' };
  const firstLine = normalized.split(/\r?\n/, 1)[0]?.trimEnd() ?? '';
  const [rawCommand, rawSubcommand] = firstLine.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const subcommand = rawSubcommand?.toLowerCase() ?? '';

  if (command === '/skills') {
    if (subcommand === 'add') return { kind: 'skills.add', args: stripCommandPrefix(normalized, rawCommand, rawSubcommand) };
    return { kind: 'skills.list' };
  }

  if (command === '/mcp') {
    if (subcommand === 'add') return { kind: 'mcp.add', args: stripCommandPrefix(normalized, rawCommand, rawSubcommand) };
    return { kind: 'mcp.list' };
  }

  if (command === '/web_search' || command === '/web-search') {
    const mode = subcommand === 'on' || subcommand === 'off' || subcommand === 'auto'
      ? subcommand
      : 'auto';
    return { kind: 'web_search.mode', mode };
  }

  if (command === '/compact') {
    return { kind: 'compact' };
  }

  if (command === '/goal') {
    return { kind: 'goal', args: stripCommandPrefix(normalized, rawCommand) };
  }

  if (command === '/workflow') {
    return { kind: 'workflow', args: stripCommandPrefix(normalized, rawCommand) };
  }

  if (command === '/ops') {
    return { kind: 'ops', preset: 'ops', args: stripCommandPrefix(normalized, rawCommand) };
  }

  if (command === '/plan' || command === '/review' || command === '/debug' || command === '/frontend') {
    return {
      kind: 'task.mode',
      mode: command.slice(1) as 'plan' | 'review' | 'debug' | 'frontend',
      args: stripCommandPrefix(normalized, rawCommand),
    };
  }

  return { kind: 'none' };
}

export function isSlashInput(input: string): boolean {
  return input.startsWith('/');
}

function stripCommandPrefix(input: string, rawCommand: string, rawSubcommand?: string): string {
  const prefix = rawSubcommand ? `${rawCommand} ${rawSubcommand}` : rawCommand;
  return input.slice(prefix.length).trimStart();
}
