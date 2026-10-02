import { afterEach, describe, expect, it } from 'vitest';
import { prepareMcpDraftRequest } from './mcpDraft.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MCP draft source preparation', () => {
  it('reads a GitHub README and extracts a runnable MCP command', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return new Response([
        '# Filesystem MCP Server',
        '',
        'Run it with:',
        '',
        '```bash',
        'npx -y @modelcontextprotocol/server-filesystem E:/langchain/Suanlizi',
        '```',
      ].join('\n'));
    };

    const prepared = await prepareMcpDraftRequest('https://github.com/modelcontextprotocol/server-filesystem');

    expect(requestedUrls[0]).toContain('raw.githubusercontent.com/modelcontextprotocol/server-filesystem');
    expect(prepared.draft).toMatchObject({
      name: 'filesystem',
      command: 'npx',
      args: '-y @modelcontextprotocol/server-filesystem E:/langchain/Suanlizi',
      enabled: true,
      sourceKind: 'url',
      sourceUrl: 'https://github.com/modelcontextprotocol/server-filesystem',
    });
    expect(prepared.sourceContent).toContain('Filesystem MCP Server');
  });

  it('keeps URL drafts disabled when no launch command is found', async () => {
    globalThis.fetch = async () => new Response('# MCP Notes\n\nThis page describes the protocol.');

    const prepared = await prepareMcpDraftRequest('请添加 https://example.com/mcp-notes');

    expect(prepared.draft).toMatchObject({
      name: 'notes',
      command: '',
      args: '',
      enabled: false,
      sourceKind: 'url',
      sourceUrl: 'https://example.com/mcp-notes',
    });
    expect(prepared.sourceError).toBeUndefined();
  });
});
