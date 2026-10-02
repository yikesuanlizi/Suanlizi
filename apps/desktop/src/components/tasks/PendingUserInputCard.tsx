// 待处理输入卡片：任务 blocked 时展示结构化待处理问题（问题 / 选项 / 是否可自由文本 / 提问时间）。
// P2 起在卡片内就近提供回答入口：freeText=true 才可输入；options 存在时渲染单选；
// 提交经 onSubmitAnswer 上抛，由 TaskCenter 编排 POST :id/input。缺省回调时保持只读展示。
// — English: pending-input card; P2 adds the inline answer entry (radio + optional free text + submit).
import { useState } from 'react';
import type { Locale } from '../../config/config.js';
import type { PendingUserInput } from '@suanlizi/protocol';
import { Icon } from '../Icon.js';
import { formatDateTime } from './taskDisplay.js';
import './tasks.css';

export interface PendingUserInputCardProps {
  locale: Locale;
  pendingInput?: PendingUserInput | null;
  /** 提交回答（POST :id/input 的 answer）；缺省时保持只读展示。 */
  onSubmitAnswer?(answer: string): void;
  /** 操作进行中：禁用输入与提交，防双发。 */
  busy?: boolean;
}

export function PendingUserInputCard({ locale, pendingInput, onSubmitAnswer, busy = false }: PendingUserInputCardProps) {
  const zh = locale === 'zh';
  const [selected, setSelected] = useState<string>('');
  const [freeText, setFreeText] = useState<string>('');
  if (!pendingInput) return null;

  const options = pendingInput.options ?? [];
  const hasOptions = options.length > 0;
  const answer = hasOptions && !pendingInput.freeText ? selected : freeText.trim() || selected;
  const canSubmit = Boolean(onSubmitAnswer) && answer.trim().length > 0 && !busy;

  return (
    <div className="pendingInputCard" role="note" aria-label={zh ? '待用户处理' : 'Awaiting user input'}>
      <div className="pendingInputHead">
        <Icon name="question" />
        <span>{zh ? '需要你确认' : 'Needs your input'}</span>
        {pendingInput.askedAt ? <em style={{ marginLeft: 'auto', fontStyle: 'normal' }}>{formatDateTime(pendingInput.askedAt, locale)}</em> : null}
      </div>
      <p className="pendingInputQuestion">{pendingInput.question}</p>
      {hasOptions ? (
        onSubmitAnswer ? (
          <div className="pendingInputOptions" role="radiogroup" aria-label={zh ? '选项' : 'Options'}>
            {options.map((option, index) => (
              <label className="pendingInputOptionLabel" key={`${option}-${index}`}>
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
          <div className="pendingInputOptions">
            {options.map((option, index) => (
              <span className="pendingInputOption" key={`${option}-${index}`} title={option}>{option}</span>
            ))}
          </div>
        )
      ) : null}
      {pendingInput.freeText && onSubmitAnswer ? (
        <input
          className="pendingInputAnswer"
          type="text"
          value={freeText}
          disabled={busy}
          placeholder={zh ? '输入你的回答' : 'Type your answer'}
          onChange={(event) => setFreeText(event.target.value)}
        />
      ) : null}
      {onSubmitAnswer ? (
        <div className="pendingInputSubmit">
          <button type="button" className="taskActionButton" disabled={!canSubmit} onClick={() => canSubmit && onSubmitAnswer(answer.trim())}>
            <Icon name="send" />
            <span>{zh ? '提交回答' : 'Submit answer'}</span>
          </button>
        </div>
      ) : (
        <div className="pendingInputFoot">
          {pendingInput.freeText
            ? (zh ? '可自由文本回复' : 'Free-text answer accepted')
            : (zh ? '请从上方选项中选择' : 'Choose from the options above')}
        </div>
      )}
    </div>
  );
}
