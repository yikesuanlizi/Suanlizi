// Phase 5 打包验证：electron-builder --dir 产物（release/win-unpacked/Suanlizi.exe）
// 能启动，React 工作台（file 模式加载 dist，相对 base）挂载成功。
// — English: Phase 5 packaging verification — the electron-builder --dir
//   artifact (release/win-unpacked/Suanlizi.exe) launches and mounts the React
//   workbench (file mode loads dist with a relative base).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { _electron as electron } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const EXE = join(here, '../apps/desktop/release/win-unpacked/Suanlizi.exe');

describe('Phase 5 · 打包产物', () => {
  it('win-unpacked/Suanlizi.exe 存在', () => {
    expect(existsSync(EXE)).toBe(true);
  });

  it('打包产物启动：React 工作台挂载 + suanliziDesktop API 可用（file 模式）', async () => {
    const app = await electron.launch({
      executablePath: EXE,
      env: { ...process.env, SUANLIZI_ELECTRON_LOAD: 'file', SUANLIZI_DISABLE_SINGLE_INSTANCE: '1' },
      args: [],
    });
    try {
      const win = await app.firstWindow();
      // React 工作台挂载（#root 有子节点 = main.tsx 渲染成功）。
      // — English: the React workbench mounts (#root gets children).
      try {
        await win.waitForSelector('#root > *', { timeout: 30_000 });
      } catch {
        const url = await win.evaluate(() => window.location.href);
        const body = await win.evaluate(() => document.body?.innerHTML?.slice(0, 200) ?? '(empty)');
        const hasRoot = await win.evaluate(() => document.querySelector('#root') !== null);
        throw new Error('React workbench did not mount');
      }
      const rootChildren = await win.evaluate(() => document.querySelector('#root')?.children.length ?? 0);
      expect(rootChildren).toBeGreaterThan(0);

      // 桌面桥可用（preload typed API）。
      // — English: the desktop bridge is present (typed preload API).
      const hasBridge = await win.evaluate(() => typeof (window as unknown as { suanliziDesktop?: unknown }).suanliziDesktop === 'object');
      expect(hasBridge).toBe(true);
    } finally {
      await app.close();
    }
  }, 90_000);
});
