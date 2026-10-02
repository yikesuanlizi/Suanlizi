// Run 历史（只读）：展示任务的各次执行 Run 的过程态、类型与更新时间；标注当前 Run。
// Read-only run history: process state, kind and updated time per run; marks the current run.
import React from 'react';
import type { TaskRun } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { formatTimestamp } from '../../shared/i18n.js';
import { getRunStateView } from '../../features/tasks/taskCenterModel.js';
import { StatusBadge } from './StatusBadge.js';
import { styles, toneColor } from './taskStyles.js';

export interface TaskRunHistoryProps {
  locale: Locale;
  runs: readonly TaskRun[];
  currentRunId?: string;
}

function runKindLabel(kind: TaskRun['kind'], workflowKind: TaskRun['workflowKind'], locale: Locale): string {
  if (kind === 'goal') return locale === 'en' ? 'Goal run' : '目标续跑';
  if (workflowKind === 'script') return locale === 'en' ? 'Workflow (script)' : '工作流（脚本）';
  if (workflowKind === 'blueprint') return locale === 'en' ? 'Workflow (blueprint)' : '工作流（蓝图）';
  return locale === 'en' ? 'Workflow run' : '工作流执行';
}

export function TaskRunHistory({ locale, runs, currentRunId }: TaskRunHistoryProps) {
  if (!runs.length) {
    return (
      <div style={{ ...styles.faint, fontSize: 12 }}>
        {locale === 'en' ? 'No runs recorded yet' : '尚无执行记录'}
      </div>
    );
  }
  const sorted = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div>
      {sorted.map((run) => {
        const view = getRunStateView(run.status, locale);
        const isCurrent = run.id === currentRunId;
        return (
          <div key={run.id} style={styles.runRow}>
            <div style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 500, color: 'var(--nx-text)' }}>
                {runKindLabel(run.kind, run.workflowKind, locale)}
              </span>
              {isCurrent ? (
                <span style={{ ...styles.faint, fontSize: 11, marginLeft: 6 }}>
                  {locale === 'en' ? '(current)' : '（当前）'}
                </span>
              ) : null}
              <div style={{ ...styles.time }} title={run.error ?? undefined}>
                {run.error
                  ? <span style={{ color: toneColor.danger }}>{run.error}</span>
                  : formatTimestamp(run.updatedAt, locale)}
              </div>
            </div>
            <StatusBadge view={view} />
          </div>
        );
      })}
    </div>
  );
}
