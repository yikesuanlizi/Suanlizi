/**
 * 文件用途：锁定 Suanlizi 桌面端深色主题的基础视觉令牌，防止后续局部规则重新引入白色表面。
 * 业务归属：桌面客户端视觉系统。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** 读取最终 CSS 守卫，确保断言覆盖位于旧规则之后的最终优先级。 */
function readVisualContract(): string {
  const styles = readFileSync(join(here, 'styles.css'), 'utf-8').replace(/\r\n/g, '\n');
  return styles.slice(styles.lastIndexOf('/* Suanlizi visual contract:'));
}

describe('dark theme skin', () => {
  it('defines a dark semantic surface contract for semantic component surfaces', () => {
    const contract = readVisualContract();

    expect(contract).toContain('--nx-surface-canvas: #0a0e13;');
    expect(contract).toContain('--nx-surface-raised: #121820;');
    expect(contract).toContain('--nx-surface-panel: #171e27;');
    expect(contract).toContain('--nx-control-bg: #0c1218;');
    expect(contract).toContain('--nx-text-primary: #e9edf2;');
  });

  it('does not let the dark settings drawer fall back to a white surface', () => {
    const contract = readVisualContract();

    expect(contract).toContain('.appShell:not(.theme-light) .settingsDrawer');
    expect(contract).not.toContain('.appShell:not(.theme-light) .settingsDrawer {\n  background: #ffffff;');
  });

  it('routes shared workbench surfaces through the semantic dark tokens', () => {
    const contract = readVisualContract();

    for (const selector of [
      '.appShell:not(.theme-light) .settingsNav',
      '.appShell:not(.theme-light) .settingsContent',
      '.appShell:not(.theme-light) .settingsCard',
      '.appShell:not(.theme-light) .composer',
      '.appShell:not(.theme-light) .commandInputRow',
      '.appShell:not(.theme-light) .workbenchPanel',
      '.appShell:not(.theme-light) .dropdownMenu',
      '.appShell:not(.theme-light) .appDialog',
      '.appShell:not(.theme-light) .turnFileSummary',
    ]) {
      expect(contract).toContain(selector);
    }

    expect(contract).toContain('background: var(--nx-surface-panel);');
    expect(contract).toContain('border-color: var(--nx-control-border);');
    expect(contract).toContain('color: var(--nx-text-primary);');
  });

  it('overrides important light surfaces inside the dark settings shell', () => {
    const contract = readVisualContract();

    for (const selector of [
      '.appShell:not(.theme-light) .settingsDrawer .settingsHeader',
      '.appShell:not(.theme-light) .settingsDrawer .settingsBody',
      '.appShell:not(.theme-light) .settingsDrawer .settingsNav',
      '.appShell:not(.theme-light) .settingsDrawer .settingsContent',
      '.appShell:not(.theme-light) .settingsDrawer :is(input, select, textarea, .dropdownButton)',
    ]) {
      expect(contract).toContain(selector);
    }

    expect(contract).toContain('background: var(--nx-surface-raised) !important;');
    expect(contract).toContain('background: var(--nx-control-bg) !important;');
    expect(contract).toContain('color: var(--nx-text-primary) !important;');
  });

  it('keeps every settings page readable without restoring light-only cards or buttons', () => {
    const contract = readVisualContract();

    for (const selector of [
      '.appShell:not(.theme-light) .settingsLayer .settingsDrawer .settingsHeader .iconButton',
      '.appShell:not(.theme-light) .settingsLayer .settingsDrawer .settingsNav :is(button, a).active',
      '.appShell:not(.theme-light) .settingsLayer .settingsDrawer .settingsSection:not(.pluginCatalogShell) > h3',
      '.appShell:not(.theme-light) .settingsLayer .settingsDrawer .settingsCard label',
      '.appShell:not(.theme-light) .settingsLayer .settingsDrawer :is(.avatarSettingsPanel, .weixinBotPanel, .dingtalkBotPanel, .memoryAdvancedPanel.expanded, .settingsInfoBlock)',
      '.appShell:not(.theme-light) .settingsLayer .settingsDrawer :is(.presetItem, .remoteBotCard, .providerCard, .skillItem)',
      '.appShell:not(.theme-light) .settingsLayer .settingsDrawer .providerKeyCard .modelKeyStatusLine',
    ]) {
      expect(contract).toContain(selector);
    }

    expect(contract).toContain('background: var(--nx-surface-panel) !important;');
    expect(contract).toContain('color: var(--nx-text-muted) !important;');
    expect(contract).toContain(
      '@layer components {\n  .appShell:not(.theme-light) .settingsLayer .settingsDrawer .settingsHeader .iconButton',
    );
  });
});
