import type { ThreadId } from '@suanlizi/protocol';

export type BotPlatform = 'weixin' | 'feishu' | 'dingtalk' | 'wechat-work' | 'qq';
export type BotChatType = 'dm' | 'group';
export type BotTurnStatus = 'completed' | 'duplicate' | 'busy' | 'failed';

export interface BotInboundMessage {
  platform: BotPlatform;
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  messageId: string;
  chatType: BotChatType;
  threadId?: string;
  attachments?: Array<{
    type: 'file' | 'image';
    fileName: string;
    fileSize?: number;
    mimeType?: string;
    downloadCode?: string;
    downloadUrl?: string;
    mediaId?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface BotOutboundMessage {
  platform: BotPlatform;
  chatId: string;
  text: string;
  accountId?: string;
  threadId?: ThreadId;
  metadata?: Record<string, unknown>;
}

export interface BotTurnResult {
  status: BotTurnStatus;
  threadId?: ThreadId;
  reply?: string;
  error?: string;
}

export interface BotSession {
  key: string;
  platform: BotPlatform;
  chatId: string;
  chatType: BotChatType;
  threadId: ThreadId;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotSessionState {
  sessions: BotSession[];
}

export interface BotDedupeEntry {
  key: string;
  seenAt: string;
}

export interface BotDedupeState {
  entries: BotDedupeEntry[];
}

export interface BotRunContext {
  platform: BotPlatform;
  chatId: string;
  chatType: BotChatType;
  userId: string;
  userName: string;
  messageId: string;
  sessionKey: string;
}

export interface BotRunResult {
  text: string;
}

export interface WeixinBridgeClientOptions {
  rpcUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WeixinLoginStartResult {
  ok?: boolean;
  qrDataUrl?: string;
  qrcode?: string;
  qrcodeUrl?: string;
  sessionKey: string;
  message?: string;
}

export interface WeixinLoginWaitResult {
  connected: boolean;
  accountId?: string;
  sessionKey?: string;
  message?: string;
}

export type WeixinBridgeSendResult =
  | { ok: true; messageId: string }
  | { ok: false; message: string };
