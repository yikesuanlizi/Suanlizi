import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { RUN_CONFIG_STORAGE_KEY, mergeRunConfigDefaults, type RunConfig, type WebSearchMode } from './config/config.js';
import { Icon } from './components/Icon.js';
import { AppDialog, SettingsHelpDialog, SkillDraftDialog, type AppDialogState } from './components/Dialogs.js';
import { ComposerBar, type PaletteOption } from './components/ComposerBar.js';
import { AssistantTurnView, ItemView, TurnPreparingIndicator } from './components/ItemView.js';
import { TranscriptTurnRail, type TranscriptTurnRailEntry } from './components/TranscriptTurnRail.js';
import { ApprovalPanel } from './components/ApprovalPanel.js';
import { SettingsDrawer } from './components/SettingsDrawer.js';
import { WeixinConnectDialog } from './components/WeixinConnectDialog.js';
import { RightPane } from './components/RightPane.js';
import { OpsTaskAnchorCard, type OpsAnchorAction } from './components/OpsTaskAnchorCard.js';
import type { ExternalPreviewRequest } from './components/WorkspaceFilesPanel.js';
import { RunMonitorDrawer } from './components/RunMonitorDrawer.js';
import { TaskCenterDrawer } from './components/tasks/TaskCenterDrawer.js';
import { createTask, startTask } from './api/taskClient.js';
import { proposeWorkflowRun } from './api/workflowScriptClient.js';
import { WorkflowSidePane } from './components/WorkflowSidePane.js';
import { WorkspaceThreadList } from './components/WorkspaceThreadList.js';
import { useBotControls, type WeixinLoginState } from './api/botClient.js';
import { resizeTextareaToContent } from './shared/composer.js';
import { useRightPaneSizing, useToastNotice } from './shared/uiState.js';
import { defaultConfig, defaultMcps } from './config/defaults.js';
import { saveGlobalDefaults } from './features/settings/settingsClient.js';
import { contextTokensForSelectedModel } from './api/modelContextReferencesClient.js';
import { t } from './shared/i18n.js';
import { extractGitHubSkillInstallUrls } from './features/input/composerInput.js';
import { normalizeStoredMcps, resolveMcpDraftFromInput } from './features/settings/mcpConfig.js';
import { getSlashCommandOptions, isSlashInput, parseSlashCommand, type SlashCommand, type SlashCommandOption } from './features/slash/slashCommands.js';
import { localizedSkillDescription } from './features/settings/skillDescriptions.js';
import { readStored } from './shared/storage.js';
import { buildChildActivityByThread } from './features/agents/subagentActivity.js';
import { buildSubagentStatusRows } from './features/agents/subagents.js';
import { modeInstructionFor } from './config/taskModes.js';
import { HIGH_AUTONOMY_OVERRIDES, createInitialWorkflowScript, type ComposerExecutionMode, type ComposerThinkingMode } from './features/composer/executionMode.js';
import {
  buildTokenTooltip,
  buildTokenUsageSummary,
  contextUsagePercent,
  hasContextPressure,
  resolveDisplayContextPressure,
  resolveModelCapabilities,
} from './features/chat/usageDisplay.js';
import { resolveSnapshotBusy } from './features/thread/snapshotBusy.js';
import { rollbackCountForTurn } from './features/chat/rollback.js';
import { useWebProviderSettings, type SettingsResponseWithWebProvider } from './api/webProviderClient.js';
import { useRunMonitor } from './features/monitor/runMonitor.js';
import { useTaskRuntimeMonitor, isTaskRuntimeEvent } from './features/monitor/taskRuntimeMonitor.js';
import { actionDetail, actionTitle, completeLocalSkillDraftItem, createLocalSkillDraftItems, mergeIncomingItems, removeLocalThreadItems } from './features/chat/threadItems.js';
import { optimisticDeleteThread } from './features/chat/threads.js';
import { compactWorkspaceRoots, forgetWorkspaceRoot, pickWorkspaceRoot, readRememberedWorkspaceRoots, rememberWorkspaceRoots, saveRememberedWorkspaceRoots, threadsInWorkspace, workspaceKey, workspacePickerNotice, workspacePickerStatus } from './features/workspaces/workspaces.js';
import { controlThreadWorkflow, createWorkflowDraftErrorItem, createWorkflowDraftReplyItem, createWorkflowDraftUserItem, isUntitledWorkflowProjectTitle, loadThreadWorkflow, parseThreadWorkflow, parseWorkflowCheckpointItems, planWorkflowDraft, saveThreadWorkflow, workflowThreadTitleFromGoal, type WorkflowBlueprintCompileResult, type WorkflowComponentDefinition, type WorkflowPlanDraft, type WorkflowRuntimeAction, type WorkflowSnapshot } from './features/workflow/workflow.js';
import { applyAgentMessageDelta, describeEvent, groupTranscriptItems, removeThreadItem, withSyntheticUserMessages, type EventDraft } from './features/chat/threadView.js';
import { fetchThreadConfigOverrides, patchThreadConfigOverrides, type ThreadConfigOverrides } from './api/threadConfigClient.js';
import { createLatestRequestGuard } from './features/chat/latestRequestGuard.js';
import {
  nextTranscriptFollowState,
  TRANSCRIPT_FOLLOW_GAP_PX,
  type TranscriptFollowState,
} from './features/chat/transcriptFollow.js';
import type { ApiKeyState, ApprovalRequest, EventLine, McpConfig, McpServerStatus, ModelPreset, ModelPresetConfig, ProviderEntry, SkillDraft, SkillEntry, ThreadItem, ThreadChildInfo, ThreadMeta, ThreadUsage, TurnMeta } from './shared/types.js';
import { formatSuanliziErrorMessage, type OpsTaskSession, type PersistentAccessScope, type TemporaryAccessScope } from '@suanlizi/protocol';
import './styles.css';
type ComposerImage = { name: string; dataUrl: string };
type PreparingTurn = { threadId: string; turnId?: string };
type RuntimeStateSnapshot = { executionStatus?: string };
function resolveThemeShortcutMode(current: RunConfig['themeMode']): 'light' | 'dark' {
  if (current === 'dark') return 'dark';
  if (current === 'light') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

function nextThemeMode(current: RunConfig['themeMode']): RunConfig['themeMode'] {
  return resolveThemeShortcutMode(current) === 'dark' ? 'light' : 'dark';
}

function parseProviderEnvVarSaveFailure(detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // API may return plain text from a proxy or dev server; fall through to raw detail.
  }
  return trimmed;
}

function parseApiErrorMessage(payload: unknown, fallback: string, locale: 'zh' | 'en' = 'zh'): string {
  if (typeof payload === 'string' && payload.trim()) return formatSuanliziErrorMessage(undefined, payload.trim(), locale);
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as { error?: unknown; message?: unknown };
  let info: Parameters<typeof formatSuanliziErrorMessage>[0];
  let code = '';
  let message = '';
  if (typeof record.error === 'string' && record.error.trim()) message = record.error.trim();
  if (record.error && typeof record.error === 'object') {
    const error = record.error as { code?: unknown; message?: unknown; info?: Parameters<typeof formatSuanliziErrorMessage>[0] };
    if (typeof error.code === 'string' && error.code.trim()) code = error.code.trim();
    if (error.info && typeof error.info === 'object') info = error.info;
    if (!message && typeof error.message === 'string') message = error.message.trim();
  }
  if (!message && typeof record.message === 'string') message = record.message.trim();
  return message ? formatSuanliziErrorMessage(info, code ? `${code}: ${message}` : message, locale) : fallback;
}

function eventItemId(event: Record<string, unknown>): string | undefined {
  const item = event.item;
  if (!item || typeof item !== 'object') return undefined;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

function runtimeConfigPayload(source: RunConfig): Partial<RunConfig> {
  const { themeMode, userAvatarId, customUserAvatarDataUrl, ...payload } = source;
  void themeMode;
  void userAvatarId;
  void customUserAvatarDataUrl;
  return payload;
}

function App() {
  const [hasStoredRunConfig] = useState(() => Boolean(localStorage.getItem(RUN_CONFIG_STORAGE_KEY)));
  const [config, setConfig] = useState<RunConfig>(() => ({
    ...defaultConfig,
    ...readStored<Partial<RunConfig>>(RUN_CONFIG_STORAGE_KEY, {}),
  }));
  // Thread-scoped model overrides are merged into `config` for the active
  // conversation, but they must not become the next global startup defaults.
  const globalConfigRef = useRef<RunConfig>(config);
  const persistedThreadIdRef = useRef('');
  const [configHydrated, setConfigHydrated] = useState(false);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [rememberedWorkspaceRoots, setRememberedWorkspaceRoots] = useState<string[]>(() => readRememberedWorkspaceRoots());
  const [threadId, setThreadId] = useState('');
  const threadIdRef = useRef('');
  threadIdRef.current = threadId;
  const [turns, setTurns] = useState<TurnMeta[]>([]);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [threadUsage, setThreadUsage] = useState<ThreadUsage | null>(null);
  const [compactionPressure, setCompactionPressure] = useState<{
    status?: string;
    estimatedTokens?: number;
    hardThreshold?: number;
    maxTokens?: number;
    windowKnown?: boolean;
    softThreshold?: number;
    ratio?: number;
  } | null>(null);
  const [threadChildren, setThreadChildren] = useState<ThreadChildInfo[]>([]);
  const [, setEvents] = useState<EventLine[]>([]);
  const [runningTurnIds, setRunningTurnIds] = useState<Set<string>>(() => new Set());
  const [unreadThreadIds, setUnreadThreadIds] = useState<Set<string>>(() => new Set());
  const prevThreadStatusesRef = useRef<Record<string, string>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 窄屏 sidebar 抽屉开关 — Chinese: narrow-screen sidebar drawer toggle
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [threadFilter, setThreadFilter] = useState('');
  const [input, setInput] = useState('');
  const [executionMode, setExecutionMode] = useState<ComposerExecutionMode>('chat');
  const [thinkingMode, setThinkingMode] = useState<ComposerThinkingMode>(() => config.reasoningEffort);
  const [composerFileReferences, setComposerFileReferences] = useState<string[]>([]);
  const [activeSlashOption, setActiveSlashOption] = useState<SlashCommandOption | null>(null);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [draggingImage, setDraggingImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparingTurn, setPreparingTurn] = useState<PreparingTurn | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [workflowPlanning, setWorkflowPlanning] = useState(false);
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const [workflowRuntimeBusy, setWorkflowRuntimeBusy] = useState(false);
  const [workflowPlanDraft, setWorkflowPlanDraft] = useState<WorkflowPlanDraft | null>(null);
  const [workflowComponents, setWorkflowComponents] = useState<WorkflowComponentDefinition[]>([]);
  const [workflowBlueprint, setWorkflowBlueprint] = useState<WorkflowBlueprintCompileResult | null>(null);
  const [workflowSelectedNodeIds, setWorkflowSelectedNodeIds] = useState<string[]>([]);
  const [status, setStatus] = useState('Idle');
  const [transcriptFollow, setTranscriptFollow] = useState<TranscriptFollowState>({ following: true, showReturnToBottom: false });
  const [settingsOpen, setSettingsOpen] = useState(false), [settingsHelpOpen, setSettingsHelpOpen] = useState(false);
  const [rightPaneVisible, setRightPaneVisible] = useState(false);
  // 中文注释：外部预览请求 — 从对话条目点击"预览"时驱动右侧文件面板加载该文件
  // — Chinese: external preview request — drives right file panel to load a file when "preview" is clicked from chat
  const [previewRequest, setPreviewRequest] = useState<ExternalPreviewRequest | null>(null);
  const [rightPaneSizingMode, setRightPaneSizingMode] = useState<'standard' | 'files' | 'terminal'>(() => readStoredRightPaneSizingMode());
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const taskRuntimeMonitor = useTaskRuntimeMonitor();
  const [opsTask, setOpsTask] = useState<OpsTaskSession | null>(null);
  const [opsTaskBusy, setOpsTaskBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [keyStates, setKeyStates] = useState<ApiKeyState[]>([]);
  const [modelPresets, setModelPresets] = useState<ModelPreset[]>([]);
  const modelSelectionRef = useRef(0);
  const currentModelConfigRef = useRef(config);
  currentModelConfigRef.current = config;
  const [skillsList, setSkillsList] = useState<SkillEntry[]>([]);
  const [mcps, setMcps] = useState<McpConfig[]>(() => normalizeStoredMcps(readStored('suanlizi.mcps', defaultMcps)));
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([]);
  const [mcpHydrated, setMcpHydrated] = useState(false);
  const [pendingMcpDraft, setPendingMcpDraft] = useState<McpConfig | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null);
  const [dialog, setDialog] = useState<AppDialogState | null>(null);
  const [weixinConnectState, setWeixinConnectState] = useState<WeixinLoginState | null>(null);
  useEffect(() => {
    // A file preview belongs to the thread that requested it. Never let a
    // newly selected conversation inherit the previous thread's preview.
    setPreviewRequest(null);
  }, [threadId]);
  useEffect(() => {
    setPreparingTurn((current) => current && current.threadId === threadId ? current : null);
  }, [threadId]);
  const eventCounter = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const transcriptTurnRefs = useRef(new Map<string, HTMLElement>());
  const transcriptAutoScrollFrameRef = useRef<number | null>(null);
  const transcriptFollowRef = useRef(transcriptFollow);
  transcriptFollowRef.current = transcriptFollow;
  const transcriptContentAnchorRef = useRef<number | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeTurnThreadIdRef = useRef<string>('');
  const activeTurnIdRef = useRef<string>('');
  const threadLoadGuardRef = useRef(createLatestRequestGuard());
  const sendMessageGuardRef = useRef(createLatestRequestGuard());
  const turnWatchRef = useRef<{ epoch: number; timer: number | null; threadId: string; knownTurnIds: Set<string> } | null>(null);
  const turnWatchEpochRef = useRef(0);
  const threadEventSourceGenerationRef = useRef(0);
  const eventSourceRecoveryTimerRef = useRef<number | null>(null);
  const activeThread = threads.find((thread) => thread.threadId === threadId);
  const hasActiveThread = Boolean(threadId && activeThread);
  const showRightPane = rightPaneVisible && hasActiveThread;
  useEffect(() => {
    if (!hasActiveThread) {
      setRightPaneVisible(false);
      setRightPaneSizingMode('standard');
      return;
    }
    setRightPaneVisible(readStoredRightPaneVisibility(threadId));
    setRightPaneSizingMode(readStoredRightPaneSizingMode(threadId));
  }, [hasActiveThread, threadId]);
  const revealRightPaneForThread = useCallback((mode: 'standard' | 'files' | 'terminal' = 'standard'): boolean => {
    if (!hasActiveThread || !threadId) return false;
    writeStoredRightPaneVisibility(true, threadId);
    setRightPaneVisible(true);
    setRightPaneSizingMode(mode);
    return true;
  }, [hasActiveThread, threadId]);
  const toggleRightPane = useCallback(() => {
    if (!hasActiveThread || !threadId) return;
    setRightPaneVisible((current) => {
      const next = !current;
      writeStoredRightPaneVisibility(next, threadId);
      return next;
    });
  }, [hasActiveThread, threadId]);
  const activeWorkflow = useMemo(() => parseThreadWorkflow(activeThread) ?? parseWorkflowCheckpointItems(items), [activeThread, items]);
  const isWorkflowProject = activeThread?.tags?.workflowProject === 'true' || Boolean(activeWorkflow);
  const { rightPaneGridTemplateColumns, startRightPaneResize } = useRightPaneSizing(showRightPane, isWorkflowProject ? 'workflow' : rightPaneSizingMode);
  const { toast, showToast } = useToastNotice();
  const { botConfig, botStatus, bindRemoteAssistant, refreshBotStatus, saveBotConfig, connectWeixin, startDingtalkStream, stopDingtalkStream, testDingtalkMessage } = useBotControls();
  const { applyWebProviderState, clearWebProviderKey, saveWebProviderKey, webProviderState } = useWebProviderSettings();
  const apiConfig = useMemo(() => {
    const patch: Partial<RunConfig> = {};
    for (const key of Object.keys(config) as Array<keyof RunConfig>) {
      const value = config[key];
      if (value !== '' && value !== undefined) {
        (patch as Record<string, unknown>)[key] = value;
      }
    }
    return patch;
  }, [config]);
  const threadApiConfig = useMemo(() => {
    const { themeMode, userAvatarId, customUserAvatarDataUrl, ...threadConfig } = apiConfig;
    void themeMode;
    void userAvatarId;
    void customUserAvatarDataUrl;
    return threadConfig;
  }, [apiConfig]);
  function updatePreparingTurnId(eventThreadId: string, turnId: string): void {
    setPreparingTurn((current) => current && current.threadId === eventThreadId
      ? { ...current, turnId }
      : current);
  }
  function clearPreparingTurn(eventThreadId: string, eventTurnId?: unknown): void {
    setPreparingTurn((current) => {
      if (!current || current.threadId !== eventThreadId) return current;
      if (current.turnId && typeof eventTurnId === 'string' && current.turnId !== eventTurnId) return current;
      return null;
    });
  }
  const transcriptGroups = useMemo(() => groupTranscriptItems(items, turns), [items, turns]);
  const transcriptTurnSummaries = useMemo<TranscriptTurnRailEntry[]>(() => {
    const repliesByTurn = new Map<string, string>();
    for (const group of transcriptGroups) {
      if (group.kind !== 'assistant' || !group.turnId) continue;
      const replies = group.items
        .filter((item) => item.type === 'agent_message')
        .map((item) => item.text ?? '')
        .filter(Boolean);
      repliesByTurn.set(group.turnId, replies[replies.length - 1] ?? '');
    }
    return transcriptGroups
      .filter((group): group is Extract<typeof group, { kind: 'user' }> => group.kind === 'user')
      .map((group) => {
        const id = group.item.turnId ?? group.item.id;
        return {
          id,
          userText: group.item.text ?? '',
          assistantText: group.item.turnId ? repliesByTurn.get(group.item.turnId) ?? '' : '',
        };
      });
  }, [transcriptGroups]);
  const scrollToTranscriptTurn = useCallback((turnId: string) => {
    transcriptTurnRefs.current.get(turnId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const latestRollbackTurnId = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.type === 'user_message' && item.turnId && item.status !== 'in_progress') {
        return item.turnId;
      }
    }
    return undefined;
  }, [items]);
  const subagentRows = useMemo(() => buildSubagentStatusRows(threadChildren, config.locale), [config.locale, threadChildren]);
  void subagentRows;
  const activeWorkspaceRoot = activeThread?.tags?.conversationKind === 'chat' ? '' : (activeThread?.workspaceRoot || config.workspaceRoot || '');
  const childActivityByThread = useMemo(() => buildChildActivityByThread(threadChildren), [threadChildren]);
  const tokenUsage = useMemo(() => {
    return buildTokenUsageSummary(threadUsage, config.locale);
  }, [config.locale, threadUsage]);
  const modelCapabilities = useMemo(() => resolveModelCapabilities({
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    modelContextTokens: config.modelContextTokens,
    modelMaxOutputTokens: config.modelMaxOutputTokens,
  }), [config.baseUrl, config.model, config.modelContextTokens, config.modelMaxOutputTokens, config.provider]);
  const displayCompactionPressure = useMemo(
    () => hasActiveThread ? resolveDisplayContextPressure(compactionPressure, modelCapabilities) : null,
    [compactionPressure, hasActiveThread, modelCapabilities],
  );
  const transcriptContentSignature = useMemo(() => items.map((item) => [
    item.id,
    item.type,
    item.status ?? '',
    // Track every streaming item, not only the last array entry. Reasoning,
    // tool output, and an assistant answer can grow while another item is
    // appended after them; all of those changes may increase scrollHeight.
    item.text?.length ?? 0,
    item.toolName ?? '',
    JSON.stringify(item.result ?? item.error ?? '').length,
  ].join(':')).join('|'), [items]);
  const openRemoteAssistants = useCallback((platform: 'weixin' | 'dingtalk') => {
    const targetThreadId = threadId || undefined;
    void (async () => {
      if (platform === 'weixin') {
        await connectWeixin(targetThreadId, setWeixinConnectState);
        return;
      }
      const dingtalkConfigured = Boolean(botConfig?.dingtalk.enabled && botConfig.dingtalk.clientId && botConfig.dingtalk.clientSecret)
        || botStatus?.dingtalk?.configured === true;
      if (!dingtalkConfigured) {
        setWeixinConnectState({ dialogTitle: '绑定钉钉远程助手', polling: false, error: '请先在设置中配置钉钉机器人。' });
        return;
      }
      if (!targetThreadId) {
        setWeixinConnectState({ dialogTitle: '绑定钉钉远程助手', polling: false, error: '请先选择一个对话再绑定钉钉。' });
        return;
      }
      const bound = await bindRemoteAssistant('dingtalk', targetThreadId);
      setWeixinConnectState({
        dialogTitle: '绑定钉钉远程助手',
        polling: false,
        message: bound ? '钉钉已绑定到当前对话。' : undefined,
        error: bound ? undefined : '钉钉绑定当前对话失败。',
        successTitle: '钉钉已绑定',
      });
    })();
  }, [bindRemoteAssistant, botConfig?.dingtalk.clientId, botConfig?.dingtalk.clientSecret, botConfig?.dingtalk.enabled, botStatus?.dingtalk?.configured, connectWeixin, threadId]);
  const slashVisible = !isWorkflowProject && !activeSlashOption && isSlashInput(input) && !busy && images.length === 0;
  const slashCommandOptions = useMemo<PaletteOption[]>(() => getSlashCommandOptions(config.locale), [config.locale]);
  const filteredSlashOptions = useMemo<PaletteOption[]>(() => {
    if (!slashVisible) return [];
    const trimmed = input.trim().toLowerCase();
    if (trimmed.startsWith('/skills') && !trimmed.startsWith('/skills add')) {
      const query = trimmed.replace(/^\/skills/, '').trim();
      return skillsList
        .filter((skill) => {
          const text = [
            skill.name,
            skill.description,
            localizedSkillDescription(skill, config.locale),
          ].join('\n').toLowerCase();
          return !query || text.includes(query);
        })
        .map((skill) => ({
          id: `skill:${skill.name}`,
          command: `$${skill.name}`,
          title: skill.name,
          detail: localizedSkillDescription(skill, config.locale),
          action: 'insert_skill' as const,
          skillName: skill.name,
          hideCommand: true as const,
        }));
    }
    if (trimmed.startsWith('/mcp') && !trimmed.startsWith('/mcp add')) {
      const query = trimmed.replace(/^\/mcp/, '').trim();
      return mcps
        .filter((mcp) => {
          const text = [mcp.name, mcp.command, mcp.args].join('\n').toLowerCase();
          return !query || text.includes(query);
        })
        .map((mcp) => ({
          id: `mcp:${mcp.id}`,
          command: mcp.enabled
            ? (config.locale === 'zh' ? '已启用' : 'Enabled')
            : (config.locale === 'zh' ? '启用' : 'Enable'),
          title: mcp.name,
          detail: `${mcp.command} ${mcp.args}`.trim(),
          action: 'enable_mcp' as const,
          mcpId: mcp.id,
          hideCommand: true as const,
        }));
    }
    const query = input.slice(1).trim().toLowerCase();
    if (!query) return slashCommandOptions;
    return slashCommandOptions.filter((option) => (
      option.command.toLowerCase().includes(query)
      || option.title.toLowerCase().includes(query)
      || option.detail.toLowerCase().includes(query)
    ));
  }, [config.locale, input, mcps, skillsList, slashCommandOptions, slashVisible]);
  const addEvent = useCallback((event: EventDraft) => {
    eventCounter.current += 1;
    setEvents((current) => {
      const displayKey = [event.kind, event.title, event.detail, event.tone].join('\n');
      const next = {
        id: eventCounter.current,
        key: event.key ?? displayKey,
        kind: event.kind,
        title: event.title,
        detail: event.detail,
        tone: event.tone,
        timestamp: new Date().toISOString(),
      };
      const existingIndex = current.findIndex((item) => {
        if (item.key === next.key) return true;
        return [item.kind, item.title, item.detail, item.tone].join('\n') === displayKey;
      });
      if (existingIndex >= 0) {
        const updated = current.map((item, index) => (index === existingIndex ? { ...item, ...next } : item));
        return [updated[existingIndex], ...updated.filter((_, index) => index !== existingIndex)].slice(0, 80);
      }
      return [next, ...current].slice(0, 80);
    });
  }, [config.locale]);
  const runMonitor = useRunMonitor({ threadId, threadIds: threadChildren.map((child) => child.thread.threadId), locale: config.locale, addEvent });
  const monitorButtonActive = runMonitor.open;
  const openUnifiedMonitor = useCallback(() => {
    runMonitor.openDrawer();
  }, [runMonitor]);
  // 任务中心（P1 只读）：跨线程任务列表抽屉，只读取真实 Task/Run 数据。
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);

  const workbenchCurrentRunId = useMemo(() => {
    if (runMonitor.selectedRunId) return runMonitor.selectedRunId;
    const runningRun = runMonitor.runs.find(r => r.threadId === threadId && r.status === 'running');
    return runningRun?.runId ?? runMonitor.runs.find(r => r.threadId === threadId)?.runId;
  }, [runMonitor.selectedRunId, runMonitor.runs, threadId]);

  const workbenchSelectedRun = useMemo(() => {
    return runMonitor.runs.find(r => r.runId === workbenchCurrentRunId) ?? null;
  }, [runMonitor.runs, workbenchCurrentRunId]);

  const workbenchTraceSummary = useMemo(() => {
    if (!workbenchSelectedRun) return null;
    const traces = runMonitor.traces;
    const modelCalls = traces.filter(t => t.category === 'model' && t.lifecycle !== 'started').length;
    const toolCalls = traces.filter(t => t.category === 'tool' && t.lifecycle !== 'started').length;
    const toolFailed = traces.filter(t => t.category === 'tool' && t.lifecycle === 'failed').length;
    const toolDenied = traces.filter(t => t.category === 'tool' && (t.payload as { decision?: string }).decision === 'deny').length;
    const errorTraces = traces.filter(t => t.category === 'error' || t.level === 'error');
    const lastError = errorTraces[errorTraces.length - 1];
    const checkpointTraces = traces.filter(t => t.category === 'checkpoint' && t.lifecycle === 'completed');
    const lastCheckpoint = checkpointTraces[checkpointTraces.length - 1];
    const runningSpan = traces.filter(t => t.lifecycle === 'started' && !traces.some(t2 => t2.spanId === t.spanId && t2.lifecycle !== 'started')).pop();
    const modelTraces = traces.filter(t => t.category === 'model' && t.lifecycle !== 'started') as Array<{ payload: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; ttftMs?: number } }>;
    const totalInput = modelTraces.reduce((s, t) => s + (t.payload.inputTokens ?? 0), 0);
    const totalOutput = modelTraces.reduce((s, t) => s + (t.payload.outputTokens ?? 0), 0);
    const totalCacheRead = modelTraces.reduce((s, t) => s + (t.payload.cacheReadTokens ?? 0), 0);
    const totalCacheWrite = modelTraces.reduce((s, t) => s + (t.payload.cacheWriteTokens ?? 0), 0);
    const maxTtft = Math.max(...modelTraces.map(t => t.payload.ttftMs ?? 0), 0);
    return {
      status: workbenchSelectedRun.status === 'blocked' ? 'running' : workbenchSelectedRun.status,
      startedAt: workbenchSelectedRun.startedAt,
      completedAt: workbenchSelectedRun.completedAt ?? undefined,
      durationMs: workbenchSelectedRun.completedAt
        ? new Date(workbenchSelectedRun.completedAt).getTime() - new Date(workbenchSelectedRun.startedAt).getTime()
        : Date.now() - new Date(workbenchSelectedRun.startedAt).getTime(),
      currentSpan: workbenchSelectedRun.status === 'running' && runningSpan
        ? { spanId: runningSpan.spanId, category: runningSpan.category, name: runningSpan.name }
        : undefined,
      model: {
        calls: modelCalls || workbenchSelectedRun.modelCallCount,
        inputTokens: totalInput || workbenchSelectedRun.inputTokens,
        outputTokens: totalOutput || workbenchSelectedRun.outputTokens,
        cacheReadTokens: totalCacheRead || workbenchSelectedRun.cachedInputTokens,
        cacheWriteTokens: totalCacheWrite,
        maxTtftMs: maxTtft > 0 ? maxTtft : undefined,
      },
      tools: { calls: toolCalls || workbenchSelectedRun.toolCallCount, failed: toolFailed, denied: toolDenied },
      items: { started: 0, completed: 0, failed: 0, byType: {} },
      agents: { spawned: workbenchSelectedRun.subagentCount, running: 0, failed: 0 },
      files: { reads: 0, changed: 0, addedLines: 0, removedLines: 0, extracted: 0, reused: 0, stale: 0, refreshed: 0 },
      lastError: lastError && lastError.category === 'error'
        ? { code: (lastError.payload as { code?: string })?.code ?? 'ERROR', message: (lastError.payload as { message?: string })?.message ?? lastError.name }
        : (workbenchSelectedRun.error ? { code: 'RUN_ERROR', message: workbenchSelectedRun.error } : undefined),
      lastCheckpointId: lastCheckpoint ? (lastCheckpoint.payload as { checkpointId?: string })?.checkpointId : undefined,
    };
  }, [workbenchSelectedRun, runMonitor.traces]);

  const jumpToMonitor = useCallback((opts: { runId?: string; eventId?: string; itemId?: string; threadId?: string }) => {
    const { runId, eventId, itemId, threadId } = opts;
    if (itemId && !runId && !eventId && !threadId) {
      const target = document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('itemJumpHighlight');
        setTimeout(() => target.classList.remove('itemJumpHighlight'), 1800);
        return;
      }
    }
    let targetRunId = runId;
    if (!targetRunId && threadId) {
      const runForThread = runMonitor.runs.find(r => r.threadId === threadId && r.status === 'running')
        ?? runMonitor.runs.find(r => r.threadId === threadId);
      if (runForThread) {
        targetRunId = runForThread.runId;
      }
    }
    if (eventId || itemId) {
      if (threadId) {
        runMonitor.toggleThread(threadId);
      }
      runMonitor.focusTraceTarget({ runId: targetRunId, eventId, itemId });
      return;
    }
    if (threadId && !targetRunId) {
      runMonitor.focusThread(threadId);
      return;
    }
    runMonitor.openDrawer();
    if (threadId) {
      runMonitor.toggleThread(threadId);
    }
    if (targetRunId) {
      runMonitor.selectRun(targetRunId);
    }
  }, [runMonitor]);

  const handleControlInterrupt = useCallback(() => {
    if (workbenchSelectedRun) {
      void runMonitor.controlRun('interrupt', workbenchSelectedRun);
    } else {
      void stopTurn();
    }
  }, [runMonitor, workbenchSelectedRun]);

  const handleControlResume = useCallback(() => {
    if (workbenchSelectedRun) {
      void runMonitor.controlRun('resume', workbenchSelectedRun);
    }
  }, [runMonitor, workbenchSelectedRun]);

  const handleControlRollback = useCallback((checkpointId?: string) => {
    if (workbenchSelectedRun) {
      void runMonitor.controlRun('rollback', workbenchSelectedRun, { checkpointId });
    } else {
      void threadAction('rollback', 1);
    }
  }, [runMonitor, workbenchSelectedRun]);

  const [responsiveMode, setResponsiveMode] = useState<'side' | 'overlay' | 'sheet'>('side');
  useEffect(() => {
    function update() {
      const w = window.innerWidth;
      if (w >= 1180) setResponsiveMode('side');
      else if (w >= 768) setResponsiveMode('overlay');
      else setResponsiveMode('sheet');
    }
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const handleCloseWorkbench = useCallback(() => {
    if (hasActiveThread && threadId) writeStoredRightPaneVisibility(false, threadId);
    setRightPaneVisible(false);
  }, [hasActiveThread, threadId]);
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && (responsiveMode === 'overlay' || responsiveMode === 'sheet')) {
        handleCloseWorkbench();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleCloseWorkbench, responsiveMode]);

  const mergeApproval = useCallback((approval: ApprovalRequest) => {
    setPendingApprovals((current) =>
      current.some((item) => item.requestId === approval.requestId) ? current : [...current, approval],
    );
  }, []);
 const refreshThreads = useCallback(async () => {
   const response = await fetch('/api/threads');
    if (!response.ok) return;
    const data = (await response.json().catch(() => null)) as { threads?: ThreadMeta[] } | null;
    setThreads(data?.threads ?? []);
 }, []);
  // 检测线程从 running 变为非 running：标记未查看的线程为未读
  // Chinese: detect running→idle transitions and mark non-active threads as unread
  useEffect(() => {
    const prev = prevThreadStatusesRef.current;
    const next: Record<string, string> = {};
    const newlyCompleted: string[] = [];
    for (const thread of threads) {
      next[thread.threadId] = thread.status;
      if (prev[thread.threadId] === 'running' && thread.status !== 'running' && thread.threadId !== threadId) {
        newlyCompleted.push(thread.threadId);
      }
    }
    if (newlyCompleted.length > 0) {
      setUnreadThreadIds((current) => {
        const updated = new Set(current);
        for (const id of newlyCompleted) updated.add(id);
        return updated;
      });
    }
    prevThreadStatusesRef.current = next;
  }, [threads, threadId]);
  const refreshApprovals = useCallback(async () => {
    const response = await fetch('/api/approvals');
    if (!response.ok) return;
    const data = (await response.json()) as { approvals?: ApprovalRequest[] };
    setPendingApprovals(data.approvals ?? []);
  }, []);
  const refreshProviders = useCallback(async () => {
    const [providerResponse, keyResponse] = await Promise.all([
      fetch('/api/providers'),
      fetch('/api/keys'),
    ]);
    if (providerResponse.ok) {
      const data = (await providerResponse.json()) as { providers?: ProviderEntry[] };
      setProviders(data.providers ?? []);
    }
    if (keyResponse.ok) {
      const data = (await keyResponse.json()) as { keys?: ApiKeyState[] };
      setKeyStates(data.keys ?? []);
    }
  }, []);
  // P2.3 单独刷新 keyStates：保存 preset 后用于 server truth reconcile
  const refreshKeyStates = useCallback(async () => {
    const response = await fetch('/api/keys');
    if (!response.ok) return;
    const data = (await response.json()) as { keys?: ApiKeyState[] };
    setKeyStates(data.keys ?? []);
  }, []);
  const refreshModelPresets = useCallback(async () => {
    const response = await fetch('/api/model-presets');
    if (!response.ok) return;
    const data = (await response.json()) as { presets?: ModelPreset[] };
    setModelPresets(data.presets ?? []);
  }, []);
  const refreshSkills = useCallback(async (options: { forceReload?: boolean } = {}) => {
    const response = await fetch(options.forceReload ? '/api/skills?forceReload=1' : '/api/skills');
    if (!response.ok) return;
    const data = (await response.json()) as { skills?: SkillEntry[] };
    setSkillsList(data.skills ?? []);
  }, []);
  const refreshMcpStatus = useCallback(async (detail: 'light' | 'full' = 'light') => {
    try {
      const response = await fetch(detail === 'full' ? '/api/mcp/status?detail=full' : '/api/mcp/status');
      if (!response.ok) return;
      const data = (await response.json()) as { servers?: McpServerStatus[] };
      setMcpStatuses(data.servers ?? []);
    } catch (error) {
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? 'MCP 状态刷新失败' : 'MCP status refresh failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }, [addEvent, config.locale]);
  const refreshThreadChildren = useCallback(async (id: string) => {
    if (!id) return setThreadChildren([]);
    const response = await fetch(`/api/threads/${id}/children?recursive=1`);
    if (!response.ok) return setThreadChildren([]);
    const data = (await response.json()) as { children?: ThreadChildInfo[] };
    setThreadChildren(data.children ?? []);
  }, []);
  const reloadThreadSnapshot = useCallback(async (id: string, guard?: { signal?: AbortSignal; isCurrent: () => boolean; preserveCurrentItems?: boolean; terminalTurnId?: string; reconcileBusy?: boolean; requestEpoch?: number }) => {
    let response: Response;
    try {
      response = await fetch(`/api/threads/${id}?includeChildren=1`, guard?.signal ? { signal: guard.signal } : undefined);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      throw error;
    }
    if (!response.ok) return;
    if (guard && !guard.isCurrent()) return;
    const data = (await response.json()) as {
      thread?: ThreadMeta;
      turns?: TurnMeta[];
      items: ThreadItem[];
      config?: RunConfig;
      usage?: ThreadUsage;
    };
    let runtimeState: RuntimeStateSnapshot | null = null;
    try {
      const stateResponse = await fetch('/api/threads/' + id + '/state', guard?.signal ? { signal: guard.signal } : undefined);
      if (stateResponse.ok) {
        const stateData = (await stateResponse.json()) as { state?: RuntimeStateSnapshot | null };
        runtimeState = stateData.state ?? null;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
    if (guard && !guard.isCurrent()) return;
    // Reconciliation can finish after the user switches away; it must never
    // write the old thread into the newly selected transcript.
    if (threadIdRef.current !== id) return;
    if (data.thread) {
      setThreads((current) => current.map((thread) => thread.threadId === id ? data.thread! : thread));
    }
    setTurns(data.turns ?? []);
    setThreadUsage(data.usage ?? null);
    const runningTurns = (data.turns ?? []).filter((turn) => turn.status === 'running');
    setRunningTurnIds(new Set(runningTurns.map((turn) => turn.turnId)));
    // Rehydrate the lightweight pre-first-event marker after a thread switch
    // or SSE reconnect. Preserve a locally-started turn until its first
    // persisted turn metadata arrives, but clear a known turn once the
    // snapshot reports it as terminal.
    setPreparingTurn((current) => {
      const runningTurn = runningTurns[0];
      if (runningTurn) return { threadId: id, turnId: runningTurn.turnId };
      if (!current || current.threadId !== id || !current.turnId) return current?.threadId === id ? current : null;
      return (data.turns ?? []).some((turn) => turn.turnId === current.turnId) ? null : current;
    });
    const snapshotItems = withSyntheticUserMessages(data.turns ?? [], data.items ?? []) as ThreadItem[];
    // A failed turn can finish persisting just after the snapshot request was
    // read. Keep terminal error items already visible for turns that still
    // exist in this thread, so a refresh cannot make the failure disappear.
    const snapshotTurnIds = new Set((data.turns ?? []).map((turn) => turn.turnId));
    setItems((current) => {
      if (threadIdRef.current !== id) return snapshotItems;
      // A terminal event or SSE reconnect can race the storage write that
      // produced the snapshot. Keep the live stream first so a stale read
      // cannot make the beginning or middle of the answer disappear.
      if (guard?.preserveCurrentItems) return mergeIncomingItems(current, snapshotItems);
      const visibleErrors = current.filter((item) =>
        item.type === 'error' && typeof item.turnId === 'string' && snapshotTurnIds.has(item.turnId),
      );
      return mergeIncomingItems(snapshotItems, visibleErrors);
    });
    const busyDecision = resolveSnapshotBusy({
      turns: data.turns ?? [],
      runtimeStatus: runtimeState?.executionStatus,
      reconcileBusy: guard?.reconcileBusy,
      knownTurnIds: turnWatchRef.current?.threadId === id ? turnWatchRef.current.knownTurnIds : undefined,
      terminalTurnId: guard?.terminalTurnId,
      requestEpoch: guard?.requestEpoch,
      watchEpoch: turnWatchEpochRef.current,
    });
    if (busyDecision.applyLifecycle) {
      setRunningTurnIds(new Set(runningTurns.map((turn) => turn.turnId)));
      setBusy(busyDecision.busy);
      if (busyDecision.clearPreparingTurn) setPreparingTurn(null);
    }
    if (data.config) {
      const { themeMode, userAvatarId, customUserAvatarDataUrl, ...threadConfig } = data.config;
      void themeMode;
      void userAvatarId;
      void customUserAvatarDataUrl;
      setConfig(() => ({
        ...globalConfigRef.current,
        ...threadConfig,
        hasWorkspace: threadConfig.hasWorkspace !== false,
        workspaceRoot: threadConfig.hasWorkspace === false ? '' : threadConfig.workspaceRoot,
      }));
    }
    if (guard && !guard.isCurrent()) return;
    try {
      const workflowData = await loadThreadWorkflow(id);
      if (guard && !guard.isCurrent()) return;
      setWorkflowComponents(workflowData.components ?? []);
      setWorkflowBlueprint(workflowData.blueprint ?? null);
    } catch {
      if (guard && !guard.isCurrent()) return;
      setWorkflowComponents([]);
      setWorkflowBlueprint(null);
    }
    if (guard && !guard.isCurrent()) return;
    await refreshThreadChildren(id);
  }, [refreshThreadChildren]);
  const requestWorkflowPlan = useCallback(async (goal: string) => {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal || !threadId) return;
    const draftTurnId = `workflow_draft_${Date.now()}`;
    setWorkflowPlanning(true);
    try {
      const editableWorkflow = activeWorkflow && activeWorkflow.definition.nodes.length > 0 ? activeWorkflow : null;
      const selectedScope = editableWorkflow?.definition.nodes
        .filter((node) => workflowSelectedNodeIds.includes(node.id))
        .map((node) => `${node.id}（${node.title}）`)
        .join('、') ?? '';
      const effectiveGoal = editableWorkflow
        ? `${editableWorkflow.definition.goal}${selectedScope ? `\n\n修改范围：${selectedScope}` : ''}\n\n修改要求：${trimmedGoal}`
        : trimmedGoal;
      const draft = await planWorkflowDraft(effectiveGoal, threadId);
      setWorkflowPlanDraft(draft);
      setWorkflowComponents(draft.components);
      setWorkflowBlueprint(draft.blueprint ?? null);
      setItems((current) => mergeIncomingItems(
        current,
        draft.items?.length ? draft.items : [
          createWorkflowDraftUserItem(trimmedGoal, draftTurnId),
          createWorkflowDraftReplyItem(draft, config.locale, draftTurnId),
        ],
      ) as ThreadItem[]);
      if (isUntitledWorkflowProjectTitle(activeThread?.title)) {
        void renameConversation(threadId, workflowThreadTitleFromGoal(draft.workflow.definition.goal, config.locale === 'zh' ? '未命名工作流项目' : 'Untitled workflow project'))
          .catch(() => undefined);
      }
      addEvent({
        kind: 'workflow',
        title: config.locale === 'zh' ? '计划草案已生成' : 'Plan draft ready',
        detail: draft.workflow.definition.goal,
        tone: 'success',
      });
    } catch (error) {
      setItems((current) => mergeIncomingItems(current, [
        createWorkflowDraftUserItem(trimmedGoal, draftTurnId),
        createWorkflowDraftErrorItem(error instanceof Error ? error.message : String(error), config.locale, draftTurnId),
      ]) as ThreadItem[]);
      addEvent({
        kind: 'workflow',
        title: config.locale === 'zh' ? '计划生成失败' : 'Plan failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setWorkflowPlanning(false);
    }
  }, [activeThread?.title, activeWorkflow, addEvent, config.locale, threadId, workflowSelectedNodeIds]);
  const commitWorkflowPlan = useCallback(async () => {
    if (!threadId || !workflowPlanDraft) return;
    setWorkflowSaving(true);
    try {
      const data = await saveThreadWorkflow(threadId, workflowPlanDraft.workflow);
      if (data.thread) setThreads((current) => current.map((thread) => thread.threadId === threadId ? data.thread! : thread));
      setWorkflowComponents(data.components ?? workflowPlanDraft.components);
      setWorkflowBlueprint(data.blueprint ?? workflowPlanDraft.blueprint ?? null);
      setWorkflowPlanDraft(null);
      addEvent({
        kind: 'workflow',
        title: config.locale === 'zh' ? '计划已保存' : 'Plan saved',
        detail: data.workflow?.definition.goal ?? workflowPlanDraft.goal,
        tone: 'success',
      });
    } catch (error) {
      addEvent({
        kind: 'workflow',
        title: config.locale === 'zh' ? '保存失败' : 'Save failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setWorkflowSaving(false);
    }
  }, [addEvent, config.locale, threadId, workflowPlanDraft]);
  const saveWorkflow = useCallback(async (workflow: WorkflowSnapshot) => {
    if (!threadId) return;
    setWorkflowSaving(true);
    try {
      const response = await fetch(`/api/threads/${threadId}/workflow`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow }),
      });
      const data = (await response.json()) as { thread?: ThreadMeta; workflow?: WorkflowSnapshot; components?: WorkflowComponentDefinition[]; blueprint?: WorkflowBlueprintCompileResult | null; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Workflow save failed');
      if (data.thread) setThreads((current) => current.map((thread) => thread.threadId === threadId ? data.thread! : thread));
      setWorkflowComponents(data.components ?? workflowComponents);
      setWorkflowBlueprint(data.blueprint ?? workflowBlueprint);
      addEvent({
        kind: 'workflow',
        title: config.locale === 'zh' ? '节点已保存' : 'Workflow saved',
        detail: data.workflow?.definition.goal ?? '',
        tone: 'success',
      });
    } catch (error) {
      addEvent({
        kind: 'workflow',
        title: config.locale === 'zh' ? '保存失败' : 'Save failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setWorkflowSaving(false);
    }
  }, [addEvent, config.locale, threadId, workflowBlueprint, workflowComponents]);
  const controlWorkflowRuntime = useCallback(async (action: WorkflowRuntimeAction, nodeId?: string) => { if (!threadId || !activeWorkflow) return; setWorkflowRuntimeBusy(true);
    try { const data = await controlThreadWorkflow(threadId, action, { nodeId, runId: activeWorkflow.run.id, input: { goal: activeWorkflow.definition.goal } }); if (data.thread) setThreads((current) => current.map((thread) => thread.threadId === threadId ? data.thread! : thread)); setWorkflowComponents(data.components ?? workflowComponents); setWorkflowBlueprint(data.blueprint ?? workflowBlueprint); addEvent({ kind: 'workflow', title: config.locale === 'zh' ? '工作流状态已更新' : 'Workflow updated', detail: data.workflow?.run.status ?? action, tone: data.workflow?.run.status === 'failed' ? 'danger' : data.workflow?.run.status === 'blocked' ? 'warning' : 'success' }); if (runMonitor.open) void runMonitor.refresh(runMonitor.selectedRunId || undefined); }
    catch (error) { addEvent({ kind: 'workflow', title: config.locale === 'zh' ? '工作流运行失败' : 'Workflow runtime failed', detail: error instanceof Error ? error.message : String(error), tone: 'danger' }); }
    finally { setWorkflowRuntimeBusy(false); }
  }, [activeWorkflow, addEvent, config.locale, runMonitor, threadId, workflowBlueprint, workflowComponents]);
  const loadThread = useCallback(
    async (id: string) => {
      if (!id) return;
      const request = threadLoadGuardRef.current.begin();
      if (eventSourceRecoveryTimerRef.current !== null) {
        window.clearTimeout(eventSourceRecoveryTimerRef.current);
        eventSourceRecoveryTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setThreadId(id);
      threadIdRef.current = id;
      setUnreadThreadIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setWorkflowPlanDraft(null);
      setEvents([]);
      setCompactionPressure(null);
      setTranscriptFollow({ following: true, showReturnToBottom: false });
      taskRuntimeMonitor.clear();
      const isCurrent = () => threadLoadGuardRef.current.isCurrent(request.generation);
      const sourceGeneration = request.generation;
      threadEventSourceGenerationRef.current = sourceGeneration;
      const source = new EventSource(`/api/events/${id}`);
      // Subscribe before the snapshot request. Events can arrive while the
      // thread payload is loading; replay them after the initial state is set.
      const preSnapshotMessages: MessageEvent[] = [];
      let lastEventSequence = 0;
      let connectionFailedBeforeSubscription = false;
      const reconnectLimit = Math.max(0, Math.floor(config.eventStreamReconnectLimit ?? 5));
      const offlineReconnectLimit = Math.max(0, Math.floor(config.offlineReconnectLimit ?? 5));
      const offlineBackoffMs = Math.max(500, config.streamIdleTimeoutSeconds ? 1_000 : 1_000);
      let preSubscriptionReconnects = 0;
      let offlineTimer: number | null = null;
      const closeForOfflineRetry = () => {
        if (offlineTimer !== null) return;
        source.close();
        eventSourceRef.current = null;
        offlineTimer = window.setTimeout(() => {
          offlineTimer = null;
          void loadThread(id);
        }, offlineBackoffMs);
      };
      source.onmessage = (message) => {
        if (isCurrent()) preSnapshotMessages.push(message);
      };
      source.onerror = () => {
        if (navigator.onLine === false) {
          if (preSubscriptionReconnects < offlineReconnectLimit) {
            preSubscriptionReconnects += 1;
            closeForOfflineRetry();
            return;
          }
          connectionFailedBeforeSubscription = true;
          return;
        }
        if (preSubscriptionReconnects < reconnectLimit) {
          preSubscriptionReconnects += 1;
          return;
        }
        connectionFailedBeforeSubscription = true;
      };
      source.addEventListener('thread.replay.gap', () => {
        if (!isCurrent()) return;
        void reloadThreadSnapshot(id, { isCurrent, preserveCurrentItems: true }).catch(() => undefined);
      });
      eventSourceRef.current = source;
      await reloadThreadSnapshot(id, { signal: request.signal, isCurrent });
      if (!isCurrent()) return;
      try {
        const overrides = await fetchThreadConfigOverrides(id);
        if (!isCurrent()) return;
        // Thread overrides are scoped to the selected conversation. Always
        // rebuild from the global snapshot so an older conversation cannot
        // leak its context window into the next one.
        setConfig(() => ({ ...globalConfigRef.current, ...overrides }));
      } catch {
        if (!isCurrent()) return;
      }
      void (async () => {
        try {
          const response = await fetch(`/api/threads/${id}/context-pressure`, request.signal ? { signal: request.signal } : undefined);
          if (!response.ok) return;
          const data = await response.json() as { pressure?: { estimatedTokens?: number; maxTokens?: number; softThreshold?: number; hardThreshold?: number; ratio?: number; status?: string } };
          if (!isCurrent()) return;
          if (data.pressure) {
            flushSync(() => {
              setCompactionPressure(data.pressure as never);
            });
          }
        } catch {
          // 主动查询失败时不阻断，后续 SSE 事件仍可更新
        }
      })();
      source.onmessage = (message) => {
        if (!threadLoadGuardRef.current.isCurrent(sourceGeneration)) return;
        try {
          const event = JSON.parse(message.data) as Record<string, unknown>;
          if (event.type === 'connected') return;
          if (typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence)) {
            if (event.sequence <= lastEventSequence) return;
            lastEventSequence = event.sequence;
          }
          const described = describeEvent(event, config.locale);
          if (described) addEvent(described);
          if (event.type === 'turn.started' && typeof event.turnId === 'string') {
            activeTurnIdRef.current = event.turnId;
            updatePreparingTurnId(id, event.turnId);
            setRunningTurnIds((current) => new Set([...current, event.turnId as string]));
          }
          if (
            (event.type === 'turn.completed' || event.type === 'turn.failed')
            && typeof event.turnId === 'string'
          ) {
            const belongsToActiveTurn = activeTurnThreadIdRef.current === id
              && (!activeTurnIdRef.current || activeTurnIdRef.current === event.turnId);
            setRunningTurnIds((current) => {
              const next = new Set(current);
              next.delete(event.turnId as string);
              return next;
            });
            clearPreparingTurn(id, event.turnId);
            if (belongsToActiveTurn) {
              setBusy(false);
              activeTurnIdRef.current = '';
              activeTurnThreadIdRef.current = '';
              setStatus(event.type === 'turn.failed' ? (config.locale === 'zh' ? '回复失败' : 'Turn failed') : t(config.locale, 'idle'));
            }
            void reloadThreadSnapshot(id, { isCurrent, preserveCurrentItems: true, terminalTurnId: event.turnId });
            void refreshThreadChildren(id);
            if (runMonitor.open) void runMonitor.refresh(runMonitor.selectedRunId || undefined);
          }
          if (event.type === 'thread.runtime.updated' && event.status === 'terminal' && typeof event.turnId === 'string') {
            const belongsToActiveTurn = activeTurnThreadIdRef.current === id
              && (!activeTurnIdRef.current || activeTurnIdRef.current === event.turnId);
            if (belongsToActiveTurn) {
              setBusy(false);
              activeTurnIdRef.current = '';
              activeTurnThreadIdRef.current = '';
              setStatus(event.terminalStatus === 'failed' ? (config.locale === 'zh' ? '回复失败' : 'Turn failed') : t(config.locale, 'idle'));
              clearPreparingTurn(id, event.turnId);
            }
          }
          if (event.type === 'approval.required' && typeof event.requestId === 'string') {
            mergeApproval(event as unknown as ApprovalRequest);
          }
          if (event.type === 'approval.resolved' && typeof event.requestId === 'string') {
            setPendingApprovals((current) => current.filter((item) => item.requestId !== event.requestId));
          }
          if (event.type === 'thread.token_usage.updated' && event.usage) {
            flushSync(() => {
              setThreadUsage(event.usage as ThreadUsage);
            });
          }
          if (event.type === 'thread.metadata.updated' && typeof event.threadId === 'string') {
            setThreads((current) =>
              current.map((t) => {
                if (t.threadId !== event.threadId) return t;
                const updated: ThreadMeta = { ...t };
                if (typeof event.title === 'string') updated.title = event.title;
                if (typeof event.status === 'string') updated.status = event.status as ThreadMeta['status'];
                return updated;
              }),
            );
          }
          if (event.type === 'context.compaction_pressure' && event.pressure) {
            flushSync(() => {
              setCompactionPressure(event.pressure as never);
            });
          }
          if (event.type === 'thread.compacted.v2' && event.trigger === 'auto' && typeof event.turnId === 'string') {
            const compactionItemId = eventItemId(event) ?? `${event.turnId}:auto`;
            const progressItemId = `compaction-progress:${compactionItemId}`;
            const failed = event.phase === 'failed';
            const completed = event.phase === 'completed';
            const errorMessage = event.error && typeof event.error === 'object' && typeof (event.error as { message?: unknown }).message === 'string'
              ? (event.error as { message: string }).message
              : '';
            setItems((current) => mergeIncomingItems(current, [{
              id: progressItemId,
              type: 'reasoning',
              turnId: event.turnId as string,
              status: failed ? 'failed' : completed ? 'completed' : 'in_progress',
              text: failed
                ? `上下文压缩失败：${errorMessage || '未能生成摘要。'}`
                : completed ? '上下文压缩完成。' : '上下文正在压缩…',
              timestamp: new Date().toISOString(),
              ...(completed || failed ? { completedAt: new Date().toISOString() } : {}),
            } as ThreadItem]));
            clearPreparingTurn(id, event.turnId);
          }
          if (event.type === 'child_agent.event') {
            void refreshThreadChildren(id);
          }
          if (event.type === 'harness.state.updated' && typeof event.harnessRunId === 'string') {
            if ((event.status as string) !== 'active') void refreshThreadChildren(id);
          }
          if (isTaskRuntimeEvent(event)) taskRuntimeMonitor.applyEvent(event);
          if (event.type === 'agent_message.delta') {
            clearPreparingTurn(id, event.turnId);
            setItems((current) => applyAgentMessageDelta(current, event as never) as ThreadItem[]);
          }
          if (event.type === 'item.discarded' && typeof event.itemId === 'string') {
            const itemId = event.itemId;
            setItems((current) => removeThreadItem(current, itemId) as ThreadItem[]);
          }
          if (
            (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
            && event.item
          ) {
            setItems((current) => mergeIncomingItems(current, [event.item as ThreadItem]));
            const item = event.item as ThreadItem;
            if (item.type !== 'user_message') clearPreparingTurn(id, event.turnId ?? item.turnId);
            if (item.type === 'collab_tool_call') {
              void refreshThreadChildren(id);
            }
          }
        } catch {
          addEvent({
            kind: 'event',
            title: config.locale === 'zh' ? '事件解析失败' : 'Event parse failed',
            detail: config.locale === 'zh' ? '服务器事件格式无效，已重新同步当前对话。' : 'The server event was malformed; the current conversation will be resynced.',
            tone: 'warning',
          });
          void reloadThreadSnapshot(id, { isCurrent, preserveCurrentItems: true }).catch(() => undefined);
        }
      };
      let recovering = connectionFailedBeforeSubscription;
      let reconnectAttempts = 0;
      source.onopen = () => {
        if (!threadLoadGuardRef.current.isCurrent(sourceGeneration) || eventSourceRef.current !== source) return;
        const wasRecovering = recovering;
        recovering = false;
        reconnectAttempts = 0;
        if (wasRecovering) {
          void reloadThreadSnapshot(id, {
            isCurrent: () => threadLoadGuardRef.current.isCurrent(sourceGeneration),
            preserveCurrentItems: true,
          }).catch(() => undefined);
        }
      };
      source.onerror = () => {
        if (!threadLoadGuardRef.current.isCurrent(sourceGeneration) || eventSourceRef.current !== source) return;
        reconnectAttempts += 1;
        if (navigator.onLine === false && reconnectAttempts <= offlineReconnectLimit) {
          closeForOfflineRetry();
          return;
        }
        if (reconnectAttempts > reconnectLimit) {
          source.close();
          eventSourceRef.current = null;
          addEvent({
            kind: 'events',
            title: config.locale === 'zh' ? '连接已停止重试' : 'Reconnect stopped',
            detail: config.locale === 'zh' ? `事件连接重试 ${reconnectLimit} 次后停止；刷新或重新选择对话可恢复。` : `Stopped after ${reconnectLimit} reconnect attempts. Reload or reopen the thread.`,
            tone: 'danger',
          });
          return;
        }
        if (!recovering) {
          recovering = true;
          addEvent({
            kind: 'events',
            title: config.locale === 'zh' ? '连接恢复中' : 'Reconnecting',
            detail: config.locale === 'zh' ? '事件连接断开，正在重新拉取当前对话。' : 'The event stream disconnected; reloading the current thread.',
            tone: 'warning',
          });
        }
        if (eventSourceRecoveryTimerRef.current !== null) return;
        eventSourceRecoveryTimerRef.current = window.setTimeout(() => {
          eventSourceRecoveryTimerRef.current = null;
          if (!threadLoadGuardRef.current.isCurrent(sourceGeneration) || eventSourceRef.current !== source) return;
          void reloadThreadSnapshot(id, {
            isCurrent: () => threadLoadGuardRef.current.isCurrent(sourceGeneration),
            preserveCurrentItems: true,
          }).catch(() => undefined);
        }, 700);
      };
      // Apply messages received between subscription and snapshot completion.
      // Keep this after the full handler is installed so no lifecycle event is lost.
      const pendingMessages = preSnapshotMessages.splice(0);
      for (const message of pendingMessages) source.onmessage?.(message);
    },
    [addEvent, config.locale, mergeApproval, refreshThreadChildren, reloadThreadSnapshot, runMonitor, taskRuntimeMonitor],
  );
  useEffect(() => {
    fetch('/api/settings')
      .then((response) => response.ok ? response.json().catch(() => null) : null)
      .then((data: ({ config?: Partial<RunConfig>; stored?: boolean } & SettingsResponseWithWebProvider) | null) => {
        if (!data) { setConfigHydrated(true); return; }
        setConfig((current) => {
          if (data.stored || !hasStoredRunConfig) {
            const next = { ...defaultConfig, ...data.config };
            globalConfigRef.current = next;
            return next;
          }
          const next = mergeRunConfigDefaults(data.config, current);
          globalConfigRef.current = next;
          return next;
        });
        applyWebProviderState(data);
        setConfigHydrated(true);
      })
      .catch(() => setConfigHydrated(true));
    void refreshThreads();
    void refreshProviders();
    void refreshModelPresets();
    void refreshSkills();
    void refreshBotStatus();
    fetch('/api/mcp')
      .then((response) => response.ok ? response.json() : null)
      .then((data: { servers?: McpConfig[] } | null) => {
        if (data?.servers) {
          setMcps(normalizeStoredMcps(data.servers));
        }
        setMcpHydrated(true);
        void refreshMcpStatus('light');
      })
      .catch(() => setMcpHydrated(true));
    return () => {
      if (eventSourceRecoveryTimerRef.current !== null) {
        window.clearTimeout(eventSourceRecoveryTimerRef.current);
        eventSourceRecoveryTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      threadLoadGuardRef.current.dispose();
      sendMessageGuardRef.current.dispose();
    };
  }, [applyWebProviderState, hasStoredRunConfig, refreshBotStatus, refreshMcpStatus, refreshModelPresets, refreshProviders, refreshSkills, refreshThreads]);
  useEffect(() => {
    void refreshApprovals();
    const timer = window.setInterval(() => void refreshApprovals(), 2000);
    return () => window.clearInterval(timer);
  }, [refreshApprovals]);
  // Web 端同样按线程恢复活动 Ops 任务。只有非终态任务才会进入工作台；
  // waiting_confirmation/blocked 还会在主聊天流显示锚点，避免隐藏侧栏造成死锁。
  useEffect(() => {
    setOpsTask(null);
    if (!threadId || !hasActiveThread) return undefined;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const listResponse = await fetch(`/api/ops/tasks?threadId=${encodeURIComponent(threadId)}&limit=20`);
        if (!listResponse.ok || disposed) return;
        const listed = await listResponse.json() as { tasks?: Array<{ spec?: { taskId?: unknown }; state?: unknown }> };
        const candidate = (listed.tasks ?? []).find((item) =>
          typeof item.spec?.taskId === 'string'
          && ['draft', 'queued', 'running', 'paused', 'waiting_confirmation', 'verifying', 'blocked'].includes(String(item.state)),
        );
        const candidateTaskId = typeof candidate?.spec?.taskId === 'string' ? candidate.spec.taskId : '';
        if (!candidateTaskId) { setOpsTask(null); return; }
        const detailResponse = await fetch(`/api/ops/tasks/${encodeURIComponent(candidateTaskId)}`);
        if (disposed) return;
        if (!detailResponse.ok) { setOpsTask(null); return; }
        const detail = await detailResponse.json() as { task?: OpsTaskSession };
        if (!disposed && detail.task?.spec.threadId === threadId) setOpsTask(detail.task);
        else if (!disposed) setOpsTask(null);
      } catch {
        // Ops 状态是辅助面板；网络瞬断不应影响普通对话输入。
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [hasActiveThread, threadId]);
  const handleOpsTaskAction = useCallback(async (action: OpsAnchorAction): Promise<void> => {
    if (!opsTask || !threadId || opsTaskBusy) return;
    setOpsTaskBusy(true);
    try {
      const response = await fetch(`/api/ops/tasks/${encodeURIComponent(opsTask.spec.taskId)}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, expectedTaskVersion: opsTask.taskVersion }),
      });
      if (!response.ok) throw new Error(parseApiErrorMessage(await response.json().catch(() => null), 'Ops 操作失败', config.locale));
      const data = await response.json() as { task?: OpsTaskSession };
      if (data.task?.spec.threadId === threadId) setOpsTask(data.task);
    } catch (error) {
      addEvent({ kind: 'error', title: config.locale === 'zh' ? '运维操作失败' : 'Ops action failed', detail: error instanceof Error ? error.message : String(error), tone: 'warning' });
    } finally {
      setOpsTaskBusy(false);
    }
  }, [addEvent, config.locale, opsTask, opsTaskBusy, threadId]);
  useEffect(() => {
    if (!configHydrated) return;
    if (!threadId && !persistedThreadIdRef.current) {
      globalConfigRef.current = config;
    }
    persistedThreadIdRef.current = threadId;
    localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify(globalConfigRef.current));
  }, [config, configHydrated, threadId]);
  useEffect(() => {
    // 只从真实线程和当前选择恢复工作区；删除后不要再把旧根写回 localStorage。
    // — English: restore roots only from real threads/current selection; never resurrect deleted roots.
    const realRoots = compactWorkspaceRoots([config.workspaceRoot, ...threads.map((thread) => thread.workspaceRoot)]);
    setRememberedWorkspaceRoots((current) => {
      const keys = new Set(realRoots.map((root) => workspaceKey(root)));
      return saveRememberedWorkspaceRoots([...realRoots, ...current.filter((root) => keys.has(workspaceKey(root)))]);
    });
  }, [config.workspaceRoot, threads]);
  useEffect(() => {
    if (!mcpHydrated) return;
    void fetch('/api/mcp', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers: mcps }),
    })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { statuses?: McpServerStatus[] } | null) => {
        if (data?.statuses) setMcpStatuses(data.statuses);
      })
      .catch((error) => {
        addEvent({
          kind: 'error',
          title: config.locale === 'zh' ? 'MCP 配置保存失败' : 'MCP config save failed',
          detail: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        });
      });
  }, [addEvent, config.locale, mcpHydrated, mcps]);
  function scheduleTranscriptFollow(force = false): void {
    if (!force && !transcriptFollowRef.current.following) return;
    if (transcriptAutoScrollFrameRef.current !== null) return;
    transcriptAutoScrollFrameRef.current = requestAnimationFrame(() => {
      transcriptAutoScrollFrameRef.current = null;
      const transcript = transcriptRef.current;
      if (!transcript || !transcriptFollowRef.current.following) return;
      // Anchor the bottom gap instead of chasing a moving scrollHeight. Layout
      // can grow again between this frame and the scroll event; anchoring keeps
      // the same visible whitespace and prevents a content-driven scroll event
      // from being mistaken for the user scrolling upward.
      const anchor = transcript.scrollHeight - transcript.scrollTop;
      const nextScrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight - TRANSCRIPT_FOLLOW_GAP_PX);
      if (Math.abs(transcript.scrollTop - nextScrollTop) > 1) transcript.scrollTop = nextScrollTop;
      transcriptContentAnchorRef.current = anchor;
    });
  }
  useEffect(() => {
    if (!transcriptFollow.following) {
      if (transcriptAutoScrollFrameRef.current !== null) {
        cancelAnimationFrame(transcriptAutoScrollFrameRef.current);
        transcriptAutoScrollFrameRef.current = null;
      }
      return;
    }
    scheduleTranscriptFollow();
  }, [transcriptContentSignature, transcriptFollow.following]);
  useEffect(() => {
    return () => {
      if (transcriptAutoScrollFrameRef.current !== null) {
        cancelAnimationFrame(transcriptAutoScrollFrameRef.current);
        transcriptAutoScrollFrameRef.current = null;
      }
    };
  }, []);
  function handleTranscriptScroll() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const expectedAnchor = transcriptContentAnchorRef.current;
    if (transcriptFollowRef.current.following && expectedAnchor !== null) {
      // A resize or streamed item can increase scrollHeight before rAF runs.
      // Ignore that content displacement; the scheduled rAF will re-anchor to
      // the exact follow gap.
      if (transcript.scrollHeight - transcript.scrollTop > expectedAnchor + 1) return;
    }
    const distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    const nextFollow = nextTranscriptFollowState({
      following: transcriptFollowRef.current.following,
      distanceFromBottom,
      source: 'user',
    });
    transcriptFollowRef.current = nextFollow;
    setTranscriptFollow(nextFollow);
  }
  function handleReturnToBottom() {
    const nextFollow = nextTranscriptFollowState({
      following: false,
      distanceFromBottom: 0,
      source: 'return-action',
    });
    transcriptFollowRef.current = nextFollow;
    setTranscriptFollow(nextFollow);
    scheduleTranscriptFollow(true);
  }
  useEffect(() => { resizeTextareaToContent(composerInputRef.current); }, [activeSlashOption, images.length, input]);
  // 窄屏下窗口变宽时自动收起 sidebar 抽屉 — Chinese: auto-close sidebar drawer when resizing to wide
  useEffect(() => {
    function onResize() { if (window.innerWidth >= 768) setSidebarOpen(false); }
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  async function createConversation(workspaceRoot = config.workspaceRoot, conversationKind: 'chat' | 'project' = 'project', workflowProject = false) {
    setWorkflowPlanDraft(null);
    setBusy(true);
    setStatus(t(config.locale, 'creating'));
    try {
      const runConfig = { ...runtimeConfigPayload(globalConfigRef.current) };
      if (conversationKind === 'chat') {
        runConfig.hasWorkspace = false;
        runConfig.workspaceRoot = '';
      } else {
        runConfig.hasWorkspace = Boolean(workspaceRoot.trim());
      }
      const title = workflowProject ? (config.locale === 'zh' ? '未命名工作流项目' : 'Untitled workflow project') : t(config.locale, 'untitled');
      if (conversationKind === 'project') {
        setRememberedWorkspaceRoots((current) => rememberWorkspaceRoots(current, [workspaceRoot]));
      }
      const response = await fetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, config: runConfig, conversationKind, workflowProject }),
      });
      const data = (await response.json()) as { thread: ThreadMeta };
      await refreshThreads();
      await loadThread(data.thread.threadId);
      setStatus(t(config.locale, 'ready'));
    } finally {
      setBusy(false);
    }
  }
  async function createPlainConversation() { await createConversation('', 'chat'); }
  async function createWorkflowProject() { await createConversation(config.workspaceRoot, 'project', true); }
  async function createConversationWithWorkspacePicker() {
    if (busy) return;
    setStatus(workspacePickerStatus(config.locale));
    try {
      const workspaceRoot = await pickWorkspaceRoot(); if (!workspaceRoot) { setStatus(t(config.locale, 'ready')); return; }
      setRememberedWorkspaceRoots((current) => rememberWorkspaceRoots(current, [workspaceRoot]));
      await createConversation(workspaceRoot, 'project');
    } catch (error) {
      setDialog(workspacePickerNotice(config.locale, error)); setStatus(t(config.locale, 'ready'));
    }
  }
  async function forgetWorkspace(workspaceRoot: string) {
    const normalize = (value?: string | null) => (value ?? '').trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    const target = normalize(workspaceRoot);
    if (!target) return;
    const merged = new Map<string, ThreadMeta>();
    const addThread = (thread?: ThreadMeta | null, parentThreadId?: string) => {
      if (!thread?.threadId) return;
      const next = parentThreadId && !thread.parentThreadId ? { ...thread, parentThreadId } : thread;
      const current = merged.get(next.threadId);
      if (!current) {
        merged.set(next.threadId, next);
        return;
      }
      if (!current.parentThreadId && next.parentThreadId) {
        merged.set(next.threadId, { ...current, parentThreadId: next.parentThreadId });
      }
    };
    for (const thread of threads) addThread(thread);
    for (const child of threadChildren) addThread(child.thread);
    try {
      const response = await fetch('/api/threads');
      if (response.ok) {
        const data = await response.json() as { threads?: ThreadMeta[] };
        for (const thread of data.threads ?? []) addThread(thread);
      }
    } catch {
      // 列表接口失败时仍用本地已经加载的对话。
    }
    const known = threadsInWorkspace([...merged.values()], workspaceRoot);
    await Promise.all(known.map(async (thread) => {
      try {
        const response = await fetch(`/api/threads/${encodeURIComponent(thread.threadId)}/children?recursive=1`);
        if (!response.ok) return;
        const data = await response.json() as { children?: Array<{ thread?: ThreadMeta }> };
        for (const child of data.children ?? []) addThread(child.thread, thread.threadId);
      } catch {
        // 子线程接口失败时至少删除已经识别到的对话。
      }
    }));
    const affected = threadsInWorkspace([...merged.values()], workspaceRoot);
    const zh = config.locale === 'zh';
    const accepted = await requestDecisionDialog({
      title: zh ? '移除工作区' : 'Remove workspace',
      message: affected.length > 0
        ? (zh
          ? `将删除其中 ${affected.length} 个对话和本地记录，且不可撤销。`
          : `This deletes ${affected.length} chats and their local records. It cannot be undone.`)
        : (zh ? '此工作区没有对话，只会从列表中移除。' : 'This workspace has no chats. It will only be removed from the list.'),
      actionLabel: zh ? '移除' : 'Remove',
      cancelLabel: t(config.locale, 'cancel'),
      tone: 'danger',
    });
    if (!accepted) return;
    const previousThreads = threads;
    const previousThreadId = threadId;
    const previousWorkspaceRoot = config.workspaceRoot;
    const previousRemembered = rememberedWorkspaceRoots;
    const removedIds = new Set(affected.map((thread) => thread.threadId));
    const remaining = threads.filter((thread) => !removedIds.has(thread.threadId));
    setThreads(remaining);
    setRememberedWorkspaceRoots(forgetWorkspaceRoot(previousRemembered, workspaceRoot));
    const clearingCurrent = normalize(previousWorkspaceRoot) === target;
    if (clearingCurrent) {
      setConfig((current) => {
        globalConfigRef.current = { ...globalConfigRef.current, hasWorkspace: false, workspaceRoot: '' };
        return { ...current, hasWorkspace: false, workspaceRoot: '' };
      });
      try {
        await saveGlobalDefaults({ hasWorkspace: false, workspaceRoot: '' });
      } catch {
        // 后端不可达时本地仍会清空；refreshThreads 后全局 effect 不会再恢复旧根。
      }
    }
    if (removedIds.has(threadId)) {
      const nextThreadId = remaining[0]?.threadId ?? '';
      if (eventSourceRecoveryTimerRef.current !== null) {
        window.clearTimeout(eventSourceRecoveryTimerRef.current);
        eventSourceRecoveryTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setBusy(false);
      setStatus(t(config.locale, 'idle'));
      if (nextThreadId) {
        setThreadId(nextThreadId);
        setTurns([]);
        setItems([]);
        setThreadUsage(null);
        setEvents([]);
        void loadThread(nextThreadId);
      } else {
        setThreadId('');
        setTurns([]);
        setItems([]);
        setThreadUsage(null);
        setEvents([]);
      }
    }
    try {
      await Promise.all(affected.map(async (thread) => {
        const response = await fetch(`/api/threads/${encodeURIComponent(thread.threadId)}`, { method: 'DELETE' });
        if (response.status === 404) return;
        if (!response.ok) throw new Error(zh ? '删除失败' : 'Delete failed');
      }));
      await refreshThreads();
      await refreshBotStatus();
    } catch (error) {
      setThreads(previousThreads);
      setRememberedWorkspaceRoots(saveRememberedWorkspaceRoots(previousRemembered));
      if (clearingCurrent) {
        setConfig((current) => {
          globalConfigRef.current = { ...globalConfigRef.current, hasWorkspace: true, workspaceRoot: previousWorkspaceRoot };
          return { ...current, hasWorkspace: true, workspaceRoot: previousWorkspaceRoot };
        });
      }
      if (previousThreadId) await loadThread(previousThreadId);
      addEvent({
        kind: 'error',
        title: zh ? '移除工作区失败' : 'Remove workspace failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }
  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setImages((current) => [...current, { name: file.name || `paste-${Date.now()}.png`, dataUrl }]);
        };
        reader.readAsDataURL(file);
      }
    }
  }
  function addImageFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setImages((current) => [...current, { name: file.name, dataUrl }]);
      };
      reader.readAsDataURL(file);
    }
  }
  function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files) return;
    addImageFiles(files);
    event.target.value = '';
  }
  function handleDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    setDraggingImage(false);
    addImageFiles(event.dataTransfer.files);
  }
  function removeImage(index: number) {
    setImages((current) => current.filter((_, i) => i !== index));
  }
  function requestDecisionDialog(options: Omit<Extract<AppDialogState, { kind: 'decision' }>, 'kind' | 'resolve'>) {
    return new Promise<boolean>((resolve) => {
      setDialog({ ...options, kind: 'decision', resolve });
    });
  }
  function requestTextDialog(options: Omit<Extract<AppDialogState, { kind: 'text' }>, 'kind' | 'resolve'>) {
    return new Promise<string | null>((resolve) => {
      setDialog({ ...options, kind: 'text', resolve });
    });
  }
  async function selectExecutionMode(mode: ComposerExecutionMode): Promise<void> {
    setExecutionMode(mode);
    if (mode !== 'goal') return;

    // Goal 入口采用最高自治配置；Dynamic Workflow 的同一配置由思考档位单独控制。
    setConfig((current) => ({ ...current, ...HIGH_AUTONOMY_OVERRIDES }));
    const targetThreadId = threadIdRef.current;
    if (targetThreadId) {
      const persisted = await patchThreadConfigOverrides(targetThreadId, HIGH_AUTONOMY_OVERRIDES);
      if (threadIdRef.current === targetThreadId) {
        setConfig((current) => ({ ...current, ...persisted }));
      }
      return;
    }

    globalConfigRef.current = { ...globalConfigRef.current, ...HIGH_AUTONOMY_OVERRIDES };
    localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify(globalConfigRef.current));
  }

  async function selectThinkingMode(next: ComposerThinkingMode): Promise<void> {
    setThinkingMode(next);
    const overrides = next === 'workflow'
      ? HIGH_AUTONOMY_OVERRIDES
      : { reasoningEffort: next };
    setConfig((current) => ({ ...current, ...overrides }));
    const targetThreadId = threadIdRef.current;
    if (targetThreadId) {
      const persisted = await patchThreadConfigOverrides(targetThreadId, overrides);
      if (threadIdRef.current === targetThreadId) {
        setConfig((current) => ({ ...current, ...persisted }));
      }
      return;
    }
    globalConfigRef.current = { ...globalConfigRef.current, ...overrides };
    localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify(globalConfigRef.current));
  }

  function clearExecutionMode(): void {
    setExecutionMode('chat');
  }

  function reportExecutionModeError(error: unknown): void {
    addEvent({
      kind: 'error',
      title: config.locale === 'zh' ? '执行模式保存失败' : 'Execution mode save failed',
      detail: error instanceof Error ? error.message : String(error),
      tone: 'warning',
    });
  }

  function clearTaskComposerInput(): void {
    setInput('');
    setImages([]);
    setComposerFileReferences([]);
    setActiveSlashOption(null);
  }

  async function submitExecutionMode(mode: ComposerExecutionMode, rawObjective = input): Promise<void> {
    if (busy || actionBusy) return;
    const objective = rawObjective.trim();

    if (mode === 'chat') {
      await sendMessage(undefined, mergeComposerFileReferences(rawObjective, composerFileReferences));
      setComposerFileReferences([]);
      return;
    }

    if (mode === 'plan') {
      await sendMessage(modeInstructionFor('plan', config.locale), mergeComposerFileReferences(rawObjective, composerFileReferences));
      setComposerFileReferences([]);
      return;
    }

    if (!objective) return;
    setActionBusy(true);
    try {
       // Slash 有参入口也必须走同一配置与提交路径，避免绕开 Goal 的持久化约束。
       await selectExecutionMode(mode);
      const targetThreadId = threadIdRef.current;
      if (!targetThreadId) {
        throw new Error(mode === 'goal'
          ? (config.locale === 'zh' ? '请先打开一个会话，再创建 Goal。' : 'Open a thread before creating a Goal.')
          : (config.locale === 'zh' ? '请先打开一个会话，再创建 Dynamic Workflow。' : 'Open a thread before creating a Dynamic Workflow.'));
      }

      const task = await createTask({
        threadId: targetThreadId,
        objective,
        acceptanceCriteria: [],
        entryMode: mode,
      });

      const started = await startTask(task.id);
      addEvent({
        kind: 'config',
        title: config.locale === 'zh' ? 'Goal 已启动' : 'Goal started',
        detail: objective,
        tone: 'success',
      });
      void started;

      clearTaskComposerInput();
      setTaskCenterOpen(true);
    } catch (error) {
      addEvent({
        kind: 'error',
        title: mode === 'goal'
          ? (config.locale === 'zh' ? 'Goal 创建失败' : 'Goal creation failed')
          : (config.locale === 'zh' ? 'Dynamic Workflow 创建失败' : 'Dynamic Workflow creation failed'),
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setActionBusy(false);
    }
  }

  async function submitDynamicWorkflow(rawObjective = input): Promise<void> {
    if (busy || actionBusy) return;
    const objective = mergeComposerFileReferences(rawObjective, composerFileReferences);
    if (!objective.trim()) return;
    setActionBusy(true);
    try {
      const targetThreadId = threadIdRef.current;
      if (!targetThreadId) throw new Error('请先打开一个会话，再创建 Dynamic Workflow。');
      const task = await createTask({
        threadId: targetThreadId,
        objective: objective.trim(),
        acceptanceCriteria: [],
        entryMode: executionMode === 'goal' ? 'goal' : 'workflow',
      });
      let goalRunId: string | undefined;
      if (executionMode === 'goal') {
        const started = await startTask(task.id);
        goalRunId = started.run?.id;
        if (!goalRunId) throw new Error('Goal 启动响应缺少 Goal Run');
      }
      // Dynamic Workflow 只生成待审阅脚本；批准和执行必须由任务中心完成。
      await proposeWorkflowRun(task.id, {
        objective: objective.trim(),
        proposedScript: createInitialWorkflowScript(objective),
        ...(goalRunId ? { goalRunId } : {}),
      });
      addEvent({
        kind: 'config',
        title: executionMode === 'goal'
          ? (config.locale === 'zh' ? 'Goal × Dynamic Workflow 等待审阅' : 'Goal × Dynamic Workflow awaiting review')
          : (config.locale === 'zh' ? 'Dynamic Workflow 等待审阅' : 'Dynamic Workflow awaiting review'),
        detail: objective.trim(),
        tone: 'success',
      });
      clearTaskComposerInput();
      setTaskCenterOpen(true);
    } catch (error) {
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? 'Dynamic Workflow 创建失败' : 'Dynamic Workflow creation failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setActionBusy(false);
    }
  }

  async function runSlashCommand(command: SlashCommand) {
    switch (command.kind) {
      case 'skills.list':
        setInput('/skills ');
        window.requestAnimationFrame(() => composerInputRef.current?.focus());
        return;
      case 'skills.add':
        {
          const installTargets = extractGitHubSkillInstallUrls(command.args);
          if (installTargets.length > 0) {
            await installSkillsFromGitHub(installTargets, command.args);
          } else {
            await createSkillDraft(command.args);
          }
        }
        return;
      case 'mcp.list':
        setInput('/mcp ');
        window.requestAnimationFrame(() => composerInputRef.current?.focus());
        return;
      case 'mcp.add':
        setInput('');
        setActionBusy(true);
        try {
          const { draft, sourceError } = await resolveMcpDraftFromInput(command.args);
          setPendingMcpDraft(draft);
          setSettingsOpen(true);
          if (sourceError) addEvent({ kind: 'config', title: config.locale === 'zh' ? 'MCP 来源读取失败' : 'MCP source read failed', detail: sourceError, tone: 'warning' });
        } finally {
          setActionBusy(false);
        }
        return;
      case 'web_search.mode':
        setWebSearchMode(command.mode);
        setInput('');
        return;
      case 'compact':
        setInput('');
        if (threadId && !busy && !actionBusy) await threadAction('compact');
        return;
      case 'goal':
        if (!command.args.trim()) {
          try {
            await selectExecutionMode('goal');
          } catch (error) {
            reportExecutionModeError(error);
          }
          setInput('');
          window.requestAnimationFrame(() => composerInputRef.current?.focus());
          return;
        }
        await submitExecutionMode('goal', command.args);
        return;
      case 'workflow':
        try {
          await selectThinkingMode('workflow');
        } catch (error) {
          reportExecutionModeError(error);
        }
        if (!command.args.trim()) {
          setInput('');
          window.requestAnimationFrame(() => composerInputRef.current?.focus());
          return;
        }
        await submitDynamicWorkflow(command.args);
        return;
      case 'task.mode':
        if (!command.args.trim()) {
          if (command.mode === 'plan') {
            try {
              await selectExecutionMode('plan');
            } catch (error) {
              reportExecutionModeError(error);
            }
          }
          setInput(`/${command.mode} `);
          window.requestAnimationFrame(() => composerInputRef.current?.focus());
          return;
        }
        if (command.mode === 'plan') {
          try {
            await selectExecutionMode('plan');
          } catch (error) {
            reportExecutionModeError(error);
          }
          await submitExecutionMode('plan', command.args);
          return;
        }
        await sendMessage(modeInstructionFor(command.mode, config.locale), command.args);
        return;
      case 'none':
        return;
    }
  }
  function selectSlashOption(option: PaletteOption) {
    if (option.action === 'insert_skill') {
      setActiveSlashOption(null);
      setInput(`$${option.skillName} `);
      window.requestAnimationFrame(() => {
        composerInputRef.current?.focus();
        composerInputRef.current?.setSelectionRange(option.skillName.length + 2, option.skillName.length + 2);
      });
      return;
    }
    if (option.action === 'enable_mcp') {
      const selected = mcps.find((mcp) => mcp.id === option.mcpId);
      setMcps((current) => current.map((mcp) => (
        mcp.id === option.mcpId ? { ...mcp, enabled: true } : mcp
      )));
      setActiveSlashOption(null);
      setInput('');
      addEvent({
        kind: 'config',
        title: config.locale === 'zh' ? 'MCP 已启用' : 'MCP enabled',
        detail: selected?.name ?? option.title,
        tone: 'success',
      });
      return;
    }
    if (option.command === '/goal ' || option.command === '/workflow ') {
      setActiveSlashOption(null);
      setInput('');
      void runSlashCommand(parseSlashCommand(option.command));
      return;
    }
    if (option.command.endsWith(' ')) {
      setActiveSlashOption(option);
      setInput('');
      window.requestAnimationFrame(() => composerInputRef.current?.focus());
      return;
    }
    setInput('');
    void runSlashCommand(parseSlashCommand(option.command));
  }
  async function submitComposer() {
    if (isWorkflowProject) {
      const goal = input.trim();
      if (!goal) return;
      setInput('');
      setActiveSlashOption(null);
      setStatus(config.locale === 'zh' ? '正在更新工作流' : 'Updating workflow');
      await requestWorkflowPlan(goal);
      setStatus(t(config.locale, 'idle'));
      return;
    }
    if (activeSlashOption) {
      if (!input.trim()) return;
      const command = parseSlashCommand(activeSlashOption.command + input);
      setActiveSlashOption(null);
      await runSlashCommand(command);
      return;
    }
    if (slashVisible && images.length === 0 && composerFileReferences.length === 0) {
      if (filteredSlashOptions.length > 0) {
        const exactOption = filteredSlashOptions.find((option) => option.command.trim() === input.trim());
        selectSlashOption(exactOption ?? filteredSlashOptions[0]);
        return;
      }
      const command = parseSlashCommand(input);
      if (command.kind !== 'none') {
        await runSlashCommand(command);
        return;
      }
    }
    if (thinkingMode === 'workflow') {
      await submitDynamicWorkflow();
      return;
    }
    if (executionMode !== 'chat') {
      await submitExecutionMode(executionMode);
      return;
    }
    await submitExecutionMode('chat');
  }
  function setWebSearchMode(mode: WebSearchMode) {
    setConfig((current) => ({ ...current, webSearchMode: mode }));
    addEvent({
      kind: 'config',
      title: config.locale === 'zh' ? '联网搜索模式' : 'Web search mode',
      detail: mode,
      tone: 'success',
    });
  }
  async function createSkillDraft(description: string) {
    const text = description.trim();
    if (!text) {
      return;
    }
    setInput('');
    const localDraft = createLocalSkillDraftItems(text, config.locale);
    setItems((current) => mergeIncomingItems(current, localDraft.items));
    setBusy(true);
    setStatus(config.locale === 'zh' ? '生成 Skill 草稿' : 'Drafting skill');
    try {
      const response = await fetch('/api/skills/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: text, config: threadApiConfig }),
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? 'Skill draft failed');
      }
      const data = (await response.json()) as { draft?: SkillDraft; source?: SkillDraft['source']; error?: string };
      if (!data.draft) throw new Error('Skill draft missing');
      setSkillDraft({ ...data.draft, source: data.source, error: data.error });
      setItems((current) => completeLocalSkillDraftItem(
        current,
        localDraft.statusItemId,
        'completed',
        config.locale === 'zh' ? `已生成 Skill 草稿：${data.draft?.name ?? text}` : `Skill draft ready: ${data.draft?.name ?? text}`,
      ));
      setStatus(t(config.locale, 'idle'));
    } catch (error) {
      const readableError = formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), config.locale);
      setStatus(readableError);
      setItems((current) => completeLocalSkillDraftItem(
        current,
        localDraft.statusItemId,
        'failed',
        readableError,
      ));
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? 'Skill 草稿失败' : 'Skill draft failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }
  async function installSkillsFromGitHub(skillUrls: string[], args: string) {
    const installTargets = skillUrls.map((url) => url.trim()).filter(Boolean);
    const text = args.trim();
    const inputText = `/skills add ${text}`.trim();
    if (!text) return;
    let activeThreadId = threadId;
    const localDraft = createLocalSkillDraftItems(text, config.locale, undefined, 'install');
    setInput('');
    setActiveSlashOption(null);
    setBusy(true);
    setStatus(config.locale === 'zh' ? '安装 Skill' : 'Installing skill');
    try {
      if (!activeThreadId) {
        const threadResponse = await fetch('/api/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: inputText.slice(0, 60), config: threadApiConfig }),
        });
        if (!threadResponse.ok) {
          const error = (await threadResponse.json()) as { error?: string };
          throw new Error(error.error ?? 'Create thread failed');
        }
        const threadData = (await threadResponse.json()) as { thread: ThreadMeta };
        activeThreadId = threadData.thread.threadId;
        await refreshThreads();
        await loadThread(activeThreadId);
      }
      setItems((current) => mergeIncomingItems(current, localDraft.items));
      const response = await fetch(`/api/threads/${activeThreadId}/skills/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: inputText, urls: installTargets, config: threadApiConfig }),
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? 'Skill install failed');
      }
      const data = (await response.json()) as {
        items?: ThreadItem[];
        installed?: Array<{ name: string; path: string; sourcePath: string }>;
        skillsRoot?: string;
      };
      const installed = data.installed ?? [];
      const detail = installed.length > 0
        ? installed.map((skill) => skill.name).join(', ')
        : text;
      setItems((current) => mergeIncomingItems(removeLocalThreadItems(current, localDraft.items), data.items ?? []));
      await refreshSkills();
      await refreshThreads();
      addEvent({
        kind: 'config',
        title: config.locale === 'zh' ? 'Skill 已安装' : 'Skill installed',
        detail,
        tone: 'success',
      });
      setStatus(t(config.locale, 'idle'));
    } catch (error) {
      const readableError = formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), config.locale);
      setStatus(readableError);
      if (activeThreadId) {
        await loadThread(activeThreadId);
      }
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? 'Skill 安装失败' : 'Skill install failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }
  async function saveSkillDraft(draft: SkillDraft) {
    const response = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error ?? 'Save skill failed');
    }
    setSkillDraft(null);
    addEvent({
      kind: 'config',
      title: config.locale === 'zh' ? 'Skill 已保存' : 'Skill saved',
      detail: draft.name,
      tone: 'success',
    });
    await refreshSkills({ forceReload: true });
  }
  async function deleteSkill(name: string) {
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error ?? 'Delete skill failed');
    }
    await refreshSkills({ forceReload: true });
    addEvent({
      kind: 'config',
      title: config.locale === 'zh' ? 'Skill 已删除' : 'Skill removed',
      detail: name,
      tone: 'success',
    });
  }
  function stopTurnWatch(epoch: number): void {
    const watch = turnWatchRef.current;
    if (!watch || watch.epoch !== epoch) return;
    if (watch.timer !== null) window.clearInterval(watch.timer);
    turnWatchRef.current = null;
  }

  async function sendMessage(
    modeInstruction?: string,
    forcedText?: string,
    options: { imagesOverride?: ComposerImage[]; clearComposerImages?: boolean; configOverride?: Partial<RunConfig> } = {},
  ) {
    const text = (forcedText ?? input).trim();
    const outgoingImages = options.imagesOverride ?? images;
    const hasImages = outgoingImages.length > 0;
    if (!text && !hasImages) return;
    const sendReq = sendMessageGuardRef.current.begin();
    const isSendCurrent = () => sendMessageGuardRef.current.isCurrent(sendReq.generation);
    let activeThreadId = threadId;
    const requestConfig = options.configOverride
      ?? (activeThreadId ? threadApiConfig : runtimeConfigPayload(globalConfigRef.current));
    if (!activeThreadId) {
      const response = await fetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: (text || 'Image').slice(0, 60),
          config: { ...requestConfig, workspaceRoot: '' },
          conversationKind: 'chat',
        }),
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? 'Create thread failed');
      }
      const data = (await response.json()) as { thread: ThreadMeta };
      if (!data.thread?.threadId) throw new Error('Create thread failed');
      activeThreadId = data.thread.threadId;
      if (!isSendCurrent()) return;
      activeTurnThreadIdRef.current = activeThreadId;
      await loadThread(activeThreadId);
      if (!isSendCurrent()) return;
      await refreshThreads();
      if (!isSendCurrent()) return;
    }
    setBusy(true);
    activeTurnThreadIdRef.current = activeThreadId;
    activeTurnIdRef.current = '';
    setPreparingTurn({ threadId: activeThreadId });
    const turnWatchEpoch = turnWatchEpochRef.current + 1;
    turnWatchEpochRef.current = turnWatchEpoch;
    const turnWatch = {
      epoch: turnWatchEpoch,
      timer: null as number | null,
      threadId: activeThreadId,
      knownTurnIds: new Set(turns.map((turn) => turn.turnId)),
    };
    const isTurnWatchCurrent = () => threadIdRef.current === activeThreadId
      && turnWatchEpochRef.current === turnWatchEpoch;
    turnWatch.timer = window.setInterval(() => {
      void reloadThreadSnapshot(activeThreadId, {
        isCurrent: isTurnWatchCurrent,
        reconcileBusy: true,
        requestEpoch: turnWatchEpoch,
      }).catch(() => {});
    }, 2500);
    turnWatchRef.current = turnWatch;
    setInput('');
    const sentImages = [...outgoingImages];
    if (options.clearComposerImages ?? !options.imagesOverride) setImages([]);
    setStatus(t(config.locale, 'running'));
    const pendingUserItem: ThreadItem = {
      id: `pending_user_${Date.now()}`,
      type: 'user_message',
      text: text || (config.locale === 'zh' ? '见附件图片。' : 'See attached image(s).'),
      status: 'in_progress',
      timestamp: new Date().toISOString(),
    };
    if (!isSendCurrent()) {
      setBusy(false);
      activeTurnThreadIdRef.current = '';
      return;
    }
    setItems((current) => mergeIncomingItems(current, [pendingUserItem]));
    let failureItems: ThreadItem[] = [];
    const requestedModelConfig = {
      provider: requestConfig.provider ?? config.provider,
      model: requestConfig.model ?? config.model,
      baseUrl: requestConfig.baseUrl ?? config.baseUrl,
      modelContextTokens: requestConfig.modelContextTokens,
      modelMaxOutputTokens: requestConfig.modelMaxOutputTokens,
    };
    try {
      const body: Record<string, unknown> = { input: text || 'See attached image(s).', config: requestConfig };
      if (modeInstruction) body.modeInstruction = modeInstruction;
      if (sentImages.length > 0) {
        body.images = sentImages.map((img) => ({ name: img.name, dataUrl: img.dataUrl }));
      }
      const response = await fetch(`/api/threads/${activeThreadId}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: sendReq.signal,
      });
      if (!isSendCurrent()) return;
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown; items?: unknown } | null;
        if (Array.isArray(payload?.items)) failureItems = payload.items as ThreadItem[];
        throw new Error(parseApiErrorMessage(payload, 'Turn failed', config.locale));
      }
      const data = (await response.json()) as { items: ThreadItem[] };
      if (!isSendCurrent()) return;
      setItems((current) => mergeIncomingItems(current, data.items ?? []));
      if ((data.items ?? []).some((item) => item.type !== 'user_message')) clearPreparingTurn(activeThreadId);
      setRunningTurnIds(new Set());
      await refreshThreads();
      if (!isSendCurrent()) return;
      setStatus(t(config.locale, 'idle'));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (!isSendCurrent()) return;
      clearPreparingTurn(activeThreadId);
      // Keep the long gateway diagnostic in the persisted error item; the
      // top bar is a compact lifecycle status and must never become the title.
      setStatus(config.locale === 'zh' ? '回复失败' : 'Turn failed');
      if (activeThreadId) {
        if (failureItems.length > 0) {
          setItems((current) => mergeIncomingItems(current, failureItems));
        } else {
          // `loadThread` rehydrates the terminal error item written by the
          // runtime. Do not append an unscoped synthetic item here: it would
          // render as a second assistant group beside the persisted error.
          await loadThread(activeThreadId);
          // A failed-turn snapshot can lag behind the just-applied model
          // selection. Preserve the request model instead of reverting it.
          if (isSendCurrent()) {
            setConfig((current) => ({ ...current, ...requestedModelConfig }));
            globalConfigRef.current = { ...globalConfigRef.current, ...requestedModelConfig };
          }
        }
      }
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? '发送失败' : 'Send failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      if (isSendCurrent()) {
        stopTurnWatch(turnWatchEpoch);
        setBusy(false);
        activeTurnIdRef.current = '';
        activeTurnThreadIdRef.current = '';
      }
    }
  }
  async function stopTurn() {
    const targetThreadId = activeTurnThreadIdRef.current || threadId;
    if (!targetThreadId) return;
    const activeWatch = turnWatchRef.current;
    if (activeWatch) stopTurnWatch(activeWatch.epoch);
    turnWatchEpochRef.current += 1;
    setBusy(false);
    clearPreparingTurn(targetThreadId);
    setRunningTurnIds(new Set());
    activeTurnIdRef.current = '';
    setStatus(config.locale === 'zh' ? '已停止' : 'Interrupted');
    showToast(config.locale === 'zh' ? '已请求停止当前回复' : 'Stop requested');
    try {
      const response = await fetch(`/api/threads/${targetThreadId}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: threadApiConfig }),
      });
      const data = (await response.json()) as { interrupted?: boolean };
      if (!response.ok || !data.interrupted) {
        await reloadThreadSnapshot(targetThreadId);
      }
    } catch {
      await reloadThreadSnapshot(targetThreadId);
    } finally {
      setBusy(false);
      setRunningTurnIds(new Set());
      activeTurnThreadIdRef.current = '';
      addEvent({
        kind: 'interrupt',
        title: config.locale === 'zh' ? '已停止' : 'Interrupted',
        detail: config.locale === 'zh' ? '当前回复已请求中断。' : 'The current turn was interrupted.',
        tone: 'warning',
      });
    }
  }
  async function decideApproval(
    requestId: string,
    approved: boolean,
    temporaryScope: TemporaryAccessScope = 'tool_call',
    persistentScope?: PersistentAccessScope,
  ) {
    try {
      const response = await fetch(`/api/approvals/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved,
          reason: approved ? 'approved from web' : 'denied from web',
          temporaryScope,
          persistentScope,
        }),
      });
      if (response.ok) {
        setPendingApprovals((current) => current.filter((item) => item.requestId !== requestId));
        return;
      }
      await refreshApprovals();
      addEvent({
        kind: 'approval',
        title: config.locale === 'zh' ? '授权已失效' : 'Approval expired',
        detail: config.locale === 'zh' ? '该请求已结束，请重新发起操作。' : 'This request has ended. Run the operation again.',
        tone: 'warning',
      });
    } catch {
      await refreshApprovals();
      addEvent({
        kind: 'approval',
        title: config.locale === 'zh' ? '授权提交失败' : 'Approval failed',
        detail: config.locale === 'zh' ? '无法提交授权决定。' : 'The approval decision could not be submitted.',
        tone: 'danger',
      });
    }
  }
  async function threadAction(action: 'compact' | 'fork' | 'rollback', count = 1) {
    if (!threadId || busy || actionBusy) return;
    setActionBusy(true);
    try {
      const response = await fetch(`/api/threads/${threadId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: threadApiConfig, count }),
      });
      const data = await response.json();
      addEvent({
        kind: action,
        title: actionTitle(action, config.locale),
        detail: actionDetail(action, data, config.locale),
        tone: response.ok ? 'success' : 'danger',
      });
      if (action === 'fork' && data.thread?.threadId) {
        await refreshThreads();
        await loadThread(data.thread.threadId);
      } else {
        await loadThread(threadId);
      }
    } finally {
      setActionBusy(false);
    }
  }
  function rollbackToTurn(turnId: string) {
    if (turnId !== latestRollbackTurnId) return;
    const count = rollbackCountForTurn(turnId, turns, items);
    const userText = items.find((item) => item.type === 'user_message' && item.turnId === turnId)?.text;
    if (userText) {
      setInput(userText);
      window.requestAnimationFrame(() => {
        composerInputRef.current?.focus();
        resizeTextareaToContent(composerInputRef.current);
      });
    }
    void threadAction('rollback', count);
  }
  async function regenerateFromTurn(turnId: string) {
    if (!threadId || busy || actionBusy || turnId !== latestRollbackTurnId) return;
    const userText = items.find((item) => item.type === 'user_message' && item.turnId === turnId)?.text?.trim();
    if (!userText) return;
    const count = rollbackCountForTurn(turnId, turns, items);
    const regenerateConfig = { ...threadApiConfig };
    setActionBusy(true);
    try {
      const response = await fetch(`/api/threads/${threadId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: threadApiConfig, count }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? 'Rollback failed');
      addEvent({
        kind: 'rollback',
        title: config.locale === 'zh' ? '正在重新回答' : 'Regenerating response',
        detail: config.locale === 'zh' ? '已回退最近一轮，正在重新发送。' : 'Rolled back the latest turn and is sending it again.',
        tone: 'success',
      });
      await loadThread(threadId);
      setActionBusy(false);
      await sendMessage(undefined, userText, { imagesOverride: [], clearComposerImages: false, configOverride: regenerateConfig });
    } catch (error) {
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? '重新回答失败' : 'Regenerate failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setActionBusy(false);
    }
  }
  async function branchFromTurn(turnId: string) {
    if (!threadId) return;
    const index = turns.findIndex((turn) => turn.turnId === turnId);
    const trailingTurns = index >= 0 ? Math.max(0, turns.length - index - 1) : 0;
    setBusy(true);
    try {
      const forkResponse = await fetch(`/api/threads/${threadId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: threadApiConfig }),
      });
      const forkData = await forkResponse.json() as { thread?: ThreadMeta };
      const nextThreadId = forkData.thread?.threadId;
      if (!forkResponse.ok || !nextThreadId) throw new Error('Fork failed');
      if (trailingTurns > 0) {
        await fetch(`/api/threads/${nextThreadId}/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: trailingTurns }),
        });
      }
      await refreshThreads();
      await loadThread(nextThreadId);
      addEvent({
        kind: 'fork',
        title: actionTitle('fork', config.locale),
        detail: config.locale === 'zh' ? '已从这条回复创建分支对话。' : 'A branch was created from this reply.',
        tone: 'success',
      });
    } catch (error) {
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? '分支失败' : 'Branch failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }
  async function copyMessage(text: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(config.locale === 'zh' ? '已复制到剪贴板' : 'Copied to clipboard');
      addEvent({
        kind: 'copy',
        title: config.locale === 'zh' ? '已复制' : 'Copied',
        detail: config.locale === 'zh' ? '消息内容已复制到剪贴板。' : 'Message copied to clipboard.',
        tone: 'success',
      });
    } catch (error) {
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? '复制失败' : 'Copy failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }
  // 中文注释：点击工具条目"预览"按钮 → 切换右侧栏到文件标签并驱动预览
  // — Chinese: clicking "preview" on a tool item switches the right panel to Files tab and drives preview
  function previewFileFromItem(path: string) {
    if (!path) return;
    if (!revealRightPaneForThread('files')) return;
    setPreviewRequest({ path, pin: true, nonce: Date.now() });
  }
  function addWorkspaceFileToComposer(path: string) {
    const normalized = path.trim();
    if (!normalized) return;
    setComposerFileReferences((current) => current.includes(normalized) ? current : [...current, normalized]);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  }
  async function deleteConversation(id: string) {
    if (!id) return;
    const accepted = await requestDecisionDialog({
      title: t(config.locale, 'deleteConversation'),
      message: config.locale === 'zh' ? '此操作会删除这个对话和本地记录。' : 'This will delete the chat and its local records.',
      actionLabel: t(config.locale, 'remove'),
      cancelLabel: t(config.locale, 'cancel'),
      tone: 'danger',
    });
    if (!accepted) return;
    const previousThreads = threads;
    const previousThreadId = threadId;
    const nextState = optimisticDeleteThread(threads, id, threadId);
    setThreads(nextState.threads);
    if (id === threadId) {
      if (eventSourceRecoveryTimerRef.current !== null) {
        window.clearTimeout(eventSourceRecoveryTimerRef.current);
        eventSourceRecoveryTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setBusy(false);
      setStatus(t(config.locale, 'idle'));
      if (nextState.nextThreadId) {
        setThreadId(nextState.nextThreadId);
        setTurns([]);
        setItems([]);
        setThreadUsage(null);
        setEvents([]);
        void loadThread(nextState.nextThreadId);
      } else {
        setThreadId('');
        setTurns([]);
        setItems([]);
        setThreadUsage(null);
        setEvents([]);
      }
    }
    try {
      const response = await fetch(`/api/threads/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Delete failed');
      await refreshThreads();
      await refreshBotStatus();
    } catch (error) {
      setThreads(previousThreads);
      if (previousThreadId) {
        await loadThread(previousThreadId);
      }
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? '删除失败' : 'Delete failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }
  async function renameConversation(id: string, title: string) {
    const response = await fetch(`/api/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    const data = (await response.json().catch(() => ({}))) as { thread?: ThreadMeta; error?: string };
    if (!response.ok || !data.thread) throw new Error(data.error ?? 'Rename failed');
    setThreads((current) => current.map((thread) => thread.threadId === id ? data.thread! : thread));
  }
  async function toggleThreadMemoryExcluded(excluded: boolean) {
    if (!threadId) return;
    const response = await fetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: { memoryExcluded: excluded ? 'true' : 'false' } }),
    });
    const data = (await response.json().catch(() => ({}))) as { thread?: ThreadMeta; error?: string };
    if (!response.ok || !data.thread) {
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? '记忆设置失败' : 'Memory setting failed',
        detail: data.error ?? 'Unable to update thread memory setting',
        tone: 'danger',
      });
      return;
    }
    setThreads((current) => current.map((thread) => thread.threadId === threadId ? data.thread! : thread));
  }
  async function requestModelPresetName(defaultName: string): Promise<string | null> {
    const name = await requestTextDialog({
      title: t(config.locale, 'saveModelPreset'),
      value: defaultName,
      actionLabel: t(config.locale, 'save'),
      cancelLabel: t(config.locale, 'cancel'),
    });
    if (name === null) return null;
    return name.trim() || defaultName;
  }
  async function saveModelPreset(name: string, presetConfig: ModelPresetConfig, presetId?: string): Promise<ModelPreset> {
    const response = await fetch('/api/model-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(presetId ? { id: presetId } : {}), name, config: presetConfig }),
    });
    if (!response.ok) throw new Error('Model preset save failed');
    const data = (await response.json()) as { preset?: ModelPreset; presets?: ModelPreset[] };
    if (!data.preset?.id) throw new Error('Model preset save response missing preset id');
    setModelPresets(data.presets ?? []);
    return data.preset;
  }
  async function recoverDeletedModel(providerId: string, model: string | null, remaining: ModelPreset[]): Promise<void> {
    const matches = (value: RunConfig) => value.provider === providerId && (model === null || value.model === model);
    const currentAffected = matches(config);
    const globalAffected = matches(globalConfigRef.current);
    if (!currentAffected && !globalAffected) return;
    const fallback = remaining[0]?.config ?? defaultConfig;
    const patch: ThreadConfigOverrides = {
      provider: fallback.provider,
      model: fallback.model,
      baseUrl: fallback.baseUrl,
      modelContextTokens: fallback.modelContextTokens,
      modelMaxOutputTokens: fallback.modelMaxOutputTokens,
    };
    if (globalAffected) {
      await saveGlobalDefaults(patch);
      const nextGlobal = { ...globalConfigRef.current, ...patch };
      globalConfigRef.current = nextGlobal;
      localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify(nextGlobal));
    }
    if (currentAffected) {
      setConfig((current) => ({ ...current, ...patch }));
      await saveThreadModelOverrides(patch);
    }
  }
  async function deleteModelPreset(presetId: string): Promise<void> {
    const response = await fetch(`/api/model-presets/${encodeURIComponent(presetId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Model preset delete failed');
    const data = (await response.json()) as { presets?: ModelPreset[]; providers?: ProviderEntry[] };
    setModelPresets(data.presets ?? []);
    if (data.providers) setProviders(data.providers);
    const removed = modelPresets.find((preset) => preset.id === presetId);
    if (removed) await recoverDeletedModel(removed.config.provider, removed.config.model, data.presets ?? []);
  }
  async function deleteCustomProvider(providerId: string): Promise<void> {
    const response = await fetch(`/api/providers/` + encodeURIComponent(providerId), { method: 'DELETE' });
    if (!response.ok) throw new Error('Provider delete failed');
    const data = (await response.json()) as { providers?: ProviderEntry[]; presets?: ModelPreset[] };
    setProviders(data.providers ?? []);
    setModelPresets(data.presets ?? []);
    await recoverDeletedModel(providerId, null, data.presets ?? []);
  }
  function applyModelPreset(preset: ModelPreset) {
    const selection = ++modelSelectionRef.current;
    const targetThreadId = threadIdRef.current;
    const patch: ThreadConfigOverrides = {
      provider: preset.config.provider,
      model: preset.config.model,
      baseUrl: preset.config.baseUrl,
      modelContextTokens: preset.config.modelContextTokens,
      modelMaxOutputTokens: preset.config.modelMaxOutputTokens,
    };
    currentModelConfigRef.current = { ...currentModelConfigRef.current, ...patch };
    setConfig((current) => ({ ...current, ...patch }));
    if (patch.modelContextTokens !== undefined) {
      void saveThreadModelOverrides(patch);
      return;
    }
    // 无显式长度的旧预设：先尝试服务端，再从独立参考列表复制一次。
    void contextTokensForSelectedModel(preset.config).then((contextTokens) => {
      const latest = currentModelConfigRef.current;
      if (selection !== modelSelectionRef.current || threadIdRef.current !== targetThreadId
        || latest.provider !== patch.provider || latest.model !== patch.model || latest.baseUrl !== patch.baseUrl
        || latest.modelContextTokens !== undefined) return;
      const assigned = { ...patch, modelContextTokens: contextTokens };
      currentModelConfigRef.current = { ...latest, ...assigned };
      setConfig((current) => current.provider === patch.provider && current.model === patch.model && current.baseUrl === patch.baseUrl
        ? { ...current, ...assigned } : current);
      void saveThreadModelOverrides(assigned);
    });
  }
  async function saveProviderKey(providerId: string, apiKey: string) {
    const response = await fetch(`/api/keys/${providerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (response.ok) {
      const data = (await response.json()) as { keys?: ApiKeyState[] };
      setKeyStates(data.keys ?? []);
    }
  }
  async function clearProviderKey(providerId: string) {
    const response = await fetch(`/api/keys/${providerId}`, { method: 'DELETE' });
    if (response.ok) {
      const data = (await response.json()) as { keys?: ApiKeyState[] };
      setKeyStates(data.keys ?? []);
    }
  }
  async function saveProviderEnvVar(providerId: string, envVar: string) {
    const response = await fetch(`/api/keys/${encodeURIComponent(providerId)}/env-var`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envVar }) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const reason = parseProviderEnvVarSaveFailure(detail);
      throw new Error(reason ? `Provider env var save failed: ${reason}` : 'Provider env var save failed');
    }
    if (response.ok) {
      const data = (await response.json()) as { keys?: ApiKeyState[] };
      setKeyStates(data.keys ?? []);
    }
  }
  async function saveThreadModelOverrides(overrides: ThreadConfigOverrides): Promise<void> {
    const targetThreadId = threadIdRef.current;
    if (!targetThreadId) return;
    try {
      const persisted = await patchThreadConfigOverrides(targetThreadId, overrides);
      if (threadIdRef.current !== targetThreadId) return;
      setConfig((current) => ({ ...current, ...persisted }));
    } catch (error) {
      addEvent({
        kind: 'error',
        title: config.locale === 'zh' ? '对话配置保存失败' : 'Thread setting save failed',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'warning',
      });
    }
  }
  function saveGlobalModelConfig(nextConfig: RunConfig): void {
    const currentGlobal = globalConfigRef.current;
    const nextGlobal: RunConfig = {
      ...currentGlobal,
      provider: nextConfig.provider,
      model: nextConfig.model,
      baseUrl: nextConfig.baseUrl,
      modelContextTokens: nextConfig.modelContextTokens,
      modelMaxOutputTokens: nextConfig.modelMaxOutputTokens,
    };
    globalConfigRef.current = nextGlobal;
    localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify(nextGlobal));
    setConfig(nextGlobal);
  }
  const shortcutThemeMode = resolveThemeShortcutMode(config.themeMode);
  const themeShortcutLabel = shortcutThemeMode === 'dark'
    ? (config.locale === 'zh' ? '深色' : 'Dark')
    : (config.locale === 'zh' ? '浅色' : 'Light');
  const themeShortcutTitle = config.locale === 'zh'
    ? `主题：${themeShortcutLabel}，点击切换`
    : `Theme: ${themeShortcutLabel}. Click to switch`;
  const themeShortcutIcon = shortcutThemeMode === 'dark' ? 'moon' : 'sun';
  return (
    <main className={[
      'appShell',
      `theme-${config.themeMode}`,
      sidebarCollapsed ? 'sidebarCollapsed' : '',
    ].filter(Boolean).join(' ')}
    style={{
      gridTemplateColumns: sidebarCollapsed
        ? '58px minmax(0, 1fr)'
        : '278px minmax(0, 1fr)',
    }}>
      {/* 窄屏 sidebar scrim 遮罩 — Chinese: narrow sidebar scrim */}
      <button type="button" className={`sidebarScrim${sidebarOpen ? ' mobileOpen' : ''}`} aria-label={config.locale === 'zh' ? '关闭侧栏' : 'Close sidebar'} onClick={() => setSidebarOpen(false)} />
      <aside className={[sidebarCollapsed ? 'conversationPane collapsed' : 'conversationPane', sidebarOpen ? 'mobileOpen' : ''].filter(Boolean).join(' ')}>
        <WorkspaceThreadList
          activeThreadId={threadId} busy={busy} currentWorkspaceRoot={config.workspaceRoot} locale={config.locale}
          rememberedRoots={rememberedWorkspaceRoots} runningTurnIds={runningTurnIds} searchQuery={threadFilter}
          sidebarCollapsed={sidebarCollapsed} threads={threads} unreadThreadIds={unreadThreadIds}
          weixinActiveThreadId={botConfig?.weixin.activeThreadId ?? ''} dingtalkActiveThreadId={botConfig?.dingtalk.activeThreadId ?? ''}
          onCreatePlainChat={() => void createPlainConversation()}
          onCreateInWorkspace={(workspaceRoot) => void createConversation(workspaceRoot, 'project')}
          onCreateWorkflowProject={() => void createWorkflowProject()}
          onDeleteThread={(id) => void deleteConversation(id)}
          onForgetWorkspace={(workspaceRoot) => { void forgetWorkspace(workspaceRoot); }}
          onOpenSettings={() => { setSettingsOpen(true); setSidebarOpen(false); }}
          onPickWorkspace={() => void createConversationWithWorkspacePicker()}
          onRenameThread={renameConversation}
          onSearchQueryChange={setThreadFilter} onSelectThread={(id) => { void loadThread(id); setSidebarOpen(false); }}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
        />
      </aside>
      <section
        className={[
          'workspace',
          showRightPane ? '' : 'rightPaneHidden',
          isWorkflowProject ? 'workflowSplit' : '',
        ].filter(Boolean).join(' ')}
        style={{
          gridTemplateColumns: rightPaneGridTemplateColumns,
        }}
      >
        <header className="topbar">
          <div className="conversationTitle">
            <strong>{activeThread?.title || t(config.locale, 'noConversation')}</strong>
            {hasActiveThread ? <span>{status}</span> : null}
          </div>
          {hasActiveThread ? (
            <div className="usage-strip" title={buildTokenTooltip(tokenUsage, displayCompactionPressure, config.locale)}>
              <span className={["usage-item", "cache", tokenUsage?.cacheReported !== true ? "unknown" : ""].filter(Boolean).join(' ')}>
                <b>{tokenUsage?.cacheReported === true
                  ? `${config.locale === 'zh' ? '缓存命中' : 'Cache hit'} ${tokenUsage.hitRate ?? 0}%`
                  : (config.locale === 'zh' ? '缓存未上报' : 'Cache unavailable')}</b>
                {tokenUsage?.cacheReported === true ? <i><span style={{ width: `${tokenUsage.hitRate ?? 0}%` }} /></i> : null}
              </span>
              {hasContextPressure(displayCompactionPressure) ? (
                <span className="usage-item context">
                  <b>{config.locale === 'zh' ? '上下文' : 'Context'} {contextUsagePercent(displayCompactionPressure)}%</b>
                  <i><span style={{ width: `${contextUsagePercent(displayCompactionPressure)}%` }} /></i>
                </span>
              ) : (
                <span className="usage-item context unknown" title={config.locale === 'zh' ? '请在模型配置中填写上下文 Token 数' : 'Set context tokens in model settings'}>
                  <b>{config.locale === 'zh' ? '上下文未配置' : 'Context unset'}</b>
                </span>
              )}
            </div>
          ) : null}
          <div className="actions">
            {/* 移动端菜单按钮，窄屏显示 — Chinese: mobile menu button, narrow-only */}
            <button type="button" className="iconButton mobileMenuButton" onClick={() => setSidebarOpen((value) => !value)} title={config.locale === 'zh' ? '菜单' : 'Menu'} aria-label={config.locale === 'zh' ? '菜单' : 'Menu'} aria-expanded={sidebarOpen}><Icon name="menu" /></button>
            <button
              className="iconButton themeQuickButton"
              onClick={() => setConfig((current) => ({ ...current, themeMode: nextThemeMode(current.themeMode) }))}
              title={themeShortcutTitle}
              aria-label={themeShortcutTitle}
            >
              <Icon name={themeShortcutIcon} />
            </button>
            <button className="iconButton" onClick={() => void threadAction('compact')} disabled={!threadId || busy || actionBusy} title={t(config.locale, 'compact')} aria-label={t(config.locale, 'compact')}><Icon name="refresh" /></button>
            <button className="iconButton helpButton" onClick={() => setSettingsHelpOpen(true)} title={config.locale === 'zh' ? '设置说明' : 'Settings guide'} aria-label={config.locale === 'zh' ? '设置说明' : 'Settings guide'}><Icon name="question" /></button>
            <button className={monitorButtonActive ? 'iconButton panelButton active' : 'iconButton panelButton'} onClick={openUnifiedMonitor} title={config.locale === 'zh' ? '任务监控' : 'Task monitor'} aria-label={config.locale === 'zh' ? '任务监控' : 'Task monitor'}><Icon name="activity" /></button>
            <button className={taskCenterOpen ? 'iconButton panelButton active' : 'iconButton panelButton'} onClick={() => setTaskCenterOpen(true)} title={config.locale === 'zh' ? '运行观察' : 'Run observer'} aria-label={config.locale === 'zh' ? '运行观察' : 'Run observer'}><Icon name="workflow" /></button>
            <button className={showRightPane ? 'iconButton panelButton rightPaneToggleButton active' : 'iconButton panelButton rightPaneToggleButton'} onClick={toggleRightPane} disabled={!hasActiveThread} title={config.locale === 'zh' ? '显示/隐藏右侧栏' : 'Show/hide right panel'} aria-label={config.locale === 'zh' ? '显示/隐藏右侧栏' : 'Show/hide right panel'}><Icon name="panel" /></button>
          </div>
        </header>
        <div className="contentGrid">
          <section className="transcript" ref={transcriptRef} onScroll={handleTranscriptScroll}>
            {items.length === 0 && preparingTurn?.threadId !== threadId ? (
              <div className="empty">{isWorkflowProject
                ? (config.locale === 'zh' ? '从下方输入工作流目标，或描述节点修改要求。' : 'Describe a workflow goal or node change below.')
                : t(config.locale, 'empty')}</div>
            ) : (
              <>
                <TranscriptTurnRail entries={transcriptTurnSummaries} transcriptRef={transcriptRef} onSelect={scrollToTranscriptTurn} />
                {transcriptGroups.map((group) => (
                  group.kind === 'user' ? (
                    <div
                      className="transcriptTurnAnchor"
                      key={group.item.id}
                      ref={(element) => {
                        const turnId = group.item.turnId ?? group.item.id;
                        if (element) transcriptTurnRefs.current.set(turnId, element);
                        else transcriptTurnRefs.current.delete(turnId);
                      }}
                    >
                      <ItemView
                        item={group.item as ThreadItem}
                        locale={config.locale}
                        canRollback={Boolean(group.item.turnId && group.item.turnId === latestRollbackTurnId && !busy && !actionBusy)}
                        onBranch={branchFromTurn}
                        onCopy={copyMessage}
                        onRollback={rollbackToTurn}
                        onPreviewFile={previewFileFromItem}
                        userAvatarId={config.userAvatarId}
                        customUserAvatarDataUrl={config.customUserAvatarDataUrl}
                      />
                    </div>
                  ) : (
                    <AssistantTurnView
                      group={{
                        ...group,
                        items: group.items as ThreadItem[],
                        status: group.turnId && runningTurnIds.has(group.turnId) ? 'running' : group.status,
                      }}
                      key={group.id}
                      locale={config.locale}
                      canRegenerate={Boolean(group.turnId && group.turnId === latestRollbackTurnId && !busy && !actionBusy)}
                      childActivityByThread={childActivityByThread}
                      onBranch={branchFromTurn}
                      onCopy={copyMessage}
                      onRegenerate={regenerateFromTurn}
                      onPreviewFile={previewFileFromItem}
                      workspaceRoot={activeWorkspaceRoot}
                    />
                  )
                ))}
                {preparingTurn?.threadId === threadId ? <TurnPreparingIndicator locale={config.locale} /> : null}
                {opsTask && (opsTask.state === 'waiting_confirmation' || opsTask.state === 'blocked') ? (
                  <OpsTaskAnchorCard locale={config.locale} task={opsTask} busy={opsTaskBusy} onAction={handleOpsTaskAction} />
                ) : null}
              </>
            )}
            <div ref={transcriptEndRef} className="transcriptEndSentinel" aria-hidden="true" />
          </section>
          {showRightPane && (responsiveMode === 'overlay' || responsiveMode === 'sheet') ? (
            <div className="workbenchOverlay" onClick={handleCloseWorkbench} aria-hidden="true" />
          ) : null}
          {showRightPane ? (
            <>
              {responsiveMode === 'side' ? (
                <button
                  type="button"
                  className="rightPaneDivider"
                  aria-label={config.locale === 'zh' ? '调整右侧栏宽度' : 'Resize right panel'}
                  title={config.locale === 'zh' ? '拖拽调整右侧栏宽度' : 'Drag to resize right panel'}
                  onPointerDown={startRightPaneResize}
                />
              ) : null}
              {isWorkflowProject ? <WorkflowSidePane locale={config.locale} workflow={activeWorkflow} planDraft={workflowPlanDraft} components={workflowPlanDraft?.components ?? workflowComponents} blueprint={workflowPlanDraft?.blueprint ?? workflowBlueprint} runEvents={runMonitor.events} saving={workflowSaving} runtimeBusy={workflowRuntimeBusy} onCancelPlan={() => setWorkflowPlanDraft(null)} onCommitPlan={() => void commitWorkflowPlan()} onSave={(workflow) => void saveWorkflow(workflow)} onControl={(action, nodeId) => void controlWorkflowRuntime(action, nodeId)} onSelectionChange={setWorkflowSelectedNodeIds} /> : (
                 <RightPane key={`${hasActiveThread ? threadId : 'no-thread'}:${activeWorkspaceRoot}`} activeThread={hasActiveThread ? activeThread : null} activeThreadId={hasActiveThread ? threadId : ''} activeThreadTitle={hasActiveThread ? activeThread?.title ?? '' : ''} busy={hasActiveThread && busy} threadChildren={hasActiveThread ? threadChildren : []} externalPreviewRequest={previewRequest} config={config} locale={config.locale} runtimeItems={hasActiveThread ? items : []} taskRuntimeState={hasActiveThread ? taskRuntimeMonitor.state : undefined} workspaceRoot={activeWorkspaceRoot} onTabChange={(tab) => setRightPaneSizingMode(rightPaneSizingModeForTab(tab))} onJumpToMonitor={jumpToMonitor} onToggleMemoryExcluded={(excluded) => void toggleThreadMemoryExcluded(excluded)} onAddFileToConversation={addWorkspaceFileToComposer} traceSummary={hasActiveThread ? workbenchTraceSummary as Parameters<typeof RightPane>[0]['traceSummary'] : null} currentRunId={hasActiveThread ? workbenchCurrentRunId : undefined} controlCapabilities={hasActiveThread && workbenchSelectedRun?.controlCapabilities ? { interrupt: workbenchSelectedRun.controlCapabilities.interrupt, resume: workbenchSelectedRun.controlCapabilities.resume, rollback: { enabled: workbenchSelectedRun.controlCapabilities.rollback.enabled, checkpointIds: workbenchSelectedRun.controlCapabilities.rollback.checkpointIds ?? [], reason: workbenchSelectedRun.controlCapabilities.rollback.reason } } : undefined} recentTraces={hasActiveThread ? runMonitor.traces.slice(-10) : []} onInterrupt={handleControlInterrupt} onResume={handleControlResume} onRollback={handleControlRollback} responsiveMode={responsiveMode === 'side' ? undefined : responsiveMode} onCloseRequest={handleCloseWorkbench} showOps={Boolean(opsTask)} opsTask={opsTask} opsTaskBusy={opsTaskBusy} onOpsTaskAction={handleOpsTaskAction} />
              )}
            </>
          ) : null}
        </div>
        <ApprovalPanel locale={config.locale} approvals={pendingApprovals} onDecision={decideApproval} />
        {transcriptFollow.showReturnToBottom ? (
          <button type="button" className="returnToBottomButton" onClick={handleReturnToBottom} title={config.locale === 'zh' ? '回到底部' : 'Return to bottom'} aria-label={config.locale === 'zh' ? '回到底部' : 'Return to bottom'}>
            <Icon name="chevronDown" />
          </button>
        ) : null}
        <ComposerBar activeSlashOption={activeSlashOption} activeThreadId={threadId} actionBusy={actionBusy} addFileReference={(path) => setComposerFileReferences((current) => current.includes(path) ? current : [...current, path])} applyModelPreset={applyModelPreset} botConfig={botConfig} botStatus={botStatus} busy={busy} composerInputRef={composerInputRef} config={config} draggingImage={draggingImage} executionMode={executionMode} thinkingMode={thinkingMode} onThinkingModeChange={(mode) => { void selectThinkingMode(mode).catch(reportExecutionModeError); }} onClearExecutionMode={clearExecutionMode} filteredSlashOptions={filteredSlashOptions} handleDrop={handleDrop} handleFileSelect={handleFileSelect} handlePaste={handlePaste} images={images} input={input} fileReferences={composerFileReferences} modelPresets={modelPresets} providers={providers} openRemoteAssistants={openRemoteAssistants} persistThreadConfigOverrides={saveThreadModelOverrides} removeImage={removeImage} removeFileReference={(path) => setComposerFileReferences((current) => current.filter((item) => item !== path))} rightPaneVisible={showRightPane} selectSlashOption={selectSlashOption} setActiveSlashOption={setActiveSlashOption} setConfig={setConfig} setDraggingImage={setDraggingImage} setInput={setInput} slashVisible={slashVisible} stopTurn={stopTurn} submitComposer={submitComposer} workflowMode={isWorkflowProject} workflowPlanning={workflowPlanning} workspaceRoot={activeWorkspaceRoot} />
      </section>
      {settingsOpen ? (
        <SettingsDrawer
          botConfig={botConfig} botStatus={botStatus} config={config} keyStates={keyStates} locale={config.locale}
          mcps={mcps} mcpStatuses={mcpStatuses} modelPresets={modelPresets} providers={providers} skillsList={skillsList}
          refreshSkills={refreshSkills} refreshMcpStatus={refreshMcpStatus} refreshBotStatus={refreshBotStatus}
          refreshProviders={refreshProviders}
          clearProviderKey={clearProviderKey}
          deleteSkill={deleteSkill}
          requestModelPresetName={requestModelPresetName} saveModelPreset={saveModelPreset} deleteModelPreset={deleteModelPreset} deleteCustomProvider={deleteCustomProvider} saveProviderKey={saveProviderKey} saveProviderEnvVar={saveProviderEnvVar} saveBotConfig={saveBotConfig} saveSkillDraft={saveSkillDraft}
          webProviderState={webProviderState} saveWebProviderKey={saveWebProviderKey} clearWebProviderKey={clearWebProviderKey}
          setConfig={setConfig} setMcps={setMcps} setOpen={setSettingsOpen}
          pendingMcpDraft={pendingMcpDraft}
          consumePendingMcpDraft={() => setPendingMcpDraft(null)}
          startDingtalkStream={startDingtalkStream} stopDingtalkStream={stopDingtalkStream} testDingtalkMessage={testDingtalkMessage}
          activeThreadId={threadId}
          workspaceRoots={rememberedWorkspaceRoots}
          saveThreadModelOverrides={saveThreadModelOverrides}
          saveGlobalModelConfig={saveGlobalModelConfig}
          refreshKeyStates={refreshKeyStates}
        />
      ) : null}
      {settingsHelpOpen ? <SettingsHelpDialog locale={config.locale} onClose={() => setSettingsHelpOpen(false)} /> : null}
      <RunMonitorDrawer
        threadId={threadId}
        open={runMonitor.open}
        runs={runMonitor.runs}
        traces={runMonitor.traces}
        visibleTraces={runMonitor.visibleTraces}
        threads={runMonitor.threads}
        selectedRunId={runMonitor.selectedRunId}
        selectedRun={runMonitor.selectedRun}
        selectedEventId={runMonitor.selectedEventId}
        traceFocusVersion={runMonitor.traceFocusVersion}
        selectedTrace={runMonitor.selectedTrace}
        systemMonitorStatus={runMonitor.systemMonitorStatus}
        categoryFilter={runMonitor.categoryFilter}
        errorsOnly={runMonitor.errorsOnly}
        tracePage={runMonitor.tracePage}
        expandedThreadId={runMonitor.expandedThreadId}
        autoRefresh={runMonitor.autoRefresh}
        autoRefreshInterval={runMonitor.autoRefreshInterval}
        loading={runMonitor.loading}
        loadError={runMonitor.loadError}
        allCategories={runMonitor.allCategories}
        zh={runMonitor.zh}
        onClose={() => runMonitor.setOpen(false)}
        onRefresh={() => void runMonitor.refresh(runMonitor.selectedRunId || undefined)}
        onSelectRun={(runId) => void runMonitor.refresh(runId)}
        onControlRun={(action, opts) => {
          if (runMonitor.selectedRun) {
            void runMonitor.controlRun(action, runMonitor.selectedRun, opts);
          }
        }}
        onToggleThread={runMonitor.toggleThread}
        onSelectEvent={runMonitor.selectEvent}
        onToggleCategory={runMonitor.toggleCategory}
        onSetCategoryFilter={runMonitor.setCategoryFilter}
        onSetErrorsOnly={runMonitor.setErrorsOnly}
        onAutoRefreshChange={runMonitor.setAutoRefresh}
        onAutoRefreshIntervalChange={runMonitor.setAutoRefreshInterval}
        onLoadOlder={() => void runMonitor.loadOlder()}
      />
      <TaskCenterDrawer
        open={taskCenterOpen}
        locale={config.locale}
        onClose={() => setTaskCenterOpen(false)}
        onJumpToThread={(jumpThreadId) => {
          setTaskCenterOpen(false);
          if (jumpThreadId !== threadId) void loadThread(jumpThreadId);
        }}
      />
      {dialog ? <AppDialog dialog={dialog} onClose={() => setDialog(null)} /> : null}
      {toast ? <div className="toastNotice" key={toast.id} role="alert"><Icon name="alert" /><span>{toast.text}</span></div> : null}
      {weixinConnectState ? <WeixinConnectDialog locale={config.locale} state={weixinConnectState} onClose={() => setWeixinConnectState(null)} /> : null}
      {skillDraft ? (
        <SkillDraftDialog
          draft={skillDraft}
          locale={config.locale}
          onCancel={() => setSkillDraft(null)}
          onSave={saveSkillDraft}
        />
      ) : null}
    </main>
  );
}

function mergeComposerFileReferences(text: string, references: string[]): string {
  const tokens = references.map((path) => /\s/.test(path) ? `@"${path}"` : `@${path}`);
  return [text.trim(), ...tokens].filter(Boolean).join(' ');
}

function rightPaneVisibilityStorageKey(threadId: string): string {
  return `suanlizi.workbench.visibility.v1:${encodeURIComponent(threadId)}`;
}

function readStoredRightPaneVisibility(threadId?: string, fallback = true): boolean {
  const normalized = threadId?.trim();
  if (!normalized) return false;
  try {
    const stored = localStorage.getItem(rightPaneVisibilityStorageKey(normalized));
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

function writeStoredRightPaneVisibility(visible: boolean, threadId?: string): void {
  const normalized = threadId?.trim();
  if (!normalized) return;
  try {
    localStorage.setItem(rightPaneVisibilityStorageKey(normalized), visible ? '1' : '0');
  } catch {
    // UI state persistence is best effort.
  }
}

function readStoredRightPaneSizingMode(threadId?: string): 'standard' | 'files' | 'terminal' {
  const normalized = threadId?.trim();
  if (!normalized) return 'standard';
  try {
    const tab = localStorage.getItem(`suanlizi.rightPane.tab:${encodeURIComponent(normalized)}`);
    if (tab === 'files') return 'files';
    if (tab === 'terminal') return 'terminal';
    return 'standard';
  } catch {
    return 'standard';
  }
}

function rightPaneSizingModeForTab(tab: string): 'standard' | 'files' | 'terminal' {
  if (tab === 'files') return 'files';
  if (tab === 'terminal') return 'terminal';
  return 'standard';
}

createRoot(document.getElementById('root')!).render(<App />);
