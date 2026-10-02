// 审批 diff 预览解析器：从工具调用 payload 提取 diff hunks
// — English: approval diff preview parser: extract diff hunks from tool call payload
import type { DiffViewHunk } from './DiffView.js';

// 轻量级 Suanlizi patch 解析（仅用于审批预览，不写入文件）
// — English: lightweight Suanlizi patch parser for approval preview only
export function parseSuanliziPatchForPreview(patchText: string): DiffViewHunk[] {
  const lines = patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const hunks: DiffViewHunk[] = [];
  let i = 0;
  if (lines[i] === '*** Begin Patch') i++;

  while (i < lines.length) {
    const line = lines[i];
    if (line === '*** End Patch' || (line === '' && i === lines.length - 1)) break;

    // *** Add File: path
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const added: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (lines[i].startsWith('+')) added.push(lines[i].slice(1));
        i++;
      }
      hunks.push({
        path,
        addedLines: added.length,
        removedLines: 0,
        addedLinesContent: added,
        removedLinesContent: [],
        summary: `add file ${path}`,
      });
      continue;
    }

    // *** Delete File: path
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      hunks.push({
        path,
        addedLines: 0,
        removedLines: 0,
        addedLinesContent: [],
        removedLinesContent: [],
        summary: `delete file ${path}`,
      });
      continue;
    }

    // *** Update File: path [*** Move to: newpath]
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | undefined;
      if (lines[i]?.startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      let currentAdded: string[] = [];
      let currentRemoved: string[] = [];
      let hasHunk = false;
      const flushHunk = () => {
        if (hasHunk) {
          hunks.push({
            path: moveTo ?? path,
            addedLines: currentAdded.length,
            removedLines: currentRemoved.length,
            addedLinesContent: currentAdded,
            removedLinesContent: currentRemoved,
          });
        }
        currentAdded = [];
        currentRemoved = [];
        hasHunk = false;
      };
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        const hunkLine = lines[i];
        if (hunkLine === '' && i === lines.length - 1) break;
        if (hunkLine.startsWith('@@')) {
          flushHunk();
          hasHunk = true;
          i++;
          continue;
        }
        if (hunkLine === '*** End of File') {
          i++;
          continue;
        }
        if (!hasHunk) hasHunk = true;
        const prefix = hunkLine[0];
        const text = hunkLine.slice(1);
        if (prefix === '+') currentAdded.push(text);
        else if (prefix === '-') currentRemoved.push(text);
        i++;
      }
      flushHunk();
      if (moveTo) {
        hunks.push({
          path,
          addedLines: 0,
          removedLines: 0,
          addedLinesContent: [],
          removedLinesContent: [],
          summary: `rename to ${moveTo}`,
        });
      }
      continue;
    }

    // 未识别行，跳过避免死循环
    i++;
  }
  return hunks;
}

// 从 write_file payload 构造 diff 预览（整个文件内容作为新增行展示）
// — English: build diff preview from write_file payload (entire content as added lines)
export function buildWriteFileHunks(payload: Record<string, unknown>): DiffViewHunk[] {
  const filePath = typeof payload.filePath === 'string' ? payload.filePath : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  const lines = content.length > 0 ? content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n') : [];
  return [{
    path: filePath,
    addedLines: lines.length,
    removedLines: 0,
    addedLinesContent: lines,
    removedLinesContent: [],
    summary: `write ${filePath}`,
  }];
}

// 从未知 payload 提取 diff 预览 hunks
// — English: extract diff preview hunks from unknown payload
export function extractApprovalDiffHunks(payload: unknown): DiffViewHunk[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  // apply_patch: { patch: "*** Begin Patch..." }
  if (typeof obj.patch === 'string') {
    return parseSuanliziPatchForPreview(obj.patch);
  }
  // write_file: { filePath, content }
  if (typeof obj.filePath === 'string' && typeof obj.content === 'string') {
    return buildWriteFileHunks(obj);
  }
  return [];
}
