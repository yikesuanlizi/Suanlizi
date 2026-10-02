import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ThreadActivityDot, WorkspaceThreadList } from './WorkspaceThreadList.js';
import type { ThreadMeta } from '../shared/types.js';

function thread(threadId: string, workspaceRoot = 'E:/langchain'): ThreadMeta {
  return {
    threadId,
    title: threadId,
    workspaceRoot,
    status: 'idle',
    turnCount: 1,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
  };
}

describe('ThreadActivityDot', () => {
  it('renders running and unread dots but not idle state', () => {
    expect(renderToStaticMarkup(React.createElement(ThreadActivityDot, { state: 'idle' }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(ThreadActivityDot, { state: 'running' }))).toContain('threadActivityDot running');
    expect(renderToStaticMarkup(React.createElement(ThreadActivityDot, { state: 'unread' }))).toContain('threadActivityDot unread');
  });
});

describe('WorkspaceThreadList', () => {
  it('keeps settings pinned to the bottom of the sidebar', () => {
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/src/styles.css'), 'utf8');
    expect(css).toMatch(/\.threadListPanel\s*\{[^}]*flex-col/s);
    expect(css).toMatch(/\.threadListScroll\s*\{[^}]*flex-1/s);
    expect(css).toMatch(/\.threadListFooter\s*\{[^}]*mt-auto/s);
  });

  it('keeps the search launcher as a full-width sidebar row', () => {
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/src/styles.css'), 'utf8');
    expect(css).toMatch(/\.workspaceThreadsHeader\s*\{[^}]*w-full/s);
    expect(css).toMatch(/\.searchLauncher\s*\{[^}]*w-full/s);
    expect(css).toMatch(/\.searchLauncher span\s*\{[^}]*flex-1/s);
  });

  it('gives the conversation title priority over a compact, single-line timestamp', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/components/WorkspaceThreadList.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/src/styles.css'), 'utf8');
    expect(source).toContain('className="workspaceThreadTimestamp"');
    expect(css).toContain('.appShell .workspaceThreadTimestamp');
    expect(css).toContain('white-space: nowrap');
    expect(css).toContain('.appShell .workspaceThreadMain {\n  display: flex;\n  width: 100%;');
    expect(css).toContain('.appShell .workspaceThreadActions {\n  position: absolute;');
    expect(css).toContain('background: inherit !important;');
    expect(css).toContain('-webkit-mask-image: linear-gradient(to right, transparent 0, #000 16px, #000 100%)');
    expect(css).toContain('padding-right: 8px !important;');
    expect(css).not.toContain('.appShell .workspaceThreadRow.active .workspaceThreadActions');
    expect(css).toContain('-webkit-mask-image: linear-gradient(to right, #000 0%, #000 42%');
  });

  it('mounts the search dialog at the document root so the sidebar cannot clip it', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/components/WorkspaceThreadList.tsx'), 'utf8');
    expect(source).toContain("import { createPortal } from 'react-dom'");
    expect(source).toContain('createPortal(dialog, document.body)');
  });

  it('keeps the sidebar collapse control visible and points it left', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/components/WorkspaceThreadList.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/src/styles.css'), 'utf8');
    expect(source).toContain('<Icon className="icon" name="chevron" />');
    expect(css).toContain('.appShell .workspaceThreadsHeader > .miniIconButton');
    expect(css).toContain('visibility: visible');
  });

  it('renders workspace group actions and compact thread rows without child threads', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceThreadList, {
      activeThreadId: 'a',
      busy: false,
      currentWorkspaceRoot: 'E:/langchain',
      locale: 'zh',
      rememberedRoots: ['D:/empty'],
      runningTurnIds: new Set<string>(),
      searchQuery: '',
      sidebarCollapsed: false,
      threads: [thread('a'), { ...thread('child'), parentThreadId: 'a' }],
      weixinActiveThreadId: 'a',
      dingtalkActiveThreadId: 'a',
      onCreatePlainChat: vi.fn(),
      onCreateInWorkspace: vi.fn(),
      onCreateWorkflowProject: vi.fn(),
      onDeleteThread: vi.fn(),
      onForgetWorkspace: vi.fn(),
      onOpenSettings: vi.fn(),
      onPickWorkspace: vi.fn(),
      onRenameThread: vi.fn(),
      onSearchQueryChange: vi.fn(),
      onSelectThread: vi.fn(),
      onToggleSidebar: vi.fn(),
    }));

    expect(html).toContain('workspaceGroup');
    expect(html).toContain('工作流');
    expect(html).toContain('对话');
    expect(html).toContain('langchain');
    expect(html).toContain('workspaceThreadRow active');
    expect(html).toContain('weixinThreadBadge');
    expect(html).toContain('remoteThreadBadge');
    expect(html).toContain('远程助手已绑定到此对话');
    expect(html).toContain('微信');
    expect(html).toContain('钉钉');
    expect(html).not.toContain('child');
  });

  it('shows workflow projects without a separate workflow mode launcher', () => {
    const workflowThread = thread('wf');
    workflowThread.title = 'Release workflow';
    workflowThread.tags = { workflow: '{}' };
    const chatThread = { ...thread('chat'), tags: { conversationKind: 'chat' } };
    chatThread.title = 'Normal chat';
    const html = renderToStaticMarkup(React.createElement(WorkspaceThreadList, {
      activeThreadId: 'wf',
      busy: false,
      currentWorkspaceRoot: 'E:/langchain',
      locale: 'zh',
      rememberedRoots: [],
      runningTurnIds: new Set<string>(),
      searchQuery: '',
      sidebarCollapsed: false,
      threads: [workflowThread, chatThread],
      onCreatePlainChat: vi.fn(),
      onCreateInWorkspace: vi.fn(),
      onCreateWorkflowProject: vi.fn(),
      onDeleteThread: vi.fn(),
      onForgetWorkspace: vi.fn(),
      onOpenSettings: vi.fn(),
      onPickWorkspace: vi.fn(),
      onRenameThread: vi.fn(),
      onSearchQueryChange: vi.fn(),
      onSelectThread: vi.fn(),
      onToggleSidebar: vi.fn(),
    }));

    expect(html).toContain('工作流项目');
    expect(html).toContain('Release workflow');
    expect(html).not.toContain('workflowLauncher');
    expect(html).toContain('对话</span>');
    expect(html).toContain('项目</span>');
    expect(html).toContain('Normal chat');
  });

  it('puts a create action on the workflow project module header', () => {
    const onCreateWorkflowProject = vi.fn();
    const html = renderToStaticMarkup(React.createElement(WorkspaceThreadList, {
      activeThreadId: '',
      busy: false,
      currentWorkspaceRoot: 'E:/langchain',
      locale: 'zh',
      rememberedRoots: [],
      runningTurnIds: new Set<string>(),
      searchQuery: '',
      sidebarCollapsed: false,
      threads: [],
      onCreatePlainChat: vi.fn(),
      onCreateInWorkspace: vi.fn(),
      onCreateWorkflowProject,
      onDeleteThread: vi.fn(),
      onForgetWorkspace: vi.fn(),
      onOpenSettings: vi.fn(),
      onPickWorkspace: vi.fn(),
      onRenameThread: vi.fn(),
      onSearchQueryChange: vi.fn(),
      onSelectThread: vi.fn(),
      onToggleSidebar: vi.fn(),
    }));

    expect(html).toContain('新建工作流');
    expect(html).toContain('工作流项目');
    expect(html).toContain('暂无工作流项目');
  });

  it('shows titled workflow project shells before a workflow definition is saved', () => {
    const workflowThread = thread('wf-shell');
    workflowThread.title = '未命名工作流项目';
    workflowThread.tags = { workflowProject: 'true' };
    const html = renderToStaticMarkup(React.createElement(WorkspaceThreadList, {
      activeThreadId: 'wf-shell',
      busy: false,
      currentWorkspaceRoot: 'E:/langchain',
      locale: 'zh',
      rememberedRoots: [],
      runningTurnIds: new Set<string>(),
      searchQuery: '',
      sidebarCollapsed: false,
      threads: [workflowThread],
      onCreatePlainChat: vi.fn(),
      onCreateInWorkspace: vi.fn(),
      onCreateWorkflowProject: vi.fn(),
      onDeleteThread: vi.fn(),
      onForgetWorkspace: vi.fn(),
      onOpenSettings: vi.fn(),
      onPickWorkspace: vi.fn(),
      onRenameThread: vi.fn(),
      onSearchQueryChange: vi.fn(),
      onSelectThread: vi.fn(),
      onToggleSidebar: vi.fn(),
    }));

    expect(html).toContain('工作流项目');
    expect(html).toContain('未命名工作流项目');
    expect(html).not.toContain('暂无工作流项目');
  });

  it('keeps normal workspace chats out of the workflow project list', () => {
    const workspaceChat = thread('workspace-chat');
    workspaceChat.title = 'Normal workspace chat';
    const html = renderToStaticMarkup(React.createElement(WorkspaceThreadList, {
      activeThreadId: '',
      busy: false,
      currentWorkspaceRoot: 'E:/langchain',
      locale: 'zh',
      rememberedRoots: ['D:/empty-workspace'],
      runningTurnIds: new Set<string>(),
      searchQuery: '',
      sidebarCollapsed: false,
      threads: [workspaceChat],
      onCreatePlainChat: vi.fn(),
      onCreateInWorkspace: vi.fn(),
      onCreateWorkflowProject: vi.fn(),
      onDeleteThread: vi.fn(),
      onForgetWorkspace: vi.fn(),
      onOpenSettings: vi.fn(),
      onPickWorkspace: vi.fn(),
      onRenameThread: vi.fn(),
      onSearchQueryChange: vi.fn(),
      onSelectThread: vi.fn(),
      onToggleSidebar: vi.fn(),
    }));

    const workflowRows = html.match(/workflowProjectRows[\s\S]*?<\/article>/)?.[0] ?? '';
    expect(html).toContain('暂无工作流项目');
    expect(html).toContain('Normal workspace chat');
    expect(workflowRows).not.toContain('Normal workspace chat');
    expect(workflowRows).not.toContain('D:/empty-workspace');
  });
});
