import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectBrainContextProvider } from './projectBrainContext.js';
import { scanLocalProject, hashArchitectureSummary } from './localProjectScanner.js';
import { createInitialAgentContext } from '../types.js';
import type { ProviderContext } from '../types.js';
import type { ProjectBrainEnricher, ArchitectureSummary, ProjectChangeDelta } from './projectBrainTypes.js';

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'suanlizi-pb-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-project',
    version: '1.0.0',
    main: 'dist/index.js',
    dependencies: { react: '^18.0.0' },
    devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0' },
    scripts: { start: 'node dist/index.js', build: 'tsc', dev: 'tsx src/index.ts' },
  }));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'src', 'components'));
  mkdirSync(join(dir, 'src', 'utils'));
  writeFileSync(join(dir, 'src', 'index.ts'), "console.log('hello');");
  writeFileSync(join(dir, 'src', 'components', 'App.tsx'), 'export const App = () => null;');
  writeFileSync(join(dir, 'src', 'utils', 'helpers.ts'), 'export const id = (x) => x;');
  writeFileSync(join(dir, 'README.md'), '# Test Project');
  return dir;
}

function makeProviderCtx(root: string, overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    threadId: 'thr_pb',
    turnId: 'turn_1',
    userInput: 'test',
    agentContext: createInitialAgentContext({ cwd: root, os: 'linux', shell: '/bin/bash' }),
    items: [],
    contextBudget: 4000,
    ...overrides,
  };
}

describe('scanLocalProject', () => {
  it('detects tech stack from package.json and tsconfig', () => {
    const dir = makeTempProject();
    try {
      const summary = scanLocalProject(dir);
      expect(summary).not.toBeNull();
      expect(summary!.language).toBe('typescript');
      expect(summary!.buildSystem).toBe('npm');
      expect(summary!.techStack).toContain('Vitest');
      expect(summary!.techStack).toContain('react');
      expect(summary!.modules.length).toBeGreaterThanOrEqual(2);
      expect(summary!.entryPoints.length).toBeGreaterThan(0);
      expect(summary!.keyPatterns).toContain('has README');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for non-existent or empty directory', () => {
    expect(scanLocalProject('/nonexistent/path/that/does/not/exist')).toBeNull();
  });
});

describe('hashArchitectureSummary', () => {
  it('produces stable hash for same input', () => {
    const a: ArchitectureSummary = {
      language: 'typescript', techStack: ['react'], modules: [], entryPoints: [],
      keyPatterns: [], generatedAt: 1,
    };
    const b: ArchitectureSummary = {
      language: 'typescript', techStack: ['react'], modules: [], entryPoints: [],
      keyPatterns: [], generatedAt: 2,
    };
    expect(hashArchitectureSummary(a)).toBe(hashArchitectureSummary(b));
  });

  it('differs for different architecture', () => {
    const a: ArchitectureSummary = {
      language: 'typescript', techStack: ['react'], modules: [], entryPoints: [],
      keyPatterns: [], generatedAt: 1,
    };
    const b: ArchitectureSummary = {
      language: 'python', techStack: ['django'], modules: [], entryPoints: [],
      keyPatterns: [], generatedAt: 1,
    };
    expect(hashArchitectureSummary(a)).not.toBe(hashArchitectureSummary(b));
  });
});

describe('ProjectBrainContextProvider', () => {
  it('injects full architecture on first turn', async () => {
    const dir = makeTempProject();
    try {
      const provider = new ProjectBrainContextProvider({ workspaceRoot: dir, rescanIntervalMs: 0 });
      const ctx = makeProviderCtx(dir);
      const result = await provider.provide(ctx);
      expect(Array.isArray(result)).toBe(false);
      const output = result as { chunks: { content: string; metadata: Record<string, unknown> }[]; contextPatch: unknown };
      expect(output.chunks).toHaveLength(1);
      expect(output.chunks[0]!.content).toContain('<project_brain>');
      expect(output.chunks[0]!.content).toContain('typescript');
      expect(output.chunks[0]!.metadata.mode).toBe('full');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects delta on second turn (no changes = risk_only or skip)', async () => {
    const dir = makeTempProject();
    try {
      const provider = new ProjectBrainContextProvider({
        workspaceRoot: dir,
        rescanIntervalMs: 0,
        riskOnlyTurnGap: 3,
      });
      const ctx = makeProviderCtx(dir, { turnId: 'turn_1' });
      await provider.provide(ctx);
      const ctx2 = makeProviderCtx(dir, { turnId: 'turn_2' });
      const result2 = await provider.provide(ctx2);
      if (Array.isArray(result2)) {
        expect(result2).toHaveLength(0);
      } else {
        expect(result2.chunks.length).toBeGreaterThan(0);
        expect(result2.chunks[0]?.metadata?.mode).not.toBe('full');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges enricher architecture data', async () => {
    const dir = makeTempProject();
    try {
      const enricher: ProjectBrainEnricher = {
        name: 'test-enricher',
        async getArchitecture(): Promise<Partial<ArchitectureSummary>> {
          return {
            framework: 'TestFramework',
            techStack: ['custom-plugin'],
            keyPatterns: ['enriched-pattern'],
          };
        },
      };
      const provider = new ProjectBrainContextProvider({
        workspaceRoot: dir,
        enrichers: [enricher],
        rescanIntervalMs: 0,
      });
      const ctx = makeProviderCtx(dir);
      const result = await provider.provide(ctx) as { chunks: { content: string }[] };
      expect(result.chunks[0]!.content).toContain('TestFramework');
      expect(result.chunks[0]!.content).toContain('custom-plugin');
      expect(result.chunks[0]!.content).toContain('enriched-pattern');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gracefully handles enricher failures', async () => {
    const dir = makeTempProject();
    try {
      const failingEnricher: ProjectBrainEnricher = {
        name: 'fail',
        async getArchitecture(): Promise<Partial<ArchitectureSummary>> {
          throw new Error('enricher down');
        },
      };
      const provider = new ProjectBrainContextProvider({
        workspaceRoot: dir,
        enrichers: [failingEnricher],
        rescanIntervalMs: 0,
      });
      const ctx = makeProviderCtx(dir);
      const result = await provider.provide(ctx);
      expect(Array.isArray(result)).toBe(false);
      const chunks = (result as { chunks: unknown[] }).chunks;
      expect(chunks).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('addEnricher registers post-construction', async () => {
    const dir = makeTempProject();
    try {
      const provider = new ProjectBrainContextProvider({ workspaceRoot: dir, rescanIntervalMs: 0 });
      let called = false;
      const enricher: ProjectBrainEnricher = {
        name: 'late',
        async getChangeDelta(): Promise<Partial<ProjectChangeDelta>> {
          called = true;
          return { riskAreas: [{ area: 'test', reason: 'from late enricher', severity: 'low' as const }] };
        },
      };
      provider.addEnricher(enricher);
      await provider.provide(makeProviderCtx(dir, { turnId: 't1' }));
      await provider.provide(makeProviderCtx(dir, { turnId: 't2' }));
      expect(called).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty when workspaceRoot is empty string', async () => {
    const provider = new ProjectBrainContextProvider({ workspaceRoot: '' });
    const ctx = makeProviderCtx('');
    const result = await provider.provide(ctx);
    expect(Array.isArray(result) ? result : (result as { chunks: unknown[] }).chunks).toHaveLength(0);
  });

  it('contextPatch includes project world data', async () => {
    const dir = makeTempProject();
    try {
      const provider = new ProjectBrainContextProvider({ workspaceRoot: dir, rescanIntervalMs: 0 });
      const ctx = makeProviderCtx(dir);
      const result = await provider.provide(ctx) as {
        chunks: unknown[];
        contextPatch: { world: { project: Record<string, unknown> } };
      };
      expect(result.contextPatch).toBeDefined();
      expect(result.contextPatch.world).toBeDefined();
      expect(result.contextPatch.world.project.language).toBe('typescript');
      expect(result.contextPatch.world.project.architectureHash).toBeTruthy();
      expect(Array.isArray(result.contextPatch.world.project.techStack)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maintains per-thread cache isolation between different threads', async () => {
    const dir = makeTempProject();
    try {
      const provider = new ProjectBrainContextProvider({
        workspaceRoot: dir,
        rescanIntervalMs: 0,
        riskOnlyTurnGap: 100,
        reinjectEveryTurns: 100,
      });

      const ctxThreadA1 = makeProviderCtx(dir, { threadId: 'thread_A', turnId: 'turn_A1' });
      const resultA1 = await provider.provide(ctxThreadA1) as { chunks: { metadata: Record<string, unknown> }[] };
      expect(resultA1.chunks[0]!.metadata.mode).toBe('full');

      const ctxThreadB1 = makeProviderCtx(dir, { threadId: 'thread_B', turnId: 'turn_B1' });
      const resultB1 = await provider.provide(ctxThreadB1) as { chunks: { metadata: Record<string, unknown> }[] };
      expect(resultB1.chunks[0]!.metadata.mode).toBe('full');

      const ctxThreadA2 = makeProviderCtx(dir, { threadId: 'thread_A', turnId: 'turn_A2' });
      const resultA2 = await provider.provide(ctxThreadA2);
      if (!Array.isArray(resultA2)) {
        expect(resultA2.chunks[0]?.metadata?.mode).not.toBe('full');
      }

      provider.resetThread('thread_A');
      const ctxThreadA3 = makeProviderCtx(dir, { threadId: 'thread_A', turnId: 'turn_A3' });
      const resultA3 = await provider.provide(ctxThreadA3) as { chunks: { metadata: Record<string, unknown> }[] };
      expect(resultA3.chunks[0]!.metadata.mode).toBe('full');

      const ctxThreadB2 = makeProviderCtx(dir, { threadId: 'thread_B', turnId: 'turn_B2' });
      const resultB2 = await provider.provide(ctxThreadB2);
      if (!Array.isArray(resultB2)) {
        expect(resultB2.chunks[0]?.metadata?.mode).not.toBe('full');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
