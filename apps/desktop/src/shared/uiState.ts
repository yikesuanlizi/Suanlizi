import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

const RIGHT_PANE_MAIN_MIN = 300;
const STANDARD_RIGHT_PANE_MIN = 220;
const FILES_RIGHT_PANE_MIN = 300;
const BROWSER_RIGHT_PANE_MIN = 380;
const TERMINAL_RIGHT_PANE_MIN = 460;
const WORKFLOW_RIGHT_PANE_MIN = 300;
const SIDEBAR_WIDTH = 236;
const PANE_DIVIDER_WIDTH = 7;

export type RightPaneSizingMode = 'standard' | 'files' | 'browser' | 'terminal' | 'workflow';

export interface ToastNotice {
  id: number;
  text: string;
}

export function useToastNotice(timeoutMs = 1800) {
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const [timerId, setTimerId] = useState<number | null>(null);
  const lastToastRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });

  const showToast = useCallback((text: string) => {
    const normalized = text.trim();
    if (!normalized) return;
    const now = Date.now();
    if (lastToastRef.current.text === normalized && now - lastToastRef.current.at < timeoutMs) return;
    lastToastRef.current = { text: normalized, at: now };
    if (timerId) window.clearTimeout(timerId);
    setToast({ id: now, text: normalized });
    setTimerId(window.setTimeout(() => setToast(null), timeoutMs));
  }, [timerId, timeoutMs]);

  useEffect(() => () => {
    if (timerId) window.clearTimeout(timerId);
  }, [timerId]);

  return { toast, showToast };
}

export function useRightPaneSizing(visible: boolean, mode: RightPaneSizingMode = 'standard') {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [width, setWidth] = useState(() => {
    if (mode === 'files') {
      const stored = Number(localStorage.getItem('suanlizi.filesPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultFilesPaneWidth(), FILES_RIGHT_PANE_MIN);
    }
    if (mode === 'browser') {
      const stored = Number(localStorage.getItem('suanlizi.browserPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultBrowserPaneWidth(), BROWSER_RIGHT_PANE_MIN);
    }
    if (mode === 'terminal') {
      const stored = Number(localStorage.getItem('suanlizi.terminalPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultTerminalPaneWidth(), TERMINAL_RIGHT_PANE_MIN);
    }
    if (mode !== 'workflow') {
      const stored = Number(localStorage.getItem('suanlizi.standardPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultStandardPaneWidth(), STANDARD_RIGHT_PANE_MIN);
    }
    const stored = Number(localStorage.getItem('suanlizi.workflowPaneWidth') ?? 0);
    return clampRightPaneWidth(stored || defaultWorkflowPaneWidth(), WORKFLOW_RIGHT_PANE_MIN);
  });

  useEffect(() => {
    setWidth(() => {
      if (mode === 'workflow') {
        const stored = Number(localStorage.getItem('suanlizi.workflowPaneWidth') ?? 0);
        return clampRightPaneWidth(stored || defaultWorkflowPaneWidth(), WORKFLOW_RIGHT_PANE_MIN);
      }
      if (mode === 'files') {
        const stored = Number(localStorage.getItem('suanlizi.filesPaneWidth') ?? 0);
        return clampRightPaneWidth(stored || defaultFilesPaneWidth(), FILES_RIGHT_PANE_MIN);
      }
      if (mode === 'browser') {
        const stored = Number(localStorage.getItem('suanlizi.browserPaneWidth') ?? 0);
        return clampRightPaneWidth(stored || defaultBrowserPaneWidth(), BROWSER_RIGHT_PANE_MIN);
      }
      if (mode === 'terminal') {
        const stored = Number(localStorage.getItem('suanlizi.terminalPaneWidth') ?? 0);
        return clampRightPaneWidth(stored || defaultTerminalPaneWidth(), TERMINAL_RIGHT_PANE_MIN);
      }
      const stored = Number(localStorage.getItem('suanlizi.standardPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultStandardPaneWidth(), STANDARD_RIGHT_PANE_MIN);
    });
  }, [mode]);

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  const layout = rightPaneLayoutForViewport(mode, width, viewportWidth);

  const startResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!visible) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const currentLayout = rightPaneLayoutForViewport(mode, width, window.innerWidth);
    const resizeMin = currentLayout.min;
    const max = currentLayout.max;
    function move(moveEvent: PointerEvent) {
      const next = startWidth - (moveEvent.clientX - startX);
      const nextWidth = Math.min(max, Math.max(resizeMin, next));
      if (mode === 'workflow') localStorage.setItem('suanlizi.workflowPaneWidth', String(Math.round(nextWidth)));
      if (mode === 'files') localStorage.setItem('suanlizi.filesPaneWidth', String(Math.round(nextWidth)));
      if (mode === 'browser') localStorage.setItem('suanlizi.browserPaneWidth', String(Math.round(nextWidth)));
      if (mode === 'terminal') localStorage.setItem('suanlizi.terminalPaneWidth', String(Math.round(nextWidth)));
      if (mode === 'standard') localStorage.setItem('suanlizi.standardPaneWidth', String(Math.round(nextWidth)));
      setWidth(nextWidth);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [mode, visible, width]);

  return {
    rightPaneWidth: layout.width,
    rightPaneGridTemplateColumns: visible
      ? `minmax(${layout.mainMin}px, 1fr) ${PANE_DIVIDER_WIDTH}px minmax(${layout.min}px, ${layout.width}px)`
      : 'minmax(0, 1fr)',
    startRightPaneResize: startResize,
  };
}

function defaultWorkflowPaneWidth(): number {
  return Math.round(Math.max(620, window.innerWidth * 0.5));
}

function defaultStandardPaneWidth(): number {
  return 316;
}

function defaultFilesPaneWidth(): number {
  return Math.round(Math.min(1080, Math.max(620, window.innerWidth * 0.5)));
}

function defaultBrowserPaneWidth(): number {
  return Math.round(Math.min(1180, Math.max(640, window.innerWidth * 0.56)));
}

function defaultTerminalPaneWidth(): number {
  return Math.round(Math.min(1120, Math.max(700, window.innerWidth * 0.54)));
}

function rightPaneMinForMode(mode: RightPaneSizingMode): number {
  if (mode === 'workflow') return WORKFLOW_RIGHT_PANE_MIN;
  if (mode === 'files') return FILES_RIGHT_PANE_MIN;
  if (mode === 'browser') return BROWSER_RIGHT_PANE_MIN;
  if (mode === 'terminal') return TERMINAL_RIGHT_PANE_MIN;
  return STANDARD_RIGHT_PANE_MIN;
}

function rightPaneLayoutForViewport(mode: RightPaneSizingMode, requestedWidth: number, viewportWidth: number): { min: number; max: number; width: number; mainMin: number } {
  const workspaceWidth = Math.max(0, viewportWidth - SIDEBAR_WIDTH);
  const mainMin = mode === 'browser'
    ? 240
    : mode === 'terminal'
      ? 220
      : Math.min(420, Math.max(RIGHT_PANE_MAIN_MIN, Math.round(workspaceWidth * 0.42)));
  const max = Math.max(180, workspaceWidth - mainMin - PANE_DIVIDER_WIDTH);
  const min = Math.min(rightPaneMinForMode(mode), max);
  return {
    min,
    max,
    width: Math.min(max, Math.max(min, requestedWidth)),
    mainMin,
  };
}

function clampRightPaneWidth(width: number, min: number): number {
  // Immersive utility panes (browser/terminal) may consume most of the
  // workspace. Their layout function still protects the chat column, while
  // this hydration clamp must not reintroduce the old 300px hard cap.
  const max = Math.max(min, window.innerWidth - SIDEBAR_WIDTH - 220 - PANE_DIVIDER_WIDTH);
  return Math.min(max, Math.max(min, width));
}
