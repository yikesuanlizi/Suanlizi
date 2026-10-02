import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('skills settings', () => {
  it('uses one configured skillsRoot instead of per-skill path editing', () => {
    const settingsDrawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const defaults = readFileSync(join(here, 'config', 'defaults.ts'), 'utf-8');
    const types = readFileSync(join(here, 'shared', 'types.ts'), 'utf-8');

    expect(settingsDrawer).toContain('skillsRoot');
    expect(settingsDrawer).not.toContain('skillDraft');
    expect(settingsDrawer).not.toMatch(/\bsetSkills[,:}]/);
    expect(defaults).not.toContain('defaultSkills');
    expect(defaults).not.toContain('emptySkill');
    expect(types).not.toContain('interface SkillConfig');
  });

  it('saves skillsRoot only when the save button is clicked', () => {
    const settingsDrawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const tools = readFileSync(join(here, 'components', 'settings', 'ToolsPage.tsx'), 'utf-8');

    // skillsRoot state 与 ensureSkillsRoot / fetch 在主 SettingsDrawer 中
    expect(settingsDrawer).toContain('skillsRootDraft');
    expect(settingsDrawer).toContain('ensureSkillsRoot');
    expect(settingsDrawer).toContain("fetch('/api/settings')");
    expect(settingsDrawer).toContain('saveSkillsRoot');
    // 保存按钮文案在 ToolsPage.tsx 中渲染
    expect(tools).toContain("t(locale, 'saveSkillsRoot')");
    expect(tools).not.toContain('onChange={(event) => setConfig({ ...config, skillsRoot: event.target.value })}');
  });

  it('opens MCP add and edit forms in an internal panel', () => {
    const settingsDrawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const mcpDialog = readFileSync(join(here, 'components', 'settings', 'McpConfigDialog.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');

    // mcpPanelOpen state 在主 SettingsDrawer 中（控制 dialog 显隐）
    expect(settingsDrawer).toContain('mcpPanelOpen');
    // dialog 标题与 role 已迁到 McpConfigDialog.tsx
    expect(mcpDialog).toContain('mcpPanelTitle');
    expect(mcpDialog).toContain('role="dialog"');
    expect(settingsDrawer).not.toContain('className="crudForm"');
    expect(styles).toMatch(/\.dialogLayer\s*\{\s*@apply[^;]*pointer-events-auto/);
  });

  it('renders MCP enabled state as a clickable toggle button', () => {
    const settingsDrawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const mcpSection = readFileSync(join(here, 'components', 'settings', 'McpSection.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');

    // onToggleEnabled 与 mcpToggle 渲染已迁到 McpSection.tsx
    expect(mcpSection).toContain('onToggleEnabled');
    expect(mcpSection).toContain('mcpToggle');
    expect(settingsDrawer).not.toContain('<small className={item.enabled');
    expect(styles).toMatch(/\.mcpToggle\s*\{\s*@apply[^;]*cursor-pointer/);
  });

  it('shows the installed skills list and a refresh action', () => {
    const settingsDrawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const tools = readFileSync(join(here, 'components', 'settings', 'ToolsPage.tsx'), 'utf-8');
    const main = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const types = readFileSync(join(here, 'shared', 'types.ts'), 'utf-8');

    expect(types).toContain('interface SkillEntry');
    // skillsList 与 refreshSkills 回调通过 props 传递，主文件持有
    expect(settingsDrawer).toContain('skillsList');
    expect(settingsDrawer).toContain('refreshSkills');
    expect(main).toContain("'/api/skills?forceReload=1'");
    expect(main).toContain("'/api/skills'");
    expect(settingsDrawer).toContain('refreshSkills({ forceReload: true })');
    // 列表渲染与刷新按钮 UI 已迁到 ToolsPage.tsx
    expect(tools).toContain("t(locale, 'refresh')");
    expect(tools).toContain('localizedSkillDescription(skill, locale)');
    expect(tools).not.toContain('<code>{skill.sourcePath}</code>');
  });

  it('provides a recommended plugin catalog for built-in MCP and Skills', () => {
    const settingsDrawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const tools = readFileSync(join(here, 'components', 'settings', 'ToolsPage.tsx'), 'utf-8');
    const catalog = readFileSync(join(here, 'features', 'settings', 'pluginCatalog.ts'), 'utf-8');

    // 插件中心内部 tab 与 catalog 渲染已迁到 ToolsPage.tsx
    expect(tools).toContain("useState<'recommended' | 'mcp' | 'skills' | 'web'>('recommended')");
    expect(tools).toContain('recommendedPluginCatalog');
    // install/add 回调仍在主 SettingsDrawer 中（与 saveSkillDraft 联动）
    expect(settingsDrawer).toContain('installRecommendedSkill');
    expect(settingsDrawer).toContain('addRecommendedMcp');
    expect(catalog).toContain('recommendedSkills');
    expect(catalog).toContain('recommendedMcps');
    expect(catalog).toContain('code-review');
    expect(catalog).toContain('playwright');
    expect(catalog).toContain('filesystem');
  });

  it('lets users remove installed skills from the plugin center', () => {
    const settingsDrawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const tools = readFileSync(join(here, 'components', 'settings', 'ToolsPage.tsx'), 'utf-8');
    const main = readFileSync(join(here, 'main.tsx'), 'utf-8');

    // deleteSkill 通过 props 从主文件传入
    expect(settingsDrawer).toContain('deleteSkill');
    // 删除按钮 UI 已迁到 ToolsPage.tsx
    expect(tools).toContain('onClick={() => void deleteSkill(skill.name)}');
    expect(tools).toContain("aria-label={t(locale, 'remove')}");
    expect(main).toContain('async function deleteSkill');
    expect(main).toContain("method: 'DELETE'");
    expect(main).toContain("`/api/skills/${encodeURIComponent(name)}`");
  });

  it('handles MCP persistence fetch failures without an uncaught promise', () => {
    const main = readFileSync(join(here, 'main.tsx'), 'utf-8');

    const mcpPersistence = main.slice(
      main.indexOf("fetch('/api/mcp'"),
      main.indexOf('}, [mcpHydrated, mcps]);'),
    );

    expect(mcpPersistence).toContain('.catch((error)');
    expect(mcpPersistence).toContain('MCP 配置保存失败');
  });

  it('keeps plugin tab layout stable and readable in light mode', () => {
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');

    expect(styles).toMatch(/\.settingsDrawer \.pluginTabs\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
    expect(styles).toMatch(/\.settingsDrawer \.pluginPane\s*\{[^}]*min-height:\s*360px/s);
    expect(styles).toMatch(/\.settingsDrawer \.pluginInnerSection\s*\{[^}]*width:\s*100%/s);
    expect(styles).toMatch(/\.appShell\.theme-light \.settingsDrawer \.pluginCatalogItem strong[\s\S]*color:\s*#0f172a/);
    expect(styles).toMatch(/\.appShell\.theme-light \.settingsDrawer \.pluginTabs button span[\s\S]*color:\s*#0f172a/);
  });

  it('uses locale-aware skill descriptions without showing per-skill paths', () => {
    const tools = readFileSync(join(here, 'components', 'settings', 'ToolsPage.tsx'), 'utf-8');
    const descriptions = readFileSync(join(here, 'features', 'settings', 'skillDescriptions.ts'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');

    // localizedSkillDescription 调用已迁到 ToolsPage.tsx
    expect(tools).toContain('localizedSkillDescription(skill, locale)');
    expect(descriptions).toContain('ZH_SKILL_DESCRIPTIONS');
    expect(descriptions).toContain("'frontend-design': '设计高质量、具有明确风格的前端界面。'");
    expect(styles).not.toContain('grid-cols-[minmax(0,1fr)_minmax(180px,320px)]');
  });

  it('shows registered custom providers with optional favicon branding', () => {
    const shared = readFileSync(join(here, 'components', 'settings', 'shared.ts'), 'utf-8');
    // providerDropdownOptions 已迁到 settings/shared.ts
    const helperIndex = shared.indexOf('ProviderBrandIcon');
    const providerOptions = shared.slice(helperIndex >= 0 ? helperIndex : shared.indexOf('function providerDropdownOptions'));

    expect(providerOptions).toContain('label: provider.name');
    expect(providerOptions).toContain("provider.id === 'openai_compatible'");
    expect(providerOptions).toContain("provider.id.startsWith('custom_')");
    expect(providerOptions).toContain("t(locale, 'customProvider')");
    expect(providerOptions).toContain('ProviderBrandIcon');
    expect(providerOptions).not.toContain('detail: provider');
    expect(providerOptions).not.toContain('apiKeyEnvVar');
    expect(providerOptions).not.toContain('baseUrl.replace');
  });

  it('loads and applies model presets inside the model page', () => {
    const models = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');
    const settingsDrawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');

    // 模型 section UI 已迁到 ModelsPage.tsx
    expect(settingsDrawer).not.toContain("{ id: 'presets'");
    expect(models).toContain('modelPresets.map((preset)');
    expect(models).toContain('<DropdownSelect');
    expect(models).toContain('beginEdit(preset)');
    expect(models).not.toContain('applyModelPreset(preset)');
    expect(models).not.toContain('saveModelPreset()');
  });
});
