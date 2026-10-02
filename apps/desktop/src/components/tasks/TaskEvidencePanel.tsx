// 证据面板（只读）：展示任务关联的证据 id 集合与数量。P0/P1 只回传 id 原文，正文聚合在后续阶段接入。
// — English: read-only evidence panel listing evidence ids; body aggregation lands later.
import type { Locale } from '../../config/config.js';
import { Icon } from '../Icon.js';
import './tasks.css';

export interface TaskEvidencePanelProps {
  locale: Locale;
  evidenceIds: string[];
}

export function TaskEvidencePanel({ locale, evidenceIds }: TaskEvidencePanelProps) {
  const zh = locale === 'zh';
  const ids = evidenceIds ?? [];

  return (
    <div className="taskSection">
      <div className="taskSectionHeading">
        <Icon name="shield" />
        <strong>{zh ? '证据' : 'Evidence'}</strong>
        <em>{ids.length}</em>
      </div>
      {ids.length === 0 ? (
        <p className="taskEmptyState">{zh ? '暂无证据记录。' : 'No evidence recorded.'}</p>
      ) : (
        <div className="taskEvidence">
          {ids.map((id) => (
            <span className="taskEvidenceId" key={id} title={id}>{id}</span>
          ))}
          <span className="taskEvidenceNote">
            {zh ? '证据正文聚合与验收关联将在后续阶段接入。' : 'Evidence body aggregation and acceptance linkage land later.'}
          </span>
        </div>
      )}
    </div>
  );
}
