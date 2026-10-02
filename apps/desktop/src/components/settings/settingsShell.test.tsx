// P2.2 desktop 镜像测试：校验 desktop SettingsShell 与 web 关键路径一致
// 由于 desktop 与 web 共享同一份 SettingsShell 设计，这里只做关键路径守卫，
// 详细行为测试见 apps/web/src/components/settings/settingsShell.test.tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { SettingsShell, type SettingsSaveState } from './SettingsShell.js';

const here = dirname(fileURLToPath(import.meta.url));

function renderShell(overrides: {
  saveState?: Partial<SettingsSaveState>;
  visualThemeMode?: 'light' | 'dark';
} = {}): string {
  const baseSaveState: SettingsSaveState = {
    dirty: false,
    saving: false,
    error: null,
    savedToastAt: null,
    ...overrides.saveState,
  };
  return renderToStaticMarkup(React.createElement(SettingsShell, {
    locale: 'en',
    open: true,
    onClose: vi.fn(),
    settingsTabs: [{ id: 'agent', label: 'Model' }],
    activeSection: 'agent',
    setActiveSection: vi.fn(),
    saveState: baseSaveState,
    onSave: vi.fn(),
    onCancel: vi.fn(),
    pluginMode: false,
    visualThemeMode: overrides.visualThemeMode,
  }));
}

describe('desktop SettingsShell · P2.2 渲染与取消逻辑', () => {
  it('主设置 Shell 不再暴露作用域按钮', () => {
    const html = renderShell();
    expect(html).not.toContain('Global defaults');
    expect(html).not.toContain('Current thread');
    expect(html).not.toContain('New thread');
    expect(html).not.toContain('scopeButton');
    expect(html).not.toContain('role="radiogroup"');
  });

  it('saving=true 时 fieldset disabled', () => {
    const html = renderShell({
      saveState: { saving: true },
    });
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it('不再渲染 shell 底部保存/取消按钮', () => {
    const html = renderShell({ saveState: { dirty: false } });
    expect(html).not.toContain('settingsSaveActions');
    expect(html).not.toContain('settingsSaveBar');
  });

  it('dirty=true 时显示未保存改动提示', () => {
    const html = renderShell({ saveState: { dirty: true } });
    expect(html).toContain('You have unsaved changes');
  });

  it('error 非空时通过 aria-live 暴露错误，不显示底部重试块', () => {
    const html = renderShell({ saveState: { error: 'Network down', dirty: true } });
    expect(html).toContain('Failed to save');
    expect(html).toContain('Network down');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('settingsSaveStatusError');
  });

  it('savedToastAt 在 2 秒内时显示 Saved toast', () => {
    const htmlFresh = renderShell({ saveState: { savedToastAt: Date.now() } });
    expect(htmlFresh).toContain('settingsSaveToast');
    const htmlStale = renderShell({ saveState: { savedToastAt: Date.now() - 5000 } });
    expect(htmlStale).not.toContain('settingsSaveToast');
  });

  it('dark 视觉主题直接落在设置弹层自身，避免依赖外层 appShell 选择器', () => {
    const html = renderShell({ visualThemeMode: 'dark' });
    expect(html).toMatch(/class="settingsLayer theme-dark"/);
    expect(html).toMatch(/class="settingsDrawer theme-dark"/);
    expect(html).toContain('aria-label="Close settings"');
    expect(html).toContain('aria-current="page"');
  });
});

describe('desktop SettingsShell · P2.2 源码守卫', () => {
  it('Esc + dirty 不再触发 shell 级内部确认面板', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    expect(source).toContain("event.key !== 'Escape'");
    expect(source).not.toContain('ConfirmPanel');
    expect(source).not.toContain('discardConfirmOpen');
    expect(source).not.toContain('setDiscardConfirmOpen');
    expect(source).not.toContain('confirmDiscardChanges');
    expect(source).not.toContain('window.confirm');
    expect(source).not.toContain("t(locale, 'discardChanges')");
    expect(source).not.toContain('disabled={saveState.saving || !saveState.dirty}');
    expect(source).not.toContain('disabled={option.disabled || saveState.saving}');
    expect(source).not.toContain('role="radiogroup"');
    expect(source).toContain('Date.now() - saveState.savedToastAt < 2000');
  });

  it('handleCancel 在 dirty 时也直接走页面取消逻辑', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    expect(source).toMatch(/function handleCancel\(\) \{[\s\S]*?if \(saveState\.saving\) return;[\s\S]*?onCancel\(\);[\s\S]*?\}/);
    expect(source).not.toContain('if (saveState.dirty)');
    expect(source).not.toContain('setDiscardConfirmOpen');
    expect(source).not.toContain('confirmDiscardChanges');
  });
});

describe('desktop SettingsDrawer · P2.2 内部配置层切换清空 dirty', () => {
  it('scopeInfo.onChange 切换作用域时清空 dirtyFields / saveError / savedToastAt', () => {
    const source = readFileSync(join(here, '..', '..', 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    expect(source).toMatch(/onChange: \(next\) => \{[\s\S]*?setScopeState\(next\);[\s\S]*?setDirtyFields\(\{\}\);[\s\S]*?setSaveError\(null\);[\s\S]*?setSavedToastAt\(null\);[\s\S]*?\}/);
  });

  it('persistConfig 成功后清 dirtyFields 并设置 savedToastAt + 2 秒 setTimeout', () => {
    const source = readFileSync(join(here, '..', '..', 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    expect(source).toMatch(/setDirtyFields\(\{\}\);[\s\S]*?setSavedToastAt\(Date\.now\(\)\);/);
    expect(source).toContain('window.setTimeout(() => setSavedToastAt(null), 2000)');
  });
});

describe('desktop P2.2 i18n + CSS 主题色守卫', () => {
  it('desktop i18n 保留保存栏必要键，并移除外露作用域键', () => {
    const i18n = readFileSync(join(here, '..', '..', 'shared', 'i18n.ts'), 'utf-8');
    expect(i18n).not.toContain("scopeLabel:");
    expect(i18n).not.toContain("scopeGlobal:");
    expect(i18n).not.toContain("applyToScope:");
    expect(i18n).not.toContain('discardChanges');
    expect(i18n).toContain("saving: 'Saving…'");
    expect(i18n).toContain("saved: 'Saved'");
    expect(i18n).toContain("failedToSave: 'Failed to save'");
    expect(i18n).toContain("retry: 'Retry'");
    expect(i18n).toContain("hasUnsavedChanges: 'You have unsaved changes'");
  });

  it('desktop styles.css 使用保存状态主题色，并移除外露作用域样式', () => {
    const css = readFileSync(join(here, '..', '..', 'styles.css'), 'utf-8');
    expect(css).not.toContain('.settingsScopeBar');
    expect(css).not.toContain('.settingsScopeButtons');
    expect(css).not.toContain('.scopeButton');
    expect(css).toMatch(/\.settingsSaveToast\s*\{[^}]*#10b981[^}]*\}/);
    expect(css).toMatch(/\.settingsFieldset:disabled\s*\{[^}]*cursor:\s*wait[^}]*\}/);
  });
});

// P2.4 a11y：role=dialog/aria-modal、焦点进入/回收、Tab 焦点陷阱、aria-live、模型保存提示
describe('desktop SettingsShell · P2.4 a11y 对话框语义与焦点管理', () => {
  it('在 aside 上渲染 role="dialog" 和 aria-modal="true"', () => {
    const html = renderShell();
    // aside 元素必须带 role="dialog" 与 aria-modal="true"，使其被屏幕阅读器识别为模态对话框
    expect(html).toMatch(/<aside[^>]*role="dialog"[^>]*aria-modal="true"[^>]*>/);
    expect(html).toMatch(/<aside[^>]*aria-label="Settings"[^>]*>/);
  });

  it('打开时焦点进入抽屉：useEffect 记录触发元素并聚焦第一个可聚焦元素', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    // 记录触发元素
    expect(source).toContain('previousActiveElementRef.current = document.activeElement as HTMLElement | null');
    // 延迟一帧后聚焦第一个可聚焦元素
    expect(source).toContain('requestAnimationFrame(');
    // 选择器覆盖 button / href / input / select / textarea / tabindex，排除 disabled 与 tabindex=-1
    expect(source).toContain("'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])'");
    expect(source).toContain('firstFocusable.focus()');
    // 没有可聚焦元素时退回 drawer.focus()
    expect(source).toContain('drawer.focus()');
  });

  it('关闭后焦点回收到触发按钮', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    // cleanup 函数中调用 trigger.focus()
    expect(source).toMatch(/const trigger = previousActiveElementRef\.current;[\s\S]*?trigger\.focus\(\)/);
  });

  it('Tab 焦点陷阱：在抽屉内循环，Shift+Tab 反向循环', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    // handleKeyDown 处理 Tab
    expect(source).toMatch(/function handleKeyDown\(event: React\.KeyboardEvent<HTMLElement>\)[\s\S]*?if \(event\.key !== 'Tab'\) return/);
    // Shift+Tab：从第一个跳到最后一个
    expect(source).toMatch(/if \(event\.shiftKey\) \{[\s\S]*?if \(document\.activeElement === first\) \{[\s\S]*?last\.focus\(\)/);
    // Tab：从最后一个跳到第一个
    expect(source).toMatch(/\} else \{[\s\S]*?if \(document\.activeElement === last\) \{[\s\S]*?first\.focus\(\)/);
    // 抽屉绑定 onKeyDown
    expect(source).toContain('onKeyDown={handleKeyDown}');
    // 抽屉可被聚焦（tabIndex=-1）
    expect(source).toContain('tabIndex={-1}');
  });

  it('不再在主设置页暴露作用域 radiogroup', () => {
    const html = renderShell();
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain('aria-labelledby="settings-scope-label"');
  });

  it('aria-live 区域始终存在，并根据 saveState 切换内容', () => {
    // idle：aria-live 区域存在但为空
    const htmlIdle = renderShell({ saveState: { dirty: false } });
    expect(htmlIdle).toMatch(/<div[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*class="sr-only"[^>]*><\/div>|<div[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*class="sr-only"[^>]*>\s*<\/div>/);
    // saving：aria-live 包含「Saving…」
    const htmlSaving = renderShell({ saveState: { saving: true } });
    expect(htmlSaving).toMatch(/class="sr-only"[^>]*>Saving…</);
    // error：aria-live 包含「Failed to save: ...」
    const htmlError = renderShell({ saveState: { error: 'Network down', dirty: true } });
    expect(htmlError).toMatch(/class="sr-only"[^>]*>Failed to save: Network down</);
    // saved toast：aria-live 包含「Saved」
    const htmlSaved = renderShell({ saveState: { savedToastAt: Date.now() } });
    expect(htmlSaved).toMatch(/class="sr-only"[^>]*>Saved</);
  });

  it('sr-only CSS 类保留，解释型 modelSaveHint 横幅已移除', () => {
    const css = readFileSync(join(here, '..', '..', 'styles.css'), 'utf-8');
    // sr-only：视觉隐藏但读屏可读
    expect(css).toMatch(/\.sr-only\s*\{[^}]*position:\s*absolute[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)[^}]*\}/);
    expect(css).not.toContain('.modelSaveHint');
    expect(css).not.toContain('.settingsScopeDescription');
    // settingsDrawer outline:none 让 tabIndex=-1 兜底聚焦不显轮廓
    expect(css).toMatch(/\.settingsDrawer\s*\{[\s\S]*?outline:\s*none/);
  });
});

describe('desktop ModelsPage · P2.4 「保存为预设」与「应用设置」文案区分', () => {
  it('移除解释型横幅，只保留必要操作入口', () => {
    const source = readFileSync(join(here, 'ModelsPage.tsx'), 'utf-8');
    expect(source).not.toContain('modelSaveHint');
    expect(source).not.toContain('role="note"');
    expect(source).not.toContain('presetsHint');
    expect(source).not.toContain('scopeDescription');
  });

  it('按钮不带解释型 title', () => {
    const source = readFileSync(join(here, 'ModelsPage.tsx'), 'utf-8');
    expect(source).not.toContain('保存到预设列表，方便以后复用');
    expect(source).not.toContain('Save to preset list for reuse');
    expect(source).not.toContain('立即应用到当前作用域的 provider/model/baseUrl');
    expect(source).not.toContain('Apply provider/model/baseUrl to current scope immediately');
  });

  it('desktop i18n 也更新 saveModelPreset 文案', () => {
    const i18n = readFileSync(join(here, '..', '..', 'shared', 'i18n.ts'), 'utf-8');
    expect(i18n).toContain("saveModelPreset: '保存为预设'");
    expect(i18n).toContain("saveModelPreset: 'Save as preset'");
  });
});
