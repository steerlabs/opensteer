import {
  mergeBrowserCapabilities,
  noBrowserCapabilities,
  type BrowserCapabilities,
  type HeaderEntry,
} from "@opensteer/browser-core";

export const ABP_BROWSER_CORE_CAPABILITIES: BrowserCapabilities = mergeBrowserCapabilities(
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
        pause: true,
        resume: true,
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
      executionState: true,
    },
  },
);

export interface AbpLaunchOptions {
  readonly abpExecutablePath?: string;
  readonly browserExecutablePath?: string;
  readonly headless?: boolean;
  readonly userDataDir?: string;
  readonly sessionDir?: string;
  readonly args?: readonly string[];
  readonly verbose?: boolean;
}

export interface AdoptedAbpBrowser {
  readonly baseUrl: string;
  readonly remoteDebuggingUrl: string;
}

export interface AbpBrowserCoreEngineOptions {
  readonly launch?: AbpLaunchOptions;
  readonly browser?: AdoptedAbpBrowser;
  readonly extraHTTPHeaders?: readonly HeaderEntry[];
}

export interface LaunchRequestOptions {
  readonly port: number;
  readonly userDataDir: string;
  readonly sessionDir: string;
  readonly abpExecutablePath?: string;
  readonly browserExecutablePath?: string;
  readonly headless: boolean;
  readonly args: readonly string[];
  readonly verbose: boolean;
}

export function normalizeAbpBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new TypeError("ABP baseUrl cannot be empty");
  }
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

export function normalizeRemoteDebuggingUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new TypeError("remoteDebuggingUrl cannot be empty");
  }
  return trimmed;
}
