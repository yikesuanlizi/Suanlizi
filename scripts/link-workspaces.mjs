import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scopeDir = path.join(root, 'node_modules', '@suanlizi');
const packages = [
  'protocol',
  'context',
  'model-gateway',
  'sandbox',
  'storage',
  'tools',
  'memory',
  'extensions',
  'i18n',
  'bot',
  'runtime',
  'browser-runtime',
  'wiki-core',
];

fs.mkdirSync(scopeDir, { recursive: true });

// 只在包清单变化时重建 junction，避免每次启动都触碰 Vite 依赖目录、
// 导致 optimizeDeps 缓存反复失效并拖慢 desktop:dev。
// — English: rebuild junctions only when the package list changes; touching
//   these dirs on every launch invalidates Vite's optimizeDeps cache.
const markerPath = path.join(scopeDir, '.links-stamp');
const stampSource = packages.join('|');
let stampMatches = false;
try {
  stampMatches = fs.readFileSync(markerPath, 'utf8') === stampSource;
} catch {
  // marker missing or unreadable
}


function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readLinkTarget(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

for (const name of packages) {
  const target = path.join(root, 'packages', name);
  const link = path.join(scopeDir, name);
  try {
    const stat = fs.lstatSync(link);
    const currentTarget = readLinkTarget(link);
    const desiredTarget = readLinkTarget(target) ?? target;
    if (currentTarget && normalizePath(currentTarget) === normalizePath(desiredTarget)) {
      continue;
    }
    if (!stat.isSymbolicLink()) {
      throw new Error(`Workspace link path exists but is not a symlink: ${link}`);
    }
    fs.rmSync(link, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

fs.writeFileSync(markerPath, stampSource);