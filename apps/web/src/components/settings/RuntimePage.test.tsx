import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../config/defaults.js';
import { RuntimePage } from './RuntimePage.js';
import { MonitorPage } from './MonitorPage.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('runtime settings pages', () => {
  it('renders runtime limits separately from monitor controls', () => {
    const props = { locale: 'zh' as const, config: defaultConfig, setConfig: vi.fn(), markDirty: vi.fn(), dirtyFields: {}, onSave: vi.fn() };
    const runtime = renderToStaticMarkup(React.createElement(RuntimePage, props));
    const monitor = renderToStaticMarkup(React.createElement(MonitorPage, props));
    expect(runtime).toContain('全局活动任务');
    expect(runtime).toContain('子 Agent 最大深度');
    expect(monitor).toContain('监控面板显示');
    expect(monitor).toContain('性能阈值保护');
    expect(monitor).toContain('保存监控设置');
    expect(monitor).toContain('settingsToggleTrack on');
    expect(monitor).not.toContain('子 Agent 最大深度');
  });

  it('renders the compaction threshold as a percentage input', () => {
    const html = renderToStaticMarkup(React.createElement(RuntimePage, {
      locale: 'zh' as const, config: { ...defaultConfig, compactionThreshold: 0.8 },
      setConfig: vi.fn(), markDirty: vi.fn(), onSave: vi.fn(),
    }));
    expect(html).toContain('上下文压缩阈值');
    expect(html).toContain('value="80"');
  });

  it('no longer offers a 缓存优先 / 长运行 run-profile selector anywhere in the runtime surface', () => {
    const runtime = readFileSync(join(here, 'RuntimePage.tsx'), 'utf-8');
    const controller = readFileSync(join(here, '..', '..', 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    const dialogs = readFileSync(join(here, '..', 'Dialogs.tsx'), 'utf-8');
    for (const src of [runtime, controller, dialogs]) {
      expect(src).not.toContain('缓存优先');
      expect(src).not.toContain('长运行');
    }
  });

  it('persists runtime fields (incl. compaction threshold) instead of only saving model fields', () => {
    const controller = readFileSync(join(here, '..', '..', 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    // 保存动作必须真的覆盖运行参数键，否则压缩阈值等于设置白填。
    expect(controller).toContain('RUNTIME_SETTING_KEYS');
    expect(controller).toContain('handleSaveRuntimeSettings');
    expect(controller).toContain('saveGlobalDefaults(runtimePatch)');
    expect(controller).toContain('patchThreadConfigOverrides(activeThreadId, { compactionThreshold })');
  });
});
