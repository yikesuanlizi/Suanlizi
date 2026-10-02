import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('settings navigation', () => {
  it('switches settings pages with internal state instead of anchor scrolling', () => {
    const source = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const shell = readFileSync(join(here, 'components', 'settings', 'SettingsShell.tsx'), 'utf-8');

    // activeSection state 仍在主 SettingsDrawer 中管理
    expect(source).toContain('const [activeSection, setActiveSection]');
    // tab 切换 onClick 已迁到 SettingsShell.tsx
    expect(shell).toContain("onClick={() => setActiveSection(tab.id)}");
    expect(source).not.toContain('href="#settings-');
    expect(shell).not.toContain('href="#settings-');
  });

  it('keeps the settings layer fixed instead of sharing drawer panel layout', () => {
    const css = readFileSync(join(here, 'styles.css'), 'utf-8');

    expect(css).toMatch(/\.settingsLayer\s*\{[^}]*fixed[^}]*inset-0[^}]*z-20/s);
    expect(css).not.toMatch(/\.settingsLayer\s*,\s*\.settingsDrawer\s*\{/);
  });

  it('does not expose multiplayer or administrator controls', () => {
    const source = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const main = readFileSync(join(here, 'main.tsx'), 'utf-8');

    expect(source).not.toContain('showAdminControls');
    expect(source).not.toContain("id: 'admin'");
    expect(main).not.toContain('deploymentStatus');
    expect(main).not.toContain('showAdminControls');
  });

  it('offers built-in and custom user avatar controls in appearance settings', () => {
    const appearance = readFileSync(join(here, 'components', 'settings', 'AppearancePage.tsx'), 'utf-8');
    const avatar = readFileSync(join(here, 'components', 'UserAvatar.tsx'), 'utf-8');

    // 头像相关 UI 已迁到 AppearancePage.tsx
    expect(appearance).toContain('USER_AVATAR_OPTIONS.map');
    expect(appearance).toContain('accept="image/*"');
    expect(appearance).toContain('customUserAvatarDataUrl');
    expect(appearance).toContain('恢复默认头像');
    expect(avatar).toContain("DEFAULT_USER_AVATAR_ID: UserAvatarId = 'asteroid'");
    expect(avatar).toContain("id: 'mushroom'");
  });

  it('offers memory controls with list, delete, and export actions', () => {
    const source = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const memory = readFileSync(join(here, 'components', 'settings', 'MemoryPage.tsx'), 'utf-8');
    const main = readFileSync(join(here, 'main.tsx'), 'utf-8');

    expect(source).toContain("{ id: 'memory'");
    expect(source).toContain('/api/memories/settings');
    expect(source).toContain('/api/memories/export');
    // 记录列表渲染已迁到 MemoryPage.tsx
    expect(memory).toContain('memoryRecords.map');
    expect(main).toContain('memoryExcluded');
  });

  it('keeps every settings domain mounted while removing only normal-page teaching copy', () => {
    const drawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const appearance = readFileSync(join(here, 'components', 'settings', 'AppearancePage.tsx'), 'utf-8');
    const accessPolicy = readFileSync(join(here, 'components', 'settings', 'AccessPolicyPage.tsx'), 'utf-8');
    const agents = readFileSync(join(here, 'components', 'settings', 'AgentsPage.tsx'), 'utf-8');
    const monitor = readFileSync(join(here, 'components', 'settings', 'MonitorPage.tsx'), 'utf-8');
    const tools = readFileSync(join(here, 'components', 'settings', 'ToolsPage.tsx'), 'utf-8');
    const memory = readFileSync(join(here, 'components', 'settings', 'MemoryPage.tsx'), 'utf-8');

    for (const page of ['ModelsPage', 'AccessPolicyPage', 'AppearancePage', 'ToolsPage', 'MemoryPage', 'MonitorPage', 'AgentsPage', 'AboutPage']) {
      expect(drawer).toContain(`<${page}`);
    }
    expect(tools).toContain('filteredMcps');
    expect(tools).not.toContain('className="breadcrumb"');
    expect(memory).not.toContain('热记忆来自当前运行');
    expect(memory).not.toContain('Hot memory is runtime state');
    expect(memory).not.toContain('把一次完整的任务打包记住');
    expect(appearance).not.toContain('用于右侧用户消息');
    expect(accessPolicy).not.toContain('设置页只保存持久允许');
    expect(agents).not.toContain('微信优先，其他平台沿用同一网关');
    expect(monitor).not.toContain('三级限流策略');
  });

  it('uses a dense settings workbench layout instead of full-width stacked cards', () => {
    const css = readFileSync(join(here, 'styles.css'), 'utf-8');

    expect(css).toContain('/* Suanlizi settings workbench density contract */');
    expect(css).toContain('.settingsLayer .settingsDrawer .settingsSection');
    expect(css).toMatch(/max-width:\s*1040px\s*!important;/);
    expect(css).toMatch(/grid-template-columns:\s*minmax\(112px,\s*148px\)\s+minmax\(0,\s*1fr\)\s*!important;/);
    expect(css).toContain('.settingsLayer .settingsDrawer .settingsCard');
    expect(css).toMatch(/display:\s*grid\s*!important;/);
    expect(css).toMatch(/grid-template-columns:\s*minmax\(112px,\s*148px\)\s+minmax\(0,\s*1fr\)\s+auto\s*!important;/);
    expect(css).toMatch(/border-radius:\s*8px\s*!important;/);
  });
});
