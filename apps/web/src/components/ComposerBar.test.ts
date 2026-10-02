import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config/defaults.js';
import { ComposerBar } from './ComposerBar.js';

const here = dirname(fileURLToPath(import.meta.url));

function renderComposer(overrides: Partial<React.ComponentProps<typeof ComposerBar>> = {}): string {
  return renderToStaticMarkup(React.createElement(ComposerBar, {
    activeSlashOption: null,
    activeThreadId: '',
    applyModelPreset: vi.fn(),
    botConfig: null,
    botStatus: null,
    busy: false,
    composerInputRef: React.createRef<HTMLTextAreaElement>(),
    config: defaultConfig,
    draggingImage: false,
    filteredSlashOptions: [],
    handleDrop: vi.fn(),
    handleFileSelect: vi.fn(),
    handlePaste: vi.fn(),
    images: [],
    input: '',
    modelPresets: [],
      openRemoteAssistants: vi.fn(),
    removeImage: vi.fn(),
    rightPaneVisible: true,
    selectSlashOption: vi.fn(),
    setActiveSlashOption: vi.fn(),
    setConfig: vi.fn(),
    setDraggingImage: vi.fn(),
    setInput: vi.fn(),
    slashVisible: false,
    stopTurn: vi.fn(),
    submitComposer: vi.fn(),
    ...overrides,
  }));
}

describe('ComposerBar', () => {
  it('renders only active Plan and Goal states, while Dynamic Workflow belongs to thinking level four', () => {
    const source = readFileSync(join(here, 'ComposerBar.tsx'), 'utf-8');
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');
    const chatHtml = renderComposer();
    const planHtml = renderComposer({ executionMode: 'plan' });
    const goalHtml = renderComposer({ executionMode: 'goal' });
    const workflowHtml = renderComposer({ thinkingMode: 'workflow' });

    expect(chatHtml).not.toContain('对话');
    expect(chatHtml).not.toContain('modeIndicator');
    expect(planHtml).toContain('modeIndicatorPlan');
    expect(goalHtml).toContain('modeIndicatorGoal');
    expect(workflowHtml).not.toContain('modeIndicator');
    expect(planHtml).toMatch(/<span class="modeIndicator[^>]*>/);
    expect(goalHtml).toMatch(/<span class="modeIndicator[^>]*>/);
    expect(planHtml).toContain('modeIndicatorDismiss');
    expect(goalHtml).toContain('modeIndicatorDismiss');
    expect(goalHtml).not.toContain('spark');
    expect(source).not.toContain('executionModeSelect');
    expect(source).toContain("label: config.locale === 'zh' ? '动态工作流'");
    expect(styles).toContain('.modeIndicator');
    expect(styles).toContain('modeIndicatorDismiss');
    expect(styles).toContain('pointer-events: auto;');
    expect(styles).toContain('#f97316');
  });

  it('changes the intent prompt for Plan, Goal and Dynamic Workflow', () => {
    expect(renderComposer({ executionMode: 'plan' })).toContain('placeholder="输入规划目标…"');
    expect(renderComposer({ executionMode: 'goal' })).toContain('placeholder="输入目标任务…"');
    expect(renderComposer({ thinkingMode: 'workflow' })).toContain('placeholder="输入动态工作流目标…"');
  });

  it('uses the workflow planning composer instead of the ordinary chat controls', () => {
    const html = renderComposer({
      filteredSlashOptions: [{ id: 'compact', command: '/compact', title: 'Compact', detail: 'Compact context' }],
      input: '/compact',
      slashVisible: true,
      workflowMode: true,
    });

    expect(html).not.toContain('slashPalette');
    expect(html).toContain('输入工作流目标或节点修改要求');
    expect(html).toContain('计划模式');
    expect(html).toContain('首次创建必须先生成计划');
    expect(html).not.toContain('模型配置');
  });

  it('shows an explicit disabled planning state while a workflow draft is generating', () => {
    const html = renderComposer({
      input: '读取当前项目目录并生成工作流',
      workflowMode: true,
      workflowPlanning: true,
    });

    expect(html).toContain('生成计划中');
    expect(html).toContain('disabled=""');
  });

  it('marks the composer action button with explicit running-state classes', () => {
    const idleHtml = renderComposer({ input: '你好' });
    const busyHtml = renderComposer({ busy: true });
    const planningHtml = renderComposer({ workflowMode: true, workflowPlanning: true });

    expect(idleHtml).toContain('class="sendButton"');
    expect(busyHtml).toContain('class="sendButton busy stopButton"');
    expect(planningHtml).toContain('class="sendButton busy planningButton"');
  });

  it('does not resize the composer based on the selected right-pane tab', () => {
    const source = readFileSync(join(here, 'ComposerBar.tsx'), 'utf-8');
    const html = renderComposer({ rightPaneVisible: true });

    expect(html).toContain('balancedWidth');
    expect(source).not.toContain("rightPaneTab === 'files'");
    expect(source).not.toContain('wideWidth');
  });

  it('keeps composer history and draft as UX-only local storage', () => {
    const source = readFileSync(join(here, 'ComposerBar.tsx'), 'utf-8');
    expect(source).toContain('suanlizi.composer.history.v1');
    expect(source).toContain('suanlizi.composer.draft.v1');
    expect(source).toContain("event.key === 'ArrowUp'");
    expect(source).toContain("event.key === 'ArrowDown'");
  });

  it('renders remote bot bindings as platform icons instead of status text', () => {
    const html = renderComposer({
      activeThreadId: 'thread_current',
      botConfig: {
        weixin: {
          enabled: true,
          bridgeMode: 'desktop_managed',
          bridgeUrl: 'http://127.0.0.1:18790/api/v1/admin/rpc',
          accountId: 'wx_account',
          activeThreadId: 'thread_current',
          autoStartMonitor: true,
          syncHistoryOnConnect: true,
        },
        dingtalk: {
          enabled: true,
          connectionMode: 'stream',
          clientId: 'ding_client',
          clientSecret: 'ding_secret',
          robotCode: '',
          cardTemplateId: '',
          targetGroupName: '',
          targetGroupConversationId: '',
          targetGroupSessionWebhook: '',
          lastDetectedGroupConversationId: '',
          lastDetectedGroupSessionWebhook: '',
          lastDetectedGroupAt: '',
          allowedUsers: [],
          webhookSecret: '',
          activeThreadId: 'thread_current',
          autoStart: true,
        },
        feishu: { enabled: false },
        qq: { enabled: false },
        dwsCli: { enabled: false, binaryPath: '', clientId: '', clientSecret: '' },
      },
      botStatus: { weixin: { connected: true }, dingtalk: { configured: true, streamRunning: true } },
    });

    expect(html).toContain('remotePlatformIcon weixin');
    expect(html).toContain('remotePlatformIcon dingtalk');
    expect(html).toContain('微信、钉钉已绑定到当前对话');
    expect(html).not.toContain('2 个助手已绑定');
    expect(html).not.toContain('微信已绑定');
    expect(html).not.toContain('绑定到其他对话');
  });

  it('uses a robot icon when no remote assistant is bound', () => {
    const html = renderComposer({ activeThreadId: 'thread_current' });

    expect(html).toContain('remoteBindingRobot');
    expect(html).not.toContain('远程助手未绑定');
    expect(html).not.toContain('远程助手未连接');
    expect(html).not.toContain('绑定到其他对话');
  });

  it('opens a platform selection menu before starting a remote assistant flow', () => {
    const source = readFileSync(join(here, 'ComposerBar.tsx'), 'utf-8');

    expect(source).toContain('remoteAssistantMenu');
    expect(source).toContain("selectRemoteAssistant('weixin')");
    expect(source).toContain("selectRemoteAssistant('dingtalk')");
  });

  it('uses a solid semantic send control for idle and busy states', () => {
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');
    const finalContract = styles.slice(styles.lastIndexOf('/* Suanlizi conversation surface contract */'));

    expect(finalContract).toContain('.appShell .sendButton');
    expect(finalContract).toContain('background: var(--nx-brand);');
    expect(finalContract).toContain('.appShell .sendButton.busy');
    expect(finalContract).toContain('border-radius: 10px;');
  });
  it('uses one line-icon family across the composer permission, thinking, attachment and file controls', () => {
    const source = readFileSync(join(here, 'ComposerBar.tsx'), 'utf-8');
    const icons = readFileSync(join(here, 'Icon.tsx'), 'utf-8');
    const desktopSource = readFileSync(join(here, '..', '..', '..', 'desktop', 'src', 'components', 'ComposerBar.tsx'), 'utf-8');
    const desktopIcons = readFileSync(join(here, '..', '..', '..', 'desktop', 'src', 'components', 'Icon.tsx'), 'utf-8');

    // 权限三档语义图标
    expect(source).toContain(`<Icon name="hand" />`);
    expect(source).toContain(`<Icon name="messageShield" />`);
    expect(source).toContain(`<Icon name="shieldAlert" />`);
    expect(source).toContain("tone: 'warning'");
    // 思考四档：快速 / 均衡 / 深度 / 动态工作流
    expect(source).toContain(`icon: <Icon name="gauge" />`);
    expect(source).toContain(`icon: <Icon name="balance" />`);
    expect(source).toContain(`icon: <Icon name="layers" />`);
    expect(source).toContain(`icon: <Icon name="workflow" />`);
    // Plan 状态、附件、文件与目录引用
    expect(source).toContain(`icon: <Icon name="listChecks" />`);
    expect(source).toContain(`<Icon name="imagePlus" />`);
    expect(source).toContain("'folderOutline' : 'fileOutline'");
    expect(source).toContain(`<Icon name="fileOutline" />`);
    // 运行模式已收敛：不再有「缓存优先 / 长运行」下拉，压缩阈值改在运行参数页设置。
    expect(source).not.toContain('runProfileSelect');
    expect(source).not.toContain('runProfileLabel');

    // 图标系统已完全移除 FontAwesome：不允许任何实心映射或依赖回流
    expect(icons).not.toContain('fontAwesomeIcons');
    expect(icons).not.toContain('FontAwesome');
    expect(icons).not.toContain('@fortawesome');

    // Web 与 Desktop 输入框图标保持一致
    for (const semantic of ['hand', 'messageShield', 'shieldAlert', 'imagePlus', 'fileOutline', 'folderOutline', 'listChecks', 'layers']) {
      expect(source).toContain(semantic);
      expect(desktopSource).toContain(semantic);
      expect(icons).toContain(`${semantic}: <>`);
      expect(desktopIcons).toContain(`${semantic}: <>`);
    }
  });


  it('no longer groups model presets under a 已保存 / Saved label', () => {
    for (const file of ['ComposerBar.tsx']) {
      const src = readFileSync(join(here, file), 'utf-8');
      expect(src).not.toContain("'已保存'");
      expect(src).not.toContain("'Saved'");
      expect(src).not.toContain('dropdownGroup');
    }
  });

  it('keeps the model preset draft concept fully removed', () => {
    const models = readFileSync(join(here, 'settings', 'ModelsPage.tsx'), 'utf-8');
    // 保存接口不再接受 draft/published 状态
    expect(models).not.toContain("'draft' | 'published'");
    for (const banned of ['保存为草稿', '保存为正式预设', '恢复草稿', '当前编辑草稿', '__draft__']) {
      expect(models).not.toContain(banned);
    }
  });

});
