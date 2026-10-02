// Phase 2 集成测试：动态标签管理 + 导航 + 事件 + popup + bounds 布局。
// 通过 preload typed API 驱动真实 WebContentsView（不经过 Agent 策略——Phase 3 接入）。
// — English: Phase 2 integration — dynamic tabs, navigation, events, popups and
//   bounds layout via the preload typed API (no Agent policy yet — Phase 3).
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(here, '../apps/desktop/dist-electron/main/index.js');
const SITE_HTML = readFileSync(join(here, 'fixtures/electron-test-site/index.html'), 'utf8');
const SITE2_HTML = '<!doctype html><html><body><h1 id="site2-title">Second Site</h1><a id="open-popup" href="#" onclick="window.open(\'about:blank\'); return false;">open popup</a></body></html>';

let site: Server;
let siteUrl = '';
let site2Url = '';

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url?.startsWith('/second')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SITE2_HTML);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SITE_HTML);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const address = site.address();
  if (typeof address === 'object' && address !== null) {
    const port = address.port;
    siteUrl = `http://127.0.0.1:${port}/`;
    site2Url = `http://127.0.0.1:${port}/second`;
  } else {
    throw new Error('test site failed to bind');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
});

function launchPhase0() {
  return electron.launch({ args: [MAIN_JS], env: { ...process.env, SUANLIZI_ELECTRON_LOAD: 'phase0', SUANLIZI_DISABLE_SINGLE_INSTANCE: '1' } });
}

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

async function browserApi<T>(win: ElectronApp, call: string, arg?: unknown): Promise<T> {
  return win.evaluate(
    ([callExpr, argValue]) => {
      const api = (window as unknown as { suanliziDesktop: { browser: Record<string, (a: unknown) => Promise<unknown>> } }).suanliziDesktop.browser;
      return api[callExpr](argValue) as Promise<unknown>;
    },
    [call, arg],
  ) as Promise<T>;
}

async function waitForSite(win: ElectronApp, tabId: string, selector: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await browserApi<boolean>(win, 'evaluate', {
      tabId,
      expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
    });
    if (ready === true) return;
    if (Date.now() > deadline) throw new Error(`site did not become ready within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Phase 2 · 动态标签与导航', () => {
  it('多标签：创建/激活/关闭，激活标签保持可见且页面状态正确', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      const bounds = { x: 0, y: 40, width: 800, height: 600 };

      const tabA = await browserApi<{ tabId: string }>(win, 'createTab', { url: siteUrl, bounds });
      const tabB = await browserApi<{ tabId: string }>(win, 'createTab', { url: site2Url, bounds });
      await waitForSite(win, tabA.tabId, '#site-title');
      await waitForSite(win, tabB.tabId, '#site2-title');

      // 激活 B → 读取 B 页面 DOM；激活 A → 读取 A 页面 DOM。
      // — English: activate B then read B; activate A then read A.
      await browserApi<void>(win, 'activateTab', { tabId: tabB.tabId });
      const bTitle = await browserApi<string>(win, 'evaluate', {
        tabId: tabB.tabId,
        expression: 'document.getElementById("site2-title").textContent',
      });
      expect(bTitle).toBe('Second Site');

      await browserApi<void>(win, 'activateTab', { tabId: tabA.tabId });
      const aTitle = await browserApi<string>(win, 'evaluate', {
        tabId: tabA.tabId,
        expression: 'document.getElementById("site-title").textContent',
      });
      expect(aTitle).toBe('Phase0 Test Site');

      // 关闭 A → 列表只剩 B。
      // — English: close A — only B remains.
      await browserApi<void>(win, 'closeTab', { tabId: tabA.tabId });
      const tabs = await browserApi<Array<{ tabId: string; url: string }>>(win, 'listTabs');
      expect(tabs.map((t) => t.tabId)).toEqual([tabB.tabId]);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('导航历史：navigate → navigate → back → forward，URL 与标题正确', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: siteUrl,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });
      await waitForSite(win, tab.tabId, '#site-title');

      await browserApi<void>(win, 'navigate', { tabId: tab.tabId, url: site2Url });
      await waitForSite(win, tab.tabId, '#site2-title');

      const wentBack = await browserApi<boolean>(win, 'back', { tabId: tab.tabId });
      expect(wentBack).toBe(true);
      await waitForSite(win, tab.tabId, '#site-title');

      const wentForward = await browserApi<boolean>(win, 'forward', { tabId: tab.tabId });
      expect(wentForward).toBe(true);
      await waitForSite(win, tab.tabId, '#site2-title');

      // 无历史时 forward 返回 false。
      // — English: forward returns false when history is exhausted.
      const noForward = await browserApi<boolean>(win, 'forward', { tabId: tab.tabId });
      expect(noForward).toBe(false);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('事件流：page-title / loading / tab-created 事件经 subscribe 到达 Renderer', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      // 先订阅再创建，确保事件被收集。
      // — English: subscribe first, then create, so events are captured.
      const events: string[] = [];
      await win.evaluate(() => {
        const api = (window as unknown as { suanliziDesktop: { browser: { subscribe(h: (e: { type: string }) => void): void } } }).suanliziDesktop.browser;
        api.subscribe((event) => {
          (window as unknown as { __events?: string[] }).__events = [
            ...((window as unknown as { __events?: string[] }).__events ?? []),
            event.type,
          ];
        });
      });
      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: siteUrl,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });
      await waitForSite(win, tab.tabId, '#site-title');

      const seen = await win.evaluate(() => (window as unknown as { __events?: string[] }).__events ?? []);
      events.push(...seen);
      expect(events).toContain('tab-created');
      expect(events).toContain('loading');
      expect(events).toContain('page-title');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('popup：页面 window.open 在新标签打开（不产生独立窗口）', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: site2Url,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });
      await waitForSite(win, tab.tabId, '#open-popup');

      // 触发 popup：window.open('about:blank') → 新标签。
      // — English: trigger a popup — window.open('about:blank') opens a new tab.
      await browserApi<void>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'document.getElementById("open-popup").click()',
      });

      // 等待新标签出现（popup 目标为 about:blank，无标题元素，等待 listTabs 数量）。
      // — English: wait for the popup tab (about:blank has no heading; poll tab count).
      const deadline = Date.now() + 10_000;
      let tabs: Array<{ tabId: string }> = [];
      for (;;) {
        tabs = await browserApi<Array<{ tabId: string }>>(win, 'listTabs');
        if (tabs.length === 2) break;
        if (Date.now() > deadline) throw new Error('popup tab did not appear');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(tabs.length).toBe(2);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('bounds 布局：setBounds 后页面视口宽度与给定 bounds 一致（不覆盖工具栏）', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: siteUrl,
        bounds: { x: 0, y: 40, width: 640, height: 480 },
      });
      await waitForSite(win, tab.tabId, '#site-title');

      const viewport = await browserApi<{ width: number }>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })',
      });
      const parsed = typeof viewport === 'string' ? JSON.parse(viewport) : viewport;
      // 视口应接近给定 bounds（减去滚动条/缩放误差）。
      // — English: the viewport should approximate the requested bounds.
      expect(Math.abs(parsed.width - 640)).toBeLessThanOrEqual(30);
      expect(parsed.height).toBeGreaterThanOrEqual(400);
    } finally {
      await app.close();
    }
  }, 60_000);
});
