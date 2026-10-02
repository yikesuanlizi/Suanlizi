// 设置面板 modal 外壳：管理 open/close、Esc 关闭、tab 导航
// P2.4 a11y：role=dialog/aria-modal、焦点进入/回收、Tab 焦点陷阱、aria-live 状态广播
// v3 预览对齐：topbar 跨栏 + brand mark + 主题切换 + rail-label + nav 图标
import React, { useEffect, useRef, useState } from 'react';
import type { Locale } from '../../config/config.js';
import { t } from '../../shared/i18n.js';
import { Icon, type IconName } from '../Icon.js';

export type SettingsScope = 'global' | 'currentThread' | 'newThread';

export interface SettingsScopeInfo {
  value: SettingsScope;
  onChange: (scope: SettingsScope) => void;
  currentThreadAvailable: boolean;
}

export interface SettingsSaveState {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  savedToastAt: number | null;
}

// 设置导航 tab → 图标映射，对齐预览的 nav-icon 设计
const SETTINGS_TAB_ICONS: Record<string, IconName> = {
  agent: 'modelGroup',
  accessPolicy: 'shield',
  appearance: 'paintbrush',
  memory: 'brain',
  knowledge: 'knowledge',
  performance: 'gauge',
  runtime: 'gauge',
  monitor: 'activity',
  ssh: 'terminal',
  about: 'question',
  plugins: 'puzzle',
  remote: 'messages',
};

export interface SettingsShellProps {
  locale: Locale;
  open: boolean;
  onClose: () => void;
  settingsTabs: Array<{ id: string; label: string }>;
  activeSection: string;
  setActiveSection: (id: string) => void;
  saveState: SettingsSaveState;
  onSave: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
  pluginMode?: boolean;
  busyLayer?: boolean;
  saveLabel?: string;
  visualThemeMode?: 'light' | 'dark';
  onToggleTheme?: () => void;
}

export function SettingsShell({
  locale,
  open,
  onClose,
  settingsTabs,
  activeSection,
  setActiveSection,
  saveState,
  onCancel,
  children,
  pluginMode = false,
  busyLayer = true,
  visualThemeMode = 'light',
  onToggleTheme,
}: SettingsShellProps) {
  const drawerRef = useRef<HTMLElement>(null);
  const settingsFieldsetRef = useRef<HTMLFieldSetElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const scrollIndicatorDragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);
  const [scrollIndicator, setScrollIndicator] = useState({ visible: false, top: 0, right: 0 });
  const [scrollIndicatorDragging, setScrollIndicatorDragging] = useState(false);

  function handleCancel() {
    if (saveState.saving) return;
    if (onClose) onClose();
    else onCancel();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (saveState.saving) return;
      handleCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, saveState.saving, onCancel]);

  useEffect(() => {
    if (!open) return;
    previousActiveElementRef.current = document.activeElement as HTMLElement | null;
    const rafId = requestAnimationFrame(() => {
      const drawer = drawerRef.current;
      if (!drawer) return;
      const firstFocusable = drawer.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (firstFocusable) {
        firstFocusable.focus();
      } else {
        drawer.focus();
      }
    });
    return () => {
      cancelAnimationFrame(rafId);
      const trigger = previousActiveElementRef.current;
      previousActiveElementRef.current = null;
      if (trigger && typeof trigger.focus === 'function') {
        trigger.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setScrollIndicator({ visible: false, top: 0, right: 0 });
      return;
    }
    const fieldset = settingsFieldsetRef.current;
    const content = fieldset?.parentElement;
    if (!fieldset || !content) return;
    let frame = 0;
    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const scrollRange = Math.max(0, fieldset.scrollHeight - fieldset.clientHeight);
        const thumbHeight = 38;
        const trackHeight = Math.max(thumbHeight, fieldset.clientHeight - 4);
        const maxOffset = Math.max(0, trackHeight - thumbHeight);
        const progress = scrollRange > 0 ? fieldset.scrollTop / scrollRange : 0;
        const fieldsetRect = fieldset.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const top = Math.max(0, fieldsetRect.top - contentRect.top + 2 + progress * maxOffset);
        const right = Math.max(6, contentRect.right - fieldsetRect.right - 10);
        setScrollIndicator((current) => (
          current.visible === (scrollRange > 0)
          && Math.abs(current.top - top) < 0.5
          && Math.abs(current.right - right) < 0.5
            ? current
            : { visible: scrollRange > 0, top, right }
        ));
      });
    };
    update();
    fieldset.addEventListener('scroll', update, { passive: true });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resizeObserver?.observe(fieldset);
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
    mutationObserver?.observe(fieldset, { childList: true, subtree: true, attributes: true });
    return () => {
      fieldset.removeEventListener('scroll', update);
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [open, activeSection, pluginMode]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const drag = scrollIndicatorDragRef.current;
      const fieldset = settingsFieldsetRef.current;
      if (!drag || !fieldset) return;
      const scrollRange = Math.max(0, fieldset.scrollHeight - fieldset.clientHeight);
      const maxOffset = Math.max(0, fieldset.clientHeight - 4 - 38);
      if (scrollRange <= 0 || maxOffset <= 0) return;
      fieldset.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) * scrollRange) / maxOffset;
    }

    function handlePointerEnd() {
      if (!scrollIndicatorDragRef.current) return;
      scrollIndicatorDragRef.current = null;
      setScrollIndicatorDragging(false);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, []);

  function handleScrollIndicatorPointerDown(event: React.PointerEvent<HTMLSpanElement>) {
    const fieldset = settingsFieldsetRef.current;
    if (!fieldset || fieldset.scrollHeight <= fieldset.clientHeight) return;
    event.preventDefault();
    event.stopPropagation();
    scrollIndicatorDragRef.current = { startY: event.clientY, startScrollTop: fieldset.scrollTop };
    setScrollIndicatorDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  const showSavedToast = saveState.savedToastAt !== null && Date.now() - saveState.savedToastAt < 2000;

  if (!open) return null;

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const focusable = drawer.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey) {
      if (document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  const ariaLiveMessage = saveState.saving
    ? t(locale, 'saving')
    : saveState.error
      ? `${t(locale, 'failedToSave')}: ${saveState.error}`
      : showSavedToast
        ? t(locale, 'saved')
        : '';

  const closeLabel = locale === 'zh' ? '关闭设置' : 'Close settings';
  const themeToggleLabel = visualThemeMode === 'dark'
    ? (locale === 'zh' ? '切换浅色' : 'Switch to light')
    : (locale === 'zh' ? '切换深色' : 'Switch to dark');
  const railLabel = locale === 'zh' ? '配置工作台' : 'Workbench';

  return (
    <div className={`settingsLayer theme-${visualThemeMode}`} role="presentation">
      <button className="scrim" aria-label={t(locale, 'cancel')} onClick={handleCancel} type="button" />
      <aside
        className={`settingsDrawer theme-${visualThemeMode}`}
        role="dialog"
        aria-modal="true"
        aria-label={t(locale, 'settings')}
        tabIndex={-1}
        ref={drawerRef}
        onKeyDown={handleKeyDown}
      >
        <header className="settingsHeader settingsTopbar">
          <div className="settingsBrand">
            <span className="settingsBrandMark" aria-hidden="true">N</span>
            <strong className="settingsBrandName">Suanlizi</strong>
            <span className="settingsBrandSub">{t(locale, 'settings')}</span>
            {saveState.dirty ? (
              <span
                className="unsavedDot"
                title={t(locale, 'unsavedChangesHint')}
                aria-label={t(locale, 'hasUnsavedChanges')}
                role="status"
              />
            ) : null}
          </div>
          <div className="settingsTopActions">
            {onToggleTheme ? (
              <button
                className="iconButton settingsThemeToggle"
                title={themeToggleLabel}
                aria-label={themeToggleLabel}
                onClick={onToggleTheme}
                type="button"
              >
                <Icon name={visualThemeMode === 'dark' ? 'sun' : 'moon'} />
              </button>
            ) : null}
            <button
              className="iconButton settingsCloseButton"
              title={closeLabel}
              aria-label={closeLabel}
              onClick={handleCancel}
              type="button"
            >
              <Icon name="x" />
            </button>
          </div>
        </header>

        <div className="settingsBody">
          <aside className="settingsRail">
            <div className="settingsRailLabel">{railLabel}</div>
            <nav className="settingsNav" aria-label={t(locale, 'settings')}>
              {settingsTabs.map((tab) => (
                <button
                  className={activeSection === tab.id ? 'active' : ''}
                  key={tab.id}
                  aria-current={activeSection === tab.id ? 'page' : undefined}
                  onClick={() => setActiveSection(tab.id)}
                  type="button"
                >
                  <span className="settingsNavIcon" aria-hidden="true">
                    <Icon name={SETTINGS_TAB_ICONS[tab.id] ?? 'gear'} />
                  </span>
                  <span className="settingsNavLabel">{tab.label}</span>
                </button>
              ))}
            </nav>
          </aside>

          <div className={`settingsContent ${pluginMode ? 'pluginContentMode' : ''}`}>
            <fieldset ref={settingsFieldsetRef} className="settingsFieldset" disabled={saveState.saving && busyLayer}>
              {children}
            </fieldset>
            <span
              aria-hidden="true"
              className={`settingsScrollIndicator${scrollIndicator.visible ? ' is-scrollable' : ''}${scrollIndicatorDragging ? ' is-dragging' : ''}`}
              onPointerDown={handleScrollIndicatorPointerDown}
              style={{ top: scrollIndicator.top, right: scrollIndicator.right }}
            />
          </div>
        </div>

      </aside>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {ariaLiveMessage}
      </div>

      {showSavedToast ? (
        <div className="settingsSaveToast" role="status" aria-live="polite">
          {t(locale, 'saved')}
        </div>
      ) : null}
    </div>
  );
}
