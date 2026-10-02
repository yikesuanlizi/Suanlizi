// 右上角只承担运行观察：创建 Goal / Dynamic Workflow 的唯一主入口是输入栏模式和斜杠命令。
import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { Locale } from '../../config/config.js';
import { Icon } from '../Icon.js';
import { TaskCenter } from './TaskCenter.js';

export interface TaskCenterDrawerProps {
  open: boolean;
  locale: Locale;
  onClose(): void;
  /** 点击任务详情里的跳转：切换到任务所属 Thread（由 main.tsx 传入线程装载函数包装）。 */
  onOpenThread(threadId: string): void;
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  width: 'min(420px, calc(100vw - 16px))',
  height: '100%',
  margin: 0,
  borderRadius: 0,
  border: 'none',
  borderLeft: '1px solid var(--nx-border, #e2e8f0)',
  background: 'var(--nx-panel, #ffffff)',
  overflow: 'hidden',
  minHeight: 0,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 44,
  padding: '0 12px',
  borderBottom: '1px solid var(--nx-border, #e2e8f0)',
  flex: '0 0 auto',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--nx-text, #0f172a)',
};

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  border: '1px solid transparent',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--nx-muted, #64748b)',
  cursor: 'pointer',
};

const bodyStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  padding: '10px 12px',
  display: 'flex',
};

export function TaskCenterDrawer({ open, locale, onClose, onOpenThread }: TaskCenterDrawerProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const zh = locale === 'zh';
  return (
    <div className="runMonitorWorkbench taskObserverWorkbench" role="complementary" aria-label={zh ? '运行观察' : 'Run observer'}>
      <div className="taskObserverPanel" style={panelStyle}>
        <header style={headerStyle}>
          <h2 style={titleStyle}>{zh ? '运行观察' : 'Run observer'}</h2>
          <span style={{ flex: 1 }} />
          <button type="button" style={iconButtonStyle} onClick={onClose} aria-label={zh ? '关闭' : 'Close'} title={zh ? '关闭' : 'Close'}>
            <Icon name="x" />
          </button>
        </header>
        <div style={bodyStyle}>
          <TaskCenter locale={locale} onOpenThread={onOpenThread} />
        </div>
      </div>
    </div>
  );
}
