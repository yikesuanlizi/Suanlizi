// 图标组件：统一输出 24x24 SVG，各图标名称映射到对应的 path 数据
import React from 'react';

export type IconName =
  | 'activity'
  | 'alert'
  | 'balance'
  | 'brain'
  | 'alertTriangle'
  | 'agentGroup'
  | 'assistant'
  | 'modelGroup'
  | 'bot'
  | 'balance'
  | 'browser'
  | 'branch'
  | 'calendar'
  | 'calculator'
  | 'chevron'
  | 'chevronDown'
  | 'chevronRight'
  | 'clip'
  | 'copy'
  | 'database'
  | 'doc'
  | 'download'
  | 'eye'
  | 'eyeOff'
  | 'file'
  | 'fileArchive'
  | 'fileCode'
  | 'fileImage'
  | 'fileJson'
  | 'filePdf'
  | 'fileSettings'
  | 'fileSpreadsheet'
  | 'fileText'
  | 'fileMarkdown'
  | 'fileGit'
  | 'fileNpm'
  | 'filePhp'
  | 'filePython'
  | 'fileGo'
  | 'fileJava'
  | 'fileJavaScript'
  | 'fileTypeScript'
  | 'fileReact'
  | 'fileVue'
  | 'fileHtml'
  | 'fileCss'
  | 'fileRust'
  | 'fileC'
  | 'fileShell'
  | 'fileSql'
  | 'fileDocker'
  | 'folder'
  | 'folderCode'
  | 'folderOpen'
  | 'folderPlus'
  | 'gear'
  | 'gauge'
  | 'github'
  | 'hash'
  | 'layers'
  | 'knowledge'
  | 'memoryChip'
  | 'mermaid'
  | 'menu'
  | 'message'
  | 'messageShield'
  | 'hand'
  | 'shieldAlert'
  | 'imagePlus'
  | 'fileOutline'
  | 'folderOutline'
  | 'listChecks'
  | 'messages'
  | 'images'
  | 'monitor'
  | 'moon'
  | 'panel'
  | 'pen'
  | 'paintbrush'
  | 'play'
  | 'plus'
  | 'puppet'
  | 'pulse'
  | 'puzzle'
  | 'question'
  | 'refresh'
  | 'review'
  | 'search'
  | 'send'
  | 'spark'
  | 'sql'
  | 'stop'
  | 'sun'
  | 'terminal'
  | 'trash'
  | 'translate'
  | 'workflow'
  | 'wrench'
  | 'palette'
  | 'shield'
  | 'settingsSliders'
  | 'stopCircle'
  | 'x';

export type SidebarIconName = 'chevron' | 'folder' | 'folderCode' | 'folderOpen' | 'gear' | 'layers' | 'message' | 'messages' | 'pen' | 'plus' | 'search' | 'trash' | 'workflow';

export function SidebarIconSprite() {
  return (
    <svg aria-hidden="true" className="iconSprite">
      <symbol id="suanlizi-sidebar-layers" viewBox="0 0 24 24"><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" /></symbol>
      <symbol id="suanlizi-sidebar-chevron" viewBox="0 0 24 24"><path d="m7 9 5 5 5-5" /></symbol>
      <symbol id="suanlizi-sidebar-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></symbol>
      <symbol id="suanlizi-sidebar-workflow" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><path d="m8 7 8 4M8 17l8-4" /></symbol>
      <symbol id="suanlizi-sidebar-message" viewBox="0 0 24 24"><path d="M5 5h14v11H9l-4 3V5Z" /></symbol>
      <symbol id="suanlizi-sidebar-messages" viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h9A2.5 2.5 0 0 1 18 5.5v6a2.5 2.5 0 0 1-2.5 2.5H9l-4 2.7V14A2.5 2.5 0 0 1 2.5 11.5v-6A2.5 2.5 0 0 1 4 5.5Z" /><path d="M8 17.5A2.5 2.5 0 0 0 10.5 20h5l4 2.5V18A2.5 2.5 0 0 0 22 15.5" /></symbol>
      <symbol id="suanlizi-sidebar-folder" viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v10H3V6Z" /></symbol>
      <symbol id="suanlizi-sidebar-folderOpen" viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v3H5.5L3 19V6Z" /><path d="M5.5 11H21l-2.2 8H3l2.5-8Z" /></symbol>
      <symbol id="suanlizi-sidebar-folderCode" viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v10H3V6Z" /><path d="m10 12-2 2 2 2m4-4 2 2-2 2" /></symbol>
      <symbol id="suanlizi-sidebar-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
      <symbol id="suanlizi-sidebar-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19 12a7.6 7.6 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.8-1L14.4 3H9.6l-.3 3.1a8 8 0 0 0-1.8 1l-2.4-1-2 3.4L5.1 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.8 1l.3 3h4.8l.3-3a8 8 0 0 0 1.8-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1Z" /></symbol>
      <symbol id="suanlizi-sidebar-pen" viewBox="0 0 24 24"><path d="m4 20 4.2-1 9.6-9.6-3.2-3.2L5 15.8 4 20Z" /><path d="m13.8 7.2 3.2 3.2" /></symbol>
      <symbol id="suanlizi-sidebar-trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14" /></symbol>
    </svg>
  );
}

export function SidebarIcon({ className, name }: { className: 'icon' | 'row-icon'; name: SidebarIconName }) {
  return <svg aria-hidden="true" className={className} viewBox="0 0 24 24"><use href={`#suanlizi-sidebar-${name}`} /></svg>;
}

export function Icon({ className, name }: { className?: string; name: IconName }) {
  const paths: Partial<Record<IconName, React.ReactNode>> = {
    filePhp: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 17v-5h1.6a1.4 1.4 0 0 1 0 2.8H8"/><path d="M13.5 17v-5m0 2.4h2.6m0-2.4v5"/></>,
    fileNpm: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8.5 17.5v-5h7v5"/><path d="M12 12.5v5"/></>,
    fileGit: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="10" cy="17.5" r="1.5"/><circle cx="15" cy="12.5" r="1.5"/><path d="M10 16v-3a2 2 0 0 1 2-2h1.5"/></>,
    fileMarkdown: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 17v-5l2 3 2-3v5"/></>,
    // 记忆设置页专用；思考档位的“均衡”改用 balance（天平）
    brain: <><path d="M12 18V5" /><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" /><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" /><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" /><path d="M18 18a4 4 0 0 0 2-7.464" /><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" /><path d="M6 18a4 4 0 0 1-2-7.464" /><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" /></>,
    knowledge: <><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></>,
    // 权限与输入框功能图标：与 DeepSeek Harness / Codex 同为细线描边风格
    hand: <><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" /><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" /><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></>,
    messageShield: <><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /><path d="M15.6 6.6 17.5 7.4v1.5c0 1.5-.95 2.4-1.9 2.85-.95-.45-1.9-1.35-1.9-2.85V7.4l1.9-.8Z" /><path d="m14.4 9.15.85.85 1.5-1.6" /></>,
    shieldAlert: <><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="M12 8v4" /><path d="M12 16h.01" /></>,
    imagePlus: <><path d="M16 5h6" /><path d="M19 2v6" /><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /><circle cx="9" cy="9" r="2" /></>,
    fileOutline: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>,
    folderOutline: <><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></>,
    listChecks: <><path d="M13 5h8" /><path d="M13 12h8" /><path d="M13 19h8" /><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /></>,
    activity: <path d="M3 12h4l2-7 4 14 2-7h6" />,
    alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></>,
    alertTriangle: <><path d="m12 3 9 17H3L12 3Z" /><path d="M12 9v5M12 17h.01" /></>,
    agentGroup: <><circle cx="9" cy="9" r="3" /><circle cx="17" cy="10" r="2.5" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 16a4 4 0 0 1 5.5 3" /></>,
    assistant: <><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" /></>,
    modelGroup: <><circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><path d="M5 16h14M8 13v6m8-6v6" /></>,
    bot: <><rect x="5" y="7" width="14" height="12" rx="3" /><path d="M9 12h.01M15 12h.01M12 7V4m-2 0h4M8 19v2m8-2v2" /></>,
    balance: <><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="M7 21h10" /><path d="M12 3v18" /><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" /></>,
    browser: (
      <>
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <line x1="2" y1="9" x2="22" y2="9" />
        <circle cx="6" cy="6" r="0.8" fill="currentColor" stroke="none" />
        <circle cx="9" cy="6" r="0.8" fill="currentColor" stroke="none" />
      </>
    ),
    branch: <path d="M6 4v5a3 3 0 0 0 3 3h6M6 20v-5a3 3 0 0 1 3-3m6-4 4 4-4 4" />,
    calendar: (
      <>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </>
    ),
    calculator: (
      <>
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <line x1="8" y1="6" x2="16" y2="6" />
        <line x1="8" y1="12" x2="8" y2="12" />
        <line x1="12" y1="12" x2="12" y2="12" />
        <line x1="16" y1="12" x2="16" y2="12" />
        <line x1="8" y1="16" x2="8" y2="16" />
        <line x1="12" y1="16" x2="12" y2="16" />
        <line x1="16" y1="16" x2="16" y2="16" />
      </>
    ),
    chevron: <><path d="m15 18-6-6 6-6" /></>,
    chevronDown: <><path d="m6 9 6 6 6-6" /></>,
    chevronRight: <><path d="m9 18 6-6-6-6" /></>,
    clip: <path d="m21.4 11.6-8.6 8.6a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
    copy: <path d="M8 8h11v11H8zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />,
    database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" /></>,
    doc: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="13" y2="17" />
      </>
    ),
    download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />,
    eye: <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
    eyeOff: <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.1 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a10.8 10.8 0 0 0 4.1-.8" />,
    file: <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8M8 17h5" />,
    fileArchive: <><path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M10 10h4m-4 3h4m-4 3h4m-2-6v6" /></>,
    fileCode: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="m10 13-2 2 2 2m4-4 2 2-2 2" /></>,
    fileImage: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M7 18l3-3 2 2 2-2 3 3M8 11h.01" /></>,
    fileJson: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M10 13l-1.5 1.5L10 16m4-3 1.5 1.5L14 16" /></>,
    filePdf: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M8 17h2a1.5 1.5 0 0 0 0-3H8v5m5-5h1a2 2 0 0 1 0 4h-1v-4m4 0v5m0-2h2" /></>,
    fileSettings: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M10 14h6m-6 3h4" /></>,
    fileSpreadsheet: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M8 13h8M8 17h8M12 11v8" /></>,
    fileText: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>,
    filePython: <path d="M6 4h7a3 3 0 0 1 3 3v4H9a3 3 0 0 1-3-3V4Zm12 16h-7a3 3 0 0 1-3-3v-4h7a3 3 0 0 1 3 3v4Z" />,
    fileGo: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M15 14.4a3 3 0 1 0 0 2.4h-2.2"/></>,
    fileJava: <path d="M8 18h8M9 21h6M10 15c4 1 6-1 4-3-2-1-2-3 0-5M7 12c-2 2 0 4 3 4" />,
    fileJavaScript: <path d="M5 3h14v18H5zM8 16c0 2 3 2 3 0v-4M15 12v6c0 2-3 2-3 0" />,
    fileTypeScript: <path d="M4 4h16v16H4zM7 9h6M10 9v7m4-3h3c2 0 2 3 0 3h-3" />,
    fileReact: <><circle cx="12" cy="12" r="2" /><ellipse cx="12" cy="12" rx="9" ry="4" /><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)" /></>,
    fileVue: <path d="m4 5 4 0 4 7 4-7h4l-8 14L4 5Z" />,
    fileHtml: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-1.6 2.5L10 18"/><path d="m14 13 1.6 2.5L14 18"/></>,
    fileCss: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M11.2 12.6c-1 0-1.2.5-1.2 1.4v.6c0 .9-.2 1.4-1.2 1.4"/><path d="M13.8 12.6c1 0 1.2.5 1.2 1.4v.6c0 .9.2 1.4 1.2 1.4"/></>,
    fileRust: <><path d="M5 7h14v10H5z" /><path d="m8 7 1-3h6l1 3m-8 10 1 3h6l1-3M8 12h8" /></>,
    fileC: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M15 14.4a3 3 0 1 0 0 3.2"/></>,
    fileShell: <path d="m5 7 5 5-5 5m7 0h7" />,
    fileSql: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
    fileDocker: <><path d="M3 14h18M5 11h3V8h3v3h3V8h3v3h3M5 14c1 5 5 7 9 7 3 0 6-1 7-4" /></>,
    folder: <path d="M3 6h6l2 2h10v10H3V6Z" />,
    folderCode: <><path d="M3 6h6l2 2h10v10H3V6Z" /><path d="m10 12-2 2 2 2m4-4 2 2-2 2" /></>,
    folderOpen: <><path d="M3 6h6l2 2h10v3H5.5L3 19V6Z" /><path d="M5.5 11H21l-2.2 8H3l2.5-8Z" /></>,
    folderPlus: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Zm9 3v5m-2.5-2.5h5" />,
    gear: <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.2 4.8a7.7 7.7 0 0 0 0-2.6l2-1.5-2-3.4-2.4 1a8 8 0 0 0-2.2-1.3L15.3 3h-4l-.3 2.5a8 8 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.5a7.7 7.7 0 0 0 0 2.6l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 2.2 1.3l.3 2.5h4l.3-2.5a8 8 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.5Z" />,
    gauge: <><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></>,
    github: <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />,
    hash: <path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17" />,
    layers: <><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" /></>,
    memoryChip: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="8" y="8" width="8" height="8" rx="1" />
        <line x1="9" y1="2" x2="9" y2="4" />
        <line x1="15" y1="2" x2="15" y2="4" />
        <line x1="9" y1="20" x2="9" y2="22" />
        <line x1="15" y1="20" x2="15" y2="22" />
      </>
    ),
    mermaid: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="15" y="15" width="6" height="6" rx="1" />
        <rect x="15" y="3" width="6" height="6" rx="1" />
        <line x1="9" y1="6" x2="15" y2="6" />
        <line x1="18" y1="9" x2="18" y2="15" />
      </>
    ),
    // 中文注释：移动端菜单按钮的汉堡图标
    // — Chinese: hamburger icon for mobile menu button
    menu: (
      <>
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </>
    ),
    message: <path d="M5 5h14v11H9l-4 3V5Z" />,
    messages: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h9A2.5 2.5 0 0 1 18 5.5v6a2.5 2.5 0 0 1-2.5 2.5H9l-4 2.7V14A2.5 2.5 0 0 1 2.5 11.5v-6A2.5 2.5 0 0 1 4 5.5Z" /><path d="M8 17.5A2.5 2.5 0 0 0 10.5 20h5l4 2.5V18A2.5 2.5 0 0 0 22 15.5" /></>,
    images: <><rect x="3" y="5" width="15" height="14" rx="2" /><path d="m5 16 4-4 3 3 2-2 4 4M16 8h5v11a2 2 0 0 1-2 2H8" /><circle cx="8" cy="9" r="1" /></>,
    monitor: <><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></>,
    moon: <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 6.8 6.8 0 0 0 20 14.5Z" />,
    panel: <path d="M4 5h16v14H4zM15 5v14" />,
    pen: <><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></>,
    paintbrush: <><path d="m14 4 6 6-8.5 8.5a3 3 0 0 1-4.2-4.2L16 5.6" /><path d="M5 19c-1.3 1.3-1.3 2.7 0 2.7 2.2 0 3.3-1.2 3.3-2.7 0-1.1-.8-1.7-1.7-1.7" /></>,
    play: <><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    puppet: (
      <>
        <line x1="12" y1="2" x2="12" y2="8" />
        <line x1="6" y1="4" x2="9" y2="8" />
        <line x1="18" y1="4" x2="15" y2="8" />
        <rect x="8" y="8" width="8" height="8" rx="1" />
        <line x1="6" y1="14" x2="8" y2="12" />
        <line x1="18" y1="14" x2="16" y2="12" />
        <line x1="10" y1="16" x2="10" y2="20" />
        <line x1="14" y1="16" x2="14" y2="20" />
      </>
    ),
    pulse: <><circle cx="12" cy="12" r="8.5" /><path d="M7 12h2l1.5-3 3 6 1.5-3H17" /></>,
    puzzle: <path d="M9 3h3a2 2 0 0 1 4 0h3v4a2 2 0 0 1 0 4v4h-4a2 2 0 0 0-4 0H7v-4a2 2 0 0 0 0-4V3h2Z" />,
    question: <path d="M9.1 9a3 3 0 1 1 4.8 2.4c-1 .7-1.9 1.3-1.9 2.6m0 3h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" />,
    refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
    review: (
      <>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </>
    ),
    search: <path d="m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />,
    send: <><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /><path d="m21.854 2.147-10.94 10.939" /></>,
    spark: <path d="M12 3l1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8L12 3Zm6 11 1 2.7 2.7 1-2.7 1-1 2.8-1-2.8-2.7-1 2.7-1 1-2.7ZM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z" />,
    sql: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 5v6c0 1.66-4 3-9 3s-9-1.34-9-3V5" />
        <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
      </>
    ),
    stop: <path d="M8 8h8v8H8z" />,
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" />
      </>
    ),
    terminal: <path d="m4 7 5 5-5 5M11 17h9" />,
    trash: <path d="M4 7h16M9 7V5h6v2m-8 3 .5 10h9l.5-10" />,
    translate: (
      <>
        <path d="M4 5h7" />
        <path d="M9 3v2c0 4.418-2.239 8-5 8" />
        <path d="M5 9c0 2.144 2.952 3.908 6.7 4" />
        <path d="M12 20l4-9 4 9" />
        <path d="M14.5 16.5h3" />
      </>
    ),
    workflow: <><rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" /></>,
    wrench: <path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.8 2.8-2.1-2.1 2.8-2.8Z" />,
    palette: (
      <>
        <path d="M12 3a9 9 0 0 0 0 18c1.7 0 2-1.3 1.3-2.2-.8-1 .1-2.3 1.2-2.3H17a4 4 0 0 0 4-4c0-5-4.5-9-9-9Z" />
        <circle cx="7.5" cy="11" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="10" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="14" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="16.5" cy="11" r="1.1" fill="currentColor" stroke="none" />
      </>
    ),
    shield: <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />,
    settingsSliders: <><path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2" /><circle cx="14" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></>,
    stopCircle: <><circle cx="12" cy="12" r="10" /><rect x="9" y="9" width="6" height="6" rx="1" /></>,
    x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  };
  // paths 映射：图标名称到 SVG path 节点
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
      {paths[name]}
    </svg>
  );
}
