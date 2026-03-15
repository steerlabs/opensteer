import {
  noBrowserCapabilities,
  mergeBrowserCapabilities,
  type BrowserCapabilities,
  type HeaderEntry,
} from "@opensteer/browser-core";
import type { Browser } from "playwright";

export const DEFAULT_BODY_CAPTURE_LIMIT_BYTES = 1024 * 1024;

export const PLAYWRIGHT_BROWSER_CORE_CAPABILITIES: BrowserCapabilities = mergeBrowserCapabilities(
  noBrowserCapabilities(),
  {
    executor: {
      sessionLifecycle: true,
      pageLifecycle: true,
      navigation: true,
      pointerInput: true,
      keyboardInput: true,
      screenshots: true,
      executionControl: {
        freeze: true,
      },
    },
    inspector: {
      pageEnumeration: true,
      frameEnumeration: true,
      html: true,
      domSnapshot: true,
      text: true,
      attributes: true,
      hitTest: true,
      viewportMetrics: true,
      network: true,
      networkBodies: true,
      cookies: true,
      localStorage: true,
      sessionStorage: true,
      indexedDb: true,
    },
    transport: {
      sessionHttp: true,
    },
    events: {
      pageLifecycle: true,
      dialog: true,
      download: true,
      chooser: true,
      console: true,
      pageError: true,
    },
  },
);

export interface PlaywrightChromiumLaunchOptions {
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly channel?: string;
  readonly args?: readonly string[];
  readonly chromiumSandbox?: boolean;
  readonly devtools?: boolean;
  readonly downloadsPath?: string;
  readonly proxy?: {
    readonly server: string;
    readonly bypass?: string;
    readonly username?: string;
    readonly password?: string;
  };
  readonly slowMo?: number;
  readonly timeoutMs?: number;
}

export interface PlaywrightBrowserContextOptions {
  readonly ignoreHTTPSErrors?: boolean;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly userAgent?: string;
  readonly viewport?: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly javaScriptEnabled?: boolean;
  readonly bypassCSP?: boolean;
  readonly reducedMotion?: "reduce" | "no-preference";
  readonly colorScheme?: "light" | "dark" | "no-preference";
  readonly extraHTTPHeaders?: readonly HeaderEntry[];
}

export interface AdoptedChromiumBrowser {
  readonly browserType: () => { readonly name: () => string };
  readonly close: () => Promise<void>;
  readonly newContext: (options?: Record<string, unknown>) => Promise<unknown>;
}

export interface PlaywrightBrowserCoreEngineOptions {
  readonly browser?: AdoptedChromiumBrowser;
  readonly closeBrowserOnDispose?: boolean;
  readonly launch?: PlaywrightChromiumLaunchOptions;
  readonly context?: PlaywrightBrowserContextOptions;
  readonly bodyCaptureLimitBytes?: number;
}

export function asChromiumBrowser(browser: AdoptedChromiumBrowser): Browser {
  return browser as unknown as Browser;
}

export function buildContextOptions(
  options: PlaywrightBrowserContextOptions | undefined,
): Record<string, unknown> {
  if (!options) {
    return {
      acceptDownloads: true,
    };
  }

  return {
    acceptDownloads: true,
    ...(options.ignoreHTTPSErrors === undefined
      ? {}
      : { ignoreHTTPSErrors: options.ignoreHTTPSErrors }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.timezoneId === undefined ? {} : { timezoneId: options.timezoneId }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    ...(options.javaScriptEnabled === undefined
      ? {}
      : { javaScriptEnabled: options.javaScriptEnabled }),
    ...(options.bypassCSP === undefined ? {} : { bypassCSP: options.bypassCSP }),
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
    ...(options.colorScheme === undefined ? {} : { colorScheme: options.colorScheme }),
    ...(options.extraHTTPHeaders === undefined
      ? {}
      : {
          extraHTTPHeaders: Object.fromEntries(
            options.extraHTTPHeaders.map((header) => [header.name, header.value]),
          ),
        }),
  };
}

export function buildLaunchOptions(
  options: PlaywrightChromiumLaunchOptions | undefined,
): Record<string, unknown> {
  return {
    headless: options?.headless ?? false,
    ...(options?.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    ...(options?.channel === undefined ? {} : { channel: options.channel }),
    ...(options?.args === undefined ? {} : { args: [...options.args] }),
    ...(options?.chromiumSandbox === undefined ? {} : { chromiumSandbox: options.chromiumSandbox }),
    ...(options?.devtools === undefined ? {} : { devtools: options.devtools }),
    ...(options?.downloadsPath === undefined ? {} : { downloadsPath: options.downloadsPath }),
    ...(options?.proxy === undefined ? {} : { proxy: options.proxy }),
    ...(options?.slowMo === undefined ? {} : { slowMo: options.slowMo }),
    ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };
}
