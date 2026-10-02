import { adaptMarkdownForDingtalk } from './markdown.js';
import { DingtalkStreamClient } from './streamClient.js';
import { DingtalkTokenManager } from './token.js';
import {
  CONVERSATION_TYPE_GROUP,
  CONVERSATION_TYPE_P2P,
  DINGTALK_API_BASE,
  DINGTALK_OAPI_BASE,
  MAX_UPLOAD_SIZE_BYTES,
  type DingtalkAICardCreateOptions,
  type DingtalkAICardCreateResult,
  type DingtalkAICardFinalizeOptions,
  type DingtalkAICardUpdateOptions,
  type DingtalkClientOptions,
  type DingtalkDownloadFileOptions,
  type DingtalkDownloadFileResult,
  type DingtalkInboundMessage,
  type DingtalkMessageAttachment,
  type DingtalkReplyWithCardOptions,
  type DingtalkSearchContactUserIdsOptions,
  type DingtalkSearchContactUserIdsResult,
  type DingtalkSearchOrgUserIdsByNameOptions,
  type DingtalkSearchOrgUserIdsByNameResult,
  type DingtalkSendBaseOptions,
  type DingtalkSendCardOptions,
  type DingtalkSendFileOptions,
  type DingtalkSendResult,
  type DingtalkSendTextOptions,
  type DingtalkSendWebhookTextOptions,
  type DingtalkStartStreamResult,
  type DingtalkWebhookEvent,
} from './types.js';

export type DingtalkMessageHandler = (msg: DingtalkInboundMessage) => void | Promise<void>;
export type DingtalkStatusHandler = (status: 'connecting' | 'connected' | 'disconnected' | 'error', detail?: string) => void;

export class DingtalkClient {
  private readonly options: DingtalkClientOptions;
  private readonly tokenManager: DingtalkTokenManager;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly robotCode: string;
  private streamClient: DingtalkStreamClient | null = null;
  private messageHandler: DingtalkMessageHandler | null = null;
  private statusHandler: DingtalkStatusHandler | null = null;
  private running = false;

  constructor(options: DingtalkClientOptions) {
    this.options = options;
    this.tokenManager = new DingtalkTokenManager(options);
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.robotCode = options.robotCode?.trim() || options.clientId;
  }

  setMessageHandler(handler: DingtalkMessageHandler | null): void {
    this.messageHandler = handler;
  }

  setStatusHandler(handler: DingtalkStatusHandler | null): void {
    this.statusHandler = handler;
  }

  get isStreamRunning(): boolean {
    return this.running && this.streamClient !== null && this.streamClient.isConnected;
  }

  async startStream(): Promise<DingtalkStartStreamResult> {
    if (this.running && this.streamClient) {
      return { connected: this.streamClient.isConnected };
    }
    this.running = true;
    if (!this.messageHandler) {
      return { connected: false, error: 'No message handler set' };
    }
    this.streamClient = new DingtalkStreamClient({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      getToken: () => this.tokenManager.getToken(),
      timeoutMs: this.timeoutMs,
      onMessage: (msg) => {
        if (this.messageHandler) {
          void this.messageHandler(msg);
        }
      },
      onStatus: (status, detail) => {
        this.statusHandler?.(status, detail);
      },
    });
    const result = await this.streamClient.start();
    if (!result.connected) {
      this.running = false;
      this.streamClient = null;
    }
    return result;
  }

  stopStream(): void {
    this.running = false;
    if (this.streamClient) {
      this.streamClient.stop();
      this.streamClient = null;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; tokenValid: boolean; error?: string }> {
    try {
      await this.tokenManager.getToken();
      return { ok: true, tokenValid: true };
    } catch (error) {
      return {
        ok: false,
        tokenValid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async sendMarkdown(options: DingtalkSendTextOptions): Promise<DingtalkSendResult> {
    return this.sendMessage('sampleMarkdown', {
      title: 'Suanlizi',
      text: adaptMarkdownForDingtalk(options.text),
    }, options);
  }

  // ===== AI Card 接口 =====
  // 创建卡片实例（对应钉钉 v1.0/card/instances）
  async createAICard(options: DingtalkAICardCreateOptions): Promise<DingtalkAICardCreateResult> {
    const token = await this.tokenManager.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const outTrackId = options.outTrackId ?? `suanlizi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const body: Record<string, unknown> = {
        cardTemplateId: options.cardTemplateId,
        outTrackId,
        robotCode: this.robotCode,
      };
      if (options.conversationType === CONVERSATION_TYPE_GROUP && options.conversationId) {
        body.openConversationId = options.conversationId;
      }
      const response = await this.fetchImpl(`${DINGTALK_API_BASE}/v1.0/card/instances`, {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `createAICard HTTP ${response.status}: ${errText}` };
      }
      const data = await response.json() as { cardInstanceId?: string; outTrackId?: string };
      if (!data.cardInstanceId) {
        return { ok: false, error: 'createAICard returned empty cardInstanceId' };
      }
      return { ok: true, cardInstanceId: data.cardInstanceId };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: 'createAICard timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  // 发送已创建的卡片实例（使用 sampleAICard 消息类型）
  async sendAICard(options: DingtalkSendCardOptions): Promise<DingtalkSendResult> {
    return this.sendMessage('sampleAICard', {
      cardTemplateId: options.cardTemplateId,
      cardInstanceId: options.cardInstanceId,
    }, options);
  }

  // 流式更新卡片内容（markdown 增量/全量替换）
  async updateAICard(options: DingtalkAICardUpdateOptions): Promise<DingtalkSendResult> {
    const token = await this.tokenManager.getOapiToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${DINGTALK_API_BASE}/v1.0/card/instances/${encodeURIComponent(options.cardInstanceId)}/content`,
        {
          method: 'PUT',
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: options.content,
            contentType: options.contentType ?? 'markdown',
            append: options.append === true,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `updateAICard HTTP ${response.status}: ${errText}` };
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: 'updateAICard timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  // 标记卡片为最终完成状态（停止"正在输入"指示）
  async finalizeAICard(options: DingtalkAICardFinalizeOptions): Promise<DingtalkSendResult> {
    const token = await this.tokenManager.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${DINGTALK_API_BASE}/v1.0/card/instances/${encodeURIComponent(options.cardInstanceId)}/flow`,
        {
          method: 'POST',
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ final: true }),
          signal: controller.signal,
        },
      );
      // 部分钉钉版本可能不支持 flow 接口，404 视为成功（卡片已经 send 出去）
      if (!response.ok && response.status !== 404) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `finalizeAICard HTTP ${response.status}: ${errText}` };
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: 'finalizeAICard timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  // 高阶便捷方法：创建卡片 → 发送 thinking 占位 → 更新为最终 markdown → finalize
  // 任意步骤失败都返回 ok:false，调用方可 fallback 到 sendMarkdown
  async replyWithAICardMarkdown(options: DingtalkReplyWithCardOptions): Promise<DingtalkSendResult> {
    const { cardTemplateId, thinkingText, markdown, conversationType, conversationId } = options;
    const createResult = await this.createAICard({ cardTemplateId, conversationType, conversationId });
    if (!createResult.ok || !createResult.cardInstanceId) {
      return { ok: false, error: `create card failed: ${createResult.error ?? 'unknown'}` };
    }
    const cardInstanceId = createResult.cardInstanceId;
    const sendResult = await this.sendAICard({
      cardTemplateId,
      cardInstanceId,
      conversationType,
      conversationId,
    });
    if (!sendResult.ok) {
      return { ok: false, cardInstanceId, error: `send card failed: ${sendResult.error ?? 'unknown'}` };
    }
    // 如果有 thinkingText，先发一个思考中状态；然后更新为最终内容
    if (thinkingText) {
      await this.updateAICard({ cardInstanceId, content: thinkingText, contentType: 'text' }).catch(() => { /* ignore */ });
    }
    const adapted = adaptMarkdownForDingtalk(markdown);
    const updateResult = await this.updateAICard({ cardInstanceId, content: adapted, contentType: 'markdown' });
    if (!updateResult.ok) {
      return { ok: false, cardInstanceId, messageId: sendResult.messageId, error: `update card failed: ${updateResult.error ?? 'unknown'}` };
    }
    await this.finalizeAICard({ cardInstanceId }).catch(() => { /* ignore finalize errors */ });
    return { ok: true, cardInstanceId, messageId: sendResult.messageId };
  }

  async sendText(options: DingtalkSendTextOptions): Promise<DingtalkSendResult> {
    return this.sendMessage('sampleText', { content: options.text }, options);
  }

  async sendWebhookText(options: DingtalkSendWebhookTextOptions): Promise<DingtalkSendResult> {
    const webhookUrl = options.webhookUrl.trim();
    if (!webhookUrl) return { ok: false, error: 'DingTalk sessionWebhook is required' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: options.text },
          ...(options.atStaffIds?.length ? { at: { atUserIds: options.atStaffIds, isAtAll: false } } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `DingTalk webhook HTTP ${response.status}: ${errText}` };
      }
      const data = await response.json().catch(() => ({})) as { errcode?: number; errmsg?: string };
      if (typeof data.errcode === 'number' && data.errcode !== 0) {
        return { ok: false, error: `DingTalk webhook error ${data.errcode}: ${data.errmsg ?? 'unknown error'}` };
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: 'DingTalk webhook timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async searchContactUserIds(options: DingtalkSearchContactUserIdsOptions): Promise<DingtalkSearchContactUserIdsResult> {
    const queryWord = options.queryWord.trim();
    if (!queryWord) return { ok: false, error: 'queryWord is required' };
    const token = await this.tokenManager.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${DINGTALK_API_BASE}/v1.0/contact/users/search`, {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          queryWord,
          fullMatch: options.fullMatch ?? true,
          size: options.size ?? 10,
          offset: options.offset ?? 0,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `searchContactUserIds HTTP ${response.status}: ${errText}` };
      }
      const data = await response.json() as { list?: unknown };
      const userIds = Array.isArray(data.list)
        ? data.list.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
        : [];
      return { ok: true, userIds };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: 'searchContactUserIds timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async searchOrgUserIdsByName(options: DingtalkSearchOrgUserIdsByNameOptions): Promise<DingtalkSearchOrgUserIdsByNameResult> {
    const name = options.name.trim();
    if (!name) return { ok: false, error: 'name is required' };
    const token = await this.tokenManager.getOapiToken();
    const rootDeptId = options.rootDeptId ?? 1;
    const maxDepartments = options.maxDepartments ?? 200;
    const queue: number[] = [rootDeptId];
    const seen = new Set<number>();
    const matches: string[] = [];
    try {
      while (queue.length && seen.size < maxDepartments) {
        const deptId = queue.shift();
        if (typeof deptId !== 'number' || !Number.isFinite(deptId) || seen.has(deptId)) continue;
        seen.add(deptId);

        const users = await this.listSimpleUsersInDepartment(token, deptId);
        if (!users.ok) return { ok: false, error: users.error };
        for (const user of users.users ?? []) {
          if (normalizeDingtalkName(user.name) === normalizeDingtalkName(name) && user.userId) {
            matches.push(user.userId);
          }
        }

        const children = await this.listSubDepartmentIds(token, deptId);
        if (!children.ok) return { ok: false, error: children.error };
        for (const childId of children.departmentIds ?? []) {
          if (!seen.has(childId)) queue.push(childId);
        }
      }
      return { ok: true, userIds: mergeUniqueStrings(matches) };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: 'searchOrgUserIdsByName timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendFile(options: DingtalkSendFileOptions): Promise<DingtalkSendResult> {
    const fileSize = options.fileSize ?? (options.fileBytes?.length ?? 0);
    if (fileSize > MAX_UPLOAD_SIZE_BYTES) {
      return { ok: false, error: `File too large: ${fileSize} bytes (max ${MAX_UPLOAD_SIZE_BYTES})` };
    }

    let bytes: Uint8Array;
    if (options.fileBytes) {
      bytes = options.fileBytes;
    } else {
      if (!options.filePath) {
        return { ok: false, error: 'filePath or fileBytes is required' };
      }
      try {
        const fs = await import('node:fs/promises');
        bytes = new Uint8Array(await fs.readFile(options.filePath));
      } catch (error) {
        return { ok: false, error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    const isImage = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(options.fileName);
    const upload = await this.uploadMedia(bytes, options.fileName, isImage ? 'image' : 'file');
    if (!upload.ok || !upload.mediaId) {
      return { ok: false, error: `Failed to upload media${upload.error ? `: ${upload.error}` : ''}` };
    }
    const mediaId = upload.mediaId;

    if (isImage) {
      return this.sendMessage('sampleImageMsg', { photoURL: mediaId }, options);
    }
    return this.sendMessage('sampleFile', {
      fileUrl: mediaId,
      fileName: options.fileName,
      fileSize: String(bytes.length),
    }, options);
  }

  async downloadFile(options: DingtalkDownloadFileOptions): Promise<DingtalkDownloadFileResult> {
    const downloadCode = options.downloadCode.trim();
    if (!downloadCode) return { ok: false, error: 'downloadCode is required' };
    const token = await this.tokenManager.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${DINGTALK_API_BASE}/v1.0/robot/messageFiles/download`, {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          downloadCode,
          robotCode: this.robotCode,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `downloadFile HTTP ${response.status}: ${errText}` };
      }
      const data = await response.json() as { downloadUrl?: string };
      const downloadUrl = data.downloadUrl?.trim();
      if (!downloadUrl) return { ok: false, error: 'downloadFile returned empty downloadUrl' };
      const fileResponse = await this.fetchImpl(downloadUrl, { method: 'GET', signal: controller.signal });
      if (!fileResponse.ok) {
        const errText = await fileResponse.text().catch(() => '');
        return { ok: false, error: `downloadFile bytes HTTP ${fileResponse.status}: ${errText}` };
      }
      return { ok: true, bytes: new Uint8Array(await fileResponse.arrayBuffer()) };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: 'downloadFile timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  parseWebhookEvent(body: unknown): DingtalkInboundMessage | null {
    if (!body || typeof body !== 'object') return null;
    const raw = body as DingtalkWebhookEvent;
    const conversationType = raw.conversationType === '2' ? CONVERSATION_TYPE_GROUP : CONVERSATION_TYPE_P2P;
    const conversationId = raw.conversationId ?? '';
    const senderStaffId = raw.senderStaffId ?? raw.senderId ?? '';
    const messageId = raw.msgId ?? '';
    let text = '';
    if (raw.text?.content) {
      text = raw.text.content.trim();
    } else if (typeof (raw as Record<string, unknown>).content === 'string') {
      text = String((raw as Record<string, unknown>).content).trim();
    }
    const attachments = parseDingtalkAttachments(raw as Record<string, unknown>);
    if (!text && attachments.length) {
      text = attachments.map((item) => item.fileName).join(' ').trim();
    }
    const atUsers = Array.isArray(raw.atUsers)
      ? raw.atUsers.filter((u): u is { dingtalkId: string; staffId?: string } => u !== null && typeof u === 'object' && 'dingtalkId' in u)
      : [];
    const chatbotUserId = raw.chatbotUserId ?? '';
    const isAtBot = chatbotUserId
      ? atUsers.some((u) => u.dingtalkId === chatbotUserId) || Boolean(raw.isInAtList)
      : false;

    if (!text || !messageId) return null;
    if (conversationType === CONVERSATION_TYPE_GROUP && !isAtBot) return null;

    return {
      conversationType,
      conversationId: conversationType === CONVERSATION_TYPE_GROUP ? conversationId : senderStaffId,
      senderStaffId,
      senderNick: raw.senderNick ?? '',
      messageId,
      text: stripBotMention(text, chatbotUserId),
      messageType: attachments.some((item) => item.type === 'file') ? 'file' : attachments.length ? 'image' : 'text',
      isAtBot: true,
      atUsers,
      sessionWebhook: typeof raw.sessionWebhook === 'string' ? raw.sessionWebhook.trim() : undefined,
      ...(attachments.length ? { attachments } : {}),
    };
  }

  private async sendMessage(
    msgKey: string,
    msgParam: Record<string, unknown>,
    options: DingtalkSendBaseOptions,
  ): Promise<DingtalkSendResult> {
    const token = await this.tokenManager.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let url: string;
      const body: Record<string, unknown> = {
        msgKey,
        msgParam: JSON.stringify(msgParam),
        robotCode: this.robotCode,
      };
      if (options.conversationType === CONVERSATION_TYPE_GROUP) {
        url = `${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`;
        body.openConversationId = options.conversationId;
        if (options.atStaffIds?.length) {
          body.at = {
            atUserIds: options.atStaffIds,
            isAtAll: false,
          };
        }
      } else {
        url = `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`;
        body.userIds = [options.conversationId];
      }
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `DingTalk API HTTP ${response.status}: ${errText}` };
      }
      const data = await response.json() as { processQueryKey?: string; messageId?: string };
      return { ok: true, processQueryKey: data.processQueryKey, messageId: data.messageId };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: 'Request timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async uploadMedia(bytes: Uint8Array, fileName: string, mediaType: 'image' | 'file'): Promise<{
    ok: boolean;
    mediaId?: string;
    error?: string;
  }> {
    const token = await this.tokenManager.getOapiToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const url = new URL(`${DINGTALK_OAPI_BASE}/media/upload`);
      url.searchParams.set('access_token', token);
      url.searchParams.set('type', mediaType);
      const form = new FormData();
      const blob = new Blob([bytes]);
      form.append('media', blob, fileName);
      const response = await this.fetchImpl(url, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `/media/upload HTTP ${response.status}: ${errText}` };
      }
      const data = await response.json() as { errcode?: number; errmsg?: string; media_id?: string; mediaId?: string };
      if (typeof data.errcode === 'number' && data.errcode !== 0) {
        return { ok: false, error: `/media/upload error ${data.errcode}: ${data.errmsg ?? 'unknown error'}` };
      }
      const mediaId = data.media_id ?? data.mediaId;
      if (!mediaId) return { ok: false, error: '/media/upload returned empty media_id' };
      return { ok: true, mediaId };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: '/media/upload timeout' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async listSimpleUsersInDepartment(token: string, deptId: number): Promise<{
    ok: boolean;
    users?: Array<{ userId: string; name: string }>;
    error?: string;
  }> {
    const users: Array<{ userId: string; name: string }> = [];
    let cursor = 0;
    for (let page = 0; page < 50; page++) {
      const data = await this.postOapi(token, '/topapi/user/listsimple', {
        dept_id: String(deptId),
        cursor: String(cursor),
        size: '100',
        contain_access_limit: 'true',
      });
      if (!data.ok) return { ok: false, error: data.error };
      const result = asRecord(data.body.result);
      const list = Array.isArray(result.list) ? result.list : [];
      for (const item of list) {
        const record = asRecord(item);
        const userId = normalizeTextRecordValue(record.userid ?? record.userId);
        const name = normalizeTextRecordValue(record.name);
        if (userId && name) users.push({ userId, name });
      }
      if (result.has_more !== true) break;
      const nextCursor = Number(result.next_cursor ?? result.nextCursor);
      if (!Number.isFinite(nextCursor) || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return { ok: true, users };
  }

  private async listSubDepartmentIds(token: string, deptId: number): Promise<{
    ok: boolean;
    departmentIds?: number[];
    error?: string;
  }> {
    const data = await this.postOapi(token, '/topapi/v2/department/listsubid', {
      dept_id: String(deptId),
    });
    if (!data.ok) return { ok: false, error: data.error };
    return { ok: true, departmentIds: parseDepartmentIds(data.body.result) };
  }

  private async postOapi(token: string, path: string, body: Record<string, string>): Promise<{
    ok: boolean;
    body: Record<string, unknown>;
    error?: string;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = `${DINGTALK_OAPI_BASE}${path}?access_token=${encodeURIComponent(token)}`;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
        body: new URLSearchParams(body).toString(),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, body: {}, error: `${path} HTTP ${response.status}: ${errText}` };
      }
      const data = await response.json() as Record<string, unknown>;
      if (typeof data.errcode === 'number' && data.errcode !== 0) {
        return { ok: false, body: data, error: `${path} error ${data.errcode}: ${normalizeTextRecordValue(data.errmsg) || 'unknown error'}` };
      }
      return { ok: true, body: data };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface DingtalkAICardStreamOptions {
  cardTemplateId: string;
  conversationType: string;
  conversationId: string;
  thinkingText?: string;
  throttleMs?: number;
  errorFallbackText?: string;
}

export type DingtalkAICardStreamStatus = 'pending' | 'active' | 'finalized' | 'failed';

/**
 * AI Card 流式会话：创建卡片→发送思考中→按节流频率把累积文本 push 到卡片→结束时 finalize。
 * 任何步骤失败都会把 status 置为 failed，调用方应 fallback 到 Markdown 重发整条消息。
 *
 * Chinese: stream session for AI cards; throttles updates to avoid API rate limits.
 */
export class DingtalkAICardStream {
  private readonly client: DingtalkClient;
  private readonly options: Required<Omit<DingtalkAICardStreamOptions, 'errorFallbackText'>> & { errorFallbackText?: string };
  private cardInstanceId: string | null = null;
  private buffer = '';
  private flushedLength = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private closed = false;
  private initPromise: Promise<boolean> | null = null;
  private _status: DingtalkAICardStreamStatus = 'pending';
  private lastError: string | null = null;

  constructor(client: DingtalkClient, options: DingtalkAICardStreamOptions) {
    this.client = client;
    this.options = {
      cardTemplateId: options.cardTemplateId,
      conversationType: options.conversationType,
      conversationId: options.conversationId,
      thinkingText: options.thinkingText ?? '思考中...',
      throttleMs: options.throttleMs ?? 400,
      errorFallbackText: options.errorFallbackText,
    };
  }

  get status(): DingtalkAICardStreamStatus { return this._status; }
  get cardId(): string | null { return this.cardInstanceId; }
  get error(): string | null { return this.lastError; }

  /** 启动会话：创建卡片并发送思考中占位。返回是否成功。 */
  async start(): Promise<boolean> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<boolean> {
    try {
      const createResult = await this.client.createAICard({
        cardTemplateId: this.options.cardTemplateId,
        conversationType: this.options.conversationType,
        conversationId: this.options.conversationId,
      });
      if (!createResult.ok || !createResult.cardInstanceId) {
        this.fail(createResult.error ?? 'create card failed');
        return false;
      }
      this.cardInstanceId = createResult.cardInstanceId;
      const sendResult = await this.client.sendAICard({
        cardTemplateId: this.options.cardTemplateId,
        cardInstanceId: this.cardInstanceId,
        conversationType: this.options.conversationType,
        conversationId: this.options.conversationId,
      });
      if (!sendResult.ok) {
        this.fail(sendResult.error ?? 'send card failed');
        return false;
      }
      // 先推送 thinking 占位
      await this.client.updateAICard({
        cardInstanceId: this.cardInstanceId,
        content: this.options.thinkingText,
        contentType: 'text',
      }).catch(() => { /* non-fatal */ });
      this._status = 'active';
      return true;
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /** 追加一段增量文本（通常对应一个 token chunk）。首次调用会自动 start()。 */
  append(delta: string): void {
    if (this.closed || this._status === 'failed') return;
    if (!delta) return;
    this.buffer += delta;
    // 首次 append 时懒启动
    if (!this.initPromise) {
      void this.start();
    }
    this.scheduleFlush();
  }

  /** 结束流：以 markdown 渲染推送最终完整内容并 finalize。 */
  async finalize(finalMarkdown?: string): Promise<boolean> {
    if (this._status === 'failed') return false;
    if (!this.cardInstanceId) {
      const ok = await this.start();
      if (!ok || !this.cardInstanceId) return false;
    }
    const cardInstanceId: string = this.cardInstanceId;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const finalRaw = finalMarkdown ?? this.buffer;
    this.buffer = finalRaw;
    this.flushing = true;
    try {
      // finalize 阶段用完整 markdown 渲染一次，覆盖流式阶段的 text 占位
      // Chinese translation: final push uses markdown renderer for proper formatting
      await this.client.updateAICard({
        cardInstanceId,
        content: adaptMarkdownForDingtalk(finalRaw),
        contentType: 'markdown',
      });
      this.flushedLength = finalRaw.length;
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.flushing = false;
    }
    await this.client.finalizeAICard({ cardInstanceId }).catch(() => { /* ignore */ });
    this._status = 'finalized';
    return true;
  }

  /** 失败时标记卡片为错误（可选展示错误文案）。 */
  async abort(reason?: string): Promise<void> {
    if (this._status === 'finalized' || this._status === 'failed') return;
    this.fail(reason ?? 'aborted');
    if (this.cardInstanceId) {
      const fallback = this.options.errorFallbackText ?? `出错了：${reason ?? 'unknown'}`;
      await this.client.updateAICard({
        cardInstanceId: this.cardInstanceId,
        content: fallback,
        contentType: 'text',
      }).catch(() => { /* ignore */ });
      await this.client.finalizeAICard({ cardInstanceId: this.cardInstanceId }).catch(() => { /* ignore */ });
    }
  }

  private scheduleFlush(): void {
    if (this.flushing || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, this.options.throttleMs);
  }

  private async flushNow(): Promise<void> {
    if (!this.cardInstanceId || this.flushing) return;
    const text = this.buffer;
    if (text.length === this.flushedLength) return;
    this.flushing = true;
    try {
      // 流式阶段用纯 text 推送（markdown 语法没闭合时直接渲染会很丑），
      // finalize 时会再用完整 markdown 覆盖一次。
      await this.client.updateAICard({
        cardInstanceId: this.cardInstanceId,
        content: text,
        contentType: 'text',
      });
      this.flushedLength = text.length;
    } catch {
      // 单次 flush 失败不终止会话；下次 flush / finalize 会再覆盖
    } finally {
      this.flushing = false;
      // 如果 flush 期间又追加了新内容，再排一次
      if (this.buffer.length !== this.flushedLength && !this.closed) {
        this.scheduleFlush();
      }
    }
  }

  private fail(reason: string): void {
    this._status = 'failed';
    this.lastError = reason;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

function stripBotMention(text: string, botId: string): string {
  let result = text;
  if (botId) {
    result = result.replace(new RegExp(`@${botId}\\s*`, 'g'), '');
  }
  return result.trim();
}

function parseDingtalkAttachments(body: Record<string, unknown>): DingtalkMessageAttachment[] {
  const candidates = [
    body.fileContent,
    body.file,
    body.fileMessage,
    body.imageContent,
    body.image,
    body.picture,
    body.attachment,
  ];
  const attachments: DingtalkMessageAttachment[] = [];
  for (const candidate of candidates) {
    const attachment = parseDingtalkAttachment(candidate);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

function parseDingtalkAttachment(value: unknown): DingtalkMessageAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const fileName = normalizeTextRecordValue(record.fileName ?? record.name ?? record.filename);
  const downloadCode = normalizeTextRecordValue(record.downloadCode ?? record.download_code);
  const downloadUrl = normalizeTextRecordValue(record.downloadUrl ?? record.download_url);
  const mediaId = normalizeTextRecordValue(record.mediaId ?? record.media_id);
  if (!fileName || (!downloadCode && !downloadUrl && !mediaId)) return null;
  const fileSize = Number(record.fileSize ?? record.size);
  const mimeType = normalizeTextRecordValue(record.mimeType ?? record.contentType);
  const type = /\.(png|jpe?g|gif|webp|bmp)$/i.test(fileName) || normalizeTextRecordValue(record.type).toLowerCase().includes('image')
    ? 'image'
    : 'file';
  return {
    type,
    fileName,
    ...(Number.isFinite(fileSize) ? { fileSize } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(downloadCode ? { downloadCode } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(mediaId ? { mediaId } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizeTextRecordValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function normalizeDingtalkName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').trim();
}

function parseDepartmentIds(value: unknown): number[] {
  const record = asRecord(value);
  const raw: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(record.dept_id_list)
      ? record.dept_id_list
      : Array.isArray(record.deptIdList)
        ? record.deptIdList
        : [];
  return raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function mergeUniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
