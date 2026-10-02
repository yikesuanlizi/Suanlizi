import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workspaceHtmlPreviewDocument, workspacePreviewBreadcrumb, workspacePreviewCopyPath, workspacePreviewTabsForDisplay } from './components/WorkspaceFilesPanel.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('workspace preview types', () => {
  it('renders image, pdf, markdown, html, source, and office previews', () => {
    const component = readFileSync(join(here, 'components', 'WorkspaceFilesPanel.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');

    expect(component).toContain('ReactMarkdown');
    expect(component).toContain('remarkGfm');
    expect(component).toContain("preview.previewType === 'image'");
    expect(component).toContain("preview.previewType === 'pdf'");
    expect(component).toContain("preview.previewType === 'markdown'");
    expect(component).toContain("preview.previewType === 'html'");
    expect(component).toContain('workspacePreviewModeSwitch');
    expect(component).toContain('workspaceSourcePreview');
    expect(component).toContain('sandbox=""');
    expect(component).toContain('workspaceOfficePreview');
    expect(styles).toContain('.workspaceImagePreview');
    expect(styles).toContain('.workspacePdfPreview');
    expect(styles).toContain('.workspaceMarkdownPreview');
    expect(styles).toContain('.workspaceHtmlPreview');
    expect(styles).toContain('.workspaceSourcePreview');
    expect(styles).toContain('.appShell.theme-light .workspaceSourcePreview');
    expect(styles).toContain('.workspaceOfficePreview');
  });

  it('keeps rendered html constrained inside the preview viewport', () => {
    const html = workspaceHtmlPreviewDocument('<main style="width: 2000px"><img src="/hero.png"></main>');

    expect(html).toContain('data-suanlizi-preview-style');
    expect(html).toContain('max-width: 100% !important;');
    expect(html).toContain('overflow: auto !important;');
    expect(html).toContain('<main style="width: 2000px"><img src="/hero.png"></main>');
  });

  it('shows a readable copyable breadcrumb path in the preview header', () => {
    const component = readFileSync(join(here, 'components', 'WorkspaceFilesPanel.tsx'), 'utf-8');
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');
    const preview = {
      name: 'suanlizi111.html',
      path: 'Suanlizi/suanlizi111.html',
    };

    expect(workspacePreviewBreadcrumb(preview, 'E:\\langchain')).toBe('langchain > Suanlizi > suanlizi111.html');
    expect(workspacePreviewCopyPath(preview, 'E:\\langchain')).toBe('E:\\langchain\\Suanlizi\\suanlizi111.html');
    expect(component).toContain('workspacePreviewPathButton');
    expect(component).not.toContain('当前工作目录：');
    expect(component).not.toContain('Current workspace: ');
    expect(component).toContain('data-copy-hint={locale === \'zh\' ? \'点击复制路径\' : \'Click to copy path\'}');
    expect(component).toContain('aria-label={`${locale === \'zh\' ? \'点击复制路径\' : \'Click to copy path\'}: ${workspacePreviewCopyPath(preview, workspaceRoot)}`}');
    expect(component).toContain('copyPreviewPath(workspacePreviewCopyPath(preview, workspaceRoot))');
    expect(styles).toContain('.workspacePreviewPathButton strong');
    expect(styles).toContain('.workspacePreviewPathButton::after');
    expect(styles).toContain('content: attr(data-copy-hint);');
    expect(styles).toContain('color: #0f172a');
    expect(styles).not.toContain('.workspacePreviewPathButton:hover:not(:disabled) strong {\n  text-decoration: underline;');
  });

  it('keeps the preview tab title in sync when a non-pinned file is selected', () => {
    const component = readFileSync(join(here, 'components', 'WorkspaceFilesPanel.tsx'), 'utf-8');
    const pinned = [{ name: 'old.md', path: 'docs/old.md' }];
    const current = { name: 'next.md', path: 'docs/next.md' };

    expect(workspacePreviewTabsForDisplay(current, pinned, current).map((file) => file.name)).toEqual(['next.md', 'old.md']);
    expect(workspacePreviewTabsForDisplay(pinned[0], pinned, current).map((file) => file.name)).toEqual(['next.md', 'old.md']);
    expect(workspacePreviewTabsForDisplay(pinned[0], pinned, pinned[0]).map((file) => file.name)).toEqual(['old.md']);
    expect(workspacePreviewTabsForDisplay(pinned[0], pinned, null).map((file) => file.name)).toEqual(['old.md']);
    expect(component).toContain('displayedPreviewTabs');
    expect(component).toContain('displayedPreviewTabs.map');
    expect(component).toContain('transientPreview');
  });
});
