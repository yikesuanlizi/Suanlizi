// Phase 4 集成测试：单一持久化会话（cookie 跨 View 共享）、下载事件转发、
// Tauri 卸载后 desktop:dev 链路（Electron Main）可用。
// — English: Phase 4 integration — single persistent session (cookies shared
//   across views), download events, and the Electron dev chain after Tauri removal.
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(here, '../apps/desktop/dist-electron/main/index.js');

let site: Server;
let baseUrl = '';

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === '/set-cookie') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'suanlizi_phase4=shared' });
      res.end('<html><body><h1>cookie set</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>phase4 site</h1><a href="/set-cookie">set</a></body></html>');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const address = site.address();
  if (typeof address === 'object' && address !== null) {
    baseUrl = `http://127.0.0.1:${address.port}`;
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

describe('Phase 4 · 单一会话 / 下载 / Tauri 卸载', () => {
  it('两个 View 共享同一持久化会话：A 写 cookie，B 读到', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });

      const tabA = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: `${baseUrl}/set-cookie`,
        bounds: { x: 0, y: 40, width: 400, height: 300 },
      });
      // A 已种 cookie（同源 /set-cookie）。
      // — English: tab A has set the cookie on this origin.
      const cookieA = await browserApi<unknown>(win, 'evaluate', {
        tabId: tabA.tabId,
        expression: 'document.cookie',
      });
      expect(String(cookieA)).toContain('suanlizi_phase4');

      // B 在同一个 persist:suanlizi-browser 会话里，能读到 A 种的 cookie。
      // — English: tab B (same persist:suanlizi-browser session) can read it.
      const tabB = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: `${baseUrl}/`,
        bounds: { x: 0, y: 40, width: 400, height: 300 },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const cookieB = await browserApi<unknown>(win, 'evaluate', {
        tabId: tabB.tabId,
        expression: 'document.cookie',
      });
      expect(String(cookieB)).toContain('suanlizi_phase4');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('下载事件转发：will-download → download-started/progress 事件可见', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });

      // 记录 Renderer 收到的 browser:event 中的下载事件。
      // — English: capture download events the renderer receives.
      await win.evaluate(() => {
        const w = window as unknown as { suanliziDesktop: { browser: { subscribe: (h: (p: unknown) => void) => () => void } }; __p4Events: string[] };
        w.__p4Events = [];
        w.suanliziDesktop.browser.subscribe((payload) => {
          const p = payload as { type?: string };
          if (typeof p?.type === 'string' && p.type.startsWith('download-')) {
            w.__p4Events.push(p.type);
          }
        });
      });

      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: `${baseUrl}/`,
        bounds: { x: 0, y: 40, width: 400, height: 300 },
      });
      // 触发下载：加载一个 attachment 响应（Content-Disposition: attachment）。
      // — English: trigger a download via an attachment response.
      const downloadUrl = `${baseUrl}/dl.bin`;
      const site2 = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="phase4-dl.bin"' });
        res.end('download payload');
      });
      await new Promise<void>((resolve) => site2.listen(0, '127.0.0.1', resolve));
      const dlAddress = site2.address();
      const dlUrl = typeof dlAddress === 'object' && dlAddress !== null ? `http://127.0.0.1:${dlAddress.port}/dl.bin` : downloadUrl;
      void browserApi(win, 'navigate', { tabId: tab.tabId, url: dlUrl });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await new Promise<void>((resolve) => site2.close(() => resolve()));

      const events = (await win.evaluate(() => (window as unknown as { __p4Events: string[] }).__p4Events)) as string[];
      expect(events.some((t) => t.startsWith('download-'))).toBe(true);
    } finally {
      await app.close();
    }
  }, 60_000);
});
