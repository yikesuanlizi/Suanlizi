import { formatSuanliziErrorMessage } from '@suanlizi/protocol';
import type { OpsTaskSession, OpsTaskState } from '@suanlizi/protocol';
import { Icon } from './Icon.js';
import type { Locale } from '../config/config.js';

export type OpsAnchorAction = 'confirm' | 'reject_continue' | 'update_scope' | 'cancel';

export interface OpsTaskAnchorCardProps {
  locale: Locale;
  task: OpsTaskSession;
  busy?: boolean;
  onAction(action: OpsAnchorAction): void | Promise<void>;
}

const stateLabel: Record<OpsTaskState, [string, string]> = {
  draft: ['草稿', 'Draft'], queued: ['排队中', 'Queued'], running: ['运行中', 'Running'],
  paused: ['已暂停', 'Paused'], waiting_confirmation: ['需要确认', 'Confirmation required'],
  verifying: ['验证中', 'Verifying'], completed: ['已完成', 'Completed'], blocked: ['需要补充信息', 'More information required'],
  cancelled: ['已取消', 'Cancelled'], failed: ['失败', 'Failed'],
};

function text(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

export function OpsTaskAnchorCard({ locale, task, busy = false, onAction }: OpsTaskAnchorCardProps) {
  const waiting = task.state === 'waiting_confirmation';
  const target = [
    ...task.spec.target.hostIds,
    ...(task.spec.target.serviceNames ?? []),
    ...(task.spec.target.containerNames ?? []),
  ].join(' / ');
  const reason = task.lastError
    ? formatSuanliziErrorMessage(undefined, task.lastError, locale)
    : '';
  return (
    <article className={`opsTaskAnchorCard opsTaskAnchorCard-${task.state}`} aria-live="polite">
      <header className="opsTaskAnchorHeader">
        <span className="opsTaskAnchorStatusIcon" aria-hidden="true"><Icon name={waiting ? 'shield' : 'alert'} /></span>
        <div className="opsTaskAnchorHeading">
          <strong>{text(locale, `运维任务 ${task.spec.taskId}`, `Ops task ${task.spec.taskId}`)}</strong>
          <span>{text(locale, stateLabel[task.state][0], stateLabel[task.state][1])}</span>
        </div>
      </header>
      <div className="opsTaskAnchorBody">
        <span><b>{text(locale, '阶段', 'Phase')}</b>{task.currentPhase}</span>
        {target ? <span><b>{text(locale, '目标', 'Target')}</b>{target}</span> : null}
        {reason ? <span><b>{text(locale, '原因', 'Reason')}</b>{reason}</span> : null}
        {task.finalConclusion?.summary ? <p>{task.finalConclusion.summary}</p> : null}
      </div>
      <footer className="opsTaskAnchorActions">
        {waiting ? (
          <>
            <button type="button" className="opsTaskAnchorPrimary" disabled={busy} onClick={() => void onAction('confirm')}><Icon name="shield" />{text(locale, '确认并验证', 'Confirm and verify')}</button>
            <button type="button" className="opsTaskAnchorSecondary" disabled={busy} onClick={() => void onAction('reject_continue')}>{text(locale, '拒绝并继续调查', 'Reject and continue')}</button>
          </>
        ) : (
          <button type="button" className="opsTaskAnchorPrimary" disabled={busy} onClick={() => void onAction('update_scope')}><Icon name="gear" />{text(locale, '补充任务范围', 'Update task scope')}</button>
        )}
        <button type="button" className="opsTaskAnchorCancel" disabled={busy} onClick={() => void onAction('cancel')}>{text(locale, '取消任务', 'Cancel task')}</button>
      </footer>
    </article>
  );
}
