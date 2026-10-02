// 工具搜索能力：为 delayed binding 模式提供基于语义关键词的工具查询与可见工具绑定。
import { ToolRegistry, type ToolDefinition } from '@suanlizi/tools';

// TOOL_SEARCH_TOOL_NAME：内部工具搜索工具的固定名称
export const TOOL_SEARCH_TOOL_NAME = 'tool_search';

// ToolSearchRuntimeOptions：创建 tool_search 工具时的运行时配置
export interface ToolSearchRuntimeOptions {
  /** 单次搜索可返回的工具数量上限（0 或正数）。 */
  maxResults: number;
}

// ToolSearchResultData：tool_search 返回给模型的数据结构
export interface ToolSearchResultData {
  /** 用户/模型输入的原始查询字符串。 */
  query: string;
  /** 匹配到的工具列表，包含名称、描述、权限要求以及工具参数 schema。 */
  tools: Array<{
    name: string;
    description: string;
    requiredPolicy: string;
    requiresApproval: boolean;
    parameters: unknown;
  }>;
}

// INTERNAL_TOOL_NAMES：不对外开放的内部工具名集合（避免自我搜索）
const INTERNAL_TOOL_NAMES = new Set([TOOL_SEARCH_TOOL_NAME, 'web_fetch']);

// 创建 tool_search 工具定义：根据关键词搜索 registry 中的工具，返回 JSON 数据供模型后续绑定真实工具
export function createToolSearchTool(
  registry: ToolRegistry,
  options: ToolSearchRuntimeOptions,
): ToolDefinition {
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    description: 'Search available runtime tools by capability and bind matching tool schemas for later calls.',
    // 说明：按能力/任务描述搜索可用的运行时工具，并返回匹配工具的 schema，供后续调用使用。
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Capability or task to search for, such as "read file", "search code", or "run command".',
          // 说明：要搜索的能力或任务描述，例如“读取文件”、“搜索代码”、“运行命令”。
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matching tools to return.',
          // 说明：最多返回多少个匹配工具。
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    requiredPolicy: 'readonly',
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.floor(args.limit)
        : options.maxResults;
      // 将 limit 夹到 [1, maxResults]，避免无意义的 0 或过大请求
      const limit = Math.max(1, Math.min(requestedLimit, options.maxResults));
      const tools = searchRegistryTools(registry, query, limit);
      const data: ToolSearchResultData = { query, tools };
      return {
        status: 'completed',
        output: JSON.stringify(data, null, 2),
        data,
      };
    },
  };
}

// 在 ToolRegistry 中搜索工具：按名称/描述做简单打分，返回前 limit 条并裁剪为标准字段
function searchRegistryTools(registry: ToolRegistry, query: string, limit: number): ToolSearchResultData['tools'] {
  const terms = normalizeSearchTerms(query);
  return registry.list()
    .filter((tool) => !INTERNAL_TOOL_NAMES.has(tool.name))
    .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
    .filter((entry) => terms.length === 0 || entry.score > 0)
    // 按分数降序、名称升序排序
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      requiredPolicy: tool.requiredPolicy,
      requiresApproval: tool.requiresApproval === true,
      parameters: tool.parameters,
    }));
}

// 规范化查询关键词：转为小写、按非字母数字/中文字符切分、过滤空值
function normalizeSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
}

// 对单个工具打分：完全命中名称 → 20 分；名称包含关键词 → 10 分；描述包含 → 3 分
function scoreTool(tool: ToolDefinition, terms: string[]): number {
  if (terms.length === 0) return 1;
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 20;
    else if (name.includes(term)) score += 10;
    if (description.includes(term)) score += 3;
  }
  return score;
}

// 从 tool_search 的执行结果 data 中提取工具名称列表：类型安全地解析未知结构，失败时返回空数组
export function toolNamesFromSearchResult(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const tools = (data as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((entry) => entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : null)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}
