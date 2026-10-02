import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { handleWorkspaceFilesRoute } from './workspaceFiles.js';

function req(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), { method, url }) as IncomingMessage;
}

function res(): ServerResponse & { status?: number; body?: unknown } {
  const output = {
    writeHead(status: number) {
      output.status = status;
      return output;
    },
    end(raw: string) {
      output.body = raw ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return output;
}

async function route(url: string) {
  const response = res();
  const parsed = new URL(url, 'http://localhost');
  const handled = await handleWorkspaceFilesRoute({ req: req('GET', url), res: response, url: parsed });
  return { handled, response };
}

async function fetchFromRoute(url: string): Promise<Response> {
  const server = createServer((request, response) => {
    const parsed = new URL(request.url ?? '/', 'http://localhost');
    handleWorkspaceFilesRoute({ req: request, res: response, url: parsed }).catch((error) => {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start test server');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${url}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('workspace files route', () => {
  it('lists workspace entries and previews text files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'suanlizi-files-'));
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'README.md'), '# Suanlizi\n');
    await writeFile(path.join(root, 'src', 'index.ts'), 'export const ok = true;\n');

    const listed = await route(`/api/workspaces/files?root=${encodeURIComponent(root)}`);
    expect(listed.handled).toBe(true);
    expect(listed.response.status).toBe(200);
    expect(listed.response.body).toMatchObject({
      entries: [
        { name: 'src', kind: 'directory' },
        { name: 'README.md', kind: 'file' },
      ],
    });

    const preview = await route(`/api/workspaces/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent('src/index.ts')}`);
    expect(preview.response.status).toBe(200);
    expect(preview.response.body).toMatchObject({ name: 'index.ts', text: 'export const ok = true;\n', binary: false });
  });

  it('accepts an explicit workspace root that matches the API process cwd', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'suanlizi-files-cwd-'));
    await writeFile(path.join(root, 'package.json'), '{"name":"cwd-root"}\n');
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const listed = await route(`/api/workspaces/files?root=${encodeURIComponent(root)}&query=package.json`);
      expect(listed.handled).toBe(true);
      expect(listed.response.status).toBe(200);
      expect(listed.response.body).toMatchObject({
        entries: [{ name: 'package.json', path: 'package.json', kind: 'file' }],
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('rejects paths outside the workspace root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'suanlizi-files-'));
    const result = await route(`/api/workspaces/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent('../')}`);
    expect(result.response.status).toBe(400);
    expect(result.response.body).toMatchObject({ error: 'Path escapes workspace root' });
  });

  it('searches recursively by file extension', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'suanlizi-files-'));
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'manual.PDF'), '%PDF-1.4\n');
    await writeFile(path.join(root, 'notes.md'), '# Notes\n');

    const result = await route(`/api/workspaces/files?root=${encodeURIComponent(root)}&query=pdf`);
    expect(result.response.status).toBe(200);
    expect(result.response.body).toMatchObject({
      entries: [
        {
          name: 'manual.PDF',
          path: 'docs/manual.PDF',
          kind: 'file',
          extension: 'pdf',
        },
      ],
      entriesByPath: {
        '': [{ name: 'docs', path: 'docs', kind: 'directory' }],
        docs: [{ name: 'manual.PDF', path: 'docs/manual.PDF', kind: 'file', extension: 'pdf' }],
      },
      expandedPaths: ['', 'docs'],
    });
  });

  it('skips virtualenv folders while searching', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'suanlizi-files-'));
    await mkdir(path.join(root, '.venv', 'bin'), { recursive: true });
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, '.venv', 'bin', 'python.pdf'), '%PDF-1.4\n');
    await writeFile(path.join(root, 'docs', 'report.pdf'), '%PDF-1.4\n');

    const result = await route(`/api/workspaces/files?root=${encodeURIComponent(root)}&query=pdf`);
    expect(result.response.status).toBe(200);
    expect(result.response.body).toMatchObject({
      entries: [{ name: 'report.pdf', path: 'docs/report.pdf', kind: 'file', extension: 'pdf' }],
    });
  });

  it('searches document type aliases such as word', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'suanlizi-files-'));
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'meeting-notes.docx'), 'placeholder');

    const result = await route(`/api/workspaces/files?root=${encodeURIComponent(root)}&query=word`);
    expect(result.response.status).toBe(200);
    expect(result.response.body).toMatchObject({
      entries: [{ name: 'meeting-notes.docx', path: 'docs/meeting-notes.docx', kind: 'file', extension: 'docx' }],
      expandedPaths: ['', 'docs'],
    });
  });

  it('classifies markdown, html, image, pdf, and spreadsheet previews', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'suanlizi-files-'));
    await writeFile(path.join(root, 'notes.md'), '# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n');
    await writeFile(path.join(root, 'page.html'), '<h1>Hello</h1><p>World</p>');
    await writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(path.join(root, 'paper.pdf'), '%PDF-1.4\n');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name', 'Score'], ['Suanlizi', 42]]), 'Sheet1');
    XLSX.writeFile(workbook, path.join(root, 'scores.xlsx'));

    const markdown = await route(`/api/workspaces/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent('notes.md')}`);
    expect(markdown.response.body).toMatchObject({
      name: 'notes.md',
      previewType: 'markdown',
      mimeType: 'text/markdown; charset=utf-8',
      text: expect.stringContaining('| A | B |'),
      binary: false,
    });

    const html = await route(`/api/workspaces/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent('page.html')}`);
    expect(html.response.body).toMatchObject({
      name: 'page.html',
      previewType: 'html',
      mimeType: 'text/html; charset=utf-8',
      text: expect.stringContaining('<h1>Hello</h1>'),
      binary: false,
    });

    const image = await route(`/api/workspaces/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent('image.png')}`);
    expect(image.response.body).toMatchObject({
      name: 'image.png',
      previewType: 'image',
      mimeType: 'image/png',
      binary: true,
      rawUrl: expect.stringContaining('/api/workspaces/raw?'),
    });

    const pdf = await route(`/api/workspaces/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent('paper.pdf')}`);
    expect(pdf.response.body).toMatchObject({
      name: 'paper.pdf',
      previewType: 'pdf',
      mimeType: 'application/pdf',
      binary: true,
      rawUrl: expect.stringContaining('/api/workspaces/raw?'),
    });

    const sheet = await route(`/api/workspaces/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent('scores.xlsx')}`);
    expect(sheet.response.body).toMatchObject({
      name: 'scores.xlsx',
      previewType: 'office',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      text: expect.stringContaining('Suanlizi,42'),
      binary: false,
    });
  });

  it('serves raw files with unicode filenames', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'suanlizi-files-'));
    await writeFile(path.join(root, '中国货币政策执行报告63页.pdf'), '%PDF-1.4\n');

    const response = await fetchFromRoute(`/api/workspaces/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent('中国货币政策执行报告63页.pdf')}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(await response.text()).toBe('%PDF-1.4\n');
  });
});
