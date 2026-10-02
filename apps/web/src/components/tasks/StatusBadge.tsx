// 任务中心共享状态徽章：由 tone 驱动 1px 低对比边框 + 小圆点，仅表达状态语义。
// Shared read-only status badge for the task center.
import React from 'react';
import type { StatusView } from '../../features/tasks/taskCenterModel.js';
import { styles, toneColor, toneSoftBg } from './taskStyles.js';

export interface StatusBadgeProps {
  view: StatusView;
  /** 是否显示前置圆点（默认显示）。 */
  showDot?: boolean;
}

export function StatusBadge({ view, showDot = true }: StatusBadgeProps) {
  const color = toneColor[view.tone];
  return (
    <span
      style={{
        ...styles.badge,
        color,
        background: toneSoftBg[view.tone],
      }}
    >
      {showDot ? <span style={{ ...styles.statusDot, background: color }} aria-hidden="true" /> : null}
      {view.label}
    </span>
  );
}
