import type { McpConfig, SkillDraft } from '../../shared/types.js';

export type RecommendedPlugin = RecommendedSkill | RecommendedMcp;

export interface RecommendedSkill {
  type: 'skill';
  id: string;
  name: string;
  titleZh: string;
  titleEn: string;
  descriptionZh: string;
  descriptionEn: string;
  draft: SkillDraft;
}

export interface RecommendedMcp {
  type: 'mcp';
  id: string;
  name: string;
  titleZh: string;
  titleEn: string;
  descriptionZh: string;
  descriptionEn: string;
  draft: Omit<McpConfig, 'id'>;
}

function skillDraft(name: string, description: string, instructions: string): SkillDraft {
  return {
    name,
    description,
    body: [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      '# Instructions',
      '',
      instructions,
      '',
    ].join('\n'),
  };
}

export const recommendedSkills: RecommendedSkill[] = [
  {
    type: 'skill',
    id: 'skill-code-review',
    name: 'code-review',
    titleZh: '代码审查',
    titleEn: 'Code review',
    descriptionZh: '优先发现缺陷、回归风险和缺失测试。',
    descriptionEn: 'Find defects, regressions, and missing tests first.',
    draft: skillDraft('code-review', '审查代码变更，优先发现缺陷、回归和缺失测试。', '以代码审查视角输出问题，按严重程度排序，给出文件和行号，摘要放在问题之后。'),
  },
  {
    type: 'skill',
    id: 'skill-bug-hunt',
    name: 'bug-hunt',
    titleZh: '问题定位',
    titleEn: 'Bug hunt',
    descriptionZh: '复现、追踪根因，并给出最小修复路径。',
    descriptionEn: 'Reproduce issues, trace root cause, and propose a focused fix.',
    draft: skillDraft('bug-hunt', '复现并定位问题，给出最小修复和验证路径。', '先复现并阅读错误，再追踪数据流和最近变更。不要在根因明确前堆叠修复。'),
  },
  {
    type: 'skill',
    id: 'skill-frontend-design',
    name: 'frontend-design',
    titleZh: '前端设计',
    titleEn: 'Frontend design',
    descriptionZh: '构建有明确风格、少 AI 味的生产级界面。',
    descriptionEn: 'Build polished production UI with a clear product style.',
    draft: skillDraft('frontend-design', '创建具有鲜明风格和生产级质量的前端界面。', '按产品场景设计真实可用的界面，控制信息密度、色彩、响应式和交互状态，避免空泛大字和蓝紫渐变。'),
  },
  {
    type: 'skill',
    id: 'skill-frontend-polish',
    name: 'frontend-polish',
    titleZh: '界面打磨',
    titleEn: 'Frontend polish',
    descriptionZh: '优化颜色、间距、响应式和可读性。',
    descriptionEn: 'Polish color, spacing, responsive behavior, and readability.',
    draft: skillDraft('frontend-polish', '优化界面细节、响应式状态和视觉一致性。', '检查浅色/深色主题、对比度、布局稳定性、按钮状态、长文本和小屏适配。'),
  },
  {
    type: 'skill',
    id: 'skill-playwright',
    name: 'playwright',
    titleZh: '浏览器验证',
    titleEn: 'Browser verification',
    descriptionZh: '用真实浏览器复现和验证 UI 流程。',
    descriptionEn: 'Use a real browser to reproduce and verify UI flows.',
    draft: skillDraft('playwright', '使用 Playwright 自动化真实浏览器进行验证。', '当需要点击、输入、截图或验证页面状态时，使用 Playwright 复现流程并记录可验证结果。'),
  },
  {
    type: 'skill',
    id: 'skill-release-notes',
    name: 'release-notes',
    titleZh: '发布说明',
    titleEn: 'Release notes',
    descriptionZh: '整理面向用户的变更说明和升级注意事项。',
    descriptionEn: 'Draft user-facing release notes and upgrade notes.',
    draft: skillDraft('release-notes', '整理面向用户的发布说明和升级注意事项。', '把改动按用户价值、风险和迁移步骤组织，避免只列内部提交。'),
  },
];

export const recommendedMcps: RecommendedMcp[] = [
  {
    type: 'mcp',
    id: 'mcp-playwright',
    name: 'playwright',
    titleZh: 'Playwright MCP',
    titleEn: 'Playwright MCP',
    descriptionZh: '浏览器自动化、页面检查和截图验证。',
    descriptionEn: 'Browser automation, page inspection, and screenshot checks.',
    draft: { name: 'playwright', command: 'npx', args: '@playwright/mcp@latest', enabled: true },
  },
  {
    type: 'mcp',
    id: 'mcp-browser',
    name: 'browser',
    titleZh: 'Browser MCP',
    titleEn: 'Browser MCP',
    descriptionZh: '网页读取、浏览器操作和本地页面验证。',
    descriptionEn: 'Web reading, browser control, and local page verification.',
    draft: { name: 'browser', command: 'npx', args: '@browsermcp/mcp@latest', enabled: true },
  },
  {
    type: 'mcp',
    id: 'mcp-filesystem',
    name: 'filesystem',
    titleZh: 'Filesystem MCP',
    titleEn: 'Filesystem MCP',
    descriptionZh: '受控读取项目文件和目录结构。',
    descriptionEn: 'Controlled access to project files and directory trees.',
    draft: { name: 'filesystem', command: 'npx', args: '@modelcontextprotocol/server-filesystem@latest E:\\langchain\\Suanlizi', enabled: false },
  },
  {
    type: 'mcp',
    id: 'mcp-figma',
    name: 'figma',
    titleZh: 'Figma MCP',
    titleEn: 'Figma MCP',
    descriptionZh: '读取设计稿、变量和视觉上下文。',
    descriptionEn: 'Read design context, variables, and visual specs.',
    draft: { name: 'figma', command: 'npx', args: 'figma-developer-mcp@latest', enabled: false },
  },
  {
    type: 'mcp',
    id: 'mcp-gitnexus',
    name: 'gitnexus',
    titleZh: 'GitNexus MCP',
    titleEn: 'GitNexus MCP',
    descriptionZh: '代码知识图谱、符号上下文、影响面和调用链分析。',
    descriptionEn: 'Code graph intelligence, symbol context, impact analysis, and call tracing.',
    draft: { name: 'gitnexus', command: 'npx', args: '-y gitnexus@latest mcp', enabled: true },
  },
];

export const recommendedPluginCatalog: RecommendedPlugin[] = [
  ...recommendedSkills,
  ...recommendedMcps,
];
