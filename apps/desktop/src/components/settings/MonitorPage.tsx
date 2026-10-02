// 设置面板：监控策略。运行时参数位于 RuntimePage。
import React from 'react';
import type { Locale, RunConfig } from '../../config/config.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';
import { SectionHeader } from './SectionHeader.js';

export interface MonitorPageProps {
  locale: Locale;
  config: RunConfig;
  setConfig: React.Dispatch<React.SetStateAction<RunConfig>>;
  markDirty: (field: string, dirty: boolean) => void;
  // P2.2 dirty 跟踪
  dirtyFields: Record<string, boolean>;
  onSave?: (patch?: MonitorSettingsPatch) => void | Promise<void>;
}

export type MonitorSettingsPatch = Partial<Pick<RunConfig,
  'monitorPanelVisible'
  | 'systemMonitorSamplingEnabled'
  | 'systemMonitorLogRecordingEnabled'
  | 'systemMonitorGuardEnabled'
  | 'systemMonitorThresholds'>>;

function text(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

function ToggleRow({
  checked,
  disabled,
  onChange,
  label,
  help,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  help: string;
}) {
  return (
    <label className={`settingsToggleRow ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <div className="settingsToggleContent">
        <strong>{label}</strong>
        <span className="settingsHelpBadge" title={help} aria-label={help} onClick={(event) => event.preventDefault()}>?</span>
      </div>
      <span className={`settingsToggleTrack${checked ? ' on' : ''}`} aria-hidden="true">
        <span className="settingsToggleThumb" />
      </span>
    </label>
  );
}

const thresholdLabels = {
  cpuLight: ['CPU 提醒', 'CPU notice'],
  cpuModerate: ['CPU 限制', 'CPU limit'],
  cpuSevere: ['CPU 严重', 'CPU severe'],
  memLight: ['内存提醒', 'Memory notice'],
  memModerate: ['内存限制', 'Memory limit'],
  memSevere: ['内存严重', 'Memory severe'],
} as const;

export function MonitorPage({ locale, config, setConfig, markDirty, onSave }: MonitorPageProps) {
  function updateField<K extends keyof RunConfig>(field: K, value: RunConfig[K]) {
    setConfig((current) => ({ ...current, [field]: value }));
    markDirty(field as string, true);
    if (field === 'monitorPanelVisible'
      || field === 'systemMonitorSamplingEnabled'
      || field === 'systemMonitorLogRecordingEnabled'
      || field === 'systemMonitorGuardEnabled') {
      void onSave?.({ [field]: value } as MonitorSettingsPatch);
    }
  }

  return (
    <section className="settingsSection" id="settings-monitor">
      <SettingsPageHeader
        eyebrow={text(locale, '运行时', 'Runtime')}
        title={text(locale, '监控', 'Monitor')}
      />

      <div className="settingsSectionBlock">
        <SectionHeader title={text(locale, '监控策略', 'Monitoring policy')} help={text(locale, '控制监控入口与后台采样行为。', 'Controls the monitor entry and background sampling.')} />
        <div className="settingsToggleList">
          <ToggleRow
            checked={config.monitorPanelVisible !== false}
            onChange={(checked) => updateField('monitorPanelVisible', checked)}
            label={text(locale, '监控面板显示', 'Monitor panel')}
            help={text(locale, '显示或隐藏顶部监控入口。', 'Show or hide the monitor entry.')}
          />
          <ToggleRow
            checked={config.systemMonitorSamplingEnabled === true}
            onChange={(checked) => updateField('systemMonitorSamplingEnabled', checked)}
            label={text(locale, '系统性能采样', 'System performance sampling')}
            help={text(locale, '在后台定时读取 CPU、内存和磁盘状态。', 'Periodically reads CPU, memory, and disk usage in the runtime.')}
          />
          <ToggleRow
            checked={config.systemMonitorLogRecordingEnabled === true}
            onChange={(checked) => updateField('systemMonitorLogRecordingEnabled', checked)}
            label={text(locale, '运行日志记录', 'Runtime log recording')}
            help={text(locale, '记录系统监控通知；普通运行轨迹始终单独记录。', 'Records system monitor notices; normal run traces are recorded separately.')}
          />
          <ToggleRow
            checked={config.systemMonitorGuardEnabled === true}
            disabled={!config.systemMonitorSamplingEnabled}
            onChange={(checked) => updateField('systemMonitorGuardEnabled', checked)}
            label={text(locale, '性能阈值保护', 'Performance threshold guard')}
            help={text(locale, '超过阈值时降低并发或限制高风险操作。', 'Reduces concurrency or restricts risky actions above thresholds.')}
          />
        </div>
      </div>

      <div className="settingsSectionBlock">
        <SectionHeader title={text(locale, '阈值', 'Thresholds')} help={text(locale, '仅在性能阈值保护开启时生效。', 'Used only when threshold protection is enabled.')} />
        <div className="settingsFormGrid three">
          {(['cpuLight', 'cpuModerate', 'cpuSevere', 'memLight', 'memModerate', 'memSevere'] as const).map((field) => (
            <label className="settingsField" key={field}>
              <span className="settingsFieldLabel">{text(locale, thresholdLabels[field][0], thresholdLabels[field][1])}</span>
              <div className="settingsInputWithSuffix"><input type="number" min={1} max={100} value={config.systemMonitorThresholds[field]} onChange={(e) => updateField('systemMonitorThresholds', { ...config.systemMonitorThresholds, [field]: Number(e.target.value) })} /><span className="settingsInputSuffix">%</span></div>
            </label>
          ))}
        </div>
        <div className="settingsThresholdActions"><button type="button" className="solidButton settingsThresholdSave" onClick={() => onSave?.()}>{text(locale, '保存监控设置', 'Save monitor settings')}</button></div>
      </div>
    </section>
  );
}
