// Phase 0 集成测试：Playwright 驱动真实 Electron（_electron.launch），验证
// 同会话闸门——WebContentsView 真实页面、bounds 布局、用户/Agent 同一 DOM、
// Cookie/localStorage 同会话、CDP Adapter 决策、进程无残留。
// 前置：apps/desktop 下 `npx tsc -p tsconfig.electron.json` 已生成 dist-electron。
// — English: Phase 0 integration — Playwright drives real Electron
//   (_electron.launch) through the same-session gate: real pages in
//   WebContentsView, bounds layout, shared DOM between user and agent, shared
//   cookies/localStorage, the CDP Adapter decision, and no residual processes.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(here, '../apps/desktop/dist-electron/main/index.js');
const SITE_HTML = readFileSync(join(here, 'fixtures/electron-test-site/index.html'), 'utf8');

let site: Server;
let siteUrl = '';

beforeAll(async () => {
  site = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SITE_HTML);
  });
  await new Promise<void>((resolve) => {
    site.listen(0, '127.0.0.1', resolve);
  });
  const address = site.address();
  if (typeof address === 'object' && address !== null) {
    siteUrl = `http://127.0.0.1:${address.port}/`;
  } else {
    throw new Error('test site failed to bind');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
});

// Renderer 侧白名单 API（contextBridge 暴露）调用辅助。
// — English: helper calling the whitelisted preload API from the renderer.
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

// Phase 0 模式：加载最小测试 Renderer（renderer.html）。
// — English: Phase 0 mode — loads the minimal test renderer (renderer.html).
function launchPhase0() {
  return electron.launch({ args: [MAIN_JS], env: { ...process.env, SUANLIZI_ELECTRON_LOAD: 'phase0', SUANLIZI_DISABLE_SINGLE_INSTANCE: '1' } });
}

async function browserApi<T>(win: ElectronApp, call: string, arg?: unknown): Promise<T> {
  return win.evaluate(
    ([callExpr, argValue]) => {
      // 分步调用：先取 api 再传参（避免 window.evaluate 序列化限制）。
      // — English: resolve the API object first, then call with the arg.
      const api = (window as unknown as { suanliziDesktop: { browser: Record<string, (a: unknown) => Promise<unknown>> } }).suanliziDesktop.browser;
      return api[callExpr](argValue) as Promise<unknown>;
    },
    [call, arg],
  ) as Promise<T>;
}

// 等待 WebContentsView 页面加载完成（轮询指定元素出现）。
// — English: wait until the WebContentsView page finishes loading (poll for an element).
async function waitForSiteReady(win: ElectronApp, tabId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const loaded = await browserApi<boolean>(win, 'evaluate', {
      tabId,
      expression: 'document.getElementById("site-title") !== null',
    });
    if (loaded === true) return;
    if (Date.now() > deadline) throw new Error(`test site did not become ready within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Phase 0 · Electron 同会话可行性闸门', () => {
  it('启动 Electron：主窗口加载 preload，suanliziDesktop API 可用（sandbox + contextIsolation）', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      const hasApi = await win.evaluate(() => {
        const api = (window as unknown as { suanliziDesktop?: unknown }).suanliziDesktop;
        return api !== undefined && typeof api === 'object';
      });
      expect(hasApi).toBe(true);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('createTab：WebContentsView 加载真实页面，执行器经 CDP Adapter 读取同一 DOM', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });

      const tab = await browserApi<{ tabId: string; url: string }>(win, 'createTab', {
        url: siteUrl,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });
      expect(tab.tabId).toMatch(/^tab-\d+$/);
      expect(tab.url).toBe(siteUrl);

      // 等待页面加载完成后再由执行器读取。
      // — English: wait for the page to load before the executor reads.
      await waitForSiteReady(win, tab.tabId);

      // 执行器（BrowserEngineAdapter）读取 View 页面 DOM：标题 + 输入框存在。
      // — English: the executor (BrowserEngineAdapter) reads the view's DOM.
      const title = await browserApi<string>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'document.getElementById("site-title").textContent',
      });
      expect(title).toBe('Phase0 Test Site');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('同会话：用户输入（CDP Input）→ 执行器 evaluate 读到同一值；执行器点击 → 页面更新（用户可见）', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: siteUrl,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });
      await waitForSiteReady(win, tab.tabId);

      // 1) 模拟用户输入：CDP Input.insertText 聚焦输入框后键入文本。
      // — English: 1) simulate user typing via CDP Input after focusing the field.
      await browserApi<void>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'document.getElementById("name").focus()',
      });
      await browserApi<void>(win, 'insertText', { tabId: tab.tabId, text: '内嵌浏览器' });

      // 2) 执行器读取同一 DOM：输入框值 = 用户刚输入的文本。
      // — English: 2) the executor reads the same DOM — the field value matches.
      const typed = await browserApi<string>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'document.getElementById("name").value',
      });
      expect(typed).toBe('内嵌浏览器');

      // 3) 执行器点击「提交」按钮（CDP Input 鼠标事件）→ 页面输出更新（用户可见）。
      // — English: 3) the executor clicks submit via CDP Input — the page output updates.
      await browserApi<unknown>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: '(() => { const r = document.getElementById("go").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()',
      }).then(async (point) => {
        const { x, y } = point as { x: number; y: number };
        await browserApi<void>(win, 'click', { tabId: tab.tabId, x, y });
      });

      const out = await browserApi<string>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'document.getElementById("out").textContent',
      });
      expect(out).toBe('收到: 内嵌浏览器');

      // Agent 点击前会在同一可见页面展示平滑虚拟指针，随后仍由真实 CDP 鼠标
      // 事件完成操作。指针不参与 hit testing，也不会阻断用户随时接管。
      const agentPointerSeen = await browserApi<boolean>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'document.getElementById("__suanlizi_agent_pointer__") !== null',
      });
      expect(agentPointerSeen).toBe(true);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('同会话存储：localStorage 与 Cookie 在同一 webContents 读写一致（独立 partition）', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: siteUrl,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });

      // 写入 localStorage 与 cookie。
      // — English: write localStorage and a cookie on the shared webContents.
      await browserApi<unknown>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'localStorage.setItem("phase0", "shared-session"); document.cookie = "suanlizi_phase0=ok; path=/"',
      });

      // 导航到站点根（重载）后读取：同 partition 持久化仍在。
      // — English: navigate (reload) then read — persistence survives within the partition.
      await browserApi<void>(win, 'navigate', { tabId: tab.tabId, url: siteUrl });

      const stored = await browserApi<{ local: string | null; cookie: string }>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'JSON.stringify({ local: localStorage.getItem("phase0"), cookie: document.cookie })',
      });
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      expect(parsed.local).toBe('shared-session');
      expect(parsed.cookie).toContain('suanlizi_phase0=ok');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('关闭后无残留：app.close() 后 Electron 进程树退出', async () => {
    const app = await launchPhase0();
    const proc = app.process();
    const pid = proc.pid;
    expect(pid).toBeGreaterThan(0);
    await app.firstWindow().then((w) => w.waitForSelector('#btn-create', { timeout: 15_000 }));
    await app.close();
    // Playwright 的 close 等待进程退出；再确认 PID 不再存活。
    // — English: close waits for exit; confirm the PID is no longer alive.
    const alive = await isProcessAlive(pid);
    expect(alive).toBe(false);
  }, 60_000);
});

// Windows 进程存活探测（tasklist /FI "PID eq n"）。
// — English: Windows process-liveness probe.
async function isProcessAlive(pid: number): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  return new Promise<boolean>((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(stdout.includes(String(pid)));
    });
  });
}
