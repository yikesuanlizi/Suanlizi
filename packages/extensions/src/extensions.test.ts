import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSkillRegistry, LocalSkillRegistryCache } from './extensions.js';

describe('LocalSkillRegistry', () => {
  it('renders Codex-style skills instructions in name order for stable prompt prefixes', () => {
    const registry = new LocalSkillRegistry();
    registry.register({
      name: 'zeta',
      description: 'Last skill.',
      body: '',
      sourcePath: 'zeta/SKILL.md',
    });
    registry.register({
      name: 'alpha',
      description: 'First skill.',
      body: '',
      sourcePath: 'alpha/SKILL.md',
    });

    expect(registry.list().map((skill) => skill.name)).toEqual(['alpha', 'zeta']);
    const promptText = registry.toPromptText();
    expect(promptText).toContain('<skills_instructions>');
    expect(promptText).toContain('</skills_instructions>');
    expect(promptText).toContain('## Skills');
    expect(promptText).toContain('### Available skills');
    expect(promptText).toContain('- alpha: First skill. (file: alpha/SKILL.md)');
    expect(promptText).toContain('- zeta: Last skill. (file: zeta/SKILL.md)');
    expect(promptText.indexOf('- alpha:')).toBeLessThan(promptText.indexOf('- zeta:'));
    expect(promptText).toContain('### How to use skills');
    expect(promptText).toContain('Trigger rules');
    expect(promptText).toContain("task clearly matches a skill's description");
    expect(promptText).toContain('Do not carry skills across turns unless re-mentioned.');
  });

  it('keeps empty registries out of the system prompt', () => {
    const registry = new LocalSkillRegistry();

    expect(registry.toPromptText()).toBe('');
  });
});

describe('LocalSkillRegistryCache', () => {
  it('reuses a cached directory scan until forceReload is requested', async () => {
    const root = path.join(tmpdir(), `suanlizi-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = path.join(root, 'alpha');

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), [
        '---',
        'description: first description',
        '---',
        '',
        'First body',
      ].join('\n'));

      const cache = new LocalSkillRegistryCache();
      const first = await cache.loadFromDirectory(root);
      expect(first.list()[0]?.description).toBe('first description');

      await writeFile(path.join(skillDir, 'SKILL.md'), [
        '---',
        'description: second description',
        '---',
        '',
        'Second body',
      ].join('\n'));

      const cached = await cache.loadFromDirectory(root);
      expect(cached.list()[0]?.description).toBe('first description');

      const refreshed = await cache.loadFromDirectory(root, { forceReload: true });
      expect(refreshed.list()[0]?.description).toBe('second description');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
