import { createHash } from 'node:crypto';
import type { ChatMessage, ToolDefinition } from '@suanlizi/model-gateway';

// 提示词缓存形状描述：用于判断两次模型调用的 system prompt / tool schema 是否稳定
export interface PromptCacheShape {
  systemHash: string;
  // systemHash：system prompt 内容的稳定哈希值
  toolsHash: string;
  // toolsHash：工具 schema 的稳定哈希值
  prefixHash: string;
  // prefixHash：以上两者拼接后的哈希值，用于快速对比
}

// 构建一个 PromptCacheShape：提取 system message、工具定义并分别哈希
export function buildPromptCacheShape(
  messages: Pick<ChatMessage, 'role' | 'content'>[],
  tools: ToolDefinition[],
): PromptCacheShape {
  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content);
  const systemHash = sha256(stableStringify(systemMessages));
  const toolsHash = sha256(stableStringify(tools));
  return {
    systemHash,
    toolsHash,
    prefixHash: sha256(`${systemHash}:${toolsHash}`),
  };
}

// 对比两次 PromptCacheShape：返回是否稳定以及变化的原因（system 或 tools）
export function comparePromptCacheShape(
  previous: PromptCacheShape | undefined,
  next: PromptCacheShape,
): { stable: boolean; reasons: Array<'system' | 'tools'> } {
  if (!previous) return { stable: true, reasons: [] };
  const reasons: Array<'system' | 'tools'> = [];
  if (previous.systemHash !== next.systemHash) reasons.push('system');
  if (previous.toolsHash !== next.toolsHash) reasons.push('tools');
  return { stable: reasons.length === 0, reasons };
}

// 内部工具：计算字符串 sha256 十六进制摘要
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// 内部工具：按属性名排序后序列化对象，保证相同语义得到相同字符串
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}
