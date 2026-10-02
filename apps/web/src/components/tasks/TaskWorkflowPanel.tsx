// Dynamic Workflow 面板：展示 GoalRun 按需提出的提案，或用户显式创建的独立受限脚本工作流。
// 提案必须经用户审阅、可选编辑与批准后才会执行；普通 Harness 与静态 Blueprint Workflow 均不在此处出现。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from '../../config/config.js';
import { Icon } from '../Icon.js';
import {
  approveWorkflowRequest,
  cancelWorkflowRun,
  fetchWorkflowRequests,
  fetchWorkflowRunResult,
  fetchWorkflowScripts,
  rejectWorkflowRequest,
  startWorkflowRun,
  WORKFLOW_TERMINAL_STATUSES,
  type WorkflowPendingRequest,
  type WorkflowRunResult,
  type WorkflowScriptHistoryEntry,
} from '../../api/workflowScriptClient.js';
import { diffScripts } from '../../features/workflow/workflowScriptCost.js';
import {
  shouldRefreshWorkflowRequests,
  shouldRefreshWorkflowRun,
  TASK_EVENT_REFRESH_DEBOUNCE_MS,
} from '../../features/tasks/taskEventRefresh.js';

const POLL_INTERVAL_MS = 1500;

type LocalStyles = Record<string, React.CSSProperties>;

const panel: LocalStyles = {
  empty: {
    padding: '8px 0',
    color: 'var(--nx-muted)',
    fontSize: 12,
    lineHeight: 1.6,
  },
  requestItem: {
    padding: '8px 10px',
    border: '1px solid var(--nx-border)',
    borderRadius: 6,
    fontSize: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    minWidth: 0,
  },
  requestTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--nx-text)',
  },
  toolRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  smallButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 9px',
    border: '1px solid var(--nx-border)',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--nx-text)',
    cursor: 'pointer',
    fontSize: 12,
  },
  smallButtonDisabled: {
    opacity: 0.5,
    cursor: 'default',
  },
  primaryButton: {
    color: 'var(--nx-blue)',
    borderColor: 'var(--nx-blue)',
  },
  dangerButton: {
    color: 'var(--nx-danger)',
    borderColor: 'var(--nx-danger)',
  },
  textarea: {
    width: '100%',
    minHeight: 156,
    padding: '8px 10px',
    border: '1px solid var(--nx-border)',
    borderRadius: 6,
    background: 'var(--nx-bg)',
    color: 'var(--nx-text)',
    fontFamily: 'var(--nx-mono, monospace)',
    fontSize: 12,
    lineHeight: 1.5,
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  faint: { color: 'var(--nx-muted)', fontSize: 12 },
  inlineError: {
    marginTop: 8,
    fontSize: 12,
    color: 'var(--nx-danger)',
    wordBreak: 'break-word',
  },
  diff: {
    color: 'var(--nx-muted)',
    fontSize: 12,
  },
  runBlock: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid var(--nx-border)',
  },
  runRow: {
    display: 'flex',
    gap: 9,
    alignItems: 'baseline',
    flexWrap: 'wrap',
    fontSize: 12,
  },
  callList: {
    marginTop: 7,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  callItem: {
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
    padding: '4px 8px',
    border: '1px solid var(--nx-border)',
    borderRadius: 6,
    minWidth: 0,
    fontSize: 12,
  },
  callPrompt: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  history: {
    marginTop: 10,
    paddingTop: 8,
    borderTop: '1px solid var(--nx-border)',
    color: 'var(--nx-muted)',
    fontSize: 12,
  },
  historyList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    margin: '7px 0 0',
    padding: 0,
    listStyle: 'none',
  },
};

const STATUS_LABEL: Record<string, { zh: string; en: string }> = {
  queued: { zh: '排队中', en: 'Queued' },
  running: { zh: '运行中', en: 'Running' },
  completed: { zh: '已完成', en: 'Completed' },
  failed: { zh: '失败', en: 'Failed' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  interrupted: { zh: '已中断', en: 'Interrupted' },
  blocked: { zh: '等待批准', en: 'Awaiting approval' },
};

function statusLabel(status: string, locale: Locale): string {
  const entry = STATUS_LABEL[status];
  return entry ? (locale === 'en' ? entry.en : entry.zh) : status;
}

/** 从提案 meta 读取名称；异常或没有 meta 时回退为首行摘要。 */
function scriptSummary(script: string): string {
  const match = /name:\s*["']([^"']+)["']/.exec(script);
  if (match?.[1]) return match[1];
  return (script.split('\n').find((line) => line.trim()) ?? '动态工作流提案').slice(0, 72);
}

export interface TaskWorkflowPanelProps {
  locale: Locale;
  taskId: string;
  /** 用任务所属线程订阅实时事件，提案/运行发生后无需重开面板。 */
  threadId?: string;
  /** true 时为用户直接创建的 Dynamic Workflow，不把它伪装成 Goal 的附属物。 */
  standalone?: boolean;
}

export interface WorkflowRequestListProps {
  locale: Locale;
  requests: WorkflowPendingRequest[];
  busy: boolean;
  editingRequestId: string | null;
  editedScript: string;
  onReview(request: WorkflowPendingRequest): void;
  onEditedScriptChange(script: string): void;
  onCancelReview(): void;
  onApproveOriginal(request: WorkflowPendingRequest): void;
  onApproveEdited(request: WorkflowPendingRequest, script: string): void;
  onReject(request: WorkflowPendingRequest): void;
}

/**
 * 每一项都是 GoalRun 已落库的提案。编辑器只会在用户明确点击「审阅并编辑」后出现，
 * 因此这里不会退化为可任意启动的 JS 工作流控制台。
 */
export function WorkflowRequestList({
  locale,
  requests,
  busy,
  editingRequestId,
  editedScript,
  onReview,
  onEditedScriptChange,
  onCancelReview,
  onApproveOriginal,
  onApproveEdited,
  onReject,
}: WorkflowRequestListProps) {
  if (requests.length === 0) return null;
  const zh = locale !== 'en';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={panel.faint}>{zh ? '等待你批准的动态工作流提案' : 'Dynamic workflow proposals awaiting your approval'}</div>
      {requests.map((request) => {
        const editing = editingRequestId === request.id;
        const edited = editing && editedScript !== request.script ? editedScript : null;
        const diff = edited ? diffScripts(request.script, edited) : null;
        const noEditedChanges = !edited || diff?.identical;
        return (
          <div key={request.id} style={panel.requestItem}>
            <span style={panel.requestTitle} title={request.script}>
              <strong>{scriptSummary(request.script)}</strong>
            </span>
            <span style={panel.faint} title={request.goalRunId ?? request.taskRunId}>
              {request.goalRunId
                ? `${zh ? '来源 Goal Run：' : 'Goal Run: '}${request.goalRunId}`
                : (zh ? '独立 Dynamic Workflow' : 'Standalone Dynamic Workflow')}
            </span>

            {editing ? (
              <>
                <textarea
                  style={panel.textarea}
                  aria-label={zh ? '动态工作流提案脚本' : 'Dynamic workflow proposal script'}
                  value={editedScript}
                  disabled={busy}
                  onChange={(event) => onEditedScriptChange(event.target.value)}
                />
                {diff && !diff.identical ? (
                  <span style={panel.diff}>
                    {zh ? '编辑差异：' : 'Edited: '}
                    +{diff.added} / -{diff.removed}{zh ? ' 行' : ' lines'}
                  </span>
                ) : null}
              </>
            ) : null}

            <div style={panel.toolRow}>
              {!editing ? (
                <button
                  type="button"
                  style={{ ...panel.smallButton, ...(busy ? panel.smallButtonDisabled : {}) }}
                  disabled={busy}
                  onClick={() => onReview(request)}
                >
                  <Icon name="file" />
                  <span>{zh ? '审阅并编辑' : 'Review and edit'}</span>
                </button>
              ) : null}
              {editing ? (
                <button
                  type="button"
                  style={{
                    ...panel.smallButton,
                    ...panel.primaryButton,
                    ...(busy || noEditedChanges ? panel.smallButtonDisabled : {}),
                  }}
                  disabled={busy || noEditedChanges}
                  onClick={() => onApproveEdited(request, editedScript)}
                >
                  <Icon name="play" />
                  <span>{zh ? '批准编辑后提案' : 'Approve edited proposal'}</span>
                </button>
              ) : null}
              <button
                type="button"
                style={{ ...panel.smallButton, ...panel.primaryButton, ...(busy ? panel.smallButtonDisabled : {}) }}
                disabled={busy}
                onClick={() => onApproveOriginal(request)}
              >
                <Icon name="play" />
                <span>{zh ? '批准原提案' : 'Approve original'}</span>
              </button>
              {editing ? (
                <button
                  type="button"
                  style={{ ...panel.smallButton, ...(busy ? panel.smallButtonDisabled : {}) }}
                  disabled={busy}
                  onClick={onCancelReview}
                >
                  <Icon name="x" />
                  <span>{zh ? '取消编辑' : 'Cancel edit'}</span>
                </button>
              ) : null}
              <button
                type="button"
                style={{ ...panel.smallButton, ...panel.dangerButton, ...(busy ? panel.smallButtonDisabled : {}) }}
                disabled={busy}
                onClick={() => onReject(request)}
              >
                <Icon name="stopCircle" />
                <span>{zh ? '拒绝' : 'Reject'}</span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TaskWorkflowPanel({ locale, taskId, threadId, standalone = false }: TaskWorkflowPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<WorkflowPendingRequest[]>([]);
  const [scripts, setScripts] = useState<WorkflowScriptHistoryEntry[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [result, setResult] = useState<WorkflowRunResult | null>(null);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [editedScript, setEditedScript] = useState('');
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  activeRunIdRef.current = activeRunId;

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (eventTimer.current) clearTimeout(eventTimer.current);
  }, []);

  const loadRequests = useCallback(async (id: string) => {
    try {
      const next = await fetchWorkflowRequests(id);
      setRequests(Array.isArray(next.requests) ? next.requests : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const pollResult = useCallback((runId: string) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      try {
        const next = await fetchWorkflowRunResult(runId);
        setResult(next);
        if (!WORKFLOW_TERMINAL_STATUSES.has(next.run.status)) {
          pollResult(runId);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        pollResult(runId);
      }
    }, POLL_INTERVAL_MS);
  }, []);

  const loadScripts = useCallback(async (id: string) => {
    try {
      const next = await fetchWorkflowScripts(id);
      const nextScripts = Array.isArray(next.scripts) ? next.scripts : [];
      setScripts(nextScripts);
      const active = nextScripts.find((item) => !WORKFLOW_TERMINAL_STATUSES.has(item.status));
      if (active) {
        setActiveRunId(active.runId);
        pollResult(active.runId);
      }
    } catch {
      // 历史仅为辅助信息，失败不能阻断 Goal 的提案审批。
      setScripts([]);
    }
  }, [pollResult]);

  useEffect(() => {
    setError(null);
    setRequests([]);
    setScripts([]);
    setResult(null);
    setActiveRunId(null);
    setEditingRequestId(null);
    setEditedScript('');
    void loadRequests(taskId);
    void loadScripts(taskId);
  }, [taskId, loadRequests, loadScripts]);

  useEffect(() => {
    if (!threadId || typeof EventSource === 'undefined') return undefined;
    const source = new EventSource(`/api/events/${encodeURIComponent(threadId)}`);
    const schedule = (job: () => void) => {
      if (eventTimer.current) clearTimeout(eventTimer.current);
      eventTimer.current = setTimeout(job, TASK_EVENT_REFRESH_DEBOUNCE_MS);
    };
    source.onmessage = (message: MessageEvent) => {
      const data = typeof message.data === 'string' ? message.data : '';
      if (shouldRefreshWorkflowRequests(data)) {
        schedule(() => {
          void loadRequests(taskId);
          void loadScripts(taskId);
        });
        return;
      }
      if (shouldRefreshWorkflowRun(data)) {
        schedule(() => {
          const runId = activeRunIdRef.current;
          if (runId) pollResult(runId);
          void loadScripts(taskId);
        });
      }
    };
    return () => {
      source.close();
      if (eventTimer.current) clearTimeout(eventTimer.current);
    };
  }, [threadId, taskId, loadRequests, loadScripts, pollResult]);

  const handleApprove = async (request: WorkflowPendingRequest, script?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const decided = await approveWorkflowRequest(request.id, script);
      setRequests((current) => current.filter((item) => item.id !== decided.runId));
      setEditingRequestId(null);
      setEditedScript('');
      setActiveRunId(decided.runId);
      setResult(null);
      pollResult(decided.runId);
      void loadScripts(taskId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async (request: WorkflowPendingRequest) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const decided = await rejectWorkflowRequest(request.id);
      setRequests((current) => current.filter((item) => item.id !== decided.runId));
      if (editingRequestId === request.id) {
        setEditingRequestId(null);
        setEditedScript('');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!activeRunId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelWorkflowRun(activeRunId);
      pollResult(activeRunId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async () => {
    if (!result || busy) return;
    const original = scripts.find((item) => item.runId === result.run.id)?.script;
    if (!original) {
      setError(locale === 'en' ? 'The original approved workflow script is unavailable.' : '找不到本次运行已批准的原始工作流脚本，无法恢复。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 只复用该运行已持久化的原始脚本；不允许从临时编辑区派生一次恢复运行。
      const started = await startWorkflowRun(taskId, original, undefined, result.run.id);
      setActiveRunId(started.runId);
      setResult(null);
      pollResult(started.runId);
      void loadScripts(taskId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runStatus = result?.run.status;
  const running = Boolean(activeRunId && runStatus && !WORKFLOW_TERMINAL_STATUSES.has(runStatus));
  const hasWorkflowActivity = requests.length > 0 || result !== null || scripts.length > 0;

  return (
    <div>
      {!hasWorkflowActivity ? (
        <div style={panel.empty}>
          {standalone
            ? (locale === 'en'
              ? 'This Dynamic Workflow has no pending script or run record yet.'
              : '当前 Dynamic Workflow 没有待审脚本或运行记录。')
            : (locale === 'en'
              ? 'This Goal has not proposed a dynamic workflow. A Goal Run will request one only when it needs decomposition, parallel work, or an alternative path.'
              : '当前 Goal 尚未提出动态工作流。只有 Goal Run 需要拆分、并行或替代路径时，才会向你提交提案。')}
        </div>
      ) : null}

      <WorkflowRequestList
        locale={locale}
        requests={requests}
        busy={busy}
        editingRequestId={editingRequestId}
        editedScript={editedScript}
        onReview={(request) => {
          setEditingRequestId(request.id);
          setEditedScript(request.script);
          setError(null);
        }}
        onEditedScriptChange={setEditedScript}
        onCancelReview={() => {
          setEditingRequestId(null);
          setEditedScript('');
        }}
        onApproveOriginal={(request) => void handleApprove(request)}
        onApproveEdited={(request, script) => void handleApprove(request, script)}
        onReject={(request) => void handleReject(request)}
      />

      {error ? <div style={panel.inlineError}>{error}</div> : null}

      {result ? (
        <div style={panel.runBlock}>
          <div style={panel.runRow}>
            <strong>{locale === 'en' ? 'Dynamic workflow' : '动态工作流'}</strong>
            <span>{statusLabel(result.run.status, locale)}</span>
            <span style={panel.faint}>{result.run.usage.agentCallCount} agent · {result.run.usage.inputTokens + result.run.usage.outputTokens} tokens</span>
            {result.run.evidenceId ? <span style={panel.faint}>{locale === 'en' ? 'Evidence attached' : '已附证据'}</span> : null}
            {running ? (
              <button
                type="button"
                style={{ ...panel.smallButton, ...panel.dangerButton, ...(busy ? panel.smallButtonDisabled : {}) }}
                disabled={busy}
                onClick={() => void handleCancel()}
              >
                <Icon name="stopCircle" />
                <span>{locale === 'en' ? 'Stop workflow' : '停止工作流'}</span>
              </button>
            ) : null}
            {result.run.status === 'failed' || result.run.status === 'interrupted' ? (
              <button
                type="button"
                style={{ ...panel.smallButton, ...panel.primaryButton, ...(busy ? panel.smallButtonDisabled : {}) }}
                disabled={busy}
                onClick={() => void handleResume()}
              >
                <Icon name="refresh" />
                <span>{locale === 'en' ? 'Resume original workflow' : '恢复原工作流'}</span>
              </button>
            ) : null}
          </div>
          {result.agentCalls.length ? (
            <div style={panel.callList}>
              {result.agentCalls.map((call) => (
                <div key={call.id} style={panel.callItem}>
                  <span style={panel.faint}>{statusLabel(call.status, locale)}</span>
                  <span style={panel.callPrompt} title={call.prompt}>{call.label ? `${call.label} · ` : ''}{call.prompt}</span>
                  <span style={panel.faint}>{call.inputTokens + call.outputTokens} tok</span>
                  {call.evidenceId ? <span style={panel.faint}>{locale === 'en' ? 'evidence' : '证据'}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {scripts.length ? (
        <details style={panel.history}>
          <summary>{locale === 'en' ? `Workflow history (${scripts.length})` : `动态工作流记录（${scripts.length}）`}</summary>
          <ul style={panel.historyList}>
            {scripts.map((item) => (
              <li key={item.runId}>
                <span>{scriptSummary(item.script)}</span>
                <span style={panel.faint}> · {statusLabel(item.status, locale)} · {item.usage.agentCallCount} agent</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}