import React from 'react';
import type { RunConfig } from '../config/config.js';
import { extractUrlTokens, summarizeUrlToken } from '../features/input/composerInput.js';
import type { ComposerExecutionMode, ComposerThinkingMode } from '../features/composer/executionMode.js';
import type { SlashCommandOption } from '../features/slash/slashCommands.js';
import { resizeTextareaToContent } from '../shared/composer.js';
import { t } from '../shared/i18n.js';
import { DropdownSelect } from './DropdownSelect.js';
import { Icon } from './Icon.js';
import { ModelBrandIcon } from './ModelBrandIcon.js';
import type { BotConfig, BotStatus, ModelPreset, ProviderEntry } from '../shared/types.js';
import type { ThreadConfigOverrides } from '../api/threadConfigClient.js';

export type RemoteAssistantPlatform = 'weixin' | 'dingtalk';

// 输入栏选项类型：普通命令 / 插入 Skill / 启用 MCP。
// Composer palette option type: plain command / insert Skill / enable MCP.
export type PaletteOption = SlashCommandOption & (
  | { action?: 'command' }
  | { action: 'insert_skill'; skillName: string; hideCommand: true }
  | { action: 'enable_mcp'; mcpId: string; hideCommand: true }
);

// 输入历史在 localStorage 中的键。
// Storage key for composer history in localStorage.
export const COMPOSER_HISTORY_STORAGE_KEY = 'nexus.composer.history.v1';
// 输入草稿在 localStorage 中的键（用于刷新后恢复）。
// Storage key for composer draft in localStorage (used to restore after refresh).
export const COMPOSER_DRAFT_STORAGE_KEY = 'nexus.composer.draft.v1';
// 保留的历史条目上限。
// Maximum number of history entries to keep.
const COMPOSER_HISTORY_LIMIT = 100;

// 自定义厂商图标：已注册的 custom_* 使用 iconUrl，其他厂商走原有无图标逻辑。
// English: custom provider icon resolution for composer options.
// 输入框模型下拉的厂商图标：自定义厂商用其 favicon，内置厂商用品牌图标。
// 没有任何品牌时回退到中性连接图标，绝不留空。
function providerIcon(
  providers: ProviderEntry[],
  providerId: string | undefined,
  model: string | undefined,
): React.ReactNode {
  const selected = providers.find((provider) => provider.id === providerId);
  return <ModelBrandIcon model={model} provider={providerId} providerName={selected?.name} iconUrl={selected?.iconUrl} baseUrl={selected?.baseUrl} />;
}

type FileMentionEntry = {
  kind: 'directory' | 'file';
  name: string;
  path: string;
};

export function ComposerBar({
  activeSlashOption,
  activeThreadId,
  addFileReference = () => undefined,
  applyModelPreset,
  botConfig,
  botStatus,
  busy,
  actionBusy = false,
  composerInputRef,
  config,
  draggingImage,
  executionMode = 'chat',
  filteredSlashOptions,
  handleDrop,
  handleFileSelect,
  handlePaste,
  images,
  input,
  fileReferences = [],
  modelPresets,
  providers = [],
  openRemoteAssistants,
  thinkingMode = config.reasoningEffort as ComposerThinkingMode,
  onThinkingModeChange = () => undefined,
  onClearExecutionMode = () => undefined,
  persistThreadConfigOverrides = async () => undefined,
  removeImage,
  removeFileReference = () => undefined,
  rightPaneVisible,
  selectSlashOption,
  setActiveSlashOption,
  setConfig,
  setDraggingImage,
  setInput,
  slashVisible,
  stopTurn,
  submitComposer,
  workflowMode = false,
  workflowPlanning = false,
  workspaceRoot = '',
}: {
  activeSlashOption: SlashCommandOption | null;
  activeThreadId: string;
  addFileReference?: (path: string) => void;
  applyModelPreset: (preset: ModelPreset) => void;
  botConfig: BotConfig | null;
  botStatus: BotStatus | null;
  busy: boolean;
  actionBusy?: boolean;
  composerInputRef: React.RefObject<HTMLTextAreaElement | null>;
  config: RunConfig;
  draggingImage: boolean;
  executionMode?: ComposerExecutionMode;
  filteredSlashOptions: PaletteOption[];
  handleDrop: (event: React.DragEvent<HTMLElement>) => void;
  handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  images: Array<{ name: string; dataUrl: string }>;
  input: string;
  fileReferences?: string[];
  modelPresets: ModelPreset[];
  providers?: ProviderEntry[];
  openRemoteAssistants: (platform: RemoteAssistantPlatform) => void;
  /** Dynamic Workflow 是思考程度的第四档，不属于执行入口。 */
  thinkingMode?: ComposerThinkingMode;
  onThinkingModeChange?: (mode: ComposerThinkingMode) => void;
  onClearExecutionMode?: () => void;
  persistThreadConfigOverrides?: (overrides: ThreadConfigOverrides) => Promise<void>;
  removeImage: (index: number) => void;
  removeFileReference?: (path: string) => void;
  rightPaneVisible: boolean;
  selectSlashOption: (option: PaletteOption) => void;
  setActiveSlashOption: (option: SlashCommandOption | null) => void;
  setConfig: React.Dispatch<React.SetStateAction<RunConfig>>;
  setDraggingImage: (dragging: boolean) => void;
  setInput: (value: string) => void;
  slashVisible: boolean;
  stopTurn: () => Promise<void>;
  submitComposer: () => Promise<void>;
  workflowMode?: boolean;
  workflowPlanning?: boolean;
  workspaceRoot?: string;
}) {
  const historyRef = React.useRef<string[]>([]);
  const [historyCursor, setHistoryCursor] = React.useState<number | null>(null);
  const [assistantMenuOpen, setAssistantMenuOpen] = React.useState(false);
  const [fileMentions, setFileMentions] = React.useState<FileMentionEntry[]>([]);
  const [fileMentionIndex, setFileMentionIndex] = React.useState(0);
  const [fileMentionDirectory, setFileMentionDirectory] = React.useState('');
  const remoteBinding = remoteBindingView(botConfig, botStatus, activeThreadId, config.locale);
  const matchedModelPreset = modelPresets.find((preset) => modelPresetMatchesConfig(preset, config));
  const modelPresetValue = matchedModelPreset?.id ?? '__current__';
  const currentModelPresetOptions = matchedModelPreset
    ? []
    : [{
      value: '__current__',
      label: modelDisplayName(config.model),
      icon: providerIcon(providers, config.provider, config.model),
      title: modelPresetTooltip(config),
      current: true,
    }];
  const modelPresetOptions = [
    ...currentModelPresetOptions,
    ...modelPresets.map((preset) => ({
      value: preset.id,
      label: modelDisplayName(preset.config.model ?? config.model),
      icon: providerIcon(providers, preset.config.provider ?? config.provider, preset.config.model ?? config.model),
      title: modelPresetTooltip({ ...config, ...preset.config }),
      current: matchedModelPreset?.id === preset.id,
    })),
  ];
  const workflowBusy = workflowMode && workflowPlanning;
  const modeIndicator: { className: string; label: string; icon?: React.ReactNode } | null = executionMode === 'plan'
    ? { className: 'modeIndicatorPlan', label: config.locale === 'zh' ? '计划' : 'Plan', icon: <Icon name="listChecks" /> }
    : executionMode === 'goal'
      ? { className: 'modeIndicatorGoal', label: 'Goal' }
      : null;
  const thinkingOptions: Array<{ value: ComposerThinkingMode; label: string; icon: React.ReactNode }> = [
    { value: 'no', label: config.locale === 'zh' ? '快速' : 'Fast', icon: <Icon name="gauge" /> },
    { value: 'medium', label: config.locale === 'zh' ? '均衡' : 'Balanced', icon: <Icon name="balance" /> },
    { value: 'high', label: config.locale === 'zh' ? '深度' : 'Deep', icon: <Icon name="layers" /> },
    { value: 'xhigh', label: config.locale === 'zh' ? '更深' : 'Deeper', icon: <Icon name="brain" /> },
    { value: 'max', label: config.locale === 'zh' ? '最高' : 'Max', icon: <Icon name="spark" /> },
    { value: 'workflow', label: config.locale === 'zh' ? '动态工作流' : 'Dynamic Workflow', icon: <Icon name="workflow" /> },
  ];
  const urlTokens = React.useMemo(() => extractUrlTokens(input), [input]);
  const commandInputClassName = [
    'commandInputRow',
    !workflowMode && activeSlashOption ? 'active' : '',
    urlTokens.length > 0 ? 'withTokens' : '',
  ].filter(Boolean).join(' ');
  const fileMentionMatch = !workflowMode ? input.match(/(?:^|\s)@([^\s@"]*)$/) : null;
  const fileMentionQuery = fileMentionMatch?.[1] ?? '';

  React.useEffect(() => {
    if (!fileMentionMatch || !workspaceRoot) {
      setFileMentions([]);
      return undefined;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({ root: workspaceRoot });
      if (fileMentionQuery) params.set('query', fileMentionQuery);
      else if (fileMentionDirectory) params.set('path', fileMentionDirectory);
      fetch(`/api/workspaces/files?${params}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('File search failed')))
        .then((data: { entries?: FileMentionEntry[] }) => {
          setFileMentions((data.entries ?? []).filter((entry) => entry.kind === 'file' || entry.kind === 'directory'));
          setFileMentionIndex(0);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFileMentions([]);
        });
    }, 120);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [fileMentionQuery, fileMentionDirectory, Boolean(fileMentionMatch), workspaceRoot]);

  function insertFileMention(path: string): void {
    if (!fileMentionMatch) return;
    updateComposerInput(input.slice(0, fileMentionMatch.index! + fileMentionMatch[0].lastIndexOf('@')));
    addFileReference(path);
    setFileMentions([]);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  function openFileMentionDirectory(path: string): void {
    setFileMentionDirectory(path);
    setFileMentionIndex(0);
  }

  function moveToFileMentionParent(): void {
    setFileMentionDirectory((current) => current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '');
    setFileMentionIndex(0);
  }

  function startComposerResize(event: React.PointerEvent<HTMLElement>): void {
    const textarea = composerInputRef.current;
    if (!textarea) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = textarea.getBoundingClientRect().height;
    const composer = textarea.closest<HTMLElement>('.composer');
    const minHeight = 44;
    const maxHeight = Math.min(420, Math.floor(window.innerHeight * 0.42));
    const controls = composer?.querySelector<HTMLElement>('.composerBottom');
    const viewportBottom = Math.min(window.innerHeight, document.documentElement.clientHeight) - 8;
    const maximumControlsBottom = Math.min(controls?.getBoundingClientRect().bottom ?? viewportBottom, viewportBottom);
    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + startY - moveEvent.clientY));
      textarea.dataset.userResized = 'true';
      textarea.style.height = `${Math.round(nextHeight)}px`;

      // Keep the composer controls inside the live viewport even when zoom or layout changes.
      const visibleBottom = controls?.getBoundingClientRect().bottom ?? composer?.getBoundingClientRect().bottom ?? 0;
      const overflow = Math.max(0, visibleBottom - maximumControlsBottom);
      if (overflow > 0) {
        textarea.style.height = `${Math.round(Math.max(minHeight, nextHeight - overflow))}px`;
      }
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }

  React.useEffect(() => {
    historyRef.current = readComposerHistory();
    const draft = readComposerDraft();
    if (draft && !input.trim()) {
      setInput(draft);
      window.requestAnimationFrame(() => resizeTextareaToContent(composerInputRef.current));
    }
  }, []);

  function updateComposerInput(next: string) {
    setHistoryCursor(null);
    setInput(next);
    writeComposerDraft(next);
    window.requestAnimationFrame(() => resizeTextareaToContent(composerInputRef.current));
  }

  async function handleSubmitComposer() {
    const text = input.trim();
    await submitComposer();
    if (text) {
      historyRef.current = writeComposerHistory(text, historyRef.current);
    }
    setHistoryCursor(null);
    clearComposerDraft();
  }

  function browseComposerHistory(direction: 'up' | 'down'): boolean {
    const history = historyRef.current;
    if (history.length === 0) return false;
    if (direction === 'up') {
      if (input.trim() && historyCursor === null) return false;
      const nextCursor = historyCursor === null ? history.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextCursor);
      setInput(history[nextCursor]);
      writeComposerDraft(history[nextCursor]);
      window.requestAnimationFrame(() => resizeTextareaToContent(composerInputRef.current));
      return true;
    }
    if (historyCursor === null) return false;
    const nextCursor = historyCursor + 1;
    if (nextCursor >= history.length) {
      setHistoryCursor(null);
      setInput('');
      clearComposerDraft();
    } else {
      setHistoryCursor(nextCursor);
      setInput(history[nextCursor]);
      writeComposerDraft(history[nextCursor]);
    }
    window.requestAnimationFrame(() => resizeTextareaToContent(composerInputRef.current));
    return true;
  }

  function selectRemoteAssistant(platform: RemoteAssistantPlatform): void {
    setAssistantMenuOpen(false);
    openRemoteAssistants(platform);
  }

  function updateThinkingMode(next: ComposerThinkingMode): void {
    onThinkingModeChange(next);
  }

  function updateThreadChoice<K extends 'permissions' | 'reasoningEffort'>(
    key: K,
    value: NonNullable<ThreadConfigOverrides[K]>,
  ): void {
    setConfig((current) => ({ ...current, [key]: value }));
    void persistThreadConfigOverrides({ [key]: value } as Pick<ThreadConfigOverrides, K>);
  }

  const sendButtonClassName = ['sendButton', busy || workflowPlanning ? 'busy' : '', busy ? 'stopButton' : '', workflowPlanning ? 'planningButton' : ''].filter(Boolean).join(' ');

  return (
    <footer
      className={['composer', draggingImage ? 'dragging' : '', !rightPaneVisible ? 'compactWidth' : 'balancedWidth'].filter(Boolean).join(' ')}
      onDragEnter={(event) => { event.preventDefault(); setDraggingImage(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDraggingImage(false)}
      onDrop={handleDrop}
    >
      <div className="composerMain">
        <div className="composerInner">
          {images.length > 0 ? (
            <div className="imageStrip">
              {images.map((img, i) => (
                <div className="imageThumb" key={i}>
                  <img src={img.dataUrl} alt={img.name} />
                  <button className="imageRemove" onClick={() => removeImage(i)} title={t(config.locale, 'remove')} aria-label={t(config.locale, 'remove')}>
                    <Icon name="x" />
                  </button>
                  <span>{img.name}</span>
                </div>
              ))}
            </div>
          ) : null}
          {!workflowMode && slashVisible && filteredSlashOptions.length > 0 ? (
            <div className="slashPalette" role="listbox" aria-label="Slash commands">
              {filteredSlashOptions.map((option) => (
                <button className={'hideCommand' in option && option.hideCommand ? 'slashOption compact' : 'slashOption'} key={option.id} onClick={() => selectSlashOption(option)}>
                  <strong>{option.title}</strong>
                  {'hideCommand' in option && option.hideCommand ? null : <span>{option.command}</span>}
                  <small>{option.detail}</small>
                </button>
              ))}
            </div>
          ) : null}
          <div className={commandInputClassName}>
            {fileMentionMatch && fileMentions.length > 0 ? (
              <div className="fileMentionPalette" role="listbox" aria-label={config.locale === 'zh' ? '项目文件' : 'Project files'}>
                <div className="fileMentionPaletteHeader">
                  <span>{fileMentionDirectory || (fileMentionQuery ? (config.locale === 'zh' ? '搜索项目文件' : 'Search project files') : (config.locale === 'zh' ? '项目根目录' : 'Project root'))}</span>
                  {fileMentionDirectory ? <button type="button" onClick={moveToFileMentionParent} title={config.locale === 'zh' ? '返回上级目录' : 'Parent directory'} aria-label={config.locale === 'zh' ? '返回上级目录' : 'Parent directory'}><Icon name="chevron" /></button> : null}
                </div>
                {fileMentions.map((file, index) => (
                  <button className={index === fileMentionIndex ? 'active' : ''} key={file.path} type="button" role="option" aria-selected={index === fileMentionIndex} onClick={() => file.kind === 'directory' ? openFileMentionDirectory(file.path) : insertFileMention(file.path)}>
                    <Icon name={file.kind === 'directory' ? 'folderOutline' : 'fileOutline'} />
                    <span><strong>{file.name}</strong><small>{file.path}</small></span>
                    {file.kind === 'directory' ? <Icon name="chevronRight" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {!workflowMode && activeSlashOption ? (
              <div className="commandInputMeta">
                <div className="commandChip" title={activeSlashOption.command.trim()}>
                  <span>{activeSlashOption.command.trim()}</span>
                  <button type="button" title={t(config.locale, 'cancel')} aria-label={t(config.locale, 'cancel')} onClick={() => { setActiveSlashOption(null); setInput(''); composerInputRef.current?.focus(); }}>
                    <Icon name="x" />
                  </button>
                </div>
                {urlTokens.length > 0 ? (
                  <div className="commandTokenRow" aria-label={config.locale === 'zh' ? '已识别链接' : 'Detected links'}>
                    {urlTokens.map((token) => (
                      <span className="commandUrlChip" key={token.value} title={token.value}>
                        <span>{summarizeUrlToken(token.value)}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : urlTokens.length > 0 ? (
              <div className="commandTokenRow" aria-label={config.locale === 'zh' ? '已识别链接' : 'Detected links'}>
                {urlTokens.map((token) => (
                  <span className="commandUrlChip" key={token.value} title={token.value}>
                    <span>{summarizeUrlToken(token.value)}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {fileReferences.length > 0 ? (
              <div className="commandFileTokenRow" aria-label={config.locale === 'zh' ? '已引用文件' : 'Referenced files'}>
                {fileReferences.map((path) => (
                  <span className="commandFileToken" key={path} title={path}><Icon name="fileOutline" /><span>@{path}</span><button type="button" onClick={() => removeFileReference(path)} title={config.locale === 'zh' ? '移除引用' : 'Remove reference'} aria-label={config.locale === 'zh' ? '移除引用' : 'Remove reference'}><Icon name="x" /></button></span>
                ))}
              </div>
            ) : null}
            <div className="composerResizeHandle" onPointerDown={startComposerResize} role="separator" title={config.locale === 'zh' ? '向上拖拽扩大输入框' : 'Drag up to expand composer'} aria-label={config.locale === 'zh' ? '拖拽调整输入框高度' : 'Drag to resize composer'} />
            <textarea
              ref={composerInputRef}
              value={input}
              rows={1}
              onChange={(event) => updateComposerInput(event.target.value)}
              onInput={() => resizeTextareaToContent(composerInputRef.current)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (fileMentionMatch && fileMentions.length > 0) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setFileMentionIndex((current) => event.key === 'ArrowDown' ? (current + 1) % fileMentions.length : (current - 1 + fileMentions.length) % fileMentions.length);
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const selected = fileMentions[fileMentionIndex];
                    if (selected.kind === 'directory') openFileMentionDirectory(selected.path);
                    else insertFileMention(selected.path);
                    return;
                  }
                  if (event.key === 'ArrowRight' && fileMentions[fileMentionIndex]?.kind === 'directory') {
                    event.preventDefault();
                    openFileMentionDirectory(fileMentions[fileMentionIndex].path);
                    return;
                  }
                  if (event.key === 'ArrowLeft' && fileMentionDirectory && !fileMentionQuery) {
                    event.preventDefault();
                    moveToFileMentionParent();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setFileMentions([]);
                    return;
                  }
                }
                if (event.key === 'ArrowUp' && browseComposerHistory('up')) {
                  event.preventDefault();
                  return;
                }
                if (event.key === 'ArrowDown' && browseComposerHistory('down')) {
                  event.preventDefault();
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!busy && !actionBusy) void handleSubmitComposer();
                }
              }}
              placeholder={workflowMode
                ? (config.locale === 'zh' ? '输入工作流目标或节点修改要求...' : 'Describe a workflow goal or node change...')
                : activeSlashOption
                  ? (config.locale === 'zh' ? '输入自然语言参数...' : 'Describe what to add...')
                  : thinkingMode === 'workflow'
                    ? (config.locale === 'zh' ? '输入动态工作流目标…' : 'Describe a Dynamic Workflow…')
                    : executionModePlaceholder(executionMode, config.locale)}
            />
          </div>
        </div>
        <button className={sendButtonClassName} onClick={() => busy ? void stopTurn() : actionBusy ? undefined : void handleSubmitComposer()} disabled={workflowBusy || actionBusy || (!busy && (!input.trim() && images.length === 0 && fileReferences.length === 0))} title={workflowBusy ? (config.locale === 'zh' ? '生成计划中' : 'Planning workflow') : busy ? t(config.locale, 'stop') : t(config.locale, 'send')} aria-label={workflowBusy ? (config.locale === 'zh' ? '生成计划中' : 'Planning workflow') : busy ? t(config.locale, 'stop') : t(config.locale, 'send')}>
          <Icon name={workflowBusy ? 'refresh' : busy ? 'stopCircle' : 'send'} />
        </button>
      </div>
      <div className={workflowMode ? 'composerBottom workflowMode' : 'composerBottom'}>
        {workflowMode ? (
          <div className="workflowComposerPlan">
            <span>{config.locale === 'zh' ? '首次创建必须先生成计划' : 'First creation must start with a plan'}</span>
            <button className="solidButton" type="button" onClick={() => void handleSubmitComposer()} disabled={workflowBusy || busy || actionBusy || (!input.trim() && images.length === 0)}>
              {workflowBusy ? (config.locale === 'zh' ? '生成计划中' : 'Planning') : (config.locale === 'zh' ? '计划模式' : 'Plan mode')}
            </button>
          </div>
        ) : (
        <>
          {modeIndicator ? (
            <span className={`modeIndicator ${modeIndicator.className}`} aria-label={modeIndicator.label} title={modeIndicator.label}>
              {modeIndicator.icon ? <span className="modeIndicatorIcon">{modeIndicator.icon}</span> : null}
              <span>{modeIndicator.label}</span>
              <button
                type="button"
                className="modeIndicatorDismiss"
                aria-label={config.locale === 'zh' ? '关闭当前模式' : 'Clear current mode'}
                title={config.locale === 'zh' ? '关闭当前模式' : 'Clear current mode'}
                onClick={onClearExecutionMode}
              >
                <Icon name="x" />
              </button>
            </span>
          ) : null}
          <div className="remoteAssistantPicker">
            <button
              className={`weixinBindingButton remoteBindingButton ${remoteBinding.tone}`}
              title={remoteBinding.title}
              aria-label={remoteBinding.title}
              aria-haspopup="menu"
              aria-expanded={assistantMenuOpen}
              onClick={() => setAssistantMenuOpen((open) => !open)}
              type="button"
            >
              {remoteBinding.boundPlatforms.length > 0 ? (
                remoteBinding.boundPlatforms.map((platform) => <RemotePlatformIcon key={platform} platform={platform} />)
              ) : (
                <span className="remoteBindingRobot" aria-hidden="true"><Icon name="assistant" /></span>
              )}
            </button>
            {assistantMenuOpen ? (
              <div className="remoteAssistantMenu" role="menu" aria-label={config.locale === 'zh' ? '选择远程助手' : 'Select remote assistant'}>
                <button type="button" role="menuitem" onClick={() => selectRemoteAssistant('weixin')}>
                  <RemotePlatformIcon platform="weixin" />
                  <span>
                    <strong>{config.locale === 'zh' ? '微信' : 'WeChat'}</strong>
                    <small>{remoteBinding.weixinHint}</small>
                  </span>
                </button>
                <button type="button" role="menuitem" onClick={() => selectRemoteAssistant('dingtalk')}>
                  <RemotePlatformIcon platform="dingtalk" />
                  <span>
                    <strong>{config.locale === 'zh' ? '钉钉' : 'DingTalk'}</strong>
                    <small>{remoteBinding.dingtalkHint}</small>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <label className="fileButton" title={t(config.locale, 'attachImage')} aria-label={t(config.locale, 'attachImage')}>
            <input type="file" accept="image/*" multiple onChange={handleFileSelect} hidden />
            <Icon name="imagePlus" />
          </label>
          <div className="composerMeta">
          <DropdownSelect
            ariaLabel={config.locale === 'zh' ? '模型配置' : 'Model preset'}
            className="modelPresetSelect"
            title={config.locale === 'zh' ? '模型配置' : 'Model preset'}
            value={modelPresetValue}
            onChange={(presetId) => {
              if (presetId === '__current__') return;
              const preset = modelPresets.find((item) => item.id === presetId);
              if (preset) applyModelPreset(preset);
            }}
            options={modelPresetOptions}
          />
          </div>
          <div className="composerActions">
          <DropdownSelect ariaLabel={t(config.locale, 'mode')} className="modeSelect permissionSelect" title={t(config.locale, 'mode')} value={config.permissions} onChange={(permissions) => updateThreadChoice('permissions', permissions as NonNullable<ThreadConfigOverrides['permissions']>)} options={[{ value: 'read_only', label: config.locale === 'zh' ? '只读' : 'Read', icon: <Icon name="hand" /> }, { value: 'workspace', label: config.locale === 'zh' ? '默认' : 'Default', icon: <Icon name="messageShield" /> }, { value: 'danger_full_access', label: config.locale === 'zh' ? '自主' : 'Auto', icon: <Icon name="shieldAlert" />, tone: 'warning' }]} />
          <DropdownSelect ariaLabel={config.locale === 'zh' ? '思考程度' : 'Reasoning effort'} className="modeSelect reasoningSelect" title={config.locale === 'zh' ? '思考程度' : 'Reasoning effort'} value={thinkingMode} onChange={updateThinkingMode} options={thinkingOptions} />
          </div>
        </>
        )}
      </div>
    </footer>
  );
}


function executionModePlaceholder(mode: ComposerExecutionMode, locale: RunConfig['locale']): string {
  if (mode === 'goal') return locale === 'zh' ? '输入目标任务…' : 'Describe a Goal…';
  if (mode === 'plan') return locale === 'zh' ? '输入规划目标…' : 'Describe a plan…';
  return t(locale, 'placeholder');
}

function modelPresetMatchesConfig(preset: ModelPreset, config: RunConfig): boolean {
  const entries = Object.entries(preset.config) as Array<[keyof RunConfig, RunConfig[keyof RunConfig] | undefined]>;
  return entries.length > 0 && entries.every(([key, value]) => value === undefined || config[key] === value);
}

function readComposerHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(COMPOSER_HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeComposerHistory(text: string, current: string[]): string[] {
  const next = [...current.filter((item) => item !== text), text].slice(-COMPOSER_HISTORY_LIMIT);
  try {
    window.localStorage.setItem(COMPOSER_HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage can fail in private or constrained browser contexts.
  }
  return next;
}

function readComposerDraft(): string {
  try {
    return window.localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeComposerDraft(text: string): void {
  try {
    if (text) window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, text);
    else window.localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
  } catch {
    // Draft persistence is best-effort UX state.
  }
}

function clearComposerDraft(): void {
  try {
    window.localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
  } catch {
    // Draft persistence is best-effort UX state.
  }
}

function modelPresetSummary(config: Partial<RunConfig>): string {
  return [config.provider, config.model].filter(Boolean).join(' / ') || 'model';
}

function modelDisplayName(model?: string): string {
  const value = model?.trim() ?? '';
  if (!value) return 'model';
  const segments = value.split(/\s*\/\s*/).filter(Boolean);
  return (segments.at(-1) ?? value).replace(/:(?:featherless-ai)$/i, '');
}

function modelPresetTooltip(config: Partial<RunConfig>): string {
  return [
    modelPresetSummary(config),
    config.baseUrl ? `API: ${config.baseUrl}` : '',
    config.reasoningEffort ? `Reasoning: ${config.reasoningEffort}` : '',
  ].filter(Boolean).join('\n');
}

function RemotePlatformIcon({ platform }: { platform: RemoteAssistantPlatform }) {
  return (
    <span className={`remotePlatformIcon ${platform}`} aria-hidden="true">
      {platform === 'weixin' ? '微' : '钉'}
    </span>
  );
}

function remoteBindingView(
  botConfig: BotConfig | null,
  botStatus: BotStatus | null,
  activeThreadId: string,
  locale: RunConfig['locale'],
): {
  boundPlatforms: RemoteAssistantPlatform[];
  dingtalkHint: string;
  title: string;
  tone: 'ok' | 'warn' | 'muted';
  weixinHint: string;
} {
  const connected = Boolean(botConfig?.weixin.accountId) || botStatus?.weixin?.connected === true;
  const dingtalkConfigured = Boolean(botConfig?.dingtalk.enabled && botConfig.dingtalk.clientId && botConfig.dingtalk.clientSecret)
    || botStatus?.dingtalk?.configured === true;
  const platforms = [
    {
      name: locale === 'zh' ? '微信' : 'WeChat',
      platform: 'weixin' as const,
      boundThreadId: botConfig?.weixin.activeThreadId?.trim() ?? '',
    },
    {
      name: locale === 'zh' ? '钉钉' : 'DingTalk',
      platform: 'dingtalk' as const,
      boundThreadId: botConfig?.dingtalk.activeThreadId?.trim() ?? '',
    },
  ];
  const current = platforms.filter((platform) => activeThreadId && platform.boundThreadId === activeThreadId);
  const weixinHint = connected
    ? (locale === 'zh' ? '绑定到当前对话' : 'Bind to this chat')
    : (locale === 'zh' ? '扫码连接并绑定' : 'Scan to connect and bind');
  const dingtalkHint = dingtalkConfigured
    ? (locale === 'zh' ? '绑定到当前对话' : 'Bind to this chat')
    : (locale === 'zh' ? '先在设置中配置' : 'Configure in settings first');
  if (current.length > 0) {
    const names = current.map((platform) => platform.name).join(locale === 'zh' ? '、' : ', ');
    return {
      boundPlatforms: current.map((platform) => platform.platform),
      dingtalkHint,
      title: locale === 'zh' ? `${names}已绑定到当前对话` : `${names} bound to this chat`,
      tone: 'ok',
      weixinHint,
    };
  }
  const elsewhere = platforms.filter((platform) => platform.boundThreadId);
  if (elsewhere.length > 0) {
    return {
      boundPlatforms: [],
      dingtalkHint,
      title: locale === 'zh' ? '选择远程助手平台' : 'Select a remote assistant',
      tone: 'warn',
      weixinHint,
    };
  }
  return {
    boundPlatforms: [],
    dingtalkHint,
    title: locale === 'zh' ? '选择远程助手平台' : 'Select a remote assistant',
    tone: 'muted',
    weixinHint,
  };
}
