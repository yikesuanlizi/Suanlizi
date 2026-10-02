import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { computeFileFingerprint } from './fileKnowledge.js';
import {
  assessArtifactFreshness,
  documentArtifactPathForSource,
  findArtifactByPath,
  loadDocumentArtifactLedger,
  registerExternalDocumentArtifactsFromText,
  saveDocumentArtifactRecord,
} from './documentArtifacts.js';

describe('document artifact ledger', () => {
  it('persists a source to artifact lineage record', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-artifacts-'));
    const sourcePath = path.join(root, 'a.docx');
    await fs.writeFile(sourcePath, 'source bytes');
    const source = await computeFileFingerprint(root, sourcePath);
    const artifactPath = await documentArtifactPathForSource(root, source, 'docx-text', '1');
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, 'artifact text', 'utf-8');
    const artifactHash = createHash('sha256').update('artifact text').digest('hex');

    await saveDocumentArtifactRecord(root, {
      artifactPath,
      artifactRelativePath: '.suanlizi/artifacts/documents/' + path.basename(artifactPath),
      artifactHash,
      artifactKind: 'document_text',
      sourcePath,
      sourceRelativePath: 'a.docx',
      sourceHash: source.sha256,
      sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs,
      extractor: 'docx-text',
      extractorVersion: '1',
      createdAt: '2026-07-23T08:00:00.000Z',
    });

    const ledger = await loadDocumentArtifactLedger(root);
    expect(ledger.records).toHaveLength(1);
    expect(findArtifactByPath(ledger, artifactPath)?.sourcePath).toBe(sourcePath);
  });

  it('reports stale when source hash changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-artifacts-stale-'));
    const sourcePath = path.join(root, 'a.docx');
    await fs.writeFile(sourcePath, 'v1');
    const source = await computeFileFingerprint(root, sourcePath);
    const artifactPath = await documentArtifactPathForSource(root, source, 'docx-text', '1');
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, 'artifact v1', 'utf-8');
    await saveDocumentArtifactRecord(root, {
      artifactPath,
      artifactRelativePath: '.suanlizi/artifacts/documents/' + path.basename(artifactPath),
      artifactHash: createHash('sha256').update('artifact v1').digest('hex'),
      artifactKind: 'document_text',
      sourcePath,
      sourceRelativePath: 'a.docx',
      sourceHash: source.sha256,
      sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs,
      extractor: 'docx-text',
      extractorVersion: '1',
      createdAt: '2026-07-23T08:00:00.000Z',
    });

    await fs.writeFile(sourcePath, 'v2', 'utf-8');
    const record = findArtifactByPath(await loadDocumentArtifactLedger(root), artifactPath);
    const freshness = await assessArtifactFreshness(root, record!);

    expect(freshness).toMatchObject({
      status: 'stale',
      sourcePath,
      artifactPath,
      reason: 'source_hash_changed',
      recommendedTool: 'read_document',
    });
  });

  it('registers external script text artifacts with source document lineage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-external-artifact-'));
    const sourcePath = path.join(root, 'brief.docx');
    const artifactPath = path.join(root, '_brief_decoded.txt');
    await fs.writeFile(sourcePath, 'source v1', 'utf-8');
    await fs.writeFile(artifactPath, 'decoded v1', 'utf-8');

    const registered = await registerExternalDocumentArtifactsFromText(
      root,
      `python parse_docx.py ${sourcePath}\nwrote ${artifactPath}`,
    );

    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      sourcePath,
      artifactPath,
      artifactKind: 'document_text',
      extractor: 'docx-text',
      extractorVersion: 'external-script',
    });
    expect(findArtifactByPath(await loadDocumentArtifactLedger(root), artifactPath)?.sourcePath).toBe(sourcePath);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(sourcePath, 'source v2', 'utf-8');
    const freshness = await assessArtifactFreshness(
      root,
      findArtifactByPath(await loadDocumentArtifactLedger(root), artifactPath)!,
    );

    expect(freshness).toMatchObject({
      status: 'stale',
      sourcePath,
      artifactPath,
      reason: 'source_hash_changed',
    });
  });
});
