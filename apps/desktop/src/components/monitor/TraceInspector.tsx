import { useState } from 'react';
import { presentSuanliziError } from '@suanlizi/protocol';
import type { RunTraceEnvelope } from '@suanlizi/protocol';
import type { RunRecord } from '../../shared/types.js';
import {
  formatDuration,
  traceCategoryLabel,
  traceIcon,
  traceEventNameLabel,
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
  const [zhLabelsOverride, setZhLabelsOverride] = useState<boolean | null>(null);
  const zhLabels = zhLabelsOverride ?? zh;
  const fieldLabel = (key: string) => (zhLabels && FIELD_LABELS[key]) || key;

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
          <div className="traceInspector__category">{traceCategoryLabel(selectedTrace.category, zhLabels)}</div>
          <div className="traceInspector__name">{zhLabels ? traceEventNameLabel(selectedTrace.name, zhLabels) : selectedTrace.name}</div>
        </div>
        <div className="traceInspector__actions">
          <button type="button" className="traceInspector__copyBtn" onClick={onCopyJson} title="复制当前追踪事件的原始 JSON">
            {zhLabels ? '复制 JSON' : 'Copy JSON'}
          </button>
          <button type="button" className="traceInspector__copyBtn" onClick={() => setZhLabelsOverride(!zhLabels)}>
            {zhLabels ? 'EN' : '中文'}
          </button>
        </div>
      </div>
      <div className="traceInspector__body">
        <div className="traceInspector__section">
          <h4 className="traceInspector__sectionTitle">{zh ? '详细信息' : 'Details'}</h4>
          <TypedFields trace={selectedTrace} zh={zhLabels} fieldLabel={fieldLabel} />
        </div>
        <div className="traceInspector__section">
          <h4 className="traceInspector__sectionTitle">{zh ? '通用字段' : 'Common fields'}</h4>
          <div className="inspectorGrid">
            <Field label={fieldLabel('sequence')} value={String(selectedTrace.sequence)} mono />
            <Field label={fieldLabel('eventId')} value={selectedTrace.eventId} mono />
            {selectedTrace.spanId ? <Field label={fieldLabel('spanId')} value={selectedTrace.spanId} mono /> : null}
            {selectedTrace.parentSpanId ? <Field label={fieldLabel('parentSpanId')} value={selectedTrace.parentSpanId} mono /> : null}
            {selectedTrace.turnId ? <Field label={fieldLabel('turnId')} value={selectedTrace.turnId} mono /> : null}
            <Field label={fieldLabel('occurredAt')} value={new Date(selectedTrace.occurredAt).toLocaleString()} />
            <Field label={fieldLabel('level')} value={selectedTrace.level} />
            <Field label={fieldLabel('lifecycle')} value={selectedTrace.lifecycle} />
            {selectedTrace.durationMs != null ? (
              <Field label={fieldLabel('durationMs')} value={formatDuration(selectedTrace.durationMs)} />
            ) : null}
            {selectedTrace.itemId ? <Field label={fieldLabel('itemId')} value={selectedTrace.itemId} mono /> : null}
            {selectedTrace.runKind ? <Field label={fieldLabel('runKind')} value={selectedTrace.runKind} /> : null}
          </div>
        </div>

      </div>
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  provider: '提供商',
  model: '模型',
  attempt: '尝试',
  streaming: '流式',
  ttftMs: '首字耗时',
  inputTokens: '输入 Token',
  outputTokens: '输出 Token',
  cacheReadTokens: '缓存读取',
  cacheWriteTokens: '缓存写入',
  finishReason: '结束原因',
  duration: '耗时',
  durationMs: '耗时',
  resourceKind: '资源类型',
  server: '服务',
  tool: '工具',
  toolName: '工具名',
  skillName: '技能名',
  callId: '调用 ID',
  decision: '决策',
  approvalId: '审批 ID',
  exitCode: '退出码',
  outputBytes: '输出字节',
  itemType: '条目类型',
  itemId: '条目 ID',
  status: '状态',
  action: '动作',
  path: '路径',
  addedLines: '新增行',
  removedLines: '删除行',
  code: '错误码',
  message: '消息',
  retryable: '可重试',
  source: '来源',
  checkpointId: '检查点 ID',
  turnCount: '轮数',
  itemIndex: '条目序号',
  role: '角色',
  childRunId: '子运行 ID',
  agentThreadId: 'Agent 线程 ID',
  outcome: '结果',
  reason: '原因',
  inputItemCount: '输入条目数',
  index: '序号',
  phase: '阶段',
  recordCount: '记录数',
  omittedContent: '遗漏内容',
  estimatedTokens: '估算 Token',
  sequence: '序号',
  eventId: '事件 ID',
  spanId: 'Span ID',
  parentSpanId: '父 Span ID',
  turnId: '轮次 ID',
  occurredAt: '发生时间',
  level: '级别',
  lifecycle: '生命周期',
  runKind: '运行类型',
  access: '访问',
  agentRole: 'Agent 角色',
  grantId: '授权 ID',
  requestId: '请求 ID',
  scope: '范围',
  matchedRuleId: '匹配规则 ID',
  matchedRuleScope: '匹配规则范围',
  middlewareId: '中间件 ID',
  stage: '阶段',
  kind: '类型',
  label: '标签',
  passed: '是否通过',
};

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
      <span className={`inspectorField__label ${/^[A-Za-z][A-Za-z0-9]*$/.test(label) ? '' : 'inspectorField__label--zh'}`}>{label}</span>
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

function TypedFields({ trace, zh, fieldLabel }: {
  trace: RunTraceEnvelope;
  zh: boolean;
  fieldLabel(key: string): string;
}) {
  const p = trace.payload as Record<string, unknown>;
  const has = (k: string) => p[k] != null;
  const str = (k: string) => String(p[k] ?? '');
  const num = (k: string) => Number(p[k]);
  const bool = (k: string) => Boolean(p[k]);

  switch (trace.category) {
    case 'model':
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('provider')} value={str('provider')} />
          <Field label={fieldLabel('model')} value={str('model')} />
          <Field label={fieldLabel('attempt')} value={str('attempt')} />
          <Field label={fieldLabel('streaming')} value="" badge={bool('streaming') ? (zh ? '是' : 'yes') : (zh ? '否' : 'no')} badgeTone={bool('streaming') ? 'info' : 'neutral'} />
          {has('ttftMs') ? <Field label={fieldLabel('ttftMs')} value={formatDuration(num('ttftMs'))} /> : null}
          {has('inputTokens') ? <Field label={fieldLabel('inputTokens')} value={str('inputTokens')} /> : null}
          {has('outputTokens') ? <Field label={fieldLabel('outputTokens')} value={str('outputTokens')} /> : null}
          {has('cacheReadTokens') ? <Field label={fieldLabel('cacheReadTokens')} value={str('cacheReadTokens')} /> : null}
          {has('cacheWriteTokens') ? <Field label={fieldLabel('cacheWriteTokens')} value={str('cacheWriteTokens')} /> : null}
          {has('finishReason') ? <Field label={fieldLabel('finishReason')} value={str('finishReason')} /> : null}
          {trace.durationMs != null ? <Field label={fieldLabel('duration')} value={formatDuration(trace.durationMs)} /> : null}
        </div>
      );
    case 'tool': {
      const decision = p.decision as string | undefined;
      const decisionTone = decision === 'allow' ? 'success' : decision === 'deny' ? 'danger' : decision === 'approval_required' ? 'warning' : 'neutral';
      const resource = traceResourceDetails(trace);
      return (
        <div className="inspectorGrid">
          {resource ? <Field label={fieldLabel('resourceKind')} value="" badge={resource.kind} badgeTone={resource.kind === 'MCP' ? 'info' : resource.kind === 'Skill' ? 'success' : 'neutral'} /> : null}
          {resource?.server ? <Field label={fieldLabel('server')} value={resource.server} /> : null}
          {resource?.tool ? <Field label={fieldLabel('tool')} value={resource.tool} /> : null}
          {resource?.skillName ? <Field label={fieldLabel('skillName')} value={resource.skillName} /> : null}
          <Field label={fieldLabel('toolName')} value={str('toolName')} />
          <Field label={fieldLabel('callId')} value={str('callId')} mono />
          {decision ? <Field label={fieldLabel('decision')} value="" badge={decision} badgeTone={decisionTone} /> : null}
          {has('approvalId') ? <Field label={fieldLabel('approvalId')} value={str('approvalId')} mono /> : null}
          {has('exitCode') ? (
            <Field label={fieldLabel('exitCode')} value={str('exitCode')} badge={str('exitCode')} badgeTone={num('exitCode') === 0 ? 'success' : 'danger'} />
          ) : null}
          {has('outputBytes') ? <Field label={fieldLabel('outputBytes')} value={str('outputBytes')} /> : null}
          {trace.durationMs != null ? <Field label={fieldLabel('duration')} value={formatDuration(trace.durationMs)} /> : null}
          {has('argsSummary') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label inspectorField__label--zh">{zh ? '参数' : 'args'}</span>
              <PreBlock value={p.argsSummary} />
            </div>
          ) : null}
          {has('resultSummary') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label inspectorField__label--zh">{zh ? '结果' : 'result'}</span>
              <PreBlock value={p.resultSummary} />
            </div>
          ) : null}
        </div>
      );
    }
    case 'item':
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('itemType')} value={str('itemType')} />
          {has('status') ? <Field label={fieldLabel('status')} value={str('status')} /> : null}
          {trace.itemId ? <Field label={fieldLabel('itemId')} value={trace.itemId} mono /> : null}
        </div>
      );
    case 'file': {
      const action = p.action as string | undefined;
      const actionTone = action === 'read' ? 'info' : action === 'write' || action === 'patch' ? 'warning' : action === 'delete' ? 'danger' : 'neutral';
      return (
        <div className="inspectorGrid">
          {action ? <Field label={fieldLabel('action')} value="" badge={action} badgeTone={actionTone} /> : null}
          <div className="inspectorField inspectorField--full">
            <span className="inspectorField__label">{fieldLabel('path')}</span>
            <span className="inspectorField__value inspectorField__value--mono">{str('path')}</span>
          </div>
          {has('addedLines') ? <Field label={fieldLabel('addedLines')} value={`+${p.addedLines}`} badge={`+${p.addedLines}`} badgeTone="success" /> : null}
          {has('removedLines') ? <Field label={fieldLabel('removedLines')} value={`-${p.removedLines}`} badge={`-${p.removedLines}`} badgeTone="danger" /> : null}
        </div>
      );
    }
    case 'error':
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('code')} value={str('code')} mono badge={str('code')} badgeTone="danger" />
          <div className="inspectorField inspectorField--full">
            <span className="inspectorField__label inspectorField__label--zh">{zh ? '说明' : 'Summary'}</span>
            <span className="inspectorField__value" style={{ color: '#ef4444' }}>{presentSuanliziError(p as never, str('message'), zh ? 'zh' : 'en').summary}</span>
          </div>
          <div className="inspectorField inspectorField--full">
            <span className="inspectorField__label">{fieldLabel('message')}</span>
            <span className="inspectorField__value inspectorField__value--prewrap" style={{ color: '#ef4444' }}>{str('message')}</span>
          </div>
          <Field label={fieldLabel('retryable')} value="" badge={bool('retryable') ? (zh ? '可重试' : 'retryable') : (zh ? '不可重试' : 'not retryable')} badgeTone={bool('retryable') ? 'warning' : 'danger'} />
          {has('source') ? <Field label={fieldLabel('source')} value={str('source')} /> : null}
        </div>
      );
    case 'checkpoint': {
      const status = p.status as string | undefined;
      const statusTone = status === 'valid' ? 'success' : status === 'invalid' ? 'danger' : 'neutral';
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('checkpointId')} value={str('checkpointId')} mono />
          <Field label={fieldLabel('turnCount')} value={str('turnCount')} />
          <Field label={fieldLabel('itemIndex')} value={str('itemIndex')} />
          {status ? <Field label={fieldLabel('status')} value="" badge={status} badgeTone={statusTone} /> : null}
        </div>
      );
    }
    case 'agent': {
      const action = p.action as string | undefined;
      const actionTone = action === 'spawn' || action === 'started' ? 'info' : action === 'joined' ? 'success' : action === 'failed' || action === 'interrupted' ? 'danger' : 'neutral';
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('role')} value={str('role')} />
          {action ? <Field label={fieldLabel('action')} value="" badge={action} badgeTone={actionTone} /> : null}
          {has('childRunId') ? <Field label={fieldLabel('childRunId')} value={str('childRunId')} mono /> : null}
          {has('agentThreadId') ? <Field label={fieldLabel('agentThreadId')} value={str('agentThreadId')} mono /> : null}
        </div>
      );
    }
    case 'control': {
      const outcome = p.outcome as string | undefined;
      const outcomeTone = outcome === 'accepted' || outcome === 'completed' ? 'success' : outcome === 'rejected' ? 'danger' : outcome === 'requested' ? 'warning' : 'neutral';
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('action')} value={str('action')} badge={str('action')} badgeTone="info" />
          {outcome ? <Field label={fieldLabel('outcome')} value="" badge={outcome} badgeTone={outcomeTone} /> : null}
          {has('checkpointId') ? <Field label={fieldLabel('checkpointId')} value={str('checkpointId')} mono /> : null}
          {has('reason') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label">{fieldLabel('reason')}</span>
              <span className="inspectorField__value" style={{ color: outcome === 'rejected' ? '#ef4444' : undefined }}>{str('reason')}</span>
            </div>
          ) : null}
        </div>
      );
    }
    case 'turn':
      return (
        <div className="inspectorGrid">
          {has('status') ? <Field label={fieldLabel('status')} value={str('status')} /> : null}
          {has('inputItemCount') ? <Field label={fieldLabel('inputItemCount')} value={str('inputItemCount')} /> : null}
          {has('reason') ? <Field label={fieldLabel('reason')} value={str('reason')} /> : null}
        </div>
      );
    case 'iteration':
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('index')} value={str('index')} />
          {has('outcome') ? <Field label={fieldLabel('outcome')} value={str('outcome')} /> : null}
        </div>
      );
    case 'context':
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('phase')} value={str('phase')} />
          {has('estimatedTokens') ? <Field label={fieldLabel('estimatedTokens')} value={str('estimatedTokens')} /> : null}
          {trace.durationMs != null ? <Field label={fieldLabel('duration')} value={formatDuration(trace.durationMs)} /> : null}
          {p.sourceCounts && typeof p.sourceCounts === 'object' ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label inspectorField__label--zh">{zh ? '来源计数' : 'sourceCounts'}</span>
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
              <span className="inspectorField__label">{fieldLabel('omittedContent')}</span>
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
          <Field label={fieldLabel('phase')} value={str('phase')} />
          {has('recordCount') ? <Field label={fieldLabel('recordCount')} value={str('recordCount')} /> : null}
          {trace.durationMs != null ? <Field label={fieldLabel('duration')} value={formatDuration(trace.durationMs)} /> : null}
          {p.scoreBuckets && typeof p.scoreBuckets === 'object' ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label inspectorField__label--zh">{zh ? '分数分布' : 'scoreBuckets'}</span>
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
          <Field label={fieldLabel('middlewareId')} value={str('middlewareId')} />
          <Field label={fieldLabel('stage')} value={str('stage')} />
          {has('attempt') ? <Field label={fieldLabel('attempt')} value={str('attempt')} /> : null}
        </div>
      );
    case 'evidence': {
      const passed = p.passed;
      const passedBool = typeof passed === 'boolean';
      return (
        <div className="inspectorGrid">
          <Field label={fieldLabel('kind')} value={str('kind')} />
          <Field label={fieldLabel('label')} value={str('label')} />
          {passedBool ? (
            <Field label={fieldLabel('passed')} value="" badge={passed ? '✓' : '✗'} badgeTone={passed ? 'success' : 'danger'} />
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
          {decision ? <Field label={fieldLabel('decision')} value="" badge={decision} badgeTone={tone} /> : null}
          {status ? <Field label={fieldLabel('status')} value="" badge={status} badgeTone={tone} /> : null}
          {has('source') ? <Field label={fieldLabel('source')} value={str('source')} /> : null}
          {has('access') ? <Field label={fieldLabel('access')} value={str('access')} /> : null}
          {has('toolName') ? <Field label={fieldLabel('toolName')} value={str('toolName')} /> : null}
          {has('requestId') ? <Field label={fieldLabel('requestId')} value={str('requestId')} mono /> : null}
          {has('scope') ? <Field label={fieldLabel('scope')} value={str('scope')} /> : null}
          {has('grantId') ? <Field label={fieldLabel('grantId')} value={str('grantId')} mono /> : null}
          {has('matchedRuleId') ? <Field label={fieldLabel('matchedRuleId')} value={str('matchedRuleId')} mono /> : null}
          {has('matchedRuleScope') ? <Field label={fieldLabel('matchedRuleScope')} value={str('matchedRuleScope')} /> : null}
          {has('agentRole') ? <Field label={fieldLabel('agentRole')} value={str('agentRole')} /> : null}
          {has('agentThreadId') ? <Field label={fieldLabel('agentThreadId')} value={str('agentThreadId')} mono /> : null}
          {has('target') ? (
            <div className="inspectorField inspectorField--full">
              <span className="inspectorField__label inspectorField__label--zh">{zh ? '访问目标' : 'target'}</span>
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
            <Field key={k} label={fieldLabel(k)} value={String(v)} />
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
