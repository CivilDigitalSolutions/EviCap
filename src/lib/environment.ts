import type { Environment } from './types';
import { tzOffsetMinutes } from './util';

interface UADataLike {
  getHighEntropyValues(hints: string[]): Promise<{
    fullVersionList?: { brand: string; version: string }[];
    platform?: string;
    platformVersion?: string;
  }>;
}

let cached: Promise<Omit<Environment, 'tzOffsetMinutes' | 'tz'>> | null = null;

/** Environment recorded with every capture (F4 step 4). */
export async function getEnvironment(): Promise<Environment> {
  cached ??= (async () => {
    const ua = navigator.userAgent;
    let browser = ua;
    let os = '';
    const uaData = (navigator as unknown as { userAgentData?: UADataLike }).userAgentData;
    if (uaData) {
      try {
        const v = await uaData.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion']);
        const brands = (v.fullVersionList ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
        const main = brands.find((b) => /Edge|Chrome|Opera|Brave/i.test(b.brand) && b.brand !== 'Chromium') ?? brands[0];
        if (main) browser = `${main.brand} ${main.version}`;
        os = osName(v.platform ?? '', v.platformVersion ?? '');
      } catch {
        /* fall back to the user agent string */
      }
    }
    return { extension: chrome.runtime.getManifest().version, browser, os, userAgent: ua };
  })();
  return {
    ...(await cached),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffsetMinutes: tzOffsetMinutes(),
  };
}

/** Client hints give Windows a platform version, not a product name: 13 and above is Windows 11. */
export function osName(platform: string, version: string): string {
  if (platform === 'Windows') {
    const major = Number(version.split('.')[0]);
    const name = major >= 13 ? 'Windows 11' : major > 0 ? 'Windows 10' : 'Windows';
    return version ? `${name} (platform version ${version})` : name;
  }
  return [platform, version].filter(Boolean).join(' ');
}
