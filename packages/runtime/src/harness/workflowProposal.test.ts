// P6：GoalRun → Workflow 提案链路测试（计划 §12.1）。
// 覆盖：```workflow 围栏提取（合法 / 非法 JSON / 未闭合 / 静态校验失败）、
// harness 集成（提案 → onRequest 回调 → GoalRun blocked 收口、onRequest 抛错 fail-closed、
// 未注入 workflow 选项时行为零变化）。
//
// — Chinese: P6 workflow proposal extraction + harness integration tests.

import { describe, expect, it, vi } from 'vitest';
import type { ThreadId, ThreadItem, ThreadMeta } from '@suanlizi/protocol';
import {
  TaskHarnessEngine,
  type HarnessAgentLoop,
} from './taskHarness.js';
import {
  extractWorkflowProposal,
  WORKFLOW_PROPOSAL_BLOCK_LANGUAGE,
} from './workflowProposal.js';
import { DEFAULT_HARNESS_CONFIG } from './types.js';

// ─── 工具 ────────────────────────────────────────────────────────────────────

const VALID_SCRIPT = [
  'export const meta = { name: "demo", description: "demo flow", phases: ["p1"] };',
  'phase("p1");',
  'const found = await agent("list files", { label: "lister" });',
  'return { files: found.files };',
].join('\n');

function proposalText(json: string): string {
  return `好的，我先提交一个编排提案。\n\`\`\`${WORKFLOW_PROPOSAL_BLOCK_LANGUAGE}\n${json}\n\`\`\`\n请批准。`;
}

function agentMessage(text: string): ThreadItem[] {
  return [{
    id: 'item_proposal',
    type: 'agent_message',
    turnId: 'turn_proposal',
    text,
    status: 'completed',
    timestamp: new Date().toISOString(),
  } as unknown as ThreadItem];
}

const CTX = { taskId: 'task-1', goalRunId: 'goalrun-1' };

class FakeHarnessStore {
  tags: Record<string, string> = {};

  async getThread(threadId: ThreadId): Promise<ThreadMeta> {
    return {
      threadId,
      title: 'Workflow proposal test',
      workspaceRoot: '',
      status: 'active' as const,
      turnCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      ephemeral: false,
      tags: this.tags,
    };
  }

  async updateThreadMetadata(_threadId: ThreadId, patch: { tags?: Record<string, string> }) {
    this.tags = patch.tags ?? this.tags;
  }

  async getRecentItems() {
    return [];
  }

  async getItems() {
    return [];
  }

  async getCompactionSummary() {
    return null;
  }
}

// ─── extractWorkflowProposal ─────────────────────────────────────────────────

describe('extractWorkflowProposal', () => {
  it('合法提案 → 返回补齐 taskId/goalRunId/limits 的 WorkflowScriptRequest', () => {
    const extraction = extractWorkflowProposal(
      agentMessage(proposalText(JSON.stringify({
        objective: '批量整理文件',
        script: VALID_SCRIPT,
        estimatedAgents: 8,
        estimatedTokens: 120000,
      }))),
      CTX,
    );
    expect(extraction.error).toBeUndefined();
    expect(extraction.request).not.toBeNull();
    expect(extraction.request?.taskId).toBe('task-1');
    expect(extraction.request?.goalRunId).toBe('goalrun-1');
    expect(extraction.request?.objective).toBe('批量整理文件');
    expect(extraction.request?.proposedScript).toBe(VALID_SCRIPT);
    expect(extraction.request?.estimatedAgents).toBe(8);
    expect(extraction.request?.estimatedTokens).toBe(120000);
    expect(extraction.request?.limits.maxAgentsPerRun).toBeGreaterThan(0);
  });

  it('无提案块 / 无 agent_message → request 为 null 且无 error', () => {
    expect(extractWorkflowProposal([], CTX).request).toBeNull();
    expect(extractWorkflowProposal(agentMessage('普通回复，没有提案。'), CTX).request).toBeNull();
  });

  it('非法 JSON / 缺字段 / 未闭合 / 脚本不合法 → fail-closed 携带 error', () => {
    const notJson = extractWorkflowProposal(agentMessage(proposalText('{not json')), CTX);
    expect(notJson.request).toBeNull();
    expect(notJson.error).toContain('not valid JSON');

    const noObjective = extractWorkflowProposal(
      agentMessage(proposalText(JSON.stringify({ script: VALID_SCRIPT }))),
      CTX,
    );
    expect(noObjective.error).toContain('objective');

    const badScript = extractWorkflowProposal(
      agentMessage(proposalText(JSON.stringify({ objective: 'x', script: "import fs from 'node:fs';\nreturn {};" }))),
      CTX,
    );
    expect(badScript.error).toContain('static validation');

    const unclosed = extractWorkflowProposal(
      agentMessage(`\`\`\`${WORKFLOW_PROPOSAL_BLOCK_LANGUAGE}\n{"objective":"x","script":"y"}`),
      CTX,
    );
    expect(unclosed.error).toContain('not closed');
  });
});

// ─── TaskHarnessEngine 集成 ──────────────────────────────────────────────────

function makeEngine(agentLoop: HarnessAgentLoop, store: FakeHarnessStore) {
  const model = {
    completeOnce: vi.fn(async () => JSON.stringify({
      satisfied: false,
      status: 'continue',
      passedCriteria: [],
      failedCriteria: ['目标未达成'],
      evidenceSummary: '',
      reasoning: 'keep going',
      progressSignature: `sig-${Math.random()}`,
      criteriaEvidenceMap: {},
    })),
  };
  const engine = new TaskHarnessEngine(
    agentLoop,
    model,
    store,
    { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 5 },
  );
  return { engine, model };
}

describe('TaskHarnessEngine × Workflow 提案（P6）', () => {
  it('turn 输出携带提案 → onRequest 回调收到请求，GoalRun 收口为 blocked，不再评估', async () => {
    const store = new FakeHarnessStore();
    const onRequest = vi.fn(async (_request: unknown) => {});
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => ({
        items: agentMessage(proposalText(JSON.stringify({
          objective: '批量整理文件',
          script: VALID_SCRIPT,
          estimatedAgents: 4,
          estimatedTokens: 80000,
        }))),
        usage: null,
      })),
    };
    const { engine, model } = makeEngine(agentLoop, store);

    const result = await engine.runHarness(
      'thread-wf-proposal',
      { type: 'text', text: '批量整理文件' },
      {
        acceptanceCriteria: ['批量整理文件'],
        maxContinuations: 5,
        harnessRunId: 'hrun-wf-1',
        workflow: { taskId: 'task-1', goalRunId: 'goalrun-1', onRequest },
      },
    );

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest.mock.calls[0]?.[0]).toMatchObject({
      taskId: 'task-1',
      goalRunId: 'goalrun-1',
      objective: '批量整理文件',
    });
    expect(result.status).toBe('blocked');
    expect(model.completeOnce).not.toHaveBeenCalled();
    expect(agentLoop.runTurn).toHaveBeenCalledTimes(1);
    expect(store.tags['activeHarnessRunId']).toBe('');
  });

  it('onRequest 抛错 → fail-closed：仍落 blocked 终态，不静默吞掉请求', async () => {
    const store = new FakeHarnessStore();
    const onRequest = vi.fn(async () => {
      throw new Error('WORKFLOW_LIMIT_EXCEEDED: budget reached');
    });
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => ({
        items: agentMessage(proposalText(JSON.stringify({ objective: 'x', script: VALID_SCRIPT }))),
        usage: null,
      })),
    };
    const { engine, model } = makeEngine(agentLoop, store);

    const result = await engine.runHarness(
      'thread-wf-proposal-reject',
      { type: 'text', text: '批量整理文件' },
      {
        acceptanceCriteria: ['批量整理文件'],
        maxContinuations: 5,
        harnessRunId: 'hrun-wf-2',
        workflow: { taskId: 'task-1', goalRunId: 'goalrun-1', onRequest },
      },
    );

    expect(result.status).toBe('blocked');
    expect(model.completeOnce).not.toHaveBeenCalled();
    expect(store.tags['activeHarnessRunId']).toBe('');
  });

  it('未注入 workflow 选项 → 行为零变化（不阻断、不注入提案提示）', async () => {
    const store = new FakeHarnessStore();
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => ({
        items: agentMessage(proposalText(JSON.stringify({ objective: 'x', script: VALID_SCRIPT }))),
        usage: null,
      })),
    };
    const { engine, model } = makeEngine(agentLoop, store);

    const result = await engine.runHarness(
      'thread-wf-proposal-off',
      { type: 'text', text: '批量整理文件' },
      {
        acceptanceCriteria: ['批量整理文件'],
        maxContinuations: 5,
        harnessRunId: 'hrun-wf-3',
      },
    );

    // 无 workflow 选项时提案块只是普通文本，循环继续走到评估。
    expect(model.completeOnce).toHaveBeenCalled();
    expect(result.status).not.toBe('blocked');
  });

  it('续跑输入在配置 workflow 时附加提案提示；未配置时不附加', async () => {
    const store = new FakeHarnessStore();
    const seenInputs: string[] = [];
    let calls = 0;
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async (_threadId: ThreadId, input: { type: string; text?: string }) => {
        seenInputs.push(input.text ?? '');
        calls += 1;
        if (calls >= 2) {
          return {
            items: agentMessage(JSON.stringify({
              satisfied: true,
              status: 'satisfied',
              passedCriteria: ['批量整理文件'],
              failedCriteria: [],
              evidenceSummary: 'done',
              reasoning: 'ok',
              criteriaEvidenceMap: {},
            })),
            usage: null,
          };
        }
        return { items: agentMessage('第一步完成。'), usage: null };
      }),
    };
    const model = {
      completeOnce: vi.fn(async () => JSON.stringify({
        satisfied: false,
        status: 'continue',
        passedCriteria: [],
        failedCriteria: ['目标未达成'],
        evidenceSummary: '',
        reasoning: 'keep going',
        progressSignature: `sig-${Math.random()}`,
        criteriaEvidenceMap: {},
      })),
    };
    const engine = new TaskHarnessEngine(
      agentLoop,
      model,
      store,
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 5 },
    );

    await engine.runHarness(
      'thread-wf-hint-on',
      { type: 'text', text: '批量整理文件' },
      {
        acceptanceCriteria: ['批量整理文件'],
        maxContinuations: 5,
        harnessRunId: 'hrun-wf-4',
        workflow: { taskId: 'task-1', goalRunId: 'goalrun-1', onRequest: async () => {} },
      },
    );
    expect(seenInputs[1]).toContain('workflow');

    // 未配置 workflow 的续跑输入不含提示。
    calls = 0;
    seenInputs.length = 0;
    await engine.runHarness(
      'thread-wf-hint-off',
      { type: 'text', text: '批量整理文件' },
      { acceptanceCriteria: ['批量整理文件'], maxContinuations: 5, harnessRunId: 'hrun-wf-5' },
    );
    expect(seenInputs[1]).not.toContain('[workflow]');
  });
});
