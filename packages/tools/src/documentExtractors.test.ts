import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { extractDocumentText, extractorForDocumentPath } from './documentExtractors.js';

describe('document extractors', () => {
  it('extracts text from a minimal docx', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-docx-'));
    const filePath = path.join(root, 'sample.docx');
    await writeMinimalDocx(filePath, '第一章 生命周期检测');

    const result = await extractDocumentText(filePath);

    expect(result.extractor).toBe('docx-text');
    expect(result.text).toContain('第一章 生命周期检测');
  });

  it('extracts rows from an xlsx workbook', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-xlsx-'));
    const filePath = path.join(root, 'table.xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['名称', '状态'], ['方案B', '通过']]), 'Sheet1');
    XLSX.writeFile(workbook, filePath);

    const result = await extractDocumentText(filePath);

    expect(result.extractor).toBe('xlsx-text');
    expect(result.text).toContain('名称');
    expect(result.text).toContain('方案B');
  });

  it('selects expected extractors by extension', () => {
    expect(extractorForDocumentPath('a.docx')).toBe('docx-text');
    expect(extractorForDocumentPath('a.pdf')).toBe('pdf-text');
    expect(extractorForDocumentPath('a.xlsx')).toBe('xlsx-text');
    expect(extractorForDocumentPath('a.pptx')).toBe('pptx-text');
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
