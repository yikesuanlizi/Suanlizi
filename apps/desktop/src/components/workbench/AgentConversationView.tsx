// Agent 对话详情视图：右侧智能体 tab 的详情层（卡片视图二选一，互斥显示）
// 只读展示：指令（可折叠）、timeline（工具调用/回复/状态），Header 提供返回卡片按钮。
// — Chinese: agent conversation detail view for the right agents tab — read-only
//   collapsible instruction + timeline, with a back-to-cards button in the header.

import { useState } from 'react';
import type { ThreadItem } from '../../shared/types.js';
import type { Locale } from '../../config/config.js';
import type { AgentWorkbenchNode } from '../../features/agents/agentWorkbenchModel.js';
import { formatDuration } from '../../features/monitor/traceFormatters.js';
import { isChildActivityItem } from '../../features/agents/subagentActivity.js';
import { ItemView } from '../ItemView.js';

const STATUS_LABELS: Record<string, { zh: string; en: string }> = {
  idle: { zh: '空闲', en: 'Idle' },
  queued: { zh: '排队中', en: 'Queued' },
  running: { zh: '运行中', en: 'Running' },
  waiting: { zh: '等待中', en: 'Waiting' },
  waiting_user_input: { zh: '等待输入', en: 'Waiting for input' },
  completed: { zh: '已完成', en: 'Completed' },
  closed: { zh: '已关闭', en: 'Closed' },
  failed: { zh: '失败', en: 'Failed' },
  interrupted: { zh: '已中断', en: 'Interrupted' },
  stale: { zh: '已过期', en: 'Stale' },
};

export function AgentConversationView({
  node,
  items,
  instruction,
  locale,
  onBack,
}: {
  node: AgentWorkbenchNode;
  items: ThreadItem[];
  /** 委派给该 agent 的指令文本（主 agent 可为空） */
  instruction?: string;
  locale: Locale;
  onBack(): void;
}) {
  const zh = locale === 'zh';
  const timeline = items.filter(isChildActivityItem);
  const statusLabel = STATUS_LABELS[node.status]?.[zh ? 'zh' : 'en'] ?? node.status;
  const instructionText = instruction?.trim();
  // 指令默认折叠为一行摘要，点击展开完整内容——长指令不该霸占详情页首屏。
  // — Chinese: the instruction folds to a one-line summary by default.
  const [instructionOpen, setInstructionOpen] = useState(false);
  const instructionOneLine = instructionText ? instructionText.replace(/\s+/g, ' ') : '';

  return (
    <div className="agentDetailView">
      <header className="agentDetailHeader">
        <button
          type="button"
          className="agentDetailBack"
          onClick={onBack}
          title={zh ? '返回卡片视图' : 'Back to cards'}
          aria-label={zh ? '返回卡片视图' : 'Back to cards'}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M7.5 3L4.5 6L7.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{zh ? '返回卡片' : 'Back'}</span>
        </button>
        <div className="agentDetailTitle">
          <span className="agentStatusDot" data-status={node.status} aria-hidden="true" />
          <div className="agentDetailNameWrap">
            <strong>{node.role}</strong>
            {node.roleDetail ? <span className="agentDetailRoleDetail">{node.roleDetail}</span> : null}
          </div>
          <span className={`agentDetailStatusBadge status-${node.status}`}>{statusLabel}</span>
        </div>
        {node.elapsedMs != null ? <span className="agentDetailElapsed">{formatDuration(node.elapsedMs)}</span> : null}
      </header>

      {instructionText ? (
        <section className={`agentDetailInstruction${instructionOpen ? ' open' : ''}`} aria-label={zh ? '指令' : 'Instruction'}>
          <button
            type="button"
            className="agentDetailInstructionToggle"
            aria-expanded={instructionOpen}
            onClick={() => setInstructionOpen((current) => !current)}
          >
            <span className="agentDetailInstructionLabel">{zh ? '指令' : 'Instruction'}</span>
            <span className="agentDetailInstructionSummary" title={instructionOneLine}>
              {instructionOpen ? '' : instructionOneLine.slice(0, 80) || instructionOneLine}
            </span>
            <span className={`agentDetailInstructionChevron${instructionOpen ? ' open' : ''}`} aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
          {instructionOpen ? <blockquote>{instructionText}</blockquote> : null}
        </section>
      ) : null}

      <div className="agentDetailTimeline" role="log" aria-label={zh ? 'Agent 活动时间线' : 'Agent activity timeline'}>
        {timeline.length === 0 ? (
          <div className="agentDetailTimelineEmpty">
            <p>{zh ? '暂无活动记录' : 'No activity yet'}</p>
            <span>{zh ? '该 Agent 的工具调用与回复会实时显示在这里' : 'Tool calls and replies from this agent will appear here live'}</span>
          </div>
        ) : timeline.map((item) => (
          <ItemView item={item} key={item.id} locale={locale} />
        ))}
      </div>

      <footer className="agentDetailFooter">
        <span>{zh ? '工具调用' : 'Tools'} <strong>{node.toolCalls}</strong></span>
        {node.tokens > 0 ? <span>Token <strong>{node.tokens.toLocaleString()}</strong></span> : null}
        <span>{zh ? '更新于' : 'Updated'} <strong>{node.updatedAt ? new Date(node.updatedAt).toLocaleTimeString() : '—'}</strong></span>
      </footer>
    </div>
  );
}
