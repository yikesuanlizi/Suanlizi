import { describe, expect, it } from 'vitest';
import {
  threadEventSchema,
  taskRuntimeUpdatedEventSchema,
  taskCognitionUpdatedEventSchema,
  taskContextUpdatedEventSchema,
  taskLoopUpdatedEventSchema,
} from './schemas.js';
import { taskEventNameSchema, taskTransitionEventSchema } from './task.js';
import type { ThreadEvent } from './types.js';

describe('Task Runtime 事件 schema（第 2 步骨架）', () => {
  it('task.runtime.updated 通过 threadEventSchema 解析', () => {
    const event = {
      type: 'task.runtime.updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'before_turn',
      status: 'running',
      runProfile: 'runtime_os',
      timestamp: new Date().toISOString(),
    };
    expect(threadEventSchema.parse(event)).toEqual(event);
    expect(taskRuntimeUpdatedEventSchema.parse(event)).toEqual(event);
  });

  it('task.cognition.updated 通过 threadEventSchema 解析', () => {
    const event = {
      type: 'task.cognition.updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      cognition: {
        goal: '介绍航空保障包',
        constraints: ['必须基于现有资料'],
        knownFacts: ['扩展包用于补充能力'],
        unknowns: [],
        risks: [],
        confidence: 0.7,
        verificationCriteria: ['说明用途'],
      },
      timestamp: new Date().toISOString(),
    };
    expect(threadEventSchema.parse(event)).toEqual(event);
    expect(taskCognitionUpdatedEventSchema.parse(event)).toEqual(event);
  });

  it('task.context.updated 只接收 metadata，不接收完整 chunk content', () => {
    const event = {
      type: 'task.context.updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      chunks: [
        {
          id: 'chunk-task-1',
          source: 'task-context-provider',
          tokens: 120,
          priority: 10,
          truncated: false,
          summary: '当前任务认知摘要',
        },
      ],
      usedTokens: 120,
      remainingTokens: 7880,
      timestamp: new Date().toISOString(),
    };
    const parsed = taskContextUpdatedEventSchema.parse(event);
    expect(parsed.chunks[0]).not.toHaveProperty('content');
    // chunk 字段中不应有 content / prompt 等敏感字段
    expect(JSON.stringify(parsed)).not.toContain('prompt');
    expect(JSON.stringify(parsed)).not.toContain('content');
    // 通过总 schema 也能解析
    expect(threadEventSchema.parse(event)).toEqual(event);
  });

  it('task.loop.updated 兼容 harness continuation 状态', () => {
    const event = {
      type: 'task.loop.updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      loopId: 'harness-run-001',
      iteration: 2,
      maxIterations: 8,
      noProgressCount: 0,
      continuationReason: 'continue',
      status: 'active',
      timestamp: new Date().toISOString(),
    };
    expect(threadEventSchema.parse(event)).toEqual(event);
    expect(taskLoopUpdatedEventSchema.parse(event)).toEqual(event);
  });

  it('拒绝缺少必填字段的事件', () => {
    expect(() => taskRuntimeUpdatedEventSchema.parse({ type: 'task.runtime.updated' })).toThrow();
    expect(() => taskCognitionUpdatedEventSchema.parse({ type: 'task.cognition.updated', threadId: 't' })).toThrow();
  });
});

// P2 生命周期端点向所属 thread 发 task.run.updated / task.run.terminal 事件（计划 §9.3）。
// 事件名逐字取自 TASK_EVENT_NAMES（不发明新名），payload（taskId/runId/status/reason）过
// task.ts 冻结的 taskTransitionEventSchema 校验；两个接口已并入 ThreadEvent union，可直接作为
// publishEvent 的实参类型。此处不重复定义 zod schema（§9.3「复用现有 ThreadEvent 通道」），
// 仅锁定事件名与 payload 契约，防止路由侧与协议漂移。
// — Chinese: P2 lifecycle events reuse the frozen TASK_EVENT_NAMES + transition payload contract.
describe('Task run 生命周期事件兼容（计划 §9.3）', () => {
  it('task.run.updated / task.run.terminal 是合法 TASK_EVENT_NAMES', () => {
    expect(taskEventNameSchema.parse('task.run.updated')).toBe('task.run.updated');
    expect(taskEventNameSchema.parse('task.run.terminal')).toBe('task.run.terminal');
    // 未知事件名必须被拒，确保端点不会发明新事件名。
    expect(() => taskEventNameSchema.parse('task.run.pausing')).toThrow();
  });

  it('生命周期事件 payload 过 taskTransitionEventSchema 兼容校验', () => {
    const payload = {
      event: 'task.run.terminal' as const,
      taskId: 'task_1',
      threadId: 'thread-1',
      runId: 'run_1',
      reason: 'user cancel',
      occurredAt: new Date().toISOString(),
    };
    expect(taskTransitionEventSchema.parse(payload)).toEqual(payload);
  });

  it('两个新事件接口已并入 ThreadEvent union（类型级兼容）', () => {
    const timestamp = new Date().toISOString();
    const updated: ThreadEvent = {
      type: 'task.run.updated',
      threadId: 'thread-1',
      taskId: 'task_1',
      runId: 'run_1',
      status: 'running',
      timestamp,
    };
    const terminal: ThreadEvent = {
      type: 'task.run.terminal',
      threadId: 'thread-1',
      taskId: 'task_1',
      runId: 'run_1',
      status: 'cancelled',
      reason: 'redirect',
      timestamp,
    };
    expect(updated.type).toBe('task.run.updated');
    expect(terminal.type).toBe('task.run.terminal');
  });
});
