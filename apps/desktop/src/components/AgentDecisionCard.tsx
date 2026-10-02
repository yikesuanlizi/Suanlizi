import React from 'react';
import type { AgentDecisionAction, AgentDecisionRequest, AgentDecisionResponse } from '@suanlizi/protocol';

export interface AgentDecisionCardProps {
  request: AgentDecisionRequest;
  locale: 'zh' | 'en';
  busy?: boolean;
  onSubmit: (response: AgentDecisionResponse) => Promise<void> | void;
}

export function AgentDecisionCard({ request, locale, busy = false, onSubmit }: AgentDecisionCardProps) {
  const [selectedAction, setSelectedAction] = React.useState<AgentDecisionAction | null>(null);
  const [selectedOptionId, setSelectedOptionId] = React.useState<string | undefined>();
  const [customInput, setCustomInput] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const zh = locale === 'zh';

  async function submit(action: AgentDecisionAction, optionId?: string) {
    if (submitting || busy) return;
    if (action === 'custom_input' && !customInput.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        requestId: request.requestId,
        action,
        ...(optionId ? { optionId } : {}),
        ...(action === 'custom_input' ? { customInput: customInput.trim() } : {}),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const selectedResponse = selectedAction
    ? {
        action: selectedAction,
        ...(selectedOptionId ? { optionId: selectedOptionId } : {}),
        ...(selectedAction === 'custom_input' ? { customInput: customInput.trim() } : {}),
      }
    : null;

  return (
    <section className="agentDecisionCard" aria-label={zh ? 'Agent 决策请求' : 'Agent decision request'}>
      <header className="agentDecisionHeader">
        <strong>{zh ? '需要你的选择' : 'Your decision is needed'}</strong>
        <span>{zh ? 'Agent 已暂停，提交后从当前检查点继续' : 'Agent is paused and will continue from this checkpoint'}</span>
      </header>
      <p className="agentDecisionPrompt">{request.prompt}</p>
      <div className="agentDecisionOptions" role="group" aria-label={zh ? '决策方式' : 'Decision options'}>
        {request.options.map((option: AgentDecisionRequest['options'][number]) => (
          <button
            key={option.id}
            type="button"
            className={selectedOptionId === option.id ? 'agentDecisionOption selected' : 'agentDecisionOption'}
            disabled={submitting || busy}
            onClick={() => {
              setSelectedAction(option.action);
              setSelectedOptionId(option.id);
            }}
            aria-pressed={selectedOptionId === option.id}
          >
            <strong>{option.label}</strong>
            {option.description ? <small>{option.description}</small> : null}
          </button>
        ))}
        {request.allowCustomInput ? (
          <button
            type="button"
            className={selectedAction === 'custom_input' ? 'agentDecisionOption selected' : 'agentDecisionOption'}
            disabled={submitting || busy}
            onClick={() => {
              setSelectedAction('custom_input');
              setSelectedOptionId(undefined);
            }}
            aria-pressed={selectedAction === 'custom_input'}
          >
            <strong>{zh ? '自定义输入' : 'Custom input'}</strong>
            <small>{zh ? '提供其他处理方式' : 'Provide another direction'}</small>
          </button>
        ) : null}
      </div>
      {selectedAction === 'custom_input' ? (
        <div className="agentDecisionCustom">
          <textarea
            value={customInput}
            onChange={(event) => setCustomInput(event.target.value)}
            placeholder={zh ? '输入你的决定...' : 'Enter your decision...'}
            rows={2}
            disabled={submitting || busy}
          />
        </div>
      ) : null}
      <footer className="agentDecisionFooter">
        <button type="button" className="textButton" disabled={submitting || busy} onClick={() => void submit('cancel')}>
          {zh ? '取消此次选择/拒绝并继续' : 'Decline and continue'}
        </button>
        <button
          type="button"
          className="solidButton"
          disabled={submitting || busy || !selectedResponse || (selectedAction === 'custom_input' && !customInput.trim())}
          onClick={() => selectedResponse && void submit(selectedResponse.action, selectedResponse.optionId)}
        >
          {zh ? '确认并继续' : 'Confirm and continue'}
        </button>
      </footer>
    </section>
  );
}
