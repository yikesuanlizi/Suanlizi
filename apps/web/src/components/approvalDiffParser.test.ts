import { describe, expect, it } from 'vitest';
import { extractApprovalDiffHunks, parseSuanliziPatchForPreview, buildWriteFileHunks } from './approvalDiffParser.js';

describe('approvalDiffParser', () => {
  describe('extractApprovalDiffHunks', () => {
    it('returns empty array for null/undefined/non-object payload', () => {
      expect(extractApprovalDiffHunks(null)).toEqual([]);
      expect(extractApprovalDiffHunks(undefined)).toEqual([]);
      expect(extractApprovalDiffHunks('string')).toEqual([]);
      expect(extractApprovalDiffHunks(42)).toEqual([]);
    });

    it('returns empty array for unknown payload shape', () => {
      expect(extractApprovalDiffHunks({ foo: 'bar' })).toEqual([]);
      // apply_patch without string patch
      expect(extractApprovalDiffHunks({ patch: 123 })).toEqual([]);
      // write_file without content
      expect(extractApprovalDiffHunks({ filePath: 'a.txt' })).toEqual([]);
    });
  });

  describe('parseSuanliziPatchForPreview - Add File', () => {
    it('parses *** Add File with all added lines', () => {
      const patch = `*** Begin Patch
*** Add File: new.txt
+line one
+line two
+line three
*** End Patch`;
      const hunks = parseSuanliziPatchForPreview(patch);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].path).toBe('new.txt');
      expect(hunks[0].addedLines).toBe(3);
      expect(hunks[0].removedLines).toBe(0);
      expect(hunks[0].addedLinesContent).toEqual(['line one', 'line two', 'line three']);
      expect(hunks[0].removedLinesContent).toEqual([]);
      expect(hunks[0].summary).toBe('add file new.txt');
    });
  });

  describe('parseSuanliziPatchForPreview - Delete File', () => {
    it('parses *** Delete File', () => {
      const patch = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`;
      const hunks = parseSuanliziPatchForPreview(patch);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].path).toBe('old.txt');
      expect(hunks[0].addedLines).toBe(0);
      expect(hunks[0].removedLines).toBe(0);
      expect(hunks[0].addedLinesContent).toEqual([]);
      expect(hunks[0].removedLinesContent).toEqual([]);
      expect(hunks[0].summary).toBe('delete file old.txt');
    });
  });

  describe('parseSuanliziPatchForPreview - Update File', () => {
    it('parses hunks with +/- lines', () => {
      const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
-old line
+new line
 context line
+another added
*** End Patch`;
      const hunks = parseSuanliziPatchForPreview(patch);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].path).toBe('src/app.ts');
      expect(hunks[0].addedLines).toBe(2);
      expect(hunks[0].removedLines).toBe(1);
      expect(hunks[0].addedLinesContent).toEqual(['new line', 'another added']);
      expect(hunks[0].removedLinesContent).toEqual(['old line']);
    });

    it('parses multiple @@ hunks in same file', () => {
      const patch = `*** Begin Patch
*** Update File: src/util.ts
@@
-removed one
+added one
@@
-removed two
+added two
*** End Patch`;
      const hunks = parseSuanliziPatchForPreview(patch);
      expect(hunks).toHaveLength(2);
      expect(hunks[0].addedLinesContent).toEqual(['added one']);
      expect(hunks[0].removedLinesContent).toEqual(['removed one']);
      expect(hunks[1].addedLinesContent).toEqual(['added two']);
      expect(hunks[1].removedLinesContent).toEqual(['removed two']);
    });

    it('handles *** End of File marker', () => {
      const patch = `*** Begin Patch
*** Update File: src/eof.ts
@@
+appended line
*** End of File
*** End Patch`;
      const hunks = parseSuanliziPatchForPreview(patch);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].addedLinesContent).toEqual(['appended line']);
    });
  });

  describe('parseSuanliziPatchForPreview - Move to (rename)', () => {
    it('parses rename with content edits', () => {
      const patch = `*** Begin Patch
*** Update File: old/path.ts
*** Move to: new/path.ts
@@
-old line
+new line
*** End Patch`;
      const hunks = parseSuanliziPatchForPreview(patch);
      // 第一个 hunk 是内容变更（路径用 moveTo 目标）
      expect(hunks[0].path).toBe('new/path.ts');
      expect(hunks[0].addedLinesContent).toEqual(['new line']);
      expect(hunks[0].removedLinesContent).toEqual(['old line']);
      // 第二个 hunk 标记源路径 rename
      expect(hunks[1].path).toBe('old/path.ts');
      expect(hunks[1].summary).toBe('rename to new/path.ts');
    });

    it('parses pure rename without content edits', () => {
      const patch = `*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
*** End Patch`;
      const hunks = parseSuanliziPatchForPreview(patch);
      // 纯 rename 只生成 rename 标记 hunk
      expect(hunks).toHaveLength(1);
      expect(hunks[0].path).toBe('a.txt');
      expect(hunks[0].summary).toBe('rename to b.txt');
    });
  });

  describe('parseSuanliziPatchForPreview - edge cases', () => {
    it('handles CRLF line endings', () => {
      const patch = '*** Begin Patch\r\n*** Add File: a.txt\r\n+hello\r\n*** End Patch\r\n';
      const hunks = parseSuanliziPatchForPreview(patch);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].addedLinesContent).toEqual(['hello']);
    });

    it('returns empty for patch without *** Begin Patch', () => {
      // 没有 *** Begin Patch 开头，跳过第一行后继续解析
      const patch = `*** Add File: a.txt
+hello
*** End Patch`;
      const hunks = parseSuanliziPatchForPreview(patch);
      // 仍然能解析（第一行不是 Begin Patch 就跳过）
      expect(hunks).toHaveLength(1);
      expect(hunks[0].addedLinesContent).toEqual(['hello']);
    });

    it('handles empty patch', () => {
      expect(parseSuanliziPatchForPreview('')).toEqual([]);
    });
  });

  describe('buildWriteFileHunks', () => {
    it('builds hunk from write_file payload', () => {
      const hunks = buildWriteFileHunks({ filePath: 'test.txt', content: 'line1\nline2\nline3' });
      expect(hunks).toHaveLength(1);
      expect(hunks[0].path).toBe('test.txt');
      expect(hunks[0].addedLines).toBe(3);
      expect(hunks[0].removedLines).toBe(0);
      expect(hunks[0].addedLinesContent).toEqual(['line1', 'line2', 'line3']);
      expect(hunks[0].removedLinesContent).toEqual([]);
    });

    it('handles empty content', () => {
      const hunks = buildWriteFileHunks({ filePath: 'empty.txt', content: '' });
      expect(hunks).toHaveLength(1);
      expect(hunks[0].addedLines).toBe(0);
      expect(hunks[0].addedLinesContent).toEqual([]);
    });

    it('handles missing filePath', () => {
      const hunks = buildWriteFileHunks({ content: 'hello' });
      expect(hunks).toHaveLength(1);
      expect(hunks[0].path).toBe('');
    });

    it('handles CRLF content', () => {
      const hunks = buildWriteFileHunks({ filePath: 'a.txt', content: 'a\r\nb\r\nc' });
      expect(hunks[0].addedLinesContent).toEqual(['a', 'b', 'c']);
    });
  });

  describe('extractApprovalDiffHunks - integration', () => {
    it('routes apply_patch payload to patch parser', () => {
      const hunks = extractApprovalDiffHunks({
        patch: '*** Begin Patch\n*** Add File: x.txt\n+hi\n*** End Patch',
      });
      expect(hunks).toHaveLength(1);
      expect(hunks[0].addedLinesContent).toEqual(['hi']);
    });

    it('routes write_file payload to write_file builder', () => {
      const hunks = extractApprovalDiffHunks({
        filePath: 'y.txt',
        content: 'hello\nworld',
      });
      expect(hunks).toHaveLength(1);
      expect(hunks[0].path).toBe('y.txt');
      expect(hunks[0].addedLinesContent).toEqual(['hello', 'world']);
    });
  });
});
