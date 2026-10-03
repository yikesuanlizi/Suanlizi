import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('topbar actions', () => {
  it('does not render stop or fork buttons in the top-right toolbar', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const topbar = source.match(/<header className="topbar">([\s\S]*?)<\/header>/)?.[1] ?? '';
    expect(topbar).not.toContain("title={t(config.locale, 'stop')}");
    expect(topbar).not.toContain("title={t(config.locale, 'fork')}");
    expect(topbar).not.toContain("threadAction('fork')");
  });

  it('routes the activity button to the unified task monitor entry', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const openUnifiedMonitor = source.match(/const openUnifiedMonitor[\s\S]*?\n  const mergeApproval/)?.[0] ?? '';
    expect(source).toContain('openUnifiedMonitor');
    expect(source).toContain("title={config.locale === 'zh' ? '任务监控' : 'Task monitor'}");
    expect(openUnifiedMonitor).toContain('runMonitor.openDrawer()');
    expect(openUnifiedMonitor).not.toContain("setRightPaneTab('status')");
    expect(openUnifiedMonitor).not.toContain('runMonitor.setOpen(false)');
    expect(source).not.toContain('disabled={!threadId} title={config.locale === \'zh\' ? \'任务监控\' : \'Task monitor\'}');
  });

  it('does not wire the harness monitor into normal app chrome', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).not.toContain('HarnessMonitor');
    expect(source).not.toContain('useHarnessMonitor');
  });

  it('keeps the production topbar as labelled icon controls', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const topbar = source.match(/<header className="topbar">([\s\S]*?)<\/header>/)?.[1] ?? '';

    expect(topbar).toContain('mobileMenuButton');
    expect(topbar).toContain('helpButton');
    expect(topbar).toContain('openUnifiedMonitor');
    expect(topbar).toContain('rightPaneToggleButton');
    expect(topbar).toContain('aria-label={themeShortcutTitle}');
    expect(topbar).not.toContain('<span className="themeQuickLabel">');
  });

  it('keeps the real settings guide behind the help control', () => {
    const dialogs = readFileSync(join(here, 'components', 'Dialogs.tsx'), 'utf-8');

    expect(dialogs).toContain('核心功能概览');
    expect(dialogs).toContain('运行配置说明');
    expect(dialogs).toContain('使用小贴士');
  });
});
