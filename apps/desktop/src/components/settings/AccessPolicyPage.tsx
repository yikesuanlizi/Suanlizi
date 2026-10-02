import React from 'react';
import type { AccessKind, AccessPolicyConfig, AccessRule, AccessRuleScope, AccessTarget } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';

export type AccessPolicySettingsScope = 'global' | 'workspace' | 'currentThread';

export interface AccessPolicyPageProps {
  locale: Locale;
  value: AccessPolicyConfig;
  scope: AccessPolicySettingsScope;
  currentWorkspaceAvailable?: boolean;
  currentWorkspaceRoot?: string;
  workspaceRoots?: string[];
  selectedWorkspaceRoot?: string;
  currentThreadAvailable: boolean;
  currentThreadId?: string;
  saving: boolean;
  notice: string;
  onScopeChange: (scope: AccessPolicySettingsScope) => void;
  onWorkspaceChange?: (workspaceRoot: string) => void;
  onChange: (value: AccessPolicyConfig) => void;
  onSave: () => void;
  onReload: () => void;
}

function text(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

function modeLabel(mode: AccessPolicyConfig['mode'], locale: Locale): string {
  if (mode === 'chat') return text(locale, '对话', 'Chat');
  if (mode === 'danger_full_access') return text(locale, '完全访问', 'Full access');
  return text(locale, '工作区', 'Workspace');
}

function modeDescription(mode: AccessPolicyConfig['mode'], locale: Locale): string {
  if (mode === 'chat') return text(locale, '仅允许对话相关的有限操作', 'Limited actions for chat only');
  if (mode === 'danger_full_access') return text(locale, '可读写任意路径并执行命令', 'Can read/write any path and run commands');
  return text(locale, '限制在工作区目录内操作', 'Restrict operations to the workspace directory');
}

function defaultTargetForAccess(access: AccessKind): AccessTarget {
  if (access === 'network') return { kind: 'network', host: '' };
  if (access === 'command') return { kind: 'command', command: '' };
  if (access === 'tool_call') return { kind: 'tool', toolName: '' };
  return { kind: 'path', path: '' };
}

function targetValue(target: AccessTarget): string {
  if (target.kind === 'network') return target.host ?? '';
  if (target.kind === 'command') return target.command ?? '';
  if (target.kind === 'tool') return target.toolName ?? '';
  return target.path ?? '';
}

function targetFromValue(access: AccessKind, value: string): AccessTarget {
  if (access === 'network') return { kind: 'network', host: value };
  if (access === 'command') return { kind: 'command', command: value };
  if (access === 'tool_call') return { kind: 'tool', toolName: value };
  return { kind: 'path', path: value };
}

function ruleScope(scope: AccessPolicySettingsScope): AccessRuleScope {
  if (scope === 'currentThread') return 'thread';
  if (scope === 'workspace') return 'workspace';
  return 'global';
}

function scopeLabel(scope: AccessPolicySettingsScope, locale: Locale): string {
  if (scope === 'workspace') return text(locale, '当前工作区', 'Current workspace');
  if (scope === 'currentThread') return text(locale, '当前线程', 'Current thread');
  return text(locale, '全局规则', 'Global rules');
}

export function AccessPolicyPage({
  locale,
  value,
  scope,
  currentWorkspaceAvailable = false,
  currentWorkspaceRoot,
  workspaceRoots = [],
  selectedWorkspaceRoot = currentWorkspaceRoot ?? '',
  currentThreadAvailable,
  currentThreadId,
  saving,
  notice,
  onScopeChange,
  onWorkspaceChange,
  onChange,
  onSave,
  onReload,
}: AccessPolicyPageProps) {
  const persistentRules = value.persistentRules ?? [];

  function patchPolicy(patch: Partial<AccessPolicyConfig>) {
    onChange({
      ...value,
      ...patch,
      temporaryGrants: [],
    });
  }

  function patchRule(index: number, patch: Partial<AccessRule>) {
    patchPolicy({
      persistentRules: persistentRules.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)),
    });
  }

  function addRule() {
    const now = new Date().toISOString();
    const access: AccessKind = 'read';
    patchPolicy({
      persistentRules: [
        ...persistentRules,
        {
          id: `rule_${Date.now()}`,
          effect: 'allow',
          access,
          target: defaultTargetForAccess(access),
          scope: ruleScope(scope),
          ...(scope === 'workspace' && currentWorkspaceRoot ? { workspaceRoot: currentWorkspaceRoot } : {}),
          ...(scope === 'currentThread' && currentThreadId ? { threadId: currentThreadId } : {}),
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
  }

  function removeRule(index: number) {
    patchPolicy({ persistentRules: persistentRules.filter((_, ruleIndex) => ruleIndex !== index) });
  }

  return (
    <section className="settingsPage settingsAccessPolicyPage">
      <SettingsPageHeader
        eyebrow={text(locale, '安全边界', 'Safety boundary')}
        title={text(locale, '权限', 'Access')}
        actions={[
          {
            label: text(locale, '重新载入', 'Reload'),
            onClick: onReload,
            disabled: saving,
          },
          {
            label: saving ? text(locale, '保存中…', 'Saving…') : text(locale, scopeLabel(scope, locale), `Save ${scopeLabel(scope, 'en').toLowerCase()}`),
            primary: true,
            onClick: onSave,
            disabled: saving,
          },
        ]}
      />

      <div className="settingsCard settingsCardCompact accessPolicyScopeBlock">
        <div className="accessPolicyScopeHeader">
          <div><strong>{text(locale, '规则范围', 'Rule scope')}</strong><small>{scopeLabel(scope, locale)}{scope === 'workspace' && currentWorkspaceRoot ? ` · ${currentWorkspaceRoot}` : ''}</small></div>
        </div>
        <div className="accessPolicyScopeTabs" role="tablist" aria-label={text(locale, '规则范围', 'Rule scope')}>
          <button className={scope === 'global' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'global'} onClick={() => onScopeChange('global')}>
            {text(locale, '全局规则', 'Global rules')}
          </button>
          <button className={scope === 'workspace' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'workspace'} disabled={!currentWorkspaceAvailable} onClick={() => onScopeChange('workspace')}>
            {text(locale, '当前工作区', 'Current workspace')}
          </button>
          <button
            className={scope === 'currentThread' ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={scope === 'currentThread'}
            disabled={!currentThreadAvailable}
            onClick={() => onScopeChange('currentThread')}
          >
            {text(locale, '当前线程', 'Current thread')}
          </button>
        </div>
      </div>

      <div className="settingsCard settingsCardCompact accessModeBlock">
        <div className="settingsFieldRow">
          <label>{text(locale, '当前模式', 'Mode')}</label>
          <output className="accessModeValue" title={modeDescription(value.mode, locale)}>{modeLabel(value.mode, locale)}</output>
        </div>
        {scope === 'workspace' ? (
          <div className="settingsFieldRow accessWorkspacePicker">
            <label>{text(locale, '工作区', 'Workspace')}</label>
            {workspaceRoots.length > 0 ? (
              <div className="accessWorkspaceList" role="listbox" aria-label={text(locale, '可用工作区', 'Available workspaces')}>
                {workspaceRoots.map((root) => (
                  <button
                    key={root}
                    type="button"
                    role="option"
                    aria-selected={root === selectedWorkspaceRoot}
                    className={root === selectedWorkspaceRoot ? 'active' : ''}
                    onClick={() => onWorkspaceChange?.(root)}
                  >
                    <span>{root}</span>
                  </button>
                ))}
              </div>
            ) : (
              <span className="accessWorkspaceEmpty">{text(locale, '暂无可用工作区', 'No workspace is available')}</span>
            )}
          </div>
        ) : null}
      </div>

      <div className="settingsCard settingsCardCompact">
        <div className="settingsSectionTitleRow">
          <div>
            <h3>{text(locale, '持久规则', 'Persistent rules')}</h3>
          </div>
          <button className="whiteButton" type="button" onClick={addRule}>
            {text(locale, '新增规则', 'Add rule')}
          </button>
        </div>

        {persistentRules.length === 0 ? (
          <p className="accessPolicyEmpty">{text(locale, '暂无规则', 'No rules')}</p>
        ) : (
          <div className="accessRuleList">
            {persistentRules.map((rule, index) => (
              <article className="accessRuleRow" key={`${rule.id}:${index}`}>
                <span className="accessRuleId" title={rule.id}>{rule.id}</span>
                <select
                  aria-label={text(locale, '效果', 'Effect')}
                  value={rule.effect}
                  onChange={(event) => patchRule(index, { effect: event.target.value as AccessRule['effect'] })}
                >
                  <option value="allow">{text(locale, '允许', 'Allow')}</option>
                  <option value="deny">{text(locale, '禁止', 'Deny')}</option>
                </select>
                <select
                  aria-label={text(locale, '权限', 'Access')}
                  value={rule.access}
                  onChange={(event) => {
                    const access = event.target.value as AccessKind;
                    patchRule(index, { access, target: defaultTargetForAccess(access) });
                  }}
                >
                  <option value="read">{text(locale, '读取', 'Read')}</option>
                  <option value="write">{text(locale, '改写', 'Write')}</option>
                  <option value="command">{text(locale, '命令', 'Command')}</option>
                  <option value="network">{text(locale, '网络', 'Network')}</option>
                  <option value="tool_call">{text(locale, '工具', 'Tool')}</option>
                </select>
                <input
                  aria-label={text(locale, '目标', 'Target')}
                  value={targetValue(rule.target)}
                  onChange={(event) => patchRule(index, { target: targetFromValue(rule.access, event.target.value) })}
                  placeholder={rule.access === 'network' ? 'api.example.com' : rule.access === 'command' ? 'git status' : 'E:\\langchain\\dexin-agent'}
                />
                <button className="whiteButton accessRuleDelete" type="button" onClick={() => removeRule(index)}>
                  {text(locale, '删除', 'Delete')}
                </button>
              </article>
            ))}
          </div>
        )}
      </div>

      {notice ? <p className="settingsNotice">{notice}</p> : null}
    </section>
  );
}
