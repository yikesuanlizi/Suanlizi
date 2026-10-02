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

  it('keeps workflow projects as a split chat plus workflow workspace', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).toContain('<section className="transcript"');
    expect(source).toContain('workflowSidePane');
    expect(source).toContain("workspaceView === 'workflow' ? (");
    expect(source).toContain('<section className="workflowSidePane">');
    expect(source).not.toContain('<section className="workflowWorkspace">');
  });

  it('creates a titled workflow project shell without saving an empty workflow definition', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const createDraft = source.match(/const createWorkflowProjectDraft[\s\S]*?\r?\n\r?\n  useEffect/)?.[0] ?? '';
    expect(createDraft).toContain("setWorkspaceView('workflow')");
    expect(createDraft).toContain('createWorkflowThread(');
    expect(createDraft).toContain('未命名工作流项目');
    expect(createDraft).not.toContain('saveThreadWorkflow(');
    expect(createDraft).not.toContain('createEmptyWorkflowSnapshot');
  });

  it('uses workflow-specific empty transcript text in workflow mode', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).toContain("workspaceView === 'workflow'");
    expect(source).toContain('从下方输入工作流目标，或描述节点修改要求。');
  });

  it('clears transient workflow UI state when deleting the active workflow thread', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const deleteConversation = source.match(/async function deleteConversation[\s\S]*?async function renameConversation/)?.[0] ?? '';
    expect(source).toContain('function resetWorkflowState()');
    expect(deleteConversation).toContain('resetWorkflowState();');
  });

  it('recovers the active workflow from checkpoint items when thread tags are unavailable', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    expect(source).toContain('parseWorkflowCheckpointItems');
    expect(source).toContain('parseThreadWorkflow(activeThread) ?? parseWorkflowCheckpointItems(items)');
  });

  it('drops unconfirmed workflow drafts when switching sidebar threads', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const selectThread = source.match(/const selectThreadFromSidebar[\s\S]*?const createWorkflowProjectDraft/)?.[0] ?? '';
    expect(selectThread).toContain('resetWorkflowState();');
  });

  it('shows workflow planning input and reply in the chat transcript', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const requestWorkflowPlan = source.match(/const requestWorkflowPlan[\s\S]*?const commitWorkflowPlan/)?.[0] ?? '';
    expect(requestWorkflowPlan).toContain('createWorkflowDraftUserItem');
    expect(requestWorkflowPlan).toContain('createWorkflowDraftReplyItem');
    expect(requestWorkflowPlan).toContain('createWorkflowDraftErrorItem');
  });

  it('renames untitled workflow project shells after a plan is generated', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const requestWorkflowPlan = source.match(/const requestWorkflowPlan[\s\S]*?const commitWorkflowPlan/)?.[0] ?? '';
    expect(requestWorkflowPlan).toContain('isUntitledWorkflowProjectTitle');
    expect(requestWorkflowPlan).toContain('workflowThreadTitleFromGoal');
    expect(requestWorkflowPlan).toContain('renameConversation');
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

  it('keeps an Ops start bound to its originating thread and generation', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const startOpsTask = source.match(/async function startOpsTask[\s\S]*?async function runSlashCommand/)?.[0] ?? '';

    expect(startOpsTask).toContain('let requestThreadId = threadIdRef.current;');
    expect(startOpsTask).toContain('opsStartGenerationRef.current === startGeneration');
    expect(startOpsTask).toContain('threadIdRef.current === requestThreadId');
    expect(startOpsTask).toContain('const workspaceRoot = requestThreadId ? activeWorkspaceRoot : config.workspaceRoot.trim();');
    expect(startOpsTask).toContain('if (!isCurrentStart()) return false;');
    expect(startOpsTask).toContain('const reportStartError =');
  });

  it('keeps Ops behind an explicit start action', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');

    expect(source).toContain("const activeWorkspaceRoot = threadId");
    expect(source).toContain("activeThread?.tags?.conversationKind === 'chat' ? ''");
    expect(source).toContain('showOps={hasActiveThread && opsSessionActive}');
    expect(source).toContain("case 'ops':");
    expect(source).toContain("return submitExecutionMode('ops', command.args, attachments)");
    expect(source).not.toContain('handleThreadModeChange');
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
