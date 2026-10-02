// 命令终端预览面板：右侧栏里实时观看 agent 执行的命令输出（只读，不可人工介入）。
// 数据来源：气泡命令块的"终端"按钮选中某个 command_execution 条目，
// 其 liveOutput/aggregatedOutput 以终端样式滚动展示。
// — Chinese: read-only right-pane terminal that mirrors an agent command's live output.

import { useEffect, useRef } from 'react';
import type { Locale } from '../../config/config.js';
import type { ThreadItem } from '../../shared/types.js';

export function CommandTerminalPane({
  locale,
  items,
  selectedItemId,
  onSelectItem,
  onClose,
}: {
  locale: Locale;
  /** 当前线程的全部 runtime 条目（含命令块） */
  items: ThreadItem[];
  /** 选中的命令条目 id */
  selectedItemId: string | null;
  onSelectItem(itemId: string): void;
  onClose(): void;
}) {
  const zh = locale === 'zh';
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  // 命令类条目（含仍在运行的），最新的在前
  const commandItems = items
    .filter((item) => item.type === 'command_execution')
    .slice()
    .reverse();

  const selectedItem = commandItems.find((item) => item.id === selectedItemId) ?? commandItems[0] ?? null;
  const output = selectedItem
    ? String((selectedItem as ThreadItem & { liveOutput?: string }).liveOutput ?? selectedItem.aggregatedOutput ?? '')
    : '';
  const running = selectedItem?.status === 'in_progress';

  // 终端式跟随：新输出自动滚到底，用户上滑即暂停，滚回底部恢复。
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !followRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [output, selectedItemId]);

  const handleScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    followRef.current = distance <= 24;
  };

  return (
    <div className="commandTerminalPane" role="region" aria-label={zh ? '命令终端预览' : 'Command terminal preview'}>
      <header className="commandTerminalHeader">
        <strong>{zh ? '命令终端' : 'Command Terminal'}</strong>
        {running ? <span className="commandTerminalRunning">{zh ? '运行中' : 'Running'}</span> : null}
        <button
          type="button"
          className="commandTerminalClose"
          onClick={onClose}
          aria-label={zh ? '关闭命令终端' : 'Close command terminal'}
        >
          ×
        </button>
      </header>
      {commandItems.length > 1 ? (
        <nav className="commandTerminalTabs" aria-label={zh ? '命令列表' : 'Command list'}>
          {commandItems.slice(0, 8).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`commandTerminalTab${selectedItem?.id === item.id ? ' active' : ''}${item.status === 'failed' ? ' failed' : ''}`}
              onClick={() => { followRef.current = true; onSelectItem(item.id); }}
              title={item.command}
            >
              <span className={`commandTerminalTabDot status-${item.status ?? 'unknown'}`} aria-hidden="true" />
              <span className="commandTerminalTabLabel">{item.command}</span>
            </button>
          ))}
        </nav>
      ) : null}
      <div className="commandTerminalBody" ref={bodyRef} onScroll={handleScroll}>
        {selectedItem ? (
          <>
            <div className="commandTerminalCmdLine">
              <span className="commandTerminalPrompt" aria-hidden="true">$</span>
              <code>{selectedItem.command}</code>
            </div>
            <pre className="commandTerminalOutput">{output}</pre>
            {running ? <div className="commandTerminalCursor" aria-hidden="true" /> : null}
            {selectedItem.exitCode != null && selectedItem.exitCode !== 0 ? (
              <div className="commandTerminalExit">{zh ? `进程已退出，退出码 ${selectedItem.exitCode}` : `Process exited with code ${selectedItem.exitCode}`}</div>
            ) : null}
          </>
        ) : (
          <div className="commandTerminalEmpty">
            <p>{zh ? '暂无命令输出' : 'No command output yet'}</p>
            <span>{zh ? '点击对话里命令块的"终端"按钮，即可在这里实时观看。' : 'Click the "Terminal" button on a command block in the chat to watch it live here.'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
