import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('right pane sizing', () => {
  it('keeps standard and files pane sizing independent', () => {
    const source = readFileSync(join(here, 'shared', 'uiState.ts'), 'utf-8');

    expect(source).toContain('const RIGHT_PANE_MAIN_MIN = 220;');
    expect(source).toContain('const STANDARD_RIGHT_PANE_MIN = 220;');
    expect(source).toContain('const FILES_RIGHT_PANE_MIN = 300;');
    expect(source).toContain('defaultStandardPaneWidth');
    expect(source).toContain('defaultFilesPaneWidth');
    expect(source).toContain('Math.min(1080, Math.max(620, window.innerWidth * 0.5))');
    expect(source).toContain("if (mode === 'files')");
    expect(source).toContain("localStorage.getItem('suanlizi.filesPaneWidth')");
    expect(source).toContain("localStorage.getItem('suanlizi.standardPaneWidth')");
    expect(source).toContain('rightPaneAvailableMax()');
    expect(source).toContain('calc(100vw - 240px)');
    expect(source).not.toContain('55vw');
    expect(source).not.toContain('62vw');
  });

  it('lets workflow projects resize below and above the old half-screen band', () => {
    const source = readFileSync(join(here, 'shared', 'uiState.ts'), 'utf-8');

    expect(source).toContain('const WORKFLOW_RIGHT_PANE_MIN = 300;');
    expect(source).toContain('defaultWorkflowPaneWidth');
    expect(source).toContain('clampRightPaneWidth(stored || defaultWorkflowPaneWidth(), WORKFLOW_RIGHT_PANE_MIN)');
    expect(source).toContain('const resizeMin = rightPaneMinForMode(mode);');
    expect(source).toContain('minmax(${RIGHT_PANE_MAIN_MIN}px, 1fr) 7px minmax(${rightPaneMin}px, min(${width}px, calc(100vw - 240px)))');
    expect(source).not.toContain('rightPaneMinForTab');
    expect(source).not.toContain('workflowPaneWidthForTwoThirds');
  });

  it('keeps workbench tabs mounted and transitions them only on compositor-friendly properties', () => {
    const workbench = readFileSync(join(here, 'components', 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');
    const inactiveStart = styles.indexOf('.workbenchPanel.inactive {');
    const inactiveStyles = styles.slice(inactiveStart, styles.indexOf('\n}', inactiveStart) + 2);

    expect(workbench).toContain("data-state={activeTab === 'activity' ? 'active' : 'inactive'}");
    expect(workbench).toContain("data-state={activeTab === 'agents' ? 'active' : 'inactive'}");
    expect(workbench).toContain("data-state={activeTab === 'files' ? 'active' : 'inactive'}");
    expect(workbench).toContain("inert={activeTab !== 'activity'}");
    expect(workbench).toContain("inert={activeTab !== 'agents'}");
    expect(workbench).toContain("inert={activeTab !== 'files'}");
    expect(workbench).not.toContain("{activeTab === 'activity' ? (");
    expect(workbench).not.toContain("{activeTab === 'agents' ? (");
    expect(styles).toMatch(/\.workbenchPanel\s*\{[\s\S]*?transition: opacity var\(--nx-motion-fast\), transform var\(--nx-motion-fast\);/);
    expect(inactiveStyles).toContain('transform: translate3d(8px, 0, 0);');
    expect(inactiveStyles).not.toContain('visibility: hidden;');
  });
});
