import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDecisionRequest } from '@suanlizi/protocol';
import { AgentDecisionCard } from './AgentDecisionCard.js';

const request: AgentDecisionRequest = {
  requestId: 'decision-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  prompt: '请选择执行方案',
  options: [
    { id: 'one', action: 'way_one', label: '方式一', description: '快速处理' },
    { id: 'two', action: 'way_two', label: '方式二', description: '完整处理' },
  ],
  allowCustomInput: true,
  createdAt: '2026-08-23T00:00:00.000Z',
  status: 'pending',
};

const here = dirname(fileURLToPath(import.meta.url));

describe('AgentDecisionCard', () => {
  it('renders independent decision controls and custom input affordance', () => {
    const html = renderToStaticMarkup(<AgentDecisionCard request={request} locale="zh" onSubmit={vi.fn()} />);
    expect(html).toContain('agentDecisionCard');
    expect(html).toContain('方式一');
    expect(html).toContain('方式二');
    expect(html).toContain('自定义输入');
    expect(html).toContain('取消此次选择/拒绝并继续');
    expect(html).toContain('确认并继续');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('approvalPanel');
  });

  it('keeps option clicks as selection-only and uses one bottom confirmation', () => {
    const source = readFileSync(join(here, 'AgentDecisionCard.tsx'), 'utf-8');
    expect(source).not.toContain("if (option.action !== 'custom_input') void submit");
    expect(source).toContain('aria-pressed={selectedOptionId === option.id}');
    expect(source).toContain("{zh ? '取消此次选择/拒绝并继续' : 'Decline and continue'}");
    expect(source).toContain("{zh ? '确认并继续' : 'Confirm and continue'}");
    expect(source).not.toContain("onClick={() => void submit('custom_input')}");
  });
});
