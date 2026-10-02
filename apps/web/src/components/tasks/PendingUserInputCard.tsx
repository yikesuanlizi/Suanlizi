// 待补充信息卡片：blocked 时结构化展示待办问题、可选项与提问时间。
// P2 起在卡片内就近提供回答入口：freeText=true 才可输入自由文本；options 存在时渲染单选；
// 提交通过 onSubmitAnswer 上抛，由上层（抽屉/容器）编排 POST :id/input。
// Read-only display in P1; P2 adds the inline answer entry (radio + optional free text + submit).
import React, { useState } from 'react';
import type { PendingUserInput } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { formatTimestamp } from '../../shared/i18n.js';
import { Icon } from '../Icon.js';
import { styles } from './taskStyles.js';

export interface PendingUserInputCardProps {
  locale: Locale;
  pendingInput?: PendingUserInput | null;
  /** 提交回答（POST :id/input 的 answer）；缺省时保持只读展示。 */
  onSubmitAnswer?(answer: string): void;
  /** 操作进行中：禁用输入与提交，防双发。 */
  busy?: boolean;
}

export function PendingUserInputCard({ locale, pendingInput, onSubmitAnswer, busy = false }: PendingUserInputCardProps) {
  const [selected, setSelected] = useState<string>('');
  const [freeText, setFreeText] = useState<string>('');
  if (!pendingInput) return null;
  const options = pendingInput.options ?? [];
  const hasOptions = options.length > 0;
  const answer = hasOptions && !pendingInput.freeText ? selected : (freeText.trim() || selected);
  const canSubmit = Boolean(onSubmitAnswer) && answer.trim().length > 0 && !busy;

  return (
    <div style={styles.pendingCard} role="note">
      <div style={styles.pendingHead}>
        <Icon name="question" />
        <span>{locale === 'en' ? 'Needs your input' : '需要你补充信息'}</span>
      </div>
      <div style={styles.pendingQuestion}>{pendingInput.question}</div>
      {hasOptions ? (
        onSubmitAnswer ? (
          <div style={styles.chipRow} role="radiogroup" aria-label={locale === 'en' ? 'Options' : '选项'}>
            {options.map((option) => (
              <label key={option} style={styles.radioRow}>
                <input
                  type="radio"
                  name={`pending-${pendingInput.askedAt}`}
                  value={option}
                  checked={selected === option}
                  disabled={busy}
                  onChange={() => setSelected(option)}
                />
                <span title={option}>{option}</span>
              </label>
            ))}
          </div>
        ) : (
          <div style={styles.chipRow}>
            {options.map((option) => (
              <span key={option} style={styles.chip} title={option}>
                {option}
              </span>
            ))}
          </div>
        )
      ) : null}
      {pendingInput.freeText && onSubmitAnswer ? (
        <input
          style={styles.textInput}
          type="text"
          value={freeText}
          disabled={busy}
          placeholder={locale === 'en' ? 'Type your answer' : '输入你的回答'}
          onChange={(event) => setFreeText(event.target.value)}
        />
      ) : null}
      {onSubmitAnswer ? (
        <div style={styles.answerRow}>
          <button
            type="button"
            style={{ ...styles.actionButton, ...(canSubmit ? {} : styles.actionButtonBusy) }}
            disabled={!canSubmit}
            onClick={() => canSubmit && onSubmitAnswer(answer.trim())}
          >
            <Icon name="send" />
            <span>{locale === 'en' ? 'Submit answer' : '提交回答'}</span>
          </button>
        </div>
      ) : (
        <div style={{ ...styles.faint, fontSize: 11 }}>
          {pendingInput.freeText
            ? locale === 'en' ? 'Free-text reply accepted' : '可自由文本回复'
            : locale === 'en' ? 'Choose from the options above' : '请从上方选项中选择'}
          {' · '}
          {formatTimestamp(pendingInput.askedAt, locale)}
        </div>
      )}
    </div>
  );
}
