// 应用菜单（Phase 5.1）：文件/编辑/视图/帮助 随主题 locale 中英切换。
// Renderer 的 locale 变化时经 IPC 通知 Main 重建菜单（Electron 默认英文菜单
// 无法跟随应用主题）。
// — English: the application menu (File/Edit/View/Help) switches between
//   Chinese and English with the UI locale. The renderer notifies Main via IPC
//   so the menu follows the app theme (the Electron default menu is always
//   English).
import { ipcMain, Menu, type MenuItemConstructorOptions } from 'electron';

type Locale = 'zh' | 'en';

export function registerMenuIpc(): void {
  ipcMain.handle('menu:setLocale', (_event, locale: unknown) => {
    const resolved: Locale = locale === 'zh' ? 'zh' : 'en';
    setApplicationMenu(resolved);
  });
}

export function setApplicationMenu(locale: Locale): void {
  const t = labels[locale];
  const template: MenuItemConstructorOptions[] = [
    {
      label: t.file,
      submenu: [
        { label: t.closeWindow, role: 'close' },
        { type: 'separator' },
        { label: t.quit, role: 'quit' },
      ],
    },
    {
      label: t.edit,
      submenu: [
        { label: t.undo, role: 'undo' },
        { label: t.redo, role: 'redo' },
        { type: 'separator' },
        { label: t.cut, role: 'cut' },
        { label: t.copy, role: 'copy' },
        { label: t.paste, role: 'paste' },
        { label: t.selectAll, role: 'selectAll' },
      ],
    },
    {
      label: t.view,
      submenu: [
        { label: t.reload, role: 'reload' },
        { label: t.forceReload, role: 'forceReload' },
        // F12 is the explicit fallback for windows where the focused view does
        // not deliver before-input-event (the menu role still supports Ctrl+Shift+I).
        { label: t.toggleDevTools, role: 'toggleDevTools', accelerator: 'F12' },
        { type: 'separator' },
        { label: t.resetZoom, role: 'resetZoom' },
        { label: t.zoomIn, role: 'zoomIn' },
        { label: t.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: t.toggleFullScreen, role: 'togglefullscreen' },
      ],
    },
    {
      label: t.help,
      role: 'help',
      submenu: [
        { label: t.about, click: () => void undefined },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const labels: Record<Locale, Record<string, string>> = {
  zh: {
    file: '文件',
    edit: '编辑',
    view: '视图',
    help: '帮助',
    closeWindow: '关闭窗口',
    quit: '退出',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    reload: '重新加载',
    forceReload: '强制重新加载',
    toggleDevTools: '开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullScreen: '切换全屏',
    about: '关于 Suanlizi',
  },
  en: {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    help: 'Help',
    closeWindow: 'Close Window',
    quit: 'Quit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullScreen: 'Toggle Full Screen',
    about: 'About Suanlizi',
  },
};
