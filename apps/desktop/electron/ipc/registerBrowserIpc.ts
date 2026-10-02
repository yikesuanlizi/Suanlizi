// 浏览器 IPC 注册（迁移计划 §7 目标目录 ipc/registerBrowserIpc.ts）。
// 所有 handler 只暴露领域方法；Renderer 永远不接触 webContents.debugger 等原始对象。
// — English: browser IPC registration (§7) — handlers expose domain methods only;
//   the renderer never touches raw objects such as webContents.debugger.
import { ipcMain } from 'electron';
import type { BrowserViewManager } from '../browser/BrowserViewManager.js';
import type { BrowserEngineAdapter } from '../browser/BrowserEngineAdapter.js';
import {
  validateClick,
  validateCreateTab,
  validateEvaluate,
  validateInsertText,
  validateNavigate,
  validateListTabs,
  validateTabBounds,
  validateTabId,
  validateScopedTabId,
  requireThreadScope,
  validateTabVisible,
} from './validateIpc.js';

export interface BrowserIpcDeps {
  manager: BrowserViewManager;
  adapterFor(tabId: string): BrowserEngineAdapter;
}

export function registerBrowserIpc(deps: BrowserIpcDeps): void {
  const { manager } = deps;

  ipcMain.handle('browser:createTab', (_event, input: unknown) => {
    const tab = validateCreateTab(input);
    // Every renderer-created page must belong to the active conversation. An
    // unscoped tab could otherwise be claimed later by an unrelated Agent run.
    return manager.createTab({ ...tab, threadId: requireThreadScope(tab.threadId) });
  });

  ipcMain.handle('browser:setBounds', (_event, input: unknown) => {
    const { tabId, bounds, threadId } = validateTabBounds(input);
    // A layout frame can arrive after its React tab has been closed. It is a
    // stale renderer update, not an agent operation, so it must not turn into
    // an unhandled IPC rejection or revive an obsolete native view.
    if (!manager.hasTab(tabId)) return;
    manager.setBounds(tabId, bounds, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:setVisible', (_event, input: unknown) => {
    const { tabId, visible, threadId } = validateTabVisible(input);
    manager.setVisible(tabId, visible, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:activateTab', (_event, input: unknown) => {
    const { tabId, threadId } = validateScopedTabId(input);
    // See the matching setBounds guard above: closing and layout are async.
    if (!manager.hasTab(tabId)) return;
    manager.activateTab(tabId, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:navigate', (_event, input: unknown) => {
    const { tabId, url, threadId } = validateNavigate(input);
    manager.navigate(tabId, url, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:back', (_event, input: unknown) => {
    const { tabId, threadId } = validateTabId(input);
    return manager.back(tabId, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:forward', (_event, input: unknown) => {
    const { tabId, threadId } = validateTabId(input);
    return manager.forward(tabId, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:reload', (_event, input: unknown) => {
    const { tabId, threadId } = validateTabId(input);
    manager.reload(tabId, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:stop', (_event, input: unknown) => {
    const { tabId, threadId } = validateTabId(input);
    manager.stop(tabId, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:focus', (_event, input: unknown) => {
    const { tabId, threadId } = validateTabId(input);
    manager.focus(tabId, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:toggleDevTools', (_event, input: unknown) => {
    const { tabId, threadId } = validateTabId(input);
    manager.toggleDevTools(tabId, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:evaluate', async (_event, input: unknown) => {
    const evalInput = validateEvaluate(input);
    manager.assertTabScope(evalInput.tabId, requireThreadScope(evalInput.threadId));
    return deps.adapterFor(evalInput.tabId).evaluate(evalInput);
  });

  ipcMain.handle('browser:click', async (_event, input: unknown) => {
    const clickInput = validateClick(input);
    manager.assertTabScope(clickInput.tabId, requireThreadScope(clickInput.threadId));
    await deps.adapterFor(clickInput.tabId).click(clickInput);
  });

  ipcMain.handle('browser:insertText', async (_event, input: unknown) => {
    const { tabId, text, threadId } = validateInsertText(input);
    manager.assertTabScope(tabId, requireThreadScope(threadId));
    await deps.adapterFor(tabId).insertText(text);
  });

  ipcMain.handle('browser:closeTab', (_event, input: unknown) => {
    const { tabId, threadId } = validateTabId(input);
    manager.destroy(tabId, requireThreadScope(threadId));
  });

  ipcMain.handle('browser:closeAll', (_event, input: unknown) => {
    const { threadId } = validateListTabs(input);
    manager.destroyThreadTabs(requireThreadScope(threadId));
  });

  ipcMain.handle('browser:hideAll', (_event, input: unknown) => {
    manager.hideAll(requireThreadScope(validateListTabs(input).threadId));
  });

  ipcMain.handle('browser:listTabs', (_event, input: unknown) => manager.listTabs(requireThreadScope(validateListTabs(input).threadId)));

  ipcMain.handle('browser:hasPendingAgentRequest', () => manager.hasPendingAgentBrowserRequest());
  ipcMain.handle('browser:pendingAgentRequestTaskIds', () => manager.pendingAgentBrowserRequestTaskIds());
}
