// Preload（sandbox 模式）：只通过 contextBridge 暴露白名单领域 API。
// 禁止暴露 ipcRenderer、任意 channel、webContents 或 Node 能力（迁移计划 §7）。
// 注意：sandbox: true 的 preload 必须是 CJS，且只能 require('electron') 等受限模块。
// — English: sandboxed preload — exposes only a whitelisted domain API via
//   contextBridge. Never exposes ipcRenderer, raw channels, webContents or Node
//   capabilities (§7). Sandboxed preloads must be CJS and may only require
//   limited modules such as 'electron'.
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopCapabilitiesContract } from '../contracts/browserTypes.js';

export interface SuanliziDesktopApi {
  browser: {
    createTab(input: unknown): Promise<unknown>;
    setBounds(input: unknown): Promise<void>;
    setVisible(input: unknown): Promise<void>;
    activateTab(input: unknown): Promise<void>;
    navigate(input: unknown): Promise<void>;
    back(input: unknown): Promise<boolean>;
    forward(input: unknown): Promise<boolean>;
    reload(input: unknown): Promise<void>;
    stop(input: unknown): Promise<void>;
    focus(input: unknown): Promise<void>;
    toggleDevTools(input: unknown): Promise<void>;
    evaluate(input: unknown): Promise<unknown>;
    click(input: unknown): Promise<void>;
    insertText(input: unknown): Promise<void>;
    closeTab(input: unknown): Promise<void>;
    closeAllTabs(input?: unknown): Promise<void>;
    hideAllTabs(input?: unknown): Promise<void>;
    listTabs(input?: unknown): Promise<unknown>;
    hasPendingAgentRequest(): Promise<boolean>;
    pendingAgentRequestTaskIds(): Promise<string[]>;
    subscribe(handler: (event: unknown) => void): () => void;
  };
  // 窗口控制（替换 Tauri window.getCurrentWindow）。
  // — English: window controls (replaces Tauri window.getCurrentWindow).
  windowControls: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    startDragging(): Promise<void>;
    onMaximizedChanged(handler: (maximized: boolean) => void): () => void;
  };
  // 桌面能力与系统服务（替换 Tauri desktop_capabilities / open_path）。
  // — English: desktop capabilities & system services (replaces Tauri commands).
  desktop: {
    capabilities(): Promise<DesktopCapabilitiesContract>;
    openPath(path: string): Promise<boolean>;
    showItemInFolder(path: string): Promise<void>;
  };
  appearance: {
    setTheme(input: { source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' }): Promise<void>;
  };
  menu: {
    setLocale(locale: 'zh' | 'en'): Promise<void>;
  };
  // Agent Runtime 任务（Phase 3：orchestrator 在 Main 进程驱动真实 View）。
  // — English: Agent Runtime tasks (Phase 3 — the orchestrator runs in Main and
  //   drives the real view).
  task: {
    runGolden(input: { goldenId: string; tabId?: string; task?: unknown }): Promise<{ outcome: string; failedStepId: string | null; stepCount: number }>;
    cancel(input: { tabId: string }): Promise<void>;
  };
}

const api: SuanliziDesktopApi = {
  browser: {
    createTab: (input) => ipcRenderer.invoke('browser:createTab', input),
    setBounds: (input) => ipcRenderer.invoke('browser:setBounds', input),
    setVisible: (input) => ipcRenderer.invoke('browser:setVisible', input),
    activateTab: (input) => ipcRenderer.invoke('browser:activateTab', input),
    navigate: (input) => ipcRenderer.invoke('browser:navigate', input),
    back: (input) => ipcRenderer.invoke('browser:back', input),
    forward: (input) => ipcRenderer.invoke('browser:forward', input),
    reload: (input) => ipcRenderer.invoke('browser:reload', input),
    stop: (input) => ipcRenderer.invoke('browser:stop', input),
    focus: (input) => ipcRenderer.invoke('browser:focus', input),
    toggleDevTools: (input) => ipcRenderer.invoke('browser:toggleDevTools', input),
    evaluate: (input) => ipcRenderer.invoke('browser:evaluate', input),
    click: (input) => ipcRenderer.invoke('browser:click', input),
    insertText: (input) => ipcRenderer.invoke('browser:insertText', input),
    closeTab: (input) => ipcRenderer.invoke('browser:closeTab', input),
    closeAllTabs: (input) => ipcRenderer.invoke('browser:closeAll', input),
    hideAllTabs: (input) => ipcRenderer.invoke('browser:hideAll', input),
    listTabs: (input) => ipcRenderer.invoke('browser:listTabs', input),
    hasPendingAgentRequest: () => ipcRenderer.invoke('browser:hasPendingAgentRequest'),
    pendingAgentRequestTaskIds: () => ipcRenderer.invoke('browser:pendingAgentRequestTaskIds'),
    subscribe: (handler) => {
      const listener = (_event: unknown, payload: unknown): void => {
        handler(payload);
      };
      ipcRenderer.on('browser:event', listener);
      return () => {
        ipcRenderer.removeListener('browser:event', listener);
      };
    },
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    startDragging: () => ipcRenderer.invoke('window:startDragging'),
    onMaximizedChanged: (handler) => {
      const listener = (_event: unknown, payload: unknown): void => {
        handler(payload === true);
      };
      ipcRenderer.on('window:maximized-changed', listener);
      return () => {
        ipcRenderer.removeListener('window:maximized-changed', listener);
      };
    },
  },
  desktop: {
    capabilities: () => ipcRenderer.invoke('desktop:capabilities'),
    openPath: (path) => ipcRenderer.invoke('desktop:openPath', path),
    showItemInFolder: (path) => ipcRenderer.invoke('desktop:showItemInFolder', path),
  },
  appearance: {
    setTheme: (input) => ipcRenderer.invoke('appearance:setTheme', input),
  },
  menu: {
    setLocale: (locale) => ipcRenderer.invoke('menu:setLocale', locale),
  },
  task: {
    runGolden: (input) => ipcRenderer.invoke('task:runGolden', input),
    cancel: (input) => ipcRenderer.invoke('task:cancel', input),
  },
};

contextBridge.exposeInMainWorld('suanliziDesktop', api);
