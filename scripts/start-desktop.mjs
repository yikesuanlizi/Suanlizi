import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './link-workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDataRoot = path.join(root, 'app-data');

function resolveAppDataRoot() {
  if (process.env.SUANLIZI_DATA_DIR?.trim()) return path.resolve(process.env.SUANLIZI_DATA_DIR.trim());
  if (process.env.SUANLIZI_PORTABLE_DATA_DIR?.trim()) return path.resolve(process.env.SUANLIZI_PORTABLE_DATA_DIR.trim());
  return desktopDataRoot;
}
const isWindows = process.platform === 'win32';
const DEFAULT_WEIXIN_BRIDGE_PORT = 18790;
const children = new Set();
let stopping = false;

// 等待本地 HTTP 服务就绪；API 必须先于 Vite/Electron 可用，避免首屏把暂时
// 的连接失败显示成空线程列表。
// — English: wait for a local HTTP service. The API must be available before
// Vite/Electron open, so a transient refusal is never rendered as an empty list.
async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        // 首页返回后 vite 已开始编译依赖；再给一点时间让入口编译完成。
        // — English: once the index returns, vite has started compiling deps;
        //   give it a moment to finish the entry modules.
        const warmupMs = Number.parseInt(process.env.SUANLIZI_WARMUP_MS ?? '120', 10);
        if (Number.isFinite(warmupMs) && warmupMs > 0) {
          await new Promise((r) => setTimeout(r, warmupMs));
        }
        return true;
      }
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function bin(name) {
  return path.join(root, 'node_modules', '.bin', isWindows ? `${name}.CMD` : name);
}

function run(command, args, options = {}) {
  const child = isWindows && command.toLowerCase().endsWith('.cmd')
    ? spawn(command, args, {
        cwd: options.cwd ?? root,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ...options.env },
      })
    : spawn(command, args, {
        cwd: options.cwd ?? root,
        stdio: 'inherit',
        shell: false,
        env: { ...process.env, ...options.env },
      });
  children.add(child);
  child.on('exit', (code) => {
    children.delete(child);
    if (options.primary || (code && !options.allowExit)) {
      stopChildren(child);
      process.exit(code ?? 0);
    }
  });
  return child;
}

function stopChildren(except) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child !== except && !child.killed) killChildTree(child);
  }
}

function killChildTree(child) {
  if (!child?.pid) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => {
      try { child.kill(); } catch { /* ignore */ }
    });
    return;
  }
  try { child.kill(); } catch { /* ignore */ }
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen({ host: '127.0.0.1', port });
  });
}

async function isPortFreeAnyAddress(port) {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function chooseWeixinBridgePort() {
  const explicit = process.env.SUANLIZI_WEIXIN_BRIDGE_PORT;
  const preferred = Number(explicit || DEFAULT_WEIXIN_BRIDGE_PORT);
  if (!Number.isInteger(preferred) || preferred <= 0) return DEFAULT_WEIXIN_BRIDGE_PORT;
  if (await isPortFree(preferred)) return preferred;
  if (explicit) return preferred;
  for (let port = DEFAULT_WEIXIN_BRIDGE_PORT + 1; port < DEFAULT_WEIXIN_BRIDGE_PORT + 40; port += 1) {
    if (await isPortFree(port)) {
      console.warn(`[desktop] Weixin bridge port ${preferred} is occupied; using ${port} for this Suanlizi desktop session.`);
      return port;
    }
  }
  return preferred;
}

const build = run(bin('tsc'), ['-b'], { allowExit: true });
build.on('exit', async (code) => {
  if (code) process.exit(code);
  const electronBuild = run('node', ['apps/desktop/scripts/build-electron.mjs'], { allowExit: true });
  electronBuild.on('exit', async (electronCode) => {
    if (electronCode) process.exit(electronCode);
    await startDesktopStack();
  });
});
async function startDesktopStack() {
  const apiPort = process.env.SUANLIZI_API_PORT ?? '4127';
  if (!await isPortFreeAnyAddress(Number(apiPort))) {
    console.error(`[api] Port ${apiPort} is already in use. Suanlizi may already be running.`);
    console.error(`[api] Stop the existing Suanlizi process first, or start with SUANLIZI_API_PORT=<free-port>.`);
    process.exit(1);
  }
  const appDataRoot = resolveAppDataRoot();
  const logDir = path.join(appDataRoot, 'logs');
  const weixinBridgePort = await chooseWeixinBridgePort();
  const weixinBridgeUrl = `http://127.0.0.1:${weixinBridgePort}/api/v1/admin/rpc`;

  // 每次桌面会话的浏览器控制 capability token：API（BrowserTool）与 Electron
  // （browser-server）共享同一随机值；TCP 首帧握手校验，防本机未授权进程控制浏览器。
  // — English: a per-desktop-session capability token for browser control,
  //   shared between the API (BrowserTool) and Electron (browser-server); the
  //   TCP first-frame handshake checks it so unauthorized local processes
  //   cannot drive the browser.
  const browserToken = (await import('node:crypto')).randomBytes(24).toString('hex');

  const api = run('node', ['apps/api/dist/server.js'], {
    env: {
      SUANLIZI_API_PORT: apiPort,
      SUANLIZI_WEIXIN_BRIDGE_PORT: String(weixinBridgePort),
      SUANLIZI_WEIXIN_BRIDGE_URL: weixinBridgeUrl,
      SUANLIZI_DATA_DIR: process.env.SUANLIZI_DATA_DIR ?? process.env.SUANLIZI_PORTABLE_DATA_DIR ?? desktopDataRoot,
      SUANLIZI_LOG_DIR: process.env.SUANLIZI_LOG_DIR ?? logDir,
      SUANLIZI_BROWSER_TOKEN: browserToken,
    },
  });
  const weixinBridge = run('node', ['apps/desktop/bridge/weixin-bridge.mjs'], {
    env: {
      SUANLIZI_API_URL: `http://127.0.0.1:${apiPort}`,
      SUANLIZI_WEIXIN_BRIDGE_PORT: String(weixinBridgePort),
      SUANLIZI_DATA_DIR: process.env.SUANLIZI_DATA_DIR ?? process.env.SUANLIZI_PORTABLE_DATA_DIR ?? desktopDataRoot,
      SUANLIZI_LOG_DIR: process.env.SUANLIZI_LOG_DIR ?? logDir,
    },
  });
  const apiReady = await waitForHttp(`http://127.0.0.1:${apiPort}/api/settings`);
  if (!apiReady) {
    console.error('[api] API did not become ready before the desktop UI startup window.');
  }
  const desktopUi = run(bin('vite'), ['--host', '127.0.0.1', '--port', '5178'], {
    cwd: path.join(root, 'apps', 'desktop'),
    env: {
      FORCE_COLOR: '1',
      SUANLIZI_API_URL: `http://127.0.0.1:${apiPort}`,
      SUANLIZI_DATA_DIR: process.env.SUANLIZI_DATA_DIR ?? process.env.SUANLIZI_PORTABLE_DATA_DIR ?? desktopDataRoot,
    },
  });

  // 等 vite 就绪并预热首页：首次请求会触发 vite 编译入口模块，编译完成后
  // 再启动 Electron，避免窗口打开后长时间空白（首屏编译热缓存）。
  // — English: wait for vite and warm the entry page — the first request makes
  //   vite compile the entry modules, so Electron opens against a warm cache
  //   instead of a long blank first paint.
  const viteReady = await waitForHttp('http://127.0.0.1:5178/');
  if (!viteReady) {
    console.error('[vite] dev server did not become ready — continuing anyway (Electron will retry)');
  }

  // Electron Main（迁移计划 Phase 1）：dev 模式加载 5178 Vite Renderer。
  // 注意：args 是相对 cwd（apps/desktop）的路径，不能带 apps/desktop 前缀，
  // 否则会拼成 apps/desktop/apps/desktop/... 导致 "Unable to find Electron app"。
  // — English: Electron Main (Phase 1) — dev mode loads the 5178 Vite renderer.
  //   args are relative to cwd (apps/desktop) — no apps/desktop prefix, or the
  //   path doubles and Electron can't find the app.
  const electronMain = run(bin('electron'), ['dist-electron/main/index.js'], {
    primary: true,
    cwd: path.join(root, 'apps', 'desktop'),
    env: {
      SUANLIZI_ELECTRON_LOAD: 'dev',
      SUANLIZI_API_URL: `http://127.0.0.1:${apiPort}`,
      SUANLIZI_BROWSER_TOKEN: browserToken,
      SUANLIZI_PORTABLE_DATA_DIR: process.env.SUANLIZI_DATA_DIR ?? process.env.SUANLIZI_PORTABLE_DATA_DIR ?? desktopDataRoot,
    },
  });

  const stop = () => {
    stopChildren();
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => stopChildren());
}
