import type { UserInput } from '@suanlizi/protocol';

// 网页搜索模式：auto 表示根据用户输入内容自动判断；on 表示强制开启；off 表示强制关闭
export type WebSearchMode = 'auto' | 'on' | 'off';

// 触发关键词（中英文混合）：当用户输入包含其中任一关键词时，建议开启网络搜索
const SEARCH_TRIGGERS = [
  '联网',
  '搜索',
  '查一下',
  '最新',
  '今天',
  '新闻',
  'web_search',
  'web search',
  'search the web',
  'look up',
  'latest',
  'recent',
  'current',
  'today',
];

// 判断是否应开启 web_search：mode 为 on 直接开启；mode 为 off 直接关闭；auto 时按用户输入是否含搜索关键词判断
export function shouldEnableWebSearch(mode: WebSearchMode, input: UserInput): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  const text = userInputToText(input).toLowerCase();
  return SEARCH_TRIGGERS.some((trigger) => text.includes(trigger.toLowerCase()));
}

// 从 UserInput 中提取纯文本内容；对多 part 输入过滤出 text 段并换行拼接
function userInputToText(input: UserInput): string {
  if (input.type === 'text') return input.text;
  return input.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
