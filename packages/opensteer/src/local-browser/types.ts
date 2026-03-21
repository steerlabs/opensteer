import type {
  OpensteerAttachLiveBrowserLaunchOptions,
  OpensteerManagedBrowserLaunchOptions,
  OpensteerSnapshotAuthenticatedBrowserLaunchOptions,
  OpensteerSnapshotSessionBrowserLaunchOptions,
} from "@opensteer/protocol";
import type { BrowserBrandId } from "./browser-brands.js";
import type { StealthProfile } from "./stealth-profiles.js";

export interface LocalChromeProfileDescriptor {
  readonly directory: string;
  readonly name: string;
  readonly userDataDir: string;
}

export interface LocalBrowserInstallation {
  readonly brand: BrowserBrandId;
  readonly executablePath: string | null;
  readonly userDataDir: string;
}

export type LocalChromeInstallation = LocalBrowserInstallation;

export interface InspectedCdpEndpoint {
  readonly endpoint: string;
  readonly browser?: string;
  readonly protocolVersion?: string;
  readonly httpUrl?: string;
  readonly port?: number;
}

export interface LocalCdpBrowserCandidate extends InspectedCdpEndpoint {
  readonly source: "devtools-active-port" | "fallback-port";
  readonly installationBrand?: BrowserBrandId;
  readonly userDataDir?: string;
}

export interface ResolvedManagedBrowserLaunch {
  readonly executablePath: string;
  readonly headless: boolean;
  readonly timeoutMs: number;
  readonly args: readonly string[];
}

export interface ResolvedSnapshotBrowserLaunch extends ResolvedManagedBrowserLaunch {
  readonly copyMode: "session" | "authenticated";
  readonly sourceProfileDirectory: string;
  readonly sourceUserDataDir: string;
}

export interface ResolvedAttachLiveBrowserLaunch {
  readonly endpoint?: string;
  readonly freshTab: boolean;
  readonly headers?: Readonly<Record<string, string>>;
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
  readonly addInitScript?: (script: { readonly content: string }) => Promise<void>;
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
  readonly useRealKeychain?: boolean;
  readonly stealthProfile?: StealthProfile;
}

export interface PreparedOwnedBrowserLaunch extends LaunchOwnedBrowserOptions {
  readonly userDataDir: string;
  readonly profileDirectory?: string;
  readonly cleanupUserDataDir?: string;
  readonly release?: () => Promise<void>;
  readonly useRealKeychain?: boolean;
}

export interface ConnectCdpBrowserOptions {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly freshTab: boolean;
  readonly ownedBrowser?: OwnedLocalChromeProcess;
  readonly stealthProfile?: StealthProfile;
  readonly connectBrowser: (input: {
    readonly url: string;
    readonly timeoutMs: number;
    readonly headers?: Readonly<Record<string, string>>;
  }) => Promise<ConnectedCdpBrowser>;
}

export interface ConnectAttachBrowserOptions extends Omit<
  ConnectCdpBrowserOptions,
  "endpoint" | "headers"
> {
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
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
  | ResolvedSnapshotBrowserLaunch
  | ResolvedAttachLiveBrowserLaunch;

export type LocalBrowserLaunchInput =
  | OpensteerManagedBrowserLaunchOptions
  | OpensteerSnapshotSessionBrowserLaunchOptions
  | OpensteerSnapshotAuthenticatedBrowserLaunchOptions
  | OpensteerAttachLiveBrowserLaunchOptions;
