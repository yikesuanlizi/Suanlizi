import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workspaceDirectoryChainForTarget, workspaceFileRowTitle, workspaceRelativePathForTree } from './components/WorkspaceFilesPanel.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('workspace files layout', () => {
  it('stretches the preview card to the full right-pane height', () => {
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');
    const bodyStyles = styles.slice(styles.indexOf('.workspaceFileBody {'), styles.indexOf('.workspaceFileTreePane,'));
    const previewPaneStyles = styles.slice(styles.indexOf('.workspacePreviewPane {'), styles.indexOf('.workspaceFileSearch'));
    const noTabsStyles = styles.slice(styles.indexOf('.workspacePreviewPane.noPreviewTabs'), styles.indexOf('.workspacePreviewTabs'));
    const previewStart = styles.indexOf('.workspacePreview {', styles.indexOf('.workspaceFileRow:hover'));
    const previewStyles = styles.slice(previewStart, styles.indexOf('.workspacePreviewPane.noPreviewTabs', previewStart));

    expect(bodyStyles).toContain('grid-template-rows: minmax(0, 1fr);');
    expect(bodyStyles).toContain('align-items: stretch;');
    expect(previewPaneStyles).toContain('align-content: stretch;');
    expect(previewPaneStyles).toContain('height: 100%;');
    expect(noTabsStyles).toContain('grid-template-rows: minmax(0,1fr);');
    expect(previewStyles).toContain('align-self: stretch;');
    expect(previewStyles).toContain('min-height: 100%;');
    expect(noTabsStyles).toContain('display: flex;');
    expect(noTabsStyles).toContain('flex-direction: column;');
    expect(noTabsStyles).toContain('flex: 1 1 auto;');
    expect(noTabsStyles).toContain('min-height: 0;');
    expect(styles).toContain('display: block;');
    expect(styles).toContain('margin: 0;');
    expect(styles).toContain('max-height: none;');
  });

  it('keeps the file preview inside the right pane at compact widths', () => {
    const component = readFileSync(join(here, 'components', 'WorkspaceFilesPanel.tsx'), 'utf-8');

    expect(component).toContain('minmax(180px, ${treeWidth}%) 7px minmax(0, 1fr)');
  });

  it('loads every ancestor directory needed to reveal an externally previewed file', () => {
    expect(workspaceRelativePathForTree('E:\\langchain\\Suanlizi\\apps\\web\\src\\main.tsx', 'E:\\langchain\\Suanlizi')).toBe('apps/web/src/main.tsx');
    expect(workspaceDirectoryChainForTarget('apps/web/src/main.tsx', 'file')).toEqual(['', 'apps', 'apps/web', 'apps/web/src']);
    expect(workspaceDirectoryChainForTarget('apps/web/src', 'directory')).toEqual(['', 'apps', 'apps/web', 'apps/web/src']);
  });

  it('centers and flashes the revealed file row in the tree', () => {
    const component = readFileSync(join(here, 'components', 'WorkspaceFilesPanel.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');

    expect(component).toContain("scrollIntoView({ behavior: 'smooth', block: 'center' })");
    expect(component).toContain("'workspaceFileRow spotlight'");
    expect(styles).toContain('@keyframes workspaceFileSpotlight');
    expect(styles).toContain('animation: workspaceFileSpotlight 720ms ease-in-out 3;');
  });

  it('shows the full path when hovering file and directory rows', () => {
    const component = readFileSync(join(here, 'components', 'WorkspaceFilesPanel.tsx'), 'utf-8');

    expect(workspaceFileRowTitle({ name: 'src', path: 'apps/web/src' }, 'E:\\langchain\\Suanlizi')).toBe('E:\\langchain\\Suanlizi\\apps\\web\\src');
    expect(workspaceFileRowTitle({ name: 'main.tsx', path: 'apps/web/src/main.tsx' }, 'E:\\langchain\\Suanlizi')).toBe('E:\\langchain\\Suanlizi\\apps\\web\\src\\main.tsx');
    expect(component).toContain('title={workspaceFileRowTitle(entry, workspaceRoot)}');
  });

  it('keeps the file tree as the scroll owner inside the mounted workbench panel', () => {
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');

    expect(styles).toContain('.workbenchContent {\n  contain: layout paint;\n  overflow: hidden;');
    expect(styles).toContain('.workbenchPanel.active {\n  height: 100%;\n  min-height: 0;');
    expect(styles).toContain('.workspaceFiles {\n  backface-visibility: hidden;\n  height: 100%;\n  min-height: 0;');
    expect(styles).toContain('.workspaceFileList,\n.workspacePreviewPane,\n.workspacePreviewContent');
    expect(styles).toContain('overscroll-behavior: contain;');
  });
});
