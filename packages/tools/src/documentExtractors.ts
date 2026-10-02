import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import type { DocumentExtractor } from '@suanlizi/protocol';

export const DOCUMENT_EXTRACTOR_VERSION = '1';

export interface ExtractedDocumentText {
  extractor: DocumentExtractor;
  text: string;
}

export function extractorForDocumentPath(filePath: string): DocumentExtractor {
  switch (path.extname(filePath).toLowerCase()) {
    case '.docx':
      return 'docx-text';
    case '.pdf':
      return 'pdf-text';
    case '.xlsx':
      return 'xlsx-text';
    case '.pptx':
      return 'pptx-text';
    default:
      throw Object.assign(new Error(`Unsupported document type: ${path.extname(filePath)}`), {
        code: 'UNSUPPORTED_DOCUMENT_TYPE',
      });
  }
}

export async function extractDocumentText(filePath: string): Promise<ExtractedDocumentText> {
  const extractor = extractorForDocumentPath(filePath);
  if (extractor === 'docx-text') {
    const result = await mammoth.extractRawText({ path: filePath });
    return { extractor, text: result.value.trim() };
  }
  if (extractor === 'pdf-text') {
    const parser = new PDFParse({ data: new Uint8Array(await fs.readFile(filePath)) });
    try {
      const parsed = await parser.getText();
      return { extractor, text: parsed.text.trim() };
    } finally {
      await parser.destroy();
    }
  }
  if (extractor === 'xlsx-text') {
    const workbook = XLSX.readFile(filePath);
    const text = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      return `## ${sheetName}\n${csv.trim()}`;
    }).join('\n\n').trim();
    return { extractor, text };
  }
  return { extractor, text: await extractPptxText(filePath) };
}

async function extractPptxText(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const slides: string[] = [];
  for (const name of slideNames) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXmlText(match[1] ?? ''))
      .filter(Boolean)
      .join('\n');
    if (text.trim()) slides.push(`## ${path.basename(name, '.xml')}\n${text.trim()}`);
  }
  return slides.join('\n\n').trim();
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
