import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('slash command selection UI', () => {
  it('selects argument-taking slash commands into a styled chip instead of executing immediately', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const composer = readFileSync(join(here, 'components', 'ComposerBar.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8').replace(/\r\n/g, '\n');

    expect(source).toContain('activeSlashOption');
    expect(source).toContain('selectSlashOption');
    expect(composer).toContain('commandChip');
    expect(composer).toContain('commandInputMeta');
    expect(composer).toContain('commandUrlChip');
    expect(composer).toContain('commandInputClassName');
    expect(composer).toContain("'withTokens'");
    expect(source).toContain('activeSlashOption.command + input');
    expect(source).toContain('extractGitHubSkillInstallUrls(command.args)');
    expect(source).toContain('await installSkillsFromGitHub(installTargets, command.args)');
    expect(source).toContain("createLocalSkillDraftItems(text, config.locale, undefined, 'install')");
    expect(source).toContain('body: JSON.stringify({ input: inputText, urls: installTargets, config: threadApiConfig })');
    expect(source).not.toContain('find((token) => isGitHubSkillInstallUrl(token.value))');
    expect(source).not.toContain("if (!text) {\n      setSettingsOpen(true);");
    expect(styles).toContain('.commandChip');
    expect(styles).toContain('.commandUrlChip');
  });

  it('keeps the selected slash command inside a plain black input frame', () => {
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8').replace(/\r\n/g, '\n');
    const commandStyles = styles.slice(styles.indexOf('.commandInputRow'), styles.indexOf('.skillDraftDialog'));

    expect(commandStyles).toContain('.commandInputRow.active {\n    @apply border-slate-950;');
    expect(commandStyles).toContain('.commandInputMeta');
    expect(commandStyles).toContain('.commandTokenRow');
    expect(commandStyles).toContain('.commandInputRow.withTokens .commandInputMeta');
    expect(commandStyles).toContain('border-bottom: 1px solid rgba(148, 163, 184, .24);');
    expect(commandStyles).toContain('border-slate-950');
    expect(commandStyles).not.toContain('grid-cols-[auto_minmax(0,1fr)]');
    expect(commandStyles).not.toContain('text-sky');
    expect(commandStyles).not.toContain('border-sky');
    expect(commandStyles).not.toContain('bg-sky');
    expect(commandStyles).not.toContain('rgba(14,165,233');
  });

  it('lists skills and MCP servers as quick actions instead of only opening settings', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const composer = readFileSync(join(here, 'components', 'ComposerBar.tsx'), 'utf-8');

    expect(source).toContain("action: 'insert_skill'");
    expect(source).toContain('hideCommand: true as const');
    expect(composer).toContain("'hideCommand' in option && option.hideCommand ? null : <span>{option.command}</span>");
    expect(source).toContain("setInput(`$${option.skillName} `)");
    expect(source).toContain("action: 'enable_mcp'");
    expect(source).toContain('resolveMcpDraftFromInput(command.args)');
    expect(readFileSync(join(here, 'features', 'settings', 'mcpConfig.ts'), 'utf-8')).toContain("fetchImpl('/api/mcp/draft'");
    expect(source).toContain('setMcps((current) => current.map((mcp) => (');
    expect(source).not.toContain("case 'skills.list':\n        setSettingsOpen(true);");
    expect(source).not.toContain("case 'mcp.list':\n        setSettingsOpen(true);");
  });

  it('shows remote assistant binding icons and a platform picker inside the composer', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const composer = readFileSync(join(here, 'components', 'ComposerBar.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8').replace(/\r\n/g, '\n');

    expect(source).toContain('botConfig={botConfig}');
    expect(source).toContain('botStatus={botStatus}');
    expect(composer).toContain('remoteBindingView');
    expect(composer).toContain('remotePlatformIcon');
    expect(composer).toContain('remoteBindingRobot');
    expect(composer).toContain('remoteAssistantMenu');
    expect(composer).not.toContain('助手已绑定');
    expect(composer).not.toContain('绑定到其他对话');
    expect(composer).not.toContain('远程助手未绑定');
    expect(styles).toContain('.weixinBindingButton');
    expect(styles).toContain('.remoteAssistantMenu');
  });

  it('marks MCP URL input as a source draft in the settings panel instead of a runnable command', () => {
    const mcpDialog = readFileSync(join(here, 'components', 'settings', 'McpConfigDialog.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');

    // mcpDraftSourceUrl 已迁到 McpConfigDialog.tsx
    expect(mcpDialog).toContain('mcpDraftSourceUrl');
    expect(mcpDialog).toContain('mcpSourceNotice');
    expect(mcpDialog).toContain('Suanlizi 不会把 URL 直接当作命令执行');
    expect(mcpDialog).toContain('disabled={!mcpCanSave}');
    expect(styles).toContain('.mcpSourceNotice');
  });
});
