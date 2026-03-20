import type { BrowserCoreEngine } from "@opensteer/browser-core";
import type {
  OpensteerAttachBrowserLaunchOptions,
  OpensteerBrowserContextOptions,
  OpensteerBrowserLaunchOptions,
  OpensteerClonedBrowserLaunchOptions,
  OpensteerManagedBrowserLaunchOptions,
  OpensteerProfileBrowserLaunchOptions,
} from "@opensteer/protocol";

import { OPENSTEER_COMPUTER_DISPLAY_PROFILE } from "../runtimes/computer-use/display.js";
import {
  resolveAttachBrowserLaunch,
  resolveClonedBrowserLaunch,
  resolveManagedBrowserLaunch,
  resolveProfileBrowserLaunch,
} from "../local-browser/launch-resolution.js";
import {
  connectAttachBrowserSession,
  launchClonedBrowserSession,
  launchManagedBrowserSession,
  launchProfileBrowserSession,
} from "../local-browser/shared-session.js";
import {
  generateStealthProfile,
  type StealthProfile,
} from "../local-browser/stealth-profiles.js";
import type {
  ConnectedCdpBrowser,
  ConnectedCdpBrowserContext,
  ConnectedCdpPage,
  LocalBrowserLease,
} from "../local-browser/types.js";

export const OPENSTEER_ENGINE_NAMES = ["playwright", "abp"] as const;
export type OpensteerEngineName = (typeof OPENSTEER_ENGINE_NAMES)[number];

export const DEFAULT_OPENSTEER_ENGINE: OpensteerEngineName = "playwright";

export interface OpensteerNamedEngineFactoryOptions {
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
}

export type OpensteerNamedEngineFactory = (
  options: OpensteerNamedEngineFactoryOptions,
) => Promise<BrowserCoreEngine>;

interface OpensteerEngineModuleImporters {
  readonly importPlaywrightModule: () => Promise<typeof import("@opensteer/engine-playwright")>;
  readonly importAbpModule: () => Promise<typeof import("@opensteer/engine-abp")>;
}

interface OpensteerEngineDefinition {
  readonly createFactory: (
    importers: OpensteerEngineModuleImporters,
  ) => OpensteerNamedEngineFactory;
}

const defaultOpensteerEngineModuleImporters: OpensteerEngineModuleImporters = {
  importPlaywrightModule: () => import("@opensteer/engine-playwright"),
  importAbpModule: () => import("@opensteer/engine-abp"),
};

const OPENSTEER_ABP_SUPPORTED_BROWSER_OPTIONS = [
  "kind",
  "headless",
  "args",
  "executablePath",
  "timeoutMs",
] as const satisfies readonly (keyof OpensteerManagedBrowserLaunchOptions)[];

const OPENSTEER_ENGINE_REGISTRY = {
  playwright: {
    createFactory: (importers) => async (options) => {
      const playwrightModule = await importers.importPlaywrightModule();
      const normalizedContext = normalizeOpensteerBrowserContextOptions(options.context);
      return createPlaywrightBrowserEngine({
        playwrightModule,
        ...(options.browser === undefined ? {} : { browser: options.browser }),
        ...(normalizedContext === undefined ? {} : { context: normalizedContext }),
      });
    },
  },
  abp: {
    createFactory: (importers) => async (options) => {
      assertSupportedAbpEngineOptions(options);
      const { createAbpBrowserCoreEngine } = await loadAbpEngineModule(importers);
      const managedBrowser = toManagedBrowserLaunchOptions(options.browser);
      const launch = toAbpLaunchOptions(
        managedBrowser,
        normalizeOpensteerBrowserContextOptions(options.context),
      );
      return createAbpBrowserCoreEngine(
        launch === undefined
          ? {}
          : {
              launch,
            },
      );
    },
  },
} as const satisfies Record<OpensteerEngineName, OpensteerEngineDefinition>;

export function resolveOpensteerEngineName(
  input: {
    readonly requested?: string | undefined;
    readonly environment?: string | undefined;
  } = {},
): OpensteerEngineName {
  if (input.requested !== undefined) {
    return normalizeOpensteerEngineName(input.requested, "--engine");
  }

  if (input.environment !== undefined) {
    return normalizeOpensteerEngineName(input.environment, "OPENSTEER_ENGINE");
  }

  return DEFAULT_OPENSTEER_ENGINE;
}

export function normalizeOpensteerEngineName(
  value: string,
  source = "engine",
): OpensteerEngineName {
  const normalized = value.trim().toLowerCase();
  if (normalized === "playwright" || normalized === "abp") {
    return normalized;
  }

  throw new Error(
    `${source} must be one of ${OPENSTEER_ENGINE_NAMES.join(", ")}; received "${value}".`,
  );
}

export function createOpensteerEngineFactory(
  name: OpensteerEngineName,
  importers: OpensteerEngineModuleImporters = defaultOpensteerEngineModuleImporters,
): OpensteerNamedEngineFactory {
  return OPENSTEER_ENGINE_REGISTRY[name].createFactory(importers);
}

export const defaultOpensteerEngineFactory = createOpensteerEngineFactory(DEFAULT_OPENSTEER_ENGINE);

export function normalizeOpensteerBrowserContextOptions(
  context: OpensteerBrowserContextOptions | undefined,
): OpensteerBrowserContextOptions | undefined {
  const stealthProfile = resolveStealthProfile(context?.stealthProfile);
  const locale = context?.locale ?? stealthProfile?.locale;
  const timezoneId = context?.timezoneId ?? stealthProfile?.timezoneId;
  const userAgent = context?.userAgent ?? stealthProfile?.userAgent;
  return {
    ...(context ?? {}),
    ...(stealthProfile === undefined ? {} : { stealthProfile }),
    ...(locale === undefined ? {} : { locale }),
    ...(timezoneId === undefined ? {} : { timezoneId }),
    ...(userAgent === undefined ? {} : { userAgent }),
    viewport:
      context?.viewport
      ?? stealthProfile?.viewport
      ?? OPENSTEER_COMPUTER_DISPLAY_PROFILE.preferredViewport,
  };
}

async function createPlaywrightBrowserEngine(input: {
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly playwrightModule: Awaited<
    ReturnType<OpensteerEngineModuleImporters["importPlaywrightModule"]>
  >;
}): Promise<BrowserCoreEngine> {
  const lease = await acquireLocalBrowserLease({
    ...(input.browser === undefined ? {} : { browser: input.browser }),
    ...(input.context === undefined ? {} : { context: input.context }),
    connectBrowser: async ({ headers, timeoutMs, url }) =>
      asConnectedCdpBrowser(
        await input.playwrightModule.connectPlaywrightChromiumBrowser({
          url,
          ...(headers === undefined ? {} : { headers }),
        }),
      ),
  });

  try {
    const engine = await input.playwrightModule.createPlaywrightBrowserCoreEngine({
      browser: asAdoptedChromiumBrowser(input.playwrightModule, lease.browser),
      attachedContext: asAttachedContext(input.playwrightModule, lease.context),
      attachedPage: asAttachedPage(input.playwrightModule, lease.page),
      closeAttachedContextOnSessionClose: false,
      closeBrowserOnDispose: false,
      ...(input.context === undefined
        ? {}
        : { context: toEngineBrowserContextOptions(input.context) }),
    });

    return wrapBrowserLease(engine, lease);
  } catch (error) {
    await lease.close().catch(() => undefined);
    throw error;
  }
}

async function acquireLocalBrowserLease(input: {
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly connectBrowser: (input: {
    readonly url: string;
    readonly timeoutMs: number;
    readonly headers?: Readonly<Record<string, string>>;
  }) => Promise<ConnectedCdpBrowser>;
}): Promise<LocalBrowserLease> {
  const browser = input.browser;
  const stealthProfile = resolveStealthProfile(input.context?.stealthProfile);
  if (browser === undefined || isManagedBrowserLaunchOptions(browser)) {
    const resolved = resolveManagedBrowserLaunch(browser ?? {});
    return launchManagedBrowserSession({
      ...resolved,
      args: mergeManagedLaunchArgs(resolved.args, input.context?.viewport) ?? [],
      ...(stealthProfile === undefined ? {} : { stealthProfile }),
      connectBrowser: input.connectBrowser,
    });
  }

  if (isProfileBrowserLaunchOptions(browser)) {
    const resolved = resolveProfileBrowserLaunch(browser);
    return launchProfileBrowserSession({
      ...resolved,
      args: mergeManagedLaunchArgs(resolved.args, input.context?.viewport) ?? [],
      ...(stealthProfile === undefined ? {} : { stealthProfile }),
      connectBrowser: input.connectBrowser,
    });
  }

  if (isClonedBrowserLaunchOptions(browser)) {
    const resolved = resolveClonedBrowserLaunch(browser);
    return launchClonedBrowserSession({
      ...resolved,
      args: mergeManagedLaunchArgs(resolved.args, input.context?.viewport) ?? [],
      ...(stealthProfile === undefined ? {} : { stealthProfile }),
      connectBrowser: input.connectBrowser,
    });
  }

  if (isAttachBrowserLaunchOptions(browser)) {
    const resolved = resolveAttachBrowserLaunch(browser);
    return connectAttachBrowserSession({
      ...resolved,
      ...(stealthProfile === undefined ? {} : { stealthProfile }),
      timeoutMs: 15_000,
      connectBrowser: input.connectBrowser,
    });
  }

  throw new Error(
    `Unsupported browser launch kind "${(browser as { kind?: string }).kind ?? ""}".`,
  );
}

async function loadAbpEngineModule(importers: OpensteerEngineModuleImporters) {
  try {
    return await importers.importAbpModule();
  } catch (error) {
    if (isMissingPackageError(error, "@opensteer/engine-abp")) {
      throw new Error(
        'ABP engine selected but "@opensteer/engine-abp" is not installed. Install it to use --engine abp or OPENSTEER_ENGINE=abp.',
      );
    }
    throw error;
  }
}

function toManagedBrowserLaunchOptions(
  options: OpensteerBrowserLaunchOptions | undefined,
): OpensteerManagedBrowserLaunchOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  if (isManagedBrowserLaunchOptions(options)) {
    return options;
  }

  return undefined;
}

function toAbpLaunchOptions(
  options: OpensteerManagedBrowserLaunchOptions | undefined,
  context: OpensteerBrowserContextOptions | undefined,
):
  | {
      readonly headless?: boolean;
      readonly args?: readonly string[];
      readonly browserExecutablePath?: string;
    }
  | undefined {
  const mapped: {
    headless?: boolean;
    args?: readonly string[];
    browserExecutablePath?: string;
  } = {};

  if (options?.headless !== undefined) {
    mapped.headless = options.headless;
  }

  const args = mergeManagedLaunchArgs(options?.args, context?.viewport);
  if (args !== undefined) {
    mapped.args = args;
  }

  if (options?.executablePath !== undefined) {
    mapped.browserExecutablePath = options.executablePath;
  }

  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

function assertSupportedAbpEngineOptions(options: OpensteerNamedEngineFactoryOptions): void {
  if (options.browser && !isManagedBrowserLaunchOptions(options.browser)) {
    throw new Error(
      'ABP engine only supports managed local browser launches. Use the Playwright engine for browser.kind="profile", "cloned", or "attach".',
    );
  }

  const unsupportedOptionNames = [
    ...listUnsupportedOptionNames(
      toManagedBrowserLaunchOptions(options.browser),
      OPENSTEER_ABP_SUPPORTED_BROWSER_OPTIONS,
      "browser",
    ),
    ...listUnsupportedContextOptionNames(options.context),
  ];
  if (unsupportedOptionNames.length === 0) {
    return;
  }

  const supportedBrowserOptions = OPENSTEER_ABP_SUPPORTED_BROWSER_OPTIONS.map(
    (name) => `browser.${name}`,
  ).join(", ");
  const supportedContextOptions = "context.viewport";
  throw new Error(
    `ABP engine does not support ${unsupportedOptionNames.join(", ")}. Supported ABP open options: ${supportedBrowserOptions}, ${supportedContextOptions}.`,
  );
}

function listUnsupportedContextOptionNames(
  options: OpensteerBrowserContextOptions | undefined,
): readonly string[] {
  if (options === undefined) {
    return [];
  }

  return Object.entries(options)
    .filter(([key, value]) => value !== undefined && key !== "viewport")
    .map(([key]) => `context.${key}`);
}

function listUnsupportedOptionNames<T extends object, TSupportedKey extends keyof T>(
  options: T | undefined,
  supportedKeys: readonly TSupportedKey[],
  prefix: string,
): readonly string[] {
  if (options === undefined) {
    return [];
  }

  const supportedKeySet = new Set<keyof T>(supportedKeys);
  return Object.entries(options)
    .filter(([key, value]) => value !== undefined && !supportedKeySet.has(key as keyof T))
    .map(([key]) => `${prefix}.${key}`);
}

function mergeManagedLaunchArgs(
  args: readonly string[] | undefined,
  viewport:
    | {
        readonly width: number;
        readonly height: number;
      }
    | null
    | undefined,
): readonly string[] | undefined {
  const filtered = stripWindowSizeArgs(args);
  if (viewport === undefined || viewport === null) {
    return filtered.length === 0 ? undefined : filtered;
  }

  return [...filtered, `--window-size=${viewport.width},${viewport.height}`];
}

function stripWindowSizeArgs(args: readonly string[] | undefined): readonly string[] {
  if (args === undefined) {
    return [];
  }

  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--window-size") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--window-size=")) {
      continue;
    }
    filtered.push(argument);
  }

  return filtered;
}

function toEngineBrowserContextOptions(
  context: OpensteerBrowserContextOptions,
): Omit<OpensteerBrowserContextOptions, "stealthProfile"> {
  const { stealthProfile: _stealthProfile, ...engineContext } = context;
  return engineContext;
}

function resolveStealthProfile(
  input: OpensteerBrowserContextOptions["stealthProfile"] | undefined,
): StealthProfile | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (isStealthProfile(input)) {
    return input;
  }

  return generateStealthProfile(input);
}

function isStealthProfile(
  input: NonNullable<OpensteerBrowserContextOptions["stealthProfile"]>,
): input is StealthProfile {
  return (
    input.id !== undefined
    && input.platform !== undefined
    && input.browserBrand !== undefined
    && input.browserVersion !== undefined
    && input.userAgent !== undefined
    && input.viewport !== undefined
    && input.screenResolution !== undefined
    && input.devicePixelRatio !== undefined
    && input.maxTouchPoints !== undefined
    && input.webglVendor !== undefined
    && input.webglRenderer !== undefined
    && input.fonts !== undefined
    && input.canvasNoiseSeed !== undefined
    && input.audioNoiseSeed !== undefined
    && input.locale !== undefined
    && input.timezoneId !== undefined
  );
}

function isMissingPackageError(error: unknown, packageName: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes(packageName)
  );
}

function isManagedBrowserLaunchOptions(
  options: OpensteerBrowserLaunchOptions | undefined,
): options is OpensteerManagedBrowserLaunchOptions {
  return options === undefined || options.kind === undefined || options.kind === "managed";
}

function isProfileBrowserLaunchOptions(
  options: OpensteerBrowserLaunchOptions,
): options is OpensteerProfileBrowserLaunchOptions {
  return options.kind === "profile";
}

function isClonedBrowserLaunchOptions(
  options: OpensteerBrowserLaunchOptions,
): options is OpensteerClonedBrowserLaunchOptions {
  return options.kind === "cloned";
}

function isAttachBrowserLaunchOptions(
  options: OpensteerBrowserLaunchOptions,
): options is OpensteerAttachBrowserLaunchOptions {
  return options.kind === "attach";
}

function asConnectedCdpBrowser(
  browser: Awaited<
    ReturnType<(typeof import("@opensteer/engine-playwright"))["connectPlaywrightChromiumBrowser"]>
  >,
): ConnectedCdpBrowser {
  return browser as unknown as ConnectedCdpBrowser;
}

function asAdoptedChromiumBrowser(
  playwrightModule: Awaited<ReturnType<OpensteerEngineModuleImporters["importPlaywrightModule"]>>,
  browser: ConnectedCdpBrowser,
): NonNullable<
  NonNullable<
    Parameters<(typeof playwrightModule)["createPlaywrightBrowserCoreEngine"]>[0]
  >["browser"]
> {
  return browser as unknown as NonNullable<
    NonNullable<
      Parameters<(typeof playwrightModule)["createPlaywrightBrowserCoreEngine"]>[0]
    >["browser"]
  >;
}

function asAttachedContext(
  playwrightModule: Awaited<ReturnType<OpensteerEngineModuleImporters["importPlaywrightModule"]>>,
  context: ConnectedCdpBrowserContext,
): NonNullable<
  NonNullable<
    Parameters<(typeof playwrightModule)["createPlaywrightBrowserCoreEngine"]>[0]
  >["attachedContext"]
> {
  return context as unknown as NonNullable<
    NonNullable<
      Parameters<(typeof playwrightModule)["createPlaywrightBrowserCoreEngine"]>[0]
    >["attachedContext"]
  >;
}

function asAttachedPage(
  playwrightModule: Awaited<ReturnType<OpensteerEngineModuleImporters["importPlaywrightModule"]>>,
  page: ConnectedCdpPage,
): NonNullable<
  NonNullable<
    Parameters<(typeof playwrightModule)["createPlaywrightBrowserCoreEngine"]>[0]
  >["attachedPage"]
> {
  return page as unknown as NonNullable<
    NonNullable<
      Parameters<(typeof playwrightModule)["createPlaywrightBrowserCoreEngine"]>[0]
    >["attachedPage"]
  >;
}

function wrapBrowserLease(engine: BrowserCoreEngine, lease: LocalBrowserLease): BrowserCoreEngine {
  const disposableEngine = engine as BrowserCoreEngine & {
    dispose?: () => Promise<void>;
    [Symbol.asyncDispose]?: () => Promise<void>;
  };
  const originalDispose = disposableEngine.dispose?.bind(disposableEngine);
  const originalAsyncDispose = disposableEngine[Symbol.asyncDispose]?.bind(disposableEngine);
  let released = false;
  const releaseLease = async () => {
    if (released) {
      return;
    }
    released = true;
    await lease.close();
  };

  disposableEngine.dispose = async () => {
    try {
      await originalDispose?.();
    } finally {
      await releaseLease();
    }
  };
  disposableEngine[Symbol.asyncDispose] = async () => {
    try {
      await originalAsyncDispose?.();
    } finally {
      await releaseLease();
    }
  };

  return disposableEngine;
}
