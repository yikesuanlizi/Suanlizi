import { mkdtemp, readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSkillDraftSystemPrompt, createSkillInstallTurnItems, createTemplateSkillDraft, deleteSkill, formatSkillMarkdown, installSkillsFromGitHubUrl, installSkillsFromGitHubUrls, prepareSkillDraftRequest, safeGeneratedSkillDraft, writeSkillDraft } from './skills.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('skill file creation', () => {
  it('writes generated SKILL.md only under the configured skills root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-skills-'));
    const result = await writeSkillDraft(root, {
      name: '../Code Review Skill!!',
      description: '审查代码变更',
      body: formatSkillMarkdown({
        name: 'code-review',
        description: '审查代码变更',
        instructions: '优先发现缺陷、回归和缺失测试。',
      }),
    });

    expect(result.name).toBe('code-review-skill');
    expect(result.path).toBe(path.join(root, 'code-review-skill', 'SKILL.md'));
    expect(await readFile(result.path, 'utf-8')).toContain('description: 审查代码变更');
  });

  it('deletes an installed skill directory without touching outside paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-skills-delete-'));
    await writeSkillDraft(root, {
      name: 'frontend-polish',
      description: '优化界面细节',
      body: formatSkillMarkdown({
        name: 'frontend-polish',
        description: '优化界面细节',
        instructions: '检查布局、颜色和响应式状态。',
      }),
    });

    const removed = await deleteSkill(root, 'frontend-polish');

    expect(removed.name).toBe('frontend-polish');
    await expect(stat(path.join(root, 'frontend-polish'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(deleteSkill(root, '../outside')).rejects.toThrow('Skill path escapes skills root');
  });
});

describe('skill draft language', () => {
  it('builds locale-specific drafting instructions', () => {
    expect(buildSkillDraftSystemPrompt('en')).toContain('Write description and instructions in English');
    expect(buildSkillDraftSystemPrompt('zh')).toContain('使用中文编写 description 和 instructions');
  });
});

describe('skill draft source preparation', () => {
  it('fetches GitHub URL content before asking the model to draft a skill', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return new Response('# Anthropic Skills\n\nA repository of reusable Claude skill definitions.');
    };

    const prepared = await prepareSkillDraftRequest('https://github.com/anthropics/skills');

    expect(requestedUrls[0]).toContain('raw.githubusercontent.com/anthropics/skills');
    expect(prepared.sourceUrl).toBe('https://github.com/anthropics/skills');
    expect(prepared.prompt).toContain('# Anthropic Skills');
    expect(prepared.prompt).toContain('Do not write a skill that merely tells the user to visit or use the URL');
  });

  it('uses fetched source content for template drafts instead of URL-only placeholders', async () => {
    globalThis.fetch = async () =>
      new Response([
        '# Skills',
        '',
        'Skills are folders of instructions, scripts, and resources that Claude loads dynamically.',
        'Skills teach Claude how to complete specific tasks in a repeatable way.',
      ].join('\n'));

    const prepared = await prepareSkillDraftRequest('https://github.com/anthropics/skills');
    const draft = createTemplateSkillDraft(prepared, 'zh');

    expect(draft.name).not.toBe('https-github-com-anthropics-skills');
    expect(draft.description).not.toBe('https://github.com/anthropics/skills');
    expect(draft.body).not.toContain('\nhttps://github.com/anthropics/skills\n');
    expect(draft.body).toContain('Skills are folders of instructions');
  });

  it('replaces URL-only model output with the fetched-content fallback', async () => {
    globalThis.fetch = async () =>
      new Response('# Skills\n\nSkills are folders of instructions, scripts, and resources.');

    const prepared = await prepareSkillDraftRequest('https://github.com/anthropics/skills');
    const fallback = createTemplateSkillDraft(prepared, 'zh');
    const draft = safeGeneratedSkillDraft(
      {
        name: 'https-github-com-anthropics-skills',
        description: 'https://github.com/anthropics/skills',
        instructions: 'https://github.com/anthropics/skills',
      },
      prepared,
      fallback,
    );

    expect(draft.name).toBe(fallback.name);
    expect(draft.description).toBe(fallback.description);
    expect(draft.body).toContain('Skills are folders of instructions');
    expect(draft.body).not.toContain('\nhttps://github.com/anthropics/skills\n');
  });

  it('uses the first fetchable url when several source urls are provided', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes('missing')) return new Response('not found', { status: 404 });
      return new Response('# MCP Guide\n\nUse npx @modelcontextprotocol/server-filesystem to start the server.');
    };

    const prepared = await prepareSkillDraftRequest('参考 https://example.com/missing 和 https://example.com/mcp-guide');

    expect(prepared.sourceUrl).toBe('https://example.com/mcp-guide');
    expect(prepared.sourceContent).toContain('@modelcontextprotocol/server-filesystem');
    expect(requestedUrls.some((url) => url.includes('missing'))).toBe(true);
  });

  it('reads SKILL.md from explicit GitHub tree directories before falling back to repo README', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith('/skills/pdf/SKILL.md')) {
        return new Response('# PDF Skill\n\nHandle PDF extraction and visual QA.');
      }
      return new Response('not found', { status: 404 });
    };

    const prepared = await prepareSkillDraftRequest('https://github.com/anthropics/skills/tree/main/skills/pdf');

    expect(requestedUrls[0]).toBe('https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md');
    expect(prepared.sourceContent).toContain('PDF Skill');
  });
});

describe('GitHub skill installation', () => {
  it('copies real skill directories with SKILL.md into the configured skills root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-install-skills-'));
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/git/trees/main?recursive=1')) {
        return new Response(JSON.stringify({
          tree: [
            { path: 'README.md', type: 'blob' },
            { path: 'skills/frontend-design/SKILL.md', type: 'blob' },
            { path: 'skills/frontend-design/references/style.md', type: 'blob' },
          ],
        }));
      }
      if (requestUrl.endsWith('/skills/frontend-design/SKILL.md')) {
        return new Response('---\nname: frontend-design\ndescription: Design frontend UI.\n---\n\n# Instructions\n\nBuild polished UI.');
      }
      if (requestUrl.endsWith('/skills/frontend-design/references/style.md')) {
        return new Response('Use compact layout.');
      }
      return new Response('not found', { status: 404 });
    };

    const result = await installSkillsFromGitHubUrl(root, 'https://github.com/anthropics/skills');

    expect(result.installed).toEqual([
      {
        name: 'frontend-design',
        path: path.join(root, 'frontend-design'),
        sourcePath: 'skills/frontend-design',
      },
    ]);
    expect(await readFile(path.join(root, 'frontend-design', 'SKILL.md'), 'utf-8')).toContain('name: frontend-design');
    expect(await readFile(path.join(root, 'frontend-design', 'references', 'style.md'), 'utf-8')).toBe('Use compact layout.');
  });

  it('installs several explicit GitHub skill urls from one command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-install-multi-skills-'));
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/git/trees/main?recursive=1')) {
        return new Response(JSON.stringify({
          tree: [
            { path: 'skills/pdf/SKILL.md', type: 'blob' },
            { path: 'skills/docx/SKILL.md', type: 'blob' },
          ],
        }));
      }
      if (requestUrl.endsWith('/skills/pdf/SKILL.md')) {
        return new Response('---\nname: pdf\ndescription: PDF tools.\n---\n\n# Instructions\n\nHandle PDFs.');
      }
      if (requestUrl.endsWith('/skills/docx/SKILL.md')) {
        return new Response('---\nname: docx\ndescription: DOCX tools.\n---\n\n# Instructions\n\nHandle DOCX.');
      }
      return new Response('not found', { status: 404 });
    };

    const result = await installSkillsFromGitHubUrls(root, [
      'https://github.com/anthropics/skills/tree/main/skills/pdf',
      'https://github.com/anthropics/skills/tree/main/skills/docx',
    ]);

    expect(result.installed.map((skill) => skill.name)).toEqual(['pdf', 'docx']);
    expect(await readFile(path.join(root, 'pdf', 'SKILL.md'), 'utf-8')).toContain('name: pdf');
    expect(await readFile(path.join(root, 'docx', 'SKILL.md'), 'utf-8')).toContain('name: docx');
  });

  it('continues multi-url install when an earlier target is already installed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-install-partial-skills-'));
    await writeSkillDraft(root, {
      name: 'pdf',
      description: 'Existing PDF skill.',
      body: formatSkillMarkdown({
        name: 'pdf',
        description: 'Existing PDF skill.',
        instructions: 'Already present.',
      }),
    });
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/git/trees/main?recursive=1')) {
        return new Response(JSON.stringify({
          tree: [
            { path: 'skills/pdf/SKILL.md', type: 'blob' },
            { path: 'skills/docx/SKILL.md', type: 'blob' },
          ],
        }));
      }
      if (requestUrl.endsWith('/skills/pdf/SKILL.md')) {
        return new Response('---\nname: pdf\ndescription: PDF tools.\n---\n\n# Instructions\n\nHandle PDFs.');
      }
      if (requestUrl.endsWith('/skills/docx/SKILL.md')) {
        return new Response('---\nname: docx\ndescription: DOCX tools.\n---\n\n# Instructions\n\nHandle DOCX.');
      }
      return new Response('not found', { status: 404 });
    };

    const result = await installSkillsFromGitHubUrls(root, [
      'https://github.com/anthropics/skills/tree/main/skills/pdf',
      'https://github.com/anthropics/skills/tree/main/skills/docx',
    ]);

    expect(result.installed.map((skill) => skill.name)).toEqual(['docx']);
    expect(await readFile(path.join(root, 'docx', 'SKILL.md'), 'utf-8')).toContain('name: docx');
  });
});

describe('skill install transcript items', () => {
  it('creates persistent user, tool, and agent items for a skills add turn', () => {
    const items = createSkillInstallTurnItems({
      turnId: 'turn-skills',
      input: '/skills add https://github.com/anthropics/skills',
      installed: [
        {
          name: 'frontend-design',
          path: 'C:/Users/Alice/.suanlizi/skills/frontend-design',
          sourcePath: 'skills/frontend-design',
        },
      ],
      skillsRoot: 'C:/Users/Alice/.suanlizi/skills',
      agentText: '已安装 1 个 Skill：frontend-design。',
      timestamp: '2026-06-09T08:00:00.000Z',
    });

    expect(items).toEqual([
      expect.objectContaining({
        id: 'turn-skills_item_0',
        type: 'user_message',
        text: '/skills add https://github.com/anthropics/skills',
      }),
      expect.objectContaining({
        id: 'turn-skills_item_1',
        type: 'tool_call',
        toolName: 'skills_add',
        status: 'completed',
        arguments: { input: 'https://github.com/anthropics/skills' },
        result: expect.objectContaining({
          count: 1,
          names: ['frontend-design'],
          skillsRoot: 'C:/Users/Alice/.suanlizi/skills',
          sourcePaths: ['skills/frontend-design'],
        }),
      }),
      expect.objectContaining({
        id: 'turn-skills_item_2',
        type: 'agent_message',
        text: '已安装 1 个 Skill：frontend-design。',
      }),
    ]);
  });

  it('keeps the full multi-url user command and structured url list in install transcript items', () => {
    const input = [
      '/skills add',
      'https://github.com/anthropics/skills/tree/main/skills/pdf',
      'https://github.com/anthropics/skills/tree/main/skills/docx',
      '添加这两个skill',
    ].join(' ');
    const items = createSkillInstallTurnItems({
      turnId: 'turn-skills',
      input,
      installUrls: [
        'https://github.com/anthropics/skills/tree/main/skills/pdf',
        'https://github.com/anthropics/skills/tree/main/skills/docx',
      ],
      installed: [
        {
          name: 'pdf',
          path: 'E:/langchain/Suanlizi/skills/pdf',
          sourcePath: 'skills/pdf',
        },
        {
          name: 'docx',
          path: 'E:/langchain/Suanlizi/skills/docx',
          sourcePath: 'skills/docx',
        },
      ],
      skillsRoot: 'E:/langchain/Suanlizi/skills',
      agentText: '已安装 2 个 Skill：pdf, docx。',
      timestamp: '2026-06-09T08:00:00.000Z',
    });

    expect(items[0]).toMatchObject({
      type: 'user_message',
      text: input,
    });
    expect(items[1]).toMatchObject({
      type: 'tool_call',
      arguments: {
        input: 'https://github.com/anthropics/skills/tree/main/skills/pdf https://github.com/anthropics/skills/tree/main/skills/docx 添加这两个skill',
        urls: [
          'https://github.com/anthropics/skills/tree/main/skills/pdf',
          'https://github.com/anthropics/skills/tree/main/skills/docx',
        ],
      },
    });
  });
});
