/** 远端列表成功时不再补示例；失败或为空时保留既有预设和最小兜底建议。 */
export function mergeModelSuggestions(input: {
  presetModels: string[];
  remoteModels?: string[];
  remoteReady: boolean;
}): string[] {
  const presetModels = input.presetModels.filter(Boolean);
  if (input.remoteReady && (input.remoteModels?.length ?? 0) > 0) {
    return Array.from(new Set([...presetModels, ...input.remoteModels!.filter(Boolean)]));
  }
  return Array.from(new Set([
    ...presetModels,
    'gpt-g-luna', 'gpt-6-sol', 'deepseek-4.1-flash', 'glm-5.3-flash',
  ]));
}