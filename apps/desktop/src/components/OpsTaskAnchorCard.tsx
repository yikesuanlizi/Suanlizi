import React from 'react';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';
import type { Locale } from '../config/config.js';
import { Icon } from './Icon.js';

export type OpsAnchorState = 'waiting_confirmation' | 'blocked';
export type OpsAnchorAction = 'confirm' | 'reject_continue' | 'update_scope' | 'cancel';

export interface OpsTaskAnchor {
  threadId: string;
  taskId: string;
  state: OpsAnchorState;
  phase?: string;
  target?: string;
  reason?: string;
  summary?: string;
}

export interface OpsTaskAnchorCardProps {
  locale: Locale;
  task: OpsTaskAnchor;
  busy?: boolean;
  onAction: (action: OpsAnchorAction) => void | Promise<void>;
}

function text(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

export function OpsTaskAnchorCard({
  locale,
  task,
  busy = false,
  onAction,
}: OpsTaskAnchorCardProps) {
  const waiting = task.state === 'waiting_confirmation';
  return (
    <article className={`opsTaskAnchorCard opsTaskAnchorCard-${task.state}`} aria-live="polite">
      <header className="opsTaskAnchorHeader">
        <span className="opsTaskAnchorStatusIcon" aria-hidden="true">
          <Icon name={waiting ? 'shield' : 'alert'} />
        </span>
        <div className="opsTaskAnchorHeading">
          <strong>{text(locale, `运维任务 ${task.taskId}`, `Ops task ${task.taskId}`)}</strong>
          <span>
            {waiting
              ? text(locale, '需要确认', 'Confirmation required')
              : text(locale, '需要补充信息', 'More information required')}
          </span>
        </div>
      </header>
      <div className="opsTaskAnchorBody">
        {task.phase ? (
          <span>
            <b>{text(locale, '阶段', 'Phase')}</b>
            {task.phase}
          </span>
        ) : null}
        {task.target ? (
          <span>
            <b>{text(locale, '目标', 'Target')}</b>
            {task.target}
          </span>
        ) : null}
        {task.reason ? (
          <span>
            <b>{text(locale, '原因', 'Reason')}</b>
            {formatSuanliziErrorMessage(undefined, task.reason, locale)}
          </span>
        ) : null}
        {task.summary ? <p>{task.summary}</p> : null}
      </div>
      <footer className="opsTaskAnchorActions">
        {waiting ? (
          <>
            <button
              type="button"
              className="opsTaskAnchorPrimary"
              disabled={busy}
              onClick={() => void onAction('confirm')}
            >
              <Icon name="shield" />
              {text(locale, '确认并验证', 'Confirm and verify')}
            </button>
            <button
              type="button"
              className="opsTaskAnchorSecondary"
              disabled={busy}
              onClick={() => void onAction('reject_continue')}
            >
              {text(locale, '拒绝并继续调查', 'Reject and continue')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="opsTaskAnchorPrimary"
            disabled={busy}
            onClick={() => void onAction('update_scope')}
          >
            <Icon name="gear" />
            {text(locale, '补充任务范围', 'Update task scope')}
          </button>
        )}
        <button
          type="button"
          className="opsTaskAnchorCancel"
          disabled={busy}
          onClick={() => void onAction('cancel')}
        >
          {text(locale, '取消任务', 'Cancel task')}
        </button>
      </footer>
    </article>
  );
}
