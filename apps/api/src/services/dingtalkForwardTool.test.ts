import { describe, expect, it, vi } from 'vitest';
import { DingtalkClient, dwsExec } from '@suanlizi/bot';
import { DEFAULT_BOT_CONFIG, type BotConfig } from '../config/botConfig.js';
import {
  DINGTALK_TOOL_NAME,
  createDingtalkForwardTools,
  dingtalkForwardingSystemPrompt,
} from './dingtalkForwardTool.js';

vi.mock('@suanlizi/bot', async () => {
  const actual = await vi.importActual('@suanlizi/bot') as typeof import('@suanlizi/bot');
  return {
    ...actual,
    dwsExec: vi.fn(),
  };
});

function config(patch: Partial<BotConfig['dingtalk']> = {}): BotConfig {
  return {
    ...DEFAULT_BOT_CONFIG,
    dingtalk: {
      ...DEFAULT_BOT_CONFIG.dingtalk,
      enabled: true,
      clientId: 'ding_app_key',
      clientSecret: 'ding_secret',
      robotCode: 'ding_robot',
      targetGroupName: '打完我去打DD·',
      targetGroupConversationId: 'cid_group_target',
      targetGroupSessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
      ...patch,
    },
  };
}

describe('dingtalk forward tool', () => {
  it('sends a DingTalk group bubble with the unified forwarding tool', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown }) as unknown as DingtalkClient,
      currentUserText: '在群里冒个泡',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({ message: '冒个泡', source: 'dingtalk_dm', intent: 'send_message' }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(sendMarkdown).toHaveBeenCalledWith({
      conversationType: '2',
      conversationId: 'cid_group_target',
      text: '冒个泡',
    });
  });

  it('allows a model-composed bubble message when the user only requested bubbling in the group', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown }) as unknown as DingtalkClient,
      currentUserText: '在群里冒个泡',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({ message: '冒个泡 🧋 — Suanlizi 助手冒泡测试', source: 'dingtalk_dm', intent: 'send_message' }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(sendMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      text: '冒个泡 🧋 — Suanlizi 助手冒泡测试',
    }));
  });

  it('fails mention requests when the target name cannot be resolved to a DingTalk staff id', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown }) as unknown as DingtalkClient,
      currentUserText: '去群里艾特一下安博魏',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({ message: '@安博魏 有人找你', source: 'dingtalk_dm', intent: 'send_message' }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_MENTION_TARGET_NOT_RESOLVED' },
    });
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('uses DingTalk session webhook text messages for structured mentions because active group messages do not highlight @', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText, sendWebhookText }) as unknown as DingtalkClient,
      currentUserText: '去群里艾特一下安博魏',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@安博魏 有人找你',
      mentionStaffIds: ['staff_ambowei'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
      text: '有人找你',
      atStaffIds: ['staff_ambowei'],
    }));
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('strips leading visible mention text when sending structured webhook mentions', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: ['staff_shiziyi'] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText, sendWebhookText, searchContactUserIds }) as unknown as DingtalkClient,
      currentUserText: '在群里 @史紫亿，说大家好',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@史紫亿 大家好，我是 Suanlizi Agent OS 的 AI 助手',
      mentions: ['史紫亿'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      text: '大家好，我是 Suanlizi Agent OS 的 AI 助手',
      atStaffIds: ['staff_shiziyi'],
    }));
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('resolves mentioned display names through DingTalk contacts before sending a real text mention', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: ['staff_fushoufan'] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText, sendWebhookText, searchContactUserIds }) as unknown as DingtalkClient,
      currentUserText: '群里换一个人，@付守凡，消息“糖b”',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@付守凡 糖b',
      mentions: ['付守凡'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(searchContactUserIds).toHaveBeenCalledWith({ queryWord: '付守凡', fullMatch: true, size: 10 });
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
      text: '糖b',
      atStaffIds: ['staff_fushoufan'],
    }));
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('falls back to DingTalk organization departments when contact search cannot find a mentioned member', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: [] }));
    const searchOrgUserIdsByName = vi.fn(async () => ({ ok: true, userIds: ['staff_fushoufan'] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText, sendWebhookText, searchContactUserIds, searchOrgUserIdsByName }) as unknown as DingtalkClient,
      currentUserText: '群里 @付守凡，消息“糖b”',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@付守凡 糖b',
      mentions: ['付守凡'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(searchContactUserIds).toHaveBeenCalledWith({ queryWord: '付守凡', fullMatch: true, size: 10 });
    expect(searchOrgUserIdsByName).toHaveBeenCalledWith({ name: '付守凡' });
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
      text: '糖b',
      atStaffIds: ['staff_fushoufan'],
    }));
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('resolves mentions via dws CLI first when dws is configured, skipping native API fallback', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: [] }));
    const searchOrgUserIdsByName = vi.fn(async () => ({ ok: true, userIds: [] }));
    const mockDwsExec = vi.mocked(dwsExec);
    mockDwsExec.mockResolvedValue({
      exitCode: 0,
      stdout: '{"success":true,"result":[{"userId":"staff_zhangtianyu","name":"张天宇"}]}',
      stderr: '',
      json: { success: true, result: [{ userId: 'staff_zhangtianyu', name: '张天宇' }] },
    });
    const dwsConfig = {
      enabled: true,
      binaryPath: '',
      clientId: 'dws_app_key',
      clientSecret: 'dws_app_secret',
    };
    const tools = createDingtalkForwardTools({
      getConfig: async () => ({
        ...config(),
        dwsCli: dwsConfig,
      }),
      createClient: () => ({ sendMarkdown, sendText, sendWebhookText, searchContactUserIds, searchOrgUserIdsByName }) as unknown as DingtalkClient,
      currentUserText: '群里 @张天宇，消息“开会了”',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@张天宇 开会了',
      mentions: ['张天宇'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(mockDwsExec).toHaveBeenCalled();
    const callArgs = mockDwsExec.mock.calls[0];
    expect(callArgs?.[0]).toContain('contact');
    expect(callArgs?.[0]).toContain('张天宇');
    expect(searchContactUserIds).not.toHaveBeenCalled();
    expect(searchOrgUserIdsByName).not.toHaveBeenCalled();
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      atStaffIds: ['staff_zhangtianyu'],
    }));
  });

  it('falls back to native contact/org search when dws CLI is enabled but cannot find the member', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: [] }));
    const searchOrgUserIdsByName = vi.fn(async () => ({ ok: true, userIds: ['staff_lisi'] }));
    const mockDwsExec = vi.mocked(dwsExec);
    mockDwsExec.mockResolvedValue({
      exitCode: 0,
      stdout: '{"success":true,"result":[]}',
      stderr: '',
      json: { success: true, result: [] },
    });
    const dwsConfig = {
      enabled: true,
      binaryPath: '',
      clientId: 'dws_app_key',
      clientSecret: 'dws_app_secret',
    };
    const tools = createDingtalkForwardTools({
      getConfig: async () => ({
        ...config(),
        dwsCli: dwsConfig,
      }),
      createClient: () => ({ sendMarkdown, sendText, sendWebhookText, searchContactUserIds, searchOrgUserIdsByName }) as unknown as DingtalkClient,
      currentUserText: '群里 @李四，消息“来一下”',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@李四 来一下',
      mentions: ['李四'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(mockDwsExec).toHaveBeenCalled();
    expect(searchContactUserIds).toHaveBeenCalled();
    expect(searchOrgUserIdsByName).toHaveBeenCalled();
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      atStaffIds: ['staff_lisi'],
    }));
  });

  it('fails a mention request when the organization department fallback finds multiple exact members', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: [] }));
    const searchOrgUserIdsByName = vi.fn(async () => ({ ok: true, userIds: ['staff_1', 'staff_2'] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText, sendWebhookText, searchContactUserIds, searchOrgUserIdsByName }) as unknown as DingtalkClient,
      currentUserText: '去群里 @张伟 说一下开会',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@张伟 开会',
      mentions: ['张伟'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_MENTION_TARGET_AMBIGUOUS' },
    });
    expect(sendWebhookText).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('falls back to robot sendMarkdown when session webhook expires (errcode 300001), preserving @ mentions', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: false, error: 'DingTalk webhook error 300001: session 不存在' }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendWebhookText }) as unknown as DingtalkClient,
      currentUserText: '去群里艾特一下安博魏',
      mentionUsers: [{ staffId: 'staff_ambowei', name: '安博魏' }],
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@安博魏 有人找你',
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: '已发送（session webhook 已过期，使用机器人主动发送）',
    });
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
      atStaffIds: ['staff_ambowei'],
    }));
    expect(sendMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: '2',
      conversationId: 'cid_group_target',
      text: '@安博魏 有人找你',
      atStaffIds: ['staff_ambowei'],
    }));
  });

  it('returns the original non-session error when webhook fails for other reasons', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: false, error: 'DingTalk webhook HTTP 500: Internal Server Error' }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendWebhookText }) as unknown as DingtalkClient,
      currentUserText: '去群里艾特一下安博魏',
      mentionUsers: [{ staffId: 'staff_ambowei', name: '安博魏' }],
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@安博魏 有人找你',
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_GROUP_SEND_FAILED' },
    });
    expect(sendWebhookText).toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('falls back to sendMarkdown for attachment captions when session webhook expires', async () => {
    const sendFile = vi.fn(async () => ({ ok: true }));
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: false, error: 'DingTalk webhook error 300001: session 不存在' }));
    const downloadFile = vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: ['staff_xiemingzhi'] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendFile, sendMarkdown, sendWebhookText, downloadFile, searchContactUserIds }) as unknown as DingtalkClient,
      currentUserText: '把这个发送到群里，备注信息"好可爱的志志呀"，然后@谢明志',
      currentAttachments: [{
        type: 'image',
        fileName: 'msg-picture-1.jpg',
        fileSize: 3,
        downloadCode: 'download-code-1',
      }],
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      fileMode: 'current_message_files',
      message: '@谢明志 好可爱的志志呀',
      mentions: ['谢明志'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: '已发送（session webhook 已过期，使用机器人主动发送）',
    });
    expect(sendWebhookText).toHaveBeenCalled();
    expect(sendMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: '2',
      conversationId: 'cid_group_target',
      atStaffIds: ['staff_xiemingzhi'],
    }));
  });

  it('fails structured mentions when no DingTalk group session webhook is available', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: ['staff_fushoufan'] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config({ targetGroupSessionWebhook: '' } as Partial<BotConfig['dingtalk']>),
      createClient: () => ({ sendMarkdown, sendText, searchContactUserIds }) as unknown as DingtalkClient,
      currentUserText: '群里 @付守凡，消息“糖b”',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@付守凡 糖b',
      mentions: ['付守凡'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_GROUP_SESSION_WEBHOOK_REQUIRED_FOR_MENTION' },
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('fails a mention request when DingTalk contact search returns multiple possible users', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: ['staff_1', 'staff_2'] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText, searchContactUserIds }) as unknown as DingtalkClient,
      currentUserText: '去群里 @张伟 说一下开会',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@张伟 开会',
      mentions: ['张伟'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_MENTION_TARGET_AMBIGUOUS' },
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('fails a mention request when DingTalk contact search cannot find the named member', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: [] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText, searchContactUserIds }) as unknown as DingtalkClient,
      currentUserText: '去群里 @不存在的人 说一下开会',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@不存在的人 开会',
      mentions: ['不存在的人'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_MENTION_TARGET_NOT_RESOLVED' },
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('rejects display names passed as mention staff ids instead of real DingTalk ids', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText }) as unknown as DingtalkClient,
      currentUserText: '群里换一个人，@付守凡，消息“糖b”',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '@付守凡 糖b',
      mentionStaffIds: ['付守凡'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_MENTION_TARGET_NOT_RESOLVED' },
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('rejects mention requests when the model omits the @ text and has no real member id', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText }) as unknown as DingtalkClient,
      currentUserText: '群里换一个人，@付守凡，消息“糖b”',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      message: '糖b',
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_MENTION_TARGET_NOT_RESOLVED' },
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('infers a structured mention id when the outgoing message mentions a known DingTalk user name', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendText, sendWebhookText }) as unknown as DingtalkClient,
      currentUserText: '去群里艾特一下安博魏',
      mentionUsers: [{ staffId: 'staff_ambowei', name: '安博魏' }],
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({ message: '@安博魏 我是你dad', source: 'dingtalk_dm', intent: 'send_message' }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
      text: '我是你dad',
      atStaffIds: ['staff_ambowei'],
    }));
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('allows task-result delivery requests that ask to send the final result to the group', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown }) as unknown as DingtalkClient,
      currentUserText: '查一下今天部署结果，整理完同步到群里',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({ message: '今天部署结果：全部服务已完成检查。', source: 'suanlizi_chat', intent: 'announce_reply' }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(sendMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      text: '今天部署结果：全部服务已完成检查。',
    }));
  });

  it('forwards files from the current DingTalk DM attachment to the configured group', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const sendFile = vi.fn(async () => ({ ok: true }));
    const downloadFile = vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown, sendFile, downloadFile }) as unknown as DingtalkClient,
      currentUserText: '把这个文件发群里',
      currentAttachments: [{
        type: 'file',
        fileName: '方案.pdf',
        fileSize: 3,
        downloadCode: 'download-code-1',
      }],
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      fileMode: 'current_message_files',
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(downloadFile).toHaveBeenCalledWith({ downloadCode: 'download-code-1' });
    expect(sendFile).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: '2',
      conversationId: 'cid_group_target',
      fileName: '方案.pdf',
      fileBytes: new Uint8Array([1, 2, 3]),
      fileSize: 3,
    }));
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it('forwards current DingTalk DM images and sends an optional mentioned caption', async () => {
    const sendFile = vi.fn(async () => ({ ok: true }));
    const sendWebhookText = vi.fn(async () => ({ ok: true }));
    const downloadFile = vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: ['staff_xiemingzhi'] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendFile, sendWebhookText, downloadFile, searchContactUserIds }) as unknown as DingtalkClient,
      currentUserText: '把这个发送到群里，备注信息"好可爱的志志呀"，然后@谢明志',
      currentAttachments: [{
        type: 'image',
        fileName: 'msg-picture-1.jpg',
        fileSize: 3,
        downloadCode: 'download-code-1',
      }],
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      fileMode: 'current_message_files',
      message: '@谢明志 好可爱的志志呀',
      mentions: ['谢明志'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(downloadFile).toHaveBeenCalledWith({ downloadCode: 'download-code-1' });
    expect(sendFile).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: '2',
      conversationId: 'cid_group_target',
      fileName: 'msg-picture-1.jpg',
      fileBytes: new Uint8Array([1, 2, 3]),
      fileSize: 3,
    }));
    expect(searchContactUserIds).toHaveBeenCalledWith({ queryWord: '谢明志', fullMatch: true, size: 10 });
    expect(sendWebhookText).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
      text: '好可爱的志志呀',
      atStaffIds: ['staff_xiemingzhi'],
    }));
  });

  it('still forwards DingTalk DM attachments and caption when an optional file caption mention cannot be resolved', async () => {
    const sendFile = vi.fn(async () => ({ ok: true }));
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const downloadFile = vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) }));
    const searchContactUserIds = vi.fn(async () => ({ ok: true, userIds: [] }));
    const searchOrgUserIdsByName = vi.fn(async () => ({ ok: true, userIds: [] }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendFile, sendMarkdown, downloadFile, searchContactUserIds, searchOrgUserIdsByName }) as unknown as DingtalkClient,
      currentUserText: '把这个发送到群里，备注信息"好可爱的志志呀"，然后@谢明志',
      currentAttachments: [{
        type: 'image',
        fileName: 'msg-picture-1.jpg',
        fileSize: 3,
        downloadCode: 'download-code-1',
      }],
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      fileMode: 'current_message_files',
      message: '好可爱的志志呀',
      mentions: ['谢明志'],
      source: 'dingtalk_dm',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed' });
    expect(result?.output).toContain('已发送');
    expect(sendFile).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'msg-picture-1.jpg',
    }));
    expect(sendMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: '2',
      conversationId: 'cid_group_target',
      text: '好可爱的志志呀',
    }));
  });

  it('does not allow file forwarding outside DingTalk DM attachment context', async () => {
    const sendFile = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendFile }) as unknown as DingtalkClient,
      currentUserText: '把本地文件发群里',
      currentAttachments: [{
        type: 'file',
        fileName: '方案.pdf',
        fileSize: 3,
        downloadCode: 'download-code-1',
      }],
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({
      fileMode: 'current_message_files',
      source: 'suanlizi_chat',
      intent: 'send_message',
    }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'DINGTALK_FILE_FORWARD_DM_ONLY' },
    });
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('treats the tool call as the agent decision instead of keyword-checking the current user text', async () => {
    const sendMarkdown = vi.fn(async () => ({ ok: true }));
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown }) as unknown as DingtalkClient,
      currentUserText: '继续',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({ message: '冒个泡', source: 'dingtalk_dm', intent: 'send_message' }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({ status: 'completed', output: '已发送' });
    expect(sendMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      text: '冒个泡',
    }));
  });

  it('does not expose the old DingTalk send tool name as a callable tool', () => {
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown: vi.fn() }) as unknown as DingtalkClient,
      currentUserText: '发到群“打完我去打DD·”一条消息：“安博威的爸爸”',
    });

    expect(tools.map((item) => item.name)).toEqual([DINGTALK_TOOL_NAME]);
    expect(tools[0]?.parameters.properties).toHaveProperty('mentions');
    expect(tools[0]?.parameters.properties).not.toHaveProperty('mentionStaffIds');
  });

  it('returns a concise failure when DingTalk group sending fails', async () => {
    const tools = createDingtalkForwardTools({
      getConfig: async () => config(),
      createClient: () => ({ sendMarkdown: vi.fn(async () => ({ ok: false, error: 'HTTP 403' })) }) as unknown as DingtalkClient,
      currentUserText: '在群里发“冒个泡”',
    });
    const tool = tools.find((item) => item.name === DINGTALK_TOOL_NAME);

    const result = await tool?.execute({ message: '冒个泡' }, {
      workspaceRoot: '',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      status: 'failed',
      output: '发送失败：HTTP 403',
      error: { code: 'DINGTALK_GROUP_SEND_FAILED' },
    });
  });

  it('describes forwarding as a dedicated connector instead of local discovery work', () => {
    const prompt = dingtalkForwardingSystemPrompt('zh');

    expect(prompt).toContain(DINGTALK_TOOL_NAME);
    expect(prompt).toContain('不要搜索代码');
    expect(prompt).toContain('不要扫描端口');
    expect(prompt).toContain('不要调用 MCP');
    expect(prompt).toContain('连续对话');
  });
});
