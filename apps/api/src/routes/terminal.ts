import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as pty from 'node-pty';
import { readJson, sendError, sendJson } from '../shared/http.js';

const execAsync = promisify(exec);
const MAX_COMMAND_LENGTH = 8_000;
const MAX_OUTPUT_BYTES = 1_024 * 1_024;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_PTY_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const CLOSED_SESSION_RETENTION_MS = 60_000;
const DEFAULT_PTY_COLS = 120;
const DEFAULT_PTY_ROWS = 32;
const MAX_OUTPUT_WAIT_MS = 1_000;

type TerminalRequest = {
  root?: unknown;
  command?: unknown;
};

type TerminalResult = {
  root: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type TerminalSession = {
  id: string;
  root: string;
  threadId: string;
  process: pty.IPty;
  output: string;
  outputBase: number;
  outputCursor: number;
  exited: boolean;
  exitCode: number | null;
  idleTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
  outputWaiters: Set<() => void>;
};

type TerminalSessionRequest = {
  root?: unknown;
  cols?: unknown;
  rows?: unknown;
  threadId?: unknown;
};

type TerminalInputRequest = {
  data?: unknown;
};

const terminalSessions = new Map<string, TerminalSession>();

function resolveTerminalRoot(rootInput: unknown): Promise<string> {
  const value = typeof rootInput === 'string' ? rootInput.trim() : '';
  if (!value) return Promise.reject(new Error('Workspace root is required'));
  return fs.stat(path.resolve(value)).then((stat) => {
    const root = path.resolve(value);
    if (!stat.isDirectory()) throw new Error('Workspace root is not a directory');
    return root;
  });
}

function ptyShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-Command',
        '$utf8 = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; chcp 65001 > $null',
      ],
    };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-i'] };
}

function touchTerminalSession(session: TerminalSession): void {
  if (session.exited) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (terminalSessions.get(session.id) === session) closeTerminalSession(session.id);
  }, SESSION_IDLE_TIMEOUT_MS);
  session.idleTimer.unref?.();
}

function scheduleClosedSessionCleanup(session: TerminalSession): void {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    if (terminalSessions.get(session.id) === session && session.exited) {
      terminalSessions.delete(session.id);
    }
  }, CLOSED_SESSION_RETENTION_MS);
  session.cleanupTimer.unref?.();
}

function appendTerminalOutput(session: TerminalSession, data: string): void {
  session.output += data;
  session.outputCursor += data.length;
  if (session.output.length > MAX_PTY_OUTPUT_BYTES) {
    const discarded = session.output.length - MAX_PTY_OUTPUT_BYTES;
    session.output = session.output.slice(discarded);
    session.outputBase += discarded;
  }
  notifyTerminalOutput(session);
}

function notifyTerminalOutput(session: TerminalSession): void {
  const waiters = [...session.outputWaiters];
  session.outputWaiters.clear();
  for (const wake of waiters) wake();
}

function waitForTerminalOutput(session: TerminalSession, cursor: number, waitMs: number): Promise<void> {
  if (waitMs <= 0 || session.exited || cursor < session.outputCursor) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timeout);
      session.outputWaiters.delete(wake);
      resolve();
    };
    const timeout = setTimeout(wake, waitMs);
    timeout.unref?.();
    session.outputWaiters.add(wake);
  });
}

function closeTerminalSession(id: string): void {
  const session = terminalSessions.get(id);
  if (!session) return;
  const wasExited = session.exited;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.exited = true;
  notifyTerminalOutput(session);
  if (!wasExited) {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(session.process.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    } else {
      try { session.process.kill(); } catch { /* process may have exited already */ }
    }
  }
  scheduleClosedSessionCleanup(session);
}

function createTerminalSession(root: string, threadId: string, cols: number, rows: number): TerminalSession {
  const shell = ptyShell();
  const child = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: root,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    useConpty: true,
  });
  const session: TerminalSession = {
    id: randomUUID(),
    root,
    threadId,
    process: child,
    output: '',
    outputBase: 0,
    outputCursor: 0,
    exited: false,
    exitCode: null,
    idleTimer: null,
    cleanupTimer: null,
    outputWaiters: new Set(),
  };
  child.onData((data) => appendTerminalOutput(session, data));
  child.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    scheduleClosedSessionCleanup(session);
    notifyTerminalOutput(session);
  });
  terminalSessions.set(session.id, session);
  touchTerminalSession(session);
  return session;
}

async function handleTerminalSessionRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}): Promise<boolean> {
  const match = options.url.pathname.match(/^\/api\/terminal\/session(?:\/([^/]+)(?:\/(input|output|resize))?)?$/);
  if (!match) return false;
  const sessionId = match[1];
  const operation = match[2];

  try {
    if (options.req.method === 'POST' && !sessionId) {
      const body = await readJson<TerminalSessionRequest>(options.req);
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
      if (!threadId) {
        sendError(options.res, 400, 'Thread id is required');
        return true;
      }
      const root = await resolveTerminalRoot(body.root);
      const cols = clampDimension(body.cols, DEFAULT_PTY_COLS, 20, 400);
      const rows = clampDimension(body.rows, DEFAULT_PTY_ROWS, 4, 200);
      const session = createTerminalSession(root, threadId, cols, rows);
      sendJson(options.res, 200, { sessionId: session.id, root, threadId, cols, rows });
      return true;
    }
    if (!sessionId || (!operation && options.req.method !== 'DELETE')) {
      sendError(options.res, 405, 'Unsupported terminal session operation');
      return true;
    }
    const session = terminalSessions.get(sessionId);
    if (!session) {
      sendError(options.res, 404, 'Terminal session not found');
      return true;
    }
    const requestThreadId = options.url.searchParams.get('threadId')?.trim() ?? '';
    if (!requestThreadId || requestThreadId !== session.threadId) {
      sendError(options.res, 403, 'Terminal session is outside thread scope');
      return true;
    }
    touchTerminalSession(session);
    if (options.req.method === 'DELETE' && operation === undefined) {
      closeTerminalSession(sessionId);
      sendJson(options.res, 200, { ok: true });
      return true;
    }
    if (options.req.method === 'POST' && operation === 'input') {
      const body = await readJson<TerminalInputRequest>(options.req);
      const data = typeof body.data === 'string' ? body.data : '';
      if (data.length > 64_000) {
        sendError(options.res, 413, 'Terminal input is too long');
        return true;
      }
      if (!session.exited && data) session.process.write(data);
      sendJson(options.res, 200, { ok: true });
      return true;
    }
    if (options.req.method === 'POST' && operation === 'resize') {
      const body = await readJson<TerminalSessionRequest>(options.req);
      session.process.resize(clampDimension(body.cols, DEFAULT_PTY_COLS, 20, 400), clampDimension(body.rows, DEFAULT_PTY_ROWS, 4, 200));
      sendJson(options.res, 200, { ok: true });
      return true;
    }
    if (options.req.method === 'GET' && operation === 'output') {
      const requestedCursor = Number(options.url.searchParams.get('cursor') ?? 0);
      const cursor = Number.isFinite(requestedCursor) ? Math.max(0, Math.floor(requestedCursor)) : 0;
      const waitMs = clampDimension(Number(options.url.searchParams.get('waitMs') ?? 0), 0, 0, MAX_OUTPUT_WAIT_MS);
      await waitForTerminalOutput(session, cursor, waitMs);
      const start = cursor < session.outputBase ? 0 : Math.max(0, cursor - session.outputBase);
      sendJson(options.res, 200, {
        output: session.output.slice(start),
        cursor: session.outputCursor,
        exited: session.exited,
        exitCode: session.exitCode,
      });
      return true;
    }
    sendError(options.res, 405, 'Unsupported terminal session operation');
    return true;
  } catch (error) {
    sendError(options.res, 400, error instanceof Error ? error.message : String(error));
    return true;
  }
}

function clampDimension(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 执行终端面板提交的命令，工作目录始终限制在用户选择的项目根目录。 */
export async function handleTerminalRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}): Promise<boolean> {
  if (await handleTerminalSessionRoute(options)) return true;
  if (options.req.method !== 'POST' || options.url.pathname !== '/api/terminal/execute') return false;

  try {
    const body = await readJson<TerminalRequest>(options.req);
    const rootInput = typeof body.root === 'string' ? body.root.trim() : '';
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!rootInput) {
      sendError(options.res, 400, 'Workspace root is required');
      return true;
    }
    if (!command) {
      sendError(options.res, 400, 'Command is required');
      return true;
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      sendError(options.res, 413, `Command is too long (maximum ${MAX_COMMAND_LENGTH} characters)`);
      return true;
    }

    const root = path.resolve(rootInput);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      sendError(options.res, 400, 'Workspace root is not a directory');
      return true;
    }

    try {
      const result = await execAsync(command, {
        cwd: root,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      const response: TerminalResult = {
        root,
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      };
      sendJson(options.res, 200, response);
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      const code = typeof failure.code === 'number' ? failure.code : 1;
      const response: TerminalResult = {
        root,
        command,
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        stderr: typeof failure.stderr === 'string' ? failure.stderr : (error instanceof Error ? error.message : String(error)),
        exitCode: code,
      };
      sendJson(options.res, 200, response);
    }
    return true;
  } catch (error) {
    sendError(options.res, 400, error instanceof Error ? error.message : String(error));
    return true;
  }
}
