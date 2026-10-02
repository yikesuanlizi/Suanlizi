import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchTabs } from './WorkbenchTabs.js';

describe('WorkbenchTabs', () => {
  const baseProps = {
    activeTab: 'activity' as const,
    onTabChange: vi.fn(),
    openUtilityTabs: [],
    onOpenUtilityTab: vi.fn(() => 'files' as const),
    onCloseUtilityTab: vi.fn(),
    runningAgentCount: 0,
    locale: 'zh' as const,
  };

  it('keeps Ops hidden unless the current thread exposes Ops mode', () => {
    const chat = renderToStaticMarkup(React.createElement(WorkbenchTabs, baseProps));
    const ops = renderToStaticMarkup(React.createElement(WorkbenchTabs, { ...baseProps, showOps: true }));

    expect(chat).not.toContain('运维');
    expect(ops).toContain('运维');
    expect(ops).toContain('workbenchPrimaryTabs');
    expect(ops).not.toContain('workbenchDynamicTab');
    expect(ops).not.toContain('知识库');
  });

  it('disables utility creation when no thread is selected', () => {
    const html = renderToStaticMarkup(React.createElement(WorkbenchTabs, {
      ...baseProps,
      utilitiesEnabled: false,
    }));

    expect(html).toContain('disabled=""');
    expect(html).not.toContain('role="menu"');
  });

  it('keeps utility tabs in the scrolling region while Ops remains fixed', () => {
    const html = renderToStaticMarkup(React.createElement(WorkbenchTabs, {
      ...baseProps,
      showOps: true,
      openUtilityTabs: ['files', 'browser'],
    }));

    expect(html).toContain('workbenchPrimaryTabs');
    expect(html).toContain('workbenchTabsScrollable');
    expect(html).toContain('运维');
    expect(html).toContain('文件');
    expect(html).toContain('浏览器');
  });

  it('keeps the fixed primary strip shrinkable so the utility scroller and add button stay reachable', () => {
    const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

    expect(styles).toContain('.appShell .workbenchPrimaryTabs {');
    expect(styles).toContain('max-width: min(46%, 310px);');
    expect(styles).toContain('min-width: 72px;');
    expect(styles).toContain('flex: 1 1 0;');
    expect(styles).toContain('.appShell .workbenchTabsScrollable {');
    expect(styles).toContain('min-width: 0;');
    expect(styles).toContain('overscroll-behavior-inline: contain;');
    expect(styles).toContain('.appShell .workbenchUtilityActions {');
  });
});
