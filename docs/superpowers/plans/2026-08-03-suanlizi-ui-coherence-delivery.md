# Suanlizi UI Coherence Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Turn the existing Suanlizi web and desktop clients into one coherent, dense, light/dark workbench without deleting working configuration, monitoring, file, GitNexus, or Agent behavior.

**Architecture:** Retain the React component boundaries and API/state contracts. The work introduces equivalent semantic surface/control tokens in both client stylesheets, then applies them to the shell, settings, right workbench, monitor, file preview, and GitNexus. It does not move features into a new shared package or redesign data contracts.

**Tech Stack:** React, TypeScript, CSS custom properties, Vitest, Vite/Electron desktop client, built-in browser validation on http://127.0.0.1:5177 and http://127.0.0.1:5178.

---

## Delivery boundaries

- Baseline is commit a582066 (chore: checkpoint current Suanlizi development before theme polish). Do not reset, squash, or discard it.
- This is a desktop-product pass. Validate 1440x900, 1180x760, and 1024x720. Do not replace the desktop workbench with a mobile card stack.
- Web and desktop are two product entry points. Every change below applies to apps/web and apps/desktop unless a page physically exists in only one client.
- Preserve provider credentials, preset persistence, access-policy persistence, MCP/plugin payloads, remote-assistant integrations, monitor API routes, file lifecycle, and GitNexus graph data.
- Preserve the existing animated chat avatar and AgentStagePanel robot visual language. Tune surfaces, border, type, spacing, and motion only. Do not substitute emoji, a generic status card, or a new Agent data model.
- Normal work surfaces contain only labels, values, controls, errors, and operational state. Do not leave instructional prose in Settings or other working pages. The top-right SettingsHelpDialog remains the sole explanatory surface and keeps the real product help content.
- GitNexus remains available from a selected directory inside the right File view. It must not become a global top-navigation view.
- The current HTML visual samples are review artifacts only. No application behavior is copied from them without a test and a matching real component path.

## File and responsibility map

| Area | Web | Desktop | Responsibility |
| --- | --- | --- | --- |
| Visual tokens | apps/web/src/styles.css | apps/desktop/src/styles.css | Light/dark surfaces, controls, type, popovers, dialogs, scrollbars, reduced motion |
| Product shell | apps/web/src/main.tsx; components/WorkspaceThreadList.tsx; components/Dialogs.tsx | matching apps/desktop paths | Top icon controls, left workflow/project/thread hierarchy, help dialog, panel visibility |
| Chat and Agent | components/ItemView.tsx; ComposerBar.tsx; RightPane.tsx; AgentStagePanel.tsx; components/workbench | matching apps/desktop paths | Streaming transcript, composer, original avatars, Activity/Agent/File panels |
| Settings | SettingsDrawer.tsx; components/settings/SettingsShell.tsx; ModelsPage.tsx; AccessPolicyPage.tsx; AppearancePage.tsx; AgentsPage.tsx; ToolsPage.tsx; McpPage.tsx; MemoryPage.tsx; MonitorPage.tsx | matching apps/desktop paths; desktop intentionally has no AboutPage.tsx | Complete configuration UI without removing controls |
| Observe, File, GitNexus | components/monitor; RunMonitorDrawer.tsx; components/workbench; GitNexusPanel.tsx; GitNexusGraphModal.tsx | matching apps/desktop paths | Trace selection, file preview, directory-scoped full-screen graph |
| Tests | src/lightThemeSkin.test.ts; src/topbarActions.test.ts; src/sidebar.test.ts; src/rightPaneSizing.test.ts; src/workspaceFilesLayout.test.ts; component tests | matching apps/desktop tests | Web/desktop parity and regression guards |

## Phase 1: visual foundation and dark-theme parity

### Task 1: add one semantic visual contract to both clients

**Files:**
- Modify: apps/web/src/styles.css
- Modify: apps/desktop/src/styles.css
- Modify: apps/web/src/lightThemeSkin.test.ts
- Modify: apps/desktop/src/lightThemeSkin.test.ts
- Create: apps/web/src/darkThemeSkin.test.ts
- Create: apps/desktop/src/darkThemeSkin.test.ts

- [x] Step 1: write the failing dark-theme guards in each new test.

    expect(styles).toContain('--nx-surface-canvas: #0a0e13;');
    expect(styles).toContain('--nx-surface-raised: #121820;');
    expect(styles).toContain('--nx-surface-panel: #171e27;');
    expect(styles).toContain('--nx-control-bg: #0c1218;');
    expect(styles).toContain('--nx-text-primary: #e9edf2;');
    expect(styles).not.toContain('.appShell:not(.theme-light) .settingsDrawer {\n  background: #ffffff;');

- [x] Step 2: run npx vitest run apps/web/src/darkThemeSkin.test.ts apps/desktop/src/darkThemeSkin.test.ts. Expected: failure for missing semantic tokens.
- [x] Step 3: add equivalent token families to both stylesheets, placed after the broad component rules so order cannot turn a dark region white.

    --nx-surface-canvas: #0a0e13;
    --nx-surface-raised: #121820;
    --nx-surface-panel: #171e27;
    --nx-surface-overlay: #10171f;
    --nx-control-bg: #0c1218;
    --nx-control-border: #394653;
    --nx-text-primary: #e9edf2;
    --nx-text-muted: #aab4c0;
    --nx-text-faint: #737f8e;
    --nx-accent: #82add9;
    --nx-accent-soft: rgba(94, 143, 190, 0.15);

- [x] Step 4: update both lightThemeSkin tests to require --nx-surface-canvas: #f8fafc;, --nx-text-primary: #0f172a;, and prohibit --nx-surface-canvas: #0a0e13; in the final light guard.
- [x] Step 5: run npx vitest run apps/web/src/lightThemeSkin.test.ts apps/web/src/darkThemeSkin.test.ts apps/desktop/src/lightThemeSkin.test.ts apps/desktop/src/darkThemeSkin.test.ts. Expected: all pass.
- [x] Step 6: commit only these files with git commit -m "feat: unify Suanlizi light and dark theme tokens".

### Task 2: apply the visual contract to shared primitives before page layout

**Files:**
- Modify: apps/web/src/styles.css
- Modify: apps/desktop/src/styles.css
- Test: the four theme tests from Task 1

- [x] Step 1: extend the tests to require final token-consuming rules for .settingsDrawer, .settingsNav (live rail), .settingsContent (live main), .settingsCard, .composer, .commandInputRow, .workbenchPanel, .dropdownMenu, .appDialog, .gitNexusGraphModal, and .turnFileSummary.
- [x] Step 2: run the tests. Expected: failure until the required selectors consume semantic surfaces.
- [x] Step 3: make every listed region use semantic values rather than late hard-coded white or near-black values. Where the old declaration is in @layer components with !important, place the dark override in that same layer.

    .settingsDrawer, .workbenchPanel, .appDialog { background: var(--nx-surface-raised); color: var(--nx-text-primary); }
    .settingsNav, .settingsCard, .turnFileSummary { background: var(--nx-surface-panel); border-color: var(--nx-control-border); }
    .commandInputRow, .dropdownButton, .settingsDrawer input, .settingsDrawer select, .settingsDrawer textarea { background: var(--nx-control-bg); color: var(--nx-text-primary); border-color: var(--nx-control-border); }

- [x] Step 4: enforce one control hierarchy: primary is a muted steel-blue action; secondary, icon, close, checkbox, disabled, and select controls use dark surfaces in dark mode. Do not use gradients, bright purple-blue, or broad glow shadows.
- [x] Step 5: run the four theme tests and npm run build. Expected: all tests pass and TypeScript exits 0.
- [x] Step 6: commit with git commit -m "feat: apply Suanlizi semantic surfaces to shared controls".

### Task 3: preserve desktop pane widths while removing motion jank

**Files:**
- Modify: apps/web/src/styles.css
- Modify: apps/desktop/src/styles.css
- Modify: apps/web/src/rightPaneSizing.test.ts
- Modify: apps/desktop/src/rightPaneSizing.test.ts

- [x] Step 1: extend the existing width guards with a mount/transition contract proving File keeps its separate full preview width and Activity/Agent do not inherit it.

    expect(source).toContain('.workspaceFiles');
    expect(source).toContain('min-width');
    expect(source).not.toContain('width: 280px; /* all right-pane tabs */');

- [x] Step 2: run npx vitest run apps/web/src/rightPaneSizing.test.ts apps/desktop/src/rightPaneSizing.test.ts. Expected: fail until inactive tab regions expose state and dimensions use separate selectors.
- [x] Step 3: keep tab content mounted during transitions, make inactive regions inert, and animate opacity/transform only.

    .workbenchPanel { will-change: opacity, transform; transition: opacity var(--nx-motion-fast), transform var(--nx-motion-fast); }
    .workbenchPanel[data-state='inactive'] { pointer-events: none; opacity: 0; transform: translate3d(8px, 0, 0); }
    .workspaceFiles { min-width: min(52vw, 760px); }

- [x] Step 4: do not animate width, left, right, or grid-template-columns. Preserve the existing prefers-reduced-motion guard and vertical File-tree scroll.
- [x] Step 5: rerun sizing/theme tests; then use the built-in browser on 5177 and 5178. On 5178 validate 1440x900, 1180x760, and 1024x720; switch Activity -> Agent -> File -> Activity. Expected: File retains proportional preview width, no white flash in dark mode, and no width jump.
- [ ] Step 6: commit with git commit -m "fix: preserve Suanlizi workbench widths during tab transitions".

## Phase 2: product shell, conversation, and Agent workbench

### Task 4: polish the existing shell without deleting actions

**Files:**
- Modify: apps/web/src/main.tsx
- Modify: apps/desktop/src/main.tsx
- Modify: apps/web/src/components/WorkspaceThreadList.tsx
- Modify: apps/desktop/src/components/WorkspaceThreadList.tsx
- Modify: both styles.css files
- Test: apps/web/src/topbarActions.test.ts; apps/web/src/sidebar.test.ts
- Test: matching apps/desktop tests

- [x] Step 1: characterize the actual control matrix before changing markup.

    expect(mainSource).toContain('SettingsHelpDialog');
    expect(mainSource).toContain('RunMonitorDrawer');
    expect(mainSource).toContain('setRightPaneVisible');
    expect(mainSource).toContain('setSidebarCollapsed');
    expect(sidebarSource).toContain('WorkflowProjectList');
    expect(sidebarSource).toContain('ThreadModuleView');
    expect(sidebarSource).toContain('WorkspaceGroupView');

- [x] Step 2: run npx vitest run apps/web/src/topbarActions.test.ts apps/web/src/sidebar.test.ts apps/desktop/src/topbarActions.test.ts apps/desktop/src/sidebar.test.ts. Expected: pass before restyling.
- [x] Step 3: restyle, not replace, top icon controls and row hover/expand actions.

    .topbarAction, .miniIconButton { inline-size: 32px; block-size: 32px; display: inline-grid; place-items: center; }
    .threadListRow:hover .threadListRowActions, .threadListRow:focus-within .threadListRowActions { opacity: 1; }
    .threadListRowActions { opacity: 0; transition: opacity var(--nx-motion-fast); }

- [x] Step 4: keep the actual SettingsHelpDialog content. Add a test that it still contains 核心功能概览, 运行配置说明, and GitNexus. Keep the left Settings entry because it is the real navigation action; never replace it with a shortcut cheat-sheet.
- [x] Step 5: inspect top/left controls at the live 5177 canvas and 1024x720 on 5178. Every action remains keyboard-labelled, discoverable on hover/focus, and aligned without horizontal overflow.
- [ ] Step 6: commit with git commit -m "feat: polish Suanlizi shell controls without removing navigation".

### Task 5: improve transcript and composer without touching streaming state or avatars

**Files:**
- Modify: apps/web/src/components/ItemView.tsx
- Modify: apps/desktop/src/components/ItemView.tsx
- Modify: apps/web/src/components/ComposerBar.tsx
- Modify: apps/desktop/src/components/ComposerBar.tsx
- Modify: both styles.css files
- Test: messageActions.test.ts, components/ItemView.test.ts, components/ComposerBar.test.ts in both apps

- [x] Step 1: keep behavior guards for latest-user-only rollback, latest-assistant retry, and failure metadata/copy action.

    expect(renderedLatestUser).toContain('rollback');
    expect(renderedEarlierUser).not.toContain('rollback');
    expect(renderedLatestAssistant).toContain('retry');
    expect(renderedFailure).toContain('messageMeta');
    expect(renderedFailure).toContain('copy');

- [x] Step 2: run the six focused message/composer tests. Expected: pass before visual changes.
- [x] Step 3: apply compact semantic styling to message cards, message metadata, file summary, input, and send/busy control.

    .messageBlock { border-color: var(--nx-control-border); background: var(--nx-surface-panel); }
    .messageMeta, .turnFileSummary { color: var(--nx-text-muted); background: var(--nx-surface-overlay); }
    .sendButton.busy { border-radius: 10px; }
    .sendButton.busy::after { border-radius: 12px; }

- [x] Step 4: retain key={group.item.id}, timestamp/copy controls, and the request/streaming state machine. Retain UserAvatar and existing assistant/Agent robots; only tune surrounding surface, radius, and shadow.
- [ ] Step 5: rerun the six tests; manually send one successful and one failed turn on each client. Expected: user and assistant placeholder stay visible from the first streaming frame; failed response has timestamp and copy action. Blocked only for live manual verification in this session because 5177/5178 have no API process at 4127; static render tests cover failure timestamp/copy and latest-turn actions.
- [x] Step 6: commit with git commit -m "feat: refine Suanlizi conversation and composer surfaces".

### Task 6: retain original Agent animation and make event linkage specific

**Files:**
- Modify: apps/web/src/components/RightPane.tsx
- Modify: apps/desktop/src/components/RightPane.tsx
- Modify: apps/web/src/components/AgentStagePanel.tsx
- Modify: apps/desktop/src/components/AgentStagePanel.tsx
- Modify: apps/web/src/components/workbench/WorkspaceWorkbench.tsx
- Modify: apps/desktop/src/components/workbench/WorkspaceWorkbench.tsx
- Modify: both styles.css files
- Test: components/RightPane.test.ts and agentStageTheme.test.ts in both apps

- [x] Step 1: add source guards for all three tabs and the original robot entry points.

    expect(source).toContain("'activity'");
    expect(source).toContain("'agents'");
    expect(source).toContain("'files'");
    expect(agentSource).toContain('RobotMoodIcon');
    expect(agentSource).toContain('InteractiveMainRobot');

- [x] Step 2: run the four tab/Agent tests. Expected: pass before styling.
- [x] Step 3: apply semantic panel styling. The Agent information button still toggles the actual inspector; the original avatar nudge animation is retained because it is not an inspector affordance.
- [x] Step 4: make each recent Activity event open and select the exact trace.

    onOpenMonitor({ runId: event.runId, eventId: event.eventId, itemId: event.itemId });

  Render Agent identity and skill/MCP/tool/file/resource information in the same event row. Do not add a duplicate resources column.
- [ ] Step 5: rerun focused tests and inspect Activity -> Agent -> File transitions at all target desktop sizes on both clients. Expected: robot remains original, no width jump, event links select a real trace. The transition/theme portion is verified; clicking a populated live trace remains blocked in this session because 5177/5178 have no API process at 4127.
- [x] Step 6: commit with git commit -m "feat: retain animated Agent workbench with trace linkage".

## Phase 3: settings workbench, full functionality, no instructional clutter

### Task 7: reduce SettingsShell to a clean, theme-correct frame

**Files:**
- Modify: apps/web/src/components/settings/SettingsShell.tsx
- Modify: apps/desktop/src/components/settings/SettingsShell.tsx
- Modify: apps/web/src/components/SettingsDrawer.tsx
- Modify: apps/desktop/src/components/SettingsDrawer.tsx
- Modify: both styles.css files
- Test: components/settings/settingsShell.test.tsx in both apps

- [ ] Step 1: add static-render guards rejecting shell save/cancel bars, footer help entries, scope selectors, and generic descriptive subtitle text.

    expect(html).not.toContain('settingsSaveActions');
    expect(html).not.toContain('settingsSaveBar');
    expect(html).not.toContain('data-settings-help-footer');
    expect(html).not.toContain('选择默认模型、凭据来源和可复用预设。');
    expect(html).toContain('aria-label="Close settings"');

- [ ] Step 2: run npx vitest run apps/web/src/components/settings/settingsShell.test.tsx apps/desktop/src/components/settings/settingsShell.test.tsx. Expected: fail only for unwanted remaining markup.
- [ ] Step 3: retain only modal frame, rail navigation, focus/Escape, unsaved/error/toast state, and close control in SettingsShell. Page-level actions stay inside their owning page.

    <nav className="settingsRail" aria-label={t(locale, 'settings')}>
      {settingsTabs.map((tab) => <button key={tab.id} type="button" aria-current={tab.id === activeSection ? 'page' : undefined} />)}
    </nav>

- [ ] Step 4: use tokenized rail, selected state, main canvas, close control, and scrollbar styles. The active rail item is not white in dark mode.
- [ ] Step 5: rerun both tests and npm run build. Expected: all pass.
- [ ] Step 6: commit with git commit -m "feat: simplify Suanlizi settings shell chrome".

### Task 8: compact every Settings page without dropping any setting

**Files:**
- Modify: ModelsPage.tsx, AccessPolicyPage.tsx, AppearancePage.tsx, AgentsPage.tsx, ToolsPage.tsx, McpPage.tsx, MemoryPage.tsx, MonitorPage.tsx, and McpSection.tsx under both apps
- Modify: apps/web/src/components/settings/AboutPage.tsx only where visual styling is necessary
- Modify: both styles.css files
- Test: modelSettingsDraft.test.ts, skillsSettings.test.ts, settingsNavigation.test.ts in both apps

- [ ] Step 1: add page-presence guards to both drawers.

    expect(drawerSource).toContain('<ModelsPage');
    expect(drawerSource).toContain('<AccessPolicyPage');
    expect(drawerSource).toContain('<McpPage');
    expect(drawerSource).toContain('<ToolsPage');
    expect(drawerSource).toContain('<MemoryPage');
    expect(drawerSource).toContain('<MonitorPage');

  For web only, also require AboutPage. Do not invent AboutPage in desktop.
- [ ] Step 2: run the six model/plugin/navigation tests. Expected: pass before layout changes.
- [ ] Step 3: use dense twelve-column groups and restrained cards rather than every field in a full-width white container.

    .settingsGrid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
    .settingsField { min-inline-size: 0; }
    .settingsCard { padding: 16px; border: 1px solid var(--nx-control-border); border-radius: 12px; background: var(--nx-surface-panel); }
    .settingsCard h3 { font-size: 14px; font-weight: 650; color: var(--nx-text-primary); }

- [ ] Step 4: retain model order: default model, credential, preset. Preset deletion remains inside the preset dropdown/item row. OpenAI-compatible remains the provider format that reveals provider-name; do not introduce a separate custom-provider category. Remove the one-shot environment-variable batch editor.
- [ ] Step 5: remove generic teaching copy only. Keep actual field labels, validation errors, status badges, service state, plugin/MCP forms, remote assistant controls, and all persistence actions.
- [ ] Step 6: run focused tests, then open Models, Access policy, Appearance, Memory, Monitor, Plugin Center/MCP, and Remote Assistant on 5177 and 5178 in both themes. Expected: every control remains available and readable; no dark Settings page contains a white card or selected rail item.
- [ ] Step 7: commit with git commit -m "feat: compact Suanlizi settings pages without dropping controls".

## Phase 4: monitor, file preview, and GitNexus

### Task 9: make monitor selection truthful, dense, and manually scrollable

**Files:**
- Modify: components/monitor/RunMonitorWorkbench.tsx and TraceTimeline.tsx in both apps
- Modify: features/monitor/runMonitorState.ts in both apps
- Modify: both styles.css files
- Test: components/RunMonitorDrawer.test.ts and features/monitor/runMonitorState.test.ts in both apps

- [ ] Step 1: write a failing reducer test for a one-shot selected-event reveal.

    const state = reduce(initialState, { type: 'select-event', eventId: 'trace-9' });
    expect(state.selectedEventId).toBe('trace-9');
    expect(reduce(state, { type: 'selected-event-revealed' }).selectedEventId).toBeNull();

- [ ] Step 2: run the four monitor tests. Expected: missing selected-event-revealed action fails.
- [ ] Step 3: reveal once and never re-force scroll after user input.

    if (selectedEventId && !hasRevealedRef.current) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      dispatch({ type: 'selected-event-revealed' });
    }

  Event order is newest-first. Category All clears the active category set. Clicking an individual category toggles only it.
- [ ] Step 4: use one combined event line for Agent identity plus model/tool/skill/MCP/file/resource data. Do not create a duplicate resources column. Use 12px metadata, 13px row title, and 14px inspector title.
- [ ] Step 5: run focused tests and click a recent Activity event in both clients. Expected: exact trace row centers once; subsequent manual scroll persists; filters respond without a full list refetch.
- [ ] Step 6: commit with git commit -m "fix: improve Suanlizi trace selection and monitor density".

### Task 10: make File and GitNexus readable, theme-correct, and directory-scoped

**Files:**
- Modify: components/workbench/WorkspaceWorkbench.tsx in both apps
- Modify: GitNexusPanel.tsx and GitNexusGraphModal.tsx in both apps
- Modify: both styles.css files
- Test: workspaceFilesLayout.test.ts, components/GitNexusPanel.test.ts, and components/GitNexusGraphModal.test.ts in both apps

- [ ] Step 1: add source tests requiring a File-tab plus selected-directory entry flow, never a global GitNexus tab.

    expect(workbenchSource).toContain("activeTab === 'files'");
    expect(gitNexusSource).toContain('selectedPath');
    expect(gitNexusSource).toContain('workspaceRoot');
    expect(mainSource).not.toContain('data-view="gitnexus"');

- [ ] Step 2: run the six File/GitNexus tests. Expected: pass before skin changes.
- [ ] Step 3: apply semantic File skin without changing its functional behavior.

    .workspaceFiles, .workspaceFilePreview, .filePreviewHeader { background: var(--nx-surface-raised); color: var(--nx-text-primary); }
    .workspaceFileTree { overflow-y: auto; }
    .filePreviewPath { color: var(--nx-text-muted); }

  Keep single-click selection, tab retention, full-path hover tooltip, expand-and-reveal tree behavior, source/render switch, and click-to-copy path affordance. Markdown/text is light paper with dark text in light mode and dark reading surface with light text in dark mode.
- [ ] Step 4: keep GitNexus createPortal(document.body), cursor-wheel zoom, and an application-wide modal. Apply semantic shell and canvas colors. Default graph scale is readable without immediate zoom; full graph uses collision-aware spacing and no category-outline circles.
- [ ] Step 5: run focused tests, then validate on 5177 and 5178. Expected: File tree scrolls; only selected directory launches graph; graph overlays whole app; graph/file controls and text honor light/dark.
- [ ] Step 6: commit with git commit -m "feat: unify Suanlizi file preview and GitNexus graph skin".

## Final acceptance gate

### Task 11: parity review before any release work

**Files:**
- Modify only exact source and test files responsible for a verified final regression.
- Do not edit provider API clients, configuration protocol, monitor API routes, or file-lifecycle service logic during visual acceptance.

- [ ] Step 1: run npm run verify. Expected: source-artifact check, lint, all Vitest tests, and tsc -b exit 0.
- [ ] Step 2: use built-in browser on 5177 and 5178 and capture light/dark screens for:
  1. conversation with left navigation and right Activity;
  2. Agent animation with details collapsed/expanded where applicable;
  3. File tree with source/render preview;
  4. Settings Models, Access policy, Appearance, Memory, Plugin Center/MCP, and Remote Assistant;
  5. monitor with an exact selected trace and manual scroll;
  6. directory-initiated GitNexus graph modal.
- [ ] Step 3: verify the acceptance matrix.

| Check | Required result |
| --- | --- |
| Theme | no white control/card/rail remains in dark mode; no dark text/background mismatch remains in light mode |
| Density | restrained headings, compact groups, no generic explanatory paragraphs in normal work pages |
| Controls | top/left/settings/file/Agent controls remain, align correctly, and keep accessible names |
| Settings | every real complex Plugin Center, MCP, and Remote Assistant control remains; no shell save/cancel or browser discard confirm returns |
| Right pane | Activity, Agent, and File retain their correct independent widths; File preview is not sacrificed for smooth animation |
| Monitor | newest trace is at top; linked event selects/reveals once; manual scrolling remains under user control |
| GitNexus | only selected directory launches graph; graph is full-app, readable at open, and theme-aware |

- [ ] Step 4: if and only if a final regression was corrected, commit the exact corrected files with git commit -m "fix: close Suanlizi UI parity regressions". Do not create an empty commit.

## Plan self-review

- Scope coverage: tokens, controls, desktop sizing, shell, transcript/composer, original Agent animation, Settings, monitor, File, and directory-scoped GitNexus each have dedicated, testable tasks.
- Product safeguards: working state/payload contracts, original avatars, complete Settings content, and current GitNexus entry flow are explicitly preserved.
- Parity: each phase names web and desktop files plus matching tests; final browser validation requires both ports.
- Execution does not begin until the user approves the phase order and acceptance matrix.
