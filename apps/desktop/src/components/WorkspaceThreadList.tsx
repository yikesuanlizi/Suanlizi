import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Locale } from '../config/config.js';
import { formatTimestamp, t } from '../shared/i18n.js';
import type { ThreadMeta } from '../shared/types.js';
import {
  buildPlainChatThreads,
  buildWorkspaceThreadGroups,
  type ThreadActivityState,
  type WorkspaceThreadGroup,
} from '../features/workspaces/workspaces.js';
import { isWorkflowProjectThread } from '../features/workflow/workflow.js';
import { Icon, SidebarIcon, SidebarIconSprite, type SidebarIconName } from './Icon.js';

type RemoteThreadBinding = {
  activeThreadId: string;
  className: string;
  label: Record<Locale, string>;
  name: Record<Locale, string>;
};

export function WorkspaceThreadList({
  activeThreadId,
  busy,
  currentWorkspaceRoot,
  locale,
  rememberedRoots,
  runningTurnIds,
  searchQuery,
  sidebarCollapsed,
  threads,
  weixinActiveThreadId,
  dingtalkActiveThreadId,
  onCreatePlainChat,
  onCreateInWorkspace,
  onCreateWorkflowProject,
  onDeleteThread,
  onForgetWorkspace,
  onOpenSettings,
  onPickWorkspace,
  onRenameThread,
  onSearchQueryChange,
  onSelectThread,
  onToggleSidebar,
}: {
  activeThreadId: string;
  busy: boolean;
  currentWorkspaceRoot: string;
  locale: Locale;
  rememberedRoots: string[];
  runningTurnIds: Set<string>;
  searchQuery: string;
  sidebarCollapsed: boolean;
  threads: ThreadMeta[];
  weixinActiveThreadId?: string;
  dingtalkActiveThreadId?: string;
  onCreatePlainChat(): void;
  onCreateInWorkspace(workspaceRoot: string): void;
  onCreateWorkflowProject(): void;
  onDeleteThread(threadId: string): void;
  onForgetWorkspace(workspaceRoot: string): void;
  onOpenSettings(): void;
  onPickWorkspace(): void;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onSearchQueryChange(query: string): void;
  onSelectThread(threadId: string): void;
  onToggleSidebar(): void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [plainCollapsed, setPlainCollapsed] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [workflowProjectsCollapsed, setWorkflowProjectsCollapsed] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<ThreadMeta | null>(null);
  const threadListScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollTopRef = useRef<number | null>(null);
  const workflowThreads = useMemo(() => threads.filter((thread) => isWorkflowThread(thread) && thread.parentThreadId === undefined), [threads]);
  const listedThreads = useMemo(() => threads.filter((thread) => !isWorkflowThread(thread)), [threads]);
  const plainChats = useMemo(() => buildPlainChatThreads({ searchQuery, threads: listedThreads }), [listedThreads, searchQuery]);
  const groups = useMemo(() => buildWorkspaceThreadGroups({
    currentWorkspaceRoot,
    locale,
    rememberedRoots,
    searchQuery,
    threads: listedThreads,
  }), [currentWorkspaceRoot, listedThreads, locale, rememberedRoots, searchQuery]);
  const remoteBindings = useMemo(() => buildRemoteThreadBindings({ dingtalkActiveThreadId, weixinActiveThreadId }), [dingtalkActiveThreadId, weixinActiveThreadId]);
  const searchVisible = searchOpen || searchQuery.trim().length > 0;
  useEffect(() => {
    const pendingTop = pendingScrollTopRef.current;
    if (pendingTop === null) return;
    pendingScrollTopRef.current = null;
    window.requestAnimationFrame(() => {
      if (threadListScrollRef.current) threadListScrollRef.current.scrollTop = pendingTop;
    });
  }, [activeThreadId]);

  function selectThreadPreservingScroll(nextThreadId: string): void {
    pendingScrollTopRef.current = threadListScrollRef.current?.scrollTop ?? 0;
    onSelectThread(nextThreadId);
  }
  const searchResults = useMemo(() => [
    ...workflowThreads.map((thread) => ({ context: locale === 'zh' ? '工作流项目' : 'Workflow projects', thread })),
    ...plainChats.map((thread) => ({ context: locale === 'zh' ? '对话' : 'Chats', thread })),
    ...groups.flatMap((group) => group.threads.map((thread) => ({ context: group.label, thread }))),
  ].sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt)), [groups, locale, plainChats, workflowThreads]);

  if (sidebarCollapsed) {
    return (
      <section className="threadListPanel collapsed" aria-label={t(locale, 'conversations')}>
        <button className="sidebarBrandButton" type="button" title={t(locale, 'title')} onClick={onToggleSidebar}>
          <span aria-hidden="true">N</span>
        </button>
        <button className="miniIconButton" type="button" title={t(locale, 'settings')} onClick={onOpenSettings}>
          <Icon name="gear" />
        </button>
      </section>
    );
  }

  return (
    <section className="threadListPanel" aria-label={t(locale, 'conversations')}>
      <SidebarIconSprite />
      <div className="workspaceThreadsHeader">
        <button className={searchVisible ? 'searchLauncher active' : 'searchLauncher'} type="button" title={locale === 'zh' ? '搜索对话' : 'Search chats'} onClick={() => setSearchOpen(true)}>
          <SidebarIcon className="icon" name="search" />
          <span>{locale === 'zh' ? '搜索' : 'Search'}</span>
        </button>
        <button
          className="miniIconButton"
          type="button"
          title={t(locale, 'collapseSidebar')}
          aria-label={t(locale, 'collapseSidebar')}
          onClick={onToggleSidebar}
        >
          <Icon className="icon" name="chevron" />
        </button>
      </div>

      <div className="threadListScroll">
        <div className="workspaceGroupList" ref={threadListScrollRef}>
          <WorkflowProjectList
            activeThreadId={activeThreadId}
            busy={busy}
            collapsed={workflowProjectsCollapsed}
            locale={locale}
            remoteBindings={remoteBindings}
            runningTurnIds={runningTurnIds}
            threads={workflowThreads}
            onCreateWorkflowProject={onCreateWorkflowProject}
            onDeleteThread={onDeleteThread}
            onRenameThread={(thread) => setRenaming(thread)}
            onSelectThread={selectThreadPreservingScroll}
            onToggleCollapsed={() => setWorkflowProjectsCollapsed((value) => !value)}
          />
        <>
        <ThreadModuleView
          activeThreadId={activeThreadId}
          busy={busy}
          collapsed={plainCollapsed}
          locale={locale}
          remoteBindings={remoteBindings}
          runningTurnIds={runningTurnIds}
          threads={plainChats}
          title={locale === 'zh' ? '对话' : 'Chats'}
          onCreate={onCreatePlainChat}
          onDeleteThread={onDeleteThread}
          onRenameThread={(thread) => setRenaming(thread)}
          onSelectThread={selectThreadPreservingScroll}
          onToggleCollapsed={() => setPlainCollapsed((value) => !value)}
        />

        <div className="threadModuleTitle">
          <button className="threadModuleToggle" type="button" onClick={() => setProjectsCollapsed((value) => !value)}>
            {projectsCollapsed ? <Icon className="icon" name="chevronRight" /> : <SidebarIcon className="icon" name="chevron" />}
            <SidebarIcon className="icon" name="folderOpen" />
            <span>{locale === 'zh' ? '项目' : 'Projects'}</span>
          </button>
          <button className="threadModuleAction" type="button" title={locale === 'zh' ? '选择工作区' : 'Select workspace'} onClick={onPickWorkspace}>
            <SidebarIcon className="icon" name="plus" />
          </button>
        </div>
        {!projectsCollapsed && groups.length === 0 ? (
          <div className="workspaceThreadEmpty">
            {locale === 'zh' ? '暂无工作区对话' : 'No workspace chats'}
          </div>
        ) : null}
        {!projectsCollapsed ? groups.map((group) => (
          <WorkspaceGroupView
            activeThreadId={activeThreadId}
            busy={busy}
            collapsed={collapsed[group.workspaceRoot] === true}
            expanded={expanded[group.workspaceRoot] === true}
            group={group}
            key={group.workspaceRoot || '__default'}
            locale={locale}
            remoteBindings={remoteBindings}
            runningTurnIds={runningTurnIds}
            onCreateInWorkspace={onCreateInWorkspace}
            onDeleteThread={onDeleteThread}
            onForgetWorkspace={onForgetWorkspace}
            pinned={group.pinned === true}
            onRenameThread={(thread) => setRenaming(thread)}
            onSelectThread={selectThreadPreservingScroll}
            onToggleCollapsed={() => setCollapsed((current) => ({ ...current, [group.workspaceRoot]: !current[group.workspaceRoot] }))}
            onToggleExpanded={() => setExpanded((current) => ({ ...current, [group.workspaceRoot]: !current[group.workspaceRoot] }))}
          />
        )) : null}
        </>
        </div>
      </div>
      {renaming ? (
        <RenameThreadDialog
          locale={locale}
          thread={renaming}
          onClose={() => setRenaming(null)}
          onSave={async (title) => {
            await onRenameThread(renaming.threadId, title);
            setRenaming(null);
          }}
        />
      ) : null}
      {searchOpen ? (
        <SearchDialog
          locale={locale}
          query={searchQuery}
          results={searchResults}
          onClose={() => setSearchOpen(false)}
          onQueryChange={onSearchQueryChange}
          onSelect={(id) => {
            setSearchOpen(false);
            selectThreadPreservingScroll(id);
          }}
        />
      ) : null}
      <footer className="threadListFooter">
        <button className="settingsButton" type="button" onClick={onOpenSettings}>
          <SidebarIcon className="icon" name="gear" />
          <span>{t(locale, 'settings')}</span>
        </button>
      </footer>
    </section>
  );
}

function isWorkflowThread(thread: ThreadMeta): boolean {
  return isWorkflowProjectThread(thread);
}

function SearchDialog({
  locale,
  query,
  results,
  onClose,
  onQueryChange,
  onSelect,
}: {
  locale: Locale;
  query: string;
  results: Array<{ context: string; thread: ThreadMeta }>;
  onClose(): void;
  onQueryChange(query: string): void;
  onSelect(threadId: string): void;
}) {
  const dialog = (
    <div className="dialogLayer searchDialogLayer" role="presentation" onMouseDown={onClose}>
      <section className="appDialog searchDialog" role="dialog" aria-modal="true" aria-label={locale === 'zh' ? '搜索对话' : 'Search chats'} onMouseDown={(event) => event.stopPropagation()}>
        <label className="searchDialogInput">
          <SidebarIcon className="icon" name="search" />
          <input
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={locale === 'zh' ? '搜索对话' : 'Search chats'}
          />
          {query.trim() ? (
            <button type="button" title={t(locale, 'cancel')} onClick={() => onQueryChange('')}>
              <Icon name="x" />
            </button>
          ) : null}
        </label>
        <div className="searchDialogResults">
          {results.length === 0 ? (
            <p>{locale === 'zh' ? '没有匹配的对话' : 'No matching chats'}</p>
          ) : results.slice(0, 12).map(({ context, thread }, index) => (
            <button key={thread.threadId} type="button" onClick={() => onSelect(thread.threadId)}>
              <span>{thread.title || t(locale, 'untitled')}</span>
              <small>{context}</small>
              <kbd>Ctrl+{index + 1}</kbd>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
  // 侧栏有 transform 动画，会把 fixed 子元素限制在侧栏的坐标系内。
  // 搜索层必须挂到 document.body，才能始终覆盖整个桌面工作区。
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

function ThreadModuleView({
  activeThreadId,
  busy,
  collapsed,
  locale,
  remoteBindings,
  runningTurnIds,
  threads,
  title,
  onCreate,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
  onToggleCollapsed,
}: {
  activeThreadId: string;
  busy: boolean;
  collapsed: boolean;
  locale: Locale;
  remoteBindings: RemoteThreadBinding[];
  runningTurnIds: Set<string>;
  threads: ThreadMeta[];
  title: string;
  onCreate(): void;
  onDeleteThread(threadId: string): void;
  onRenameThread(thread: ThreadMeta): void;
  onSelectThread(threadId: string): void;
  onToggleCollapsed(): void;
}) {
  const visibleThreads = threads.slice(0, 8);
  return (
    <article className="threadModule">
      <div className="threadModuleHeader">
        <button className="threadModuleToggle" type="button" onClick={onToggleCollapsed}>
          {collapsed ? <Icon className="icon" name="chevronRight" /> : <SidebarIcon className="icon" name="chevron" />}
          <SidebarIcon className="icon" name="messages" />
          <span>{title}</span>
        </button>
        <button type="button" title={locale === 'zh' ? '新建对话' : 'New chat'} onClick={onCreate}>
          <SidebarIcon className="icon" name="plus" />
        </button>
      </div>
      {!collapsed ? <div className="workspaceThreadRows plain">
        {visibleThreads.length === 0 ? (
          <div className="workspaceThreadEmptyRow">
            <span>{locale === 'zh' ? '暂无对话' : 'No chats'}</span>
            <button className="workspaceThreadCreateButton" type="button" title={locale === 'zh' ? '新建对话' : 'New chat'} aria-label={locale === 'zh' ? '新建对话' : 'New chat'} onClick={onCreate}>
              <Icon name="plus" />
            </button>
          </div>
        ) : visibleThreads.map((thread) => {
          const activity = threadActivityFor(thread, activeThreadId, busy, runningTurnIds);
          return (
            <ThreadRow
              activity={activity}
              active={thread.threadId === activeThreadId}
              iconName="messages"
              remoteBindings={remoteBindingsForThread(remoteBindings, thread.threadId)}
              key={thread.threadId}
              locale={locale}
              thread={thread}
              onDeleteThread={onDeleteThread}
              onRenameThread={onRenameThread}
              onSelectThread={onSelectThread}
            />
          );
        })}
      </div> : null}
    </article>
  );
}

function WorkflowProjectList({
  activeThreadId,
  busy,
  collapsed,
  locale,
  remoteBindings,
  runningTurnIds,
  threads,
  onDeleteThread,
  onCreateWorkflowProject,
  onRenameThread,
  onSelectThread,
  onToggleCollapsed,
}: {
  activeThreadId: string;
  busy: boolean;
  collapsed: boolean;
  locale: Locale;
  remoteBindings: RemoteThreadBinding[];
  runningTurnIds: Set<string>;
  threads: ThreadMeta[];
  onCreateWorkflowProject(): void;
  onDeleteThread(threadId: string): void;
  onRenameThread(thread: ThreadMeta): void;
  onSelectThread(threadId: string): void;
  onToggleCollapsed(): void;
}) {
  const sorted = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <article className="threadModule">
      <div className="threadModuleHeader">
        <button className="threadModuleToggle" type="button" onClick={onToggleCollapsed}>
          {collapsed ? <Icon className="icon" name="chevronRight" /> : <SidebarIcon className="icon" name="chevron" />}
          <SidebarIcon className="icon" name="workflow" />
          <span>{locale === 'zh' ? '工作流项目' : 'Workflow projects'}</span>
        </button>
        <button type="button" title={locale === 'zh' ? '新建工作流' : 'New workflow'} onClick={onCreateWorkflowProject}>
          <SidebarIcon className="icon" name="plus" />
        </button>
      </div>
      {!collapsed ? <div className="workspaceThreadRows plain workflowProjectRows">
        {sorted.length === 0 ? (
          <div className="workspaceThreadEmptyRow">
            <span>{locale === 'zh' ? '暂无工作流项目' : 'No workflow projects'}</span>
            <button className="workspaceThreadCreateButton" type="button" title={locale === 'zh' ? '新建工作流' : 'New workflow'} aria-label={locale === 'zh' ? '新建工作流' : 'New workflow'} onClick={onCreateWorkflowProject}>
              <Icon name="plus" />
            </button>
          </div>
        ) : sorted.map((thread) => (
          <ThreadRow
            activity={threadActivityFor(thread, activeThreadId, busy, runningTurnIds)}
            active={thread.threadId === activeThreadId}
            iconName="workflow"
            remoteBindings={remoteBindingsForThread(remoteBindings, thread.threadId)}
            key={thread.threadId}
            locale={locale}
            thread={thread}
            onDeleteThread={onDeleteThread}
            onRenameThread={onRenameThread}
            onSelectThread={onSelectThread}
          />
        ))}
      </div> : null}
    </article>
  );
}

function WorkspaceGroupView({
  activeThreadId,
  busy,
  collapsed,
  expanded,
  group,
  locale,
  remoteBindings,
  runningTurnIds,
  onCreateInWorkspace,
  onDeleteThread,
  onForgetWorkspace,
  pinned,
  onRenameThread,
  onSelectThread,
  onToggleCollapsed,
  onToggleExpanded,
}: {
  activeThreadId: string;
  busy: boolean;
  collapsed: boolean;
  expanded: boolean;
  group: WorkspaceThreadGroup;
  locale: Locale;
  remoteBindings: RemoteThreadBinding[];
  runningTurnIds: Set<string>;
  onCreateInWorkspace(workspaceRoot: string): void;
  onDeleteThread(threadId: string): void;
  onForgetWorkspace(workspaceRoot: string): void;
  pinned?: boolean;
  onRenameThread(thread: ThreadMeta): void;
  onSelectThread(threadId: string): void;
  onToggleCollapsed(): void;
  onToggleExpanded(): void;
}) {
  const visibleThreads = expanded ? group.threads : group.threads.slice(0, 5);
  const hasOverflow = group.threads.length > 5;
  return (
    <article className="workspaceGroup">
      <div className="workspaceGroupHeader" title={group.workspaceRoot || group.label}>
        <button className="workspaceGroupMain" type="button" onClick={onToggleCollapsed}>
          <SidebarIcon className="row-icon" name="folderCode" />
          <span>{group.label}</span>
        </button>
        <div className="workspaceGroupActions">
          <button type="button" title={locale === 'zh' ? '新建对话' : 'New chat'} onClick={() => onCreateInWorkspace(group.workspaceRoot)}>
            <SidebarIcon className="icon" name="plus" />
          </button>
          {group.workspaceRoot ? (
            <button type="button" title={locale === 'zh' ? '移除工作区' : 'Remove workspace'} onClick={() => onForgetWorkspace(group.workspaceRoot)}>
              <SidebarIcon className="icon" name="trash" />
            </button>
          ) : null}
        </div>
      </div>
      {!collapsed ? (
        <div className="workspaceThreadRows">
          {visibleThreads.length === 0 ? (
            <div className="workspaceThreadEmptyRow">
              <span>{locale === 'zh' ? '暂无对话' : 'No chats'}</span>
              <button className="workspaceThreadCreateButton" type="button" title={locale === 'zh' ? '新建对话' : 'New chat'} aria-label={locale === 'zh' ? '新建对话' : 'New chat'} onClick={() => onCreateInWorkspace(group.workspaceRoot)}>
                <Icon name="plus" />
              </button>
            </div>
          ) : visibleThreads.map((thread) => {
            const activity = threadActivityFor(thread, activeThreadId, busy, runningTurnIds);
            return (
              <ThreadRow
                activity={activity}
                active={thread.threadId === activeThreadId}
              iconName="messages"
                remoteBindings={remoteBindingsForThread(remoteBindings, thread.threadId)}
                key={thread.threadId}
                locale={locale}
                thread={thread}
                onDeleteThread={onDeleteThread}
                onRenameThread={onRenameThread}
                onSelectThread={onSelectThread}
              />
            );
          })}
          {hasOverflow ? (
            <button className="workspaceMoreButton" type="button" onClick={onToggleExpanded}>
              {expanded
                ? (locale === 'zh' ? '收起' : 'Show less')
                : (locale === 'zh' ? `显示更多 ${group.threads.length - 5}` : `Show ${group.threads.length - 5} more`)}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ThreadRow({
  activity,
  active,
  iconName,
  locale,
  remoteBindings,
  thread,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
}: {
  activity: ThreadActivityState;
  active: boolean;
  iconName: SidebarIconName;
  locale: Locale;
  remoteBindings: RemoteThreadBinding[];
  thread: ThreadMeta;
  onDeleteThread(threadId: string): void;
  onRenameThread(thread: ThreadMeta): void;
  onSelectThread(threadId: string): void;
}) {
  return (
    <div className={active ? 'workspaceThreadRow active' : 'workspaceThreadRow'}>
      <button className="workspaceThreadMain" type="button" title={thread.title} onClick={() => onSelectThread(thread.threadId)}>
        <SidebarIcon className="row-icon" name={iconName} />
        <span className="workspaceThreadTitle">{thread.title || t(locale, 'untitled')}</span>
        <small className="workspaceThreadTimestamp" title={formatTimestamp(thread.updatedAt, locale)}>
          {formatTimestamp(thread.updatedAt, locale)}
        </small>
        {remoteBindings.map((binding) => (
          <em className={binding.className} key={binding.name.en} title={`${locale === 'zh' ? '远程助手已绑定到此对话' : 'Remote assistant bound to this chat'}: ${binding.name[locale]}`}>
            {binding.label[locale]}
          </em>
        ))}
        <ThreadActivityDot state={activity} />
      </button>
      <div className="workspaceThreadActions">
        <button type="button" title={t(locale, 'edit')} onClick={() => onRenameThread(thread)}>
          <SidebarIcon className="icon" name="pen" />
        </button>
        <button type="button" title={t(locale, 'deleteConversation')} onClick={() => onDeleteThread(thread.threadId)}>
          <SidebarIcon className="icon" name="trash" />
        </button>
      </div>
    </div>
  );
}

function buildRemoteThreadBindings({
  dingtalkActiveThreadId,
  weixinActiveThreadId,
}: {
  dingtalkActiveThreadId?: string;
  weixinActiveThreadId?: string;
}): RemoteThreadBinding[] {
  return [
    {
      activeThreadId: weixinActiveThreadId ?? '',
      className: 'weixinThreadBadge remoteThreadBadge',
      label: { zh: '微信', en: 'WX' },
      name: { zh: '微信', en: 'WeChat' },
    },
    {
      activeThreadId: dingtalkActiveThreadId ?? '',
      className: 'dingtalkThreadBadge remoteThreadBadge',
      label: { zh: '钉钉', en: 'DT' },
      name: { zh: '钉钉', en: 'DingTalk' },
    },
  ].filter((binding) => binding.activeThreadId.trim().length > 0);
}

function remoteBindingsForThread(bindings: RemoteThreadBinding[], threadId: string): RemoteThreadBinding[] {
  return bindings.filter((binding) => binding.activeThreadId === threadId);
}

export function ThreadActivityDot({ state }: { state: ThreadActivityState }) {
  if (state === 'idle') return null;
  return <span className={state === 'running' ? 'threadActivityDot running' : 'threadActivityDot unread'} aria-hidden="true" />;
}

function threadActivityFor(thread: ThreadMeta, activeThreadId: string, busy: boolean, runningTurnIds: Set<string>): ThreadActivityState {
  if (thread.status === 'running') return 'running';
  if (thread.threadId === activeThreadId && (busy || runningTurnIds.size > 0)) return 'running';
  return 'idle';
}

function RenameThreadDialog({
  locale,
  thread,
  onClose,
  onSave,
}: {
  locale: Locale;
  thread: ThreadMeta;
  onClose(): void;
  onSave(title: string): Promise<void>;
}) {
  const [value, setValue] = useState(thread.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nextTitle = value.trim();
  const disabled = saving || !nextTitle || nextTitle === thread.title;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setSaving(true);
    setError('');
    try {
      await onSave(nextTitle);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <div className="dialogLayer" role="presentation" onMouseDown={onClose}>
      <form className="appDialog renameThreadDialog" role="dialog" aria-modal="true" aria-labelledby="rename-thread-title" onSubmit={(event) => void submit(event)} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialogHeader">
          <h2 id="rename-thread-title">{locale === 'zh' ? '重命名对话' : 'Rename chat'}</h2>
          <button className="iconButton" type="button" title={t(locale, 'cancel')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
        {error ? <p className="dialogMessage">{error}</p> : null}
        <div className="dialogActions">
          <button className="textButton" type="button" onClick={onClose} disabled={saving}>{t(locale, 'cancel')}</button>
          <button className="solidButton" type="submit" disabled={disabled}>{saving ? t(locale, 'running') : t(locale, 'save')}</button>
        </div>
      </form>
    </div>
  );
}
