import { describe, expect, it } from 'vitest';
import type { McpRuntimeManager } from '@suanlizi/runtime';
import { __gitNexusRouteTest } from './gitnexusRoute.js';

function mcpText(data: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

describe('gitnexus route graph helpers', () => {
  it('keeps display file paths case-preserving when making repo-relative graph nodes', () => {
    const result = __gitNexusRouteTest.relativePath(
      'E:/repo',
      'E:/repo/backend/src/main/java/com/acme/AiModelConfig.java',
    );

    expect(result).toBe('backend/src/main/java/com/acme/AiModelConfig.java');
  });

  it('builds a file context subgraph from cypher markdown rows', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcpManager = {
      async callTool(_serverId: string, tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args });
        return mcpText({
          markdown: [
            '| sourceLabel | source | sourceFile | sourceId | relType | targetLabel | target | targetFile | targetId | sourceLine | targetLine |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            '| File | AiModelConfig.java | backend/src/main/java/com/acme/aimodelconfig.java | File:aimodelconfig | DEFINES | Class | AiModelConfig | backend/src/main/java/com/acme/aimodelconfig.java | Class:aimodelconfig:AiModelConfig |  | 12 |',
            '| Method | loginHandler | backend/src/main/java/com/acme/Caller.java | Method:caller:loginHandler | CALLS | Method | configure | backend/src/main/java/com/acme/aimodelconfig.java | Method:aimodelconfig:configure | 44 | 18 |',
            '| Method | configure | backend/src/main/java/com/acme/aimodelconfig.java | Method:aimodelconfig:configure | CALLS | Method | hashPassword | backend/src/main/java/com/acme/UserService.java | Method:userservice:hashPassword | 18 | 9 |',
          ].join('\n'),
        });
      },
    } as unknown as McpRuntimeManager;

    const graph = await __gitNexusRouteTest.buildFileContextGraph(
      mcpManager,
      'gitnexus',
      'E:/repo',
      'backend/src/main/java/com/acme/aimodelconfig.java',
    );

    expect(calls[0].tool).toBe('cypher');
    expect(String(calls[0].args.query)).toContain('toLower');
    expect(graph.nodes.map((node) => node.label)).toEqual([
      'aimodelconfig.java',
      'AiModelConfig',
      'loginHandler',
      'configure',
      'hashPassword',
    ]);
    expect(graph.edges.map((edge) => `${edge.source}->${edge.target}:${edge.label}`)).toEqual([
      'file:backend/src/main/java/com/acme/aimodelconfig.java->Class:aimodelconfig:AiModelConfig:DEFINES',
      'Method:caller:loginHandler->Method:aimodelconfig:configure:CALLS',
      'Method:aimodelconfig:configure->Method:userservice:hashPassword:CALLS',
    ]);
    expect(graph.processes).toEqual([
      { name: 'AiModelConfig', file: 'backend/src/main/java/com/acme/aimodelconfig.java', kind: 'Class', line: 12 },
      { name: 'configure', file: 'backend/src/main/java/com/acme/aimodelconfig.java', kind: 'Method', line: 18 },
    ]);
    expect(graph.callers).toEqual([
      { name: 'loginHandler', file: 'backend/src/main/java/com/acme/Caller.java', kind: 'Method', line: 44 },
    ]);
    expect(graph.callees).toEqual([
      { name: 'hashPassword', file: 'backend/src/main/java/com/acme/UserService.java', kind: 'Method', line: 9 },
    ]);
  });

  it('handles cypher label arrays when detecting file root and symbol groups', async () => {
    const mcpManager = {
      async callTool() {
        return mcpText({
          rows: [
            {
              sourceLabel: ['File'],
              source: 'AiModelConfig.java',
              sourceFile: 'E:/repo/backend/src/main/java/com/acme/AiModelConfig.java',
              sourceId: 'File:aimodelconfig',
              sourceLine: '',
              relType: 'DEFINES',
              targetLabel: ['Class'],
              target: 'AiModelConfig',
              targetFile: 'E:/repo/backend/src/main/java/com/acme/AiModelConfig.java',
              targetId: 'Class:aimodelconfig:AiModelConfig',
              targetLine: 12,
            },
            {
              sourceLabel: ['Method'],
              source: 'loginHandler',
              sourceFile: 'E:/repo/backend/src/main/java/com/acme/Caller.java',
              sourceId: 'Method:caller:loginHandler',
              sourceLine: 44,
              relType: 'CALLS',
              targetLabel: ['Method'],
              target: 'configure',
              targetFile: 'E:/repo/backend/src/main/java/com/acme/AiModelConfig.java',
              targetId: 'Method:aimodelconfig:configure',
              targetLine: 18,
            },
          ],
        });
      },
    } as unknown as McpRuntimeManager;

    const graph = await __gitNexusRouteTest.buildFileContextGraph(
      mcpManager,
      'gitnexus',
      'E:/repo',
      'backend/src/main/java/com/acme/AiModelConfig.java',
    );

    expect(graph.nodes.find((node) => node.id === 'file:backend/src/main/java/com/acme/AiModelConfig.java')).toMatchObject({
      label: 'AiModelConfig.java',
      group: 'center',
      kind: 'File',
    });
    expect(graph.processes.map((item) => item.name)).toEqual(['AiModelConfig', 'configure']);
    expect(graph.callers.map((item) => item.name)).toEqual(['loginHandler']);
  });
});
