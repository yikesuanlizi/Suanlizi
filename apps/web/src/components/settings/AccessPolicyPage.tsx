import React from 'react';
import type { AccessKind, AccessPolicyConfig, AccessRule, AccessRuleScope, AccessTarget } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';
import { SectionHeader } from './SectionHeader.js';

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

function accessLabel(access: AccessKind, locale: Locale): string {
  switch (access) {
    case 'read': return text(locale, '读取', 'Read');
    case 'write': return text(locale, '改写', 'Write');
    case 'command': return text(locale, '命令', 'Command');
    case 'network': return text(locale, '网络', 'Network');
    case 'tool_call': return text(locale, '工具', 'Tool');
    default: return access;
  }
}

function ruleSummary(rule: AccessRule, locale: Locale): string {
  const target = targetValue(rule.target);
  if (!target) return accessLabel(rule.access, locale);
  return `${accessLabel(rule.access, locale)} · ${target}`;
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
          },
          {
            label: saving ? text(locale, '保存中…', 'Saving…') : text(locale, scope === 'global' ? '保存规则' : '保存规则', 'Save rules'),
            primary: true,
            onClick: onSave,
          },
        ]}
      />

      <div className="settingsSectionBlock accessPolicyScopeBlock">
        <div className="settingsSectionHeader">
          <div>
            <h3 className="settingsSectionHeaderTitle">{text(locale, '规则范围', 'Rule scope')}</h3>
            <span className="accessPolicyScopeValue">{scopeLabel(scope, locale)}{scope === 'workspace' && currentWorkspaceRoot ? ` · ${currentWorkspaceRoot}` : ''}</span>
          </div>
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

      <div className="settingsSectionBlock accessModeBlock">
        <div className="settingsSectionHeader">
          <h3 className="settingsSectionHeaderTitle">{text(locale, '工作模式', 'Workspace mode')}</h3>
        </div>
        <div className="accessModeLayout">
          <div className="accessModeField">
            <span className="settingsFieldLabel">{text(locale, '当前模式', 'Current mode')}</span>
            <output className="accessModeValue" title={modeDescription(value.mode, locale)}>{modeLabel(value.mode, locale)}</output>
          </div>
          {scope === 'workspace' ? (
            <div className="accessWorkspacePicker">
              <span className="settingsFieldLabel">{text(locale, '工作区', 'Workspace')}</span>
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
      </div>

      <div className="settingsSectionBlock">
        <SectionHeader
          title={text(locale, '持久规则', 'Persistent rules')}
          action={{
            label: text(locale, '新增规则', 'Add rule'),
            onClick: addRule,
          }}
        />
        {persistentRules.length === 0 ? (
          <p className="accessPolicyEmpty">{text(locale, '暂无规则', 'No rules')}</p>
        ) : (
          <div className="accessRuleList">
            {persistentRules.map((rule, index) => (
              <article className="accessRuleRow" key={`${rule.id}:${index}`}>
                <div className="accessRuleInfo">
                  <strong>{ruleSummary(rule, locale)}</strong>
                  <span>{rule.id}</span>
                </div>
                <div className="accessRuleActions">
                  <select
                    aria-label={text(locale, '效果', 'Effect')}
                    value={rule.effect}
                    onChange={(event) => patchRule(index, { effect: event.target.value as AccessRule['effect'] })}
                  >
                    <option value="allow">{text(locale, '允许', 'Allow')}</option>
                    <option value="deny">{text(locale, '禁止', 'Deny')}</option>
                    <option value="prompt">{text(locale, '按次确认', 'Prompt')}</option>
                  </select>
                  <button className="whiteButton accessRuleDelete" type="button" onClick={() => removeRule(index)}>
                    {text(locale, '删除', 'Delete')}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {notice ? <p className="settingsNotice">{notice}</p> : null}
    </section>
  );
}
