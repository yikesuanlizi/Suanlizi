// TCP Sidecar 桥：把 Sidecar 协议（JSONL 帧）承载到 TCP 上，让跨进程的
// 浏览器命令客户端（API 进程的 BrowserTool）能驱动 Electron Main 中的
// ElectronWebContentsRuntime——完全复用 createSidecar/createSidecarClient 的
// 会话/取消/幂等/超时语义，无需新协议。
// — English: a TCP transport for the Sidecar protocol (JSONL frames) so an
//   out-of-process browser command client (the API process's BrowserTool) can
//   drive the ElectronWebContentsRuntime inside Electron Main — reusing every
//   createSidecar/createSidecarClient semantic (session, cancel, idempotency,
//   timeouts) without a new protocol.
import { connect, createServer, type Server, type Socket } from 'node:net';
import { createSidecar, type SidecarHandle } from './sidecar.js';
import type { SidecarTransport } from './sidecarClient.js';
import type { BrowserRuntimePort } from '../port.js';

// ─── 服务端 ──────────────────────────────────────────────────────────────────
// — English: server side.

export interface TcpSidecarServerOptions {
  port: number;
  // 每次桌面会话的 capability token：连接首帧必须携带它，校验通过才建 Sidecar。
  // — English: per-desktop-session capability token — the first frame of a
  //   connection must carry it; the Sidecar is only created after it checks out.
  authToken: string;
  // 每个连接创建其专用的浏览器 runtime（例如绑定当前活动 tab 的 view）。
  // — English: creates a dedicated browser runtime per connection (e.g. bound
  //   to the current active tab's view).
  createRuntime(context?: { taskId: string }): BrowserRuntimePort;
  releaseRuntime?(context: { taskId: string }): void;
  log?(line: string): void;
  host?: string;
}

export interface TcpSidecarServer {
  close(): Promise<void>;
  port(): number;
}

function authLineSummary(line: string): string {
  const trimmed = line.trim();
  return `len=${trimmed.length} first=${JSON.stringify(trimmed.slice(0, 24))} startsObject=${trimmed.startsWith('{')}`;
}

function frameSummary(line: string): string {
  try {
    const frame = JSON.parse(line) as Record<string, unknown>;
    const error = frame.error && typeof frame.error === 'object'
      ? frame.error as Record<string, unknown>
      : undefined;
    const type = typeof frame.type === 'string' ? frame.type : '<missing>';
    const id = typeof frame.id === 'string' ? frame.id : undefined;
    const frameId = typeof frame.frameId === 'string' ? frame.frameId : undefined;
    const action = typeof frame.action === 'string' ? frame.action : undefined;
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const status = typeof frame.status === 'string' ? frame.status : undefined;
    const payload = frame.payload;
    const payloadSummary = payload === undefined ? '' : ` payload=${JSON.stringify(payload).slice(0, 360)}`;
    return `type=${type}${action ? ` action=${action}` : ''}${id ? ` id=${id}` : ''}${frameId ? ` frameId=${frameId}` : ''}${status ? ` status=${status}` : ''}${code ? ` errorCode=${code}` : ''}${payloadSummary}`;
  } catch {
    return authLineSummary(line);
  }
}

// 服务端一次连接 = 一个 sidecar 会话（single-session 语义与进程模式一致）。
// — English: one connection = one sidecar session (same single-session
//   semantics as the process mode).
export async function createTcpSidecarServer(options: TcpSidecarServerOptions): Promise<TcpSidecarServer> {
  const log = options.log ?? ((): void => undefined);
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    log('[tcp-sidecar] connection accepted');
    socket.setEncoding('utf8');
    let buffer = '';
    let sidecar: SidecarHandle | null = null;
    // 认证状态：连接首帧必须是 auth 帧，通过后才进入 sidecar 帧阶段。
    // — English: auth gate — the first frame must be an auth frame; only then
    //   does the connection enter the sidecar-frame phase.
    let authenticated = false;
    let taskId: string | null = null;

    const transport: SidecarTransport = {
      sendLine(line: string): void {
        if (!socket.destroyed) {
          socket.write(`${line}\n`);
        }
      },
      onLine(_handler): void {
        // 服务端读方向由下方 socket 'data' 驱动。
        // — English: the server's read side is driven by socket data below.
      },
      close(): void {
        if (!socket.destroyed) {
          socket.end();
        }
      },
    };

    const deliver = (line: string): void => {
      if (!authenticated) {
        // 首帧认证：{"type":"auth","token":"..."}
        // — English: first-frame auth.
        try {
          const frame = JSON.parse(line) as { type?: string; token?: string; taskId?: string };
          if (
            frame.type === 'auth'
            && frame.token === options.authToken
            && typeof frame.taskId === 'string'
            && frame.taskId.trim() !== ''
          ) {
            taskId = frame.taskId;
            authenticated = true;
            try {
              sidecar = createSidecar({
                runtime: options.createRuntime({ taskId }),
                log: (l: string) => log(l),
              });
              transport.sendLine(JSON.stringify({ type: 'auth', ok: true }));
            } catch (err) {
              log(`[tcp-sidecar] createSidecar failed: ${String(err)}`);
              transport.sendLine(JSON.stringify({ type: 'auth', ok: false, error: 'runtime unavailable' }));
              socket.destroy();
            }
          } else {
            log(`[tcp-sidecar] auth rejected: type=${typeof frame.type === 'string' ? frame.type : '<missing>'} tokenLength=${typeof frame.token === 'string' ? frame.token.length : 0} expectedTokenLength=${options.authToken.length} hasTaskId=${typeof frame.taskId === 'string' && frame.taskId.trim() !== ''}`);
            transport.sendLine(JSON.stringify({ type: 'auth', ok: false }));
            socket.destroy();
          }
        } catch {
          log(`[tcp-sidecar] auth frame malformed: ${authLineSummary(line)}`);
          transport.sendLine(JSON.stringify({ type: 'auth', ok: false }));
          socket.destroy();
        }
        return;
      }
      if (sidecar === null) {
        log(`[tcp-sidecar] ignoring line before sidecar ready: ${line.slice(0, 40)}`);
        return;
      }
      void sidecar.handleLine(line).then((frames) => {
        for (const frame of frames) {
          transport.sendLine(frame);
        }
      }).catch((err: unknown) => {
        log(`[tcp-sidecar] handleLine error: ${String(err)}`);
      });
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== '') {
          deliver(line);
        }
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      void sidecar?.close('client disconnected').catch(() => undefined);
      sidecar = null;
      if (taskId !== null) {
        options.releaseRuntime?.({ taskId });
        taskId = null;
      }
    });
    socket.on('error', (err: Error) => {
      log(`[tcp-sidecar] socket error: ${String(err)}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve());
  });
  const boundPort = (server.address() as { port: number }).port;

  return {
    async close(): Promise<void> {
      for (const socket of [...sockets]) {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    port(): number {
      return boundPort;
    },
  };
}

// ─── 客户端 ──────────────────────────────────────────────────────────────────
// — English: client side.

// TCP 版 SidecarTransport：连接 127.0.0.1:<port>，按行收发 JSONL 帧。
// 先完成 auth 握手（首帧携带 capability token），通过后 ready 才 resolve。
// — English: TCP SidecarTransport — connects to 127.0.0.1:<port> and exchanges
//   JSONL frames line by line. It performs the auth handshake first (the first
//   frame carries the capability token); ready resolves only after that passes.
export function createTcpSidecarTransport(options: { host?: string; port: number; authToken: string; taskId: string }): {
  transport: SidecarTransport;
  ready: Promise<void>;
  close(): void;
} {
  const socket = connect({ host: options.host ?? '127.0.0.1', port: options.port });
  socket.setEncoding('utf8');
  const debug = process.env.SUANLIZI_BROWSER_DEBUG === '1';
  const debugLog = (message: string): void => {
    if (debug) console.log(`[tcp-sidecar-client] ${message}`);
  };
  let buffer = '';
  let lineHandler: ((line: string) => void) | null = null;
  let authResolved = false;

  socket.on('data', (chunk: Buffer) => {
    debugLog(`data chunk length=${chunk.length}`);
    buffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim() === '') continue;
      if (!authResolved) {
        // 握手响应：{"type":"auth","ok":true}
        // — English: handshake response.
        try {
          const frame = JSON.parse(line) as { type?: string; ok?: boolean };
          if (frame.type === 'auth') {
            authResolved = true;
            if (frame.ok === true) {
              authReadyResolve();
            } else {
              authReadyReject(new Error('browser auth rejected'));
              socket.destroy();
            }
          }
        } catch {
          authReadyReject(new Error('browser auth response malformed'));
          socket.destroy();
        }
        continue;
      }
      debugLog(`frame ${frameSummary(line)}`);
      if (lineHandler !== null) {
        lineHandler(line);
      }
    }
  });

  let authReadyResolve: () => void = () => undefined;
  let authReadyReject: (err: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    authReadyResolve = resolve;
    authReadyReject = reject;
  });

  socket.once('connect', () => {
    // 首帧 = auth 握手。
    // — English: the first frame is the auth handshake.
    const line = `${JSON.stringify({ type: 'auth', token: options.authToken, taskId: options.taskId })}\n`;
    debugLog(`connected port=${options.port} tokenLength=${options.authToken.length} taskId=${options.taskId}`);
    socket.write(line, () => debugLog(`auth frame write callback length=${line.length}`));
  });
  socket.once('error', (err: Error) => {
    debugLog(`socket error=${err.message}`);
    if (!authResolved) {
      authReadyReject(err);
    }
  });
  socket.once('close', () => {
    debugLog(`socket closed authResolved=${authResolved}`);
    if (!authResolved) {
      authReadyReject(new Error('browser auth connection closed before handshake'));
    }
  });

  const transport: SidecarTransport = {
    sendLine(line: string): void {
      if (!socket.destroyed) {
        socket.write(`${line}\n`);
      }
    },
    onLine(handler: (line: string) => void): void {
      lineHandler = handler;
    },
    close(): void {
      if (!socket.destroyed) {
        socket.end();
      }
    },
  };

  return {
    transport,
    ready,
    close(): void {
      transport.close();
    },
  };
}
