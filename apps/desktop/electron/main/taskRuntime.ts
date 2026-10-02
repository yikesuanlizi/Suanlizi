// 任务运行时（Phase 3）：在 Main 进程承载 Agent Runtime（orchestrator + 策略 + 预算 +
// 账本 + Trace），通过 ElectronWebContentsRuntime 驱动用户可见的 WebContentsView。
// browser-runtime 是 ESM 包，Main 是 CJS——用动态 import 接入（Node 任何版本均支持）。
// — English: task runtime (Phase 3) — the Main process hosts the Agent Runtime
//   (orchestrator + policy + budget + ledger + trace) driving the user-visible
//   WebContentsView via ElectronWebContentsRuntime. browser-runtime is ESM while
//   Main is CJS — a dynamic import bridges them (supported on any Node version).
import { ipcMain } from 'electron';
import type { WebContentsView } from 'electron';
import { ElectronWebContentsRuntime } from '../browser/ElectronWebContentsRuntime.js';
import type { BrowserViewManager } from '../browser/BrowserViewManager.js';
import type { BrowserEngineAdapter } from '../browser/BrowserEngineAdapter.js';
import { validateTabId } from '../ipc/validateIpc.js';

type BrowserRuntimeModule = typeof import('@suanlizi/browser-runtime');

let cachedModule: BrowserRuntimeModule | null = null;

async function loadBrowserRuntime(): Promise<BrowserRuntimeModule> {
  if (cachedModule === null) {
    cachedModule = await import('@suanlizi/browser-runtime');
  }
  return cachedModule;
}

export interface TaskRuntimeDeps {
  manager: BrowserViewManager;
}

// 注册 task.* IPC：runGolden（在指定 tab 的 View 上跑黄金任务）+ cancel。
// — English: registers task.* IPC — runGolden (runs a golden task on a tab's view)
//   and cancel.
export function registerTaskRuntimeIpc(deps: TaskRuntimeDeps): void {
  const { manager } = deps;
  const running = new Set<string>();

  ipcMain.handle('task:runGolden', async (_event, input: unknown) => {
    const record = input as { goldenId?: unknown; tabId?: unknown; task?: unknown };
    const goldenId = typeof record.goldenId === 'string' ? record.goldenId : '';
    const tabId = typeof record.tabId === 'string' ? record.tabId : '';
    console.error(`[task] runGolden start: ${goldenId} tab=${tabId}`);
    if (goldenId === '') throw new Error('goldenId 必须为字符串');
    if (running.has(goldenId)) throw new Error(`golden task already running: ${goldenId}`);
    running.add(goldenId);
    try {
      const resolvedTabId = tabId !== '' ? tabId : manager.listTabs()[0]?.tabId ?? '';
      const view: WebContentsView = manager.viewFor(resolvedTabId);
      console.error(`[task] view resolved: ${String(view.webContents.id)}`);
      const rt = await loadBrowserRuntime();
      console.error(`[task] browser-runtime loaded: ${typeof rt.runGoldenTaskWithOrchestrator}`);
      const { GOLDEN_TASKS, runGoldenTaskWithOrchestrator } = rt;
      let task: unknown;
      if (goldenId.startsWith('custom:')) {
        // 自定义任务：IPC 传入 JSON 任务定义（本地固定站点用）。
        // — English: custom tasks arrive as JSON task definitions via IPC (for
        //   the local fixed test site).
        task = record.task;
        if (task === undefined || typeof task !== 'object' || task === null) {
          throw new Error('custom golden task 需要 task 定义');
        }
      } else {
        task = GOLDEN_TASKS.find((t) => t.id === goldenId);
        if (task === undefined) {
          throw new Error(`unknown golden task: ${goldenId}`);
        }
      }
      // 统一 adapter 缓存（manager 按 webContents.id 复用，避免双 CDP 附着）。
      // — English: use the manager's unified adapter cache (keyed by
      //   webContents.id) so two adapters never attach the same target twice.
      const runtime = new ElectronWebContentsRuntime({
        view,
        adapter: manager.adapterForView(view),
        waitForDownload: (input) => manager.waitForNextDownload(resolvedTabId, input),
      });
      const result = await runGoldenTaskWithOrchestrator(runtime, task as Parameters<typeof runGoldenTaskWithOrchestrator>[1], {
        budget: { maxSteps: 30, maxTokens: 200_000, maxReplans: 5, maxConsecutiveFailures: 3, maxDurationMs: 5 * 60_000, maxExternalWrites: 3, maxDownloadBytes: 100 * 1024 * 1024 },
      });
      return {
        outcome: result.passed ? 'passed' : 'failed',
        failedStepId: result.failedStepId ?? null,
        stepCount: result.steps.length,
      };
    } finally {
      running.delete(goldenId);
    }
  });

  ipcMain.handle('task:cancel', (_event, input: unknown) => {
    const { tabId } = validateTabId(input);
    // Phase 3 最小化：取消 = 停止该 View 上的动作（Orchestrator 的取消由
    // GoldenTask 完成后的控制流处理；完整控制权状态机在 Phase 4）。
    // — English: Phase 3 minimal — cancel stops the view's in-flight navigation.
    void manager.stop(tabId);
  });
}
