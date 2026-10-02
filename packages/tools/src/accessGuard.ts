import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AccessDecision, AccessKind, AccessRequest } from '@suanlizi/protocol';
import type { ToolResult } from './registry.js';

export interface ResolveToolPathAccessInput {
  workspaceRoot: string;
  path: string;
  access: Extract<AccessKind, 'read' | 'write'>;
  threadId: string;
  turnId: string;
  toolName: string;
  toolCallId?: string;
  description: string;
}

export function resolveToolPath(workspaceRoot: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  return path.resolve(workspaceRoot, filePath);
}

/**
 * Resolve a tool path through every existing ancestor. `path.resolve()` alone
 * is insufficient because a workspace-local symlink can point outside the
 * workspace after policy evaluation.
 */
export async function resolveCanonicalToolPath(workspaceRoot: string, filePath: string): Promise<string> {
  const lexical = resolveToolPath(workspaceRoot, filePath);
  const missingSegments: string[] = [];
  let candidate = lexical;

  while (true) {
    try {
      const canonicalAncestor = await fs.realpath(candidate);
      return missingSegments.length === 0
        ? canonicalAncestor
        : path.resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

/** Reject a path whose canonical target changed between authorization and I/O. */
export async function assertCanonicalToolPathStable(workspaceRoot: string, approvedPath: string): Promise<void> {
  const current = await resolveCanonicalToolPath(workspaceRoot, approvedPath);
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(current) !== normalize(approvedPath)) {
    throw new Error('Path target changed after access approval');
  }
}

export function resolveToolPathAccess(input: ResolveToolPathAccessInput): AccessRequest {
  return {
    access: input.access,
    target: { kind: 'path', path: resolveToolPath(input.workspaceRoot, input.path) },
    threadId: input.threadId,
    turnId: input.turnId,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    description: input.description,
  };
}

export function toolResultFromAccessDecision(decision: AccessDecision): ToolResult {
  return {
    output: decision.justification,
    status: 'failed',
    error: {
      message: decision.justification,
      code: decision.decision === 'prompt' ? 'ACCESS_APPROVAL_REQUIRED' : 'ACCESS_DENIED',
    },
    data: { accessDecision: decision },
  };
}
