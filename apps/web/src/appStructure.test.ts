import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('app module structure', () => {
  it('keeps main.tsx focused on app state and layout', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).toContain("from './components/Dialogs.js'");
    expect(source).toContain("from './components/SettingsDrawer.js'");
    expect(source).toContain("from './components/RunMonitorDrawer.js'");
    expect(source).toContain("from './components/RightPane.js'");
    expect(source).toContain("from './features/monitor/runMonitor.js'");
    expect(source).toContain("from './api/threadConfigClient.js'");
  });

  it('renders workflow projects in a dedicated side pane instead of the generic right pane tabs', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).toContain('WorkflowSidePane');
    expect(source).toContain("isWorkflowProject ? 'workflow'");
  });

  it('routes workflow composer submissions to workflow planning instead of ordinary chat turns', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).toContain('if (isWorkflowProject)');
    expect(source).toContain('await requestWorkflowPlan(goal)');
    expect(source).toContain('workflowMode={isWorkflowProject}');
    expect(source).toContain('!isWorkflowProject && !activeSlashOption');
  });

  it('uses workflow-specific empty transcript text for workflow projects', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).toContain('items.length === 0');
    expect(source).toContain('isWorkflowProject');
    expect(source).toContain('从下方输入工作流目标，或描述节点修改要求。');
  });

  it('stops the in-flight turn even before the newly created thread id reaches React state', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).toContain('const activeTurnThreadIdRef = useRef');
    const sendMessage = source.match(/async function sendMessage[\s\S]*?async function stopTurn/)?.[0] ?? '';
    expect(sendMessage).toContain('activeTurnThreadIdRef.current = activeThreadId;');
    const stopTurn = source.match(/async function stopTurn[\s\S]*?async function decideApproval/)?.[0] ?? '';
    expect(stopTurn).toContain('const targetThreadId = activeTurnThreadIdRef.current || threadId');
    expect(stopTurn).toContain('`/api/threads/${targetThreadId}/interrupt`');
    expect(stopTurn).not.toContain('if (!threadId) return;');
  });

  it('uses stable transcript keys so streaming updates do not remount messages', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const transcriptRender = source.match(/transcriptGroups\.map[\s\S]*?<\/section>/)?.[0] ?? '';

    expect(transcriptRender).toContain('key={group.item.id}');
    expect(transcriptRender).toContain('key={group.id}');
    expect(transcriptRender).not.toContain('-${index}');
  });

  it('follows one end sentinel frame without resize-driven transcript forcing', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');

    expect(source).toContain('const transcriptEndRef = useRef<HTMLDivElement | null>(null);');
    expect(source).toContain("transcriptEndRef.current?.scrollIntoView({ block: 'end' });");
    expect(source).toContain('className="transcriptEndSentinel"');
    expect(source).not.toContain('ResizeObserver');
    expect(source).not.toContain('transcript.scrollTop = transcript.scrollHeight');
  });
});
