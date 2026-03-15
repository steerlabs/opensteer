import type { BrowserCoreEngine } from "@opensteer/browser-core";
import type {
  OpensteerBrowserContextOptions,
  OpensteerBrowserLaunchOptions,
} from "@opensteer/protocol";

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

const defaultOpensteerEngineModuleImporters: OpensteerEngineModuleImporters = {
  importPlaywrightModule: () => import("@opensteer/engine-playwright"),
  importAbpModule: () => import("@opensteer/engine-abp"),
};

export function resolveOpensteerEngineName(input: {
  readonly requested?: string | undefined;
  readonly environment?: string | undefined;
} = {}): OpensteerEngineName {
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
  switch (name) {
    case "playwright":
      return async (options) => {
        const { createPlaywrightBrowserCoreEngine } = await importers.importPlaywrightModule();
        return createPlaywrightBrowserCoreEngine({
          ...(options.browser === undefined ? {} : { launch: options.browser }),
          ...(options.context === undefined ? {} : { context: options.context }),
        });
      };
    case "abp":
      return async (options) => {
        const { createAbpBrowserCoreEngine } = await loadAbpEngineModule(importers);
        const launch = toAbpLaunchOptions(options.browser);
        return createAbpBrowserCoreEngine(
          launch === undefined
            ? {}
            : {
                launch,
              },
        );
      };
  }
}

export const defaultOpensteerEngineFactory =
  createOpensteerEngineFactory(DEFAULT_OPENSTEER_ENGINE);

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

function toAbpLaunchOptions(
  options: OpensteerBrowserLaunchOptions | undefined,
): {
  readonly headless?: boolean;
  readonly args?: readonly string[];
  readonly browserExecutablePath?: string;
} | undefined {
  if (options === undefined) {
    return undefined;
  }

  const mapped = {
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.executablePath === undefined
      ? {}
      : { browserExecutablePath: options.executablePath }),
  };

  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

function isMissingPackageError(error: unknown, packageName: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes(packageName)
  );
}
