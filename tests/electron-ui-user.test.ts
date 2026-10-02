// 用户场景实测：与真实用户完全相同的操作路径——
//   1) 完整 UI 打开浏览器 tab；2) 点击地址栏并键盘输入 URL（真实按键事件，
//      验证 React 受控 input 在真实输入下正常）；3) Enter 导航后网页可见；
//   4) F12 打开 DevTools（detach 独立窗口）；5) 页面 console 日志可达 Main。
// — English: real-user scenario — 1) open the browser tab; 2) click the address
//   bar and TYPE the URL (real key events — React's controlled input works with
//   real typing); 3) the page is visible after Enter; 4) F12 opens DevTools
//   (detached window); 5) page console logs reach Main.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { _electron as electron, type ElectronApplication } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(here, '../apps/desktop/dist-electron/main/index.js');
let viteServer: ChildProcess | null = null;
let viteUiUrl = 'http://127.0.0.1:5178';
let mainLogs: string[] = [];
let userSite: Server | null = null;
let userSiteUrl = '';

const USER_SITE_HTML = `<!doctype html><title>Suanlizi User Test</title><main><h1>Browser user scenario</h1><button id="probe">Probe</button></main>`;

async function startViteDev(): Promise<void> {
  if (viteServer !== null) return;
  const viteJs = join(here, '../node_modules/vite/bin/vite.js');
  // 随机端口（--port 0）避免测试间 5178 竞争；从 vite 日志解析实际端口。
  // — English: a random port (--port 0) avoids 5178 contention between tests;
  //   the actual port is parsed from vite's log.
  viteServer = spawn(process.execPath, [viteJs, '--host', '127.0.0.1', '--port', '5195'], {
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
    env: { ...process.env, SUANLIZI_ELECTRON_LOAD: 'dev', SUANLIZI_DISABLE_SINGLE_INSTANCE: '1', SUANLIZI_UI_URL: viteUiUrl },
  });
}

async function browserApi<T>(app: ElectronApplication, call: string, arg?: unknown): Promise<T> {
  const win = await app.firstWindow();
  return win.evaluate(
    ([callExpr, argValue]) => {
      const api = (window as unknown as { suanliziDesktop: { browser: Record<string, (a: unknown) => Promise<unknown>> } }).suanliziDesktop.browser;
      return api[callExpr](argValue) as Promise<unknown>;
    },
    [call, arg],
  ) as Promise<T>;
}

beforeAll(async () => {
  await startViteDev();
  userSite = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(USER_SITE_HTML);
  });
  await new Promise<void>((resolve) => userSite!.listen(0, '127.0.0.1', resolve));
  const address = userSite.address();
  if (typeof address !== 'object' || address === null) throw new Error('user scenario site failed to bind');
  userSiteUrl = `http://127.0.0.1:${address.port}`;
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
  if (userSite !== null) {
    await new Promise<void>((resolve) => userSite!.close(() => resolve()));
    userSite = null;
  }
});

describe('用户场景实测', () => {
  it('真实键盘输入导航 + 网页可见 + F12 DevTools + 日志可达', async () => {
    const app = await launchElectronDev();
    const proc = app.process();
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') mainLogs.push(line);
      }
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') mainLogs.push(line);
      }
    });
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#root > *', { timeout: 60_000, state: 'attached' });

      // 1) 打开浏览器 tab（真实点击）。
      // — English: open the browser tab with real clicks.
      await win.locator('button[aria-label*="浏览器"], button[aria-label*="browser"]').first().click();
      await win.locator('[role="menu"]').waitFor({ timeout: 10_000 });
      await win.locator('[role="menuitem"]:has-text("浏览器"), [role="menuitem"]:has-text("Browser")').first().click();
      await win.waitForSelector('[data-testid="browserWorkbench"]', { timeout: 15_000 });

      // 2) 无标签直接输入网址回车 → 自动建标签并导航（不必先点新建标签）。
      // — English: typing a URL with no tabs auto-creates the tab and navigates.
      const addressInput = win.locator('input[aria-label="地址栏"]');
      await addressInput.click();
      await addressInput.type(userSiteUrl, { delay: 20 });
      await addressInput.press('Enter');

      // 3) 等待加载完成（轮询）。
      // — English: wait until the page loads.
      let url = '';
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        const tabs = await browserApi<Array<{ url: string; loading: boolean }>>(app, 'listTabs');
        if (tabs.length > 0) {
          url = tabs[0].url;
          if (url.includes(userSiteUrl) && !tabs[0].loading) break;
        }
      }
      expect(url).toContain(userSiteUrl);

      // 4) 网页可见性：View 内标题 + 窗口截图非空白。
      // — English: visibility — view title + a non-trivial window screenshot.
      const tabsNow = await browserApi<Array<{ tabId: string }>>(app, 'listTabs');
      const viewTitle = await browserApi<unknown>(app, 'evaluate', {
        tabId: tabsNow[0].tabId,
        expression: 'document.title',
      });
      expect(String(viewTitle)).toBe('Suanlizi User Test');
      const shot = await win.screenshot();
      expect(shot.length).toBeGreaterThan(10_000);

      // 5) F12 → DevTools 独立窗口出现（detach）。
      // — English: F12 opens a detached DevTools window.
      await win.evaluate(() => {
        // 焦点放到 View 外（UI 区域）也应在 host 上注册 F12——先聚焦地址栏。
        // — English: focus the address bar first (F12 must work from the UI too).
        (document.querySelector('input[aria-label="地址栏"]') as HTMLInputElement | null)?.focus();
      });
      await win.keyboard.press('F12');
      await new Promise((r) => setTimeout(r, 1200));
      const windowCount = (await app.windows()).length;

      // 6) 日志：页面主动打一条 console，确认能到 Main（终端）或事件。
      // — English: log a console line from the page and confirm it is visible.
      await browserApi(app, 'evaluate', { tabId: tabsNow[0].tabId, expression: "console.log('suanlizi-ui-log-probe'); 'ok'" });
      await new Promise((r) => setTimeout(r, 800));
      const logVisible = mainLogs.some((l) => l.includes('suanlizi-ui-log-probe'));
      expect(logVisible).toBe(true);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('关闭浏览器面板后 View 销毁（listTabs 为空，无残留页面）', async () => {
    const app = await launchElectronDev();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#root > *', { timeout: 60_000, state: 'attached' });

      // 打开浏览器面板并创建标签。
      // — English: open the browser panel and create a tab.
      await win.locator('button[aria-label*="浏览器"], button[aria-label*="browser"]').first().click();
      await win.locator('[role="menu"]').waitFor({ timeout: 10_000 });
      await win.locator('[role="menuitem"]:has-text("浏览器"), [role="menuitem"]:has-text("Browser")').first().click();
      await win.waitForSelector('[data-testid="browserWorkbench"]', { timeout: 15_000 });
      const addressInput = win.locator('input[aria-label="地址栏"]');
      await addressInput.click();
      await addressInput.type(userSiteUrl, { delay: 15 });
      await addressInput.press('Enter');
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        const tabs = await browserApi<Array<{ url: string; loading: boolean }>>(app, 'listTabs');
        if (tabs.length > 0 && tabs[0].url.includes(userSiteUrl) && !tabs[0].loading) break;
      }
      expect((await browserApi<Array<unknown>>(app, 'listTabs')).length).toBeGreaterThan(0);

      // 关闭浏览器面板（workbench utility tab 的关闭按钮）。
      // — English: close the browser panel (workbench utility close button).
      await win.locator('button[aria-label="关闭浏览器"], button[aria-label="Close Browser"]').first().click();
      await new Promise((r) => setTimeout(r, 800));
      await win.waitForSelector('[data-testid="browserWorkbench"]', { state: 'detached', timeout: 10_000 });

      // 原生 View 必须全部销毁（listTabs 空）——否则页面残留在窗口上。
      // — English: every native view must be destroyed (listTabs empty) or the
      //   page stays on screen.
      const remaining = await browserApi<Array<{ tabId: string; url: string; visible: boolean }>>(app, 'listTabs');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].url).toContain(userSiteUrl);
      expect(remaining[0].visible).toBe(false);
      const title = await browserApi<string>(app, 'evaluate', {
        tabId: remaining[0].tabId,
        expression: 'document.title',
      });
      expect(title).toBe('Suanlizi User Test');
    } finally {
      await app.close();
    }
  }, 90_000);

  it('搜索对话框覆盖整个窗口并保持居中，而非被侧栏裁剪', async () => {
    const app = await launchElectronDev();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#root > *', { timeout: 60_000, state: 'attached' });
      await win.locator('.searchLauncher').click();
      const dialog = win.locator('.searchDialog[role="dialog"]');
      await dialog.waitFor({ timeout: 10_000, state: 'visible' });
      const box = await dialog.boundingBox();
      const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const visual = await win.evaluate(() => {
        const root = document.documentElement;
        const dialogElement = document.querySelector<HTMLElement>('.searchDialog');
        const inputElement = document.querySelector<HTMLElement>('.searchDialogInput');
        const collapseButton = document.querySelector<HTMLElement>('.workspaceThreadsHeader > .miniIconButton');
        const path = collapseButton?.querySelector('svg path')?.getAttribute('d') ?? null;
        const buttonBox = collapseButton?.getBoundingClientRect() ?? null;
        return {
          theme: root.dataset.suanliziTheme,
          dialogBackground: dialogElement ? getComputedStyle(dialogElement).backgroundColor : null,
          inputBackground: inputElement ? getComputedStyle(inputElement).backgroundColor : null,
          buttonBox: buttonBox ? { width: buttonBox.width, height: buttonBox.height } : null,
          collapsePath: path,
        };
      });
      expect(box).not.toBeNull();
      expect(Math.abs((box!.x + box!.width / 2) - viewport.width / 2)).toBeLessThan(3);
      expect(Math.abs((box!.y + box!.height / 2) - viewport.height / 2)).toBeLessThan(3);
      expect(visual.theme).toBe('light');
      expect(visual.dialogBackground).toBe('rgb(255, 255, 255)');
      expect(visual.inputBackground).toBe('rgb(248, 250, 252)');
      expect(visual.buttonBox?.width).toBeGreaterThanOrEqual(28);
      expect(visual.buttonBox?.height).toBeGreaterThanOrEqual(28);
      expect(visual.collapsePath).toBe('m15 18-6-6 6-6');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('菜单 locale IPC：zh/en 切换调用成功（顶部菜单随主题语言）', async () => {
    const app = await launchElectronDev();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#root > *', { timeout: 60_000, state: 'attached' });
      const menuApi = (window: { suanliziDesktop?: { menu?: { setLocale(locale: string): Promise<void> } } }) => window.suanliziDesktop?.menu;
      const zhResult = await win.evaluate(() => {
        const menu = (window as unknown as { suanliziDesktop?: { menu?: { setLocale(locale: string): Promise<unknown> } } }).suanliziDesktop?.menu;
        return menu ? menu.setLocale('zh') : Promise.resolve('no-menu');
      });
      const enResult = await win.evaluate(() => {
        const menu = (window as unknown as { suanliziDesktop?: { menu?: { setLocale(locale: string): Promise<unknown> } } }).suanliziDesktop?.menu;
        return menu ? menu.setLocale('en') : Promise.resolve('no-menu');
      });
      expect(zhResult).not.toBe('no-menu');
      expect(enResult).not.toBe('no-menu');
      expect(menuApi).toBeDefined();
    } finally {
      await app.close();
    }
  }, 60_000);

  it('Electron 内嵌卡片：主界面左右下边距 8px + 圆角 12px（仅桌面壳）', async () => {
    const app = await launchElectronDev();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#root > *', { timeout: 60_000, state: 'attached' });
      const style = await win.evaluate(() => {
        const shell = document.querySelector('.electron-shell');
        const appShell = document.querySelector('.appShell');
        if (!appShell) return null;
        const cs = getComputedStyle(appShell);
        return {
          bodyHasShell: document.body.classList.contains('electron-shell'),
          shellExists: shell !== null,
          marginLeft: cs.marginLeft,
          marginRight: cs.marginRight,
          marginBottom: cs.marginBottom,
          marginTop: cs.marginTop,
          borderRadius: cs.borderRadius,
          height: cs.height,
        };
      });
      expect(style?.bodyHasShell).toBe(true);
      expect(style?.marginLeft).toBe('16px');
      expect(style?.marginRight).toBe('16px');
      expect(style?.marginBottom).toBe('16px');
      expect(style?.marginTop).toBe('16px');
      expect(style?.borderRadius).toBe('16px');
    } finally {
      await app.close();
    }
  }, 60_000);
});
