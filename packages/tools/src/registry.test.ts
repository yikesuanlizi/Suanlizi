import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';

describe('ToolRegistry output truncation', () => {
  it('adds structured truncation metadata when tool output is shortened', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'large_output',
      description: 'test tool',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      maxOutputLength: 10,
      async execute() {
        return {
          status: 'completed',
          output: '0123456789abcdef',
          data: { ok: true },
        };
      },
    });

    const result = await registry.execute(
      'large_output',
      {},
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    );

    expect(result.output).toContain('[truncated 6 chars]');
    expect(result.data).toMatchObject({
      ok: true,
      truncation: {
        originalLength: 16,
        returnedLength: expect.any(Number),
      },
    });
  });

  it('returns OpenAI tool schemas sorted by tool name for stable prompt prefixes', () => {
    const registry = new ToolRegistry();
    for (const name of ['write_file', 'read_file', 'search_content']) {
      registry.register({
        name,
        description: `${name} tool`,
        parameters: { type: 'object' },
        requiredPolicy: 'readonly',
        async execute() {
          return { status: 'completed', output: '' };
        },
      });
    }

    expect(registry.toOpenAITools().map((tool) => tool.function.name)).toEqual([
      'read_file',
      'search_content',
      'write_file',
    ]);
  });

  it('executes hidden tool aliases without exposing aliases to the model', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'list_files',
      description: 'List files',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        return { status: 'completed', output: 'listed' };
      },
    });

    expect(registry.toOpenAITools().map((tool) => tool.function.name)).toEqual(['list_files']);
    expect(registry.get('list_file')?.name).toBe('list_files');
    await expect(registry.execute(
      'list_file',
      {},
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false },
    )).resolves.toMatchObject({
      status: 'completed',
      output: 'listed',
    });
  });

  it('filters OpenAI schemas by include and exclude sets', () => {
    const registry = new ToolRegistry();
    for (const name of ['read_file', 'web_fetch', 'write_file']) {
      registry.register({
        name,
        description: `${name} tool`,
        parameters: { type: 'object' },
        requiredPolicy: 'readonly',
        async execute() {
          return { status: 'completed', output: '' };
        },
      });
    }

    expect(registry.toOpenAITools({
      include: ['read_file', 'write_file'],
      exclude: ['write_file'],
    }).map((tool) => tool.function.name)).toEqual(['read_file']);
  });

  it('searches tools by name and description without returning excluded internals', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'tool_search',
      description: 'internal binding helper',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        return { status: 'completed', output: '' };
      },
    });
    registry.register({
      name: 'read_file',
      description: 'Read a file from the workspace',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        return { status: 'completed', output: '' };
      },
    });
    registry.register({
      name: 'shell_command',
      description: 'Run a shell command',
      parameters: { type: 'object' },
      requiredPolicy: 'workspace_write',
      requiresApproval: true,
      async execute() {
        return { status: 'completed', output: '' };
      },
    });

    expect(registry.search('read workspace file', {
      limit: 5,
      exclude: ['tool_search'],
    })).toEqual([
      expect.objectContaining({
        name: 'read_file',
        requiresApproval: false,
      }),
    ]);
  });

  it('forwards cancellation to the tool and preserves its structured result', async () => {
    const registry = new ToolRegistry();
    let signalSeen: AbortSignal | undefined;
    registry.register({
      name: 'cancellable',
      description: 'test tool',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute(_args, context) {
        signalSeen = context.signal;
        return new Promise((resolve) => {
          context.signal?.addEventListener('abort', () => resolve({
            status: 'failed',
            output: 'cancelled by signal',
            error: { message: 'cancelled by signal', code: 'TOOL_CANCELLED' },
          }), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const execution = registry.execute(
      'cancellable',
      {},
      { workspaceRoot: process.cwd(), threadId: 'thread', turnId: 'turn', approved: false, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('User cancelled the turn'));

    await expect(execution).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_CANCELLED' },
    });
    expect(signalSeen?.aborted).toBe(true);
  });
});
