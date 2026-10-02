/**
 * GitNexusService — 管理 gitnexus serve 的生命周期和健康检查。
 *
 * 三层架构：
 * - serve HTTP 是 UI 和后端 API 的主查询层（本文件管理）
 * - MCP 是 Agent 的结构化工具层（由 McpRuntimeManager 管理）
 * - CLI/npx 是索引运维层（由 gitnexus_analyze 工具触发）
 *
 * 本服务负责：
 * 1. 探测已有的 gitnexus serve 实例
 * 2. 按需启动新的 serve 实例
 * 3. 健康检查和状态追踪
 * 4. 提供统一的 HTTP 查询入口
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminateProcessTree } from '@suanlizi/tools';

const DEFAULT_SERVE_PORT = 4747;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const PROBE_PORTS = [4747, 7337, 3333];
const HEALTH_PATH = '/api/health';

export interface GitNexusServeStatus {
  ok: boolean;
  ready: boolean;
  serveUrl?: string;
  reason?: string;
  repoCount?: number;
}

export interface GitNexusServiceOptions {
  /** 是否允许自动启动 serve（默认 false，需显式开启） */
  autoStart?: boolean;
  /** 指定 serve 端口 */
  port?: number;
  /** serve 启动命令（默认 gitnexus） */
  command?: string;
}

class GitNexusServiceImpl {
  private serveUrl: string | null = null;
  private serveProcess: ChildProcessWithoutNullStreams | null = null;
  private healthCheckPromise: Promise<GitNexusServeStatus> | null = null;
  private lastHealthCheck = 0;
  private readonly healthCheckIntervalMs = 10_000;
  private autoStart: boolean;
  private port: number;
  private command: string;

  constructor(options: GitNexusServiceOptions = {}) {
    this.autoStart = options.autoStart ?? false;
    this.port = options.port ?? DEFAULT_SERVE_PORT;
    this.command = options.command ?? 'gitnexus';
  }

  /**
   * 获取 serve URL；如果 serve 不可用且 autoStart 为 true，则尝试启动。
   */
  async getServeUrl(): Promise<string | null> {
    if (this.serveUrl) {
      const ok = await this.checkHealth(this.serveUrl);
      if (ok) return this.serveUrl;
      this.serveUrl = null;
    }

    // 探测已有实例
    const probed = await this.probeExistingServe();
    if (probed) {
      this.serveUrl = probed;
      return probed;
    }

    // 按需启动
    if (this.autoStart) {
      const started = await this.startServe();
      if (started) {
        this.serveUrl = `http://localhost:${this.port}`;
        return this.serveUrl;
      }
    }

    return null;
  }

  /**
   * 获取服务状态（带缓存，避免频繁探测）。
   */
  async getStatus(): Promise<GitNexusServeStatus> {
    const now = Date.now();
    if (this.healthCheckPromise && now - this.lastHealthCheck < this.healthCheckIntervalMs) {
      return this.healthCheckPromise;
    }
    this.lastHealthCheck = now;
    this.healthCheckPromise = this.runHealthCheck();
    return this.healthCheckPromise;
  }

  /**
   * 通过 serve HTTP 执行查询。
   * 返回 null 表示 serve 不可用，调用方应 fallback 到 MCP。
   */
  async query<T = unknown>(path: string, params?: Record<string, string>): Promise<T | null> {
    const url = await this.getServeUrl();
    if (!url) return null;

    const searchParams = params ? '?' + new URLSearchParams(params).toString() : '';
    const fullUrl = `${url}${path}${searchParams}`;

    try {
      const response = await fetch(fullUrl, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) return null;
      return await response.json() as T;
    } catch {
      return null;
    }
  }

  /**
   * 通过 serve HTTP 执行 POST 请求。
   */
  async postQuery<T = unknown>(path: string, body: unknown): Promise<T | null> {
    const url = await this.getServeUrl();
    if (!url) return null;

    try {
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) return null;
      return await response.json() as T;
    } catch {
      return null;
    }
  }

  /**
   * 停止由本服务启动的 serve 进程。
   */
  async stop(): Promise<void> {
    if (this.serveProcess) {
      terminateProcessTree(this.serveProcess);
      this.serveProcess = null;
    }
    this.serveUrl = null;
  }

  // ─── 内部方法 ──────────────────────────────────────────────────────────

  /** 检查指定 URL 的 serve 是否健康 */
  private async checkHealth(url: string): Promise<boolean> {
    try {
      const response = await fetch(`${url}${HEALTH_PATH}`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async runHealthCheck(): Promise<GitNexusServeStatus> {
    const url = this.serveUrl;
    if (!url) {
      // 尝试探测
      const probed = await this.probeExistingServe();
      if (!probed) {
        return { ok: false, ready: false, reason: 'serve not available' };
      }
      this.serveUrl = probed;
      return this.runHealthCheck();
    }

    try {
      const response = await fetch(`${url}${HEALTH_PATH}`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, ready: false, serveUrl: url, reason: `HTTP ${response.status}` };
      }
      // /api/health 返回 200 即表示健康；repoCount 需额外查 /api/repos
      let repoCount: number | undefined;
      try {
        const reposResp = await fetch(`${url}/api/repos`, {
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        if (reposResp.ok) {
          const reposData = await reposResp.json() as { repos?: unknown[] };
          repoCount = Array.isArray(reposData.repos) ? reposData.repos.length : 0;
        }
      } catch {
        // repo count 是可选字段
      }
      return {
        ok: true,
        ready: true,
        serveUrl: url,
        repoCount,
      };
    } catch (error) {
      return {
        ok: false,
        ready: false,
        serveUrl: url,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async probeExistingServe(): Promise<string | null> {
    const ports = [this.port, ...PROBE_PORTS.filter((p) => p !== this.port)];
    const probes = ports.map(async (port) => {
      const url = `http://localhost:${port}`;
      try {
        const response = await fetch(`${url}${HEALTH_PATH}`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (response.ok) return url;
      } catch {
        // not running on this port
      }
      return null;
    });

    const results = await Promise.allSettled(probes);
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        return result.value;
      }
    }
    return null;
  }

  private async startServe(): Promise<boolean> {
    if (this.serveProcess) return true;

    return new Promise((resolve) => {
      try {
        // 优先使用全局安装的 gitnexus，fallback 到 npx
        const useNpx = this.command === 'npx';
        const actualCommand = useNpx ? 'npx' : this.command;
        const actualArgs = useNpx
          ? ['-y', 'gitnexus@latest', 'serve', '--port', String(this.port)]
          : ['serve', '--port', String(this.port)];

        const child = spawn(actualCommand, actualArgs, {
          stdio: 'pipe',
          windowsHide: true,
          shell: process.platform === 'win32',
        });

        let started = false;
        const timeout = setTimeout(() => {
          if (!started) {
            try { child.kill(); } catch { /* ignore */ }
            resolve(false);
          }
        }, 10_000);

        child.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (!started && (text.includes('listening') || text.includes('started') || text.includes('ready'))) {
            started = true;
            clearTimeout(timeout);
            resolve(true);
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (!started && (text.includes('listening') || text.includes('started') || text.includes('ready'))) {
            started = true;
            clearTimeout(timeout);
            resolve(true);
          }
        });

        child.on('error', () => {
          if (!started) {
            clearTimeout(timeout);
            resolve(false);
          }
        });

        child.on('exit', () => {
          if (!started) {
            clearTimeout(timeout);
            resolve(false);
          }
          this.serveProcess = null;
        });

        this.serveProcess = child;
      } catch {
        resolve(false);
      }
    });
  }
}

// 单例
let serviceInstance: GitNexusServiceImpl | null = null;

export function getGitNexusService(options?: GitNexusServiceOptions): GitNexusServiceImpl {
  if (!serviceInstance) {
    serviceInstance = new GitNexusServiceImpl(options);
  }
  return serviceInstance;
}

export function resetGitNexusService(): void {
  if (serviceInstance) {
    void serviceInstance.stop();
  }
  serviceInstance = null;
}
