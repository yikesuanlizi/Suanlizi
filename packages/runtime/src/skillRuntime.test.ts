import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillExecutor } from './skillExecutor.js';
import { createUseSkillTool, USE_SKILL_TOOL_NAME } from './skillTool.js';
import type { LoadedSkill } from '@suanlizi/extensions';
import { discoverSkills, loadAllSkillModules } from '@suanlizi/extensions';

function makePromptSkill(name: string): LoadedSkill {
  return {
    name,
    kind: 'prompt',
    description: `Prompt skill ${name}`,
    sourcePath: `/${name}/SKILL.md`,
    body: `# ${name}`,
    tags: [],
    version: '1.0.0',
  };
}

function makeExecutableSkill(
  name: string,
  executeImpl: (params: Record<string, unknown>, ctx: any) => Promise<any> | any,
  parameters: any = [{ name: 'input', type: 'string', required: true }],
): LoadedSkill {
  return {
    name,
    kind: 'executable',
    description: `Exec skill ${name}`,
    sourcePath: `/${name}/SKILL.md`,
    body: `# ${name}`,
    tags: [],
    version: '1.0.0',
    entryPath: `/${name}/index.js`,
    timeoutMs: 5000,
    parameters,
    module: { execute: executeImpl as any },
  };
}

describe('SkillExecutor', () => {
  it('rejects prompt-only skills', async () => {
    const executor = new SkillExecutor();
    const result = await executor.execute(makePromptSkill('guide'), {}, {
      workspaceRoot: '/tmp', threadId: 't1',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SKILL_PROMPT_ONLY');
  });

  it('rejects skill when module not loaded', async () => {
    const executor = new SkillExecutor();
    const skill = makeExecutableSkill('broken', async () => ({}));
    skill.module = undefined;
    const result = await executor.execute(skill, {}, { workspaceRoot: '/tmp', threadId: 't1' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SKILL_MODULE_NOT_LOADED');
  });

  it('validates required parameters', async () => {
    const executor = new SkillExecutor();
    const skill = makeExecutableSkill('echo', async ({ input }) => ({ output: input }), [
      { name: 'input', type: 'string', required: true },
    ]);
    const result = await executor.execute(skill, {}, { workspaceRoot: '/tmp', threadId: 't1' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SKILL_INVALID_PARAMS');
  });

  it('applies default values when params are missing', async () => {
    const executor = new SkillExecutor();
    let received: any;
    const skill = makeExecutableSkill('greet', async (params) => { received = params; return { output: `hi ${params.name}` }; }, [
      { name: 'name', type: 'string', required: false, default: 'world' },
    ]);
    const result = await executor.execute(skill, {}, { workspaceRoot: '/tmp', threadId: 't1' });
    expect(result.success).toBe(true);
    expect(received.name).toBe('world');
    expect(result.output).toBe('hi world');
  });

  it('executes skill and returns success result', async () => {
    const executor = new SkillExecutor();
    const skill = makeExecutableSkill('add', async ({ a, b }) => ({ output: Number(a) + Number(b), summary: `sum=${Number(a) + Number(b)}` }), [
      { name: 'a', type: 'number', required: true },
      { name: 'b', type: 'number', required: true },
    ]);
    const result = await executor.execute(skill, { a: 2, b: 3 }, { workspaceRoot: '/tmp', threadId: 't1' });
    expect(result.success).toBe(true);
    expect(result.output).toBe(5);
    expect(result.summary).toBe('sum=5');
    expect(typeof result.durationMs).toBe('number');
  });

  it('enforces timeout for slow skills', async () => {
    const executor = new SkillExecutor();
    const skill = makeExecutableSkill('slow', async () => new Promise((r) => setTimeout(() => r({ output: 'done' }), 2000)));
    skill.timeoutMs = 100;
    const result = await executor.execute(skill, { input: 'x' }, { workspaceRoot: '/tmp', threadId: 't1' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SKILL_TIMEOUT');
  }, 10_000);

  it('catches skill errors and returns failure', async () => {
    const executor = new SkillExecutor();
    const skill = makeExecutableSkill('boom', async () => { throw new Error('kaboom'); });
    const result = await executor.execute(skill, { input: 'x' }, { workspaceRoot: '/tmp', threadId: 't1' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('kaboom');
  });

  it('provides scoped readFile/writeFile via ctx', async () => {
    const executor = new SkillExecutor();
    let receivedCtx: any;
    const skill = makeExecutableSkill('io', async (_params, ctx) => {
      receivedCtx = ctx;
      return { output: 'ok', summary: 'io ok' };
    }, []);
    const wsRoot = os.tmpdir();
    const result = await executor.execute(skill, {}, { workspaceRoot: wsRoot, threadId: 't1' });
    expect(result.success).toBe(true);
    expect(typeof receivedCtx.readFile).toBe('function');
    expect(typeof receivedCtx.writeFile).toBe('function');
    expect(typeof receivedCtx.logger.info).toBe('function');
  });
});

describe('createUseSkillTool', () => {
  it('fails when name is missing', async () => {
    const tool = createUseSkillTool({
      getSkills: () => [],
      executor: new SkillExecutor(),
      getWorkspaceRoot: () => '/tmp',
    });
    const result: any = await tool.execute({}, { workspaceRoot: '/tmp', threadId: 't1', turnId: 'u1', approved: false } as any);
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('INVALID_ARGS');
  });

  it('fails when skill is not found', async () => {
    const tool = createUseSkillTool({
      getSkills: () => [makePromptSkill('guide')],
      executor: new SkillExecutor(),
      getWorkspaceRoot: () => '/tmp',
    });
    const result: any = await tool.execute({ name: 'nope' }, { workspaceRoot: '/tmp', threadId: 't1', turnId: 'u1', approved: false } as any);
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('SKILL_NOT_FOUND');
  });

  it('invokes executor for executable skill', async () => {
    const skill = makeExecutableSkill('echo', async ({ input }) => ({ output: input, summary: `echoed ${input}` }));
    const tool = createUseSkillTool({
      getSkills: () => [skill],
      executor: new SkillExecutor(),
      getWorkspaceRoot: () => '/tmp',
    });
    const result: any = await tool.execute({ name: 'echo', params: { input: 'hello' } }, { workspaceRoot: '/tmp', threadId: 't1', turnId: 'u1', approved: false } as any);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('echoed hello');
  });

  it('registers with USE_SKILL_TOOL_NAME', () => {
    const tool = createUseSkillTool({ getSkills: () => [], executor: new SkillExecutor(), getWorkspaceRoot: () => '/tmp' });
    expect(tool.name).toBe(USE_SKILL_TOOL_NAME);
    expect(tool.requiredPolicy).toBe('workspace_write');
  });
});

describe('skillLoader discovery and module loading', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-skill-test-'));
    const greetDir = path.join(tmpDir, 'greet');
    await fs.mkdir(greetDir, { recursive: true });
    await fs.writeFile(path.join(greetDir, 'SKILL.md'), [
      '---',
      'name: greet',
      'version: 1.0.0',
      'description: Greet a user',
      'entry: index.js',
      'parameters_target_type: string',
      'parameters_target_required: true',
      'parameters_target_description: Who to greet',
      '---',
      '# Greet',
      'Greets the target.',
    ].join('\n'));
    await fs.writeFile(path.join(greetDir, 'index.js'), `module.exports = { async execute(params){ return { output: "hi " + params.target, summary: "greeted " + params.target, filesChanged:[] }; } };`);
    await fs.writeFile(path.join(tmpDir, 'notes.skill.md'), [
      '---',
      'name: notes',
      'version: 1.0.0',
      'description: Prompt-only notes',
      '---',
      '# Notes',
      'Just a prompt.',
    ].join('\n'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers both subdir and flat skill files', async () => {
    const { skills, errors } = await discoverSkills(tmpDir);
    expect(errors).toHaveLength(0);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['greet', 'notes']);
    const greet = skills.find((s) => s.name === 'greet')!;
    expect(greet.kind).toBe('executable');
    expect(greet.entryPath).toBeTruthy();
    expect(greet.parameters).toHaveLength(1);
    const notes = skills.find((s) => s.name === 'notes')!;
    expect(notes.kind).toBe('prompt');
  });

  it('loads executable module and execute returns expected output', async () => {
    const { skills } = await discoverSkills(tmpDir);
    const modErrors = await loadAllSkillModules(skills);
    expect(modErrors).toHaveLength(0);
    const greet = skills.find((s) => s.name === 'greet')!;
    expect(greet.module).toBeDefined();
    const executor = new SkillExecutor();
    const result = await executor.execute(greet, { target: 'world' }, { workspaceRoot: tmpDir, threadId: 't1' });
    expect(result.success).toBe(true);
    expect(result.summary).toContain('greeted world');
  });
});
