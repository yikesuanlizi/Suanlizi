const GENERATED_TITLES = new Set([
  '',
  'Untitled',
  'Untitled chat',
  '未命名对话',
  'Untitled workflow project',
  '未命名工作流项目',
  'Suanlizi',
]);

export function shouldRetitleThread(title: string | undefined): boolean {
  return GENERATED_TITLES.has((title ?? '').trim());
}

export function titleFromInput(input: string | undefined): string {
  const normalized = (input ?? '').replace(/\s+/g, ' ').trim();
  if (/^\/skills\s+(?:add|install)\b/i.test(normalized)) return '安装 Skills';
  return normalized.slice(0, 60);
}
