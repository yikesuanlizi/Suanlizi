import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import {
  BUILTIN_TOOLS,
  applyPatchTool,
  currentTimeTool,
  listFilesTool,
  readDocumentTool,
  readFileTool,
  requestUserDecisionTool,
  searchContentTool,
  shellCommandTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
} from './builtin.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function installFakeNpx(binDir: string): Promise<void> {
  const spyScript = path.join(binDir, 'npx-spy.cjs');
  await fs.writeFile(
    spyScript,
    [
      "const fs = require('node:fs');",
      "const logPath = process.env.SUANLIZI_FAKE_NPX_LOG;",
      "if (!logPath) throw new Error('missing SUANLIZI_FAKE_NPX_LOG');",
      "fs.writeFileSync(logPath, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));",
      "console.log('indexed ok');",
    ].join('\n'),
    'utf-8',
  );
  if (process.platform === 'win32') {
    await fs.writeFile(
      path.join(binDir, 'npx.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0\\npx-spy.cjs" %*\r\n`,
      'utf-8',
    );
    return;
  }
  const shimPath = path.join(binDir, 'npx');
  await fs.writeFile(
    shimPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/npx-spy.cjs" "$@"\n`,
    'utf-8',
  );
  await fs.chmod(shimPath, 0o755);
}

describe('builtin tool parallel safety', () => {
  it('opts readonly inspection tools into parallel execution and keeps mutating tools serial', () => {
    expect(currentTimeTool.supportsParallelToolCalls).toBe(true);
    expect(readFileTool.supportsParallelToolCalls).toBe(true);
    expect(listFilesTool.supportsParallelToolCalls).toBe(true);
    expect(searchContentTool.supportsParallelToolCalls).toBe(true);
    expect(webSearchTool.supportsParallelToolCalls).toBe(true);
    expect(webFetchTool.supportsParallelToolCalls).toBe(true);
    expect(requestUserDecisionTool.requiredPolicy).toBe('readonly');
    expect(requestUserDecisionTool.supportsParallelToolCalls).not.toBe(true);

    expect(writeFileTool.supportsParallelToolCalls).not.toBe(true);
    expect(shellCommandTool.supportsParallelToolCalls).not.toBe(true);
    expect(applyPatchTool.supportsParallelToolCalls).not.toBe(true);
  });
});

describe('requestUserDecisionTool', () => {
  it('waits through the runtime-owned callback and rejects out-of-contract fields', async () => {
    const requestUserDecision = vi.fn(async () => ({ requestId: 'decision-1', action: 'way_one' as const, optionId: 'one' }));
    const result = await requestUserDecisionTool.execute({
      prompt: '选择方案',
      options: [{ id: 'one', action: 'way_one', label: '方案一' }],
      allowCustomInput: false,
    }, { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false, requestUserDecision });
    expect(requestUserDecision).toHaveBeenCalledWith({
      prompt: '选择方案',
      options: [{ id: 'one', action: 'way_one', label: '方案一' }],
      allowCustomInput: false,
    });
    expect(result.status).toBe('completed');
    expect(result.data).toMatchObject({ action: 'way_one', optionId: 'one' });

    const rejected = await requestUserDecisionTool.execute({
      prompt: '选择方案',
      options: [{ id: 'one', action: 'way_one', label: '方案一' }],
      allowCustomInput: false,
      threadId: 'forbidden',
    }, { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false, requestUserDecision });
    expect(rejected.error?.code).toBe('INVALID_ARGUMENTS');
    expect(requestUserDecision).toHaveBeenCalledTimes(1);
  });
});

describe('webSearchTool', () => {
  it('formats web search results from DuckDuckGo html', async () => {
    globalThis.fetch = async () =>
      new Response(`
        <div class="result">
          <a rel="nofollow" class="result__a" href="https://example.com/page?x=1&amp;y=2">Example &amp; Result</a>
          <a class="result__snippet">A useful <b>snippet</b> about the result.</a>
        </div>
      `);

    const result = await webSearchTool.execute(
      { query: 'Suanlizi', maxResults: 1 },
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Web search results for "Suanlizi"');
    expect(result.output).toContain('Example & Result');
    expect(result.output).toContain('https://example.com/page?x=1&y=2');
    expect(result.output).toContain('A useful snippet about the result.');
  });

  it('falls back to Bing when the first search source fails', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('first source timeout');
      return new Response(`
        <li class="b_algo">
          <h2><a href="https://bing.example/result">Bing Result</a></h2>
          <p>Bing&nbsp;snippet with <strong>details</strong>&ensp;.</p>
        </li>
      `);
    };

    const result = await webSearchTool.execute(
      { query: 'fallback search', maxResults: 1 },
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Bing Result');
    expect(result.output).toContain('https://bing.example/result');
    expect(result.output).toContain('Bing snippet with details.');
  });

  it('fails clearly when query is empty', async () => {
    const result = await webSearchTool.execute(
      { action: 'search', query: '   ' },
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('query or queries is required for action="search"');
  });

  it('opens a page through the Codex-style web_search action', async () => {
    globalThis.fetch = async () =>
      new Response(`
        <html>
          <head><title>React Bits</title></head>
          <body><h1>Animations</h1><p>Text animations include DecryptText.</p></body>
        </html>
      `, { headers: { 'content-type': 'text/html' } });

    const result = await webSearchTool.execute(
      { action: 'open_page', url: 'https://example.com/react-bits' },
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Opened page: https://example.com/react-bits');
    expect(result.output).toContain('Title: React Bits');
    expect(result.output).toContain('Text animations include DecryptText.');
  });

  it('uses Firecrawl when the tool context selects the enhanced provider', async () => {
    globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.firecrawl.dev/v1/scrape');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer stored-firecrawl-key');
      return Response.json({
        success: true,
        data: {
          markdown: '# Firecrawl Page\nEnhanced content.',
          metadata: { title: 'Firecrawl Page' },
        },
      });
    };

    const result = await webSearchTool.execute(
      { action: 'open_page', url: 'https://example.com/enhanced' },
      {
        workspaceRoot: process.cwd(),
        threadId: 'thread',
        turnId: 'turn',
        approved: false,
        webProvider: { provider: 'firecrawl', firecrawl: { apiKey: 'stored-firecrawl-key' } },
      },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Provider: firecrawl');
    expect(result.output).toContain('Enhanced content.');
  });

  it('finds text in a page through the Codex-style web_search action', async () => {
    globalThis.fetch = async () =>
      new Response(`
        <html><body><p>BlurText adds blur transitions.</p><p>DecryptText reveals letters.</p></body></html>
      `, { headers: { 'content-type': 'text/html' } });

    const result = await webSearchTool.execute(
      { action: 'find_in_page', url: 'https://example.com/react-bits', pattern: 'DecryptText' },
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Find in page: "DecryptText"');
    expect(result.output).toContain('DecryptText reveals letters.');
  });
});

describe('webFetchTool', () => {
  it('fetches a URL and extracts readable HTML text', async () => {
    globalThis.fetch = async () =>
      new Response(`
        <html>
          <head><title>React Bits &amp; Animations</title><style>.hidden{}</style></head>
          <body>
            <script>window.noise = true</script>
            <main>
              <h1>Text Animations</h1>
              <p>Includes <strong>DecryptText</strong> and FuzzyText.</p>
            </main>
          </body>
        </html>
      `, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    const result = await webFetchTool.execute(
      { url: 'https://example.com/react-bits' },
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Opened page: https://example.com/react-bits');
    expect(result.output).toContain('Title: React Bits & Animations');
    expect(result.output).toContain('Text Animations');
    expect(result.output).toContain('Includes DecryptText and FuzzyText.');
    expect(result.output).not.toContain('window.noise');
  });

  it('rejects non-http URLs', async () => {
    const result = await webFetchTool.execute(
      { url: 'file:///secret.txt' },
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INVALID_ARGUMENTS');
  });
});

describe('readFileTool', () => {
  it('asks runtime access policy before reading a file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-read-file-access-'));
    await fs.writeFile(path.join(root, 'note.txt'), 'hello\n', 'utf-8');
    const requestAccess = vi.fn(async (request) => ({
      decision: 'deny' as const,
      request,
      source: 'persistent_rule' as const,
      justification: 'blocked by policy',
      matchedRuleId: 'deny-note',
      matchedRuleScope: 'global' as const,
    }));

    const result = await readFileTool.execute(
      { filePath: 'note.txt' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false, requestAccess },
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ACCESS_DENIED');
    expect(requestAccess).toHaveBeenCalledWith(expect.objectContaining({
      access: 'read',
      target: { kind: 'path', path: path.join(root, 'note.txt') },
      toolName: 'read_file',
    }));
  });

  it('returns line metadata and file segment artifact refs for large files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-read-file-'));
    await fs.writeFile(
      path.join(root, 'large.txt'),
      Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n'),
      'utf-8',
    );

    const result = await readFileTool.execute(
      { filePath: 'large.txt', offset: 10, limit: 5 },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('10: line 10');
    expect(result.output).not.toContain('16: line 16');
    expect(result.data).toMatchObject({
      path: expect.stringContaining('large.txt'),
      startLine: 10,
      endLine: 14,
      totalLines: 80,
      artifactRefs: [
        expect.objectContaining({
          kind: 'file_segment',
          path: expect.stringContaining('large.txt'),
          startLine: 10,
          endLine: 14,
          sha256: expect.any(String),
        }),
      ],
    });
  });

  it('falls back to GB18030 when reading non-UTF-8 Chinese text files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-read-file-gbk-'));
    await fs.writeFile(
      path.join(root, 'gbk.txt'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]),
    );

    const result = await readFileTool.execute(
      { filePath: 'gbk.txt' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('1: 中文测试');
    expect(result.output).not.toContain('�');
    expect(result.data).toMatchObject({ encoding: 'gb18030' });
  });

  it('returns a full file fingerprint with read_file results', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-read-file-fingerprint-'));
    await fs.writeFile(path.join(root, 'note.txt'), 'hello\n', 'utf-8');

    const result = await readFileTool.execute(
      { filePath: 'note.txt' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.data).toMatchObject({
      file: {
        path: path.join(root, 'note.txt'),
        relativePath: 'note.txt',
        sha256: expect.any(String),
        contentType: 'text/plain',
        sizeBytes: 6,
      },
      freshness: { status: 'fresh' },
    });
  });

  it('fails closed when reading a stale managed document artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-stale-artifact-'));
    const sourcePath = path.join(root, 'source.docx');
    await writeMinimalDocx(sourcePath, '源文件版本一');
    const extracted = await readDocumentTool.execute(
      { filePath: 'source.docx' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );
    const artifactPath = (extracted.data as { artifact: { path: string } }).artifact.path;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeMinimalDocx(sourcePath, '源文件版本二');
    const staleRead = await readFileTool.execute(
      { filePath: artifactPath },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(staleRead.status).toBe('failed');
    expect(staleRead.error?.code).toBe('STALE_DOCUMENT_ARTIFACT');
    expect(staleRead.data).toMatchObject({
      freshness: {
        status: 'stale',
        sourcePath,
        artifactPath,
        reason: 'source_hash_changed',
        recommendedTool: 'read_document',
      },
    });
  });
});

describe('readDocumentTool', () => {
  it('asks runtime access policy before extracting a document', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-read-document-access-'));
    const docxPath = path.join(root, 'brief.docx');
    await writeMinimalDocx(docxPath, '版本一 内容');
    const requestAccess = vi.fn(async (request) => ({
      decision: 'prompt' as const,
      request,
      source: 'approval_required' as const,
      justification: 'needs temporary approval',
    }));

    const result = await readDocumentTool.execute(
      { filePath: 'brief.docx' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false, requestAccess },
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ACCESS_APPROVAL_REQUIRED');
    expect(requestAccess).toHaveBeenCalledWith(expect.objectContaining({
      access: 'read',
      target: { kind: 'path', path: docxPath },
      toolName: 'read_document',
    }));
  });

  it('extracts docx to a managed artifact and reuses it while fresh', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-read-document-'));
    const docxPath = path.join(root, 'brief.docx');
    await writeMinimalDocx(docxPath, '版本一 内容');

    const first = await readDocumentTool.execute(
      { filePath: 'brief.docx' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );
    const second = await readDocumentTool.execute(
      { filePath: 'brief.docx' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(first.status).toBe('completed');
    expect(first.output).toContain('版本一 内容');
    expect(first.data).toMatchObject({
      stale: false,
      reused: false,
      source: expect.objectContaining({ path: docxPath, sha256: expect.any(String) }),
      artifact: expect.objectContaining({ kind: 'document_text', extractor: 'docx-text' }),
    });
    expect(second.data).toMatchObject({ reused: true, stale: false });
  });

  it('refreshes the artifact after the source document changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-read-document-refresh-'));
    const docxPath = path.join(root, 'brief.docx');
    await writeMinimalDocx(docxPath, '版本一 内容');
    await readDocumentTool.execute(
      { filePath: 'brief.docx' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeMinimalDocx(docxPath, '版本二 新内容');
    const refreshed = await readDocumentTool.execute(
      { filePath: 'brief.docx' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(refreshed.status).toBe('completed');
    expect(refreshed.output).toContain('版本二 新内容');
    expect(refreshed.data).toMatchObject({ reused: false, stale: true });
  });

  it('returns structured failures for missing or unreadable source documents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-read-document-fail-'));

    const missing = await readDocumentTool.execute(
      { filePath: 'missing.docx' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );
    expect(missing).toMatchObject({
      status: 'failed',
      error: { code: 'SOURCE_MISSING' },
    });

    await fs.writeFile(path.join(root, 'broken.docx'), 'not a real docx', 'utf-8');
    const broken = await readDocumentTool.execute(
      { filePath: 'broken.docx' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );
    expect(broken).toMatchObject({
      status: 'failed',
      error: { code: 'EXTRACTION_FAILED' },
      data: {
        source: expect.objectContaining({ path: expect.stringContaining('broken.docx'), sha256: expect.any(String) }),
      },
    });
  });
});

describe('listFilesTool', () => {
  it('lists workspace directories and files with a bounded output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-list-files-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'package.json'), '{}\n', 'utf-8');
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n', 'utf-8');

    const result = await listFilesTool.execute(
      { path: '.', recursive: true, maxEntries: 10 },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Files in .:');
    expect(result.output).toContain('src/');
    expect(result.output).toContain('package.json');
    expect(result.output).toContain(path.join('src', 'index.ts'));
    expect(result.data).toMatchObject({
      recursive: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'src', kind: 'directory' }),
        expect.objectContaining({ path: 'package.json', kind: 'file' }),
      ]),
    });
  });
});

async function writeMinimalDocx(filePath: string, text: string): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join(''));
  zip.folder('_rels')!.file('.rels', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join(''));
  zip.folder('word')!.file('document.xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body><w:p><w:r><w:t>',
    escapeXml(text),
    '</w:t></w:r></w:p></w:body></w:document>',
  ].join(''));
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('searchContentTool', () => {
  it('returns matches with file segment artifact refs instead of only plain text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-search-content-'));
    await fs.writeFile(
      path.join(root, 'src.ts'),
      ['alpha', 'needle one', 'middle', 'needle two', 'omega'].join('\n'),
      'utf-8',
    );

    const result = await searchContentTool.execute(
      { pattern: 'needle', path: '.', contextLines: 1 },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('src.ts:2: needle one');
    expect(result.data).toMatchObject({
      matches: [
        expect.objectContaining({
          line: 2,
          artifactRef: expect.objectContaining({
            kind: 'file_segment',
            startLine: 1,
            endLine: 3,
          }),
        }),
        expect.objectContaining({
          line: 4,
          artifactRef: expect.objectContaining({
            kind: 'file_segment',
            startLine: 3,
            endLine: 5,
          }),
        }),
      ],
    });
  });
});

describe('writeFileTool', () => {
  it('requests access for the canonical external target behind a workspace link', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-write-link-workspace-'));
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-write-link-external-'));
    await fs.symlink(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const requestAccess = vi.fn(async (request) => ({
      decision: 'deny' as const,
      request,
      source: 'approval_required' as const,
      justification: 'External target requires explicit approval',
    }));

    const result = await writeFileTool.execute(
      { filePath: 'linked/blocked.txt', content: 'must not escape the workspace' },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: true, requestAccess },
    );

    expect(result.error?.code).toBe('ACCESS_DENIED');
    const target = requestAccess.mock.calls[0]?.[0]?.target.path as string;
    await expect(fs.realpath(path.dirname(target))).resolves.toBe(await fs.realpath(external));
    await expect(fs.access(path.join(external, 'blocked.txt'))).rejects.toThrow();
  });
});

describe('applyPatchTool', () => {
  it('asks runtime access policy before applying a patch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-apply-patch-access-'));
    await fs.writeFile(path.join(root, 'src.txt'), 'alpha\n', 'utf-8');
    const requestAccess = vi.fn(async (request) => ({
      decision: 'deny' as const,
      request,
      source: 'persistent_rule' as const,
      justification: 'write blocked',
    }));

    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: src.txt',
          '@@',
          '-alpha',
          '+beta',
          '*** End Patch',
        ].join('\n'),
      },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: true, requestAccess },
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ACCESS_DENIED');
    expect(requestAccess).toHaveBeenCalledWith(expect.objectContaining({
      access: 'write',
      target: { kind: 'path', path: path.join(root, 'src.txt') },
      toolName: 'apply_patch',
    }));
    await expect(fs.readFile(path.join(root, 'src.txt'), 'utf-8')).resolves.toBe('alpha\n');
  });

  it('applies Suanlizi multi-hunk update patches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-apply-patch-'));
    await fs.writeFile(
      path.join(root, 'src.txt'),
      ['alpha', 'beta', 'gamma', 'delta'].join('\n'),
      'utf-8',
    );

    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: src.txt',
          '@@',
          ' alpha',
          '-beta',
          '+beta updated',
          ' gamma',
          '@@',
          ' gamma',
          '-delta',
          '+epsilon',
          '*** End Patch',
        ].join('\n'),
      },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: true },
    );

    await expect(fs.readFile(path.join(root, 'src.txt'), 'utf-8')).resolves.toBe(
      ['alpha', 'beta updated', 'gamma', 'epsilon'].join('\n'),
    );
    expect(result.status).toBe('completed');
    expect(result.data).toMatchObject({
      changes: [
        expect.objectContaining({
          path: 'src.txt',
          kind: 'update',
          addedLines: 2,
          removedLines: 2,
        }),
      ],
    });
  });

  it('fails verification instead of silently skipping missing update context', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-apply-patch-missing-'));
    await fs.writeFile(path.join(root, 'src.txt'), 'actual\n', 'utf-8');

    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: src.txt',
          '@@',
          '-missing',
          '+replacement',
          '*** End Patch',
        ].join('\n'),
      },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: true },
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('apply_patch verification failed');
    await expect(fs.readFile(path.join(root, 'src.txt'), 'utf-8')).resolves.toBe('actual\n');
  });

  it('splits a pure rename move into a source delete and a target add change', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-apply-patch-move-'));
    await fs.writeFile(path.join(root, 'a.txt'), 'alpha\nbeta\n', 'utf-8');

    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '*** Move to: b.txt',
          '*** End Patch',
        ].join('\n'),
      },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: true },
    );

    expect(result.status).toBe('completed');
    // 中文注释：rename 必须产出两个 change：源 delete + 目标 add，rollback 才能正确恢复源文件
    expect(result.data).toMatchObject({
      changes: [
        expect.objectContaining({ path: 'a.txt', kind: 'delete', addedLines: 0, removedLines: 2 }),
        expect.objectContaining({ path: 'b.txt', kind: 'add', addedLines: 2, removedLines: 0 }),
      ],
    });
    // 源文件被删除
    await expect(fs.readFile(path.join(root, 'a.txt'), 'utf-8')).rejects.toThrow();
    // 目标文件含原内容
    await expect(fs.readFile(path.join(root, 'b.txt'), 'utf-8')).resolves.toBe('alpha\nbeta\n');
  });

  it('splits a move with content edits into a source delete and a target add change', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-apply-patch-move-edit-'));
    await fs.writeFile(path.join(root, 'a.txt'), ['alpha', 'beta', 'gamma'].join('\n'), 'utf-8');

    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '*** Move to: b.txt',
          '@@',
          ' alpha',
          '-beta',
          '+beta moved',
          ' gamma',
          '*** End Patch',
        ].join('\n'),
      },
      { workspaceRoot: root, threadId: 'thread', turnId: 'turn', approved: true },
    );

    expect(result.status).toBe('completed');
    expect(result.data).toMatchObject({
      changes: [
        expect.objectContaining({ path: 'a.txt', kind: 'delete' }),
        expect.objectContaining({ path: 'b.txt', kind: 'add' }),
      ],
    });
    await expect(fs.readFile(path.join(root, 'a.txt'), 'utf-8')).rejects.toThrow();
    await expect(fs.readFile(path.join(root, 'b.txt'), 'utf-8')).resolves.toBe(
      ['alpha', 'beta moved', 'gamma'].join('\n'),
    );
  });
});

describe('shellCommandTool', () => {
  it('terminates a running command when the turn signal is cancelled', async () => {
    const controller = new AbortController();
    const command = process.platform === 'win32' ? 'ping -n 6 127.0.0.1 > NUL' : 'sleep 5';
    const execution = shellCommandTool.execute(
      { command },
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: true, signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('cancelled in test')), 30).unref?.();

    await expect(execution).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_CANCELLED' },
    });
  });
});
