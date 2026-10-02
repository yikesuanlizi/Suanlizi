// 证据面板（只读）：展示证据数量与 id 引用原文；P0 不做正文聚合，不伪造内容。
// Read-only evidence panel: count + id references only (P0 exposes raw ids).
import React from 'react';
import type { Locale } from '../../config/config.js';
import { styles } from './taskStyles.js';

export interface TaskEvidencePanelProps {
  locale: Locale;
  evidenceIds: readonly string[];
}

export function TaskEvidencePanel({ locale, evidenceIds }: TaskEvidencePanelProps) {
  const count = evidenceIds.length;
  return (
    <div>
      <div style={{ ...styles.muted, fontSize: 12, marginBottom: 6 }}>
        {locale === 'en' ? `${count} evidence item(s)` : `证据 ${count} 条`}
      </div>
      {count === 0 ? (
        <div style={{ ...styles.faint, fontSize: 12 }}>
          {locale === 'en' ? 'No evidence recorded yet' : '暂无证据记录'}
        </div>
      ) : (
        <div style={styles.chipRow}>
          {evidenceIds.map((id) => (
            <span key={id} style={styles.chip} title={id}>
              {id}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
