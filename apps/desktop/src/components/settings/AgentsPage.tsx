// 设置面板：远程助手页（desktop 桌面端版本）
// 与 web 版差异：含 desktopCapabilities、桥接说明、退登按钮、weixinBridgeDiagnostics
// 钉钉/dws CLI 的 patch 直接调用 updateXxxConfig 完成「patch + 立即 save」
import type React from 'react';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import type { BotConfig, BotStatus } from '../../shared/types.js';
import type { DesktopCapabilities } from '../../api/desktopBridge.js';
import { t } from '../../shared/i18n.js';
import { Icon } from '../Icon.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';
import { SectionHeader } from './SectionHeader.js';

export interface AgentsPageProps {
  locale: Locale;
  botConfig: BotConfig | null;
  botStatus: BotStatus | null;
  botDraft: BotConfig;
  weixinNotice: string;
  dingtalkNotice: string;
  dingtalkTestConvId: string;
  setDingtalkTestConvId: (value: string) => void;
  dingtalkTestConvType: 'dm' | 'group';
  setDingtalkTestConvType: (value: 'dm' | 'group') => void;
  // desktop 特有：桥接能力描述
  desktopCapabilities: DesktopCapabilities | null;
  // desktop 钉钉状态
  dingtalkConfigured: boolean;
  dingtalkStatus: BotStatus['dingtalk'] | undefined;
  // patch 直接调用 updateXxxConfig 完成 patch+save 一体
  updateWeixinConfig: (patch: Partial<BotConfig['weixin']>) => Promise<void>;
  updateDingtalkConfig: (patch: Partial<BotConfig['dingtalk']>) => Promise<void>;
  updateDwsCliConfig: (patch: Partial<BotConfig['dwsCli']>) => Promise<void>;
  patchDingtalk: (patch: Partial<BotConfig['dingtalk']>) => void;
  patchDwsCli: (patch: Partial<BotConfig['dwsCli']>) => void;
  handleWeixinLogout: () => Promise<void>;
  handleStartDingtalk: () => Promise<void>;
  handleStopDingtalk: () => Promise<void>;
  handleTestDingtalk: () => Promise<void>;
  refreshBotStatus: () => Promise<void>;
}

function text(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

// 桌面桥接状态文案
export function desktopBridgeStatusLabel(capabilities: DesktopCapabilities | null, locale: Locale): string {
  if (capabilities?.weixinBridge.managedAvailable) return locale === 'zh' ? '可用' : 'Available';
  if (capabilities?.weixinBridge.reason === 'not_bundled') return locale === 'zh' ? '组件未打包' : 'Component not bundled';
  if (capabilities?.weixinBridge.reason === 'unsupported') return locale === 'zh' ? '仅桌面端可用' : 'Desktop only';
  return locale === 'zh' ? '未运行' : 'Not running';
}

// 桥接诊断片段：用于在退登按钮下方展示监听/轮询/消息计数等
export function weixinBridgeDiagnostics(status: BotStatus, locale: Locale): Array<{ label: string; tone?: 'bad' }> {
  const bridgeStatus = status.weixin?.bridgeStatus;
  const monitors = bridgeStatus?.monitors ?? [];
  const activeMonitor = monitors.find((monitor) => monitor.running) ?? monitors[0];
  if (!activeMonitor) {
    return [{
      label: locale === 'zh' ? '监听：未启动' : 'Monitor: not started',
      tone: bridgeStatus?.error ? 'bad' : undefined,
    }];
  }
  const runningLabel = activeMonitor.running
    ? (locale === 'zh' ? '监听中' : 'Monitoring')
    : (locale === 'zh' ? '未监听' : 'Stopped');
  const result = [
    { label: runningLabel, tone: activeMonitor.running ? undefined : 'bad' as const },
    { label: `${locale === 'zh' ? '轮询' : 'Polls'} ${activeMonitor.pollCount ?? 0}` },
    { label: `${locale === 'zh' ? '消息' : 'Messages'} ${activeMonitor.messageCount ?? 0}` },
    { label: `${locale === 'zh' ? '投递' : 'Webhooks'} ${activeMonitor.webhookCount ?? 0}` },
  ];
  if (activeMonitor.lastError) {
    result.push({
      label: `${locale === 'zh' ? '最后错误' : 'Last error'}: ${formatSuanliziErrorMessage(undefined, activeMonitor.lastError, locale)}`,
      tone: 'bad' as const,
    });
  }
  return result;
}

function MiniToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`settingsToggleTrack mini ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="settingsToggleThumb" />
    </label>
  );
}

export function AgentsPage({
  locale,
  botStatus,
  botDraft,
  weixinNotice,
  dingtalkNotice,
  dingtalkTestConvId,
  setDingtalkTestConvId,
  dingtalkTestConvType,
  setDingtalkTestConvType,
  desktopCapabilities,
  dingtalkConfigured,
  dingtalkStatus,
  updateWeixinConfig,
  updateDingtalkConfig,
  updateDwsCliConfig,
  patchDingtalk,
  patchDwsCli,
  handleWeixinLogout,
  handleStartDingtalk,
  handleStopDingtalk,
  handleTestDingtalk,
  refreshBotStatus,
}: AgentsPageProps) {
  const weixinOnline = botStatus?.weixin?.bridge === 'online';
  const weixinConnected = botStatus?.weixin?.connected;

  const dingtalkStreamRunning = dingtalkStatus?.streamRunning ?? false;

  return (
    <section className="settingsSection remoteBots" id="settings-remote">
      <SettingsPageHeader
        eyebrow={text(locale, '渠道', 'Channels')}
        title={text(locale, '远程助手', 'Remote bots')}
        actions={[
          {
            label: t(locale, 'refresh'),
            onClick: () => void refreshBotStatus(),
          },
        ]}
      />

      {/* 个人微信桥接 */}
      <div className="settingsSectionBlock">
        <SectionHeader
          title={text(locale, '个人微信桥接', 'Personal WeChat bridge')}
          chip={weixinConnected
            ? text(locale, '已登录 · 桥接在线', 'Signed in · Bridge online')
            : text(locale, '未登录 · 桥接未连接', 'Not signed in · Bridge offline')}
        />
        <div className="denseGrid">
          <div className="cluster">
            <div className="clusterHeader">
              <div>
                <h3>{text(locale, '连接与监听', 'Connection & listener')}</h3>
              </div>
              <MiniToggle
                checked={botDraft.weixin.enabled}
                onChange={(checked) => void updateWeixinConfig({ enabled: checked })}
              />
            </div>
            <div className="clusterBody">
              {!desktopCapabilities?.weixinBridge.managedAvailable ? (
                <p className="settingsNotice">
                  {locale === 'zh'
                    ? '当前桌面微信桥接没有运行。开发模式会随 desktop dev 启动；如果仍不可用，请检查终端里的 weixin-bridge 日志。'
                    : 'The desktop WeChat bridge is not running. In dev it starts with desktop dev; check weixin-bridge logs if it remains unavailable.'}
                </p>
              ) : null}

              <div className="settingsFormGrid">
                <label className="settingsField">
                  <span className="settingsFieldLabel">{text(locale, '账号', 'Account')}</span>
                  <div className="readonlyLine">
                    <strong>{botDraft.weixin.accountId || text(locale, '未登录', 'Not signed in')}</strong>
                    <span>{desktopBridgeStatusLabel(desktopCapabilities, locale)}</span>
                    {weixinConnected ? (
                      <button className="textButton danger" type="button" onClick={() => void handleWeixinLogout()}>
                        {text(locale, '退出登录', 'Log out')}
                      </button>
                    ) : null}
                  </div>
                </label>
                <label className="settingsField">
                  <span className="settingsFieldLabel">{text(locale, '关联对话', 'Linked thread')}</span>
                  <select
                    value={botDraft.weixin.activeThreadId}
                    onChange={(event) => void updateWeixinConfig({ activeThreadId: event.target.value })}
                  >
                    <option value="">{text(locale, '当前工作区 · 项目设计', 'Current workspace · project design')}</option>
                  </select>
                </label>
              </div>

              {botStatus?.weixin?.bridgeStatus ? (
                <div className="weixinBridgeDiagnostics">
                  {weixinBridgeDiagnostics(botStatus, locale).map((item) => (
                    <span className={item.tone === 'bad' ? 'bad' : undefined} key={item.label}>
                      {item.label}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="compactOption">
                <div>
                  <strong>{text(locale, '连接任意对话时同步微信历史消息', 'Sync prior WeChat messages when connecting any conversation')}</strong>
                </div>
                <MiniToggle
                  checked={botDraft.weixin.syncHistoryOnConnect}
                  onChange={(checked) => void updateWeixinConfig({ syncHistoryOnConnect: checked })}
                />
              </div>

              {weixinNotice || botStatus?.weixin?.error ? (
                <p className="settingsNotice">{weixinNotice || botStatus?.weixin?.error}</p>
              ) : null}
            </div>
          </div>

          <aside className="cluster">
            <div className="clusterHeader">
              <div>
                <h3>{text(locale, '运行状态', 'Runtime status')}</h3>
              </div>
            </div>
            <div className="clusterBody connectionDetail">
              <div>
                <span>{text(locale, '桥接服务', 'Bridge service')}</span>
                <span className={`settingsSectionHeaderChip ${weixinOnline ? 'ok' : ''}`}>
                  {weixinOnline ? text(locale, '在线', 'Online') : text(locale, '离线', 'Offline')}
                </span>
              </div>
              <div>
                <span>{text(locale, '桥接模式', 'Bridge mode')}</span>
                <code>{botDraft.weixin.bridgeMode}</code>
              </div>
              <div>
                <span>{text(locale, '活跃对话', 'Active thread')}</span>
                <code>{botDraft.weixin.activeThreadId || '-'}</code>
              </div>
              <div>
                <span>{text(locale, '自动监听', 'Auto monitor')}</span>
                <code>{botDraft.weixin.autoStartMonitor ? text(locale, '开启', 'On') : text(locale, '关闭', 'Off')}</code>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* 钉钉机器人 */}
      <div className="settingsSectionBlock">
        <SectionHeader
          title={text(locale, '钉钉机器人', 'DingTalk Bot')}
          chip={dingtalkStreamRunning
            ? text(locale, 'Stream 已连接', 'Stream connected')
            : dingtalkConfigured
              ? text(locale, '已配置未连接', 'Configured, not connected')
              : text(locale, '未配置', 'Not configured')}
        />
        <div className="remoteStack">
          <div className="cluster">
            <div className="clusterHeader">
              <div>
                <h3>{text(locale, '机器人连接', 'Bot connection')}</h3>
              </div>
              <MiniToggle
                checked={botDraft.dingtalk.enabled}
                onChange={(checked) => void updateDingtalkConfig({ enabled: checked })}
              />
            </div>
            <div className="clusterBody">
              <div className="settingsFormGrid three">
                <label className="settingsField">
                  <span className="settingsFieldLabel">{text(locale, '连接模式', 'Connection mode')}</span>
                  <select
                    value={botDraft.dingtalk.connectionMode}
                    onChange={(event) => patchDingtalk({ connectionMode: event.target.value as 'stream' | 'webhook' })}
                    onBlur={() => void updateDingtalkConfig({ connectionMode: botDraft.dingtalk.connectionMode })}
                    disabled={!botDraft.dingtalk.enabled}
                  >
                    <option value="stream">{text(locale, 'Stream Push（无需公网）', 'Stream Push (no public IP)')}</option>
                    <option value="webhook">{text(locale, 'Webhook（需公网回调）', 'Webhook (public callback)')}</option>
                  </select>
                </label>
                <label className="settingsField">
                  <span className="settingsFieldLabel">{text(locale, '机器人 Code（可选）', 'Robot Code (optional)')}</span>
                  <input
                    value={botDraft.dingtalk.robotCode}
                    onChange={(event) => patchDingtalk({ robotCode: event.target.value })}
                    onBlur={() => void updateDingtalkConfig({ robotCode: botDraft.dingtalk.robotCode })}
                    disabled={!botDraft.dingtalk.enabled}
                    placeholder="robotCode"
                  />
                </label>
                <label className="settingsField">
                  <span className="settingsFieldLabel">{text(locale, '默认对话 Thread', 'Default thread')}</span>
                  <input
                    value={botDraft.dingtalk.activeThreadId}
                    onChange={(event) => patchDingtalk({ activeThreadId: event.target.value })}
                    onBlur={() => void updateDingtalkConfig({ activeThreadId: botDraft.dingtalk.activeThreadId })}
                    disabled={!botDraft.dingtalk.enabled}
                    placeholder={text(locale, '留空则使用默认收件线程', 'Leave empty to use inbox thread')}
                  />
                </label>
                <label className="settingsField">
                  <span className="settingsFieldLabel">Client ID (AppKey)</span>
                  <input
                    value={botDraft.dingtalk.clientId}
                    onChange={(event) => patchDingtalk({ clientId: event.target.value })}
                    onBlur={() => void updateDingtalkConfig({ clientId: botDraft.dingtalk.clientId })}
                    disabled={!botDraft.dingtalk.enabled}
                    placeholder="dingxxxxxxxxxx"
                  />
                </label>
                <label className="settingsField">
                  <span className="settingsFieldLabel">Client Secret (AppSecret)</span>
                  <input
                    type="password"
                    value={botDraft.dingtalk.clientSecret}
                    onChange={(event) => patchDingtalk({ clientSecret: event.target.value })}
                    onBlur={() => void updateDingtalkConfig({ clientSecret: botDraft.dingtalk.clientSecret })}
                    disabled={!botDraft.dingtalk.enabled}
                    placeholder="••••••••"
                  />
                </label>
                <label className="settingsField">
                  <span className="settingsFieldLabel">{text(locale, 'Webhook 签名密钥', 'Webhook secret')}</span>
                  <input
                    type="password"
                    value={botDraft.dingtalk.webhookSecret}
                    onChange={(event) => patchDingtalk({ webhookSecret: event.target.value })}
                    onBlur={() => void updateDingtalkConfig({ webhookSecret: botDraft.dingtalk.webhookSecret })}
                    disabled={!botDraft.dingtalk.enabled}
                  />
                </label>
              </div>
              <div className="clusterActionRow">
                {dingtalkStreamRunning ? (
                  <button
                    className="settingsPageHeaderAction ghost"
                    type="button"
                    onClick={() => void handleStopDingtalk()}
                    disabled={!dingtalkConfigured || !botDraft.dingtalk.enabled}
                  >
                    {text(locale, '停止 Stream', 'Stop Stream')}
                  </button>
                ) : (
                  <button
                    className="settingsPageHeaderAction ghost"
                    type="button"
                    onClick={() => void handleStartDingtalk()}
                    disabled={!dingtalkConfigured || !botDraft.dingtalk.enabled}
                  >
                    {text(locale, '启动 Stream', 'Start Stream')}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="remoteColumns">
            <div className="cluster">
              <div className="clusterHeader">
                <div>
                  <h3>{text(locale, '群与白名单', 'Group & allowlist')}</h3>
                </div>
              </div>
              <div className="clusterBody">
                <div className="settingsFormGrid">
                  <label className="settingsField">
                    <span className="settingsFieldLabel">{text(locale, '目标群名称', 'Target group name')}</span>
                    <input
                      value={botDraft.dingtalk.targetGroupName}
                      onChange={(event) => patchDingtalk({ targetGroupName: event.target.value })}
                      onBlur={() => void updateDingtalkConfig({ targetGroupName: botDraft.dingtalk.targetGroupName })}
                      disabled={!botDraft.dingtalk.enabled}
                      placeholder={text(locale, '可选', 'Optional')}
                    />
                  </label>
                  <label className="settingsField">
                    <span className="settingsFieldLabel">{text(locale, '目标群会话 ID / openConversationId', 'Target group conversation ID / openConversationId')}</span>
                    <input
                      value={botDraft.dingtalk.targetGroupConversationId}
                      onChange={(event) => patchDingtalk({ targetGroupConversationId: event.target.value })}
                      onBlur={() => void updateDingtalkConfig({ targetGroupConversationId: botDraft.dingtalk.targetGroupConversationId })}
                      disabled={!botDraft.dingtalk.enabled}
                      placeholder="cidxxxx 或 openConversationId"
                    />
                  </label>
                  <label className="settingsField wide">
                    <span className="settingsFieldLabel">{text(locale, '白名单用户 staffId（逗号分隔，留空表示所有用户可访问）', 'Allowed staffIds (comma-separated; empty = open to all)')}</span>
                    <input
                      value={botDraft.dingtalk.allowedUsers.join(',')}
                      onChange={(event) => patchDingtalk({ allowedUsers: event.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                      onBlur={() => void updateDingtalkConfig({ allowedUsers: botDraft.dingtalk.allowedUsers })}
                      disabled={!botDraft.dingtalk.enabled}
                      placeholder="manager123,dev456"
                    />
                  </label>
                </div>
                {dingtalkStatus?.lastDetectedGroupConversationId ? (
                  <p className="helper">
                    <Icon name="question" />
                    <span>
                      {text(locale, '最近检测到群 ID：', 'Last detected group ID: ')}
                      {dingtalkStatus.lastDetectedGroupConversationId}
                    </span>
                  </p>
                ) : null}
              </div>
            </div>

            <div className="cluster">
              <div className="clusterHeader">
                <div>
                  <h3>{text(locale, '发送测试', 'Send test')}</h3>
                </div>
              </div>
              <div className="clusterBody">
                <div className="settingsFormGrid">
                  <label className="settingsField wide">
                    <span className="settingsFieldLabel">conversationId</span>
                    <input
                      value={dingtalkTestConvId}
                      onChange={(event) => setDingtalkTestConvId(event.target.value)}
                      placeholder={text(locale, '填写会话 ID', 'Fill in conversationId')}
                    />
                  </label>
                  <label className="settingsField">
                    <span className="settingsFieldLabel">{text(locale, '会话类型', 'Conversation type')}</span>
                    <select
                      value={dingtalkTestConvType}
                      onChange={(event) => setDingtalkTestConvType(event.target.value as 'dm' | 'group')}
                    >
                      <option value="dm">{text(locale, '单聊', 'DM')}</option>
                      <option value="group">{text(locale, '群聊', 'Group')}</option>
                    </select>
                  </label>
                  <label className="settingsField">
                    <span className="settingsFieldLabel">{text(locale, '服务启动时自动连接', 'Auto-connect on startup')}</span>
                    <div className="readonlyLine">
                      <MiniToggle
                        checked={botDraft.dingtalk.autoStart}
                        onChange={(checked) => void updateDingtalkConfig({ autoStart: checked })}
                      />
                      <span>{botDraft.dingtalk.autoStart ? text(locale, '已开启', 'On') : text(locale, '已关闭', 'Off')}</span>
                    </div>
                  </label>
                </div>
                <div className="clusterActionRow">
                  <button
                    className="settingsPageHeaderAction primary"
                    type="button"
                    onClick={() => void handleTestDingtalk()}
                    disabled={!dingtalkConfigured || !dingtalkTestConvId.trim()}
                  >
                    {text(locale, '发送测试消息', 'Send test')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {dingtalkNotice ? <p className="settingsNotice">{dingtalkNotice}</p> : null}
        </div>
      </div>

      {/* 钉钉 CLI 与其他平台 */}
      <div className="settingsSectionBlock">
        <SectionHeader title={text(locale, '钉钉 CLI 与其他平台', 'DingTalk CLI & other platforms')} />
        <div className="remoteColumns">
          <div className="cluster">
            <div className="clusterHeader">
              <div>
                <h3>{text(locale, '钉钉 CLI (dws)', 'DingTalk CLI (dws)')}</h3>
              </div>
              <MiniToggle
                checked={botDraft.dwsCli.enabled}
                onChange={(checked) => void updateDwsCliConfig({ enabled: checked })}
              />
            </div>
            <div className="clusterBody">
              <div className="settingsFormGrid">
                <label className="settingsField wide">
                  <span className="settingsFieldLabel">{text(locale, '二进制路径', 'Binary path')}</span>
                  <input
                    value={botDraft.dwsCli.binaryPath}
                    onChange={(event) => patchDwsCli({ binaryPath: event.target.value })}
                    onBlur={() => void updateDwsCliConfig({ binaryPath: botDraft.dwsCli.binaryPath })}
                    placeholder="/usr/local/bin/dws"
                  />
                </label>
                <label className="settingsField">
                  <span className="settingsFieldLabel">Client ID (AppKey)</span>
                  <input
                    value={botDraft.dwsCli.clientId}
                    onChange={(event) => patchDwsCli({ clientId: event.target.value })}
                    onBlur={() => void updateDwsCliConfig({ clientId: botDraft.dwsCli.clientId })}
                    placeholder="dingxxxxxxxxxx"
                  />
                </label>
                <label className="settingsField">
                  <span className="settingsFieldLabel">Client Secret (AppSecret)</span>
                  <input
                    type="password"
                    value={botDraft.dwsCli.clientSecret}
                    onChange={(event) => patchDwsCli({ clientSecret: event.target.value })}
                    onBlur={() => void updateDwsCliConfig({ clientSecret: botDraft.dwsCli.clientSecret })}
                    placeholder="••••••••"
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="cluster">
            <div className="clusterHeader">
              <div>
                <h3>{text(locale, '飞书与 QQ', 'Feishu & QQ')}</h3>
              </div>
            </div>
            <div className="clusterBody">
              <div className="compactOption">
                <div>
                  <strong>{text(locale, '飞书', 'Feishu')}</strong>
                </div>
                <span className="settingsSectionHeaderChip">{text(locale, '待接入', 'Pending')}</span>
              </div>
              <div className="compactOption">
                <div>
                  <strong>QQ</strong>
                </div>
                <span className="settingsSectionHeaderChip">{text(locale, '待接入', 'Pending')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
