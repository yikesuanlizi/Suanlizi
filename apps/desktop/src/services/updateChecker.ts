const RELEASE_API_URL = 'https://api.github.com/repos/yikesuanlizi/Suanlizi/releases/latest';
const RELEASE_FALLBACK_URL = 'https://github.com/yikesuanlizi/Suanlizi/releases/latest';
const CACHE_KEY = 'nexus.updateCheck';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface UpdateCheckResult {
  hasUpdate: boolean;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
}

interface CachedUpdateCheck {
  timestamp: number;
  result: UpdateCheckResult;
}

const NO_UPDATE_RESULT: UpdateCheckResult = {
  hasUpdate: false,
  latestVersion: '',
  releaseUrl: '',
  releaseNotes: '',
};

function stripLeadingV(version: string): string {
  return version.startsWith('v') || version.startsWith('V') ? version.slice(1) : version;
}

function compareVersions(a: string, b: string): number {
  const partsA = stripLeadingV(a).split('.').map((part) => Number.parseInt(part, 10));
  const partsB = stripLeadingV(b).split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const valueA = Number.isFinite(partsA[i]) ? partsA[i] : 0;
    const valueB = Number.isFinite(partsB[i]) ? partsB[i] : 0;
    if (valueA > valueB) return 1;
    if (valueA < valueB) return -1;
  }
  return 0;
}

function readCache(): CachedUpdateCheck | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUpdateCheck;
    if (!parsed || typeof parsed.timestamp !== 'number' || !parsed.result) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(result: UpdateCheckResult): void {
  try {
    const entry: CachedUpdateCheck = { timestamp: Date.now(), result };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // ignore storage errors (quota, private mode, etc.)
  }
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const cached = readCache();
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(RELEASE_API_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      // Only cache successful responses; let the next launch retry on failure.
      return { ...NO_UPDATE_RESULT };
    }
    const data = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
    };
    const tagName = data.tag_name ?? '';
    const latestVersion = stripLeadingV(tagName);
    const releaseUrl = data.html_url ?? RELEASE_FALLBACK_URL;
    const releaseNotes = typeof data.body === 'string' ? data.body : '';
    const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
    const result: UpdateCheckResult = { hasUpdate, latestVersion, releaseUrl, releaseNotes };
    writeCache(result);
    return result;
  } catch {
    return { ...NO_UPDATE_RESULT };
  } finally {
    window.clearTimeout(timeoutId);
  }
}
