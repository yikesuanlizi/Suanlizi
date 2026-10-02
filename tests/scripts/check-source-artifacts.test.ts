import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findSourceArtifacts } from '../../scripts/check-source-artifacts.mjs';

describe('findSourceArtifacts', () => {
  it('finds nested TypeScript emit under package and app source roots', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await Promise.all([
        writeWorkspaceFile(workspaceRoot, 'packages/memory/src/nested/memory.js'),
        writeWorkspaceFile(workspaceRoot, 'packages/memory/src/nested/memory.js.map'),
        writeWorkspaceFile(workspaceRoot, 'apps/web/src/generated/view.d.ts'),
        writeWorkspaceFile(workspaceRoot, 'apps/web/src/generated/view.d.ts.map'),
      ]);

      await expect(findSourceArtifacts(workspaceRoot)).resolves.toEqual([
        'apps/web/src/generated/view.d.ts',
        'apps/web/src/generated/view.d.ts.map',
        'packages/memory/src/nested/memory.js',
        'packages/memory/src/nested/memory.js.map',
      ]);
    });
  });

  it('does not report handwritten TypeScript and TSX source files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await Promise.all([
        writeWorkspaceFile(workspaceRoot, 'packages/runtime/src/index.ts'),
        writeWorkspaceFile(workspaceRoot, 'apps/web/src/App.tsx'),
      ]);

      await expect(findSourceArtifacts(workspaceRoot)).resolves.toEqual([]);
    });
  });

  it('does not scan dist directories', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await Promise.all([
        writeWorkspaceFile(workspaceRoot, 'packages/runtime/dist/index.js'),
        writeWorkspaceFile(workspaceRoot, 'apps/web/dist/view.d.ts'),
      ]);

      await expect(findSourceArtifacts(workspaceRoot)).resolves.toEqual([]);
    });
  });

  it('treats missing package or app scope directories as empty', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeWorkspaceFile(workspaceRoot, 'packages/runtime/src/index.ts');

      await expect(findSourceArtifacts(workspaceRoot)).resolves.toEqual([]);
    });
  });
});

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'suanlizi-source-artifacts-'));
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeWorkspaceFile(workspaceRoot: string, relativePath: string): Promise<void> {
  const filePath = join(workspaceRoot, ...relativePath.split('/'));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, 'generated', 'utf8');
}
