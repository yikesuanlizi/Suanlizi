import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCanonicalToolPath, resolveToolPathAccess } from './accessGuard.js';

describe('resolveToolPathAccess', () => {
  it('resolves relative paths inside workspace', () => {
    const request = resolveToolPathAccess({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      path: 'README.md',
      access: 'read',
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolName: 'read_file',
      description: 'read file',
    });

    expect(request.target).toEqual({ kind: 'path', path: 'E:\\langchain\\Suanlizi\\README.md' });
  });

  it('does not rewrite absolute external paths into the workspace', () => {
    const request = resolveToolPathAccess({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      path: 'E:\\langchain\\dexin-agent\\v1.docx',
      access: 'read',
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolName: 'read_document',
      description: 'read document',
    });

    expect(request.target).toEqual({ kind: 'path', path: 'E:\\langchain\\dexin-agent\\v1.docx' });
  });

  it('normalizes dot-dot traversal before runtime policy evaluation', () => {
    const request = resolveToolPathAccess({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      path: '..\\dexin-agent\\v1.docx',
      access: 'read',
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolName: 'read_document',
      description: 'read document',
    });

    expect(request.target).toEqual({ kind: 'path', path: 'E:\\langchain\\dexin-agent\\v1.docx' });
  });

  it('resolves a workspace-local directory link to its real external target', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'suanlizi-access-workspace-'));
    const external = await mkdtemp(path.join(tmpdir(), 'suanlizi-access-external-'));
    const linkedDirectory = path.join(workspace, 'linked');
    await mkdir(path.join(external, 'nested'));
    await symlink(external, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(resolveCanonicalToolPath(workspace, path.join('linked', 'nested', 'report.txt')))
      .resolves.toBe(path.join(await realpath(external), 'nested', 'report.txt'));
  });
});
