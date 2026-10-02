// 设置面板：运行时参数。监控采样与 guard 见 MonitorPage。
import React from 'react';
import type { Locale, RunConfig } from '../../config/config.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';
import { SectionHeader } from './SectionHeader.js';

export interface RuntimePageProps {
  locale: Locale;
  config: RunConfig;
  setConfig: React.Dispatch<React.SetStateAction<RunConfig>>;
  markDirty: (field: string, dirty: boolean) => void;
  onSave?: () => void;
}

function text(locale: Locale, zh: string, en: string): string { return locale === 'zh' ? zh : en; }

export function RuntimePage({ locale, config, setConfig, markDirty, onSave }: RuntimePageProps) {
  function update<K extends keyof RunConfig>(field: K, value: RunConfig[K]) {
    setConfig((current) => ({ ...current, [field]: value }));
    markDirty(String(field), true);
  }

  return (
    <section className="settingsSection" id="settings-runtime">
      <SettingsPageHeader
        eyebrow={text(locale, '运行时', 'Runtime')}
        title={text(locale, '运行参数', 'Runtime')}
        description={text(locale, '限制新任务、工具并发和子 Agent 深度。', 'Limits for task slots, readonly tools and subagent depth.')}
        actions={[{ label: text(locale, '保存运行参数', 'Save runtime'), primary: true, onClick: () => onSave?.() }]}
      />
      <div className="settingsSectionBlock">
        <SectionHeader title={text(locale, '任务与 Agent', 'Tasks and agents')} />
        <div className="settingsFormGrid three">
          <label className="settingsField">
            <span className="settingsFieldLabel">{text(locale, '每回合循环上限', 'Max iterations')}</span>
            <input type="number" min={1} max={1000} value={config.maxIterations} onChange={(e) => update('maxIterations', Number(e.target.value))} />
          </label>
          <label className="settingsField">
            <span className="settingsFieldLabel">{text(locale, '全局活动任务', 'Active top-level tasks')}</span>
            <input type="number" min={1} max={64} value={config.maxActiveTasks} onChange={(e) => update('maxActiveTasks', Number(e.target.value))} />
          </label>
          <label className="settingsField">
            <span className="settingsFieldLabel">{text(locale, '只读工具并发', 'Readonly tools per step')}</span>
            <input type="number" min={1} max={16} value={config.maxParallelReadonlyTools} onChange={(e) => update('maxParallelReadonlyTools', Number(e.target.value))} />
          </label>
          <label className="settingsField">
            <span className="settingsFieldLabel">{text(locale, '子 Agent 最大深度', 'Max subagent depth')}</span>
            <input type="number" min={1} max={2} value={config.maxSubagentDepth} onChange={(e) => update('maxSubagentDepth', Number(e.target.value))} />
            <small>{text(locale, '服务端硬上限为 2；同一线程仍保持串行。', 'Server hard cap is 2; each thread remains serial.')}</small>
          </label>
          <label className="settingsField">
            <span className="settingsFieldLabel">{text(locale, '单次工具超时', 'Tool timeout')}</span>
            <div className="settingsInputWithSuffix"><input type="number" min={10} max={600} value={config.toolTimeoutSeconds} onChange={(e) => update('toolTimeoutSeconds', Number(e.target.value))} /><span className="settingsInputSuffix">s</span></div>
          </label>
          <label className="settingsField">
            <span className="settingsFieldLabel">{text(locale, '模型响应超时', 'Model response timeout')}</span>
            <div className="settingsInputWithSuffix"><input type="number" min={10} max={3600} value={config.modelTimeoutSeconds} onChange={(e) => update('modelTimeoutSeconds', Number(e.target.value))} /><span className="settingsInputSuffix">s</span></div>
          </label>
          <label className="settingsField">
            <span className="settingsFieldLabel">{text(locale, '上下文压缩阈值', 'Compaction threshold')}</span>
            <div className="settingsInputWithSuffix">
              <input
                type="number"
                min={30}
                max={95}
                step={1}
                value={Math.round((config.compactionThreshold ?? 0.8) * 100)}
                onChange={(e) => {
                  const pct = Number(e.target.value);
                  const ratio = Number.isFinite(pct) ? Math.min(0.95, Math.max(0.3, pct / 100)) : 0.8;
                  update('compactionThreshold', ratio);
                }}
              />
              <span className="settingsInputSuffix">%</span>
            </div>
            <small>{text(locale, '占模型上下文窗口的比例，达到即压缩。', 'Share of the model context window; compaction triggers at this level.')}</small>
          </label>
        </div>
      </div>
    </section>
  );
}
