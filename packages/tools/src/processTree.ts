import { execFile, type ChildProcess } from 'node:child_process';

/** Force-close a child and all descendants across Windows and POSIX. */
export function terminateProcessTree(child: ChildProcess | null | undefined, platform = process.platform): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
}

/** Close every tracked child (used while the host process is shutting down). */
export function terminateAllProcessTrees(children: Iterable<ChildProcess>, platform = process.platform): void {
  for (const child of children) terminateProcessTree(child, platform);
}
