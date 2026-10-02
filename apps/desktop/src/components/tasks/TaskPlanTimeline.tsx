// 计划时间线（只读）：展示当前计划版本投影的步骤序列，明确区分 claimed（自述）与 verified（已验证）。
// — English: read-only plan timeline; visually separates claimed vs verified steps.
import type { Locale } from '../../config/config.js';
import type { TaskPlanTrigger, TaskPlanVersion } from '@suanlizi/protocol';
import { Icon } from '../Icon.js';
import { stepStatusLabel, stepStatusTone } from '../../features/tasks/taskCenterModel.js';
import { stepStatusIcon, toneClass } from './taskDisplay.js';
import './tasks.css';

const TRIGGER_LABELS_ZH: Record<TaskPlanTrigger, string> = {
  init: '初始',
  replan: '重规划',
  redirect: '用户引导',
  failure: '失败调整',
};

function triggerLabel(trigger: TaskPlanTrigger, zh: boolean): string {
  if (!zh) return trigger;
  return TRIGGER_LABELS_ZH[trigger] ?? trigger;
}

export interface TaskPlanTimelineProps {
  locale: Locale;
  plan?: TaskPlanVersion | null;
  historyIncomplete?: boolean;
}

export function TaskPlanTimeline({ locale, plan, historyIncomplete = false }: TaskPlanTimelineProps) {
  const zh = locale === 'zh';
  const steps = plan?.steps ?? [];

  if (steps.length === 0) {
    return <p className="taskEmptyState">{zh ? '当前计划暂无步骤。' : 'No steps in the current plan.'}</p>;
  }

  return (
    <div className="taskSection">
      <div className="taskSectionHeading">
        <Icon name="layers" />
        <strong>{zh ? '计划步骤' : 'Plan steps'}</strong>
        <em>{zh ? `v${plan?.version ?? 0} · ${triggerLabel(plan?.trigger ?? 'init', zh)}` : `v${plan?.version ?? 0} · ${plan?.trigger ?? 'init'}`}</em>
      </div>
      <div className="taskPlanTimeline">
        {steps.map((step) => {
          const tone = stepStatusTone(step.status);
          return (
            <div className="taskPlanStep" key={step.id}>
              <span className={toneClass(tone)} title={stepStatusLabel(step.status, zh)}>
                <Icon name={stepStatusIcon(step.status)} />
              </span>
              <span className="taskPlanStepText" title={step.description}>{step.description}</span>
              <span className={`taskPlanStepStatus ${toneClass(tone)}`}>{stepStatusLabel(step.status, zh)}</span>
            </div>
          );
        })}
      </div>
      {steps.some((step) => step.status === 'claimed') && zh ? (
        <p className="taskPlanMeta">「自述完成」的步骤缺少有效证据，暂不计入验收。</p>
      ) : null}
      {steps.some((step) => step.status === 'claimed' ) && !zh ? (
        <p className="taskPlanMeta">Steps marked “Claimed” lack valid evidence and are not accepted yet.</p>
      ) : null}
      {historyIncomplete ? (
        <p className="taskPlanMeta">{zh ? '仅展示当前计划投影；完整版本历史将在后续阶段接入。' : 'Showing the current plan projection only; full version history lands in a later phase.'}</p>
      ) : null}
    </div>
  );
}
