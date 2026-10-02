// 厂商图标：优先使用已注册 provider 的 favicon（自定义厂商），
// 否则回退到内置品牌图标，最后回退中性连接图标，绝不留空。
import type { ProviderEntry } from '../../shared/types.js';
import { ModelBrandIcon } from '../ModelBrandIcon.js';

export function ProviderBrandIcon({ provider }: { provider: ProviderEntry }) {
  const iconUrl = typeof provider.iconUrl === 'string' && provider.iconUrl.trim() !== '' ? provider.iconUrl : undefined;
  return <ModelBrandIcon provider={provider.id} providerName={provider.name} iconUrl={iconUrl} baseUrl={provider.baseUrl} />;
}
