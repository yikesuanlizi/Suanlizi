import { DingtalkClient, type DingtalkMessageAttachment, dwsExec, dwsSchema, dwsAuthStatus, isDwsAvailable } from '@suanlizi/bot';
import type { ToolContext, ToolDefinition, ToolResult } from '@suanlizi/tools';
import {
  BOT_CONFIG_KEY,
  normalizeBotConfig,
  type BotConfig,
  type DwsCliConfig,
} from '../config/botConfig.js';
import type { ThreadStore } from '@suanlizi/storage';

export const DINGTALK_TOOL_NAME = 'dingtalk';

export interface DingtalkForwardToolOptions {
  getConfig: () => Promise<BotConfig> | BotConfig;
  createClient?: (config: BotConfig) => DingtalkClient;
  currentUserText?: string;
  mentionUsers?: Array<{ staffId: string; name?: string }>;
  currentAttachments?: DingtalkMessageAttachment[];
  defaultSource?: 'dingtalk_dm' | 'dingtalk_group_mention' | 'suanlizi_chat';
}

export function createDingtalkForwardTools(options: DingtalkForwardToolOptions): ToolDefinition[] {
  const execute = (args: Record<string, unknown>, ctx: ToolContext) => executeDingtalkTool(args, ctx, options);
  return [
    {
      name: DINGTALK_TOOL_NAME,
      description: [
        'Unified DingTalk tool for sending messages, managing enterprise data via dws CLI, and checking authentication status.',
        'Use action=send_message to forward or send a message to the configured DingTalk target group (group forwarding, mentions, DM-to-group, attachment forwarding).',
        'Use action=dws_exec to operate DingTalk enterprise data: search contacts, manage calendar events, todos/AI tables, documents, attendance, DING messages, etc.',
        'Use action=dws_schema to discover available dws products and tools when you are unsure what commands are available.',
        'Use action=dws_auth_status to check if dws CLI is authenticated and which organization is active.',
        'Do not search files, MCP tools, ports, environment variables, or local APIs to find DingTalk functionality.',
      ].join(' '),
      requiredPolicy: 'workspace_write',
      timeoutMs: 60_000,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['send_message', 'dws_exec', 'dws_schema', 'dws_auth_status'],
            description: 'The DingTalk operation to perform. send_message: send/forward message to group. dws_exec: execute dws CLI command. dws_schema: query available dws products/tools. dws_auth_status: check dws authentication status.',
          },
          message: {
            type: 'string',
            description: '[send_message] Exact message content to send to the configured DingTalk group. With fileMode, this is an optional caption or note sent after the attachment.',
          },
          targetGroupName: {
            type: 'string',
            description: '[send_message] Optional group name mentioned by the user. It must match the configured target group name when one is configured.',
          },
          mentions: {
            type: 'array',
            items: { type: 'string' },
            description: '[send_message] Optional DingTalk display names to mention in the group message, for example ["付守凡"]. The tool resolves them to real user IDs.',
          },
          source: {
            type: 'string',
            enum: ['dingtalk_dm', 'dingtalk_group_mention', 'suanlizi_chat'],
            description: '[send_message] Where the request came from.',
          },
          intent: {
            type: 'string',
            enum: ['send_message', 'forward_user_request', 'announce_reply'],
            description: '[send_message] The forwarding intent recognized from the user request.',
          },
          note: {
            type: 'string',
            description: '[send_message] Optional private audit note. Do not put secrets or internal IDs here.',
          },
          fileMode: {
            type: 'string',
            enum: ['current_message_files'],
            description: '[send_message] Forward files or images attached to the current or most recent DingTalk DM message to the configured group. Only valid for source=dingtalk_dm.',
          },
          fileNames: {
            type: 'array',
            items: { type: 'string' },
            description: '[send_message] Optional attachment file names to forward from the current DingTalk DM context.',
          },
          dwsArgs: {
            type: 'array',
            items: { type: 'string' },
            description: '[dws_exec] Command arguments to pass to dws (without the "dws" prefix). Example: ["calendar","event","list","--format","json"]',
          },
          dwsDryRun: {
            type: 'boolean',
            description: '[dws_exec] If true, preview the request without executing. Recommended for destructive operations.',
          },
          dwsJq: {
            type: 'string',
            description: '[dws_exec] Optional jq expression to filter JSON output and reduce token consumption. Example: ".result[] | {name: .userName, id: .userId}"',
          },
          dwsToolPath: {
            type: 'string',
            description: '[dws_schema] Optional tool path to query. Format: product.rpc_name (e.g. "calendar.event.list"). If omitted, lists all products.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute,
    },
  ];
}

export function createDingtalkForwardToolsForStore(store: ThreadStore): ToolDefinition[] {
  return createDingtalkForwardTools({
    getConfig: async () => normalizeBotConfig(await store.getSetting(BOT_CONFIG_KEY)),
    defaultSource: 'suanlizi_chat',
  });
}

export function dingtalkForwardingSystemPrompt(locale: string): string {
  if (locale === 'en') {
    return [
      '## DingTalk',
      `Use the unified ${DINGTALK_TOOL_NAME} tool for all DingTalk operations: sending messages, searching contacts, managing calendar, todos, AI tables, documents, attendance, etc.`,
      '',
      '### Send / Forward Messages',
      `Use action=send_message when the user asks to send, forward, announce, coordinate, mention someone, or deliver a task result in the configured DingTalk group.`,
      `This includes short requests like "bubble in the group", "mention Alex in the group", "say hi in the group", "send the result to the group after finishing", DingTalk DM requests to forward the current DM attachment/image to the group, follow-ups that refer to the previous DingTalk group delivery, and Suanlizi chat commands that ask DingTalk to post a message.`,
      'For mentions, put human-readable names in mentions. If message starts with visible @name text, the tool will strip that prefix before sending the webhook Text message so DingTalk can render the real highlighted mention once. Do not invent DingTalk staff IDs.',
      'For attachment forwarding, use fileMode=current_message_files only when the request comes from DingTalk DM and refers to the attached/recent DM file or image. If the user asks for a caption/note or @ mention with that attachment, put the caption in message and human-readable names in mentions. Do not use it for Suanlizi local files, paths, URLs, or group mention contexts.',
      '',
      '### Enterprise Data via dws CLI',
      `Use action=dws_exec to operate DingTalk enterprise data: search contacts, manage calendar events, todos/AI tables, documents, attendance, DING messages, etc.`,
      'The dws command format is: dws <product> <group> <action> [flags]. Pass arguments in dwsArgs as an array (without the "dws" prefix).',
      'Examples: ["calendar","event","list"], ["todo","task","create","--title","Review PR","--executors","userId"], ["contact","user","search","--query","张三"]',
      'Always use dwsDryRun=true first if unsure about the command. Use dwsJq to filter JSON output and reduce token consumption.',
      `Use action=dws_schema to discover available dws products and tools when you are unsure what commands are available.`,
      `Use action=dws_auth_status to check if dws CLI is authenticated and which organization is active.`,
      '',
      'Do not discover DingTalk by searching code, reading files, scanning ports, calling MCP, checking environment variables, or curling local APIs.',
      'The tool result is final: if it says sent/completed, answer briefly; if it says failed, answer only the failure in user-facing words.',
      'Never reveal conversationId, openConversationId, processQueryKey, messageId, access tokens, tool arguments, or routing internals.',
    ].join('\n');
  }
  return [
    '## 钉钉',
    `所有钉钉操作都使用统一的 ${DINGTALK_TOOL_NAME} 工具：发送消息、搜索联系人、管理日程、待办、AI表格、文档、考勤等。`,
    '',
    '### 发送/转发消息',
    `当用户要求把内容发送、转发、发布、通知、喊话、冒泡、艾特某人、协调群内事项，或把任务结果交付到已配置的钉钉群时，使用 action=send_message。`,
    '这包括"在群里冒个泡""去群里艾特一下某人""帮我往钉钉群发 xxx""把这段转到群里""做完后把结果同步到群里"、钉钉单聊里要求把当前/最近附件或图片转到群里、以及引用上一条钉钉群投递任务的连续对话。',
    '需要 @ 人时，把可读姓名放入 mentions；message 可以包含开头的 @姓名，工具会在 webhook Text 发送前去掉这个普通文本前缀，只保留钉钉真正高亮 @。不要编造钉钉 staff/user ID。',
    '附件转发只用于钉钉单聊附件：用户要求把当前/最近单聊文件或图片发到群里时，使用 fileMode=current_message_files；如果用户同时要求备注/说明/@某人，把备注文本放入 message，把姓名放入 mentions。不要用于 Suanlizi 本地文件、路径、URL 或群 @ 上下文。',
    '',
    '### 企业数据操作（dws CLI）',
    `使用 action=dws_exec 操作钉钉企业数据：搜索联系人、管理日程、待办、AI表格、文档、考勤、DING消息等。`,
    'dws 命令格式：dws <产品> <分组> <动作> [参数]。用 dwsArgs 数组传递参数（不含 "dws" 前缀）。',
    '示例：["calendar","event","list"], ["todo","task","create","--title","评审PR","--executors","userId"], ["contact","user","search","--query","张三"]',
    '不确定命令是否正确时，先用 dwsDryRun=true 预览。用 dwsJq 过滤 JSON 输出以减少 token 消耗。',
    `不确定 dws 有哪些可用命令时，使用 action=dws_schema 发现可用产品和工具。`,
    `使用 action=dws_auth_status 检查 dws CLI 的登录状态和当前组织。`,
    '',
    '不要搜索代码、不要读取文件、不要扫描端口、不要调用 MCP、不要查环境变量、不要 curl 本地 API 来寻找钉钉发送方式。',
    '工具结果就是最终事实：成功只说明已完成；失败只说明失败原因和用户可理解的解释。',
    '不要向用户透露 conversationId、openConversationId、processQueryKey、messageId、access token、工具参数或其他内部路由细节。',
  ].join('\n');
}

async function executeDingtalkTool(
  args: Record<string, unknown>,
  _ctx: ToolContext,
  options: DingtalkForwardToolOptions,
): Promise<ToolResult> {
  const action = normalizeText(args.action) || 'send_message';

  if (action === 'dws_exec') {
    return executeDwsExec(args, options);
  }
  if (action === 'dws_schema') {
    return executeDwsSchema(args, options);
  }
  if (action === 'dws_auth_status') {
    return executeDwsAuthStatus(options);
  }

  return executeSendMessage(args, options);
}

async function getDwsConfig(options: DingtalkForwardToolOptions): Promise<{ binaryPath: string | undefined; env: Record<string, string> }> {
  const config = await options.getConfig();
  const dwsConfig = config.dwsCli as DwsCliConfig | undefined;
  const binaryPath = dwsConfig?.binaryPath?.trim() || undefined;
  const env: Record<string, string> = {};
  if (dwsConfig?.clientId?.trim()) {
    env.DWS_CLIENT_ID = dwsConfig.clientId.trim();
  }
  if (dwsConfig?.clientSecret?.trim()) {
    env.DWS_CLIENT_SECRET = dwsConfig.clientSecret.trim();
  }
  return { binaryPath, env };
}

async function executeDwsExec(
  args: Record<string, unknown>,
  options: DingtalkForwardToolOptions,
): Promise<ToolResult> {
  const cmdArgs = Array.isArray(args.dwsArgs) ? args.dwsArgs.map(String) : [];
  const dryRun = Boolean(args.dwsDryRun);
  const jq = typeof args.dwsJq === 'string' ? args.dwsJq.trim() : undefined;
  if (cmdArgs.length === 0) {
    return { status: 'failed', output: 'Error: dwsArgs is required for action=dws_exec.', error: { message: 'No dws command arguments provided.' } };
  }
  const { binaryPath, env } = await getDwsConfig(options);
  const available = await isDwsAvailable(binaryPath);
  if (!available) {
    return {
      status: 'failed',
      output: 'dws CLI is not installed or not found. Please install it first.',
      error: { message: 'dws not available' },
    };
  }
  const result = await dwsExec(cmdArgs, {
    binaryPath,
    env,
    format: 'json',
    dryRun,
    jq,
  });
  if (result.exitCode !== 0 && result.exitCode !== -2) {
    return {
      status: 'failed',
      output: `dws exited with code ${result.exitCode}.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
      error: { message: `dws exited with code ${result.exitCode}` },
    };
  }
  const output = result.json !== null ? JSON.stringify(result.json, null, 2) : result.stdout;
  return { status: 'completed', output: output || '(empty output)' };
}

async function executeDwsSchema(
  args: Record<string, unknown>,
  options: DingtalkForwardToolOptions,
): Promise<ToolResult> {
  const toolPath = typeof args.dwsToolPath === 'string' ? args.dwsToolPath.trim() : undefined;
  const { binaryPath, env } = await getDwsConfig(options);
  const available = await isDwsAvailable(binaryPath);
  if (!available) {
    return { status: 'failed', output: 'dws CLI is not installed or not found.', error: { message: 'dws not available' } };
  }
  const result = await dwsSchema(toolPath, { binaryPath, env });
  if (result.exitCode !== 0) {
    return { status: 'failed', output: `dws schema failed: ${result.stderr}`, error: { message: `dws schema exited ${result.exitCode}` } };
  }
  return { status: 'completed', output: result.stdout || '(empty)' };
}

async function executeDwsAuthStatus(options: DingtalkForwardToolOptions): Promise<ToolResult> {
  const { binaryPath, env } = await getDwsConfig(options);
  const available = await isDwsAvailable(binaryPath);
  if (!available) {
    return { status: 'failed', output: 'dws CLI is not installed or not found.', error: { message: 'dws not available' } };
  }
  const result = await dwsAuthStatus({ binaryPath, env });
  if (result.exitCode !== 0) {
    return { status: 'failed', output: `Not authenticated: ${result.stderr}`, error: { message: 'Not authenticated' } };
  }
  return { status: 'completed', output: result.stdout || '(empty)' };
}

async function executeSendMessage(
  args: Record<string, unknown>,
  options: DingtalkForwardToolOptions,
): Promise<ToolResult> {
  const message = normalizeText(args.message);
  const fileMode = normalizeText(args.fileMode);
  const source = normalizeText(args.source) || options.defaultSource || '';
  const requestedGroupName = normalizeText(args.targetGroupName);
  const rawMentionStaffIds = normalizeStringArray(args.mentionStaffIds);
  const invalidMentionStaffIds = rawMentionStaffIds.filter((id) => !looksLikeDingtalkStaffId(id));
  const requestedMentionNames = mergeUniqueStrings([
    ...normalizeStringArray(args.mentions).map(stripAtPrefix),
    ...extractMentionNames(message),
    ...extractMentionNames(options.currentUserText ?? ''),
  ]);
  const config = await options.getConfig();
  const targetConversationId = config.dingtalk.targetGroupConversationId?.trim() ?? '';
  const targetSessionWebhook = config.dingtalk.targetGroupSessionWebhook?.trim() ?? '';
  const targetGroupName = config.dingtalk.targetGroupName?.trim() ?? '';

  if (fileMode === 'current_message_files') {
    if (source !== 'dingtalk_dm') {
      return failed('文件转发只支持钉钉单聊里的当前或最近附件。', 'DINGTALK_FILE_FORWARD_DM_ONLY');
    }
    return forwardDingtalkDmAttachments({
      source: 'dingtalk_dm',
      config,
      message,
      requestedGroupName,
      targetGroupName,
      targetConversationId,
      targetSessionWebhook,
      clientFactory: options.createClient,
      attachments: options.currentAttachments ?? [],
      fileNames: normalizeStringArray(args.fileNames),
      rawStaffIds: rawMentionStaffIds.filter((id) => looksLikeDingtalkStaffId(id)),
      invalidMentionStaffIds,
      mentionNames: requestedMentionNames,
      mentionUsers: options.mentionUsers ?? [],
      currentUserText: options.currentUserText ?? '',
    });
  }

  if (!message) {
    return failed('消息内容不能为空。', 'DINGTALK_MESSAGE_TEXT_REQUIRED');
  }
  if (!config.dingtalk.enabled) {
    return failed('钉钉机器人未启用。', 'DINGTALK_DISABLED');
  }
  if (!config.dingtalk.clientId.trim() || !config.dingtalk.clientSecret.trim()) {
    return failed('钉钉应用 AppKey 或 AppSecret 未配置。', 'DINGTALK_CREDENTIALS_NOT_CONFIGURED');
  }
  if (!targetConversationId) {
    return failed('还没有配置钉钉目标群会话 ID。请在设置里填写，或先在目标群 @ 我一次以自动检测。', 'DINGTALK_TARGET_GROUP_NOT_CONFIGURED');
  }
  if (requestedGroupName && targetGroupName && requestedGroupName !== targetGroupName) {
    return failed(`当前只配置了钉钉目标群「${targetGroupName}」，没有找到「${requestedGroupName}」。`, 'DINGTALK_TARGET_GROUP_MISMATCH');
  }
  const mentionRequested = containsMentionSyntax(options.currentUserText ?? '') || /艾特|@/.test(options.currentUserText ?? '');
  if (invalidMentionStaffIds.length > 0) {
    return failed('mentionStaffIds 必须是真实钉钉成员 ID，不能填写姓名或 @ 显示名。', 'DINGTALK_MENTION_TARGET_NOT_RESOLVED');
  }

  const client = options.createClient?.(config) ?? new DingtalkClient({
    clientId: config.dingtalk.clientId,
    clientSecret: config.dingtalk.clientSecret,
    robotCode: config.dingtalk.robotCode,
  });
  const mentionResolution = await resolveMentionStaffIds({
    rawStaffIds: rawMentionStaffIds.filter((id) => looksLikeDingtalkStaffId(id)),
    names: requestedMentionNames,
    knownUsers: options.mentionUsers ?? [],
    client,
    dwsConfig: config.dwsCli,
  });
  if (!mentionResolution.ok) {
    return failed(mentionResolution.reason, mentionResolution.code);
  }
  const mentionStaffIds = mentionResolution.staffIds;
  if ((containsMentionSyntax(message) || mentionRequested) && mentionStaffIds.length === 0) {
    return failed('消息包含 @，但没有识别到对应的钉钉成员 ID，无法触发真正的群 @。', 'DINGTALK_MENTION_TARGET_NOT_RESOLVED');
  }
  const sendResult = await sendGroupMessageWithFallback({
    client,
    conversationId: targetConversationId,
    sessionWebhook: targetSessionWebhook,
    text: message,
    atStaffIds: mentionStaffIds,
    mentionNames: requestedMentionNames,
  });
  if (!sendResult.ok) {
    return failed(sendResult.error, sendResult.code);
  }
  const output = sendResult.usedFallback
    ? '已发送（session webhook 已过期，使用机器人主动发送）'
    : '已发送';
  return { status: 'completed', output };
}

async function forwardDingtalkDmAttachments(options: {
  source: string;
  config: BotConfig;
  message: string;
  requestedGroupName: string;
  targetGroupName: string;
  targetConversationId: string;
  targetSessionWebhook: string;
  clientFactory?: (config: BotConfig) => DingtalkClient;
  attachments: DingtalkMessageAttachment[];
  fileNames: string[];
  rawStaffIds: string[];
  invalidMentionStaffIds: string[];
  mentionNames: string[];
  mentionUsers: Array<{ staffId: string; name?: string }>;
  currentUserText: string;
}): Promise<ToolResult> {
  if (options.source !== 'dingtalk_dm') {
    return failed('文件转发只支持钉钉单聊里的当前或最近附件。', 'DINGTALK_FILE_FORWARD_DM_ONLY');
  }
  if (!options.config.dingtalk.enabled) {
    return failed('钉钉机器人未启用。', 'DINGTALK_DISABLED');
  }
  if (!options.config.dingtalk.clientId.trim() || !options.config.dingtalk.clientSecret.trim()) {
    return failed('钉钉应用 AppKey 或 AppSecret 未配置。', 'DINGTALK_CREDENTIALS_NOT_CONFIGURED');
  }
  if (!options.targetConversationId) {
    return failed('还没有配置钉钉目标群会话 ID。请在设置里填写，或先在目标群 @ 我一次以自动检测。', 'DINGTALK_TARGET_GROUP_NOT_CONFIGURED');
  }
  if (options.requestedGroupName && options.targetGroupName && options.requestedGroupName !== options.targetGroupName) {
    return failed(`当前只配置了钉钉目标群「${options.targetGroupName}」，没有找到「${options.requestedGroupName}」。`, 'DINGTALK_TARGET_GROUP_MISMATCH');
  }
  const selected = selectAttachments(options.attachments, options.fileNames);
  if (!selected.length) {
    return failed('没有可转发的钉钉单聊文件。', 'DINGTALK_FILE_FORWARD_NOT_FOUND');
  }
  const client = options.clientFactory?.(options.config) ?? new DingtalkClient({
    clientId: options.config.dingtalk.clientId,
    clientSecret: options.config.dingtalk.clientSecret,
    robotCode: options.config.dingtalk.robotCode,
  });
  if (typeof client.downloadFile !== 'function') {
    return failed('当前钉钉客户端不支持文件下载。', 'DINGTALK_FILE_DOWNLOAD_UNSUPPORTED');
  }
  if (typeof client.sendFile !== 'function') {
    return failed('当前钉钉客户端不支持文件发送。', 'DINGTALK_FILE_SEND_UNSUPPORTED');
  }
  let captionSend: (() => Promise<ToolResult | null>) | null = null;
  let mentionWarning = '';
  let captionUsedFallback = false;
  if (options.message) {
    let mentionStaffIds: string[] = [];
    if (options.invalidMentionStaffIds.length > 0) {
      mentionWarning = '未能执行 @：mentionStaffIds 不是有效钉钉成员 ID。';
    } else {
      const mentionResolution = await resolveMentionStaffIds({
        rawStaffIds: options.rawStaffIds,
        names: options.mentionNames,
        knownUsers: options.mentionUsers,
        client,
        dwsConfig: options.config.dwsCli,
      });
      if (mentionResolution.ok) {
        mentionStaffIds = mentionResolution.staffIds;
      } else {
        mentionWarning = `未能执行 @：${mentionResolution.reason}`;
      }
    }
    captionSend = async () => {
      const sendResult = await sendGroupMessageWithFallback({
        client,
        conversationId: options.targetConversationId,
        sessionWebhook: options.targetSessionWebhook,
        text: options.message,
        atStaffIds: mentionStaffIds,
        mentionNames: options.mentionNames,
      });
      if (!sendResult.ok) {
        return failed(sendResult.error, sendResult.code);
      }
      captionUsedFallback = sendResult.usedFallback;
      return null;
    };
  }
  for (const attachment of selected) {
    if (!attachment.downloadCode) {
      return failed(`文件「${attachment.fileName}」缺少下载凭证，无法转发。`, 'DINGTALK_FILE_DOWNLOAD_CODE_MISSING');
    }
    const download = await client.downloadFile({ downloadCode: attachment.downloadCode });
    if (!download.ok || !download.bytes) {
      return failed(`下载文件「${attachment.fileName}」失败：${download.error ?? 'unknown error'}`, 'DINGTALK_FILE_DOWNLOAD_FAILED');
    }
    const send = await client.sendFile({
      conversationType: '2',
      conversationId: options.targetConversationId,
      fileName: attachment.fileName,
      fileBytes: download.bytes,
      fileSize: attachment.fileSize ?? download.bytes.length,
      mimeType: attachment.mimeType,
    });
    if (!send.ok) {
      return failed(`发送文件「${attachment.fileName}」失败：${send.error ?? 'unknown error'}`, 'DINGTALK_FILE_SEND_FAILED');
    }
  }
  const captionResult = captionSend ? await captionSend() : null;
  if (captionResult) return captionResult;
  const parts: string[] = [];
  if (mentionWarning) parts.push(mentionWarning);
  if (captionUsedFallback) parts.push('session webhook 已过期，使用机器人主动发送');
  const output = parts.length ? `已发送（${parts.join('；')}）` : '已发送';
  return { status: 'completed', output };
}

function selectAttachments(attachments: DingtalkMessageAttachment[], fileNames: string[]): DingtalkMessageAttachment[] {
  const normalizedNames = new Set(fileNames.map(normalizeDingtalkToolText));
  const valid = attachments.filter((attachment) => attachment.fileName.trim());
  if (!normalizedNames.size) return valid;
  return valid.filter((attachment) => normalizedNames.has(normalizeDingtalkToolText(attachment.fileName)));
}

function failed(reason: string, code: string): ToolResult {
  return {
    status: 'failed',
    output: `发送失败：${reason}`,
    error: { message: reason, code },
  };
}

function isSessionExpiredError(error: string): boolean {
  if (!error) return false;
  return error.includes('300001') || error.includes('session 不存在');
}

async function sendGroupMessageWithFallback(options: {
  client: DingtalkClient;
  conversationId: string;
  sessionWebhook?: string;
  text: string;
  atStaffIds: string[];
  mentionNames: string[];
}): Promise<{ ok: true; usedFallback: boolean } | { ok: false; error: string; code: string }> {
  const { client, conversationId, sessionWebhook, text, atStaffIds, mentionNames } = options;

  if (atStaffIds.length) {
    if (!sessionWebhook) {
      return {
        ok: false,
        error: '目标群还没有可用于真实 @ 的 sessionWebhook。请先在目标群 @ 我一次，让我记录这个群的会话 webhook。',
        code: 'DINGTALK_GROUP_SESSION_WEBHOOK_REQUIRED_FOR_MENTION',
      };
    }
    const webhookText = stripLeadingMentionText(text, mentionNames) || text;
    const webhookResult = await client.sendWebhookText({
      webhookUrl: sessionWebhook,
      text: webhookText,
      atStaffIds,
    });
    if (webhookResult.ok) {
      return { ok: true, usedFallback: false };
    }
    if (!isSessionExpiredError(webhookResult.error ?? '')) {
      return { ok: false, error: webhookResult.error ?? 'unknown error', code: 'DINGTALK_GROUP_SEND_FAILED' };
    }
  }

  const markdownResult = await client.sendMarkdown({
    conversationType: '2',
    conversationId,
    text,
    ...(atStaffIds.length ? { atStaffIds } : {}),
  });
  if (markdownResult.ok) {
    return { ok: true, usedFallback: atStaffIds.length > 0 };
  }
  return { ok: false, error: markdownResult.error ?? 'unknown error', code: 'DINGTALK_GROUP_SEND_FAILED' };
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function inferMentionStaffIds(message: string, users: Array<{ staffId: string; name?: string }>): string[] {
  const normalizedMessage = normalizeDingtalkToolText(message);
  if (!containsMentionSyntax(message)) return [];
  const ids: string[] = [];
  for (const user of users) {
    const staffId = user.staffId.trim();
    const name = user.name?.trim();
    if (!staffId || !name) continue;
    if (normalizedMessage.includes(`@${normalizeDingtalkToolText(name)}`)) {
      ids.push(staffId);
    }
  }
  return mergeUniqueStrings(ids);
}

async function resolveMentionStaffIds(options: {
  rawStaffIds: string[];
  names: string[];
  knownUsers: Array<{ staffId: string; name?: string }>;
  client: DingtalkClient;
  dwsConfig?: { enabled: boolean; binaryPath?: string; clientId?: string; clientSecret?: string };
}): Promise<
  | { ok: true; staffIds: string[] }
  | { ok: false; reason: string; code: string }
> {
  const staffIds = mergeUniqueStrings([
    ...options.rawStaffIds,
    ...inferMentionStaffIds(options.names.map((name) => `@${name}`).join(' '), options.knownUsers),
  ]);
  if (options.rawStaffIds.length > 0) {
    return { ok: true, staffIds };
  }
  const searchContactUserIds = typeof options.client.searchContactUserIds === 'function'
    ? options.client.searchContactUserIds.bind(options.client)
    : null;
  const searchOrgUserIdsByName = typeof options.client.searchOrgUserIdsByName === 'function'
    ? options.client.searchOrgUserIdsByName.bind(options.client)
    : null;
  const dwsEnabled = options.dwsConfig?.enabled && options.dwsConfig?.clientId && options.dwsConfig?.clientSecret;
  for (const rawName of options.names) {
    const name = stripAtPrefix(rawName);
    if (!name) continue;
    if (findKnownMentionStaffId(name, options.knownUsers)) continue;
    if (!searchContactUserIds && !searchOrgUserIdsByName && !dwsEnabled) {
      return {
        ok: false,
        reason: '当前钉钉客户端不支持通讯录或组织成员查询，无法解析 @ 成员。',
        code: 'DINGTALK_MENTION_TARGET_NOT_RESOLVED',
      };
    }
    let contactError = '';
    let userIds: string[] = [];

    if (dwsEnabled) {
      try {
        const dwsEnv: Record<string, string> = {};
        if (options.dwsConfig?.clientId) dwsEnv.DWS_CLIENT_ID = options.dwsConfig.clientId;
        if (options.dwsConfig?.clientSecret) dwsEnv.DWS_CLIENT_SECRET = options.dwsConfig.clientSecret;
        const result = await dwsExec(
          ['contact', 'user', 'search', '--query', name, '--fields', 'userId,name'],
          {
            binaryPath: options.dwsConfig?.binaryPath,
            timeoutMs: 15_000,
            env: dwsEnv,
            format: 'json',
          },
        );
        if (result.exitCode === 0 && result.json && typeof result.json === 'object') {
          const data = result.json as { result?: Array<{ userId?: string; name?: string }>; success?: boolean };
          if (data.success !== false && Array.isArray(data.result)) {
            userIds = data.result
              .filter((item) => item.userId && item.name === name)
              .map((item) => item.userId!);
            if (userIds.length === 0) {
              userIds = data.result.filter((item) => item.userId).map((item) => item.userId!);
            }
          }
        } else if (result.stderr) {
          contactError = result.stderr;
        }
      } catch (error) {
        contactError = error instanceof Error ? error.message : String(error);
      }
    }

    if (userIds.length > 1) {
      return {
        ok: false,
        reason: `钉钉通讯录中找到多个「${name}」，请指定更唯一的姓名、手机号或组织信息。`,
        code: 'DINGTALK_MENTION_TARGET_AMBIGUOUS',
      };
    }
    if (userIds.length === 1) {
      staffIds.push(userIds[0]);
      continue;
    }

    if (searchContactUserIds) {
      const result = await searchContactUserIds({ queryWord: name, fullMatch: true, size: 10 });
      if (result.ok) {
        userIds = mergeUniqueStrings(result.userIds ?? []);
      } else {
        contactError = result.error ?? 'unknown error';
      }
    }
    if (userIds.length > 1) {
      return {
        ok: false,
        reason: `钉钉通讯录中找到多个「${name}」，请指定更唯一的姓名、手机号或组织信息。`,
        code: 'DINGTALK_MENTION_TARGET_AMBIGUOUS',
      };
    }
    if (userIds.length === 1) {
      staffIds.push(userIds[0]);
      continue;
    }
    if (searchOrgUserIdsByName) {
      const result = await searchOrgUserIdsByName({ name });
      if (!result.ok) {
        const error = (result.error ?? contactError) || 'unknown error';
        return {
          ok: false,
          reason: `查询钉钉组织成员「${name}」失败：${error}`,
          code: 'DINGTALK_MENTION_TARGET_NOT_RESOLVED',
        };
      }
      userIds = mergeUniqueStrings(result.userIds ?? []);
    }
    if (userIds.length === 0) {
      return {
        ok: false,
        reason: `没有在钉钉通讯录或组织部门中找到「${name}」。`,
        code: 'DINGTALK_MENTION_TARGET_NOT_RESOLVED',
      };
    }
    if (userIds.length > 1) {
      return {
        ok: false,
        reason: `钉钉组织中找到多个「${name}」，请指定更唯一的姓名、手机号或组织信息。`,
        code: 'DINGTALK_MENTION_TARGET_AMBIGUOUS',
      };
    }
    staffIds.push(userIds[0]);
  }
  return { ok: true, staffIds: mergeUniqueStrings(staffIds) };
}

function findKnownMentionStaffId(name: string, users: Array<{ staffId: string; name?: string }>): string {
  const normalizedName = normalizeDingtalkToolText(stripAtPrefix(name));
  if (!normalizedName) return '';
  const match = users.find((user) => normalizeDingtalkToolText(user.name ?? '') === normalizedName);
  return match?.staffId.trim() ?? '';
}

function containsMentionSyntax(message: string): boolean {
  return /@[^\s@，,。:：；;]{1,64}/.test(message);
}

function extractMentionNames(message: string): string[] {
  return [...message.matchAll(/@([^\s@，,。:：；;]{1,64})/g)]
    .map((match) => stripAtPrefix(match[1] ?? ''))
    .filter(Boolean);
}

function stripAtPrefix(value: string): string {
  return value.trim().replace(/^@+/, '').trim();
}

function stripLeadingMentionText(message: string, names: string[]): string {
  let next = message.trim();
  const sortedNames = mergeUniqueStrings(names.map(stripAtPrefix)).sort((a, b) => b.length - a.length);
  for (let changed = true; changed;) {
    changed = false;
    for (const name of sortedNames) {
      if (!name) continue;
      const pattern = new RegExp(`^@\\s*${escapeRegExp(name)}(?:[\\s,，:：;；]+|$)`);
      const stripped = next.replace(pattern, '').trimStart();
      if (stripped !== next) {
        next = stripped;
        changed = true;
        break;
      }
    }
  }
  return next.trim();
}

function looksLikeDingtalkStaffId(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{2,128}$/.test(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeUniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeDingtalkToolText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, '')
    .trim();
}
