import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Locale } from '../../config/config.js';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';

type TerminalSessionResponse = {
  sessionId: string;
  root: string;
  threadId: string;
};

type TerminalOutputResponse = {
  output?: string;
  cursor?: number;
  exited?: boolean;
  exitCode?: number | null;
};

const INPUT_BATCH_MS = 8;
const OUTPUT_WAIT_MS = 750;
const OUTPUT_RETRY_MS = 150;

export function TerminalPanel({ locale, workspaceRoot, threadId, active = true }: { locale: Locale; workspaceRoot: string; threadId: string; active?: boolean }) {
  const root = workspaceRoot.trim();
  const threadScope = threadId.trim();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active || !terminalRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!terminalRef.current) return;
      try { fitAddonRef.current?.fit(); } catch { /* panel may still be hidden */ }
      terminalRef.current.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const panel = container.closest<HTMLElement>('.terminalPanel');
    const resolveDark = (): boolean => {
      const explicitTheme = document.documentElement.dataset.suanliziTheme;
      if (explicitTheme === 'dark') return true;
      if (explicitTheme === 'light') return false;
      const shell = document.querySelector('.appShell');
      if (shell?.classList.contains('theme-dark')) return true;
      if (shell?.classList.contains('theme-light')) return false;
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    };
    const readPanelColor = (name: string, fallback: string): string => {
      const value = panel ? getComputedStyle(panel).getPropertyValue(name).trim() : '';
      return value || fallback;
    };
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 1,
      cursorInactiveStyle: 'bar',
      fontFamily: 'Cascadia Mono, Consolas, "Microsoft YaHei UI", monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 10_000,
      minimumContrastRatio: 7,
      // Pick the palette before xterm paints its first frame to avoid a light
      // flash when a dark workspace opens a terminal.
      theme: resolveDark() ? darkTerminalTheme : lightTerminalTheme,
    });
    const fitAddon = new FitAddon();
    const webglAddon = new WebglAddon();
    terminal.loadAddon(fitAddon);
    try {
      terminal.loadAddon(webglAddon);
    } catch {
      webglAddon.dispose();
    }
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.open(container);
    const applyTheme = (): void => {
      const dark = resolveDark();
      const theme = dark
        ? {
            ...darkTerminalTheme,
            background: readPanelColor('--terminal-canvas', darkTerminalTheme.background),
            foreground: readPanelColor('--terminal-text', darkTerminalTheme.foreground),
            cursor: readPanelColor('--terminal-text', darkTerminalTheme.cursor),
          }
        : {
            ...lightTerminalTheme,
            background: readPanelColor('--terminal-canvas', lightTerminalTheme.background),
            foreground: readPanelColor('--terminal-text', lightTerminalTheme.foreground),
            cursor: readPanelColor('--terminal-text', lightTerminalTheme.cursor),
          };
      terminal.options.theme = theme;
    };
    applyTheme();
    if (activeRef.current) terminal.focus();

    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-nexus-theme'],
      subtree: true,
    });
    const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', applyTheme);
    else themeMedia.addListener(applyTheme);

    let sessionId: string | null = null;
    let cursor = 0;
    let disposed = false;
    let pollTimer: number | null = null;
    let resizeTimer: number | null = null;
    let inputTimer: number | null = null;
    let inputSending = false;
    let pendingInput = '';

    const fit = (): void => {
      if (disposed) return;
      try { fitAddon.fit(); } catch { return; }
      if (!sessionId || !threadScope) return;
      void fetch(`/api/terminal/session/${encodeURIComponent(sessionId)}/resize?threadId=${encodeURIComponent(threadScope)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
      }).catch(() => undefined);
    };

    const scheduleFit = (): void => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        fit();
      }, 40);
    };

    const flushInput = async (): Promise<void> => {
      inputTimer = null;
      if (!sessionId || disposed || inputSending || !pendingInput) return;
      const currentSessionId = sessionId;
      const data = pendingInput;
      pendingInput = '';
      inputSending = true;
      try {
        await fetch(`/api/terminal/session/${encodeURIComponent(currentSessionId)}/input?threadId=${encodeURIComponent(threadScope)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        });
      } catch {
        // Keep the terminal responsive if the local API is briefly unavailable.
      } finally {
        inputSending = false;
        if (pendingInput && !disposed && inputTimer === null) {
          inputTimer = window.setTimeout(() => void flushInput(), 0);
        }
      }
    };

    const sendInput = (data: string): void => {
      if (!sessionId || !threadScope || disposed || !data) return;
      pendingInput += data;
      if (inputTimer === null && !inputSending) {
        inputTimer = window.setTimeout(() => void flushInput(), INPUT_BATCH_MS);
      }
    };

    const readClipboardIntoTerminal = async (): Promise<void> => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && !disposed) terminal.paste(text);
      } catch {
        // The native clipboard permission may be unavailable in a locked-down web context.
      }
    };

    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      void readClipboardIntoTerminal();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        void readClipboardIntoTerminal();
      }
    };
    const dataDisposable = terminal.onData(sendInput);
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!sessionId || !threadScope || disposed) return;
      void fetch(`/api/terminal/session/${encodeURIComponent(sessionId)}/resize?threadId=${encodeURIComponent(threadScope)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => undefined);
    });
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(container);
    container.addEventListener('contextmenu', handleContextMenu);
    container.addEventListener('keydown', handleKeyDown);

    const poll = async (): Promise<void> => {
      if (disposed || !sessionId || !threadScope) return;
      try {
        const response = await fetch(`/api/terminal/session/${encodeURIComponent(sessionId)}/output?cursor=${cursor}&waitMs=${OUTPUT_WAIT_MS}&threadId=${encodeURIComponent(threadScope)}`);
        if (!response.ok) throw new Error('terminal output unavailable');
        const payload = await response.json() as TerminalOutputResponse;
        if (payload.output) terminal.write(payload.output);
        if (typeof payload.cursor === 'number') cursor = payload.cursor;
        if (!disposed && !payload.exited) pollTimer = window.setTimeout(() => void poll(), 0);
      } catch {
        if (!disposed) pollTimer = window.setTimeout(() => void poll(), OUTPUT_RETRY_MS);
      }
    };

    const start = async (): Promise<void> => {
      if (!root || !threadScope) {
        terminal.write(locale === 'zh' ? '未选择项目根目录。\r\n' : 'No project root selected.\r\n');
        return;
      }
      try {
        const response = await fetch('/api/terminal/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, threadId: threadScope, cols: terminal.cols, rows: terminal.rows }),
        });
        const payload = await response.json() as Partial<TerminalSessionResponse> & { error?: string };
        if (!response.ok || typeof payload.sessionId !== 'string') {
          throw new Error(payload.error || (response.status === 404
            ? (locale === 'zh' ? '终端服务尚未重启，请重启 API 服务。' : 'Restart the API service to enable the terminal.')
            : 'Failed to start terminal'));
        }
        if (disposed) {
          await fetch(`/api/terminal/session/${encodeURIComponent(payload.sessionId)}?threadId=${encodeURIComponent(threadScope)}`, { method: 'DELETE' }).catch(() => undefined);
          return;
        }
        sessionId = payload.sessionId;
        fit();
        void poll();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminal.write(`\r\n${formatSuanliziErrorMessage(undefined, message, locale)}\r\n`);
      }
    };
    void start();

    return () => {
      disposed = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      if (themeMedia.removeEventListener) themeMedia.removeEventListener('change', applyTheme);
      else themeMedia.removeListener(applyTheme);
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('keydown', handleKeyDown);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      if (sessionId && threadScope) void fetch(`/api/terminal/session/${encodeURIComponent(sessionId)}?threadId=${encodeURIComponent(threadScope)}`, { method: 'DELETE' }).catch(() => undefined);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [locale, root, threadScope]);

  return (
    <section className="terminalPanel" aria-label={locale === 'zh' ? '终端' : 'Terminal'}>
      <div className="terminalOutput" ref={containerRef} />
    </section>
  );
}

const lightTerminalTheme = {
  background: '#ffffff',
  foreground: '#1d1d1f',
  cursor: '#1d1d1f',
  cursorAccent: '#ffffff',
  selectionBackground: '#b9d7ff',
  black: '#26292e',
  red: '#b42318',
  green: '#116932',
  yellow: '#8a5a00',
  blue: '#0b5cad',
  magenta: '#8a3a8a',
  cyan: '#046a73',
  white: '#3d4249',
  brightBlack: '#565c64',
  brightRed: '#c62f24',
  brightGreen: '#217a3c',
  brightYellow: '#9c6b10',
  brightBlue: '#176fb3',
  brightMagenta: '#9d479d',
  brightCyan: '#0b7c86',
  brightWhite: '#1d1d1f',
};

const darkTerminalTheme = {
  background: '#0c0c0c',
  foreground: '#f3f3f3',
  cursor: '#f3f3f3',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#4a4d52',
};
