import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../config/defaults.js';
import { ModelsPage } from './ModelsPage.js';

const providers = [
  { id: 'custom_ai', name: '忆AI', baseUrl: 'https://api.zxcbug.com/', apiKeyEnvVar: '', protocol: 'openai' as const, isLocal: false },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKeyEnvVar: 'DEEPSEEK_API_KEY', protocol: 'openai' as const, isLocal: false },
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKeyEnvVar: 'NVIDIA_API_KEY', protocol: 'openai' as const, isLocal: false },
  { id: 'giteeai', name: 'Gitee AI', baseUrl: 'https://ai.gitee.com/v1', apiKeyEnvVar: 'GITEE_API_KEY', protocol: 'openai' as const, isLocal: false },
];
const presets = [
  { id: 'p1', name: '忆AI / deepseek-v4.1-flash', config: { provider: 'custom_ai', model: 'deepseek-v4.1-flash', baseUrl: 'https://api.zxcbug.com/' }, createdAt: 'x', updatedAt: 'x' },
  { id: 'p5', name: '忆AI / glm-5.3-flash', config: { provider: 'custom_ai', model: 'glm-5.3-flash', baseUrl: 'https://api.zxcbug.com/' }, createdAt: 'x', updatedAt: 'x' },
  { id: 'p2', name: 'DeepSeek / deepseek-v4-pro', config: { provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' }, createdAt: 'x', updatedAt: 'x' },
  { id: 'p3', name: 'NVIDIA NIM / nemotron', config: { provider: 'nvidia', model: 'nemotron', baseUrl: 'https://integrate.api.nvidia.com/v1' }, createdAt: 'x', updatedAt: 'x' },
  { id: 'p4', name: 'Gitee AI / qwen3.8-flash', config: { provider: 'giteeai', model: 'qwen3.8-flash', baseUrl: 'https://ai.gitee.com/v1' }, createdAt: 'x', updatedAt: 'x' },
];

function render(){
  return renderToStaticMarkup(React.createElement(ModelsPage, {
    locale: 'zh',
    config: defaultConfig,
    modelConfigDraft: { provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' },
    setModelConfigDraft: vi.fn(),
    providers,
    keyStates: [],
    modelPresets: presets,
    deleteModelPreset: vi.fn(), deleteCustomProvider: vi.fn(),
    listProviderIconTabs: vi.fn(async () => []), saveProviderIcon: vi.fn(async () => {}),
    apiKeyDraft: '',
    setApiKeyDraft: vi.fn(),
    modelKeySource: 'env',
    setModelKeySource: vi.fn(),
    showSavedModelKey: false,
    setShowSavedModelKey: vi.fn(),
    modelKeyNotice: '',
    setModelKeyNotice: vi.fn(),
    hasSavedModelKey: false,
    hasConfiguredModelEnvVar: false,
    modelEnvVarDraft: 'DEEPSEEK_API_KEY',
    setModelEnvVarDraft: vi.fn(),
    modelEnvVarOptions: [],
    customProviderName: '',
    setCustomProviderName: vi.fn(),
    selectModelProviderDraft: vi.fn(),
    loadModelPresetIntoDraft: vi.fn(),
    selectPreset: vi.fn(),
    startNewModelPreset: vi.fn(),
    handleSaveModelConfig: vi.fn(),
    handleSetCurrentModelConfig: vi.fn(),
    onReset: vi.fn(),
    markDirty: vi.fn(),
    dirtyFields: {},
  }));
}

describe('ModelsPage flat list', () => {
  it('shows all preset rows at once with brand icons and per-row edit/delete icons', () => {
    const html = render();
    // 不再有下拉选择器
    expect(html).not.toContain('modelPresetSelect');
    // 同厂商两个模型，所有五行均渲染
    expect((html.match(/class="modelPresetRow( |")/g) ?? []).length).toBe(5);
    expect((html.match(/class="modelProviderGroup"/g) ?? []).length).toBe(4);
    expect(html).toContain('为忆AI添加模型');
    expect(html).toContain('删除厂商 忆AI');
    // 每行都有修改 + 删除
    expect((html.match(/title="修改"/g) ?? []).length).toBe(5);
    expect((html.match(/title="删除"/g) ?? []).length).toBe(5);
    // 品牌图标
    expect(html).toContain('brand-deepseek');
    expect(html).toContain('brand-nvidia');
    expect(html).toContain('brand-giteeai');
    // 自定义厂商优先尝试其 API 站点图标，绝不推断模型品牌。
    expect(html).not.toContain('https://api.zxcbug.com/favicon.ico');
    expect(html).not.toContain('modelBrandBadge');
    // 新建是页头右上角的纯图标按钮
    expect(html).toContain('iconOnly');
    expect(html).toContain('上下文参考');
    // 默认视图只有配置列表，不显示表单字段
    expect(html).not.toContain('modelEditorPanel');
    expect(html).not.toContain('默认模型');
    // 配置字段只在新建/编辑面板里出现
    expect(html).not.toContain('modelProviderSelect');
  });
});

describe('ModelsPage unified panel', () => {
  it('create and edit share one panel implementation', () => {
    const src = readFileSync(join(here, 'ModelsPage.tsx'), 'utf-8');
    // 同一个面板同时承担新建与编辑
    expect(src).toContain('const panelOpen = isCreating || editingPresetId !== null;');
    expect(src).toContain('function beginCreate(providerId?: string)');
    expect(src).toContain('function beginEdit(preset: ModelPreset)');
    expect(src).toContain('function submitPanel()');
    // 面板里同时有新建/保存修改两种文案，来自同一表单
    expect(src).toContain("isCreating ? (locale === 'zh' ? '创建' : 'Create') : (locale === 'zh' ? '保存修改' : 'Save changes')");
    // 默认视图不渲染表单
    const html = renderToStaticMarkup(React.createElement(ModelsPage, {
      locale: 'zh', config: defaultConfig,
      modelConfigDraft: { provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' },
      setModelConfigDraft: vi.fn(), providers, keyStates: [], modelPresets: presets, deleteModelPreset: vi.fn(), deleteCustomProvider: vi.fn(),
    listProviderIconTabs: vi.fn(async () => []), saveProviderIcon: vi.fn(async () => {}),
      apiKeyDraft: '', setApiKeyDraft: vi.fn(), modelKeySource: 'env', setModelKeySource: vi.fn(),
      showSavedModelKey: false, setShowSavedModelKey: vi.fn(),
      modelKeyNotice: '', setModelKeyNotice: vi.fn(),
      hasSavedModelKey: false, hasConfiguredModelEnvVar: false,
      modelEnvVarDraft: 'DEEPSEEK_API_KEY', setModelEnvVarDraft: vi.fn(), modelEnvVarOptions: [],
      customProviderName: '', setCustomProviderName: vi.fn(),
      selectModelProviderDraft: vi.fn(), loadModelPresetIntoDraft: vi.fn(),
      selectPreset: vi.fn(), startNewModelPreset: vi.fn(),
      handleSaveModelConfig: vi.fn(), handleSetCurrentModelConfig: vi.fn(),
      onReset: vi.fn(), markDirty: vi.fn(), dirtyFields: {},
    }));
    expect(html).not.toContain('modelEditorPanel');
    expect(html).toContain('modelPresetRow');
  });
});
