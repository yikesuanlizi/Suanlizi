import type {
  LoadedSkill,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillModule,
  SkillParameter,
  SkillRollbackReason,
} from '@suanlizi/extensions';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SkillExecutorOptions {
  logger?: SkillExecutionContext['logger'];
  callTool?: SkillExecutionContext['callTool'];
  readFile?: SkillExecutionContext['readFile'];
  writeFile?: SkillExecutionContext['writeFile'];
  extra?: Record<string, unknown>;
}

export class SkillExecutor {
  private readonly options: SkillExecutorOptions;

  constructor(options: SkillExecutorOptions = {}) {
    this.options = options;
  }

  async execute(
    skill: LoadedSkill,
    params: Record<string, unknown>,
    ctx: {
      workspaceRoot: string;
      threadId: string;
      turnId?: string;
      signal?: AbortSignal;
      logger?: SkillExecutionContext['logger'];
      callTool?: SkillExecutionContext['callTool'];
      readFile?: SkillExecutionContext['readFile'];
      writeFile?: SkillExecutionContext['writeFile'];
      extra?: Record<string, unknown>;
    },
  ): Promise<SkillExecutionResult> {
    if (skill.kind !== 'executable') {
      return {
        success: false,
        error: { message: `Skill "${skill.name}" is a prompt-only skill and has no executable entry point. Read its SKILL.md body and follow the instructions.`, code: 'SKILL_PROMPT_ONLY' },
        durationMs: 0,
      };
    }
    if (!skill.module) {
      return {
        success: false,
        error: { message: `Skill "${skill.name}" module not loaded (entry: ${skill.entryPath}). Check server logs for load errors.`, code: 'SKILL_MODULE_NOT_LOADED' },
        durationMs: 0,
      };
    }

    const paramErrors = this.validateParams(skill, params, skill.module);
    if (paramErrors.length > 0) {
      return {
        success: false,
        error: { message: `Invalid parameters for skill "${skill.name}": ${paramErrors.join('; ')}`, code: 'SKILL_INVALID_PARAMS' },
        durationMs: 0,
      };
    }

    const filledParams = this.applyDefaults(skill, params);

    const logger = ctx.logger
      ?? this.options.logger
      ?? createTaggedLogger(skill.name, ctx.threadId, ctx.turnId);
    const readFile = ctx.readFile ?? this.options.readFile ?? createWorkspaceReader(ctx.workspaceRoot);
    const writeFile = ctx.writeFile ?? this.options.writeFile ?? createWorkspaceWriter(ctx.workspaceRoot);
    const skillCtx: SkillExecutionContext = {
      workspaceRoot: ctx.workspaceRoot,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      logger,
      signal: ctx.signal,
      callTool: ctx.callTool ?? this.options.callTool,
      readFile,
      writeFile,
      extra: ctx.extra ?? this.options.extra,
    };

    const timeoutMs = skill.timeoutMs ?? 30_000;
    const start = Date.now();
    const mod = skill.module;

    let backupFiles: Array<{ path: string; content: string }> | undefined;
    let prepared = false;

    const fail = async (message: string, code: string, rollbackReason: SkillRollbackReason, stack?: string): Promise<SkillExecutionResult> => {
      let rolledBack = false;
      if (mod.rollback && (prepared || backupFiles)) {
        try {
          await runWithTimeout(
            () => mod.rollback!(filledParams, rollbackReason, backupFiles, skillCtx),
            Math.min(timeoutMs, 10_000),
            ctx.signal,
          );
          rolledBack = true;
        } catch (rbErr) {
          logger.warn(`rollback failed for skill "${skill.name}": ${(rbErr as Error).message}`);
        }
      }
      return {
        success: false,
        error: { message, code, stack },
        durationMs: Date.now() - start,
        prepared,
        rolledBack,
        rollbackReason,
      };
    };

    try {
      if (mod.prepare) {
        logger.info(`preparing skill "${skill.name}"`);
        const prepResult = await runWithTimeout(
          () => mod.prepare!(filledParams, skillCtx),
          timeoutMs,
          ctx.signal,
        );
        if (!prepResult.ok) {
          return fail(
            `Skill "${skill.name}" prepare failed: ${prepResult.error ?? 'unknown error'}`,
            'SKILL_PREPARE_FAILED',
            'prepare_failed',
          );
        }
        backupFiles = prepResult.backupFiles;
        prepared = true;
        logger.info(`skill "${skill.name}" prepared successfully`);
      }

      logger.info(`executing skill "${skill.name}"`);
      const raw = await runWithTimeout(
        () => mod.execute(filledParams, skillCtx),
        timeoutMs,
        ctx.signal,
      );
      const executeSuccess = raw?.success !== false && !raw?.error;
      if (!executeSuccess) {
        const errMsg = raw?.error?.message ?? `Skill "${skill.name}" execution failed`;
        return fail(errMsg, raw?.error?.code ?? 'SKILL_EXECUTION_ERROR', 'execute_failed', raw?.error?.stack);
      }

      if (mod.verify) {
        logger.info(`verifying skill "${skill.name}" result`);
        const verifyResult = await runWithTimeout(
          () => mod.verify!(filledParams, raw?.output, skillCtx),
          Math.min(timeoutMs, 15_000),
          ctx.signal,
        );
        if (!verifyResult.ok) {
          return fail(
            `Skill "${skill.name}" verification failed: ${verifyResult.error ?? 'verification did not pass'}`,
            'SKILL_VERIFY_FAILED',
            'verify_failed',
          );
        }
        logger.info(`skill "${skill.name}" verified successfully`);
      }

      const normalized: SkillExecutionResult = {
        durationMs: 0,
        ...(raw as object),
        success: true,
        prepared,
        rolledBack: false,
      } as SkillExecutionResult;
      return {
        ...normalized,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const error = err as Error;
      const isTimeout = error.name === 'TimeoutError' || error.message?.includes('timed out');
      if (isTimeout) {
        return fail(
          `Skill "${skill.name}" timed out after ${timeoutMs}ms`,
          'SKILL_TIMEOUT',
          'aborted',
          error.stack,
        );
      }
      if (ctx.signal?.aborted) {
        return fail(
          `Skill "${skill.name}" aborted`,
          'SKILL_ABORTED',
          'aborted',
          error.stack,
        );
      }
      return fail(
        error.message ?? String(err),
        'SKILL_EXECUTION_ERROR',
        'execute_failed',
        error.stack,
      );
    }
  }

  private validateParams(skill: LoadedSkill, params: Record<string, unknown>, mod: SkillModule): string[] {
    if (mod.validateParams) {
      const result = mod.validateParams(params);
      if (!result.valid) return result.errors ?? ['validation failed'];
      return [];
    }
    const errors: string[] = [];
    const declared = skill.parameters ?? mod.parameters ?? [];
    for (const p of declared) {
      const value = params[p.name];
      if (value === undefined || value === null) {
        if (p.required && p.default === undefined) {
          errors.push(`missing required parameter "${p.name}"`);
        }
        continue;
      }
      if (!typeMatches(p.type, value)) {
        errors.push(`parameter "${p.name}" expected ${p.type} got ${typeof value}`);
      }
      if (p.enum && !p.enum.includes(value)) {
        errors.push(`parameter "${p.name}" must be one of: ${p.enum.join(', ')}`);
      }
    }
    return errors;
  }

  private applyDefaults(skill: LoadedSkill, params: Record<string, unknown>): Record<string, unknown> {
    const result = { ...params };
    const declared = skill.parameters ?? skill.module?.parameters ?? [];
    for (const p of declared) {
      if (result[p.name] === undefined && p.default !== undefined) {
        result[p.name] = p.default;
      }
    }
    return result;
  }
}

function typeMatches(type: SkillParameter['type'], value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && !Number.isNaN(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    default: return true;
  }
}

function runWithTimeout<T>(fn: () => Promise<T> | T, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`Execution timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('Execution aborted'));
        return;
      }
      signal.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Execution aborted'));
      }, { once: true });
    }

    Promise.resolve()
      .then(fn)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

function createTaggedLogger(skillName: string, threadId: string, turnId?: string): SkillExecutionContext['logger'] {
  const tag = `[skill:${skillName}${turnId ? ` turn=${turnId.slice(0, 8)}` : ` thread=${threadId.slice(0, 8)}`}]`;
  return {
    info: (msg: string, meta?: Record<string, unknown>) => console.log(`${tag} ${msg}`, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`${tag} ${msg}`, meta ?? ''),
    error: (msg: string, meta?: Record<string, unknown>) => console.error(`${tag} ${msg}`, meta ?? ''),
    debug: (msg: string, meta?: Record<string, unknown>) => console.debug(`${tag} ${msg}`, meta ?? ''),
  };
}

function createWorkspaceReader(workspaceRoot: string): (filePath: string) => Promise<string> {
  return async (filePath: string) => {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
    const rel = path.relative(workspaceRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`readFile: path escapes workspace: ${filePath}`);
    }
    return fs.readFile(abs, 'utf-8');
  };
}

function createWorkspaceWriter(workspaceRoot: string): (filePath: string, content: string) => Promise<void> {
  return async (filePath: string, content: string) => {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
    const rel = path.relative(workspaceRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`writeFile: path escapes workspace: ${filePath}`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  };
}
