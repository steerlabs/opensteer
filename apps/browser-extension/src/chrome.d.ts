interface ChromeCookie {
  domain: string;
  expirationDate?: number;
  hostOnly: boolean;
  httpOnly: boolean;
  name: string;
  partitionKey?: {
    hasCrossSiteAncestor?: boolean;
    topLevelSite?: string;
  };
  path: string;
  sameSite: "no_restriction" | "lax" | "strict" | "unspecified";
  secure: boolean;
  session: boolean;
  value: string;
}

interface ChromeTab {
  id?: number;
  /** Present only while the tab that opened this one still exists. */
  openerTabId?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
}

interface ChromeDebuggee {
  tabId?: number;
  sessionId?: string;
}

interface ChromeDebugger {
  attach(target: { tabId: number }, requiredVersion: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  getTargets(): Promise<{ id: string; tabId?: number; type: string; attached?: boolean }[]>;
  sendCommand(
    target: ChromeDebuggee,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
  onEvent: ChromeEvent<
    (source: ChromeDebuggee, method: string, params?: Record<string, unknown>) => void
  >;
  onDetach: ChromeEvent<(source: ChromeDebuggee, reason: string) => void>;
}

interface ChromeMessageSender {
  frameId?: number;
  id?: string;
  tab?: ChromeTab;
  url?: string;
}

interface ChromeEvent<Listener> {
  addListener(listener: Listener): void;
}

interface ChromeNotificationOptions {
  buttons?: { title: string }[];
  iconUrl: string;
  message: string;
  priority?: number;
  title: string;
  type: "basic";
}

interface ChromeApi {
  debugger?: ChromeDebugger;
  webNavigation?: {
    onCreatedNavigationTarget: ChromeEvent<
      (details: { sourceTabId: number; tabId: number; url: string }) => void
    >;
  };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): Promise<void>;
    onAlarm: ChromeEvent<(alarm: { name: string }) => void>;
  };
  cookies: {
    getAll(details: {
      domain?: string;
      partitionKey?: { hasCrossSiteAncestor?: boolean; topLevelSite: string };
    }): Promise<ChromeCookie[]>;
  };
  notifications: {
    clear(id: string): Promise<boolean>;
    create(id: string, options: ChromeNotificationOptions): Promise<string>;
    onButtonClicked: ChromeEvent<(id: string, buttonIndex: number) => void>;
  };
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
  };
  runtime: {
    reload(): void;
    id: string;
    getPlatformInfo(): Promise<{ os: string }>;
    getURL(path: string): string;
    onInstalled: ChromeEvent<() => void>;
    onMessage: ChromeEvent<
      (
        request: unknown,
        sender: ChromeMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | void
    >;
    onStartup: ChromeEvent<() => void>;
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
    };
  };
  tabs: {
    create(properties: { url: string }): Promise<ChromeTab>;
    get(tabId: number): Promise<ChromeTab>;
    getCurrent(): Promise<ChromeTab | undefined>;
    query(query: { active?: boolean; currentWindow?: boolean }): Promise<ChromeTab[]>;
    onRemoved: ChromeEvent<(tabId: number) => void>;
    onReplaced: ChromeEvent<(addedTabId: number, removedTabId: number) => void>;
    onUpdated: ChromeEvent<
      (tabId: number, changes: { url?: string; title?: string }, tab: ChromeTab) => void
    >;
    remove(tabId: number): Promise<void>;
  };
}

declare const chrome: ChromeApi;

declare const OPENSTEER_LIVE_TABS: boolean;
