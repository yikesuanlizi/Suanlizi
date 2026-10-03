// A2A AgentCard 构建器：根据 Suanlizi 配置生成符合 SDK AgentCard 接口的描述对象
// 英文说明：A2A AgentCard builder — produces an SDK-compliant AgentCard from Suanlizi config

import type { AgentCard, AgentCapabilities, AgentSkill, HTTPAuthSecurityScheme, SecurityScheme } from '@a2a-js/sdk';

// A2A 协议版本（与 @a2a-js/sdk 对齐）
// — Chinese: A2A protocol version aligned with @a2a-js/sdk
const A2A_PROTOCOL_VERSION = '0.3.0';

// 默认输入/输出 MIME 类型
// — Chinese: default input/output MIME types
const DEFAULT_INPUT_MODES = ['text/plain'];
const DEFAULT_OUTPUT_MODES = ['text/plain'];

/**
 * 安全方案类型：'bearer' 表示 HTTP Bearer JWT 认证；'none' 表示无需认证。
 * 用于在 AgentCard 中声明调用方必须遵守的认证方式。
 */
// — Chinese: security scheme kind: 'bearer' = HTTP Bearer JWT; 'none' = no auth required
export type SuanliziSecuritySchemeKind = 'bearer' | 'none';

/**
 * SuanliziAgentCardConfig — 构建 AgentCard 所需的配置。
 *
 * url 指向 A2A HTTP 端点（例如 https://host/api/a2a）。
 * skills 描述 Agent 可执行的能力（可选，默认提供一个通用对话 skill）。
 */
// — Chinese: SuanliziAgentCardConfig — configuration for building an AgentCard.
export interface SuanliziAgentCardConfig {
  /** Agent 的显示名称。 */
  name: string;
  /** Agent 的简短描述。 */
  description: string;
  /** A2A HTTP 端点 URL（必须为绝对 HTTPS URL，生产环境）。 */
  url: string;
  /** Agent 版本号（由 provider 定义格式）。 */
  version: string;
  /** 可选：提供商信息。 */
  provider?: { organization: string; url?: string };
  /** 可选：文档 URL。 */
  documentationUrl?: string;
  /** 可选：图标 URL。 */
  iconUrl?: string;
  /** 可选：skills 列表，默认提供一个通用对话 skill。 */
  skills?: AgentSkill[];
  /** 可选：是否支持流式响应，默认 true。 */
  streaming?: boolean;
  /** 可选：是否支持 push notifications，默认 false。 */
  pushNotifications?: boolean;
  /** 可选：是否支持 authenticated extended card，默认 false。 */
  supportsAuthenticatedExtendedCard?: boolean;
  /** 可选：preferredTransport，默认 'JSONRPC'。 */
  preferredTransport?: string;
  /**
   * 可选：声明 Agent 的认证要求。
   * - 'bearer'：声明调用方必须使用 HTTP Bearer JWT（Suanlizi token 模式下的默认）。
   * - 'none'：声明无需认证（Suanlizi auth=off 模式）。
   * - undefined：不在 AgentCard 中声明 security。
   */
  // — Chinese: declare auth requirement. 'bearer' = JWT required; 'none' = no auth; undefined = omit
  securityScheme?: SuanliziSecuritySchemeKind;
}

// 构造 HTTP Bearer JWT 安全方案 — Chinese: build HTTP Bearer JWT security scheme
function buildBearerSecurityScheme(): HTTPAuthSecurityScheme {
  return {
    type: 'http',
    scheme: 'Bearer',
    bearerFormat: 'JWT',
    description: 'HTTP Bearer authentication for deployments that provide their own gateway.',
  };
}

/**
 * 构建 A2A AgentCard。
 *
 * 若未提供 skills，则默认创建一个 "conversation" skill，
 * 表示该 Agent 可处理通用对话请求。
 */
// — Chinese: build an A2A AgentCard. Falls back to a default conversation skill.
export function buildAgentCard(config: SuanliziAgentCardConfig): AgentCard {
  const capabilities: AgentCapabilities = {
    streaming: config.streaming ?? true,
    pushNotifications: config.pushNotifications ?? false,
  };

  const skills: AgentSkill[] =
    config.skills && config.skills.length > 0
      ? config.skills
      : [
          {
            id: 'conversation',
            name: 'Conversation',
            description: 'General-purpose conversational agent powered by Suanlizi runtime',
            tags: ['conversation', 'chat', 'suanlizi'],
            inputModes: DEFAULT_INPUT_MODES,
            outputModes: DEFAULT_OUTPUT_MODES,
          },
        ];

  const card: AgentCard = {
    name: config.name,
    description: config.description,
    url: config.url,
    version: config.version,
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities,
    defaultInputModes: DEFAULT_INPUT_MODES,
    defaultOutputModes: DEFAULT_OUTPUT_MODES,
    skills,
    preferredTransport: config.preferredTransport ?? 'JSONRPC',
    supportsAuthenticatedExtendedCard: config.supportsAuthenticatedExtendedCard ?? false,
  };

  if (config.provider) {
    card.provider = {
      organization: config.provider.organization,
      url: config.provider.url ?? config.url,
    };
  }
  if (config.documentationUrl) card.documentationUrl = config.documentationUrl;
  if (config.iconUrl) card.iconUrl = config.iconUrl;

  // 根据配置声明安全方案（A2A 规范遵循 OpenAPI 3.0 Security Scheme Object）
  // — Chinese: declare security scheme per A2A spec (OpenAPI 3.0 Security Scheme Object)
  if (config.securityScheme === 'bearer') {
    const schemeName = 'suanliziBearerJwt';
    const scheme: SecurityScheme = buildBearerSecurityScheme();
    card.securitySchemes = { [schemeName]: scheme };
    // security 字段为 OR 关系的方案列表，此处仅声明一个方案
    // — Chinese: security field is an OR list; we declare only one scheme
    card.security = [{ [schemeName]: [] }];
  } else if (config.securityScheme === 'none') {
    // 显式声明无需认证 — Chinese: explicitly declare no auth required
    card.security = [];
  }

  return card;
}
