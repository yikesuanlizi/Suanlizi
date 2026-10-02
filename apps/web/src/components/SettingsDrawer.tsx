// 设置面板入口薄壳：注册 Shell 与各 page；状态/handler 通过 useSettingsController 管理
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatSuanliziErrorMessage, type AccessPolicyConfig } from '@suanlizi/protocol';
import type { Locale, RunConfig } from '../config/config.js';
import { emptyMcp } from '../config/defaults.js';
import type { RecommendedMcp, RecommendedSkill } from '../features/settings/pluginCatalog.js';
import type { ApiKeyState, BotConfig, BotStatus, McpConfig, McpServerStatus, MemoryRecord, ModelPreset, ProviderEntry, SkillEntry, WebProviderPublicConfig } from '../shared/types.js';
import { SettingsShell } from './settings/SettingsShell.js';
import { AppearancePage } from './settings/AppearancePage.js';
import { ModelsPage } from './settings/ModelsPage.js';
import { AgentsPage } from './settings/AgentsPage.js';
import { ToolsPage } from './settings/ToolsPage.js';
import { MonitorPage } from './settings/MonitorPage.js';
import { RuntimePage } from './settings/RuntimePage.js';
import { SshProfilesPage } from './settings/SshProfilesPage.js';
import { MemoryPage } from './settings/MemoryPage.js';
import { AccessPolicyPage, type AccessPolicySettingsScope } from './settings/AccessPolicyPage.js';
import { AboutPage } from './settings/AboutPage.js';
import { McpConfigDialog } from './settings/McpConfigDialog.js';
import { FirecrawlKeyDialog } from './settings/FirecrawlKeyDialog.js';
import { useSettingsController } from '../features/settings/useSettingsController.js';
import { saveGlobalAccessPolicy } from '../features/settings/settingsClient.js';
import { fetchThreadAccessPolicy, patchThreadAccessPolicy } from '../api/threadConfigClient.js';
import { compactWorkspaceRoots, normalizeWorkspaceRoot } from '../features/workspaces/workspaces.js';

const defaultBotConfig: BotConfig = {
  weixin: {
    enabled: false,
    bridgeMode: 'external_rpc',
    bridgeUrl: 'http://127.0.0.1:18790/api/v1/admin/rpc',
    accountId: '',
    activeThreadId: '',
    autoStartMonitor: true,
    syncHistoryOnConnect: true,
  },
  feishu: { enabled: false },
  dingtalk: {
    enabled: false,
    connectionMode: 'stream',
    clientId: '',
    clientSecret: '',
    robotCode: '',
    cardTemplateId: '',
    targetGroupName: '',
    targetGroupConversationId: '',
    targetGroupSessionWebhook: '',
    lastDetectedGroupConversationId: '',
    lastDetectedGroupSessionWebhook: '',
    lastDetectedGroupAt: '',
    allowedUsers: [],
    webhookSecret: '',
    activeThreadId: '',
    autoStart: true,
  },
  dwsCli: {
    enabled: false,
    binaryPath: '',
    clientId: '',
    clientSecret: '',
  },
  qq: { enabled: false },
};

function accessModeFromPermissions(config: RunConfig): AccessPolicyConfig['mode'] {
  if (config.permissions === 'read_only') return 'chat';
  if (config.permissions === 'danger_full_access') return 'danger_full_access';
  return 'workspace';
}

function accessPolicyFromConfig(config: RunConfig): AccessPolicyConfig {
  return {
    mode: config.accessPolicy?.mode ?? accessModeFromPermissions(config),
    workspaceRoot: config.accessPolicy?.workspaceRoot || config.workspaceRoot || '',
    persistentRules: config.accessPolicy?.persistentRules ?? [],
    temporaryGrants: [],
  };
}

function resolveSettingsVisualThemeMode(themeMode: RunConfig['themeMode']): 'light' | 'dark' {
  if (themeMode === 'dark') return 'dark';
  if (themeMode === 'light') return 'light';
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function SettingsDrawer({
  botConfig,
  botStatus,
  config,
  deleteSkill,
  keyStates,
  locale,
  mcps,
  mcpStatuses,
  modelPresets,
  providers,
  pendingMcpDraft,
  requestModelPresetName,
  saveModelPreset,
  deleteModelPreset,
  deleteCustomProvider,
  saveSkillDraft,
  saveProviderKey,
  saveProviderEnvVar,
  skillsList,
  refreshSkills,
  refreshMcpStatus,
  refreshBotStatus,
  refreshProviders,
  setConfig,
  setMcps,
  setOpen,
  saveBotConfig,
  saveWebProviderKey,
  clearWebProviderKey,
  consumePendingMcpDraft,
  webProviderState,
  startDingtalkStream,
  stopDingtalkStream,
  testDingtalkMessage,
    activeThreadId,
    workspaceRoots,
    saveThreadModelOverrides,
  saveGlobalModelConfig,
  refreshKeyStates,
}: {
  botConfig: BotConfig | null;
  botStatus: BotStatus | null;
  clearProviderKey: (providerId: string) => Promise<void>;
  config: RunConfig;
  deleteSkill: (name: string) => Promise<void>;
  keyStates: ApiKeyState[];
  locale: Locale;
  mcps: McpConfig[];
  mcpStatuses: McpServerStatus[];
  modelPresets: ModelPreset[];
  pendingMcpDraft?: McpConfig | null;
  providers: ProviderEntry[];
  skillsList: SkillEntry[];
  refreshSkills: (options?: { forceReload?: boolean }) => Promise<void>;
  refreshMcpStatus: (detail?: 'light' | 'full') => Promise<void>;
  refreshBotStatus: () => void;
  refreshProviders: () => Promise<void>;
  requestModelPresetName: (defaultName: string) => Promise<string | null>;
  saveModelPreset: (name: string, presetConfig: import('../shared/types.js').ModelPresetConfig, presetId?: string) => Promise<import('../shared/types.js').ModelPreset | string | void>;
  deleteModelPreset: (presetId: string) => Promise<void>;
  deleteCustomProvider: (providerId: string) => Promise<void>;
  saveSkillDraft: (draft: import('../shared/types.js').SkillDraft) => Promise<void>;
  saveBotConfig: (config: BotConfig) => Promise<void>;
  saveProviderKey: (providerId: string, apiKey: string) => Promise<void>;
  saveProviderEnvVar: (providerId: string, envVar: string) => Promise<void>;
  saveWebProviderKey: (apiKey: string) => Promise<void>;
  clearWebProviderKey: () => Promise<void>;
  setConfig: React.Dispatch<React.SetStateAction<RunConfig>>;
  setMcps: React.Dispatch<React.SetStateAction<McpConfig[]>>;
  setOpen: (open: boolean) => void;
  consumePendingMcpDraft?: () => void;
  webProviderState: WebProviderPublicConfig | null;
  startDingtalkStream?: () => Promise<{ ok?: boolean; error?: string }>;
  stopDingtalkStream?: () => Promise<void>;
  testDingtalkMessage?: (conversationId: string, conversationType: 'dm' | 'group', text?: string) => Promise<{ ok?: boolean; error?: string }>;
  activeThreadId: string;
  workspaceRoots?: string[];
  saveThreadModelOverrides: (overrides: { provider: string; model: string; baseUrl: string }) => Promise<void>;
  saveGlobalModelConfig: (config: RunConfig) => void;
  refreshKeyStates: () => Promise<void>;
}) {
  const controller = useSettingsController({
    locale,
    config,
    activeThreadId,
    providers,
    keyStates,
    modelPresets,
    requestModelPresetName,
    saveModelPreset,
    saveProviderKey,
    saveProviderEnvVar,
    saveThreadModelOverrides,
    saveGlobalModelConfig,
    setConfig,
    refreshProviders,
    refreshKeyStates,
    onClose: () => setOpen(false),
  });

  const [skillsRootDraft, setSkillsRootDraft] = useState(config.skillsRoot);
  const [botDraft, setBotDraft] = useState<BotConfig>(botConfig ?? defaultBotConfig);
  const [weixinNotice, setWeixinNotice] = useState('');
  const [dingtalkNotice, setDingtalkNotice] = useState('');
  const [dingtalkTestConvId, setDingtalkTestConvId] = useState('');
  const [dingtalkTestConvType, setDingtalkTestConvType] = useState<'dm' | 'group'>('dm');
  const [mcpDraft, setMcpDraft] = useState<McpConfig>(emptyMcp());
  const [editingMcpId, setEditingMcpId] = useState('');
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const [webKeyDraft, setWebKeyDraft] = useState('');
  const [firecrawlDialogOpen, setFirecrawlDialogOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('agent');
  const [accessPolicyScope, setAccessPolicyScope] = useState<AccessPolicySettingsScope>('global');
  const [accessPolicyWorkspaceRoot, setAccessPolicyWorkspaceRoot] = useState(() => normalizeWorkspaceRoot(config.workspaceRoot));
  const [accessPolicyDraft, setAccessPolicyDraft] = useState<AccessPolicyConfig>(() => accessPolicyFromConfig(config));
  const [accessPolicySaving, setAccessPolicySaving] = useState(false);
  const [accessPolicyNotice, setAccessPolicyNotice] = useState('');
  const [pluginNotice, setPluginNotice] = useState('');
  const [memoryRecords, setMemoryRecords] = useState<MemoryRecord[]>([]);
  const [memoryNotice, setMemoryNotice] = useState('');
  const modelCloseGuardRef = useRef<(() => boolean) | null>(null);
  const availableWorkspaceRoots = compactWorkspaceRoots([config.workspaceRoot, ...(workspaceRoots ?? [])]);
  const workspaceRootsKey = (workspaceRoots ?? []).join('\u0000');

  function handleSettingsClose() {
    if (activeSection === 'agent' && modelCloseGuardRef.current?.()) return;
    void controller.handleCancel();
  }
  const settingsTabs = [
    { id: 'agent', label: locale === 'zh' ? '模型' : 'Model' },
    { id: 'accessPolicy', label: locale === 'zh' ? '权限' : 'Access' },
    { id: 'appearance', label: locale === 'zh' ? '外观' : 'Appearance' },
    { id: 'memory', label: locale === 'zh' ? '记忆' : 'Memory' },
    { id: 'runtime', label: locale === 'zh' ? '运行参数' : 'Runtime' },
    { id: 'ssh', label: locale === 'zh' ? 'SSH 配置' : 'SSH profiles' },
    { id: 'monitor', label: locale === 'zh' ? '监控' : 'Monitor' },
    { id: 'plugins', label: locale === 'zh' ? '插件中心' : 'Plugins' },
    { id: 'remote', label: locale === 'zh' ? '远程助手' : 'Remote bots' },
    { id: 'about', label: locale === 'zh' ? '关于' : 'About' },
  ];

  useEffect(() => {
    setSkillsRootDraft(config.skillsRoot);
    if (!config.skillsRoot) {
      void ensureSkillsRoot();
    }
  }, [config.skillsRoot]);

  useEffect(() => {
    if (botConfig) setBotDraft(botConfig);
  }, [botConfig]);

  useEffect(() => {
    if (!pendingMcpDraft) return;
    setMcpDraft(pendingMcpDraft);
    setEditingMcpId('');
    setMcpPanelOpen(true);
    consumePendingMcpDraft?.();
  }, [consumePendingMcpDraft, pendingMcpDraft]);

  useEffect(() => {
    if (activeSection === 'memory') void refreshMemories();
    if (activeSection === 'accessPolicy') void loadAccessPolicy(accessPolicyScope);
  }, [activeSection]);

  useEffect(() => {
    setAccessPolicyWorkspaceRoot((current) => {
      const normalizedCurrent = normalizeWorkspaceRoot(current);
      return normalizedCurrent && availableWorkspaceRoots.some((root) => normalizeWorkspaceRoot(root).toLowerCase() === normalizedCurrent.toLowerCase())
        ? normalizedCurrent
        : (availableWorkspaceRoots[0] ?? '');
    });
  }, [config.workspaceRoot, workspaceRootsKey]);

  useEffect(() => {
    if (accessPolicyScope === 'global' || accessPolicyScope === 'workspace') {
      const globalPolicy = accessPolicyFromConfig(config);
      if (accessPolicyScope === 'workspace') {
        const root = normalizeWorkspaceRoot(accessPolicyWorkspaceRoot || config.workspaceRoot).toLowerCase();
        setAccessPolicyDraft({
          ...globalPolicy,
          workspaceRoot: normalizeWorkspaceRoot(accessPolicyWorkspaceRoot || config.workspaceRoot),
          persistentRules: globalPolicy.persistentRules.filter((rule) => rule.scope === 'workspace' && normalizeWorkspaceRoot(rule.workspaceRoot ?? globalPolicy.workspaceRoot).toLowerCase() === root),
        });
      } else setAccessPolicyDraft(globalPolicy);
    }
  }, [config.accessPolicy, config.workspaceRoot, config.permissions, accessPolicyScope, accessPolicyWorkspaceRoot]);

  async function ensureSkillsRoot() {
    const response = await fetch('/api/settings');
    if (!response.ok) return;
    const data = (await response.json()) as { config?: Partial<RunConfig> };
    const root = data.config?.skillsRoot;
    if (!root) return;
    setSkillsRootDraft(root);
    setConfig((current) => current.skillsRoot ? current : { ...current, skillsRoot: root });
  }

  function saveSkillsRoot() {
    setConfig((current) => ({ ...current, skillsRoot: skillsRootDraft }));
    controller.markDirty('skillsRoot', false);
  }

  async function loadAccessPolicy(nextScope: AccessPolicySettingsScope, workspaceRootOverride?: string) {
    setAccessPolicyNotice('');
    if (nextScope === 'currentThread' && activeThreadId) {
      const threadPolicy = await fetchThreadAccessPolicy(activeThreadId);
      setAccessPolicyDraft(threadPolicy ?? {
        mode: accessModeFromPermissions(config),
        workspaceRoot: config.workspaceRoot || '',
        persistentRules: [],
        temporaryGrants: [],
      });
      return;
    }
    const globalPolicy = accessPolicyFromConfig(config);
    if (nextScope === 'workspace') {
      const selectedRoot = normalizeWorkspaceRoot(workspaceRootOverride || accessPolicyWorkspaceRoot || config.workspaceRoot);
      const root = selectedRoot.toLowerCase();
      setAccessPolicyDraft({
        ...globalPolicy,
        workspaceRoot: selectedRoot,
        persistentRules: globalPolicy.persistentRules.filter((rule) => rule.scope === 'workspace' && normalizeWorkspaceRoot(rule.workspaceRoot ?? globalPolicy.workspaceRoot).toLowerCase() === root),
      });
      return;
    }
    setAccessPolicyDraft(globalPolicy);
  }

  function handleAccessPolicyScopeChange(nextScope: AccessPolicySettingsScope) {
    setAccessPolicyScope(nextScope);
    void loadAccessPolicy(nextScope, nextScope === 'workspace' ? accessPolicyWorkspaceRoot : undefined);
  }

  function handleAccessPolicyWorkspaceChange(workspaceRoot: string) {
    const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
    setAccessPolicyWorkspaceRoot(normalizedRoot);
    if (accessPolicyScope === 'workspace') void loadAccessPolicy('workspace', normalizedRoot);
  }

  async function handleSaveAccessPolicy() {
    setAccessPolicySaving(true);
    setAccessPolicyNotice('');
    try {
      if (accessPolicyScope === 'currentThread' && activeThreadId) {
        const saved = await patchThreadAccessPolicy(activeThreadId, accessPolicyDraft);
        setAccessPolicyDraft(saved ?? { ...accessPolicyDraft, temporaryGrants: [] });
      } else if (accessPolicyScope === 'workspace') {
        const base = accessPolicyFromConfig(config);
        const root = normalizeWorkspaceRoot(accessPolicyWorkspaceRoot || config.workspaceRoot);
        if (!root) {
          setAccessPolicyNotice(locale === 'zh' ? '请先选择工作区。' : 'Select a workspace first.');
          return;
        }
        const normalizedRoot = root.toLowerCase();
        const retained = base.persistentRules.filter((rule) => !(rule.scope === 'workspace' && normalizeWorkspaceRoot(rule.workspaceRoot ?? base.workspaceRoot).toLowerCase() === normalizedRoot));
        const saved = await saveGlobalAccessPolicy({
          ...base,
          mode: accessPolicyDraft.mode,
          persistentRules: [...retained, ...accessPolicyDraft.persistentRules.map((rule) => ({ ...rule, scope: 'workspace' as const, workspaceRoot: root }))],
          temporaryGrants: [],
        });
        setAccessPolicyDraft({ ...saved, workspaceRoot: root, persistentRules: saved.persistentRules.filter((rule) => rule.scope === 'workspace' && normalizeWorkspaceRoot(rule.workspaceRoot ?? saved.workspaceRoot).toLowerCase() === normalizedRoot) });
        setConfig((current) => ({ ...current, accessPolicy: saved }));
      } else {
        const saved = await saveGlobalAccessPolicy(accessPolicyDraft);
        setAccessPolicyDraft(saved);
        setConfig((current) => ({ ...current, accessPolicy: saved }));
      }
      setAccessPolicyNotice(locale === 'zh' ? '权限规则已保存。' : 'Access policy saved.');
    } catch (error) {
      setAccessPolicyNotice(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    } finally {
      setAccessPolicySaving(false);
    }
  }

  function patchWeixin(patch: Partial<BotConfig['weixin']>) {
    setBotDraft((current) => ({ ...current, weixin: { ...current.weixin, ...patch } }));
  }

  async function saveWeixinConfig() {
    await saveBotConfig(botDraft);
    setWeixinNotice(locale === 'zh' ? '远程助手配置已保存。' : 'Remote assistant config saved.');
  }

  function patchDingtalk(patch: Partial<BotConfig['dingtalk']>) {
    setBotDraft((current) => ({ ...current, dingtalk: { ...current.dingtalk, ...patch } }));
  }

  async function saveDingtalkConfig() {
    await saveBotConfig(botDraft);
    setDingtalkNotice(locale === 'zh' ? '钉钉机器人配置已保存。' : 'DingTalk bot config saved.');
  }

  function patchDwsCli(patch: Partial<BotConfig['dwsCli']>) {
    setBotDraft((current) => ({ ...current, dwsCli: { ...current.dwsCli, ...patch } }));
  }

  function patchFeishu(patch: Partial<BotConfig['feishu']>) {
    setBotDraft((current) => ({ ...current, feishu: { ...current.feishu, ...patch } }));
  }

  function patchQq(patch: Partial<BotConfig['qq']>) {
    setBotDraft((current) => ({ ...current, qq: { ...current.qq, ...patch } }));
  }

  async function saveDwsCliConfig() {
    await saveBotConfig(botDraft);
    setDingtalkNotice(locale === 'zh' ? '钉钉 CLI 配置已保存。' : 'DingTalk CLI config saved.');
  }

  async function handleStartDingtalk() {
    if (!startDingtalkStream) return;
    const result = await startDingtalkStream();
    if (result.ok) {
      setDingtalkNotice(locale === 'zh' ? '钉钉 Stream 已连接。' : 'DingTalk Stream connected.');
    } else {
      setDingtalkNotice(locale === 'zh' ? `连接失败：${result.error || '未知错误'}` : `Connection failed: ${result.error || 'unknown error'}`);
    }
  }

  async function handleStopDingtalk() {
    if (!stopDingtalkStream) return;
    await stopDingtalkStream();
    setDingtalkNotice(locale === 'zh' ? '钉钉 Stream 已停止。' : 'DingTalk Stream stopped.');
  }

  async function handleTestDingtalk() {
    if (!testDingtalkMessage || !dingtalkTestConvId.trim()) {
      setDingtalkNotice(locale === 'zh' ? '请填写 conversationId。' : 'Please fill in conversationId.');
      return;
    }
    const result = await testDingtalkMessage(dingtalkTestConvId.trim(), dingtalkTestConvType);
    if (result.ok) {
      setDingtalkNotice(locale === 'zh' ? '测试消息已发送。' : 'Test message sent.');
    } else {
      setDingtalkNotice(locale === 'zh' ? `发送失败：${result.error || '未知错误'}` : `Send failed: ${result.error || 'unknown error'}`);
    }
  }

  function closeMcpPanel() {
    setMcpDraft(emptyMcp());
    setEditingMcpId('');
    setMcpPanelOpen(false);
  }

  function openAddMcpPanel() {
    setMcpDraft(emptyMcp());
    setEditingMcpId('');
    setMcpPanelOpen(true);
  }

  function openEditMcpPanel(item: McpConfig) {
    setMcpDraft(item);
    setEditingMcpId(item.id);
    setMcpPanelOpen(true);
  }

  function addRecommendedMcp(item: RecommendedMcp) {
    setMcpDraft({ ...item.draft, id: '' });
    setEditingMcpId('');
    setMcpPanelOpen(true);
    setActiveSection('plugins');
  }

  async function installRecommendedSkill(item: RecommendedSkill) {
    try {
      await saveSkillDraft(item.draft);
      await refreshSkills({ forceReload: true });
      setPluginNotice(locale === 'zh' ? `已安装 ${item.name}` : `Installed ${item.name}`);
    } catch (error) {
      setPluginNotice(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    }
  }

  const mcpCanSave = Boolean(mcpDraft.name.trim() && mcpDraft.command.trim());

  function saveMcp() {
    if (!mcpCanSave) return;
    setMcps((current) => {
      const upsert = (arr: McpConfig[], item: McpConfig): McpConfig[] => {
        const idx = arr.findIndex((x) => x.id === item.id);
        if (idx >= 0) { const next = [...arr]; next[idx] = item; return next; }
        return [...arr, item];
      };
      return upsert(current, {
        id: editingMcpId || crypto.randomUUID(),
        name: mcpDraft.name.trim(),
        command: mcpDraft.command.trim(),
        args: mcpDraft.args.trim(),
        enabled: mcpDraft.enabled,
      });
    });
    closeMcpPanel();
  }

  function closeFirecrawlDialog() {
    setFirecrawlDialogOpen(false);
    setWebKeyDraft('');
  }

  async function handleFirecrawlToggle(nextEnabled: boolean) {
    if (!nextEnabled) {
      setConfig((current) => ({ ...current, webProvider: 'native_fetch' }));
      setPluginNotice(locale === 'zh' ? '已切回本地读取。' : 'Switched back to local fetch.');
      return;
    }
    const firecrawlMasked = webProviderState?.firecrawl.masked ?? '';
    const firecrawlHasPreview = /[.•·]/.test(firecrawlMasked);
    const firecrawlConfigured = Boolean(webProviderState?.firecrawl.configured && firecrawlHasPreview);
    if (firecrawlConfigured) {
      setConfig((current) => ({ ...current, webProvider: 'firecrawl' }));
      setPluginNotice(locale === 'zh' ? 'Firecrawl 已开启。' : 'Firecrawl enabled.');
      return;
    }
    setConfig((current) => ({ ...current, webProviderKeySource: 'config' }));
    setFirecrawlDialogOpen(true);
  }

  async function handleSaveFirecrawlKeyAndEnable() {
    const apiKey = webKeyDraft.trim();
    if (!apiKey) return;
    try {
      await saveWebProviderKey(apiKey);
      setConfig((current) => ({ ...current, webProvider: 'firecrawl', webProviderKeySource: 'config' }));
      setPluginNotice(locale === 'zh' ? 'Firecrawl 已开启。' : 'Firecrawl enabled.');
      closeFirecrawlDialog();
    } catch (error) {
      setPluginNotice(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    }
  }

  async function handleClearFirecrawlKey() {
    try {
      await clearWebProviderKey();
      setConfig((current) => ({ ...current, webProvider: 'native_fetch', webProviderKeySource: 'config' }));
      setPluginNotice(locale === 'zh' ? '已清除 Firecrawl 密钥。' : 'Firecrawl key cleared.');
      closeFirecrawlDialog();
    } catch (error) {
      setPluginNotice(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    }
  }

  const refreshBotStatusAsync = useCallback(async () => {
    refreshBotStatus();
  }, [refreshBotStatus]);

  async function refreshMemories() {
    const response = await fetch('/api/memories');
    if (!response.ok) return;
    const data = (await response.json()) as { records?: MemoryRecord[]; settings?: Partial<RunConfig> };
    setMemoryRecords(data.records ?? []);
    if (data.settings) setConfig((current) => ({ ...current, ...data.settings! }));
  }

  async function saveMemorySettings(patch: Partial<RunConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    const response = await fetch('/api/memories/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: {
        memoryEnabled: next.memoryEnabled,
        autoExtractMemories: next.autoExtractMemories,
        useColdMemories: next.useColdMemories,
        memoryInjectLimit: next.memoryInjectLimit,
        memoryTokenBudget: next.memoryTokenBudget,
        episodeMemoryEnabled: next.episodeMemoryEnabled,
        episodeInjectLimit: next.episodeInjectLimit,
        episodeTokenBudget: next.episodeTokenBudget,
        episodeSwitchCooldownTurns: next.episodeSwitchCooldownTurns,
        episodeSealIdleMinutes: next.episodeSealIdleMinutes,
        episodeColdAfterDays: next.episodeColdAfterDays,
        episodeFtsCandidateLimit: next.episodeFtsCandidateLimit,
      } }),
    });
    setMemoryNotice(response.ok
      ? (locale === 'zh' ? '记忆设置已保存。' : 'Memory settings saved.')
      : (locale === 'zh' ? '记忆设置保存失败。' : 'Failed to save memory settings.'));
  }

  async function deleteMemory(id: string) {
    const response = await fetch(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (response.ok) {
      setMemoryRecords((current) => current.filter((record) => record.id !== id));
      setMemoryNotice(locale === 'zh' ? '记忆已删除。' : 'Memory deleted.');
    }
  }

  async function exportMemories() {
    const response = await fetch('/api/memories/export', { method: 'POST' });
    const data = response.ok ? await response.json() as { outputDir?: string } : null;
    setMemoryNotice(response.ok
      ? (locale === 'zh' ? `已导出到 ${data?.outputDir ?? ''}` : `Exported to ${data?.outputDir ?? ''}`)
      : (locale === 'zh' ? '导出失败。' : 'Export failed.'));
  }

  function renderActivePage() {
    switch (activeSection) {
      case 'agent':
        return (
          <ModelsPage
            locale={locale}
            config={config}
            modelConfigDraft={controller.modelConfigDraft}
            setModelConfigDraft={controller.setModelConfigDraft}
            providers={providers}
            keyStates={keyStates}
            modelPresets={modelPresets}
            deleteModelPreset={deleteModelPreset}
            deleteCustomProvider={deleteCustomProvider}
            listProviderIconTabs={controller.listProviderIconTabs}
            saveProviderIcon={controller.saveProviderIcon}
            apiKeyDraft={controller.apiKeyDraft}
            setApiKeyDraft={controller.setApiKeyDraft}
            modelKeySource={controller.modelKeySource}
            setModelKeySource={controller.setModelKeySource}
            showSavedModelKey={controller.showSavedModelKey}
            setShowSavedModelKey={controller.setShowSavedModelKey}
            modelKeyNotice={controller.modelKeyNotice}
            setModelKeyNotice={controller.setModelKeyNotice}
            hasSavedModelKey={controller.hasSavedModelKey}
            hasConfiguredModelEnvVar={controller.hasConfiguredModelEnvVar}
            modelEnvVarDraft={controller.modelEnvVarDraft}
            setModelEnvVarDraft={controller.setModelEnvVarDraft}
            modelEnvVarOptions={controller.modelEnvVarOptions}
            customProviderName={controller.customProviderName}
            setCustomProviderName={controller.setCustomProviderName}
            selectModelProviderDraft={controller.selectModelProviderDraft}
            loadModelPresetIntoDraft={controller.loadModelPresetIntoDraft}

            selectPreset={controller.selectPreset}


            startNewModelPreset={controller.startNewModelPreset}
            handleSaveModelConfig={controller.handleSaveModelConfig}
            handleSetCurrentModelConfig={controller.handleSetCurrentModelConfig}
            onReset={controller.resetModelDraft}
            markDirty={controller.markDirty}
            dirtyFields={controller.dirtyFields}
          />
        );
      case 'appearance':
        return (
          <AppearancePage
            locale={locale}
            config={config}
            setConfig={setConfig}
            markDirty={controller.markDirty}
            dirtyFields={controller.dirtyFields}
          />
        );
      case 'accessPolicy':
        return (
          <AccessPolicyPage
            locale={locale}
            value={accessPolicyDraft}
            scope={accessPolicyScope}
            currentWorkspaceAvailable={availableWorkspaceRoots.length > 0}
            currentWorkspaceRoot={accessPolicyWorkspaceRoot}
            workspaceRoots={availableWorkspaceRoots}
            selectedWorkspaceRoot={accessPolicyWorkspaceRoot}
            currentThreadAvailable={Boolean(activeThreadId)}
            currentThreadId={activeThreadId}
            saving={accessPolicySaving}
            notice={accessPolicyNotice}
            onScopeChange={handleAccessPolicyScopeChange}
            onWorkspaceChange={handleAccessPolicyWorkspaceChange}
            onChange={setAccessPolicyDraft}
            onSave={handleSaveAccessPolicy}
            onReload={() => void loadAccessPolicy(accessPolicyScope)}
          />
        );
      case 'memory':
        return (
          <MemoryPage
            locale={locale}
            config={config}
            memoryRecords={memoryRecords}
            memoryNotice={memoryNotice}
            saveMemorySettings={saveMemorySettings}
            deleteMemory={deleteMemory}
            exportMemories={exportMemories}
          />
        );
      case 'monitor':
        return (
          <MonitorPage
            locale={locale}
            config={config}
            setConfig={setConfig}
            markDirty={controller.markDirty}
            dirtyFields={controller.dirtyFields}
            onSave={controller.handleSaveMonitorSettings}
          />
        );
      case 'runtime':
        return (
          <RuntimePage
            locale={locale}
            config={config}
            setConfig={setConfig}
            markDirty={controller.markDirty}
            onSave={() => void controller.handleSaveRuntimeSettings()}
          />
        );
      case 'ssh':
        return <SshProfilesPage locale={locale} />;
      case 'about':
        return <AboutPage locale={locale} />;
      case 'plugins':
        return (
          <ToolsPage
            locale={locale}
            config={config}
            setConfig={setConfig}
            mcps={mcps}
            setMcps={setMcps}
            mcpStatuses={mcpStatuses}
            refreshMcpStatus={refreshMcpStatus}
            openAddMcpPanel={openAddMcpPanel}
            openEditMcpPanel={openEditMcpPanel}
            skillsList={skillsList}
            skillsRootDraft={skillsRootDraft}
            setSkillsRootDraft={setSkillsRootDraft}
            saveSkillsRoot={saveSkillsRoot}
            refreshSkills={refreshSkills}
            deleteSkill={deleteSkill}
            installRecommendedSkill={installRecommendedSkill}
            addRecommendedMcp={addRecommendedMcp}
            webProviderState={webProviderState}
            setFirecrawlDialogOpen={setFirecrawlDialogOpen}
            handleFirecrawlToggle={handleFirecrawlToggle}
            pluginNotice={pluginNotice}
            setPluginNotice={setPluginNotice}
            dirtyFields={controller.dirtyFields}
          />
        );
      case 'remote':
        return (
          <AgentsPage
            locale={locale}
            botConfig={botConfig}
            botStatus={botStatus}
            botDraft={botDraft}
            weixinNotice={weixinNotice}
            dingtalkNotice={dingtalkNotice}
            dingtalkTestConvId={dingtalkTestConvId}
            setDingtalkTestConvId={setDingtalkTestConvId}
            dingtalkTestConvType={dingtalkTestConvType}
            setDingtalkTestConvType={setDingtalkTestConvType}
            patchWeixin={patchWeixin}
            patchDingtalk={patchDingtalk}
            patchDwsCli={patchDwsCli}
            patchFeishu={patchFeishu}
            patchQq={patchQq}
            saveWeixinConfig={saveWeixinConfig}
            saveDingtalkConfig={saveDingtalkConfig}
            saveDwsCliConfig={saveDwsCliConfig}
            handleStartDingtalk={handleStartDingtalk}
            handleStopDingtalk={handleStopDingtalk}
            handleTestDingtalk={handleTestDingtalk}
            refreshBotStatus={refreshBotStatusAsync}
          />
        );
      default:
        return null;
    }
  }

  const firecrawlMasked = webProviderState?.firecrawl.masked ?? '';
  const firecrawlHasPreview = /[.•·]/.test(firecrawlMasked);
  const firecrawlConfigured = Boolean(webProviderState?.firecrawl.configured && firecrawlHasPreview);
  const visualThemeMode = resolveSettingsVisualThemeMode(config.themeMode);

  function handleToggleTheme() {
    setConfig((current) => ({
      ...current,
      themeMode: resolveSettingsVisualThemeMode(current.themeMode) === 'dark' ? 'light' : 'dark',
    }));
  }

  return (
    <>
      <SettingsShell
        locale={locale}
        open={true}
        onClose={handleSettingsClose}
        settingsTabs={settingsTabs}
        activeSection={activeSection}
        setActiveSection={setActiveSection}
        saveState={activeSection === 'accessPolicy'
          ? { dirty: false, saving: accessPolicySaving, error: null, savedToastAt: null }
          : controller.saveState}
        onSave={controller.handleSave}
        onCancel={controller.handleCancel}
        pluginMode={activeSection === 'plugins'}
        saveLabel={controller.saveLabel}
        visualThemeMode={visualThemeMode}
        onToggleTheme={handleToggleTheme}
      >
        {renderActivePage()}
      </SettingsShell>

      <McpConfigDialog
        locale={locale}
        open={mcpPanelOpen}
        mcpDraft={mcpDraft}
        editingMcpId={editingMcpId}
        mcpCanSave={mcpCanSave}
        onClose={closeMcpPanel}
        setMcpDraft={setMcpDraft}
        onSave={saveMcp}
      />

      <FirecrawlKeyDialog
        locale={locale}
        open={firecrawlDialogOpen}
        webProviderState={webProviderState}
        firecrawlMasked={firecrawlMasked}
        firecrawlHasPreview={firecrawlHasPreview}
        firecrawlConfigured={firecrawlConfigured}
        webKeyDraft={webKeyDraft}
        setWebKeyDraft={setWebKeyDraft}
        onClose={closeFirecrawlDialog}
        onSave={handleSaveFirecrawlKeyAndEnable}
        onClear={handleClearFirecrawlKey}
      />
    </>
  );
}

export { saveModelPresetDraft } from './settings/shared.js';
