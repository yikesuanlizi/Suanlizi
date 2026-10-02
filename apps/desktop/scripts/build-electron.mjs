// Electron 构建脚本：tsc 编译 electron/ → dist-electron/，并复制非 TS 资源
// （phase0 renderer.html）+ 写入 CJS 标记（宿主 package.json 是 ESM）。
// — English: Electron build script — compiles electron/ → dist-electron/, copies
//   non-TS assets (phase0 renderer.html) and writes the CJS marker (the host
//   package.json is ESM).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..');
const workspaceRoot = join(desktopRoot, '..', '..');
const outDir = join(desktopRoot, 'dist-electron');

// Windows 下 npx 是 .cmd 包装，直接调用 typescript 编译器入口更稳。
// — English: on Windows npx is a .cmd shim — invoke the tsc entry directly.
const require = createRequire(import.meta.url);
const tscEntry = require.resolve('typescript/bin/tsc');

// Electron Main 在运行时通过 workspace 包名动态导入其 dist（尤其是
// @suanlizi/browser-runtime）。先构建根 project，避免仅编译 Electron 壳而让
// 新协议停留在 src、运行时仍加载旧 dist。
execFileSync(process.execPath, [tscEntry, '-p', 'tsconfig.electron.json'], { cwd: desktopRoot, stdio: 'inherit' });

// 非 TS 资源复制：phase0 测试 Renderer。
// — English: copy non-TS assets — the phase0 test renderer.
mkdirSync(join(outDir, 'phase0'), { recursive: true });
cpSync(join(desktopRoot, 'electron/phase0/renderer.html'), join(outDir, 'phase0/renderer.html'));

// CJS 标记：宿主 package.json 是 ESM，编译产物必须按 CommonJS 解析。
// — English: CJS marker — the host package.json is ESM, so the compiled output
//   must be resolved as CommonJS.
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));
console.log('[electron:build] dist-electron ready');
