// P5：历史脚本区 —— 查看已运行脚本、载入编辑、与当前脚本对比（行级差异摘要）。
// 只接收明确 props 并管理局部展开状态；取数与写回由调用方（TaskWorkflowPanel）承担。
// — Chinese: workflow script history viewer with load / compare.

import React, { useState } from 'react';
import type { Locale } from '../../config/config.js';
import type { WorkflowScriptHistoryEntry } from '../../api/workflowScriptClient.js';
import { diffScripts } from '../../features/workflow/workflowScriptCost.js';
import { Icon } from '../Icon.js';

const styles: { readonly [key: string]: React.CSSProperties } = {
  wrap: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 },
  title: { color: 'var(--nx-muted)', fontSize: 12 },
  item: {
    padding: '4px 8px',
    border: '1px solid var(--nx-border)',
    borderRadius: 6,
    fontSize: 12,
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
    minWidth: 0,
  },
  label: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  faint: { color: 'var(--nx-muted)', fontSize: 12, whiteSpace: 'nowrap' },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    border: '1px solid var(--nx-border)',
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
  },
  diff: {
    margin: '2px 0 0',
    paddingLeft: 10,
    borderLeft: '2px solid var(--nx-border)',
    color: 'var(--nx-muted)',
    fontSize: 11,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  diffLine: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};

export interface WorkflowScriptHistoryProps {
  locale: Locale;
  scripts: WorkflowScriptHistoryEntry[];
  /** 当前编辑区脚本（用于对比基准）。 */
  currentScript: string;
  onLoad: (entry: WorkflowScriptHistoryEntry) => void;
}

export function WorkflowScriptHistory({ locale, scripts, currentScript, onLoad }: WorkflowScriptHistoryProps) {
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  if (scripts.length === 0) return null;
  const zh = locale !== 'en';

  return (
    <div style={styles.wrap}>
      <div style={styles.title}>{zh ? '历史脚本' : 'Saved scripts'}</div>
      {scripts.map((entry) => {
        const expanded = expandedHash === entry.scriptHash;
        const diff = diffScripts(entry.script, currentScript);
        return (
          <div key={entry.scriptHash} style={{ minWidth: 0 }}>
            <div style={styles.item}>
              <span style={styles.label} title={entry.script}>
                {entry.scriptHash.slice(0, 8)}
                <span style={styles.faint}>
                  {' · '}
                  {entry.usage.inputTokens + entry.usage.outputTokens} tok · {entry.usage.agentCallCount} agent
                </span>
              </span>
              <span style={styles.faint}>{zh ? statusZh(entry.status) : entry.status}</span>
              <button type="button" style={styles.button} onClick={() => onLoad(entry)}>
                <Icon name="file" />
                <span>{zh ? '载入' : 'Load'}</span>
              </button>
              <button
                type="button"
                style={styles.button}
                aria-expanded={expanded}
                onClick={() => setExpandedHash(expanded ? null : entry.scriptHash)}
              >
                <Icon name="branch" />
                <span>{zh ? '对比' : 'Compare'}</span>
              </button>
            </div>
            {expanded ? (
              <div style={styles.faint}>
                {diff.identical
                  ? (zh ? '与当前脚本一致' : 'Identical to current script')
                  : `+${diff.added} / -${diff.removed}${zh ? ' 行' : ' lines'}`}
                {!diff.identical && diff.samples.length > 0 ? (
                  <ul style={styles.diff}>
                    {diff.samples.map((sample, index) => (
                      <li key={`${sample.kind}-${index}`} style={styles.diffLine} title={sample.text}>
                        {sample.kind === 'added' ? '+ ' : '- '}
                        {sample.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function statusZh(status: string): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'blocked':
      return '待批准';
    case 'interrupted':
      return '已中断';
    case 'running':
      return '运行中';
    default:
      return status;
  }
}
