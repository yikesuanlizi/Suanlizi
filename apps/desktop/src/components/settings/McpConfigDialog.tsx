// MCP 编辑 dialog（add / edit MCP 配置）
import type React from 'react';
import type { Locale } from '../../config/config.js';
import type { McpConfig } from '../../shared/types.js';
import { t } from '../../shared/i18n.js';
import { Icon } from '../Icon.js';

export interface McpConfigDialogProps {
  locale: Locale;
  open: boolean;
  mcpDraft: McpConfig;
  editingMcpId: string;
  mcpCanSave: boolean;
  onClose: () => void;
  setMcpDraft: React.Dispatch<React.SetStateAction<McpConfig>>;
  onSave: () => void;
}

export function McpConfigDialog({
  locale,
  open,
  mcpDraft,
  editingMcpId,
  mcpCanSave,
  onClose,
  setMcpDraft,
  onSave,
}: McpConfigDialogProps) {
  if (!open) return null;
  const mcpPanelTitle = editingMcpId ? t(locale, 'editMcp') : t(locale, 'addMcp');
  const mcpDraftSourceUrl = mcpDraft.sourceKind === 'url' ? mcpDraft.sourceUrl?.trim() ?? '' : '';

  return (
    <div className="dialogLayer" role="presentation" onMouseDown={onClose}>
      <section
        className="appDialog pluginModalDialog mcpConfigDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-panel-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialogHeader">
          <div>
            <h2 id="mcp-panel-title">{mcpPanelTitle}</h2>
            <p className="dialogMessage">{mcpDraftSourceUrl
              ? (locale === 'zh' ? '已识别 MCP 来源 URL。请根据 README 或文档补全启动命令后再保存；Suanlizi 不会把 URL 直接当作命令执行。' : 'Detected an MCP source URL. Fill in the launch command from its README or docs before saving; Suanlizi will not execute a URL as a command.')
              : (locale === 'zh' ? '命令、参数和启用状态都会立即影响当前插件中心中的 MCP 配置。' : 'Command, args, and enabled state immediately affect the MCP configuration in Plugin Hub.')}
            </p>
          </div>
          <button className="iconButton" title={t(locale, 'cancel')} aria-label={t(locale, 'cancel')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="mcpPanelForm">
          {mcpDraftSourceUrl ? (
            <div className="mcpSourceNotice">
              <strong>{locale === 'zh' ? '来源 URL' : 'Source URL'}</strong>
              <span title={mcpDraftSourceUrl}>{mcpDraftSourceUrl}</span>
            </div>
          ) : null}
          <label className="pluginModalField">
            {t(locale, 'name')}
            <input value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.target.value })} />
          </label>
          <label className="pluginModalField">
            {t(locale, 'command')}
            <input value={mcpDraft.command} onChange={(event) => setMcpDraft({ ...mcpDraft, command: event.target.value })} />
          </label>
          <label className="pluginModalField">
            {t(locale, 'args')}
            <input value={mcpDraft.args} onChange={(event) => setMcpDraft({ ...mcpDraft, args: event.target.value })} />
          </label>
          <div className="pluginModalToggle">
            <div>
              <strong>{t(locale, 'enabled')}</strong>
              <span>{locale === 'zh' ? '关闭后将保留配置，但不会在运行中启用。' : 'Disabled MCPs keep their config but do not run.'}</span>
            </div>
            <button
              type="button"
              className={`pluginToggle ${mcpDraft.enabled ? 'on' : ''}`}
              aria-pressed={mcpDraft.enabled}
              aria-label={t(locale, 'enabled')}
              onClick={() => setMcpDraft({ ...mcpDraft, enabled: !mcpDraft.enabled })}
            />
          </div>
        </div>
        <div className="dialogActions">
          <button className="textButton" onClick={onClose}>{t(locale, 'cancel')}</button>
          <button
            className="solidButton"
            onClick={onSave}
            disabled={!mcpCanSave}
            title={!mcpCanSave && mcpDraftSourceUrl ? (locale === 'zh' ? '先填写可执行命令' : 'Fill in an executable command first') : undefined}
          >
            {t(locale, 'save')}
          </button>
        </div>
      </section>
    </div>
  );
}
