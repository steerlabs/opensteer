import process from "node:process";

import type { OpensteerBrowserOptions } from "@opensteer/protocol";

import { normalizeOpensteerProviderMode, type OpensteerProviderMode } from "../provider/config.js";
import { resolveCommandLength } from "./commands.js";

export interface ParsedCliOptions {
  readonly workspace?: string;
  readonly url?: string;
  readonly output?: string;
  readonly requestedEngineName?: string;
  readonly provider?: OpensteerProviderMode;
  readonly cloudBaseUrl?: string;
  readonly cloudApiKey?: string;
  readonly cloudAppBaseUrl?: string;
  readonly cloudProfileId?: string;
  readonly cloudProfileReuseIfActive?: boolean;
  readonly json?: boolean;
  readonly agents?: readonly string[];
  readonly skills?: readonly string[];
  readonly localViewMode?: "auto" | "manual";
  readonly global?: boolean;
  readonly yes?: boolean;
  readonly copy?: boolean;
  readonly all?: boolean;
  readonly list?: boolean;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: {
    readonly headless?: boolean;
    readonly executablePath?: string;
    readonly args?: readonly string[];
    readonly timeoutMs?: number;
  };
  readonly context?: Record<string, unknown>;
  readonly attachEndpoint?: string;
  readonly attachHeaders?: Readonly<Record<string, string>>;
  readonly sourceUserDataDir?: string;
  readonly sourceProfileDirectory?: string;
}

export interface ParsedCommandLine {
  readonly command: readonly string[];
  readonly rest: readonly string[];
  readonly rawOptions: ReadonlyMap<string, readonly string[]>;
  readonly options: ParsedCliOptions;
}

const CLI_OPTION_SPECS = {
  workspace: { kind: "value" },
  url: { kind: "value" },
  output: { kind: "value" },
  engine: { kind: "value" },
  provider: { kind: "value" },
  "cloud-base-url": { kind: "value" },
  "cloud-api-key": { kind: "value" },
  "cloud-app-base-url": { kind: "value" },
  "cloud-profile-id": { kind: "value" },
  "cloud-profile-reuse-if-active": { kind: "boolean" },
  json: { kind: "boolean" },
  agent: { kind: "value", multiple: true },
  skill: { kind: "value", multiple: true },
  global: { kind: "boolean" },
  yes: { kind: "boolean" },
  copy: { kind: "boolean" },
  all: { kind: "boolean" },
  list: { kind: "boolean" },
  auto: { kind: "boolean" },
  "no-auto": { kind: "boolean" },
  "attach-endpoint": { kind: "value" },
  "attach-header": { kind: "value", multiple: true },
  "fresh-tab": { kind: "boolean" },
  headless: { kind: "boolean" },
  "executable-path": { kind: "value" },
  arg: { kind: "value", multiple: true },
  "timeout-ms": { kind: "value" },
  context: { kind: "value" },
  "source-user-data-dir": { kind: "value" },
  "source-profile-directory": { kind: "value" },
  element: { kind: "value" },
  persist: { kind: "optional-value" },
  button: { kind: "value" },
  count: { kind: "value" },
  modifiers: { kind: "value" },
  "press-enter": { kind: "boolean" },
  "capture-network": { kind: "value" },
  capture: { kind: "value" },
  hostname: { kind: "value" },
  path: { kind: "value" },
  method: { kind: "value" },
  status: { kind: "value" },
  type: { kind: "value" },
  before: { kind: "value" },
  after: { kind: "value" },
  limit: { kind: "value" },
  query: { kind: "value", multiple: true },
  header: { kind: "value", multiple: true },
  body: { kind: "value" },
  "body-text": { kind: "value" },
  variables: { kind: "value" },
  dx: { kind: "value" },
  dy: { kind: "value" },
  steps: { kind: "value" },
  format: { kind: "value" },
  transport: { kind: "value" },
  cookies: { kind: "optional-value" },
  "follow-redirects": { kind: "boolean" },
  probe: { kind: "boolean" },
  "api-key": { kind: "value" },
  "site-key": { kind: "value" },
  "page-url": { kind: "value" },
  timeout: { kind: "value" },
  "url-filter": { kind: "value" },
  inline: { kind: "boolean" },
  external: { kind: "boolean" },
  dynamic: { kind: "boolean" },
  workers: { kind: "boolean" },
  fidelity: { kind: "value" },
  clock: { kind: "value" },
  globals: { kind: "value" },
  "ajax-routes": { kind: "value" },
  key: { kind: "value" },
  duration: { kind: "value" },
  script: { kind: "value" },
  "include-storage": { kind: "boolean" },
  "include-session-storage": { kind: "boolean" },
  "include-indexed-db": { kind: "boolean" },
  "global-names": { kind: "value" },
  "case-id": { kind: "value" },
  notes: { kind: "value" },
  tags: { kind: "value" },
} as const satisfies Record<
  string,
  { readonly kind: "boolean" | "value" | "optional-value"; readonly multiple?: true }
>;

export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const leadingTokens: string[] = [];
  let index = 0;
  while (index < argv.length && !argv[index]!.startsWith("--")) {
    leadingTokens.push(argv[index]!);
    index += 1;
  }

  const commandLength = resolveCommandLength(leadingTokens);
  const command = leadingTokens.slice(0, commandLength);
  const rest: string[] = leadingTokens.slice(commandLength);
  const rawOptions = new Map<string, string[]>();

  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      rest.push(token);
      index += 1;
      continue;
    }

    const separator = token.indexOf("=");
    const key = token.slice(2, separator === -1 ? undefined : separator);
    const spec = CLI_OPTION_SPECS[key as keyof typeof CLI_OPTION_SPECS];
    if (spec === undefined) {
      throw new Error(`Unknown option: --${key}.`);
    }

    if (separator !== -1) {
      rawOptions.set(key, [...(rawOptions.get(key) ?? []), token.slice(separator + 1)]);
      index += 1;
      continue;
    }

    const next = argv[index + 1];
    if (spec.kind === "boolean") {
      if (next === undefined || next.startsWith("--")) {
        rawOptions.set(key, [...(rawOptions.get(key) ?? []), "true"]);
        index += 1;
        continue;
      }
      rawOptions.set(key, [...(rawOptions.get(key) ?? []), next]);
      index += 2;
      continue;
    }

    if (spec.kind === "optional-value") {
      if (next === undefined || next.startsWith("--")) {
        rawOptions.set(key, [...(rawOptions.get(key) ?? []), "true"]);
        index += 1;
        continue;
      }

      rawOptions.set(key, [...(rawOptions.get(key) ?? []), next]);
      index += 2;
      continue;
    }

    if (next === undefined || next.startsWith("--")) {
      throw new Error(
        `Option "--${key}" requires a value.${next?.startsWith("--") === true ? ` Use "--${key}=<value>" when the value begins with "--".` : ``}`,
      );
    }

    rawOptions.set(key, [...(rawOptions.get(key) ?? []), next]);
    index += 2;
  }

  const workspace = readSingle(rawOptions, "workspace") ?? process.env.OPENSTEER_WORKSPACE;
  const requestedEngineName = readSingle(rawOptions, "engine");
  const attachEndpoint = readSingle(rawOptions, "attach-endpoint");
  const attachHeaders = parseKeyValueList(rawOptions.get("attach-header"));
  const freshTab = readOptionalBoolean(rawOptions, "fresh-tab");
  const headless = readOptionalBoolean(rawOptions, "headless");
  const executablePath = readSingle(rawOptions, "executable-path");
  const launchArgs = rawOptions.get("arg");
  const timeoutMs = readOptionalNumber(rawOptions, "timeout-ms");
  const browser =
    attachEndpoint === undefined
      ? undefined
      : ({
          mode: "attach",
          endpoint: attachEndpoint,
          ...(attachHeaders === undefined ? {} : { headers: attachHeaders }),
          ...(freshTab === undefined ? {} : { freshTab }),
        } satisfies OpensteerBrowserOptions);

  const launch = {
    ...(headless === undefined ? {} : { headless }),
    ...(executablePath === undefined ? {} : { executablePath }),
    ...(launchArgs === undefined ? {} : { args: launchArgs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  const providerValue = shouldParseRuntimeProvider(command)
    ? readSingle(rawOptions, "provider")
    : undefined;
  const provider =
    providerValue === undefined
      ? undefined
      : normalizeOpensteerProviderMode(providerValue, "--provider");

  const url = readSingle(rawOptions, "url");
  const output = readSingle(rawOptions, "output");
  const cloudBaseUrl = readSingle(rawOptions, "cloud-base-url");
  const cloudApiKey = readSingle(rawOptions, "cloud-api-key");
  const cloudAppBaseUrl = readSingle(rawOptions, "cloud-app-base-url");
  const cloudProfileId = readSingle(rawOptions, "cloud-profile-id");
  const cloudProfileReuseIfActive = readOptionalBoolean(
    rawOptions,
    "cloud-profile-reuse-if-active",
  );
  const json = readOptionalBoolean(rawOptions, "json");
  const agents = rawOptions.get("agent");
  const skills = rawOptions.get("skill");
  const autoLocalView = readOptionalBoolean(rawOptions, "auto");
  const noAutoLocalView = readOptionalBoolean(rawOptions, "no-auto");
  if (autoLocalView === true && noAutoLocalView === true) {
    throw new Error('Options "--auto" and "--no-auto" cannot be combined.');
  }
  if (command[0] !== "view" && (autoLocalView !== undefined || noAutoLocalView !== undefined)) {
    throw new Error('Options "--auto" and "--no-auto" are only supported with "view".');
  }
  const global = readOptionalBoolean(rawOptions, "global");
  const yes = readOptionalBoolean(rawOptions, "yes");
  const copy = readOptionalBoolean(rawOptions, "copy");
  const all = readOptionalBoolean(rawOptions, "all");
  const list = readOptionalBoolean(rawOptions, "list");
  const context = readJsonObject(rawOptions, "context");
  const sourceUserDataDir = readSingle(rawOptions, "source-user-data-dir");
  const sourceProfileDirectory = readSingle(rawOptions, "source-profile-directory");

  const options: ParsedCliOptions = {
    ...(workspace === undefined ? {} : { workspace }),
    ...(url === undefined ? {} : { url }),
    ...(output === undefined ? {} : { output }),
    ...(requestedEngineName === undefined ? {} : { requestedEngineName }),
    ...(provider === undefined ? {} : { provider }),
    ...(cloudBaseUrl === undefined ? {} : { cloudBaseUrl }),
    ...(cloudApiKey === undefined ? {} : { cloudApiKey }),
    ...(cloudAppBaseUrl === undefined ? {} : { cloudAppBaseUrl }),
    ...(cloudProfileId === undefined ? {} : { cloudProfileId }),
    ...(cloudProfileReuseIfActive === undefined ? {} : { cloudProfileReuseIfActive }),
    ...(json === undefined ? {} : { json }),
    ...(agents === undefined ? {} : { agents }),
    ...(skills === undefined ? {} : { skills }),
    ...(autoLocalView === true
      ? { localViewMode: "auto" as const }
      : noAutoLocalView === true
        ? { localViewMode: "manual" as const }
        : {}),
    ...(global === undefined ? {} : { global }),
    ...(yes === undefined ? {} : { yes }),
    ...(copy === undefined ? {} : { copy }),
    ...(all === undefined ? {} : { all }),
    ...(list === undefined ? {} : { list }),
    ...(browser === undefined ? {} : { browser }),
    ...(Object.keys(launch).length === 0 ? {} : { launch }),
    ...(context === undefined ? {} : { context }),
    ...(attachEndpoint === undefined ? {} : { attachEndpoint }),
    ...(attachHeaders === undefined ? {} : { attachHeaders }),
    ...(sourceUserDataDir === undefined ? {} : { sourceUserDataDir }),
    ...(sourceProfileDirectory === undefined ? {} : { sourceProfileDirectory }),
  };

  return {
    command,
    rest,
    rawOptions,
    options,
  };
}

function shouldParseRuntimeProvider(command: readonly string[]): boolean {
  return !(command[0] === "captcha" && command[1] === "solve");
}

export function parseKeyValueList(
  values: readonly string[] | undefined,
): Readonly<Record<string, string>> | undefined {
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    values.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        throw new Error(`Expected NAME=VALUE, received "${entry}".`);
      }
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

export function parseCommaSeparatedList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values.length === 0 ? undefined : values;
}

export function readSingle(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): string | undefined {
  const values = options.get(name);
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  return values[values.length - 1];
}

export function readOptionalBoolean(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): boolean | undefined {
  const value = readSingle(options, name);
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Option "--${name}" must be true or false.`);
}

export function readOptionalNumber(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): number | undefined {
  const value = readSingle(options, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Option "--${name}" must be a number.`);
  }
  return parsed;
}

export function readJsonValue(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): unknown {
  const value = readSingle(options, name);
  return value === undefined ? undefined : JSON.parse(value);
}

export function readJsonObject(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): Record<string, unknown> | undefined {
  const parsed = readJsonValue(options, name);
  if (parsed === undefined) {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Option "--${name}" must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function readJsonArray(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): readonly unknown[] | undefined {
  const parsed = readJsonValue(options, name);
  if (parsed === undefined) {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Option "--${name}" must be a JSON array.`);
  }
  return parsed;
}
