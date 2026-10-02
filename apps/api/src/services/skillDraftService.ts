// Skill 草拟与安装回复（从 server.ts 拆出，§5：server.ts 只做路由装配）。
// 模型调用与安装动作本身仍由注入的工厂/服务承担，本模块只负责提示词组装、
// 结构化结果兜底与失败 turn items 构造，保持与既有行为逐字一致。
// — Chinese: skill draft / install reply helpers extracted from server.ts.

import type { ThreadItem } from '@suanlizi/protocol';
import type { ModelGateway } from '@suanlizi/model-gateway';
import type { AgentRunConfig } from '../config/config.js';
import {
  buildSkillDraftSystemPrompt,
  createTemplateSkillDraft,
  prepareSkillDraftRequest,
  safeGeneratedSkillDraft,
  type InstallSkillsResult,
  type SkillDraft,
} from './skills.js';
import type { TenantContext } from '../shared/tenant.js';

/** 从模型自由文本里取出第一个 JSON 对象；解析失败返回 null（不猜测）。 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface SkillDraftServiceDeps {
  /** 取一个可 chat 的模型（server 侧注入 tenantRuntime.createAgent 的 model 面）。 */
  createModel: (
    configPatch: Partial<AgentRunConfig> | undefined,
    tenantContext: TenantContext,
  ) => Promise<ModelGateway>;
  defaultTenantContext: TenantContext;
}

export interface SkillDraftResult {
  draft: SkillDraft;
  source: 'model' | 'template';
  error?: string;
}

export interface SkillDraftService {
  draft(description: string, configPatch?: Partial<AgentRunConfig>, tenantContext?: TenantContext): Promise<SkillDraftResult>;
}

export function createSkillDraftService(deps: SkillDraftServiceDeps): SkillDraftService {
  async function draft(
    description: string,
    configPatch: Partial<AgentRunConfig> | undefined,
    tenantContext: TenantContext = deps.defaultTenantContext,
  ): Promise<SkillDraftResult> {
    const locale = configPatch?.locale ?? 'zh';
    const prepared = await prepareSkillDraftRequest(description);
    const templateDraft = createTemplateSkillDraft(prepared, locale);

    try {
      const model = await deps.createModel(configPatch, tenantContext);
      const response = await model.chat({
        messages: [
          { role: 'system', content: buildSkillDraftSystemPrompt(locale) },
          { role: 'user', content: prepared.prompt },
        ],
        tool_choice: 'none',
        max_tokens: 1200,
        temperature: 0.2,
      });
      const text = String(response.choices[0]?.message.content ?? '');
      const json = extractJsonObject(text);
      return {
        draft: safeGeneratedSkillDraft(json, prepared, templateDraft),
        source: 'model',
      };
    } catch (error) {
      return {
        draft: templateDraft,
        source: 'template',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { draft };
}

/** 安装成功后的自然语言回复：模型可用则润色，否则回落到固定文案。 */
export async function createSkillInstallReply(
  model: ModelGateway,
  result: InstallSkillsResult,
  inputText: string,
  locale: AgentRunConfig['locale'],
): Promise<string> {
  const fallback = fallbackSkillInstallReply(result, locale);
  try {
    const response = await model.chat({
      messages: [
        {
          role: 'system',
          content: locale === 'zh'
            ? '你是 Suanlizi。根据工具安装结果，用中文简洁回答用户。不要编造未安装的 Skill。'
            : 'You are Suanlizi. Reply concisely in English based on the skill installation result. Do not invent skills that were not installed.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            command: inputText,
            skillsRoot: result.skillsRoot,
            installed: result.installed.map((skill) => ({
              name: skill.name,
              sourcePath: skill.sourcePath,
              path: skill.path,
            })),
          }, null, 2),
        },
      ],
      tool_choice: 'none',
      max_tokens: 300,
      temperature: 0.2,
    });
    const text = String(response.choices[0]?.message.content ?? '').trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

export function fallbackSkillInstallReply(result: InstallSkillsResult, locale: AgentRunConfig['locale']): string {
  const names = result.installed.map((skill) => skill.name).join(', ');
  if (locale === 'en') {
    return `Installed ${result.installed.length} skill(s): ${names || 'none'}.`;
  }
  return `已安装 ${result.installed.length} 个 Skill：${names || '无'}。`;
}

/** 安装失败也必须落可追溯的 turn items（错误可接管，不留空白回复）。 */
export function createSkillInstallFailureItems(
  turnId: string,
  input: string,
  message: string,
  timestamp: string,
  installUrls: string[] = [],
): ThreadItem[] {
  const skillUrl = input.replace(/^\/skills\s+add\s+/i, '').trim();
  return [
    {
      id: `${turnId}_item_0`,
      type: 'user_message',
      turnId,
      text: input,
      timestamp,
    },
    {
      id: `${turnId}_item_1`,
      type: 'tool_call',
      turnId,
      toolName: 'skills_add',
      arguments: {
        input: skillUrl,
        ...(installUrls.length > 0 ? { urls: installUrls } : {}),
      },
      error: { message },
      status: 'failed',
      timestamp,
    },
    {
      id: `${turnId}_item_2`,
      type: 'error',
      turnId,
      message,
      timestamp,
    },
  ];
}

/** 归一化 `/skills add` 的 URL 列表：去空、去重、保持入参顺序。 */
export function skillInstallUrlsFromBody(body: { url?: string; urls?: string[] }): string[] {
  const candidates = Array.isArray(body.urls) ? body.urls : [body.url ?? ''];
  return candidates
    .map((value) => String(value).trim())
    .filter(Boolean)
    .filter((value, index, current) => current.indexOf(value) === index);
}
