import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelBrandIcon, modelBrandKey } from './ModelBrandIcon.js';

describe('model brand icon resolution', () => {
  it('uses only the saved site icon, without guessing /favicon.ico or model-derived logos', () => {
    const withIcon = renderToStaticMarkup(React.createElement(ModelBrandIcon, {
      model: 'glm-5.3-flash', provider: 'custom_vendor', providerName: 'Vendor', baseUrl: 'https://api.vendor.example/v1', iconUrl: 'https://vendor.example/assets/favicon.svg',
    }));
    expect(withIcon).toContain('https://vendor.example/assets/favicon.svg');
    expect(withIcon).not.toContain('brand-zhipu');
    const fallback = renderToStaticMarkup(React.createElement(ModelBrandIcon, {
      model: 'glm-5.3-flash', provider: 'custom_vendor', providerName: 'Vendor', baseUrl: 'https://api.vendor.example/v1',
    }));
    expect(fallback).not.toContain('favicon.ico');
    expect(fallback).not.toContain('modelBrandBadge');
  });

  it('renders no placeholder icon when a custom or unknown provider has no usable favicon', () => {
    expect(renderToStaticMarkup(React.createElement(ModelBrandIcon, {
      provider: 'custom_vendor', model: 'glm-5.3-flash', providerName: 'Vendor',
    }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(ModelBrandIcon, {
      provider: 'unknown_gateway', model: 'glm-5.3-flash',
    }))).toBe('');
  });

  it('does not infer vendor brands from model names on custom or generic compatible endpoints', () => {
    expect(modelBrandKey('glm-5.3-flash', 'custom_speedyun')).toBeUndefined();
    expect(modelBrandKey('glm-5.3-flash', 'openai_compatible')).toBeUndefined();
    expect(modelBrandKey('gpt-5', 'custom_third_party')).toBeUndefined();
    expect(modelBrandKey('claude-4', 'openai_compatible')).toBeUndefined();
  });

  it('keeps built-in provider branding and model-name inference only for built-in providers', () => {
    expect(modelBrandKey('glm-5.3-flash', 'zhipu')).toBe('zhipu');
    expect(modelBrandKey('deepseek-chat', 'deepseek')).toBe('deepseek');
    expect(modelBrandKey('deepseek-chat', '')).toBe('deepseek');
  });

  it('does not use model-name inference when an unrecognized explicit provider is set', () => {
    expect(modelBrandKey('glm-5.3-flash', 'speedyun')).toBeUndefined();
    expect(modelBrandKey('gpt-5', 'unknown_gateway')).toBeUndefined();
  });
});