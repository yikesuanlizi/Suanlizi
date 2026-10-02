// Electron Main 入口（Phase 1）：生命周期 + 安全默认 + 窗口状态恢复 + 浏览器管理
// + 桌面服务 IPC。Render 层通过 SUANLIZI_ELECTRON_LOAD 控制：
//   dev  → http://127.0.0.1:5178（Vite dev server，复用 start-desktop.mjs）
//   file → apps/desktop/dist/index.html（构建产物）
// — English: Electron main entry (Phase 1) — lifecycle, security defaults, window
//   state restore, browser management and desktop-service IPC. The render layer is
//   selected via SUANLIZI_ELECTRON_LOAD: dev → the 5178 Vite dev server; file → the
//   built UI (dist/index.html).
import { app, BrowserWindow, nativeTheme, protocol } from 'electron';
import { extname } from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserViewManager } from '../browser/BrowserViewManager.js';
import { applySecurityDefaults } from './security.js';
import { createMainWindow } from './createMainWindow.js';

// 自定义 app:// 协议承载打包后的 UI（file:// 下 ES module 受 CORS 限制无法执行，
// 生产模式必须走协议加载）。asar 内文件经 readFileSync 读取。
// — English: a custom app:// protocol serves the packaged UI (ES modules are
//   blocked under file:// by CORS — production must use a protocol).
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};
const APP_ROOT = join(__dirname, '../..');
const APP_ICON_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icon.ico')
  : join(APP_ROOT, 'build/icon.ico');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
import { registerBrowserIpc } from '../ipc/registerBrowserIpc.js';
import { registerDesktopIpc } from './registerDesktopIpc.js';
import { registerTaskRuntimeIpc } from './taskRuntime.js';
import { registerMenuIpc, setApplicationMenu } from './menu.js';
import { startBrowserCommandServer, type BrowserServerHandle } from './browserServer.js';
import { applyWindowState, loadWindowState, persistWindowState, registerShutdownCleanup } from './lifecycle.js';
import type { BrowserDesktopEvent } from '../contracts/browserTypes.js';

const LOAD_MODE = process.env.SUANLIZI_ELECTRON_LOAD ?? 'file';
// 仅在本地集成验收时开启 Chromium DevTools 端口；默认不暴露调试端口。
// — English: expose a Chromium DevTools port only for local integration checks.
const REMOTE_DEBUG_PORT = process.env.SUANLIZI_REMOTE_DEBUG_PORT?.trim();
if (REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', REMOTE_DEBUG_PORT);
}
// 所有窗口级运行数据统一进入应用数据目录，dev/prod 和不同项目工作区一致。
// English: keep window-owned runtime data in the application data directory.
app.setName('Suanlizi');
app.setAppUserModelId('com.suanlizi.desktop');
app.setPath('userData', process.env.SUANLIZI_PORTABLE_DATA_DIR
  ? join(process.env.SUANLIZI_PORTABLE_DATA_DIR, 'electron-user-data')
  : join(__dirname, '../../../app-data/electron-user-data'));

// dev 模式 UI 地址（测试用随机端口时经 SUANLIZI_UI_URL 注入，避免 5178 竞争）。
// — English: dev-mode UI URL (tests inject a random port via SUANLIZI_UI_URL to
//   avoid 5178 contention).
const DEV_UI_URL = process.env.SUANLIZI_UI_URL ?? 'http://127.0.0.1:5178';

// 测试探测入口：Playwright 集成测试读取本文件判断应用是否就绪。
// — English: probe entry for integration tests.
const READY_FILE = process.env.SUANLIZI_READY_FILE ?? '';

function isDevToolsShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false;
  const key = String(input.key ?? '').toLowerCase();
  const code = String((input as Electron.Input & { code?: string }).code ?? '').toLowerCase();
  const modifier = input.control === true || input.meta === true;
  return key === 'f12' || code === 'f12' || (modifier && input.shift === true && key === 'i');
}

function toggleDevTools(target: Electron.WebContents, scope: string): void {
  try {
    const opened = target.isDevToolsOpened();
    if (opened) {
      target.closeDevTools();
    } else {
      target.openDevTools({ mode: 'detach', activate: true, title: `Suanlizi ${scope} console` });
    }
    console.log(`[desktop] DevTools ${opened ? 'closed' : 'opened'} for ${scope}`);
  } catch (error) {
    console.error(`[desktop] DevTools toggle failed for ${scope}:`, error);
  }
}

function markReady(): void {
  if (READY_FILE === '') return;
  try {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(READY_FILE, 'ready', 'utf8');
  } catch {
    // 尽力而为
  }
}

app.whenReady().then(() => {
  // 崩溃诊断：任何未捕获异常都落 stderr（集成测试可见）。
  // — English: crash diagnostics — any uncaught error goes to stderr.
  process.on('uncaughtException', (err) => {
    console.error('[electron] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[electron] unhandledRejection:', reason);
  });
  applySecurityDefaults();

  // 测试模式（单实例旁路）不恢复/不保存窗口状态，避免用户上次的窗口几何
  // 污染断言（isMaximized 等）。
  // — English: test mode (single-instance bypass) skips window-state restore
  //   and save so the user's last geometry cannot pollute assertions.
  const restored = process.env.SUANLIZI_DISABLE_SINGLE_INSTANCE === '1'
    ? null
    : loadWindowState();
  const windowBounds = restored?.bounds ?? { width: 1200, height: 800, x: 0, y: 0 };
  // 主窗口：承载 Suanlizi UI Renderer，同时是 WebContentsView 的宿主。
  // — English: the main window hosts the Suanlizi UI renderer AND the WebContentsView host.
  const host = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    x: windowBounds.x,
    y: windowBounds.y,
    title: 'Suanlizi',
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    // 延迟显示：等 React 挂载后再 show（见 showWhenReady），避免空白窗口。
    // — English: keep the window hidden until React mounts (see showWhenReady),
    //   so the user never sees a blank window.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (restored !== null) {
    applyWindowState(host, restored);
  }

  const emit = (event: BrowserDesktopEvent): void => {
    if (!host.isDestroyed()) {
      host.webContents.send('browser:event', event);
    }
  };
  const browserManager = new BrowserViewManager({ host, emit });
  // F12/Ctrl+Shift+I must also work when focus is on Suanlizi itself rather than
  // an embedded browser page. Keep this handler on the host WebContents so the
  // desktop UI can always open its console, and mirror renderer logs to the
  // terminal for cases where DevTools is unavailable.
  host.webContents.on('before-input-event', (event, input) => {
    if (!isDevToolsShortcut(input)) return;
    event.preventDefault();
    toggleDevTools(host.webContents, 'host renderer');
  });
  host.webContents.on('console-message', (event) => {
    const params = event as unknown as {
      level?: number | string;
      message?: string;
      lineNumber?: number;
      sourceId?: string;
    };
    const level = typeof params.level === 'number'
      ? (params.level >= 3 ? 'error' : params.level === 2 ? 'warning' : 'info')
      : (params.level === 'error' || params.level === 'warning' ? params.level : 'info');
    const message = params.message ?? '';
    const line = params.lineNumber ?? 0;
    const sourceId = params.sourceId ?? '';
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  // 首次 Agent 请求可能早于 Renderer 的事件订阅。主窗口加载完成后重发仍待
  // 处理的请求，确保工作台会自动展开而不会让 Agent 卡在无标签页状态。
  host.webContents.on('did-finish-load', () => {
    if (browserManager.hasPendingAgentBrowserRequest()) {
      emit({ type: 'agent-browser-requested', taskId: '' });
    }
  });

  createMainWindow({ host });

  registerBrowserIpc({
    manager: browserManager,
    adapterFor: (tabId: string) => browserManager.adapterForView(browserManager.viewFor(tabId)),
  });

  registerDesktopIpc({ host });
  registerMenuIpc();
  setApplicationMenu('en');
  host.setMenuBarVisibility(false);

  // 浏览器命令 TCP 服务（Agent 经 BrowserTool 驱动真实 View）。
  // handle 保存在 Main，退出时收口；启动失败记录状态（可查询/可观测）。
  // — English: browser-command TCP service (the agent drives the real view via
  //   BrowserTool). The handle lives in Main for an orderly shutdown on exit;
  //   a start failure is recorded (observable/queryable).
  let browserServer: BrowserServerHandle | null = null;
  startBrowserCommandServer({ manager: browserManager }).then((handle) => {
    browserServer = handle;
  }).catch((err: unknown) => {
    console.error('[browser-server] failed to start:', String(err));
  });

  // 退出时收口 TCP 服务（不泄漏监听端口）。
  // — English: close the TCP service on exit (no leaked listening port).
  const closeBrowserServer = async (): Promise<void> => {
    if (browserServer !== null) {
      const handle = browserServer;
      browserServer = null;
      try {
        await handle.close();
      } catch (err) {
        console.error('[browser-server] close failed:', String(err));
      }
    }
  };
  process.once('before-exit', () => {
    void closeBrowserServer();
  });

  registerTaskRuntimeIpc({
    manager: browserManager,
  });

  host.on('closed', () => {
    console.error('[electron] main window closed');
  });

  // 窗口状态持久化（正常退出时）。
  // — English: persist window state on normal exit.
  host.on('close', () => {
    persistWindowState(host);
  });

  registerShutdownCleanup(() => {
    browserManager.dispose();
  });

  if (LOAD_MODE === 'dev') {
    // dev 模式：vite 可能尚未就绪，did-fail-load 自动重试（最多 20 次）。
    // — English: dev mode — vite may not be ready yet; retry on did-fail-load
    //   (up to 20 times).
    let devRetries = 0;
    host.webContents.on('did-fail-load', (_event, code, desc) => {
      if (LOAD_MODE === 'dev' && devRetries < 20) {
        devRetries += 1;
        console.error(`[electron] load failed (${code} ${desc}) — retry ${devRetries}/20`);
        setTimeout(() => {
          if (!host.isDestroyed()) {
            void host.loadURL(DEV_UI_URL);
          }
        }, 500);
      }
    });
    void host.loadURL(DEV_UI_URL);
  } else if (LOAD_MODE === 'phase0') {
    void host.loadFile(join(__dirname, '../phase0/renderer.html'));
  } else {
    // 生产：app:// 协议加载打包 UI（file:// 下 ES module 不可用）。
    // — English: production loads the packaged UI over app:// (ES modules are
    //   unavailable under file://).
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const rel = pathname === '/' || pathname === '' ? 'dist/index.html' : `dist/${pathname.replace(/^\/+/, '')}`;
      const filePath = join(APP_ROOT, rel);
      try {
        const data = readFileSync(filePath);
        const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        return new Response(data, { headers: { 'content-type': mime } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
    void host.loadURL('app://bundle/index.html');
  }

  // 窗口延迟显示：等 React 挂载（#root 有内容）后再 show，避免启动时空白窗口。
  // 15s 兑底强制显示（dev 首屏编译/网络异常时不至于永远不出现）。
  // — English: delay showing the window until React mounts (#root has
  //   children), so the user never sees a blank window. A 15s fallback forces
  //   show (dev first-compile/network hiccups cannot leave it hidden forever).
  const showWhenReady = (): void => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (host.isDestroyed() || host.isVisible()) return;
      if (Date.now() - startedAt > 15_000) {
        host.show();
        return;
      }
      host.webContents.executeJavaScript('Boolean(document.querySelector("#root")?.childElementCount)').then((hasContent: boolean) => {
        if (hasContent) {
          host.show();
        } else {
          setTimeout(tick, 100);
        }
      }).catch(() => {
        setTimeout(tick, 100);
      });
    };
    tick();
  };
  host.webContents.once('did-finish-load', showWhenReady);

  markReady();
});

app.on('window-all-closed', () => {
  console.error('[electron] window-all-closed → quit');
  app.quit();
});

// Phase 0/1 调试辅助：无头集成测试可通过环境变量让 Main 在 N 秒后自动退出。
// — English: Phase 0/1 helper — headless integration tests may auto-quit via env.
const autoExitMs = Number(process.env.SUANLIZI_AUTO_EXIT_MS ?? '0');
if (autoExitMs > 0) {
  setTimeout(() => {
    console.log('[electron] auto-exit after', autoExitMs, 'ms');
    app.exit(0);
  }, autoExitMs);
}
