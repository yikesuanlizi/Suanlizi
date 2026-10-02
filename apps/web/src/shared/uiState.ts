import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

const RIGHT_PANE_MAIN_MIN = 220;
const STANDARD_RIGHT_PANE_MIN = 220;
const FILES_RIGHT_PANE_MIN = 300;
const TERMINAL_RIGHT_PANE_MIN = 460;
const WORKFLOW_RIGHT_PANE_MIN = 300;

export type RightPaneSizingMode = 'standard' | 'files' | 'terminal' | 'workflow';

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
  const [width, setWidth] = useState(() => {
    if (mode === 'files') {
      const stored = Number(localStorage.getItem('nexus.filesPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultFilesPaneWidth(), FILES_RIGHT_PANE_MIN);
    }
    if (mode === 'terminal') {
      const stored = Number(localStorage.getItem('nexus.terminalPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultTerminalPaneWidth(), TERMINAL_RIGHT_PANE_MIN);
    }
    if (mode !== 'workflow') {
      const stored = Number(localStorage.getItem('nexus.standardPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultStandardPaneWidth(), STANDARD_RIGHT_PANE_MIN);
    }
    const stored = Number(localStorage.getItem('nexus.workflowPaneWidth') ?? 0);
    return clampRightPaneWidth(stored || defaultWorkflowPaneWidth(), WORKFLOW_RIGHT_PANE_MIN);
  });

  useEffect(() => {
    setWidth(() => {
      if (mode === 'workflow') {
        const stored = Number(localStorage.getItem('nexus.workflowPaneWidth') ?? 0);
        return clampRightPaneWidth(stored || defaultWorkflowPaneWidth(), WORKFLOW_RIGHT_PANE_MIN);
      }
      if (mode === 'files') {
        const stored = Number(localStorage.getItem('nexus.filesPaneWidth') ?? 0);
        return clampRightPaneWidth(stored || defaultFilesPaneWidth(), FILES_RIGHT_PANE_MIN);
      }
      if (mode === 'terminal') {
        const stored = Number(localStorage.getItem('nexus.terminalPaneWidth') ?? 0);
        return clampRightPaneWidth(stored || defaultTerminalPaneWidth(), TERMINAL_RIGHT_PANE_MIN);
      }
      const stored = Number(localStorage.getItem('nexus.standardPaneWidth') ?? 0);
      return clampRightPaneWidth(stored || defaultStandardPaneWidth(), STANDARD_RIGHT_PANE_MIN);
    });
  }, [mode]);

  const startResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!visible) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const resizeMin = rightPaneMinForMode(mode);
    const max = Math.max(
      resizeMin,
      window.innerWidth - 240 - RIGHT_PANE_MAIN_MIN - 7,
    );
    function move(moveEvent: PointerEvent) {
      const next = startWidth - (moveEvent.clientX - startX);
      const nextWidth = Math.min(max, Math.max(resizeMin, next));
      if (mode === 'workflow') localStorage.setItem('nexus.workflowPaneWidth', String(Math.round(nextWidth)));
      if (mode === 'files') localStorage.setItem('nexus.filesPaneWidth', String(Math.round(nextWidth)));
      if (mode === 'terminal') localStorage.setItem('nexus.terminalPaneWidth', String(Math.round(nextWidth)));
      if (mode === 'standard') localStorage.setItem('nexus.standardPaneWidth', String(Math.round(nextWidth)));
      setWidth(nextWidth);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [mode, visible, width]);

  const rightPaneMin = rightPaneMinForMode(mode);

  return {
    rightPaneWidth: width,
    rightPaneGridTemplateColumns: visible
      ? `minmax(${RIGHT_PANE_MAIN_MIN}px, 1fr) 7px minmax(${rightPaneMin}px, ${width}px)`
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

function defaultTerminalPaneWidth(): number {
  return Math.round(Math.min(1120, Math.max(700, window.innerWidth * 0.54)));
}

function rightPaneMinForMode(mode: RightPaneSizingMode): number {
  if (mode === 'workflow') return WORKFLOW_RIGHT_PANE_MIN;
  if (mode === 'files') return FILES_RIGHT_PANE_MIN;
  if (mode === 'terminal') return TERMINAL_RIGHT_PANE_MIN;
  return STANDARD_RIGHT_PANE_MIN;
}

function clampRightPaneWidth(width: number, min: number): number {
  return Math.min(Math.max(min, window.innerWidth - 240 - RIGHT_PANE_MAIN_MIN - 7), Math.max(min, width));
}
