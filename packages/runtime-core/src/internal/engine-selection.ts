import type {
  OpensteerBrowserContextOptions,
  OpensteerBrowserLaunchOptions,
  OpensteerBrowserOptions,
} from "@opensteer/protocol";

export const OPENSTEER_ENGINE_NAMES = ["playwright", "abp"] as const;
export type OpensteerEngineName = (typeof OPENSTEER_ENGINE_NAMES)[number];

export const DEFAULT_OPENSTEER_ENGINE: OpensteerEngineName = "playwright";

export interface ResolvedAbpLaunchOptions {
  readonly headless?: boolean;
  readonly args?: readonly string[];
  readonly browserExecutablePath?: string;
  readonly userDataDir?: string;
  readonly sessionDir?: string;
}

export function resolveOpensteerEngineName(
  input: {
    readonly requested?: string;
    readonly environment?: string;
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

export function assertSupportedEngineOptions(input: {
  readonly engineName: OpensteerEngineName;
  readonly browser?: OpensteerBrowserOptions;
  readonly context?: OpensteerBrowserContextOptions;
}): void {
  if (input.engineName !== "abp") {
    return;
  }

  if (
    typeof input.browser === "object" &&
    input.browser !== null &&
    input.browser.mode === "attach"
  ) {
    throw new Error(
      'ABP engine does not support browser.mode="attach". Use the Playwright engine for attach flows.',
    );
  }

  const unsupportedContextOptionNames = listUnsupportedContextOptionNames(input.context);
  if (unsupportedContextOptionNames.length === 0) {
    return;
  }

  throw new Error(
    `ABP engine does not support ${unsupportedContextOptionNames.join(", ")}. Supported ABP context options: context.viewport.`,
  );
}

export function toAbpLaunchOptions(input: {
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly userDataDir?: string;
  readonly sessionDir?: string;
}): ResolvedAbpLaunchOptions | undefined {
  const mapped: {
    headless?: boolean;
    args?: readonly string[];
    browserExecutablePath?: string;
    userDataDir?: string;
    sessionDir?: string;
  } = {};

  if (input.launch?.headless !== undefined) {
    mapped.headless = input.launch.headless;
  }

  const args = mergeManagedLaunchArgs(input.launch?.args, input.context?.viewport);
  if (args !== undefined) {
    mapped.args = args;
  }

  if (input.launch?.executablePath !== undefined) {
    mapped.browserExecutablePath = input.launch.executablePath;
  }

  if (input.userDataDir !== undefined) {
    mapped.userDataDir = input.userDataDir;
  }

  if (input.sessionDir !== undefined) {
    mapped.sessionDir = input.sessionDir;
  }

  return Object.keys(mapped).length === 0 ? undefined : mapped;
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
