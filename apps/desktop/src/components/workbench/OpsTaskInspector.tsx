import { useEffect, useState } from 'react';
import type { OpsTaskSession, OpsTaskState } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { Icon } from '../Icon.js';
import { listKnowledgeBases, replayKnowledgeReceipt, type KnowledgeReceiptReplay } from '../../api/knowledgeClient.js';

export interface OpsTaskInspectorProps {
  locale: Locale;
  task: OpsTaskSession | null;
  events?: OpsTaskTimelineEvent[];
  busy?: boolean;
  onAction?(action: 'pause' | 'resume' | 'cancel' | 'confirm' | 'reject_continue' | 'propose_patch' | 'approve_patch' | 'reject_patch'): void;
  onRunTest?(testId: string): void;
  onSaveIncident?(): void;
}

export interface OpsTaskTimelineEvent {
  type: string;
  sequence: number;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}

const phases = ['observe', 'hypothesize', 'investigate', 'verify', 'conclude'] as const;

type LocalTestOption = {
  testId: string;
  label: string;
  description: string;
  acceptsArgs: false;
};

const fallbackLocalTests: LocalTestOption[] = [
  { testId: 'workspace.typecheck', label: 'TypeScript typecheck', description: '', acceptsArgs: false },
  { testId: 'workspace.unit', label: 'Unit tests', description: '', acceptsArgs: false },
];

function label(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

function stateLabel(locale: Locale, state: OpsTaskState): string {
  const names: Record<OpsTaskState, [string, string]> = {
    draft: ['草稿', 'Draft'], queued: ['排队中', 'Queued'], running: ['运行中', 'Running'],
    paused: ['已暂停', 'Paused'], waiting_confirmation: ['等待确认', 'Awaiting confirmation'],
    verifying: ['验证中', 'Verifying'], completed: ['已完成', 'Completed'],
    blocked: ['需要补充', 'Blocked'], cancelled: ['已取消', 'Cancelled'], failed: ['失败', 'Failed'],
  };
  const [zh, en] = names[state];
  return label(locale, zh, en);
}

export function OpsTaskInspector({ locale, task, events = [], busy = false, onAction, onRunTest, onSaveIncident }: OpsTaskInspectorProps) {
  const [selectedTestId, setSelectedTestId] = useState('workspace.typecheck');
  const [localTests, setLocalTests] = useState<LocalTestOption[]>(fallbackLocalTests);
  const [receiptReplay, setReceiptReplay] = useState<KnowledgeReceiptReplay | null>(null);
  const [knowledgeNames, setKnowledgeNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!task?.spec.allowLocalTest) return undefined;
    const controller = new AbortController();
    void fetch('/api/ops/tests', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { tests?: LocalTestOption[] };
        const tests = Array.isArray(data.tests)
          ? data.tests.filter((item) => typeof item?.testId === 'string' && typeof item?.label === 'string')
          : [];
        if (tests.length > 0) setLocalTests(tests);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [task?.spec.allowLocalTest]);
  useEffect(() => {
    if (localTests.some((item) => item.testId === selectedTestId)) return;
    setSelectedTestId(localTests[0]?.testId ?? '');
  }, [localTests, selectedTestId]);
  useEffect(() => {
    const receiptId = task?.spec.knowledgeScope?.queryReceiptId;
    if (!receiptId) { setReceiptReplay(null); return undefined; }
    let disposed = false;
    void Promise.all([replayKnowledgeReceipt(receiptId), listKnowledgeBases()]).then(([value, bases]) => {
      if (disposed) return;
      setReceiptReplay(value);
      setKnowledgeNames(Object.fromEntries(bases.map((base) => [base.knowledgeBaseId, base.name])));
    }).catch(() => { if (!disposed) setReceiptReplay(null); });
    return () => { disposed = true; };
  }, [task?.spec.knowledgeScope?.queryReceiptId]);
  if (!task) return null;
  const usage = task.budgetUsage ?? { adapterCalls: 0, inputTokens: 0, outputBytes: 0, wallTimeMs: 0 };
  const budgets = task.spec.budgets;
  const evidence = task.evidence ?? [];
  const claims = task.finalConclusion?.claims ?? [];
  const needsConfirmation = task.state === 'waiting_confirmation';
  const canPause = task.state === 'running' || task.state === 'verifying';
  const canResume = task.state === 'paused' || task.state === 'blocked';
  const terminal = task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled';
  const canRunLocalTest = task.spec.allowLocalTest && ['queued', 'running', 'paused', 'verifying', 'blocked'].includes(task.state);
  const progress = phases.indexOf(task.currentPhase as typeof phases[number]);
  const testRuns = task.testRuns ?? [];
  const testRunning = testRuns.some((run) => run.status === 'queued' || run.status === 'running');
  const knowledgeScope = task.spec.knowledgeScope;
  const knowledgeSnapshotCount = knowledgeScope?.snapshotIds.length ?? 0;

  return (
    <section className="opsTaskInspector" aria-label={label(locale, '运维任务检查器', 'Ops task inspector')}>
      <header className="opsInspectorHeader">
        <div>
          <span className="opsInspectorEyebrow">OPS · {task.spec.presetId}</span>
          <h3>{task.spec.taskId}</h3>
        </div>
        <span className={`opsInspectorState state-${task.state}`}>{stateLabel(locale, task.state)}</span>
      </header>

      <div className="opsInspectorPhases" role="list" aria-label={label(locale, '任务阶段', 'Task phases')}>
        {phases.map((phase, index) => (
          <div key={phase} className={`opsInspectorPhase ${index < progress ? 'done' : ''} ${index === progress ? 'current' : ''}`} role="listitem">
            <span className="opsInspectorPhaseDot">{index < progress ? <Icon name="check" /> : index + 1}</span>
            <span>{phase}</span>
          </div>
        ))}
      </div>

      <div className="opsInspectorKnowledge" aria-label={label(locale, '知识依据', 'Knowledge evidence')}>
        <Icon name="layers" />
        <div className="opsInspectorKnowledgeCopy">
          <span>{label(locale, '知识依据', 'Knowledge')}</span>
          <strong>{knowledgeScope?.knowledgeBaseIds.length ?? 0} {label(locale, '个知识库', 'knowledge base(s)')} · {knowledgeSnapshotCount} {label(locale, '个固定快照', 'fixed snapshot(s)')}</strong>
        </div>
        <span className={`opsInspectorReceipt ${knowledgeScope?.queryReceiptId ? 'ready' : 'missing'}`} title={knowledgeScope?.queryReceiptId ?? label(locale, '没有查询收据', 'No query receipt')}>
          {knowledgeScope?.queryReceiptId ? label(locale, '已固定', 'Pinned') : label(locale, '缺失', 'Missing')}
        </span>
      </div>
      {receiptReplay ? <div className="opsReceiptAudit"><div className="opsSectionHeading"><Icon name="search" /><strong>{label(locale, '固定查询收据', 'Pinned query receipt')}</strong><small>{receiptReplay.receipt.receiptId}</small></div><small>{label(locale, '知识库', 'Knowledge bases')}: {receiptReplay.receipt.knowledgeBaseIds.map((id) => knowledgeNames[id] ?? id).join(' · ')}</small><small>{label(locale, '快照', 'Snapshots')}: {receiptReplay.receipt.snapshotIds.join(' · ')}</small>{receiptReplay.receipt.truncated ? <small>{label(locale, '结果已截断', 'Results truncated')}: {receiptReplay.receipt.truncationReasons.join(', ')}</small> : null}<div>{receiptReplay.hits.slice(0, 6).map((hit) => <article key={hit.chunkId}><strong>{hit.heading ?? hit.relativePath}</strong><small>{hit.relativePath}</small><p>{hit.text.slice(0, 280)}</p></article>)}</div></div> : null}

      <div className="opsInspectorBudget">
        <div className="opsInspectorBudgetHeader"><strong>{label(locale, '预算', 'Budget')}</strong><span>{usage.adapterCalls} / {budgets.maxAdapterCalls} {label(locale, '适配器调用', 'adapter calls')}</span></div>
        <div className="opsInspectorProgress"><span style={{ width: `${Math.min(100, (usage.adapterCalls / Math.max(1, budgets.maxAdapterCalls)) * 100)}%` }} /></div>
        <div className="opsInspectorBudgetMeta">
          <span>{formatBytes(usage.outputBytes)} / {formatBytes(budgets.maxOutputBytes)}</span>
          <span>{formatDuration(usage.wallTimeMs)} / {formatDuration(budgets.maxWallTimeMs)}</span>
        </div>
      </div>

      {task.patchProposal ? (
        <div className={`opsPatchReview opsPatchReview-${task.patchProposal.status}`}>
          <div className="opsSectionHeading"><Icon name="file" /><strong>{label(locale, 'Patch 提案', 'Patch proposal')}</strong><span>{task.patchProposal.status}</span></div>
          <p>{task.patchProposal.summary}</p>
          {task.patchProposal.diff ? <pre>{task.patchProposal.diff}</pre> : <div className="opsPatchEmpty">{label(locale, '没有可写入的差异内容', 'No writable diff was attached.')}</div>}
          {needsConfirmation ? (
            <div className="opsInspectorActions">
              <button type="button" className="opsActionPrimary" disabled={busy} onClick={() => onAction?.('approve_patch')}><Icon name="check" />{label(locale, '批准并验证', 'Approve and verify')}</button>
              <button type="button" className="opsActionSecondary" disabled={busy} onClick={() => onAction?.('reject_patch')}>{label(locale, '拒绝并继续', 'Reject and continue')}</button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!task.patchProposal && task.spec.allowLocalPatchProposal && (task.state === 'running' || task.state === 'verifying') ? (
        <button type="button" className="opsPatchProposalTrigger" disabled={busy} onClick={() => onAction?.('propose_patch')}>
          <Icon name="file" />{label(locale, '生成 Patch 提案供审查', 'Create patch proposal for review')}
        </button>
      ) : null}

      {evidence.length > 0 ? (
        <div className="opsEvidenceSection">
          <div className="opsSectionHeading"><Icon name="check" /><strong>{label(locale, '证据', 'Evidence')}</strong><span>{evidence.length}</span></div>
          <div className="opsEvidenceList">
            {evidence.map((item) => (
              <article className={`opsEvidenceItem evidence-${item.status}`} key={item.id}>
                <span className="opsEvidenceSignal" />
                <div><strong>{item.sourceRef || item.source}</strong><p>{item.summary}</p><small>{new Date(item.observedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</small></div>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {claims.length > 0 ? (
        <div className="opsClaimsSection">
          <div className="opsSectionHeading"><Icon name="spark" /><strong>{label(locale, '结论与证据关联', 'Claims and evidence')}</strong></div>
          {claims.map((claim) => (
            <div className={`opsClaim opsClaim-${claim.status}`} key={`${claim.text}-${claim.evidenceIds.join(',')}`}>
              <span>{claim.status === 'supported' ? '●' : claim.status === 'contradicted' ? '!' : '?'}</span>
              <div><p>{claim.text}</p><small>{claim.evidenceIds.length ? claim.evidenceIds.join(' · ') : label(locale, '无关联证据', 'No linked evidence')}</small></div>
            </div>
          ))}
        </div>
      ) : null}

      {task.spec.allowLocalTest ? (
        <div className="opsTestsSection">
          <div className="opsSectionHeading"><Icon name="terminal" /><strong>{label(locale, '本地验证', 'Local verification')}</strong></div>
          {canRunLocalTest ? (
            <div className="opsTestControls">
              <select value={selectedTestId} onChange={(event) => setSelectedTestId(event.target.value)} disabled={busy || testRunning || localTests.length === 0} aria-label={label(locale, '选择测试', 'Select test')}>
                {localTests.map((test) => (
                  <option value={test.testId} key={test.testId}>{test.label}</option>
                ))}
              </select>
              <button type="button" onClick={() => onRunTest?.(selectedTestId)} disabled={busy || testRunning || !selectedTestId}>
                <Icon name="play" />{label(locale, '运行', 'Run')}
              </button>
            </div>
          ) : null}
          {testRuns.length > 0 ? (
            <div className="opsTestRunList">
              {testRuns.slice(-5).reverse().map((run) => (
                <article className={`opsTestRun opsTestRun-${run.status}`} key={run.testRunId}>
                  <strong>{run.testId}</strong><span>{run.status}</span>
                  {run.outputSummary ? <pre>{run.outputSummary}</pre> : null}
                  {run.errorSummary ? <p>{run.errorSummary}</p> : null}
                </article>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="opsInspectorFooter">
        {!terminal && canPause ? <button type="button" onClick={() => onAction?.('pause')} disabled={busy}><Icon name="pause" />{label(locale, '暂停', 'Pause')}</button> : null}
        {!terminal && canResume ? <button type="button" onClick={() => onAction?.('resume')} disabled={busy}><Icon name="play" />{label(locale, '继续', 'Resume')}</button> : null}
      {!terminal ? <button type="button" onClick={() => onAction?.('cancel')} disabled={busy}><Icon name="x" />{label(locale, '取消任务', 'Cancel')}</button> : null}
      {terminal && task.state !== 'cancelled' ? <button type="button" onClick={onSaveIncident} disabled={busy}><Icon name="file" />{label(locale, '保存事故', 'Save incident')}</button> : null}
      <span className="opsInspectorEventCount">{events.length} {label(locale, '条事件', 'events')}</span>
      </footer>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value: number): string {
  if (value < 1000) return '<1s';
  return `${(value / 1000).toFixed(1)} s`;
}
