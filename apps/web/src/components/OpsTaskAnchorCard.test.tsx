import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OpsTaskSession } from '@suanlizi/protocol';
import { OpsTaskAnchorCard } from './OpsTaskAnchorCard.js';

const task: OpsTaskSession = {
  spec: {
    taskId: 'ops-web-1', threadId: 'thread-web', presetId: 'ops', workspaceRoot: 'D:\\suanlizi', environmentId: 'local',
    target: { hostIds: ['local'] }, policyProfile: 'ops_readonly',
    budgets: { maxAdapterCalls: 10, maxConcurrentCalls: 1, maxOutputBytes: 1000, maxWallTimeMs: 1000 },
    acceptanceCriteria: ['inspect'], allowLocalPatchProposal: false, allowLocalTest: false,
  },
  state: 'waiting_confirmation', currentPhase: 'verify', hypothesisIds: [], evidenceIds: [], checkpointSequence: 0, taskVersion: 2, sequence: 4,
};

describe('web Ops task anchor', () => {
  it('renders a confirmation action in the main conversation surface', () => {
    const html = renderToStaticMarkup(<OpsTaskAnchorCard locale="zh" task={task} onAction={vi.fn()} />);
    expect(html).toContain('运维任务 ops-web-1');
    expect(html).toContain('确认并验证');
    expect(html).toContain('拒绝并继续调查');
  });
});
