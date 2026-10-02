// 浏览器命令 TCP 服务（Agent 链路）：Electron Main 监听本机端口，运行
// Sidecar 协议服务端，其 runtime 绑定当前活动标签的 ElectronWebContentsRuntime。
// API 进程的 BrowserTool 经 TCP 客户端驱动真实 View——用户与 Agent 同会话。
// 安全：连接首帧必须携带会话级 capability token（SUANLIZI_BROWSER_TOKEN，
// 每次桌面会话启动时由 start-desktop 生成随机值注入），校验通过才建 Sidecar。
// — English: the browser-command TCP service (agent link): Electron Main listens
//   on a local port and runs the Sidecar protocol server whose runtime binds the
//   current tab's ElectronWebContentsRuntime. The API process's BrowserTool
//   drives the real view over TCP — the user and the agent share one session.
//   Security: the first frame of a connection must carry a per-desktop-session
//   capability token (SUANLIZI_BROWSER_TOKEN, a random value start-desktop injects
//   on every launch); the Sidecar is only created after it checks out.
import { randomBytes } from 'node:crypto';
import type { BrowserRuntimePort, BrowserSessionHandle } from '@suanlizi/browser-runtime';
import { ElectronWebContentsRuntime } from '../browser/ElectronWebContentsRuntime.js';
import type { BrowserViewManager } from '../browser/BrowserViewManager.js';

export interface BrowserServerHandle {
  close(): Promise<void>;
  port(): number;
  started: boolean;
  error: string | null;
}

// 默认端口；测试/多实例用 SUANLIZI_BROWSER_PORT 覆盖。
// — English: default port; SUANLIZI_BROWSER_PORT overrides it (tests / instances).
const DEFAULT_PORT = 19230;

// 每次桌面会话的随机 capability token（start-desktop.mjs 生成并注入 API/Electron）。
// — English: a per-desktop-session random capability token (start-desktop.mjs
//   generates it and injects it into the API/Electron processes).
export function resolveBrowserToken(): string {
  const fromEnv = process.env.SUANLIZI_BROWSER_TOKEN;
  if (fromEnv !== undefined && fromEnv.length >= 16) return fromEnv;
  // 兜底：Main 自身生成（API 侧拿不到时 BrowserTool 会拒绝连接）。
  // — English: fallback — Main generates one itself (if the API side cannot
  //   read it, BrowserTool refuses to connect).
  return randomBytes(24).toString('hex');
}

export async function startBrowserCommandServer(deps: {
  manager: BrowserViewManager;
  port?: number;
}): Promise<BrowserServerHandle> {
  const port = deps.port ?? Number(process.env.SUANLIZI_BROWSER_PORT ?? DEFAULT_PORT);
  const token = resolveBrowserToken();
  const { createTcpSidecarServer } = await import('@suanlizi/browser-runtime');
  const server = await createTcpSidecarServer({
    port,
    authToken: token,
    createRuntime: (context?: { taskId: string }) => {
      const taskId = context?.taskId;
      if (taskId === undefined || taskId === '') {
        throw new Error('browser taskId missing');
      }
      const sessionsByTab = new Map<string, BrowserSessionHandle>();
      let startInput: { taskId: string; signal?: AbortSignal } | undefined;
      let rootTabId: string | undefined;

      const sessionForPage = async (pageId?: string): Promise<{ tabId: string; session: BrowserSessionHandle }> => {
        if (startInput === undefined) throw new Error('browser session not started');
        const page = deps.manager.agentTabForPage(taskId, pageId);
        const existing = sessionsByTab.get(page.tabId);
        if (existing !== undefined) return { tabId: page.tabId, session: existing };
        const runtime = new ElectronWebContentsRuntime({
          view: page.view,
          adapter: deps.manager.adapterForView(page.view),
          pageId: page.tabId,
          waitForDownload: (input) => deps.manager.waitForNextDownload(page.tabId, input),
        });
        const session = await runtime.start(startInput);
        sessionsByTab.set(page.tabId, session);
        return { tabId: page.tabId, session };
      };
      const leasedRuntime: BrowserRuntimePort = {
        kind: 'electron',
        async start(input) {
          if (input.taskId !== taskId) {
            throw new Error('browser session taskId does not match authenticated thread');
          }
          startInput = input;
          const rootTab = await deps.manager.acquireAgentTab(taskId, { signal: input.signal });
          rootTabId = rootTab.tabId;
          const { session } = await sessionForPage(rootTabId);
          return {
            sessionId: session.sessionId,
            taskId: session.taskId,
            async close(reason) {
              await Promise.all([...sessionsByTab.values()].map((pageSession) => pageSession.close(reason)));
              sessionsByTab.clear();
            },
            currentPageGraph: () => deps.manager.agentPageGraph(taskId),
            observe: (observeInput) => deps.manager.runAgentOperation(taskId, observeInput?.pageId, async () => {
              const page = await sessionForPage(observeInput?.pageId);
              return page.session.observe({ ...observeInput, pageId: page.tabId });
            }),
            navigate: (navigateInput: { url: string; signal?: AbortSignal; pageId?: string }) => deps.manager.runAgentOperation(taskId, navigateInput.pageId, async () => {
              const page = await sessionForPage(navigateInput.pageId);
              const pageSession = page.session as BrowserSessionHandle & {
                navigate(input: { url: string; signal?: AbortSignal; pageId?: string }): ReturnType<BrowserSessionHandle['navigate']>;
              };
              return pageSession.navigate({ ...navigateInput, pageId: page.tabId });
            }),
            act: (actInput) => deps.manager.runAgentOperation(taskId, actInput.intent.pageId, async () => {
              const page = await sessionForPage(actInput.intent.pageId);
              return page.session.act(actInput);
            }),
          };
        },
      };
      return leasedRuntime;
    },
    log: (line: string) => console.log(`[browser-server] ${line}`),
  });
  const handle: BrowserServerHandle = {
    async close(): Promise<void> {
      await server.close();
    },
    port: () => server.port(),
    started: true,
    error: null,
  };
  console.log(`[browser-server] listening on 127.0.0.1:${server.port()} (auth enabled)`);
  return handle;
}

// 仅供测试/工具使用：生成一个随机 token。
// — English: test/utility helper: generate a random token.
export function generateBrowserToken(): string {
  return randomBytes(24).toString('hex');
}
