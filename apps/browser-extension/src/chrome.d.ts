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
    remove(tabId: number): Promise<void>;
  };
}

declare const chrome: ChromeApi;
