import { describe, expect, it } from 'vitest';
import { Sandbox } from './sandbox.js';

describe('Sandbox exec policy', () => {
  it('matches glob and regex exec policy rules across command arguments', () => {
    const sandbox = new Sandbox({
      workspaceRoot: process.cwd(),
      execPolicyRules: [
        {
          pattern: ['rm', { glob: '**/dist' }],
          decision: 'forbidden',
          justification: 'do not remove build output',
        },
        {
          pattern: [{ regex: '^git$' }, { regex: '^(push|reset)$' }],
          decision: 'prompt',
        },
      ],
    });

    expect(sandbox.evaluateCommand('rm ./packages/foo/dist -rf')).toMatchObject({
      decision: 'forbidden',
    });
    expect(sandbox.evaluateCommand('git push origin main')).toMatchObject({
      decision: 'prompt',
    });
    expect(sandbox.evaluateCommand('git status')).toMatchObject({
      decision: null,
    });
  });
});

describe('Sandbox path boundaries', () => {
  it('does not treat sibling directories as inside workspace', () => {
    const sandbox = new Sandbox({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      level: 'workspace_write',
    });

    expect(sandbox.canRead('E:\\langchain\\Suanlizi\\README.md')).toBe(true);
    expect(sandbox.canRead('E:\\langchain\\Suanlizi2\\README.md')).toBe(false);
    expect(sandbox.canWrite('E:\\langchain\\Suanlizi2\\README.md')).toBe(false);
  });

  it('allows explicit additional read and write roots with path-aware matching', () => {
    const sandbox = new Sandbox({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      level: 'workspace_write',
      allowedReadPaths: ['E:\\langchain\\dexin-agent'],
      allowedWritePaths: ['E:\\langchain\\generated'],
    });

    expect(sandbox.canRead('E:\\langchain\\dexin-agent\\v1.docx')).toBe(true);
    expect(sandbox.canRead('E:\\langchain\\dexin-agent-old\\v1.docx')).toBe(false);
    expect(sandbox.canWrite('E:\\langchain\\generated\\out.txt')).toBe(true);
    expect(sandbox.canWrite('E:\\langchain\\generated-old\\out.txt')).toBe(false);
  });
});

describe('Sandbox network allowlist', () => {
  it('allows only configured network hosts when network is otherwise enabled', () => {
    const sandbox = new Sandbox({
      workspaceRoot: process.cwd(),
      networkAllowed: true,
      networkAllowlist: ['api.github.com', '*.example.com'],
    });

    expect(sandbox.canNetwork('https://api.github.com/repos/example/project')).toBe(true);
    expect(sandbox.canNetwork('https://docs.example.com/page')).toBe(true);
    expect(sandbox.canNetwork('https://evil.test/page')).toBe(false);
  });
});
