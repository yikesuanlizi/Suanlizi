import { useEffect, useRef, useState, type ComponentProps, type WheelEvent } from 'react';
import type { Locale } from '../../config/config.js';
import { Icon } from '../Icon.js';

export type PrimaryWorkbenchTab = 'activity' | 'agents' | 'ops';
export type UtilityWorkbenchTabKind = 'files' | 'browser' | 'terminal';
export type TerminalUtilityWorkbenchTab = `terminal:${string}`;
export type UtilityWorkbenchTab = 'files' | 'browser' | TerminalUtilityWorkbenchTab;
export type WorkbenchTab = PrimaryWorkbenchTab | UtilityWorkbenchTab;

let terminalTabSequence = 0;

export function createTerminalUtilityWorkbenchTab(): TerminalUtilityWorkbenchTab {
  terminalTabSequence += 1;
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${terminalTabSequence.toString(36)}`;
  return `terminal:${id}`;
}

export function isTerminalUtilityWorkbenchTab(tab: string): tab is TerminalUtilityWorkbenchTab {
  return tab.startsWith('terminal:');
}

export function isUtilityWorkbenchTab(tab: WorkbenchTab): tab is UtilityWorkbenchTab {
  return tab === 'files' || tab === 'browser' || isTerminalUtilityWorkbenchTab(tab);
}

export function WorkbenchTabs({
  activeTab,
  onTabChange,
  openUtilityTabs,
  onOpenUtilityTab,
  onCloseUtilityTab,
  runningAgentCount,
  utilitiesEnabled = true,
  showOps = false,
  locale,
}: {
  activeTab: WorkbenchTab;
  onTabChange(tab: WorkbenchTab): void;
  openUtilityTabs: UtilityWorkbenchTab[];
  onOpenUtilityTab(tab: UtilityWorkbenchTabKind): UtilityWorkbenchTab;
  onCloseUtilityTab(tab: UtilityWorkbenchTab): void;
  runningAgentCount: number;
  utilitiesEnabled?: boolean;
  showOps?: boolean;
  locale: Locale;
}) {
  const zh = locale === 'zh';
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [utilityMenuPosition, setUtilityMenuPosition] = useState({ left: 0, top: 0 });
  const dynamicTabsScrollerRef = useRef<HTMLDivElement | null>(null);
  const utilityButtonRef = useRef<HTMLButtonElement | null>(null);
  const utilityMenuRef = useRef<HTMLDivElement | null>(null);
  const tabs: Array<{ id: PrimaryWorkbenchTab; icon: ComponentProps<typeof Icon>['name']; label: string; badge?: number }> = [
    { id: 'activity', icon: 'pulse', label: zh ? '活动' : 'Activity' },
    { id: 'agents', icon: 'agentGroup', label: zh ? '智能体' : 'Agents', badge: runningAgentCount > 0 ? runningAgentCount : undefined },
    ...(showOps ? [{ id: 'ops' as const, icon: 'monitor' as const, label: zh ? '运维' : 'Ops' }] : []),
  ];
  const utilityTabs: Array<{ id: Exclude<UtilityWorkbenchTabKind, 'terminal'>; icon: ComponentProps<typeof Icon>['name']; label: string }> = [
    { id: 'browser', icon: 'browser', label: zh ? '浏览器' : 'Browser' },
    { id: 'files', icon: 'folderOpen', label: zh ? '文件' : 'Files' },
  ];
  const utilityMenuTabs: Array<{ id: UtilityWorkbenchTabKind; icon: ComponentProps<typeof Icon>['name']; label: string }> = [
    ...utilityTabs,
    { id: 'terminal', icon: 'terminal', label: zh ? '终端' : 'Terminal' },
  ];

  const selectUtilityTab = (tab: UtilityWorkbenchTabKind): void => {
    if (!utilitiesEnabled) return;
    setUtilityOpen(false);
    onOpenUtilityTab(tab);
  };

  const updateUtilityMenuPosition = (): void => {
    const button = utilityButtonRef.current;
    const pane = button?.closest<HTMLElement>('.workbenchPane');
    if (!button || !pane) return;
    const buttonRect = button.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    setUtilityMenuPosition({
      left: Math.max(8, buttonRect.right - paneRect.left - 118),
      top: buttonRect.bottom - paneRect.top + 6,
    });
  };

  useEffect(() => {
    if (!utilitiesEnabled) setUtilityOpen(false);
  }, [utilitiesEnabled]);

  useEffect(() => {
    if (!utilityOpen) return undefined;
    updateUtilityMenuPosition();
    window.addEventListener('resize', updateUtilityMenuPosition);
    return () => window.removeEventListener('resize', updateUtilityMenuPosition);
  }, [utilityOpen]);

  useEffect(() => {
    if (!utilityOpen) return undefined;
    const closeOnOutsidePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (utilityMenuRef.current?.contains(target) || utilityButtonRef.current?.contains(target)) return;
      setUtilityOpen(false);
    };
    window.addEventListener('pointerdown', closeOnOutsidePointerDown);
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointerDown);
  }, [utilityOpen]);

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const tabList = dynamicTabsScrollerRef.current;
    if (!tabList || tabList.scrollWidth <= tabList.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    tabList.scrollLeft += delta;
    event.preventDefault();
  };

  const handleTabsScroll = (): void => {
    if (utilityOpen) updateUtilityMenuPosition();
  };

  const toggleUtilityMenu = (): void => {
    if (!utilitiesEnabled) return;
    const nextOpen = !utilityOpen;
    if (nextOpen) updateUtilityMenuPosition();
    setUtilityOpen(nextOpen);
  };

  return (
    <>
    <div className="workbenchTabs" role="tablist" aria-label={zh ? '工作台' : 'Workbench'}>
      <div className="workbenchPrimaryTabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className={activeTab === tab.id ? 'active' : ''}
            aria-selected={activeTab === tab.id}
            aria-label={tab.label}
            title={tab.label}
            onClick={() => onTabChange(tab.id)}
          >
            <Icon name={tab.icon} />
            <span>{tab.label}</span>
            {tab.badge != null ? <span className="workbenchTabBadge">{tab.badge}</span> : null}
          </button>
        ))}
      </div>
      <div ref={dynamicTabsScrollerRef} className="workbenchTabsScrollable" onScroll={handleTabsScroll} onWheel={handleWheel}>
        <div className="workbenchUtilityTabs">
          {openUtilityTabs.map((tabId) => {
            const tab = isTerminalUtilityWorkbenchTab(tabId)
              ? (() => {
                  const terminalIndex = openUtilityTabs
                    .filter(isTerminalUtilityWorkbenchTab)
                    .indexOf(tabId);
                  return {
                    id: tabId,
                    icon: 'terminal' as ComponentProps<typeof Icon>['name'],
                    label: zh ? `终端 ${terminalIndex + 1}` : `Terminal ${terminalIndex + 1}`,
                  };
                })()
              : utilityTabs.find((item) => item.id === tabId);
            if (!tab) return null;
            return (
              <div className={`workbenchDynamicTab${activeTab === tab.id ? ' active' : ''}`} key={tab.id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-label={tab.label}
                  title={tab.label}
                  onClick={() => onTabChange(tab.id)}
                >
                  <Icon name={tab.icon} />
                  <span>{tab.label}</span>
                </button>
                <button
                  type="button"
                  className="workbenchDynamicTabClose"
                  aria-label={zh ? `关闭${tab.label}` : `Close ${tab.label}`}
                  title={zh ? '关闭' : 'Close'}
                  onClick={() => onCloseUtilityTab(tab.id)}
                >
                  <Icon name="x" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="workbenchUtilityActions">
        <button
          ref={utilityButtonRef}
          type="button"
          className={utilityOpen || isTerminalUtilityWorkbenchTab(activeTab) || utilityTabs.some((tab) => tab.id === activeTab) ? 'active' : ''}
          aria-label={zh ? '打开浏览器、文件或终端' : 'Open browser, files, or terminal'}
          aria-expanded={utilityOpen}
          aria-disabled={!utilitiesEnabled}
          disabled={!utilitiesEnabled}
          title={zh ? '浏览器、文件与终端' : 'Browser, files, and terminal'}
          onClick={toggleUtilityMenu}
        >
          <Icon name="plus" />
        </button>
      </div>
    </div>
    {utilitiesEnabled && utilityOpen ? (
      <div ref={utilityMenuRef} className="workbenchUtilityMenu" role="menu" style={utilityMenuPosition}>
        {utilityMenuTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="menuitem"
            onClick={() => selectUtilityTab(tab.id)}
          >
            <Icon name={tab.icon} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    ) : null}
    </>
  );
}
