// 死循环检测：StormBreaker
// 借鉴 Reasonix applyStormBreaker：签名检测 + 连续阻塞检测。
//
// 检测规则：
// 1. 签名检测: (toolName, errorMessage) 组合连续命中 threshold 次触发
// 2. 连续阻塞检测: blockedTurnStreak 连续 blockedThreshold 次触发
// 命中后生成 instruction: "You appear to be stuck repeating the same action..."

import type { ThreadItem } from '@suanlizi/protocol';
import type { StormBreakerResult } from './types.js';

// 签名键：toolName + errorMessage 组合
function signatureKey(toolName: string | undefined, errorMessage: string | undefined): string {
  return `${toolName ?? ''}::${errorMessage ?? ''}`;
}

// 从一组 items 提取本轮签名（取最后一个 error / failed tool）
function extractSignature(items: ThreadItem[]): string {
  let lastTool: string | undefined;
  let lastError: string | undefined;

  for (const item of items) {
    if (item.type === 'tool_call' || item.type === 'mcp_tool_call') {
      const toolName = item.type === 'tool_call' ? item.toolName : `${item.server}:${item.tool}`;
      lastTool = toolName;
      if (item.status === 'failed') {
        lastError = item.error?.message ?? 'failed';
      }
    }
    if (item.type === 'command_execution' && item.status === 'failed') {
      lastTool = `command:${item.command}`;
      lastError = `exit:${item.exitCode ?? '?'}`;
    }
    if (item.type === 'error') {
      lastError = item.message;
    }
  }
  return signatureKey(lastTool, lastError);
}

export class StormBreaker {
  // signature → 连续命中次数
  private signatures: Map<string, number> = new Map();
  // 连续 blocked 次数
  private blockedStreak: number = 0;
  // 最近一次签名（用于检测连续相同签名）
  private lastSignature: string | null = null;
  private readonly threshold: number;
  private readonly blockedThreshold: number;

  constructor(options?: { threshold?: number; blockedThreshold?: number }) {
    this.threshold = options?.threshold ?? 5;
    this.blockedThreshold = options?.blockedThreshold ?? 3;
  }

  /**
   * 每轮工具执行后调用。
   * 检测本轮 items 是否触发 storm breaker。
   */
  check(items: ThreadItem[]): StormBreakerResult {
    const sig = extractSignature(items);

    // 签名检测：与上次相同签名才累加
    if (sig === this.lastSignature && sig !== signatureKey(undefined, undefined)) {
      const count = (this.signatures.get(sig) ?? 0) + 1;
      this.signatures.set(sig, count);
      if (count >= this.threshold) {
        return {
          triggered: true,
          reason: `signature_hit: ${sig} (连续 ${count} 次)`,
          signature: sig,
          instruction:
            'You appear to be stuck repeating the same action. Change your approach and try a different strategy. Do not retry the exact same tool call or command.',
        };
      }
    } else {
      // 新签名，重置该签名的计数（保留其他签名历史）
      if (sig !== signatureKey(undefined, undefined)) {
        this.signatures.set(sig, 1);
      }
    }
    this.lastSignature = sig;

    // 连续阻塞检测：本轮无任何成功工具调用则累加
    const hasAnySuccess = items.some(
      (i) =>
        (i.type === 'tool_call' || i.type === 'mcp_tool_call' || i.type === 'command_execution') &&
        i.status === 'completed',
    );
    const hasAnyFailure = items.some(
      (i) =>
        (i.type === 'tool_call' || i.type === 'mcp_tool_call' || i.type === 'command_execution') &&
        i.status === 'failed',
    );
    if (!hasAnySuccess && hasAnyFailure) {
      this.blockedStreak += 1;
      if (this.blockedStreak >= this.blockedThreshold) {
        return {
          triggered: true,
          reason: `blocked_streak: 连续 ${this.blockedStreak} 轮无成功工具调用`,
          instruction:
            'You have been blocked for multiple turns. Reconsider the goal, break down the task differently, or ask for user input.',
        };
      }
    } else {
      this.blockedStreak = 0;
    }

    return { triggered: false };
  }

  /**
   * 重置所有计数器（harness run 结束或 evaluator 判定 satisfied 时调用）。
   */
  reset(): void {
    this.signatures.clear();
    this.blockedStreak = 0;
    this.lastSignature = null;
  }

  /** 仅供测试：查看某签名的当前计数。 */
  getSignatureCount(sig: string): number {
    return this.signatures.get(sig) ?? 0;
  }

  /** 仅供测试：查看连续阻塞次数。 */
  getBlockedStreak(): number {
    return this.blockedStreak;
  }
}
