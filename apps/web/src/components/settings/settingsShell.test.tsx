import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SettingsShell, type SettingsSaveState } from './SettingsShell.js';
import { AccessPolicyPage } from './AccessPolicyPage.js';
import type { AccessPolicyConfig } from '@suanlizi/protocol';

const here = dirname(fileURLToPath(import.meta.url));

// 渲染 SettingsShell 的辅助函数：所有可选 prop 都有默认值，便于测试只覆盖关心的字段
function renderShell(overrides: {
  saveState?: Partial<SettingsSaveState>;
  settingsTabs?: Array<{ id: string; label: string }>;
  activeSection?: string;
  pluginMode?: boolean;
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
    settingsTabs: overrides.settingsTabs ?? [
      { id: 'agent', label: 'Model' },
      { id: 'appearance', label: 'Appearance' },
    ],
    activeSection: overrides.activeSection ?? 'agent',
    setActiveSection: vi.fn(),
    saveState: baseSaveState,
    onSave: vi.fn(),
    onCancel: vi.fn(),
    pluginMode: overrides.pluginMode ?? false,
    visualThemeMode: overrides.visualThemeMode,
  }));
}

describe('SettingsShell · scope UI removal', () => {
  it('does not expose global/current/new thread scope controls in the main settings shell', () => {
    const html = renderShell();
    expect(html).not.toContain('Global defaults');
    expect(html).not.toContain('Current thread');
    expect(html).not.toContain('New thread');
    expect(html).not.toContain('scopeButton');
    expect(html).not.toContain('role="radiogroup"');
  });
});

describe('SettingsShell · visual theme ownership', () => {
  it('places the resolved dark theme on the overlay and drawer instead of relying on the app shell', () => {
    const html = renderShell({ visualThemeMode: 'dark' });
    expect(html).toMatch(/class="settingsLayer theme-dark"/);
    expect(html).toMatch(/class="settingsDrawer theme-dark"/);
    expect(html).toContain('aria-label="Close settings"');
    expect(html).toContain('aria-current="page"');
  });

  it('keeps both shell variants on semantic surfaces instead of hard-coded white controls', () => {
    const webCss = readFileSync(join(here, '..', '..', 'styles.css'), 'utf-8');
    const desktopCss = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'styles.css'), 'utf-8');

    for (const css of [webCss, desktopCss]) {
      const contract = css.slice(css.lastIndexOf('/* Suanlizi settings shell surface contract */'));
      expect(contract).toContain('.settingsLayer.theme-dark');
      expect(contract).toContain('.settingsLayer.theme-light');
      expect(contract).toContain('var(--nx-settings-raised) !important');
      expect(contract).toContain('var(--nx-settings-control) !important');
    }
  });
});

describe('SettingsShell · P2.2 saving state', () => {
  it('disables the settings fieldset while saving', () => {
    const html = renderShell({
      saveState: { saving: true },
    });
    expect(html).toContain('fieldset');
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it('shows the saving indicator instead of save button label while saving', () => {
    const html = renderShell({ saveState: { saving: true } });
    expect(html).toContain('Saving');
  });

  it('does not render shell-level save/cancel buttons', () => {
    const html = renderShell({ saveState: { dirty: false } });
    expect(html).not.toContain('settingsSaveActions');
    expect(html).not.toContain('settingsSaveBar');
  });
});

describe('AccessPolicyPage · persistent policy UI', () => {
  const value: AccessPolicyConfig = {
    mode: 'workspace',
    workspaceRoot: 'E:\\langchain\\Suanlizi',
    persistentRules: [
      {
        id: 'allow-docs',
        effect: 'allow',
        access: 'read',
        target: { kind: 'path', path: 'E:\\langchain\\dexin-agent' },
        scope: 'global',
      },
    ],
    temporaryGrants: [
      {
        id: 'temp-hidden',
        effect: 'allow',
        access: 'read',
        target: { kind: 'path', path: 'E:\\secret' },
        scope: 'session',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ],
  };

  it('renders persistent rules and hides runtime temporary grants', () => {
    const html = renderToStaticMarkup(React.createElement(AccessPolicyPage, {
      locale: 'zh',
      value,
      scope: 'global',
      currentThreadAvailable: true,
      saving: false,
      notice: '',
      onScopeChange: vi.fn(),
      onChange: vi.fn(),
      onSave: vi.fn(),
      onReload: vi.fn(),
    }));

    expect(html).toContain('权限');
    expect(html).toContain('持久规则');
    expect(html).toContain('allow-docs');
    expect(html).toContain('E:\\langchain\\dexin-agent');
    expect(html).not.toContain('temp-hidden');
    expect(html).not.toContain('E:\\secret');
  });

  it('renders compact global, workspace, and thread scopes', () => {
    const html = renderToStaticMarkup(React.createElement(AccessPolicyPage, {
      locale: 'zh',
      value,
      scope: 'workspace',
      currentWorkspaceAvailable: true,
      currentWorkspaceRoot: value.workspaceRoot,
      workspaceRoots: [value.workspaceRoot, 'D:\\teacher-rag'],
      selectedWorkspaceRoot: value.workspaceRoot,
      currentThreadAvailable: true,
      currentThreadId: 'thread-1',
      saving: false,
      notice: '',
      onScopeChange: vi.fn(),
      onWorkspaceChange: vi.fn(),
      onChange: vi.fn(),
      onSave: vi.fn(),
      onReload: vi.fn(),
    }));
    expect(html).toContain('当前工作区');
    expect(html).toContain('当前线程');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('accessWorkspaceList');
    expect(html).toContain('D:\\teacher-rag');
    expect(html).toContain('class="accessModeValue"');
    expect(html).not.toContain('<select value="workspace"');
    expect(html).not.toContain('当前工作区目录');
  });

  it('keeps the page wired in web and desktop drawers', () => {
    const webDrawer = readFileSync(join(here, '..', 'SettingsDrawer.tsx'), 'utf-8');
    const desktopDrawer = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'components', 'SettingsDrawer.tsx'), 'utf-8');

    expect(webDrawer).toContain("id: 'accessPolicy'");
    expect(webDrawer).toContain('<AccessPolicyPage');
    expect(desktopDrawer).toContain("id: 'accessPolicy'");
    expect(desktopDrawer).toContain('<AccessPolicyPage');
  });
});

describe('SettingsShell · P2.2 dirty / error / saved toast', () => {
  it('shows the "unsaved changes" hint when dirty=true', () => {
    const html = renderShell({ saveState: { dirty: true } });
    expect(html).toContain('You have unsaved changes');
  });

  it('announces errors through aria-live without rendering a footer retry block', () => {
    const html = renderShell({ saveState: { error: 'Network down', dirty: true } });
    expect(html).toContain('Failed to save');
    expect(html).toContain('Network down');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('settingsSaveStatusError');
  });

  it('renders the "Saved" toast only when savedToastAt is within 2 seconds', () => {
    // 时间戳为「现在」，应当显示 toast
    const htmlFresh = renderShell({ saveState: { savedToastAt: Date.now() } });
    expect(htmlFresh).toContain('Saved');
    // 时间戳为 5 秒前，应当不显示 toast
    const htmlStale = renderShell({ saveState: { savedToastAt: Date.now() - 5000 } });
    // 注意：renderToStaticMarkup 不会触发 setTimeout，所以 savedToastAt 仍可能被读为「过期」
    // 但 SettingsShell 的判断逻辑是 Date.now() - savedToastAt < 2000，5 秒前的会判定为 false
    expect(htmlStale).not.toContain('settingsSaveToast');
  });
});

describe('SettingsShell · source code guards (P2.2 关键路径守卫)', () => {
  // 这些守卫字符串保证 P2.2 关键交互路径没有被无意移除
  it('listens for Escape and does not show the removed shell-level discard confirm', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    // 实现使用「不等于则跳过」的早返回模式，效果等价于「等于则进入处理」
    expect(source).toContain("event.key !== 'Escape'");
    // Shell 级 dirty 确认已废除；需要确认的动作留在具体页面内处理，例如删除预设
    expect(source).not.toContain('ConfirmPanel');
    expect(source).not.toContain('discardConfirmOpen');
    expect(source).not.toContain('setDiscardConfirmOpen');
    expect(source).not.toContain('confirmDiscardChanges');
    expect(source).not.toContain('window.confirm');
    expect(source).not.toContain("t(locale, 'discardChanges')");
  });

  it('keeps dirty + saving + error + toast state contract without exposing scope controls', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    expect(source).toContain('export type SettingsScope');
    expect(source).toContain('export interface SettingsScopeInfo');
    expect(source).toContain('export interface SettingsSaveState');
    expect(source).not.toContain('const scopeButtons');
    expect(source).not.toContain('settingsScopeButtons');
    // 保存状态四态：dirty / saving / error / savedToastAt
    expect(source).toContain('saveState.dirty');
    expect(source).toContain('saveState.saving');
    expect(source).toContain('saveState.error');
    expect(source).toContain('saveState.savedToastAt');
    // toast 2 秒自动消失
    expect(source).toContain('Date.now() - saveState.savedToastAt < 2000');
  });

  it('renders fieldset and toast without footer save bar or shell-level discard confirm', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    expect(source).not.toContain('settingsScopeBar');
    expect(source).not.toContain('settingsScopeButtons');
    expect(source).not.toContain('scopeButton');
    expect(source).not.toContain('settingsScopeSource');
    expect(source).toContain('settingsFieldset');
    expect(source).not.toContain('ConfirmPanel');
    expect(source).not.toContain('settingsSaveBar');
    expect(source).not.toContain('settingsSaveStatus');
    expect(source).not.toContain('settingsSaveActions');
    expect(source).toContain('settingsSaveToast');
  });
});

describe('SettingsShell · P2.2 行为：Esc / 取消 / 保存', () => {
  it('Esc 处理器在 saving 期间早返回，不会触发 onClose', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    // onKey 内必须先判 saveState.saving 早返回，避免保存中被 Esc 打断
    expect(source).toMatch(/function onKey[\s\S]*?if \(event\.key !== 'Escape'\) return;[\s\S]*?if \(saveState\.saving\) return;/);
  });

  it('handleCancel 在 dirty 时也直接走页面取消逻辑，不再弹 shell 确认', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    // handleCancel 只保留 saving 早返回；具体页面自己决定如何保存/取消
    expect(source).toMatch(/function handleCancel\(\) \{[\s\S]*?if \(saveState\.saving\) return;[\s\S]*?onCancel\(\);[\s\S]*?\}/);
    expect(source).not.toContain('if (saveState.dirty)');
    expect(source).not.toContain('setDiscardConfirmOpen');
    expect(source).not.toContain('confirmDiscardChanges');
    expect(source).not.toContain('window.confirm');
  });

  it('遮罩、关闭按钮、Esc 都走 handleCancel，避免绕过页面级取消逻辑', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    expect(source).toContain('onClick={handleCancel} type="button"');
    expect(source).not.toContain('className="scrim" aria-label={t(locale, \'cancel\')} onClick={onClose}');
    expect(source).not.toContain('aria-label={t(locale, \'cancel\')} onClick={onClose} type="button"');
    expect(source).toMatch(/function onKey\(event: KeyboardEvent\) \{[\s\S]*?if \(event\.key !== 'Escape'\) return;[\s\S]*?handleCancel\(\);/);
  });

  it('shell 不再渲染底部保存按钮，保存入口留给各设置页', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    expect(source).not.toContain('settingsSaveActions');
    expect(source).not.toContain('disabled={saveState.saving || !saveState.dirty}');
  });

  it('设置主界面不再暴露作用域按钮，避免让普通设置流程理解内部作用域', () => {
    const source = readFileSync(join(here, 'SettingsShell.tsx'), 'utf-8');
    expect(source).not.toContain('disabled={option.disabled || saveState.saving}');
    expect(source).not.toContain('role="radiogroup"');
  });
});

describe('SettingsDrawer · P2.2 作用域切换清空 dirty 状态', () => {
  it('scopeInfo.onChange 切换作用域时清空 dirtyFields / saveError / savedToastAt', () => {
    const source = readFileSync(join(here, '..', '..', 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    // onChange 回调必须包含三处状态清理：dirtyFields、saveError、savedToastAt
    expect(source).toMatch(/const setScope = useCallback\(\(next: SettingsScope\) => \{[\s\S]*?setScopeState\(next\);[\s\S]*?setDirtyFields\(\{\}\);[\s\S]*?setSaveError\(null\);[\s\S]*?setSavedToastAt\(null\);[\s\S]*?\}/);
  });

  it('persistConfig 在成功后清空 dirtyFields 并设置 savedToastAt', () => {
    const source = readFileSync(join(here, '..', '..', 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    // 成功路径必须 setDirtyFields({}) + setSavedToastAt(Date.now())
    expect(source).toMatch(/setDirtyFields\(\{\}\);[\s\S]*?setSavedToastAt\(Date\.now\(\)\);/);
    // 2 秒后自动清掉 toast 标记
    expect(source).toContain('setTimeout(() => setSavedToastAt(null), 2000)');
  });

  it('persistConfig 失败时设置 saveError 但保留 dirtyFields', () => {
    const source = readFileSync(join(here, '..', '..', 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    // catch 分支把本地化后的错误同时写入 saveError 与模型卡片提示，且不清 dirtyFields（让用户能重试）。
    const catchBlock = source.slice(source.indexOf('    } catch (error) {', source.indexOf('handleSetCurrentModelConfig')));
    const body = catchBlock.slice(0, catchBlock.indexOf('} finally'));
    expect(body).toContain('formatSuanliziErrorMessage(');
    expect(body).toContain('setSaveError(message);');
    expect(body).toContain('setModelKeyNotice(message);');
  });

});

describe('SettingsShell · P2.2 desktop 镜像守卫', () => {
  it('desktop SettingsShell 与 web 保持一致的关键路径', () => {
    const desktopShell = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'components', 'settings', 'SettingsShell.tsx'), 'utf-8');
    // 关键路径：Esc 早返回、无 shell 级 dirty confirm、保存按钮 disabled 条件；scope UI 不再暴露在主设置页
    expect(desktopShell).toContain("event.key !== 'Escape'");
    expect(desktopShell).not.toContain('ConfirmPanel');
    expect(desktopShell).not.toContain('discardConfirmOpen');
    expect(desktopShell).not.toContain('setDiscardConfirmOpen');
    expect(desktopShell).not.toContain('confirmDiscardChanges');
    expect(desktopShell).not.toContain('window.confirm');
    expect(desktopShell).not.toContain('disabled={saveState.saving || !saveState.dirty}');
    expect(desktopShell).not.toContain('disabled={option.disabled || saveState.saving}');
    expect(desktopShell).not.toContain('role="radiogroup"');
    expect(desktopShell).toContain('Date.now() - saveState.savedToastAt < 2000');
  });

  it('desktop i18n 保留保存栏必要键，并移除外露作用域键', () => {
    const desktopI18n = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'shared', 'i18n.ts'), 'utf-8');
    expect(desktopI18n).not.toContain("scopeLabel:");
    expect(desktopI18n).not.toContain("scopeGlobal:");
    expect(desktopI18n).not.toContain("applyToScope:");
    expect(desktopI18n).not.toContain('discardChanges');
    expect(desktopI18n).toContain("saving: 'Saving…'");
    expect(desktopI18n).toContain("saved: 'Saved'");
    expect(desktopI18n).toContain("failedToSave: 'Failed to save'");
    expect(desktopI18n).toContain("retry: 'Retry'");
    expect(desktopI18n).toContain("hasUnsavedChanges: 'You have unsaved changes'");
  });

  it('desktop SettingsDrawer 同样在作用域切换时清空 dirty', () => {
    const desktopController = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    expect(desktopController).toMatch(/onChange: \(next\) => \{[\s\S]*?setScopeState\(next\);[\s\S]*?setDirtyFields\(\{\}\);[\s\S]*?setSaveError\(null\);[\s\S]*?setSavedToastAt\(null\);[\s\S]*?\}/);
  });
});

describe('SettingsShell · P2.2 CSS 主题色守卫', () => {
  it('web styles.css 使用保存状态主题色，并移除外露作用域样式', () => {
    const css = readFileSync(join(here, '..', '..', 'styles.css'), 'utf-8');
    expect(css).not.toContain('.settingsScopeBar');
    expect(css).not.toContain('.settingsScopeButtons');
    expect(css).not.toContain('.scopeButton');
    // 保存成功 toast 用 #10b981 + 白字
    expect(css).toMatch(/\.settingsSaveToast\s*\{[^}]*#10b981[^}]*\}/);
    // fieldset disabled 加 cursor: wait（saving 状态）
    expect(css).toMatch(/\.settingsFieldset:disabled\s*\{[^}]*cursor:\s*wait[^}]*\}/);
    // dirty 字段高亮用 amber-500
    expect(css).toMatch(/\.fieldDirty[\s\S]*?border-amber-500/);
    expect(css).not.toContain('.fieldDirty,\n  label.fieldDirty');
    expect(css).toContain('.dropdownSelect.fieldDirty > .dropdownButton');
  });

  it('desktop styles.css 同步主题色', () => {
    const css = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'styles.css'), 'utf-8');
    expect(css).not.toContain('.settingsScopeBar');
    expect(css).not.toContain('.settingsScopeButtons');
    expect(css).not.toContain('.scopeButton');
    expect(css).toMatch(/\.settingsSaveToast\s*\{[^}]*#10b981[^}]*\}/);
    expect(css).toMatch(/\.settingsFieldset:disabled\s*\{[^}]*cursor:\s*wait[^}]*\}/);
    expect(css).not.toContain('.fieldDirty,\n  label.fieldDirty');
    expect(css).toContain('.dropdownSelect.fieldDirty > .dropdownButton');
  });
});

describe('i18n · P2.2 双语 key 守卫', () => {
  const i18n = readFileSync(join(here, '..', '..', 'shared', 'i18n.ts'), 'utf-8');
  it('contains zh keys for save bar and toast, without exposing scope wording', () => {
    expect(i18n).not.toContain('scopeLabel');
    expect(i18n).not.toContain('scopeGlobal');
    expect(i18n).not.toContain('scopeCurrentThread');
    expect(i18n).not.toContain('scopeNewThread');
    expect(i18n).not.toContain('scopeSource');
    expect(i18n).not.toContain('applyToScope');
    expect(i18n).not.toContain('discardChanges');
    expect(i18n).toContain("saving: '保存中…'");
    expect(i18n).toContain("saved: '已保存'");
    expect(i18n).toContain("failedToSave: '保存失败'");
    expect(i18n).toContain("retry: '重试'");
    expect(i18n).toContain("hasUnsavedChanges: '有未保存的改动'");
  });

  it('contains en keys for save bar and toast, without exposing scope wording', () => {
    expect(i18n).not.toContain('scopeLabel');
    expect(i18n).not.toContain('scopeGlobal');
    expect(i18n).not.toContain('scopeCurrentThread');
    expect(i18n).not.toContain('scopeNewThread');
    expect(i18n).not.toContain('Source: /api/config/defaults');
    expect(i18n).not.toContain('applyToScope');
    expect(i18n).not.toContain('discardChanges');
    expect(i18n).toContain("saving: 'Saving…'");
    expect(i18n).toContain("saved: 'Saved'");
    expect(i18n).toContain("failedToSave: 'Failed to save'");
    expect(i18n).toContain("retry: 'Retry'");
    expect(i18n).toContain("hasUnsavedChanges: 'You have unsaved changes'");
  });
});

// P2.4 a11y：role=dialog/aria-modal、焦点进入/回收、Tab 焦点陷阱、aria-live、模型保存提示
describe('SettingsShell · P2.4 a11y 对话框语义与焦点管理', () => {
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

describe('ModelsPage · P2.4 「保存为预设」与「应用设置」文案区分', () => {
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
});

describe('SettingsShell · P2.4 desktop 镜像 a11y 守卫', () => {
  it('desktop SettingsShell 也带 role=dialog/aria-modal/焦点管理/焦点陷阱/aria-live', () => {
    const desktopShell = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'components', 'settings', 'SettingsShell.tsx'), 'utf-8');
    // 对话框语义
    expect(desktopShell).toContain('role="dialog"');
    expect(desktopShell).toContain('aria-modal="true"');
    // 焦点管理：useRef + useEffect + requestAnimationFrame
    expect(desktopShell).toContain('const drawerRef = useRef<HTMLElement>(null)');
    expect(desktopShell).toContain('previousActiveElementRef');
    expect(desktopShell).toContain('requestAnimationFrame(');
    // 焦点陷阱：handleKeyDown + onKeyDown
    expect(desktopShell).toContain('function handleKeyDown(event: React.KeyboardEvent<HTMLElement>)');
    expect(desktopShell).toContain('onKeyDown={handleKeyDown}');
    // aria-live 区域
    expect(desktopShell).toContain('aria-live="polite"');
    expect(desktopShell).toContain('aria-atomic="true"');
    expect(desktopShell).toContain('className="sr-only"');
    expect(desktopShell).not.toContain('role="radiogroup"');
    expect(desktopShell).not.toContain('role="radio"');
    expect(desktopShell).not.toContain('aria-checked={scope.value === option.id}');
    // tabIndex=-1 让 drawer 可被聚焦
    expect(desktopShell).toContain('tabIndex={-1}');
  });

  it('desktop ModelsPage 同步移除解释型横幅', () => {
    const desktopModels = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');
    expect(desktopModels).not.toContain('modelSaveHint');
    expect(desktopModels).not.toContain('role="note"');
    expect(desktopModels).not.toContain('presetsHint');
    expect(desktopModels).not.toContain('scopeDescription');
    expect(desktopModels).not.toContain("'应用到当前作用域' : 'Apply to scope'");
    // 不应保留旧文案
    expect(desktopModels).not.toContain("'保存模型配置'");
    expect(desktopModels).not.toContain("'设置当前模型配置'");
  });

  it('desktop styles.css 保留 sr-only，并移除解释型横幅样式', () => {
    const desktopCss = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'styles.css'), 'utf-8');
    expect(desktopCss).toMatch(/\.sr-only\s*\{[^}]*position:\s*absolute[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)[^}]*\}/);
    expect(desktopCss).not.toContain('.modelSaveHint');
    expect(desktopCss).not.toContain('.settingsScopeDescription');
    expect(desktopCss).toMatch(/\.settingsDrawer\s*\{[\s\S]*?outline:\s*none/);
  });

  it('desktop i18n 也更新 saveModelPreset 文案', () => {
    const desktopI18n = readFileSync(join(here, '..', '..', '..', '..', 'desktop', 'src', 'shared', 'i18n.ts'), 'utf-8');
    expect(desktopI18n).toContain("saveModelPreset: 'Save as preset'");
  });
});
