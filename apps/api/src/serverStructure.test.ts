import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('server module structure', () => {
  it('keeps server.ts focused on routing and shared wiring', () => {
    const source = readFileSync(join(process.cwd(), 'apps/api/src/server.ts'), 'utf-8');
    expect(source.split('\n').length).toBeLessThanOrEqual(850);
    expect(source).toContain('handleCompactThread');
    expect(source).toContain('/api/mcp/draft');
  });

  it('creates workflow project shells without requiring a saved workflow definition', () => {
    const source = readFileSync(join(process.cwd(), 'apps/api/src/server.ts'), 'utf-8');
    expect(source).toContain('workflowProject?: boolean');
    expect(source).toContain("body.workflowProject ? { workflowProject: 'true' } : {}");
  });

  // P2 取消链（计划 §9.2）：resume-running 的续跑必须登记可取消的 AbortSignal 并收口条目
  it('registers a cancellable signal for the resume-running continuation', () => {
    const source = readFileSync(join(process.cwd(), 'apps/api/src/server.ts'), 'utf-8');
    const block = source.slice(
      source.indexOf("if (action === 'resume-running')"),
      source.indexOf("if (action === 'resume-tree')"),
    );
    expect(block).toContain('new AbortController()');
    expect(block).toContain('tenantRuntime.activeRunRegistry.register({');
    expect(block).toContain('agent.resumeRunning(threadId, input, resumeController.signal)');
    // interrupt 双写：先落 stopping checkpoint，再 abort
    expect(block).toContain('agent.interrupt(threadId);');
    expect(block).toContain('resumeController.abort();');
    expect(block).toMatch(/finally\s*\{\s*releaseResumeRun\(\);/);
  });
});
