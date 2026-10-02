// 计划步骤时间线（只读）：按当前计划渲染步骤、状态徽章与 claimed「待补证据」标注。
// Read-only plan-step timeline for the current plan projection.
import React from 'react';
import type { TaskPlanVersion } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import {
  getStepEvidenceHint,
  getStepStatusView,
} from '../../features/tasks/taskCenterModel.js';
import { StatusBadge } from './StatusBadge.js';
import { styles, toneColor } from './taskStyles.js';

export interface TaskPlanTimelineProps {
  locale: Locale;
  plan?: TaskPlanVersion | null;
  /** P0 plan-history 恒为不完整：可给出轻量提示，但不伪造历史版本。 */
  historyIncomplete?: boolean;
}

export function TaskPlanTimeline({ locale, plan, historyIncomplete = false }: TaskPlanTimelineProps) {
  const steps = plan?.steps ?? [];
  if (!steps.length) {
    return (
      <div style={styles.empty}>
        {locale === 'en' ? 'No plan steps yet' : '暂无计划步骤'}
      </div>
    );
  }
  return (
    <div>
      <ol style={styles.listReset}>
        {steps.map((step, index) => {
          const view = getStepStatusView(step.status, locale);
          const hint = getStepEvidenceHint(step, locale);
          return (
            <li key={step.id} style={styles.stepRow}>
              <span style={styles.stepIndex} aria-hidden="true">
                {index + 1}
              </span>
              <span style={{ ...styles.statusDot, background: toneColor[view.tone], marginTop: 6 }} aria-hidden="true" />
              <div style={styles.stepBody}>
                <div style={styles.rowBetween}>
                  <span style={styles.stepDesc}>{step.description}</span>
                  <StatusBadge view={view} showDot={false} />
                </div>
                {hint ? (
                  <div style={{ ...styles.stepHint, color: toneColor.warning }}>{hint}</div>
                ) : null}
                {step.failureReason ? (
                  <div style={{ ...styles.stepHint, color: toneColor.danger }}>{step.failureReason}</div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {historyIncomplete ? (
        <div style={{ ...styles.faint, fontSize: 11, marginTop: 6 }}>
          {locale === 'en'
            ? 'Plan history is partial in this version.'
            : '当前版本仅提供最新计划，历史记录不完整。'}
        </div>
      ) : null}
    </div>
  );
}
