import { describe, expect, it } from 'vitest';
import { buildTurnFileSummary } from './turnFileSummary.js';

describe('buildTurnFileSummary', () => {
  it('summarizes read and changed files with full paths and change stats', () => {
    const summary = buildTurnFileSummary([
      {
        id: 'read-1',
        type: 'tool_call',
        toolName: 'read_file',
        arguments: { filePath: 'apps/web/src/main.tsx' },
        result: { path: 'E:\\langchain\\Suanlizi\\apps\\web\\src\\main.tsx' },
        status: 'completed',
      },
      {
        id: 'change-1',
        type: 'file_change',
        changes: [
          { path: 'apps/web/src/components/ItemView.tsx', kind: 'update', addedLines: 5, removedLines: 2 },
        ],
        status: 'completed',
      },
    ], 'E:\\langchain\\Suanlizi');

    expect(summary.readFiles).toEqual([
      { path: 'E:\\langchain\\Suanlizi\\apps\\web\\src\\main.tsx' },
    ]);
    expect(summary.changedFiles).toEqual([
      { path: 'E:\\langchain\\Suanlizi\\apps\\web\\src\\components\\ItemView.tsx', addedLines: 5, removedLines: 2 },
    ]);
  });

  it('filters internal temporary paths', () => {
    const summary = buildTurnFileSummary([
      {
        id: 'read-temp',
        type: 'tool_call',
        toolName: 'read_file',
        arguments: { filePath: 'C:\\Users\\me\\AppData\\Local\\Temp\\script.ts' },
        status: 'completed',
      },
      {
        id: 'change-temp',
        type: 'file_change',
        changes: [{ path: '.codex/tmp-script.ts', kind: 'add', addedLines: 1, removedLines: 0 }],
        status: 'completed',
      },
    ], 'E:\\langchain\\Suanlizi');

    expect(summary.readFiles).toEqual([]);
    expect(summary.changedFiles).toEqual([]);
  });

  it('filters root helper artifacts and keeps the real project document from command arguments', () => {
    const summary = buildTurnFileSummary([
      {
        id: 'read-dump',
        type: 'tool_call',
        toolName: 'read_file',
        arguments: { filePath: 'E:\\langchain\\dexin-agent\\_docx_dump.txt' },
        status: 'completed',
      },
      {
        id: 'change-helper',
        type: 'file_change',
        changes: [{ path: 'E:\\langchain\\dexin-agent\\_read_docx.py', kind: 'add', addedLines: 14, removedLines: 0 }],
        status: 'completed',
      },
      {
        id: 'command-docx',
        type: 'command_execution',
        command: 'python _read_docx.py "E:\\langchain\\dexin-agent\\智能体运行平台详细架构设计_v0.9.docx" > _docx_dump.txt',
        status: 'completed',
      },
    ], 'E:\\langchain\\dexin-agent');

    expect(summary.readFiles).toEqual([
      { path: 'E:\\langchain\\dexin-agent\\智能体运行平台详细架构设计_v0.9.docx' },
    ]);
    expect(summary.changedFiles).toEqual([]);
  });

  it('uses read_document structured source metadata as the involved file', () => {
    const summary = buildTurnFileSummary([
      {
        id: 'read-doc',
        type: 'tool_call',
        toolName: 'read_document',
        arguments: { filePath: 'brief.docx' },
        result: {
          source: {
            path: 'E:\\langchain\\dexin-agent\\brief.docx',
            sha256: 'source-hash',
            mtimeMs: 1,
            sizeBytes: 10,
          },
          artifact: {
            path: 'E:\\langchain\\dexin-agent\\.suanlizi\\documents\\brief.txt',
            sha256: 'artifact-hash',
          },
        },
        status: 'completed',
      },
    ], 'E:\\langchain\\dexin-agent');

    expect(summary.readFiles).toEqual([
      { path: 'E:\\langchain\\dexin-agent\\brief.docx' },
    ]);
  });

  it('extracts bare project filenames from commands without treating URLs as files', () => {
    const summary = buildTurnFileSummary([
      {
        id: 'command-docx-name',
        type: 'command_execution',
        command: 'python _read_docx.py 需求说明.docx && python -c "p.text.strip()" && curl https://example.com/report.pdf',
        status: 'completed',
      },
    ], 'E:\\langchain\\dexin-agent');

    expect(summary.readFiles).toEqual([
      { path: 'E:\\langchain\\dexin-agent\\需求说明.docx' },
    ]);
  });

  it('does not treat code member access as a generated workspace file', () => {
    const summary = buildTurnFileSummary([
      {
        id: 'command-code-token',
        type: 'command_execution',
        command: 'python -c "for p in paragraphs: print(p.text.strip())"',
        aggregatedOutput: 'parsed by p.text.strip and saved nothing',
        status: 'completed',
      },
    ], 'E:\\langchain');

    expect(summary.readFiles).toEqual([]);
    expect(summary.changedFiles).toEqual([]);
  });

  it('extracts an absolute file path from a function call token without keeping the call prefix', () => {
    const summary = buildTurnFileSummary([
      {
        id: 'command-open-token',
        type: 'command_execution',
        command: 'python -c "print(1)"',
        aggregatedOutput: String.raw`ENOENT: no such file or directory, stat 'E:\langchain\open(E:\langchain\dexin-agent\_v1_decoded.txt'`,
        status: 'completed',
      },
    ], 'E:\\langchain');

    expect(summary.readFiles).toEqual([
      { path: 'E:\\langchain\\dexin-agent\\_v1_decoded.txt' },
    ]);
  });

  it('extracts source document paths from command output and helper script hunks', () => {
    const summary = buildTurnFileSummary([
      {
        id: 'command-output-docx',
        type: 'command_execution',
        command: 'python _read_docx.py',
        aggregatedOutput: 'reading E:\\langchain\\dexin-agent\\智能体运行平台详细架构设计_v1.0.docx\nok',
        status: 'completed',
      },
      {
        id: 'helper-script',
        type: 'file_change',
        changes: [{ path: 'E:\\langchain\\dexin-agent\\_read_docx.py', kind: 'add', addedLines: 3, removedLines: 0 }],
        hunks: [{
          path: 'E:\\langchain\\dexin-agent\\_read_docx.py',
          startLine: 1,
          endLine: 3,
          addedLines: 3,
          removedLines: 0,
          addedLinesContent: [
            'from docx import Document',
            'source = r"E:\\langchain\\dexin-agent\\原始设计文档.docx"',
            'print(Document(source))',
          ],
          removedLinesContent: [],
        }],
        status: 'completed',
      },
    ], 'E:\\langchain\\dexin-agent');

    expect(summary.readFiles).toEqual([
      { path: 'E:\\langchain\\dexin-agent\\智能体运行平台详细架构设计_v1.0.docx' },
      { path: 'E:\\langchain\\dexin-agent\\原始设计文档.docx' },
    ]);
    expect(summary.changedFiles).toEqual([]);
  });
});
