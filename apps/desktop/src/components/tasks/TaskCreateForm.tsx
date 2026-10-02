import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { Locale } from '../../config/config.js';

export interface TaskCreateFormProps {
  locale: Locale;
  threadId?: string;
  busy?: boolean;
  error?: string | null;
  onCancel(): void;
  onSubmit(input: { objective: string; acceptanceCriteria: string[] }): Promise<void>;
}

/** 任务中心内联创建入口：创建后仍需在详情中点击“启动”，避免误触直接运行。 */
export function TaskCreateForm({ locale, threadId, busy = false, error, onCancel, onSubmit }: TaskCreateFormProps) {
  const zh = locale === 'zh';
  const [objective, setObjective] = useState('');
  const [criteriaText, setCriteriaText] = useState('');
  const criteria = useMemo(
    () => criteriaText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    [criteriaText],
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = objective.trim();
    if (!threadId || !value || busy) return;
    await onSubmit({ objective: value, acceptanceCriteria: criteria });
  };

  return (
    <form className="taskCreateForm" onSubmit={submit}>
      <div className="taskCreateTitle">{zh ? '创建 Goal' : 'Create Goal'}</div>
      <div className="taskCreateHint">
        {zh
          ? '先创建 Goal，启动后由运行时按需提出动态工作流；提案会在详情中等待批准。'
          : 'This area contains explicit Goals only; ordinary conversations stay in chat. After start, the Goal Run may propose a Dynamic Workflow that requires your approval.'}
      </div>
      <label className="taskCreateLabel">
        <span>{zh ? '关联当前会话' : 'Current thread'}</span>
        <input className="taskCreateInput" value={threadId ?? ''} readOnly placeholder={zh ? '请先打开一个会话' : 'Open a thread first'} />
      </label>
      <label className="taskCreateLabel">
        <span>{zh ? '目标' : 'Objective'}</span>
        <textarea
          className="taskCreateTextarea"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder={zh ? '例如：重构认证模块并通过现有测试' : 'e.g. Refactor auth and keep existing tests green'}
          rows={3}
          autoFocus
        />
      </label>
      <label className="taskCreateLabel">
        <span>{zh ? '验收标准（每行一条，可选）' : 'Acceptance criteria (one per line, optional)'}</span>
        <textarea
          className="taskCreateTextarea"
          value={criteriaText}
          onChange={(event) => setCriteriaText(event.target.value)}
          placeholder={zh ? '测试全部通过\n关键文件已更新' : 'All tests pass\nKey files are updated'}
          rows={3}
        />
      </label>
      {error ? <div className="taskCreateError" role="alert">{error}</div> : null}
      <div className="taskCreateActions">
        <button type="button" className="taskCreateButton" onClick={onCancel} disabled={busy}>{zh ? '取消' : 'Cancel'}</button>
        <button type="submit" className="taskCreateButton taskCreateButtonPrimary" disabled={busy || !threadId || !objective.trim()}>
          {busy ? (zh ? '创建中…' : 'Creating…') : (zh ? '创建 Goal' : 'Create Goal')}
        </button>
      </div>
    </form>
  );
}
