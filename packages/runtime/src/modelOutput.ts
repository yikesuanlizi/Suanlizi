import type { ItemId, SuanliziErrorInfo, ThreadItem, TurnId } from '@suanlizi/protocol';
import { SuanliziRuntimeError } from './runtimeError.js';

// 模型输出的可识别事件类型：消息增量、最终文本、工具调用、工具结果、思考过程、工作流事件、流式错误
export type ModelOutputItem =
  | { type: 'assistant_message_delta'; itemId: ItemId; turnId: TurnId; delta: string }
  | { type: 'assistant_message_final'; itemId: ItemId; turnId: TurnId; text: string }
  | { type: 'tool_call'; callId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; toolName: string; output: string }
  | { type: 'reasoning'; itemId: ItemId; turnId: TurnId; text: string }
  | { type: 'workflow_event'; workflowId: string; nodeId?: string; eventType: string; payload?: unknown }
  | { type: 'stream_error'; message: string; recoverable: boolean; info?: SuanliziErrorInfo };

// 验证通过的模型输出：返回 ok=true 及 items
export interface ValidatedModelOutput {
  ok: true;
  items: ModelOutputItem[];
}

// 被拒绝的模型输出：返回 ok=false 及错误对象
export interface RejectedModelOutput {
  ok: false;
  error: SuanliziRuntimeError;
}

// 校验模型输出：防止工具协议文本泄漏到 assistant 内容中，检查 tool_call 与 tool_result 的 callId 是否配对，检查 workflow_event 必备字段
export function validateModelOutputItems(items: ModelOutputItem[]): ValidatedModelOutput | RejectedModelOutput {
  const toolCalls = new Set<string>();
  const toolResults = new Set<string>();
  for (const item of items) {
    if ((item.type === 'assistant_message_final' || item.type === 'assistant_message_delta') && leaksToolProtocol(item.type === 'assistant_message_final' ? item.text : item.delta)) {
      return rejected('Model output leaked tool-call protocol text into assistant content');
    }
    if (item.type === 'tool_call') {
      if (!item.callId.trim()) return rejected('Tool call is missing a call id');
      toolCalls.add(item.callId);
    }
    if (item.type === 'tool_result') {
      if (!item.callId.trim()) return rejected('Tool result is missing a call id');
      if (!toolCalls.has(item.callId)) return rejected(`orphan tool result without matching tool call: ${item.callId}`);
      toolResults.add(item.callId);
    }
    if (item.type === 'workflow_event' && (!item.workflowId.trim() || !item.eventType.trim())) {
      return rejected('Workflow event is missing workflowId or eventType');
    }
  }
  for (const callId of toolResults) {
    if (!toolCalls.has(callId)) return rejected(`orphan tool result without matching tool call: ${callId}`);
  }
  return { ok: true, items };
}

// 将 thread item（如 agent_message / reasoning）转换成 model 输出项，统一做持久化前的校验
export function validateThreadItemsForPersistence(items: ThreadItem[]): ValidatedModelOutput | RejectedModelOutput {
  return validateModelOutputItems(items.flatMap((item): ModelOutputItem[] => {
    if (item.type === 'agent_message') {
      return [{ type: 'assistant_message_final', itemId: item.id, turnId: item.turnId, text: item.text }];
    }
    if (item.type === 'reasoning') {
      return [{ type: 'reasoning', itemId: item.id, turnId: item.turnId, text: item.text }];
    }
    return [];
  }));
}

const TRANSCRIPT_TOOL_NAMES = [
  'apply_patch',
  'list_files',
  'open_file',
  'read_file',
  'run_command',
  'search_content',
  'search_files',
  'shell_command',
  'write_file',
];

// 判断内容是否泄漏了工具协议文本：匹配 <|...|> 标签、DSML、JSON tool_calls、function_call、
// [Tool xxx] 以及 Gitee 压平历史消息时使用的 [工具调用]/[工具结果] 记录。
// 这些文本不是用户可见回答；一旦进入 assistant 内容，后续上下文会把它当成
// 普通对话继续回显，必须在 runtime 边界拒绝并触发一次结构化重试。
export function leaksToolProtocol(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  const normalizedTaggedText = trimmed
    .replace(/｜/g, '|')
    .replace(/\s+/g, '')
    .toLowerCase();
  const hasTaggedToolSyntax = /<\|+(?:dsml\|+)?(?:tool_calls|invoke|parameter)/.test(normalizedTaggedText)
    || /<\|+.*(?:tool_calls|invoke|parameter)/.test(normalizedTaggedText)
    || /dsml\|+.*(?:tool_calls|invoke|parameter)/.test(normalizedTaggedText);
  const hasJsonToolSyntax = /"tool_calls"\s*:/.test(trimmed)
    || /"function_call"\s*:/.test(trimmed)
    || /"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/.test(trimmed);
  const hasToolTranscript = leaksTextToolTranscript(trimmed);
  const hasGiteeToolTranscript = leaksGiteeToolTranscript(trimmed);
  return /\[(?:Tool|tool)\s+[\w.-]+(?:\s+(?:completed|failed|running|pending))?\]/.test(trimmed)
    || /\[(?:调用|call)\s+[\w.-]+\]\s*(?:\{|\[|$)/i.test(trimmed)
    || /^工具调用\s*[:：]\s*[\w.-]+\s*$/i.test(trimmed)
    || hasGiteeToolTranscript
    || hasTaggedToolSyntax
    || hasJsonToolSyntax
    || hasToolTranscript;
}

function leaksGiteeToolTranscript(text: string): boolean {
  // Gitee 的 OpenAI 兼容接口要求把历史 tool_calls 压成普通 assistant 文本；
  // 部分模型会把这段协议原样回显。兼容单行和多行、中文/英文字段名。
  return /\[工具调用\]|\[工具结果(?:\s*[:：][^\]\r\n]*)?\]/i.test(text)
    && /(?:名称|name)\s*[:：]\s*[\w./:-]+/i.test(text)
    && /(?:参数|arguments?|args)\s*[:：]/i.test(text);
}

// 构造一个拒绝响应：统一使用 BadRequest 类型的错误
function rejected(message: string): RejectedModelOutput {
  return {
    ok: false,
    error: new SuanliziRuntimeError(message, { kind: 'BadRequest' }),
  };
}

function leaksTextToolTranscript(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;

  const toolNamePattern = TRANSCRIPT_TOOL_NAMES.map(escapeRegExp).join('|');
  const toolLine = new RegExp(`^(?:${toolNamePattern})(?:\\s|$)`, 'i');
  for (let index = 0; index < lines.length; index++) {
    if (!toolLine.test(lines[index])) continue;
    const window = lines.slice(index, index + 5);
    const hasCompletion = window.some((line) => /^(?:完成|done|success|succeeded|failed|error)$/i.test(line));
    const hasArgumentLikeLine = window.slice(1).some((line) => (
      /^[A-Za-z]:[\\/]/.test(line)
      || /[\\/].+\.[A-Za-z0-9]{1,8}$/.test(line)
      || /^[\w.-]+\s*[:=]\s*.+/.test(line)
      || /^".*"$/.test(line)
    ));
    if (hasCompletion && hasArgumentLikeLine) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
