import { describe, expect, it } from 'vitest';
import { isGuessedProviderIcon, matchingProviderTabFavicon, pageDeclaredIconUrl, validProviderIconUrl } from './providerFavicon.js';

describe('provider favicon', () => {
  it('matches the API site rather than the first visible unrelated tab', () => {
    expect(matchingProviderTabFavicon('https://api.vendor.example/v1', [
      { url: 'https://other.example', favicon: 'https://other.example/icon.svg', visible: true },
      { url: 'https://www.vendor.example', favicon: 'https://cdn.vendor.example/icon.svg' },
    ])).toBe('https://cdn.vendor.example/icon.svg');
  });
  it('does not infer a brand from a different origin or an unsafe image URL', () => {
    expect(matchingProviderTabFavicon('https://api.vendor.example/v1', [
      { url: 'https://vendor.example.evil.test', favicon: 'https://evil.test/icon.ico' },
      { url: 'https://vendor.example', favicon: 'javascript:alert(1)' },
    ])).toBeNull();
    expect(validProviderIconUrl('https://user:pass@vendor.example/favicon.ico')).toBe(false);
    expect(validProviderIconUrl('data:image/svg+xml,<svg/>')).toBe(false);
    expect(validProviderIconUrl('data:image/png;base64,aGVsbG8=')).toBe(true);
  });
  it('only replaces the old guessed API favicon when a real tab icon is available', () => {
    expect(isGuessedProviderIcon('https://poolai.chat/v1', 'https://poolai.chat/favicon.ico')).toBe(true);
    expect(isGuessedProviderIcon('https://poolai.chat/v1', 'https://poolai.chat/poolai-logo.svg')).toBe(false);
  });
  it('accepts any icon-bearing rel token, not only two fixed values', () => {
    for (const rel of ['shortcut icon', 'mask-icon', 'apple-touch-icon-precomposed', 'fluid-icon', 'ICON']) {
      expect(pageDeclaredIconUrl('https://vendor.example/app', 'https://vendor.example/', [
        { rel, href: '/assets/logo.svg' },
      ])).toBe('https://vendor.example/assets/logo.svg');
    }
    expect(pageDeclaredIconUrl('https://vendor.example/', 'https://vendor.example/', [
      { rel: 'canonical', href: '/assets/favicon.svg' },
    ])).toBeNull();
  });
  it('resolves declared SVG and Apple icons against the document base, never canonical', () => {
    expect(pageDeclaredIconUrl('https://poolai.chat/v1', 'https://poolai.chat/', [
      { rel: 'canonical', href: 'https://sudocode.chat/' },
      { rel: 'apple-touch-icon', href: '/brand/logo-square-192.png' },
      { rel: 'icon', type: 'image/svg+xml', href: '/poolai-logo.svg' },
    ])).toBe('https://poolai.chat/poolai-logo.svg');
    expect(pageDeclaredIconUrl('https://sudocode.chat/', 'https://sudocode.chat/sub/', [
      { rel: 'apple-touch-icon', href: '../brand/logo-square-192.png' },
    ])).toBe('https://sudocode.chat/brand/logo-square-192.png');
    expect(pageDeclaredIconUrl('https://site.test/', 'https://site.test/', [
      { rel: 'canonical', href: 'https://other.test/' },
    ])).toBeNull();
    expect(pageDeclaredIconUrl('https://site.test/', 'https://site.test/', [
      { rel: 'icon', href: 'javascript:alert(1)' },
      { rel: 'icon', href: 'http://site.test/icon.svg' },
    ])).toBeNull();
    expect(pageDeclaredIconUrl('https://site.test/', 'https://site.test/', [
      { rel: 'icon', href: 'https://invalid.test:bad/icon.svg' },
      { rel: 'shortcut icon', href: '/good.svg' },
    ])).toBe('https://site.test/good.svg');
  });
});
