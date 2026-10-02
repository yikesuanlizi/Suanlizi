import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildFreshnessPreflightNotice, collectMentionedDocumentPaths } from './fileFreshnessPreflight.js';

describe('file freshness preflight', () => {
  it('extracts explicitly mentioned document paths from Chinese user input', () => {
    expect(collectMentionedDocumentPaths('重新分析 E:\\langchain\\dexin-agent\\_v1.0.docx 和 ./方案.pdf')).toEqual([
      'E:\\langchain\\dexin-agent\\_v1.0.docx',
      './方案.pdf',
    ]);
  });

  it('warns when a managed artifact source changed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-preflight-'));
    const notice = await buildFreshnessPreflightNotice({
      workspaceRoot: root,
      locale: 'zh',
      userText: '继续分析 a.docx',
      recentItems: [],
      staleArtifacts: [{
        artifactPath: path.join(root, '.suanlizi', 'artifacts', 'documents', 'a.md'),
        sourcePath: path.join(root, 'a.docx'),
        reason: 'source_hash_changed',
      }],
    });

    expect(notice?.content).toContain('旧提取内容已经过期');
    expect(notice?.content).toContain('read_document');
  });

  it('requires read_document for follow-up questions about a recently read document even when not stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-preflight-followup-'));
    const notice = await buildFreshnessPreflightNotice({
      workspaceRoot: root,
      locale: 'zh',
      userText: '现在呢，看看适合开发了吗？',
      recentItems: [{
        id: 'read-doc',
        type: 'tool_call',
        turnId: 'turn-1',
        toolName: 'read_document',
        arguments: { filePath: '智能体运行平台详细架构设计_v1.0.docx' },
        status: 'completed',
        result: {
          source: { path: path.join(root, '智能体运行平台详细架构设计_v1.0.docx') },
        },
      }],
    });

    expect(notice?.content).toContain('当前问题像是在继续讨论之前的文档');
    expect(notice?.content).toContain('read_document');
    expect(notice?.content).toContain('智能体运行平台详细架构设计_v1.0.docx');
  });

  it('requires read_document for follow-up questions when old command output mentioned a document', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-preflight-command-'));
    const notice = await buildFreshnessPreflightNotice({
      workspaceRoot: root,
      locale: 'zh',
      userText: 'v1.0 现在适合开发了吗？',
      recentItems: [{
        id: 'cmd-doc',
        type: 'command_execution',
        turnId: 'turn-1',
        command: 'python _read_docx.py',
        aggregatedOutput: `reading ${path.join(root, '智能体运行平台详细架构设计_v1.0.docx')}`,
        exitCode: 0,
        status: 'completed',
      }],
    });

    expect(notice?.content).toContain('read_document');
    expect(notice?.content).toContain('智能体运行平台详细架构设计_v1.0.docx');
  });

  it('uses command-derived text artifact lineage to route follow-up questions back to the source document', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-preflight-derived-'));
    const sourcePath = path.join(root, 'brief.docx');
    const artifactPath = path.join(root, '_brief_decoded.txt');
    await fs.writeFile(sourcePath, 'source v1', 'utf-8');
    await fs.writeFile(artifactPath, 'decoded v1', 'utf-8');
    const notice = await buildFreshnessPreflightNotice({
      workspaceRoot: root,
      locale: 'zh',
      userText: '继续看刚才提取的内容是否适合开发',
      recentItems: [{
        id: 'cmd-derived',
        type: 'command_execution',
        turnId: 'turn-1',
        command: `python parse_docx.py "${sourcePath}" > "${artifactPath}"`,
        aggregatedOutput: `wrote ${artifactPath}`,
        exitCode: 0,
        status: 'completed',
      }],
    });

    expect(notice?.content).toContain('read_document');
    expect(notice?.content).toContain('brief.docx');
    expect(notice?.content).not.toContain('_brief_decoded.txt');
  });

  it('warns that command-derived text artifacts are stale when the source document changed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-preflight-derived-stale-'));
    const sourcePath = path.join(root, 'brief.docx');
    const artifactPath = path.join(root, '_brief_decoded.txt');
    await fs.writeFile(sourcePath, 'source v1', 'utf-8');
    await fs.writeFile(artifactPath, 'decoded v1', 'utf-8');
    const recentItems = [{
      id: 'cmd-derived',
      type: 'command_execution' as const,
      turnId: 'turn-1',
      command: `python parse_docx.py "${sourcePath}" > "${artifactPath}"`,
      aggregatedOutput: `wrote ${artifactPath}`,
      exitCode: 0,
      status: 'completed' as const,
    }];
    await buildFreshnessPreflightNotice({
      workspaceRoot: root,
      locale: 'zh',
      userText: '继续看刚才提取的内容',
      recentItems,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(sourcePath, 'source v2', 'utf-8');
    const notice = await buildFreshnessPreflightNotice({
      workspaceRoot: root,
      locale: 'zh',
      userText: '继续看刚才提取的内容',
      recentItems,
    });

    expect(notice?.content).toContain('旧提取内容已经过期');
    expect(notice?.content).toContain('brief.docx');
    expect(notice?.content).toContain('_brief_decoded.txt');
    expect(notice?.content).toContain('source_hash_changed');
  });
});
