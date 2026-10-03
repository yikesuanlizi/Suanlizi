import type { RunTraceCategory, RunTraceEnvelope, RunTraceLifecycle } from '@suanlizi/protocol';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';

export function traceIcon(category: RunTraceCategory): string {
  const icons: Record<RunTraceCategory, string> = {
    turn: '💬',
    iteration: '🔄',
    context: '📚',
    memory: '🧠',
    middleware: '🔌',
    model: '🤖',
    tool: '🔧',
    item: '📄',
    agent: '👤',
    file: '📁',
    checkpoint: '📍',
    evidence: '✅',
    approval: '🛂',
    error: '❌',
    control: '🎮',
    browser: '🌐',
  };
  return icons[category] ?? '•';
}

export function traceCategoryLabel(category: RunTraceCategory, zh: boolean): string {
  const labels: Record<RunTraceCategory, { zh: string; en: string }> = {
    turn: { zh: '对话轮次', en: 'Turn' },
    iteration: { zh: '迭代', en: 'Iteration' },
    context: { zh: '上下文', en: 'Context' },
    memory: { zh: '记忆', en: 'Memory' },
    middleware: { zh: '中间件', en: 'Middleware' },
    model: { zh: '模型调用', en: 'Model' },
    tool: { zh: '工具调用', en: 'Tool' },
    item: { zh: '消息条目', en: 'Item' },
    agent: { zh: '智能体', en: 'Agent' },
    file: { zh: '文件操作', en: 'File' },
    checkpoint: { zh: '检查点', en: 'Checkpoint' },
    evidence: { zh: '验证证据', en: 'Evidence' },
    approval: { zh: '授权决策', en: 'Approval' },
    error: { zh: '错误', en: 'Error' },
    control: { zh: '控制指令', en: 'Control' },
    browser: { zh: '浏览器动作', en: 'Browser' },
  };
  return zh ? labels[category].zh : labels[category].en;
}

export function traceLifecycleDot(lifecycle: RunTraceLifecycle): { color: string; label: string } {
  const dots: Record<RunTraceLifecycle, { color: string; label: string }> = {
    started: { color: '#94a3b8', label: '○' },
    completed: { color: '#22c55e', label: '●' },
    failed: { color: '#ef4444', label: '●' },
    discarded: { color: '#6b7280', label: '✕' },
    instant: { color: '#0284c7', label: '●' },
  };
  return dots[lifecycle] ?? dots.instant;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

function stringifyValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function traceSummary(trace: RunTraceEnvelope, zh: boolean): string {
  const p = trace.payload as Record<string, unknown>;
  const category = trace.category as string;
  switch (category) {
    case 'model': {
      const provider = p.provider as string | undefined;
      const model = p.model as string | undefined;
      const tokens = [p.inputTokens, p.outputTokens].filter((v): v is number => typeof v === 'number').reduce((a, b) => a + b, 0);
      const parts: string[] = [];
      if (provider && model) parts.push(`${provider}/${model}`);
      else if (model) parts.push(model);
      if (tokens > 0) parts.push(zh ? `${tokens} tokens` : `${tokens} tokens`);
      if (p.finishReason) parts.push(String(p.finishReason));
      return parts.join(' · ') || trace.name;
    }
    case 'tool': {
      const toolName = p.toolName as string | undefined;
      const resourceKind = p.resourceKind as string | undefined;
      const server = p.server as string | undefined;
      const tool = p.tool as string | undefined;
      const skillName = p.skillName as string | undefined;
      const decision = p.decision as string | undefined;
      const exitCode = p.exitCode as number | undefined;
      if (resourceKind === 'mcp' || server || toolName === 'mcp_call_tool') {
        return `MCP · ${[server || 'mcp', tool || toolName || 'tool'].join(' / ')}`;
      }
      if (resourceKind === 'skill' || skillName || /^(skill|skills)(?:_|$)/i.test(toolName ?? '') || trace.name.toLowerCase().includes('skill')) {
        return `Skill · ${skillName || toolName || trace.name}`;
      }
      const parts: string[] = [];
      if (toolName) parts.push(toolName);
      if (decision === 'deny') parts.push(zh ? '已拒绝' : 'denied');
      else if (decision === 'approval_required') parts.push(zh ? '待审批' : 'approval required');
      if (typeof exitCode === 'number' && exitCode !== 0) parts.push(`exit=${exitCode}`);
      return parts.join(' · ') || trace.name;
    }
    case 'item': {
      const itemType = p.itemType as string | undefined;
      const status = p.status as string | undefined;
      const parts: string[] = [];
      if (itemType) parts.push(itemType);
      if (status) parts.push(status);
      return parts.join(' · ') || (zh ? '消息条目' : 'Item');
    }
    case 'file': {
      const action = p.action as string | undefined;
      const path = p.path as string | undefined;
      const sourcePath = p.sourcePath as string | undefined;
      const artifactPath = p.artifactPath as string | undefined;
      const staleReason = p.staleReason as string | undefined;
      const extractor = p.extractor as string | undefined;
      const added = p.addedLines as number | undefined;
      const removed = p.removedLines as number | undefined;
      const parts: string[] = [];
      if (action) parts.push(fileActionLabel(action, zh));
      const sourceName = sourcePath || path ? fileBaseName(sourcePath || path || '') : '';
      const targetName = artifactPath ? fileBaseName(artifactPath) : sourcePath && path ? fileBaseName(path) : '';
      if (sourceName && targetName && sourceName !== targetName) {
        parts.push(`${truncate(sourceName, 30)} → ${truncate(targetName, 30)}`);
      } else if (sourceName) {
        parts.push(truncate(sourceName, 30));
      }
      if (added || removed) parts.push(`+${added ?? 0}/-${removed ?? 0}`);
      if (staleReason) parts.push(staleReason);
      if (extractor) parts.push(extractor);
      return parts.join(' · ') || trace.name;
    }
    case 'error': {
      const code = p.code as string | undefined;
      const message = p.message as string | undefined;
      const parts: string[] = [];
      if (message) parts.push(truncate(formatSuanliziErrorMessage(undefined, message, zh ? 'zh' : 'en'), 80));
      else if (code) parts.push(truncate(formatSuanliziErrorMessage(undefined, code, zh ? 'zh' : 'en'), 80));
      return parts.join(': ') || trace.name;
    }
    case 'checkpoint': {
      const checkpointId = p.checkpointId as string | undefined;
      const turnCount = p.turnCount as number | undefined;
      const status = p.status as string | undefined;
      const parts: string[] = [];
      if (typeof turnCount === 'number') parts.push(zh ? `回合 ${turnCount}` : `turn ${turnCount}`);
      if (status) parts.push(status);
      if (checkpointId) parts.push(truncate(checkpointId, 12));
      return parts.join(' · ') || trace.name;
    }
    case 'agent': {
      const role = p.role as string | undefined;
      const action = p.action as string | undefined;
      const childRunId = p.childRunId as string | undefined;
      const parts: string[] = [];
      if (role) parts.push(role);
      if (action) parts.push(action);
      if (childRunId) parts.push(truncate(childRunId, 8));
      return parts.join(' · ') || trace.name;
    }
    case 'control': {
      const action = p.action as string | undefined;
      const outcome = p.outcome as string | undefined;
      const reason = p.reason as string | undefined;
      const parts: string[] = [];
      if (action) parts.push(action);
      if (outcome) parts.push(outcome);
      if (reason && outcome === 'rejected') parts.push(truncate(reason, 40));
      return parts.join(' · ') || trace.name;
    }
    case 'turn': {
      const status = p.status as string | undefined;
      const inputItemCount = p.inputItemCount as number | undefined;
      const parts: string[] = [];
      if (status) parts.push(status);
      if (typeof inputItemCount === 'number') parts.push(zh ? `${inputItemCount} 条输入` : `${inputItemCount} inputs`);
      return parts.join(' · ') || trace.name;
    }
    case 'iteration': {
      const index = p.index as number | undefined;
      const outcome = p.outcome as string | undefined;
      const parts: string[] = [];
      if (typeof index === 'number') parts.push(`#${index}`);
      if (outcome) parts.push(truncate(outcome, 40));
      return parts.join(' · ') || trace.name;
    }
    case 'context': {
      const phase = p.phase as string | undefined;
      const sourceCounts = p.sourceCounts as Record<string, number> | undefined;
      const estimatedTokens = p.estimatedTokens as number | undefined;
      const parts: string[] = [];
      if (phase) parts.push(phase);
      if (sourceCounts) {
        const total = Object.values(sourceCounts).reduce((a, b) => a + b, 0);
        parts.push(zh ? `${total} 个来源` : `${total} sources`);
      }
      if (typeof estimatedTokens === 'number') parts.push(zh ? `≈${estimatedTokens} tokens` : `≈${estimatedTokens} tokens`);
      return parts.join(' · ') || trace.name;
    }
    case 'memory': {
      const phase = p.phase as string | undefined;
      const recordCount = p.recordCount as number | undefined;
      const parts: string[] = [];
      if (phase) parts.push(phase);
      if (typeof recordCount === 'number') parts.push(zh ? `${recordCount} 条记录` : `${recordCount} records`);
      return parts.join(' · ') || trace.name;
    }
    case 'middleware': {
      const middlewareId = p.middlewareId as string | undefined;
      const stage = p.stage as string | undefined;
      const parts: string[] = [];
      if (middlewareId) parts.push(middlewareId);
      if (stage) parts.push(stage);
      return parts.join(' · ') || trace.name;
    }
    case 'evidence': {
      const kind = p.kind as string | undefined;
      const label = p.label as string | undefined;
      const passed = p.passed as boolean | undefined;
      const parts: string[] = [];
      if (kind) parts.push(kind);
      if (label) parts.push(truncate(label, 30));
      if (typeof passed === 'boolean') parts.push(passed ? (zh ? '通过' : 'passed') : (zh ? '未通过' : 'failed'));
      return parts.join(' · ') || trace.name;
    }
    case 'approval': {
      const decision = p.decision as string | undefined;
      const status = p.status as string | undefined;
      const access = p.access as string | undefined;
      const toolName = p.toolName as string | undefined;
      const target = formatAccessTarget(p.target);
      const agentRole = p.agentRole as string | undefined;
      const source = p.source as string | undefined;
      const parts: string[] = [];
      const label = approvalDecisionLabel(decision, status, zh);
      if (label) parts.push(label);
      if (access) parts.push(access);
      if (toolName) parts.push(toolName);
      if (target) parts.push(truncate(target, 42));
      if (agentRole) parts.push(agentRole);
      if (source) parts.push(source);
      return parts.join(' · ') || trace.name;
    }
    default:
      return trace.name || '';
  }
}

export function formatDuration(ms: number | undefined): string {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return '<1s';
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m${secs}s`;
}

export function formatRelativeTime(iso: string, zh: boolean): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return zh ? '刚刚' : 'just now';
    if (diffMins < 60) return zh ? `${diffMins}分钟前` : `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return zh ? `${diffHours}小时前` : `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return zh ? `${diffDays}天前` : `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

export function formatAbsoluteTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function fileActionLabel(action: string, zh: boolean): string {
  const labels: Record<string, { zh: string; en: string }> = {
    read: { zh: '读取', en: 'read' },
    write: { zh: '写入', en: 'write' },
    patch: { zh: '修改', en: 'patch' },
    delete: { zh: '删除', en: 'delete' },
    checkpoint: { zh: '检查点', en: 'checkpoint' },
    extract: { zh: '提取', en: 'extract' },
    stale: { zh: '过期', en: 'stale' },
    refresh: { zh: '刷新', en: 'refresh' },
    reuse: { zh: '复用', en: 'reuse' },
  };
  const label = labels[action];
  return zh ? (label?.zh ?? action) : (label?.en ?? action);
}

function fileBaseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function approvalDecisionLabel(decision: string | undefined, status: string | undefined, zh: boolean): string {
  const key = decision ?? status ?? '';
  const labels: Record<string, { zh: string; en: string }> = {
    allow: { zh: '允许', en: 'allow' },
    prompt: { zh: '请求临时授权', en: 'prompt' },
    deny: { zh: '拒绝', en: 'deny' },
    required: { zh: '等待授权', en: 'required' },
    granted: { zh: '临时允许', en: 'granted' },
    denied: { zh: '临时拒绝', en: 'denied' },
  };
  const label = labels[key];
  return zh ? (label?.zh ?? key) : (label?.en ?? key);
}

function formatAccessTarget(target: unknown): string {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return '';
  const record = target as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : '';
  const command = typeof record.command === 'string' ? record.command : '';
  const url = typeof record.url === 'string' ? record.url : '';
  const kind = typeof record.kind === 'string' ? record.kind : '';
  return path || command || url || kind;
}

export function runStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return '#22c55e';
    case 'failed':
    case 'blocked':
      return '#ef4444';
    case 'interrupted':
      return '#f97316';
    case 'completed':
    case 'pending':
    default:
      return '#94a3b8';
  }
}

export function runStatusLabel(status: string, zh: boolean): string {
  const labels: Record<string, { zh: string; en: string }> = {
    pending: { zh: '等待中', en: 'Pending' },
    running: { zh: '运行中', en: 'Running' },
    completed: { zh: '已完成', en: 'Completed' },
    failed: { zh: '失败', en: 'Failed' },
    interrupted: { zh: '已中断', en: 'Interrupted' },
    blocked: { zh: '已阻塞', en: 'Blocked' },
  };
  return zh ? (labels[status]?.zh ?? status) : (labels[status]?.en ?? status);
}

export { stringifyValue, truncate };

const EVENT_NAME_LABELS: Record<string, string> = {
  'run.started': '运行开始',
  'run.completed': '运行完成',
  'run.failed': '运行失败',
  'run.cancelled': '运行取消',
  'turn.started': '轮次开始',
  'turn.completed': '轮次完成',
  'turn.failed': '轮次失败',
  'item.started': '消息条目开始',
  'item.updated': '消息条目更新',
  'item.completed': '消息条目完成',
  'tool.started': '工具调用开始',
  'tool.completed': '工具调用完成',
  'tool.failed': '工具调用失败',
  'middleware.beforeTool': '工具调用前中间件',
  'middleware.afterTool': '工具调用后中间件',
};

export function traceEventNameLabel(name: string, zh = true): string {
  if (!zh) return name;
  return EVENT_NAME_LABELS[name] ?? name;
}