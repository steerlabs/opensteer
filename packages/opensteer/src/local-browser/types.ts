import type {
  OpensteerAutoConnectBrowserLaunchOptions,
  OpensteerCdpBrowserLaunchOptions,
  OpensteerManagedBrowserLaunchOptions,
  OpensteerProfileBrowserLaunchOptions,
} from "@opensteer/protocol";

export interface LocalChromeProfileDescriptor {
  readonly directory: string;
  readonly name: string;
  readonly userDataDir: string;
}

export interface LocalChromeInstallation {
  readonly brand: "chrome" | "chromium";
  readonly executablePath: string | null;
  readonly userDataDir: string;
}

export interface ResolvedManagedBrowserLaunch {
  readonly executablePath: string;
  readonly headless: boolean;
  readonly timeoutMs: number;
  readonly args: readonly string[];
}

export interface ResolvedProfileBrowserLaunch extends ResolvedManagedBrowserLaunch {
  readonly profileDirectory: string;
  readonly userDataDir: string;
}

export interface ResolvedCdpBrowserLaunch {
  readonly endpoint: string;
  readonly freshTab: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ResolvedAutoConnectBrowserLaunch {
  readonly freshTab: boolean;
}

export interface ConnectedCdpSession {
  readonly send: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly detach: () => Promise<unknown>;
}

export interface ConnectedCdpPage {
  readonly close: () => Promise<unknown>;
  readonly bringToFront?: () => Promise<unknown>;
  readonly goto?: (
    url: string,
    options?: {
      readonly timeout?: number;
      readonly waitUntil?: "domcontentloaded";
    },
  ) => Promise<unknown>;
}

export interface ConnectedCdpBrowserContext {
  readonly pages: () => readonly ConnectedCdpPage[];
  readonly newPage: () => Promise<ConnectedCdpPage>;
}

export interface ConnectedCdpBrowser {
  readonly close: () => Promise<unknown>;
  readonly contexts: () => readonly ConnectedCdpBrowserContext[];
  readonly newBrowserCDPSession: () => Promise<ConnectedCdpSession>;
}

export interface LocalBrowserLease {
  readonly browser: ConnectedCdpBrowser;
  readonly context: ConnectedCdpBrowserContext;
  readonly page: ConnectedCdpPage;
  readonly close: () => Promise<void>;
}

export interface LaunchOwnedBrowserOptions {
  readonly executablePath: string;
  readonly headless: boolean;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly userDataDir?: string;
  readonly profileDirectory?: string;
}

export interface ConnectCdpBrowserOptions {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly freshTab: boolean;
  readonly ownedBrowser?: OwnedLocalChromeProcess;
  readonly connectBrowser: (input: {
    readonly url: string;
    readonly timeoutMs: number;
    readonly headers?: Readonly<Record<string, string>>;
  }) => Promise<ConnectedCdpBrowser>;
}

export interface OwnedLocalChromeProcess {
  readonly pid: number;
  readonly cleanupUserDataDir?: string;
  readonly close: () => Promise<void>;
  readonly kill: () => Promise<void>;
}

export interface LaunchMetadataRecord {
  readonly args: readonly string[];
  readonly executablePath: string;
  readonly headless: boolean;
  readonly owner:
    | {
        readonly pid: number;
        readonly processStartedAtMs: number;
      }
    | undefined;
  readonly profileDirectory?: string;
  readonly userDataDir: string;
}

export type ResolvedLocalBrowserLaunch =
  | ResolvedManagedBrowserLaunch
  | ResolvedProfileBrowserLaunch
  | ResolvedCdpBrowserLaunch
  | ResolvedAutoConnectBrowserLaunch;

export type LocalBrowserLaunchInput =
  | OpensteerManagedBrowserLaunchOptions
  | OpensteerProfileBrowserLaunchOptions
  | OpensteerCdpBrowserLaunchOptions
  | OpensteerAutoConnectBrowserLaunchOptions;
