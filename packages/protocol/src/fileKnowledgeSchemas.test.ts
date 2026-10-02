import { describe, expect, it } from 'vitest';
import {
  documentArtifactRecordSchema,
  fileFingerprintSchema,
  fileFreshnessSchema,
} from './fileKnowledgeSchemas.js';

describe('file knowledge schemas', () => {
  it('validates a complete file fingerprint', () => {
    const parsed = fileFingerprintSchema.parse({
      path: 'E:\\langchain\\Suanlizi\\docs\\a.docx',
      relativePath: 'docs/a.docx',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      sizeBytes: 128,
      mtimeMs: 123456,
      sha256: 'a'.repeat(64),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      observedAt: '2026-07-23T08:00:00.000Z',
    });

    expect(parsed.relativePath).toBe('docs/a.docx');
  });

  it('validates a document artifact record with source lineage', () => {
    const parsed = documentArtifactRecordSchema.parse({
      artifactPath: 'E:\\langchain\\Suanlizi\\.suanlizi\\artifacts\\documents\\abc.md',
      artifactRelativePath: '.suanlizi/artifacts/documents/abc.md',
      artifactHash: 'b'.repeat(64),
      artifactKind: 'document_text',
      sourcePath: 'E:\\langchain\\Suanlizi\\a.docx',
      sourceRelativePath: 'a.docx',
      sourceHash: 'c'.repeat(64),
      sourceSizeBytes: 2048,
      sourceMtimeMs: 123456,
      extractor: 'docx-text',
      extractorVersion: '1',
      createdAt: '2026-07-23T08:00:00.000Z',
    });

    expect(parsed.artifactKind).toBe('document_text');
  });

  it('validates stale freshness decisions', () => {
    const parsed = fileFreshnessSchema.parse({
      status: 'stale',
      sourcePath: 'E:\\langchain\\Suanlizi\\a.docx',
      artifactPath: 'E:\\langchain\\Suanlizi\\.suanlizi\\artifacts\\documents\\abc.md',
      reason: 'source_hash_changed',
      recommendedTool: 'read_document',
    });

    expect(parsed.reason).toBe('source_hash_changed');
  });
});
