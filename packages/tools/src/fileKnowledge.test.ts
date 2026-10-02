import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { computeFileFingerprint, detectContentType, isDocumentFile } from './fileKnowledge.js';

describe('file knowledge fingerprinting', () => {
  it('computes full-file sha256, relative path, size and mtime', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-fingerprint-'));
    const filePath = path.join(root, 'docs', 'a.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '中文内容\nsecond line\n', 'utf-8');

    const fp = await computeFileFingerprint(root, 'docs/a.md');

    expect(fp.path).toBe(filePath);
    expect(fp.relativePath).toBe('docs/a.md');
    expect(fp.workspaceRoot).toBe(root);
    expect(fp.sizeBytes).toBe(Buffer.byteLength('中文内容\nsecond line\n'));
    expect(fp.sha256).toBe(createHash('sha256').update('中文内容\nsecond line\n').digest('hex'));
    expect(fp.contentType).toBe('text/markdown');
    expect(Date.parse(fp.observedAt)).toBeGreaterThan(0);
  });

  it('detects document content types from extension', () => {
    expect(detectContentType('a.docx')).toContain('wordprocessingml');
    expect(detectContentType('b.pdf')).toBe('application/pdf');
    expect(detectContentType('c.xlsx')).toContain('spreadsheetml');
    expect(detectContentType('d.pptx')).toContain('presentationml');
    expect(isDocumentFile('a.docx')).toBe(true);
    expect(isDocumentFile('a.md')).toBe(false);
  });
});
