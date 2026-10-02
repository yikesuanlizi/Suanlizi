import type { RunTraceEnvelope } from '@suanlizi/protocol';
import type { ThreadItem } from '../../shared/types.js';

export type AgentResourceKind = 'MCP' | 'Skill' | 'Tool' | 'Shell' | 'File' | 'Document' | 'Agent';

export interface AgentResource {
  kind: AgentResourceKind;
  label: string;
}

/** Activity rows and resource stats share one user-readable resource model. */
export function resourceUsageFromItem(item: ThreadItem): AgentResource | null {
  if (item.type === 'mcp_tool_call') {
    return { kind: 'MCP', label: [item.server || 'mcp', item.tool || item.toolName || 'tool'].join(' / ') };
  }
  if (item.type === 'tool_call') {
    if (item.toolName === 'read_document') return { kind: 'Document', label: documentResourceLabel(item) || item.toolName };
    if (isSkillToolName(item.toolName)) return { kind: 'Skill', label: readSkillLabel(item) || item.toolName || 'skill' };
    return { kind: 'Tool', label: item.toolName || 'tool' };
  }
  if (item.type === 'collab_tool_call') return { kind: 'Agent', label: item.tool || 'collab_tool' };
  if (item.type === 'command_execution') return { kind: 'Shell', label: truncateText(item.command, 54) || 'shell' };
  if (item.type === 'file_change') return { kind: 'File', label: itemLabel(item) };
  return null;
}

export function resourceUsageFromTrace(trace: RunTraceEnvelope): AgentResource | null {
  const payload = trace.payload as Record<string, unknown>;
  if (trace.category === 'tool') {
    const toolName = readString(payload.toolName);
    const resourceKind = readString(payload.resourceKind);
    const server = readString(payload.server);
    const tool = readString(payload.tool);
    const skillName = readString(payload.skillName);
    if (resourceKind === 'mcp' || server || toolName === 'mcp_call_tool') {
      return { kind: 'MCP', label: [server || 'mcp', tool || toolName || 'tool'].join(' / ') };
    }
    if (resourceKind === 'skill' || skillName || isSkillToolName(toolName)) {
      return { kind: 'Skill', label: skillName || toolName || 'skill' };
    }
    if (resourceKind === 'shell' || ['shell_command', 'command_execution', 'exec_command'].includes(toolName)) {
      return { kind: 'Shell', label: toolName || 'shell' };
    }
    if (resourceKind === 'agent') return { kind: 'Agent', label: tool || toolName || 'agent' };
    return { kind: 'Tool', label: toolName || trace.name };
  }
  if (trace.category === 'file') {
    const path = readString(payload.sourcePath) || readString(payload.path);
    return { kind: isDocumentPath(path) ? 'Document' : 'File', label: baseFileName(path) || trace.name };
  }
  if (trace.category === 'approval') {
    const target = readStringDeep(payload.target, ['path', 'url', 'command', 'kind']);
    if (target) return { kind: isDocumentPath(target) ? 'Document' : 'File', label: baseFileName(target) || target };
    return { kind: 'Tool', label: readString(payload.toolName) || trace.name };
  }
  if (trace.category === 'agent') return { kind: 'Agent', label: readString(payload.role) || trace.name };
  return null;
}

function itemLabel(item: ThreadItem): string {
  if (item.type === 'file_change') {
    const changes = item.changes ?? [];
    const firstPath = changes[0]?.path;
    const count = changes.length;
    if (firstPath) return count > 1 ? baseFileName(firstPath) + ' +' + (count - 1) : baseFileName(firstPath);
    return 'File change';
  }
  return item.toolName || item.command || item.tool || item.message || item.text || item.type;
}

function isDocumentPath(filePath: string): boolean {
  return /\.(docx?|pdf|md|txt|xlsx?|pptx?)$/i.test(filePath);
}

function isSkillToolName(toolName: string | undefined): boolean {
  return Boolean(toolName && /^(skill|skills)(?:_|$)/i.test(toolName));
}

function readSkillLabel(item: ThreadItem): string {
  return readStringDeep(item.arguments, ['skillName', 'skill', 'name'])
    || readStringDeep(item.result, ['skillName', 'skill', 'name'])
    || readFirstInstalledSkillName(item.result);
}

function readFirstInstalledSkillName(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const installed = (value as { installed?: unknown }).installed;
  if (!Array.isArray(installed)) return '';
  for (const entry of installed) {
    const name = readStringDeep(entry, ['name', 'skillName']);
    if (name) return name;
  }
  return '';
}

function documentResourceLabel(item: ThreadItem): string {
  const result = asRecord(item.result);
  const source = asRecord(result.source);
  const args = asRecord(item.arguments);
  return baseFileName(readStringDeep(source, ['path', 'relativePath'])
    || readStringDeep(args, ['filePath', 'path']));
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringDeep(value: unknown, keys: string[]): string {
  const record = asRecord(value);
  for (const key of keys) {
    const next = record[key];
    if (typeof next === 'string' && next.trim()) return next.trim();
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function baseFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function truncateText(text: string | undefined, limit: number): string {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : normalized.slice(0, limit) + '…';
}
