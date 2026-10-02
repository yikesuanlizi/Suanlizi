import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('useRightPaneSizing', () => {
  it('keeps activity and agents compact while files and browser have dedicated wide panes', () => {
    const source = readFileSync(join(here, 'uiState.ts'), 'utf-8');

    expect(source).toContain("export type RightPaneSizingMode = 'standard' | 'files' | 'browser' | 'terminal' | 'workflow'");
    expect(source).not.toContain('RightPaneTab');
    expect(source).toContain('function defaultStandardPaneWidth(): number');
    expect(source).toContain('return 316;');
    expect(source).toContain('function defaultFilesPaneWidth(): number');
    expect(source).toContain('function defaultBrowserPaneWidth(): number');
    expect(source).toContain('function defaultTerminalPaneWidth(): number');
    expect(source).toContain("localStorage.getItem('suanlizi.standardPaneWidth')");
    expect(source).toContain("localStorage.getItem('suanlizi.filesPaneWidth')");
    expect(source).toContain("localStorage.getItem('suanlizi.browserPaneWidth')");
    expect(source).toContain("localStorage.getItem('suanlizi.terminalPaneWidth')");
    expect(source).not.toContain('[mode, tab]');
  });
});
