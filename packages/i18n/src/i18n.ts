/** Supported locales. */
// 支持的语言环境
export type Locale = 'zh' | 'en';

export const ALL_LOCALES: Locale[] = ['zh', 'en'];

export const LOCALE_DISPLAY: Record<Locale, string> = {
  zh: '中文',
  en: 'English',
};

// ─── String Tables ──────────────────────────────────────────────────────────
const zh = {
  'cli.connecting': '正在连接 {provider} 模型 "{model}"...',
  'cli.connected': '✓ 已连接。可用模型: {models}',
  'cli.cannot_reach': '❌ 无法访问模型端点: {error}',
  'cli.cannot_reach_url': '   URL: {url}',
  'cli.thread_started': '📋 线程已启动: {threadId}',
  'cli.turn_started': '🔄 第 {index} 轮开始...',
  'cli.turn_completed': '✅ 轮次完成 ({input} in / {output} out tokens)',
  'cli.turn_failed': '❌ 轮次失败: {error}',
  'cli.tool_call': '🔧 {tool}({args})',
  'cli.tool_result': '   → {result}',
  'cli.approval_required': '⚠ 需要审批: {description}',
  'cli.compacted': '📦 压缩完成: {turns} 轮, {before} → {after} tokens',
  'cli.resumed': '已恢复线程: {title} ({turns} 轮)',
  'cli.not_found': '线程 {id} 未找到，创建新线程。',
  'cli.started_new': '已创建新线程: {threadId}',
  'cli.no_active': '没有活动线程。',
  'cli.compacting': '正在压缩...',
  'cli.compact_done': '完成: {count} 轮已压缩。',
  'cli.forked': '已分支: {threadId}',
  'cli.rolled_back': '已回退 {count} 轮。',
  'cli.goodbye': '再见。',
  'cli.unknown_cmd': '未知命令: /{cmd}。输入 /help 查看帮助。',
  'cli.usage_resume': '用法: /resume <threadId>',
  'cli.prompt_hint': '输入消息或 /help 查看命令。/quit 退出。',
  'cli.lang_switched': '语言已切换为: {lang}',
  'help.title': 'suanlizi — 本地 Agent OS CLI',
  'help.usage': '用法: suanlizi [选项]',
  'help.opt_workspace': '  工作区根目录 (默认: cwd)',
  'help.opt_model': '  模型名称 (默认: qwen2.5-coder:7b)',
  'help.opt_provider': '  模型提供方: ollama | lmstudio | vllm | llama_cpp | openai_compatible | anthropic',
  'help.opt_base_url': '  覆盖 API 基础 URL',
  'help.opt_api_key': '  API 密钥 (远程 provider)',
  'help.opt_permissions': '  权限预设: read_only | workspace | danger_full_access',
  'help.opt_data_dir': '  数据目录 (默认: 应用数据目录)',
  'help.opt_lang': '  界面语言: zh | en (默认: zh)',
  'help.opt_resume': '  恢复指定线程',
  'help.opt_help': '  显示此帮助',
  'help.cmd_new': '  创建新线程',
  'help.cmd_resume': '  恢复线程',
  'help.cmd_compact': '  触发上下文压缩',
  'help.cmd_rollback': '  回退最近 n 轮',
  'help.cmd_fork': '  分支当前线程',
  'help.cmd_list': '  列出最近线程',
  'help.cmd_lang': '  切换语言 (zh/en)',
  'help.cmd_help': '  显示交互帮助',
  'help.cmd_quit': '  退出',
  'agent.system_prompt':
    '你是 Suanlizi，一个本地运行的全能 Agent OS。你可以使用工具来处理代码、管理文件、执行命令、搜索内容、操作企业数据、调用技能等。\n\n' +
    '规则:\n' +
    '- 编辑文件前先读取。\n' +
    '- 使用绝对路径或工作区相对路径。\n' +
    '- 执行命令前先说明你打算做什么。\n' +
    '- 如果工具需要审批，等待通过——绝不绕过。\n' +
    '- 本地代码分析以 list_files/read_file/search_content 等内置工具为主；它们始终是可用的基础路径。\n' +
    '- browser_pages 只能列出页面和 pageId，既不接收 URL，也不会打开网页。用户要求打开地址时，调用 browser_navigate 并传入 url；about:blank 表示尚未打开网页，导航成功前不得声称页面已打开。\n' +
    '- 浏览器操作按线程串行。用户已提供 URL 时，首个浏览器调用直接使用 browser_navigate 打开该 URL；不要先调用 browser_pages，也不要与 shell_command 或其他可能等待审批的工具放在同一批调用中。导航需要审批时，等待审批结果后再继续观察或操作。\n' +
    '- 禁止使用 window.THREE、@ts-nocheck、或假设浏览器全局变量。\n' +
    '- 始终使用 ESM import。\n' +
    '- 优先选择简洁、清晰的解决方案。\n' +
    '- 用中文回答。',
  'agent.system_prompt_en':
    'You are Suanlizi, a fully-featured local Agent OS. You can use tools to work with code, manage files, execute commands, search content, operate enterprise data, invoke skills, and more.\n\n' +
    'Rules:\n' +
    '- Read files before editing them.\n' +
    '- Use absolute or workspace-relative paths.\n' +
    '- Explain what you are about to do before executing commands.\n' +
    '- If a tool requires approval, wait for it — never bypass.\n' +
    '- For simple date/time questions, use the current_time tool instead of shell_command.\n' +
    '- For local code analysis, keep list_files/read_file/search_content as the primary path; these built-in tools remain the source of truth.\n' +
    '- browser_pages only lists pages and pageIds: it accepts no URL and never opens a page. When the user asks to open an address, call browser_navigate with url; about:blank means no webpage has opened, so do not claim success before navigation succeeds.\n' +
    '- Browser operations are serialized per thread. When the user has provided a URL, make browser_navigate the first browser call; do not first call browser_pages or batch it with shell_command or another tool that may wait for approval. If navigation needs approval, wait for that result before observing or acting.\n' +
    '- Do NOT use window.THREE, @ts-nocheck, or assume browser globals.\n' +
    '- Always use ESM imports.\n' +
    '- Prefer simple, clear solutions.',
  'runtime.unknown_tool': '未知工具: {tool}',
  'runtime.sandbox_denied': '工具 {tool} 在当前沙箱模式下不允许',
  'runtime.rejected': '已拒绝: {reason}',
  'runtime.max_iterations': 'Agent 循环超出最大迭代次数 ({max})',
  'runtime.no_response': '模型无响应',
  'sandbox.approval_command': '执行命令: {command}',
  'sandbox.approval_file_write': '写入文件: {path}',
  'sandbox.approval_tool': '执行工具: {tool}',
} as const;

const en: Record<keyof typeof zh, string> = {
  'cli.connecting': 'Connecting to {provider} model "{model}"...',
  'cli.connected': '✓ Connected. Models: {models}',
  'cli.cannot_reach': '❌ Cannot reach model endpoint: {error}',
  'cli.cannot_reach_url': '   URL: {url}',
  'cli.thread_started': '📋 Thread started: {threadId}',
  'cli.turn_started': '🔄 Turn {index} started...',
  'cli.turn_completed': '✅ Turn completed ({input} in / {output} out tokens)',
  'cli.turn_failed': '❌ Turn failed: {error}',
  'cli.tool_call': '🔧 {tool}({args})',
  'cli.tool_result': '   → {result}',
  'cli.approval_required': '⚠ Approval required: {description}',
  'cli.compacted': '📦 Compaction: {turns} turns, {before} → {after} tokens',
  'cli.resumed': 'Resumed thread: {title} ({turns} turns)',
  'cli.not_found': 'Thread {id} not found, starting new.',
  'cli.started_new': 'Started new thread: {threadId}',
  'cli.no_active': 'No active thread.',
  'cli.compacting': 'Compacting...',
  'cli.compact_done': 'Done: {count} turns compacted.',
  'cli.forked': 'Forked: {threadId}',
  'cli.rolled_back': 'Rolled back {count} turns.',
  'cli.goodbye': 'Goodbye.',
  'cli.unknown_cmd': 'Unknown command: /{cmd}. Type /help.',
  'cli.usage_resume': 'Usage: /resume <threadId>',
  'cli.prompt_hint': 'Type a message or /help for commands. /quit to exit.',
  'cli.lang_switched': 'Language switched to: {lang}',
  'help.title': 'suanlizi — Suanlizi CLI',
  'help.usage': 'Usage: suanlizi [options]',
  'help.opt_workspace': '  Workspace root (default: cwd)',
  'help.opt_model': '  Model name (default: qwen2.5-coder:7b)',
  'help.opt_provider': '  Provider: ollama | lmstudio | vllm | llama_cpp | openai_compatible | anthropic',
  'help.opt_base_url': '  Override API base URL',
  'help.opt_api_key': '  API key (for remote providers)',
  'help.opt_permissions': '  Permission preset: read_only | workspace | danger_full_access',
  'help.opt_data_dir': '  Data directory (default: app data directory)',
  'help.opt_lang': '  UI language: zh | en (default: zh)',
  'help.opt_resume': '  Resume a thread by ID',
  'help.opt_help': '  Show this help',
  'help.cmd_new': '  Start a new thread',
  'help.cmd_resume': '  Resume a thread',
  'help.cmd_compact': '  Trigger context compaction',
  'help.cmd_rollback': '  Rollback last n turns',
  'help.cmd_fork': '  Fork current thread',
  'help.cmd_list': '  List recent threads',
  'help.cmd_lang': '  Switch language (zh/en)',
  'help.cmd_help': '  Show interactive help',
  'help.cmd_quit': '  Exit',
  'agent.system_prompt':
    'You are Suanlizi, a fully-featured local Agent OS. You can use tools to work with code, manage files, execute commands, search content, operate enterprise data, invoke skills, and more.\n\n' +
    'Rules:\n' +
    '- Read files before editing them.\n' +
    '- Use absolute or workspace-relative paths.\n' +
    '- Explain what you are about to do before executing commands.\n' +
    '- If a tool requires approval, wait for it — never bypass.\n' +
    '- For simple date/time questions, use the current_time tool instead of shell_command.\n' +
    '- For local code analysis, keep list_files/read_file/search_content as the primary path; these built-in tools remain the source of truth.\n' +
    '- browser_pages only lists pages and pageIds: it accepts no URL and never opens a page. When the user asks to open an address, call browser_navigate with url; about:blank means no webpage has opened, so do not claim success before navigation succeeds.\n' +
    '- Browser operations are serialized per thread. When the user has provided a URL, make browser_navigate the first browser call; do not first call browser_pages or batch it with shell_command or another tool that may wait for approval. If navigation needs approval, wait for that result before observing or acting.\n' +
    '- Do NOT use window.THREE, @ts-nocheck, or assume browser globals.\n' +
    '- Always use ESM imports.\n' +
    '- Prefer simple, clear solutions.',
  'agent.system_prompt_en':
    'You are Suanlizi, a fully-featured local Agent OS. You can use tools to work with code, manage files, execute commands, search content, operate enterprise data, invoke skills, and more.\n\n' +
    'Rules:\n' +
    '- Read files before editing them.\n' +
    '- Use absolute or workspace-relative paths.\n' +
    '- Explain what you are about to do before executing commands.\n' +
    '- If a tool requires approval, wait for it — never bypass.\n' +
    '- For simple date/time questions, use the current_time tool instead of shell_command.\n' +
    '- For local code analysis, keep list_files/read_file/search_content as the primary path; these built-in tools remain the source of truth.\n' +
    '- browser_pages only lists pages and pageIds: it accepts no URL and never opens a page. When the user asks to open an address, call browser_navigate with url; about:blank means no webpage has opened, so do not claim success before navigation succeeds.\n' +
    '- Browser operations are serialized per thread. When the user has provided a URL, make browser_navigate the first browser call; do not first call browser_pages or batch it with shell_command or another tool that may wait for approval. If navigation needs approval, wait for that result before observing or acting.\n' +
    '- Do NOT use window.THREE, @ts-nocheck, or assume browser globals.\n' +
    '- Always use ESM imports.\n' +
    '- Prefer simple, clear solutions.',
  'runtime.unknown_tool': 'Unknown tool: {tool}',
  'runtime.sandbox_denied': 'Tool {tool} not allowed in current sandbox mode',
  'runtime.rejected': 'Rejected: {reason}',
  'runtime.max_iterations': 'Agent loop exceeded max iterations ({max})',
  'runtime.no_response': 'No response from model',
  'sandbox.approval_command': 'Execute command: {command}',
  'sandbox.approval_file_write': 'Write file: {path}',
  'sandbox.approval_tool': 'Execute tool: {tool}',
};

const TABLES: Record<Locale, Record<string, string>> = {
  zh: zh as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
};

export type UiKey = keyof typeof zh;

// ─── I18n API ───────────────────────────────────────────────────────────────
// 国际化（I18n）API 接口
export interface I18n {
  locale: Locale;
  t(key: UiKey, params?: Record<string, string | number>): string;
}

export function createI18n(locale: Locale): I18n {
  return {
    locale,
    t(key: UiKey, params?: Record<string, string | number>): string {
      const table = TABLES[locale] ?? TABLES.en;
      const template = (table[key] ?? TABLES.en[key] ?? key) as string;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        String(params[name] ?? `{${name}}`),
      );
    },
  };
}

/** System prompt key — zh uses 'agent.system_prompt' (with "用中文回答"), en uses 'agent.system_prompt_en'. */
// 系统提示词键：中文环境使用 'agent.system_prompt'（含"用中文回答"），英文环境使用 'agent.system_prompt_en'
export function systemPromptKey(locale: Locale): 'agent.system_prompt' | 'agent.system_prompt_en' {
  return locale === 'zh' ? 'agent.system_prompt' : 'agent.system_prompt_en';
}
