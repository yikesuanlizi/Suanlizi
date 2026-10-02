// Phase 3 集成测试：Agent Runtime（orchestrator + 策略 + 预算 + 账本）在 Main 进程
// 通过 ElectronWebContentsRuntime 驱动同一 WebContentsView 执行黄金任务。
// 站点用本地固定站点（自定义任务 JSON，避免 golden.test 假域名 DNS 失败）。
// — English: Phase 3 integration — the Agent Runtime (orchestrator + policy +
//   budget + ledger) in Main drives the same WebContentsView via
//   ElectronWebContentsRuntime to run a golden task against a local fixed site.
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(here, '../apps/desktop/dist-electron/main/index.js');

const LIST_HTML = `<!doctype html><html><body>
<h1 id="list-title">本地结果列表</h1>
<a id="item-1" href="/detail">结果一</a>
</body></html>`;
const DETAIL_HTML = `<!doctype html><html><body>
<h1 id="detail-title">结果详情</h1>
<p>详情内容</p>
</body></html>`;

let site: Server;
let baseUrl = '';

beforeAll(async () => {
  site = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url?.startsWith('/detail') ? DETAIL_HTML : LIST_HTML);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const address = site.address();
  if (typeof address === 'object' && address !== null) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  } else {
    throw new Error('test site failed to bind');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
});

function launchPhase0() {
  return electron.launch({ args: [MAIN_JS], env: { ...process.env, SUANLIZI_ELECTRON_LOAD: 'phase0', SUANLIZI_DISABLE_SINGLE_INSTANCE: '1' }, log: true });
}

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

async function browserApi<T>(win: ElectronApp, call: string, arg?: unknown): Promise<T> {
  return win.evaluate(
    ([callExpr, argValue]) => {
      const api = (window as unknown as { suanliziDesktop: { browser: Record<string, (a: unknown) => Promise<unknown>> } }).suanliziDesktop.browser;
      return api[callExpr](argValue) as Promise<unknown>;
    },
    [call, arg],
  ) as Promise<T>;
}

async function taskApi<T>(win: ElectronApp, call: string, arg?: unknown): Promise<T> {
  return win.evaluate(
    ([callExpr, argValue]) => {
      const api = (window as unknown as { suanliziDesktop: { task: Record<string, (a: unknown) => Promise<unknown>> } }).suanliziDesktop.task;
      return api[callExpr](argValue) as Promise<unknown>;
    },
    [call, arg],
  ) as Promise<T>;
}

// 本地站点自定义黄金任务（结构与内置 GOLDEN_TASKS 一致）。
// — English: a custom golden task for the local site (same shape as the built-ins).
function localGoldenTask(): unknown {
  return {
    id: 'custom:local-list-detail',
    goal: '打开本地列表并点击进入详情',
    site: {
      startUrl: `${baseUrl}/`,
      pages: [
        {
          url: `${baseUrl}/`,
          title: '本地结果列表',
          elements: [{ ref: 'item-1', role: 'link', name: '结果一', text: '结果一', href: '/detail' }],
          content: [{ type: 'heading', text: '本地结果列表' }],
        },
        {
          url: `${baseUrl}/detail`,
          title: '结果详情',
          elements: [{ ref: 'detail', role: 'heading', name: '结果详情' }],
          content: [{ type: 'heading', text: '结果详情' }],
        },
      ],
    },
    steps: [
      { id: 's1', description: '打开本地列表', navigate: { url: `${baseUrl}/` } },
      {
        id: 's2',
        description: '点击结果一进入详情',
        act: {
          kind: 'click',
          targetRef: '[e1]',
          postcondition: { kind: 'url_contains', value: '/detail' },
          effect: 'none',
          risk: 'low',
        },
      },
      { id: 's3', description: '断言已在详情页', assert: { kind: 'url', pageUrlContains: '/detail' } },
    ],
  };
}

describe('Phase 3 · Agent Runtime 接线（真实 View）', () => {
  it('黄金任务经 orchestrator 在 Electron 真实 View 上全闭环 passed', async () => {
    const app = await launchPhase0();
    const proc = app.process();
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) {
      }
    });
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });

      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: `${baseUrl}/`,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });

      const result = await taskApi<{ outcome: string; failedStepId: string | null; stepCount: number }>(win, 'runGolden', {
        goldenId: 'custom:local-list-detail',
        tabId: tab.tabId,
        task: localGoldenTask(),
      });
      expect(result.outcome).toBe('passed');
      expect(result.failedStepId).toBeNull();
      expect(result.stepCount).toBeGreaterThanOrEqual(3);

      // 同一 View 上 Agent 动作的结果可见：页面已导航到详情页。
      // — English: the agent's actions are visible on the SAME view — the page
      //   has navigated to the detail page.
      const finalUrl = await browserApi<string>(win, 'evaluate', {
        tabId: tab.tabId,
        expression: 'location.href',
      });
      expect(finalUrl).toContain('/detail');
    } finally {
      await app.close();
    }
  }, 90_000);

  it('取消只终止任务，不误杀 Electron 主进程（取消后应用仍可操作）', async () => {
    const app = await launchPhase0();
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('#btn-create', { timeout: 15_000 });
      const tab = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: `${baseUrl}/`,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });

      // 先触发一个带长等待步骤的任务，随后取消。
      // — English: run a task with a long wait step, then cancel.
      const slowTask = {
        ...(localGoldenTask() as Record<string, unknown>),
        steps: [
          { id: 's1', description: '打开本地列表', navigate: { url: `${baseUrl}/` } },
          { id: 's2', description: '等待', act: { kind: 'wait', arguments: { durationMs: 5000 }, postcondition: { kind: 'none' }, effect: 'none', risk: 'low' } },
        ],
      };
      const runPromise = taskApi<{ outcome: string }>(win, 'runGolden', {
        goldenId: 'custom:slow',
        tabId: tab.tabId,
        task: slowTask,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      await taskApi<void>(win, 'cancel', { tabId: tab.tabId });

      // 取消后主进程仍存活：继续执行浏览器操作（新建第二个标签）。
      // — English: after cancel the main process is still alive — we can still
      //   create another tab.
      const tab2 = await browserApi<{ tabId: string }>(win, 'createTab', {
        url: `${baseUrl}/detail`,
        bounds: { x: 0, y: 40, width: 800, height: 600 },
      });
      expect(tab2.tabId).toMatch(/^tab-\d+$/);

      await runPromise;
    } finally {
      await app.close();
    }
  }, 90_000);
});
