// BrowserTool 端到端：真实 Electron（TCP 桥 19231）→ Agent 工具链操作真实 View。
// 验证 browser_observe / browser_navigate / browser_act 经 TCP Sidecar 协议驱动
// ElectronWebContentsRuntime（用户可见页面），审批钩子与取消信号贯通。
// — English: BrowserTool end-to-end — real Electron (TCP bridge on 19231) → the
//   agent tool chain drives the real view. Verifies observe/navigate/act over
//   the TCP Sidecar protocol into ElectronWebContentsRuntime (the user-visible
//   page), with the approval hook and the abort signal wired through.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';
// 被测代码一律从 src 导入（评审 P0：测试不得引用 dist，避免旧产物掩盖问题）。
// 运行时依赖（browser-runtime）经 node_modules 解析其编译产物（包边界）。
// — English: the code under test always comes from src (review P0: tests must
//   not import dist, or stale artifacts can mask issues). The runtime dep
//   (browser-runtime) resolves its build via node_modules (package boundary).
import { browserTools } from '../packages/tools/src/browserTool.js';
import type { ToolContext } from '../packages/tools/src/registry.js';

const browserObserveTool = browserTools.find((t) => t.name === 'browser_observe');
const browserPagesTool = browserTools.find((t) => t.name === 'browser_pages');
const browserNavigateTool = browserTools.find((t) => t.name === 'browser_navigate');
const browserActTool = browserTools.find((t) => t.name === 'browser_act');

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(here, '../apps/desktop/dist-electron/main/index.js');
const BROWSER_PORT = 19231;

process.env.SUANLIZI_BROWSER_PORT = String(BROWSER_PORT);
const BROWSER_TOKEN = 'test-browser-token-0123456789abcdef';
process.env.SUANLIZI_BROWSER_TOKEN = BROWSER_TOKEN;

let viteServer: ChildProcess | null = null;
let viteUiUrl = 'http://127.0.0.1:5178';
let popupSite: Server | null = null;
let popupSiteUrl = '';

const POPUP_ROOT_HTML = `<!doctype html><title>Root page</title><button id="open-popup" onclick="window.open('/popup', '_blank')">Open popup</button>`;
const POPUP_HTML = `<!doctype html><title>Popup page</title><button id="popup-action" onclick="document.title='Popup acted'; document.body.dataset.acted='yes'">Act in popup</button>`;
const POPUP_NEXT_HTML = '<!doctype html><title>Popup next</title><h1>Popup next page</h1>';

async function startViteDev(): Promise<void> {
  if (viteServer !== null) return;
  // 随机端口（--port 0）避免测试间 5178 竞争；从 vite 日志解析实际端口。
  // — English: a random port (--port 0) avoids 5178 contention between tests;
  //   the actual port is parsed from vite's log.
  const viteJs = join(here, '../node_modules/vite/bin/vite.js');
  viteServer = spawn(process.execPath, [viteJs, '--host', '127.0.0.1', '--port', '5197'], {
    cwd: join(here, '../apps/desktop'),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let viteLog = '';
  viteServer.stdout?.on('data', (chunk: Buffer) => {
    viteLog += String(chunk);
  });
  viteServer.stderr?.on('data', (chunk: Buffer) => {
    viteLog += String(chunk);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const readyMatch = viteLog.match(/127\.0\.0\.1:(?:\u001b\[[0-9;]*m)?(\d+)/);
    if (readyMatch !== null) {
      viteUiUrl = `http://127.0.0.1:${readyMatch[1]}`;
      return;
    }
    if (viteServer.exitCode !== null) {
      throw new Error(`vite exited early: ${viteLog.slice(-500)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`vite dev server did not become ready: ${viteLog.slice(-500)}`);
}

function launchElectronDev() {
  return electron.launch({
    args: [MAIN_JS, '--disable-gpu'],
    env: {
      ...process.env,
      SUANLIZI_ELECTRON_LOAD: 'dev',
      SUANLIZI_DISABLE_SINGLE_INSTANCE: '1',
      SUANLIZI_BROWSER_PORT: String(BROWSER_PORT),
      SUANLIZI_BROWSER_TOKEN: BROWSER_TOKEN,
      SUANLIZI_UI_URL: viteUiUrl,
    },
  });
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: here,
    threadId: 'thread-tool-e2e',
    turnId: 'turn-tool-e2e',
    approved: true,
    requestAccess: async () => ({ decision: 'allow', request: { access: 'network', target: { kind: 'network', host: 'x' }, threadId: '', turnId: '', description: '' }, source: 'workspace_default', threadId: '', turnId: '', ruleId: undefined, reason: 'test' }) as never,
    ...overrides,
  } as ToolContext;
}

beforeAll(async () => {
  await startViteDev();
  popupSite = createServer((request, response) => {
    const html = request.url === '/popup' ? POPUP_HTML : request.url === '/popup-next' ? POPUP_NEXT_HTML : POPUP_ROOT_HTML;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => popupSite!.listen(0, '127.0.0.1', resolve));
  const address = popupSite.address();
  if (typeof address !== 'object' || address === null) throw new Error('popup test site failed to bind');
  popupSiteUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  // Windows 下 SIGTERM 对 node 子进程不可靠（残留 vite 占用 5178 会毒化后续
  // 测试），用 taskkill /T /F 强杀进程树。
  // — English: SIGTERM is unreliable for node children on Windows (a leftover
  //   vite holding 5178 poisons later tests), so kill the tree forcefully.
  if (viteServer !== null && viteServer.pid !== undefined) {
    try {
      spawn('taskkill', ['/PID', String(viteServer.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // ignore
    }
  }
  viteServer = null;
  if (popupSite !== null) {
    await new Promise<void>((resolve) => popupSite!.close(() => resolve()));
    popupSite = null;
  }
});

describe('BrowserTool 端到端（真实 Electron View）', () => {
  it('首次 Agent 浏览器调用自动展开可接管工作台并创建根标签', async () => {
    const app = await launchElectronDev();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#root > *', { timeout: 60_000, state: 'attached' });

      // 不预先点击浏览器入口：Agent 请求必须把用户带到同一个可见根标签，
      // 地址栏也需要立刻可接管。
      const ctx = makeContext({ threadId: 'thread-auto-browser', turnId: 'turn-auto-browser' });
      const observationPromise = browserObserveTool!.execute({}, ctx);
      await win.waitForSelector('[data-testid="browserWorkbench"]', { timeout: 15_000 });
      await win.waitForSelector('input[aria-label="地址栏"]', { timeout: 15_000 });

      const observation = await observationPromise;
      expect(observation.status).toBe('completed');
      expect(observation.output).toContain('about:blank');
      await expect.poll(async () => win.locator('[data-testid="browserTabStrip"] [role="tab"]').count()).toBe(1);

      const pages = await browserPagesTool!.execute({}, ctx);
      expect(pages.status).toBe('completed');
      expect(pages.output).toContain('about:blank');
      expect(pages.output).toContain('尚未打开网页');
      expect(pages.output).toContain('下一步必须调用');
      expect(pages.output).toContain('browser_navigate');

      // 收起右侧栏只隐藏原生 View，不得销毁 Agent 所属的 pageId；下次 Agent
      // 操作会恢复工作台并继续同一标签。
      await win.locator('button[aria-label*="显示/隐藏右侧栏"], button[aria-label*="Show/hide right panel"]').click();
      await expect.poll(async () => win.evaluate(() => {
        const browser = (window as unknown as { suanliziDesktop?: { browser?: { listTabs(): Promise<unknown> } } }).suanliziDesktop?.browser;
        return browser?.listTabs();
      })).toEqual([
        expect.objectContaining({ visible: false, url: 'about:blank' }),
      ]);
      const resumed = await browserObserveTool!.execute({}, ctx);
      expect(resumed.status).toBe('completed');
      expect(resumed.output).toContain('about:blank');
      await win.waitForSelector('[data-testid="browserWorkbench"]', { timeout: 15_000 });

      // 浏览器与活动/文件使用同一右侧工作台。切走时 WebContentsView 必须脱离
      // 原生窗口层，切回时恢复同一标签而非留下覆盖画面或重建 about:blank。
      await win.locator('.workbenchPrimaryTabs button').first().click();
      await expect.poll(async () => win.evaluate(() => {
        const browser = (window as unknown as { suanliziDesktop?: { browser?: { listTabs(): Promise<unknown> } } }).suanliziDesktop?.browser;
        return browser?.listTabs();
      })).toEqual([
        expect.objectContaining({ visible: false, url: 'about:blank' }),
      ]);
      await win.locator('.workbenchDynamicTab button').first().click();
      await expect.poll(async () => win.evaluate(() => {
        const browser = (window as unknown as { suanliziDesktop?: { browser?: { listTabs(): Promise<unknown> } } }).suanliziDesktop?.browser;
        return browser?.listTabs();
      })).toEqual([
        expect.objectContaining({ visible: true, url: 'about:blank' }),
      ]);
    } finally {
      await app.close();
    }
  }, 90_000);

  it('observe → navigate → observe → act 全链路驱动真实页面', async () => {
    const app = await launchElectronDev();
    const proc = app.process();
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') console.warn(`[el-stdout] ${line}`);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') console.warn(`[el-stderr] ${line}`);
      }
    });
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#root > *', { timeout: 60_000, state: 'attached' });
      // 打开浏览器工作台并建一个标签（TCP 桥绑定第一个 tab 的 View）。
      // — English: open the browser workbench and create a tab (the TCP bridge
      //   binds the first tab's view).
      await win.locator('button[aria-label*="浏览器"], button[aria-label*="browser"]').first().click();
      await win.locator('[role="menu"]').waitFor({ timeout: 10_000 });
      await win.locator('[role="menuitem"]:has-text("浏览器"), [role="menuitem"]:has-text("Browser")').first().click();
      await win.waitForSelector('[data-testid="browserWorkbench"]', { timeout: 15_000 });
      const addressInput = win.locator('input[aria-label="地址栏"]');
      await addressInput.click();
      await addressInput.fill('https://example.com');
      await addressInput.press('Enter');

      // 等待 TCP 桥就绪（Electron Main 已监听；tab 加载中）。
      await new Promise((r) => setTimeout(r, 1500));

      // 1) observe：应看到 example.com 页面元素。
      // — English: observe — should see example.com page elements.
      const ctx = makeContext();
      const obsResult = await browserObserveTool.execute({}, ctx);
      expect(obsResult.status).toBe('completed');
      expect(obsResult.output).toContain('example.com');
      expect(obsResult.output).toContain('[e1]');

      // 2) navigate 到 example.org 再观察。
      // — English: navigate to example.org and observe again.
      const navResult = await browserNavigateTool.execute({ url: 'https://example.org' }, ctx);
      expect(navResult.status).toBe('completed');
      expect(navResult.output).toContain('example.org');

      const obs2 = await browserObserveTool.execute({}, ctx);
      expect(obs2.output).toContain('example.org');

      // 3) act：点击第一个链接（example.org 页面有 "More information..." 链接）。
      // — English: act — click the first link on example.org.
      const clickResult = await browserActTool.execute({ kind: 'click', targetRef: '[e1]', rationale: 'e2e click' }, ctx);
      expect(clickResult.status).toBe('completed');
      expect(clickResult.output).toContain('committed');

      // 4) 取消贯通：已中止的 signal 让工具快速失败而非挂起。
      // — English: cancellation — an aborted signal fails fast.
      const aborted = new AbortController();
      aborted.abort();
      const obsAborted = await browserObserveTool.execute({}, makeContext({ signal: aborted.signal }));
      expect(obsAborted.status).toBe('failed');

      // 5) 未授权连接被拒（评审 P0-3：capability token 握手）。
      // — English: an unauthenticated connection is rejected (review P0-3:
      //   capability-token handshake).
      const { createTcpSidecarTransport } = await import('@suanlizi/browser-runtime');
      const bad = createTcpSidecarTransport({ port: BROWSER_PORT, authToken: 'wrong-token', taskId: 'thread-bad-auth' });
      await expect(bad.ready).rejects.toThrow(/auth/i);
      bad.close();

      // 6) 服务端绑定活动标签（评审 P0-2）：新建 tab-2 并激活后，新连接观察
      //    到的是 tab-2（example.org），而不是最早打开的 tab-1。
      // — English: the server binds the active tab (review P0-2): after creating
      //   tab-2 and activating it, a fresh connection observes tab-2
      //   (example.org), not the first-opened tab-1.
      await win.locator('button[aria-label="新建标签"], button:has-text("新建标签")').first().click();
      const address2 = win.locator('input[aria-label="地址栏"]');
      await address2.click();
      await address2.fill('https://example.org');
      await address2.press('Enter');
      // 激活 tab-2（点击它的标签——最后一个是新标签；显示标题而非 url）。
      // — English: activate tab-2 (click its tab — the last one is the newest;
      //   tabs show the page title, not the url).
      await win.locator('[data-testid="browserTabStrip"] [role="tab"]').last().click();
      await new Promise((r) => setTimeout(r, 1200));

      const fresh = createTcpSidecarTransport({ port: BROWSER_PORT, authToken: BROWSER_TOKEN, taskId: 'thread-fresh' });
      await fresh.ready;
      const { createSidecarClient } = await import('@suanlizi/browser-runtime');
      const freshSession = await createSidecarClient({ taskId: 'thread-fresh', transport: fresh.transport as never }) as unknown as {
        observe(input?: { signal?: AbortSignal }): Promise<{ url: string }>;
        close(reason?: string): Promise<void>;
      };
      const freshObs = await freshSession.observe();
      expect(freshObs.url).toContain('example.org');
      await freshSession.close('test done');

      // 7) 无协议本地地址：navigate localhost:<port> 补 http://（修复 https 误补
      //    导致的 ERR_SSL_PROTOCOL_ERROR）。
      // — English: a schemeless local address gets http:// (fixes the https
      //   mis-derivation that caused ERR_SSL_PROTOCOL_ERROR).
      const navLocal = await browserNavigateTool.execute({ url: `localhost:${viteUiUrl.split(':').pop() ?? ''}` }, ctx);
      expect(navLocal.status).toBe('completed');
      expect(navLocal.output).toContain('http://localhost:');
      expect(navLocal.output).not.toContain('https://localhost:');
    } finally {
      await app.close();
    }
  }, 150_000);

  it('同线程根标签和弹窗可按 pageId 枚举、观察、导航与操作', async () => {
    const app = await launchElectronDev();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#root > *', { timeout: 60_000, state: 'attached' });
      await win.locator('button[aria-label*="浏览器"], button[aria-label*="browser"]').first().click();
      await win.locator('[role="menu"]').waitFor({ timeout: 10_000 });
      await win.locator('[role="menuitem"]').filter({ hasText: /浏览器|Browser/ }).first().click();
      await win.waitForSelector('[data-testid="browserWorkbench"]', { timeout: 15_000 });

      // 根标签先由用户可见的工作台创建；Agent 只租约并操作已有可见页面。
      const addressInput = win.locator('input[aria-label="地址栏"]');
      await addressInput.click();
      await addressInput.fill(popupSiteUrl);
      await addressInput.press('Enter');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const ctx = makeContext({ threadId: 'thread-popup-pages', turnId: 'turn-popup-pages' });
      const rootObservation = await browserObserveTool!.execute({}, ctx);
      expect(rootObservation.status).toBe('completed');
      const root = (rootObservation.data as { observation: { pageId: string } }).observation;

      const openPopup = await browserActTool!.execute({ kind: 'click', targetRef: '[e1]', pageId: root.pageId }, ctx);
      expect(openPopup.status).toBe('completed');

      let popupPage: { pageId: string; openerPageId?: string } | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const pagesResult = await browserPagesTool!.execute({}, ctx);
        expect(pagesResult.status).toBe('completed');
        const pages = (pagesResult.data as { pages: Array<{ pageId: string; openerPageId?: string }> }).pages;
        popupPage = pages.find((page) => page.openerPageId === root.pageId);
        if (popupPage !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(popupPage).toBeDefined();

      const popupObservation = await browserObserveTool!.execute({ pageId: popupPage!.pageId }, ctx);
      expect(popupObservation.status).toBe('completed');
      expect(popupObservation.output).toContain('Popup page');

      const popupNavigation = await browserNavigateTool!.execute({ url: `${popupSiteUrl}/popup-next`, pageId: popupPage!.pageId }, ctx);
      expect(popupNavigation.status).toBe('completed');
      expect(popupNavigation.output).toContain('Popup next');

      await browserNavigateTool!.execute({ url: `${popupSiteUrl}/popup`, pageId: popupPage!.pageId }, ctx);
      const refreshedPopup = await browserObserveTool!.execute({ pageId: popupPage!.pageId }, ctx);
      const popup = (refreshedPopup.data as { observation: { pageId: string } }).observation;
      const popupAction = await browserActTool!.execute({ kind: 'click', targetRef: '[e1]', pageId: popup.pageId }, ctx);
      expect(popupAction.status).toBe('completed');
      expect(popupAction.output).toContain('Popup acted');

      const graphAfterAction = await browserPagesTool!.execute({}, ctx);
      expect((graphAfterAction.data as { activePageId: string }).activePageId).toBe(popupPage!.pageId);
    } finally {
      await app.close();
    }
  }, 150_000);
});
