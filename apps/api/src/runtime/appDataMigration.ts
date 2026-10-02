import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import * as path from 'node:path';

// 冷启动清理：历史版本错误写入项目里的 .suanlizi 运行数据目录。
// 目标已有 threads.db 时只清理项目内残留，不覆盖应用数据。
export function cleanupLegacyProjectAppData(dataDir: string): void {
  const dataRoot = path.resolve(dataDir);
  const legacyHomeRoot = path.resolve(process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming'), 'Suanlizi');
  const candidates = [legacyHomeRoot, path.resolve(process.cwd(), '.suanlizi')];
  const source = candidates.find((candidate) => existsSync(path.join(candidate, 'threads.db')));
  const staleEmpty = path.resolve(process.cwd(), '.suanlizi');

  if (existsSync(staleEmpty) && !existsSync(path.join(staleEmpty, 'threads.db'))) {
    try {
      rmSync(staleEmpty, { recursive: true, force: true });
    } catch {
      throw new Error('无法删除项目里的空数据目录：请关闭所有 Suanlizi 实例后重启。');
    }
  }

  if (!source || existsSync(path.join(dataRoot, 'threads.db'))) return;

  mkdirSync(path.dirname(dataRoot), { recursive: true });
  try {
    rmSync(dataRoot, { recursive: true, force: true });
    try {
      renameSync(source, dataRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      cpSync(source, dataRoot, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
      throw new Error(`历史数据迁移被占用：${source} -> ${dataRoot}。请先关闭所有 Suanlizi 实例后重启。`);
    }
    throw error;
  }
}
