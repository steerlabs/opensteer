export interface StealthProfile {
  readonly id: string;
  readonly platform: "macos" | "windows" | "linux";
  readonly browserBrand: "chrome" | "edge";
  readonly browserVersion: string;
  readonly userAgent: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly screenResolution: { readonly width: number; readonly height: number };
  readonly devicePixelRatio: number;
  readonly maxTouchPoints: number;
  readonly webglVendor: string;
  readonly webglRenderer: string;
  readonly fonts: readonly string[];
  readonly canvasNoiseSeed: number;
  readonly audioNoiseSeed: number;
  readonly locale: string;
  readonly timezoneId: string;
}

export type StealthProfileOverrides = Partial<StealthProfile>;

const PROFILE_PRESETS = [
  {
    platform: "macos" as const,
    browserBrand: "chrome" as const,
    browserVersion: "133.0.6943.99",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.99 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    screenResolution: { width: 1512, height: 982 },
    devicePixelRatio: 2,
    maxTouchPoints: 0,
    webglVendor: "Apple Inc.",
    webglRenderer: "Apple M2",
    fonts: ["SF Pro Text", "Helvetica Neue", "Arial", "Menlo", "Apple Color Emoji"],
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  },
  {
    platform: "windows" as const,
    browserBrand: "chrome" as const,
    browserVersion: "133.0.6943.99",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.99 Safari/537.36",
    viewport: { width: 1536, height: 864 },
    screenResolution: { width: 1920, height: 1080 },
    devicePixelRatio: 1.25,
    maxTouchPoints: 0,
    webglVendor: "Google Inc. (Intel)",
    webglRenderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    fonts: ["Segoe UI", "Arial", "Calibri", "Consolas", "Segoe UI Emoji"],
    locale: "en-US",
    timezoneId: "America/New_York",
  },
  {
    platform: "windows" as const,
    browserBrand: "edge" as const,
    browserVersion: "133.0.3065.82",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.3065.82",
    viewport: { width: 1536, height: 864 },
    screenResolution: { width: 1920, height: 1080 },
    devicePixelRatio: 1.25,
    maxTouchPoints: 0,
    webglVendor: "Google Inc. (Intel)",
    webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    fonts: ["Segoe UI", "Arial", "Calibri", "Consolas", "Segoe UI Emoji"],
    locale: "en-US",
    timezoneId: "America/Chicago",
  },
  {
    platform: "linux" as const,
    browserBrand: "chrome" as const,
    browserVersion: "133.0.6943.99",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.99 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    screenResolution: { width: 1366, height: 768 },
    devicePixelRatio: 1,
    maxTouchPoints: 0,
    webglVendor: "Google Inc. (Mesa)",
    webglRenderer: "ANGLE (AMD, AMD Radeon Graphics, OpenGL 4.6)",
    fonts: ["Noto Sans", "Ubuntu", "DejaVu Sans", "Liberation Sans", "Noto Color Emoji"],
    locale: "en-US",
    timezoneId: "UTC",
  },
] as const;

export function generateStealthProfile(overrides: StealthProfileOverrides = {}): StealthProfile {
  const preset = pickStealthProfilePreset(overrides);
  return {
    id:
      overrides.id
      ?? `stealth:${preset.platform}:${preset.browserBrand}:${Math.random().toString(36).slice(2, 10)}`,
    platform: overrides.platform ?? preset.platform,
    browserBrand: overrides.browserBrand ?? preset.browserBrand,
    browserVersion: overrides.browserVersion ?? preset.browserVersion,
    userAgent: overrides.userAgent ?? preset.userAgent,
    viewport: overrides.viewport ?? preset.viewport,
    screenResolution: overrides.screenResolution ?? preset.screenResolution,
    devicePixelRatio: overrides.devicePixelRatio ?? preset.devicePixelRatio,
    maxTouchPoints: overrides.maxTouchPoints ?? preset.maxTouchPoints,
    webglVendor: overrides.webglVendor ?? preset.webglVendor,
    webglRenderer: overrides.webglRenderer ?? preset.webglRenderer,
    fonts: overrides.fonts ?? preset.fonts,
    canvasNoiseSeed: overrides.canvasNoiseSeed ?? Math.floor(Math.random() * 1_000_000),
    audioNoiseSeed: overrides.audioNoiseSeed ?? Math.floor(Math.random() * 1_000_000),
    locale: overrides.locale ?? preset.locale,
    timezoneId: overrides.timezoneId ?? preset.timezoneId,
  };
}

function pickStealthProfilePreset(overrides: StealthProfileOverrides) {
  const candidates = PROFILE_PRESETS.filter(
    (preset) =>
      (overrides.platform === undefined || preset.platform === overrides.platform)
      && (overrides.browserBrand === undefined || preset.browserBrand === overrides.browserBrand),
  );
  const pool = candidates.length > 0 ? candidates : PROFILE_PRESETS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
