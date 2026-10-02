import { execFile } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { sendError, sendJson } from '../shared/http.js';

const execFileAsync = promisify(execFile);

// 工作区选择结果（cancelled=true 表示用户取消，workspaceRoot 为选中路径或空
// — Chinese: workspace pick result (cancelled true means user cancelled; workspaceRoot is chosen path or empty)
export type WorkspacePickResult = {
  cancelled: boolean;
  workspaceRoot: string;
};

// 调用系统原生目录选择对话框（当前版本仅支持 Windows）
// — Chinese: invoke native folder browser (Windows only in current build)
export async function pickWorkspaceDirectory(options: { description?: string } = {}): Promise<WorkspacePickResult> {
  if (process.platform !== 'win32') {
    throw new Error('Native workspace directory picker is only available on Windows in this build.');
  }

  // PowerShell 脚本：使用 System.Windows.Forms.FolderBrowserDialog 选择 Suanlizi 工作区，并启用新建目录
  // — Chinese: PowerShell script — use System.Windows.Forms.FolderBrowserDialog
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${(options.description ?? 'Select Suanlizi workspace').replaceAll("'", "''")}'
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  const workspaceRoot = stdout.trim();
  return {
    cancelled: workspaceRoot.length === 0,
    workspaceRoot,
  };
}

// 处理 /api/workspaces/pick 路由：返回选目录或返回错误 — Chinese: handle /api/workspaces/pick route; return pick result or error
export async function handlePickWorkspaceDirectory(res: ServerResponse): Promise<void> {
  try {
    sendJson(res, 200, await pickWorkspaceDirectory());
  } catch (error) {
    sendError(res, process.platform === 'win32' ? 500 : 501, error instanceof Error ? error.message : String(error));
  }
}
