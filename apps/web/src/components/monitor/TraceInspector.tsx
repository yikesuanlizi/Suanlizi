import { useState } from 'react';
import { presentSuanliziError } from '@suanlizi/protocol';
import type { RunTraceEnvelope } from '@suanlizi/protocol';
import type { RunRecord } from '../../shared/types.js';
import {
  formatDuration,
  traceCategoryLabel,
  traceIcon,
} from '../../features/monitor/traceFormatters.js';

interface TraceInspectorProps {
  selectedTrace: RunTraceEnvelope | null;
  selectedRun: RunRecord | null;
  zh: boolean;
  onBack?(): void;
  onCopyJson(): void;
}

export function TraceInspector({
  selectedTrace,
  zh,
  onBack,
  onCopyJson,
}: TraceInspectorProps) {
  const [jsonOpen, setJsonOpen] = useState(false);

  if (!selectedTrace) {
    return (
      <div className="traceInspector">
        <div className="traceInspector__empty">
          {zh ? '选择一个 trace 查看详情' : 'Select a trace to see details'}
        </div>
      </div>
    );
  }

  return (
    <div className="traceInspector">
      <div className="traceInspector__header">
        {onBack ? (
          <button
            type="button"
            className="traceInspector__back"
            onClick={onBack}
            aria-label={zh ? '返回' : 'Back'}
          >
            ←
          </button>
        ) : null}
        <span className="traceInspector__icon">{traceIcon(selectedTrace.category)}</span>
        <div className="traceInspector__titleWrap">
          <div className="traceInspector__category">{traceCategoryLabel(selectedTrace.category, zh)}</div>
          <div className="traceInspector__name">{selectedTrace.name}</div>
        </div>
      </div>
      <div className="traceInspector__body">
        <div className="traceInspector__section">
          <h4 className="traceInspector__sectionTitle">{zh ? '详细信息' : 'Details'}</h4>
          <TypedFields trace={selectedTrace} zh={zh} />
        </div>
        <div className="traceInspector__section">
          <h4 className="traceInspector__sectionTitle">{zh ? '通用字段' : 'Common fields'}</h4>
          <div className="inspectorGrid">
            <Field label="sequence" value={String(selectedTrace.sequence)} mono />
            <Field label="eventId" value={selectedTrace.eventId} mono />
            {selectedTrace.spanId ? <Field label="spanId" value={selectedTrace.spanId} mono /> : null}
            {selectedTrace.parentSpanId ? <Field label="parentSpanId" value={selectedTrace.parentSpanId} mono /> : null}
            {selectedTrace.turnId ? <Field label="turnId" value={selectedTrace.turnId} mono /> : null}
            <Field label="occurredAt" value={new Date(selectedTrace.occurredAt).toLocaleString()} />
            <Field label="level" value={selectedTrace.level} />
            <Field label="lifecycle" value={selectedTrace.lifecycle} />
            {selectedTrace.durationMs != null ? (
              <Field label="durationMs" value={formatDuration(selectedTrace.durationMs)} />
            ) : null}
            {selectedTrace.itemId ? <Field label="itemId" value={selectedTrace.itemId} mono /> : null}
            {selectedTrace.runKind ? <Field label="runKind" value={selectedTrace.runKind} /> : null}
          </div>
        </div>
        <details className="traceInspector__json" open={jsonOpen} onToggle={(e) => setJsonOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="traceInspector__jsonSummary">
            {zh ? '查看 JSON' : 'View JSON'}
            <button
              type="button"
              className="traceInspector__copyBtn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCopyJson();
              }}
            >
              {zh ? '复制' : 'Copy'}
            </button>
          </summary>
          <pre className="traceInspector__jsonPre">
            {JSON.stringify(selectedTrace.payload, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  badge,
  badgeTone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: string;
  badgeTone?: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
}) {
  return (
    <div className="inspectorField">
      <span className="inspectorField__label">{label}</span>
      <span className={`inspectorField__value ${mono ? 'inspectorField__value--mono' : ''}`}>
        {badge ? (
          <span className={`inspectorBadge inspectorBadge--${badgeTone ?? 'neutral'}`}>{badge}</span>
        ) : null}
        {value}
      </span>
    </div>
  );
}

function PreBlock({ value, maxBytes = 2048 }: { value: unknown; maxBytes?: number }) {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  const truncated = text.length > maxBytes;
  const display = truncated ? text.slice(0, maxBytes) + `… (${text.length} chars total)` : text;
  return <pre className="inspectorPre">{display}</pre>;
}

function TypedFields({ trace, zh }: { trace: RunTraceEnvelope; zh: boolean }) {
  const p = trace.payload as Record<string, unknown>;
  const has = (k: string) => p[k] != null;
  const str = (k: string) => String(p[k] ?? '');
  const num = (k: string) => Number(p[k]);
  const bool = (k: string) => Boolean(p[k]);

  switch (trace.category) {
    case 'model':
      return (
        <div className="inspectorGrid">
          <Field label="provider" value={str('provider')} />
          <Field label="model" value={str('model')} />
          <Field label="attempt" value={str('attempt')} />
          <Field label="streaming" value="" badge={bool('streaming') ? (zh ? '是' : 'yes') : (zh ? '否' : 'no')} badgeTone={bool('streaming') ? 'info' : 'neutral'} />
          {has('ttftMs') ? <Field label="ttftMs" value={formatDuration(num('ttftMs'))} /> : null}
          {has('inputTokens') ? <Field label="inputTokens" value={str('inputTokens')} /> : null}
          {has('outputTokens') ? <Field label="outputTokens" value={str('outputTokens')} /> : null}
          {has('cacheReadTokens') ? <Field label="cacheReadTokens" value={str('cacheReadTokens')} /> : null}
          {has('cacheWriteTokens') ? <Field label="cacheWriteTokens" value={str('cacheWriteTokens')} /> : null}
          {has('finishReason') ? <Field label="finishReason" value={str('finishReason')} /> : null}
          {trace.durationMs != null ? <Field label="duration" value={formatDuration(trace.durationMs)} /> : null}
        </div>
      );
    case 'tool': {
      const decision = p.decision as string | undefined;
      const decisionTone = decision === 'allow' ? 'success' : decision === 'deny' ? 'danger' : decision === 'approval_required' ? 'warning' : 'neutral';
      const resource = traceResourceDetails(trace);
      return (
        <div className="inspectorGrid">
          {resource ? <Field label="resourceKind" value="" badge={resource.kind} badgeTone={resource.kind === 'MCP' ? 'info' : resource.kind === 'Skill' ? 'success' : 'neutral'} /> : null}
          {resource?.server ? <Field label="server" value={resource.server} /> : null}
          {resource?.tool ? <Field label="tool" value={resource.tool} /> : null}
          {resource?.skillName ? <Field label="skillName" value={resource.skillName} /> : null}
          <Field label="toolName" value={str('toolName')} />
          <Field label="callId" value={str('callId')} mono />
          {decision ? <Field label="decision" value="" badge={decision} badgeTone={decisionTone} /> : null}
          {has('approvalId') ? <Field label="approvalId" value={str('approvalId')} mono /> : null}
          {has('exitCode') ? (
            <Field label="exitCode" value={str('exitCode')} badge={str('exitCode')} badgeTone={num('exitCode') === 0 ? 'success' : 'danger'} />
          ) : null}
          {has('outputBytes') ? <Field label="outputBytes" value={str('outputBytes')} /> : null}
          {trace.durationMs != null ? <Field label="duration" value={formatDuration(trace.durationMs)} /> : null}
          {has('argsSummary') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label">{zh ? '参数' : 'args'}</span>
              <PreBlock value={p.argsSummary} />
            </div>
          ) : null}
          {has('resultSummary') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label">{zh ? '结果' : 'result'}</span>
              <PreBlock value={p.resultSummary} />
            </div>
          ) : null}
        </div>
      );
    }
    case 'item':
      return (
        <div className="inspectorGrid">
          <Field label="itemType" value={str('itemType')} />
          {has('status') ? <Field label="status" value={str('status')} /> : null}
          {trace.itemId ? <Field label="itemId" value={trace.itemId} mono /> : null}
        </div>
      );
    case 'file': {
      const action = p.action as string | undefined;
      const actionTone = action === 'read' ? 'info' : action === 'write' || action === 'patch' ? 'warning' : action === 'delete' ? 'danger' : 'neutral';
      return (
        <div className="inspectorGrid">
          {action ? <Field label="action" value="" badge={action} badgeTone={actionTone} /> : null}
          <div className="inspectorField inspectorField--full">
            <span className="inspectorField__label">path</span>
            <span className="inspectorField__value inspectorField__value--mono">{str('path')}</span>
          </div>
          {has('addedLines') ? <Field label="addedLines" value={`+${p.addedLines}`} badge={`+${p.addedLines}`} badgeTone="success" /> : null}
          {has('removedLines') ? <Field label="removedLines" value={`-${p.removedLines}`} badge={`-${p.removedLines}`} badgeTone="danger" /> : null}
        </div>
      );
    }
    case 'error':
      return (
        <div className="inspectorGrid">
          <Field label="code" value={str('code')} mono badge={str('code')} badgeTone="danger" />
          <div className="inspectorField inspectorField--full">
            <span className="inspectorField__label">{zh ? '说明' : 'Summary'}</span>
            <span className="inspectorField__value" style={{ color: '#ef4444' }}>{presentSuanliziError(p as never, str('message'), zh ? 'zh' : 'en').summary}</span>
          </div>
          <div className="inspectorField inspectorField--full">
            <span className="inspectorField__label">message</span>
            <span className="inspectorField__value inspectorField__value--prewrap" style={{ color: '#ef4444' }}>{str('message')}</span>
          </div>
          <Field label="retryable" value="" badge={bool('retryable') ? (zh ? '可重试' : 'retryable') : (zh ? '不可重试' : 'not retryable')} badgeTone={bool('retryable') ? 'warning' : 'danger'} />
          {has('source') ? <Field label="source" value={str('source')} /> : null}
        </div>
      );
    case 'checkpoint': {
      const status = p.status as string | undefined;
      const statusTone = status === 'valid' ? 'success' : status === 'invalid' ? 'danger' : 'neutral';
      return (
        <div className="inspectorGrid">
          <Field label="checkpointId" value={str('checkpointId')} mono />
          <Field label="turnCount" value={str('turnCount')} />
          <Field label="itemIndex" value={str('itemIndex')} />
          {status ? <Field label="status" value="" badge={status} badgeTone={statusTone} /> : null}
        </div>
      );
    }
    case 'agent': {
      const action = p.action as string | undefined;
      const actionTone = action === 'spawn' || action === 'started' ? 'info' : action === 'joined' ? 'success' : action === 'failed' || action === 'interrupted' ? 'danger' : 'neutral';
      return (
        <div className="inspectorGrid">
          <Field label="role" value={str('role')} />
          {action ? <Field label="action" value="" badge={action} badgeTone={actionTone} /> : null}
          {has('childRunId') ? <Field label="childRunId" value={str('childRunId')} mono /> : null}
          {has('agentThreadId') ? <Field label="agentThreadId" value={str('agentThreadId')} mono /> : null}
        </div>
      );
    }
    case 'control': {
      const outcome = p.outcome as string | undefined;
      const outcomeTone = outcome === 'accepted' || outcome === 'completed' ? 'success' : outcome === 'rejected' ? 'danger' : outcome === 'requested' ? 'warning' : 'neutral';
      return (
        <div className="inspectorGrid">
          <Field label="action" value={str('action')} badge={str('action')} badgeTone="info" />
          {outcome ? <Field label="outcome" value="" badge={outcome} badgeTone={outcomeTone} /> : null}
          {has('checkpointId') ? <Field label="checkpointId" value={str('checkpointId')} mono /> : null}
          {has('reason') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label">reason</span>
              <span className="inspectorField__value" style={{ color: outcome === 'rejected' ? '#ef4444' : undefined }}>{str('reason')}</span>
            </div>
          ) : null}
        </div>
      );
    }
    case 'turn':
      return (
        <div className="inspectorGrid">
          {has('status') ? <Field label="status" value={str('status')} /> : null}
          {has('inputItemCount') ? <Field label="inputItemCount" value={str('inputItemCount')} /> : null}
          {has('reason') ? <Field label="reason" value={str('reason')} /> : null}
        </div>
      );
    case 'iteration':
      return (
        <div className="inspectorGrid">
          <Field label="index" value={str('index')} />
          {has('outcome') ? <Field label="outcome" value={str('outcome')} /> : null}
        </div>
      );
    case 'context':
      return (
        <div className="inspectorGrid">
          <Field label="phase" value={str('phase')} />
          {has('estimatedTokens') ? <Field label="estimatedTokens" value={str('estimatedTokens')} /> : null}
          {trace.durationMs != null ? <Field label="duration" value={formatDuration(trace.durationMs)} /> : null}
          {p.sourceCounts && typeof p.sourceCounts === 'object' ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label">{zh ? '来源计数' : 'sourceCounts'}</span>
              <div className="inspectorSourceCounts">
                {Object.entries(p.sourceCounts as Record<string, number>).map(([k, v]) => (
                  <span key={k} className="inspectorSourceCount">
                    <span className="inspectorSourceCount__key">{k}</span>
                    <span className="inspectorSourceCount__value">{v}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {has('omittedContent') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label"></span>
              <span className="inspectorField__value" style={{ color: '#f97316' }}>
                {zh ? '⚠ 部分内容已省略' : '⚠ Some content omitted'}
              </span>
            </div>
          ) : null}
        </div>
      );
    case 'memory':
      return (
        <div className="inspectorGrid">
          <Field label="phase" value={str('phase')} />
          {has('recordCount') ? <Field label="recordCount" value={str('recordCount')} /> : null}
          {trace.durationMs != null ? <Field label="duration" value={formatDuration(trace.durationMs)} /> : null}
          {p.scoreBuckets && typeof p.scoreBuckets === 'object' ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label">{zh ? '分数分布' : 'scoreBuckets'}</span>
              <div className="inspectorSourceCounts">
                {Object.entries(p.scoreBuckets as Record<string, number>).map(([k, v]) => (
                  <span key={k} className="inspectorSourceCount">
                    <span className="inspectorSourceCount__key">{k}</span>
                    <span className="inspectorSourceCount__value">{v}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      );
    case 'middleware':
      return (
        <div className="inspectorGrid">
          <Field label="middlewareId" value={str('middlewareId')} />
          <Field label="stage" value={str('stage')} />
          {has('attempt') ? <Field label="attempt" value={str('attempt')} /> : null}
        </div>
      );
    case 'evidence': {
      const passed = p.passed;
      const passedBool = typeof passed === 'boolean';
      return (
        <div className="inspectorGrid">
          <Field label="kind" value={str('kind')} />
          <Field label="label" value={str('label')} />
          {passedBool ? (
            <Field label="passed" value="" badge={passed ? '✓' : '✗'} badgeTone={passed ? 'success' : 'danger'} />
          ) : null}
        </div>
      );
    }
    case 'approval': {
      const decision = p.decision as string | undefined;
      const status = p.status as string | undefined;
      const tone = decision === 'allow' || status === 'granted'
        ? 'success'
        : decision === 'deny' || status === 'denied'
          ? 'danger'
          : 'warning';
      return (
        <div className="inspectorGrid">
          {decision ? <Field label="decision" value="" badge={decision} badgeTone={tone} /> : null}
          {status ? <Field label="status" value="" badge={status} badgeTone={tone} /> : null}
          {has('source') ? <Field label="source" value={str('source')} /> : null}
          {has('access') ? <Field label="access" value={str('access')} /> : null}
          {has('toolName') ? <Field label="toolName" value={str('toolName')} /> : null}
          {has('requestId') ? <Field label="requestId" value={str('requestId')} mono /> : null}
          {has('scope') ? <Field label="scope" value={str('scope')} /> : null}
          {has('grantId') ? <Field label="grantId" value={str('grantId')} mono /> : null}
          {has('matchedRuleId') ? <Field label="matchedRuleId" value={str('matchedRuleId')} mono /> : null}
          {has('matchedRuleScope') ? <Field label="matchedRuleScope" value={str('matchedRuleScope')} /> : null}
          {has('agentRole') ? <Field label="agentRole" value={str('agentRole')} /> : null}
          {has('agentThreadId') ? <Field label="agentThreadId" value={str('agentThreadId')} mono /> : null}
          {has('target') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label">{zh ? '访问目标' : 'target'}</span>
              <PreBlock value={p.target} />
            </div>
          ) : null}
        </div>
      );
    }
    default:
      return (
        <div className="inspectorGrid">
          {Object.entries(p).map(([k, v]) => (
            <Field key={k} label={k} value={String(v)} />
          ))}
        </div>
      );
  }
}

function traceResourceDetails(trace: RunTraceEnvelope): { kind: 'MCP' | 'Skill' | 'Shell' | 'Tool'; server?: string; tool?: string; skillName?: string } | null {
  const p = trace.payload as Record<string, unknown>;
  const toolName = typeof p.toolName === 'string' ? p.toolName : '';
  const resourceKind = typeof p.resourceKind === 'string' ? p.resourceKind : '';
  const server = typeof p.server === 'string' ? p.server : '';
  const tool = typeof p.tool === 'string' ? p.tool : '';
  const skillName = typeof p.skillName === 'string' ? p.skillName : readStringFromObject(p.argsSummary, ['skillName', 'skill', 'name']);
  if (resourceKind === 'mcp' || server || toolName === 'mcp_call_tool') {
    return { kind: 'MCP', server: server || undefined, tool: tool || undefined };
  }
  if (resourceKind === 'skill' || skillName || /^(skill|skills)(?:_|$)/i.test(toolName) || trace.name.toLowerCase().includes('skill')) {
    return { kind: 'Skill', skillName: skillName || undefined };
  }
  if (resourceKind === 'shell' || toolName === 'shell_command' || toolName === 'command_execution' || toolName === 'exec_command') {
    return { kind: 'Shell', tool: toolName };
  }
  if (toolName) return { kind: 'Tool', tool: toolName };
  return null;
}

function readStringFromObject(value: unknown, keys: string[]): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const next = record[key];
    if (typeof next === 'string' && next.trim()) return next.trim();
  }
  return '';
}
