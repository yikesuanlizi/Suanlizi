import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './link-workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const DEFAULT_WEIXIN_BRIDGE_PORT = 18790;
const children = new Set();
let stopping = false;

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
  child.on('exit', (code) => {
    children.delete(child);
    if (code && !options.allowExit) {
      stopChildren(child);
      process.exit(code);
    }
  });
  children.add(child);
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
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ host: '127.0.0.1', port });
  });
}

async function isPortFreeAnyAddress(port) {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
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
      console.warn(`[web] Weixin bridge port ${preferred} is occupied; using ${port} for this Suanlizi session.`);
      return port;
    }
  }
  return preferred;
}

function shouldStartWeixinBridge() {
  const explicit = process.env.SUANLIZI_START_WEIXIN_BRIDGE?.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(explicit ?? '')) return false;
  if (['1', 'true', 'yes', 'on'].includes(explicit ?? '')) return true;
  return true;
}

const initialBuild = run(isWindows ? 'npx.cmd' : 'npx', ['tsc', '-b'], { allowExit: true });
initialBuild.on('exit', async (code) => {
  if (code) process.exit(code);

  const webHost = process.env.SUANLIZI_WEB_HOST ?? '127.0.0.1';
  const webPort = process.env.SUANLIZI_WEB_PORT ?? '5177';
  const apiPort = process.env.SUANLIZI_API_PORT ?? '4127';
  if (!await isPortFreeAnyAddress(Number(apiPort))) {
    console.error(`[api] Port ${apiPort} is already in use. Suanlizi may already be running at http://127.0.0.1:${webPort}/.`);
    console.error(`[api] Stop the existing Suanlizi process first, or start with SUANLIZI_API_PORT=<free-port>.`);
    process.exit(1);
  }
  const logDir = path.join(root, '.suanlizi', 'logs');
  const startWeixinBridge = shouldStartWeixinBridge();
  const weixinBridgePort = startWeixinBridge ? await chooseWeixinBridgePort() : Number(process.env.SUANLIZI_WEIXIN_BRIDGE_PORT || DEFAULT_WEIXIN_BRIDGE_PORT);
  const weixinBridgeUrl = process.env.SUANLIZI_WEIXIN_BRIDGE_URL ?? `http://127.0.0.1:${weixinBridgePort}/api/v1/admin/rpc`;

  const apiEnv = {
    SUANLIZI_API_PORT: apiPort,
    SUANLIZI_WEIXIN_BRIDGE_PORT: String(weixinBridgePort),
    SUANLIZI_WEIXIN_BRIDGE_URL: weixinBridgeUrl,
    SUANLIZI_LOG_DIR: process.env.SUANLIZI_LOG_DIR ?? logDir,
  };

  const api = run(isWindows ? 'npx.cmd' : 'npx', [
    'nodemon',
    '--watch', 'apps/api/dist',
    '--watch', 'packages/*/dist',
    '--ext', 'js,json',
    '--delay', '500',
    '--quiet',
    'apps/api/dist/server.js',
  ], {
    env: apiEnv,
  });

  const web = run(bin('vite'), ['--host', webHost, '--port', webPort], {
    cwd: path.join(root, 'apps', 'web'),
    env: { FORCE_COLOR: '1' },
  });

  const weixinBridge = startWeixinBridge
    ? run('node', ['apps/desktop/bridge/weixin-bridge.mjs'], {
        env: {
          SUANLIZI_API_URL: `http://127.0.0.1:${process.env.SUANLIZI_API_PORT ?? '4127'}`,
          SUANLIZI_WEIXIN_BRIDGE_PORT: String(weixinBridgePort),
          SUANLIZI_LOG_DIR: process.env.SUANLIZI_LOG_DIR ?? logDir,
        },
      })
    : null;

  const tscWatch = run(isWindows ? 'npx.cmd' : 'npx', ['tsc', '-b', '--watch', '--preserveWatchOutput'], {
    allowExit: true,
  });

  const stop = () => {
    killChildTree(api);
    killChildTree(web);
    if (weixinBridge) killChildTree(weixinBridge);
    killChildTree(tscWatch);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log('\n  [dev] Development mode with hot reload:');
  console.log('  - TypeScript: watch mode (auto-compile on save)');
  console.log('  - API server: auto-restarts when dist/ changes');
  console.log('  - Web frontend: Vite HMR\n');
});
