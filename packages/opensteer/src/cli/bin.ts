#!/usr/bin/env node

import process from "node:process";

import type {
  OpensteerBrowserOptions,
  OpensteerSemanticOperationName,
} from "@opensteer/protocol";
import type { OpensteerSemanticRuntime } from "@opensteer/runtime-core";
import opensteerPackage from "../../package.json" with { type: "json" };

import { OpensteerBrowserManager } from "../browser-manager.js";
import { dispatchSemanticOperation } from "./dispatch.js";
import { loadCliEnvironment } from "./env-loader.js";
import { discoverLocalCdpBrowsers, inspectCdpEndpoint } from "../local-browser/cdp-discovery.js";
import {
  resolveOpensteerEngineName,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import { runOpensteerSkillsInstaller } from "./skills-installer.js";
import {
  assertProviderSupportsEngine,
  normalizeOpensteerProviderMode,
  resolveOpensteerProvider,
  type OpensteerProviderMode,
  type OpensteerProviderOptions,
  type OpensteerResolvedProvider,
} from "../provider/config.js";
import {
  createOpensteerSemanticRuntime,
  resolveOpensteerRuntimeConfig,
} from "../sdk/runtime-resolution.js";
import { collectOpensteerStatus, renderOpensteerStatus } from "./status.js";
import { runOpensteerCloudRecordCommand, runOpensteerRecordCommand } from "./record.js";

const OPERATION_ALIASES = new Map<string, OpensteerSemanticOperationName>([
  ["open", "session.open"],
  ["goto", "page.goto"],
  ["snapshot", "page.snapshot"],
  ["click", "dom.click"],
  ["hover", "dom.hover"],
  ["input", "dom.input"],
  ["scroll", "dom.scroll"],
  ["extract", "dom.extract"],
  ["network query", "network.query"],
  ["network detail", "network.detail"],
  ["replay", "network.replay"],
  ["cookies", "session.cookies"],
  ["storage", "session.storage"],
  ["state", "session.state"],
  ["close", "session.close"],
]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bootstrapAction = resolveCliBootstrapAction(argv);
  if (bootstrapAction === "version") {
    printVersion();
    return;
  }
  if (bootstrapAction === "help") {
    printHelp();
    return;
  }

  await loadCliEnvironment(process.cwd());
  const parsed = parseCommandLine(argv);

  if (parsed.command[0] === "browser") {
    await handleBrowserCommand(parsed);
    return;
  }

  if (parsed.command[0] === "skills" && parsed.command[1] === "install") {
    const exitCode = await runOpensteerSkillsInstaller({
      ...(parsed.options.agents === undefined ? {} : { agents: parsed.options.agents }),
      ...(parsed.options.skills === undefined ? {} : { skills: parsed.options.skills }),
      global: parsed.options.global === true,
      yes: parsed.options.yes === true,
      copy: parsed.options.copy === true,
      all: parsed.options.all === true,
      list: parsed.options.list === true,
    });
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (parsed.command[0] === "status") {
    await handleStatusCommand(parsed);
    return;
  }

  if (parsed.command[0] === "record") {
    await handleRecordCommandEntry(parsed);
    return;
  }

  const operation =
    parsed.command[0] === "run"
      ? (parsed.rest[0] as OpensteerSemanticOperationName | undefined)
      : resolveOperation(parsed.command);
  if (!operation) {
    throw new Error(`Unknown command: ${parsed.command.join(" ")}`);
  }

  if (parsed.options.workspace === undefined) {
    throw new Error('Stateful commands require "--workspace <id>".');
  }

  const engineName = resolveCliEngineName(parsed);
  const provider = resolveCliProvider(parsed);
  assertProviderSupportsEngine(provider.mode, engineName);
  assertCloudCliOptionsMatchProvider(parsed, provider.mode);
  const runtimeProvider = buildCliRuntimeProvider(parsed, provider.mode);

  if (operation === "session.close") {
    if (provider.mode === "cloud") {
      const runtime = createOpensteerSemanticRuntime({
        ...(runtimeProvider === undefined ? {} : { provider: runtimeProvider }),
        engine: engineName,
        runtimeOptions: {
          workspace: parsed.options.workspace,
          rootDir: process.cwd(),
          browser: "persistent",
          ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
          ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
        },
      });
      const result = await runtime.close();
      process.stdout.write(
        renderOperationOutput(operation, result, parsed.command[0] === "run"),
      );
      return;
    }

    const manager = new OpensteerBrowserManager({
      rootDir: process.cwd(),
      workspace: parsed.options.workspace,
      engineName,
      browser: "persistent",
      ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
      ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
    });
    await manager.close();
    process.stdout.write(renderOperationOutput(operation, { closed: true }, parsed.command[0] === "run"));
    return;
  }

  const runtime = createOpensteerSemanticRuntime({
    ...(runtimeProvider === undefined ? {} : { provider: runtimeProvider }),
    engine: engineName,
    runtimeOptions: {
      workspace: parsed.options.workspace,
      rootDir: process.cwd(),
      ...(parsed.options.browser === undefined ? {} : { browser: parsed.options.browser }),
      ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
      ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
    },
  });

  let result: unknown;
  try {
    result = await dispatchSemanticOperation(
      runtime,
      operation,
      buildOperationInput(
        operation,
        parsed.command[0] === "run" ? { ...parsed, rest: parsed.rest.slice(1) } : parsed,
      ),
    );
  } finally {
    await runtime.disconnect().catch(() => undefined);
  }

  process.stdout.write(renderOperationOutput(operation, result, parsed.command[0] === "run"));
}

async function handleBrowserCommand(parsed: ParsedCommandLine): Promise<void> {
  const subcommand = parsed.command[1];
  if (subcommand === "discover") {
    const result = await discoverLocalCdpBrowsers({
      ...(parsed.options.launch?.timeoutMs === undefined
        ? {}
        : { timeoutMs: parsed.options.launch.timeoutMs }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === "inspect") {
    const endpoint = parsed.options.attachEndpoint ?? parsed.rest[0];
    if (!endpoint) {
      throw new Error(
        'browser inspect requires "--attach-endpoint <url>" or a positional endpoint.',
      );
    }
    const result = await inspectCdpEndpoint({
      endpoint,
      ...(parsed.options.attachHeaders === undefined
        ? {}
        : { headers: parsed.options.attachHeaders }),
      ...(parsed.options.launch?.timeoutMs === undefined
        ? {}
        : { timeoutMs: parsed.options.launch.timeoutMs }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (parsed.options.workspace === undefined) {
    throw new Error('Browser workspace commands require "--workspace <id>".');
  }

  const engineName = resolveCliEngineName(parsed);
  const manager = new OpensteerBrowserManager({
    rootDir: process.cwd(),
    workspace: parsed.options.workspace,
    engineName,
    browser: "persistent",
    ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
    ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
  });

  switch (subcommand) {
    case "status": {
      const result = await manager.status();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "clone": {
      const sourceUserDataDir = parsed.options.sourceUserDataDir;
      if (!sourceUserDataDir) {
        throw new Error('browser clone requires "--source-user-data-dir <path>".');
      }
      const result = await manager.clonePersistentBrowser({
        sourceUserDataDir,
        ...(parsed.options.sourceProfileDirectory === undefined
          ? {}
          : { sourceProfileDirectory: parsed.options.sourceProfileDirectory }),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "reset": {
      await manager.reset();
      process.stdout.write(`${JSON.stringify({ reset: true }, null, 2)}\n`);
      return;
    }
    case "delete": {
      await manager.delete();
      process.stdout.write(`${JSON.stringify({ deleted: true }, null, 2)}\n`);
      return;
    }
    default:
      throw new Error(`Unknown browser command: ${parsed.command.join(" ")}`);
  }
}

async function handleRecordCommandEntry(parsed: ParsedCommandLine): Promise<void> {
  if (parsed.options.workspace === undefined) {
    throw new Error('record requires "--workspace <id>".');
  }

  const url = parsed.options.url ?? parsed.rest[0];
  if (url === undefined) {
    throw new Error('record requires "--url <value>" or a positional URL.');
  }

  const provider = resolveCliProvider(parsed);
  assertCloudCliOptionsMatchProvider(parsed, provider.mode);
  const engineName = resolveCliEngineName(parsed);
  if (engineName !== "playwright") {
    throw new Error('record requires engine=playwright.');
  }
  const rootDir = process.cwd();
  const recordBrowser = parsed.options.browser;

  if (provider.mode === "cloud") {
    if (typeof recordBrowser === "object") {
      throw new Error('record does not support browser.mode="attach".');
    }

    const runtimeProvider = buildCliRuntimeProvider(parsed, provider.mode);
    const runtimeConfig = resolveOpensteerRuntimeConfig({
      ...(runtimeProvider === undefined ? {} : { provider: runtimeProvider }),
      environment: process.env,
    });

    await runOpensteerCloudRecordCommand({
      cloudConfig: runtimeConfig.cloud!,
      workspace: parsed.options.workspace,
      url,
      rootDir,
      ...(recordBrowser === undefined ? {} : { browser: recordBrowser }),
      ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
      ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
      ...(parsed.options.output === undefined ? {} : { outputPath: parsed.options.output }),
    });
    return;
  }

  if (parsed.options.launch?.headless === true) {
    throw new Error('record requires a headed browser. Remove "--headless true".');
  }

  if (typeof recordBrowser === "object") {
    throw new Error('record does not support browser.mode="attach".');
  }

  const launch = {
    ...(parsed.options.launch ?? {}),
    headless: false,
  };

  const browserManager = new OpensteerBrowserManager({
    rootDir,
    workspace: parsed.options.workspace,
    engineName,
    browser: "persistent",
    launch,
    ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
  });

  const runtime = createOpensteerSemanticRuntime({
    provider: {
      mode: "local",
    },
    engine: engineName,
    runtimeOptions: {
      rootPath: browserManager.rootPath,
      cleanupRootOnClose: browserManager.cleanupRootOnDisconnect,
      workspace: parsed.options.workspace,
      browser: "persistent",
      launch,
      ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
    },
  });

  await runOpensteerRecordCommand({
    runtime,
    closeSession: () => closeOwnedLocalBrowserSession(runtime, browserManager),
    workspace: parsed.options.workspace,
    url,
    rootDir,
    ...(parsed.options.output === undefined ? {} : { outputPath: parsed.options.output }),
  });
}

async function closeOwnedLocalBrowserSession(
  runtime: OpensteerSemanticRuntime,
  browserManager: OpensteerBrowserManager,
): Promise<void> {
  let closeError: unknown;
  try {
    await runtime.close();
  } catch (error) {
    closeError = error;
  }
  try {
    await browserManager.close();
  } catch (error) {
    closeError ??= error;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
}

function buildOperationInput(
  operation: OpensteerSemanticOperationName,
  parsed: ParsedCommandLine,
): Record<string, unknown> {
  if (parsed.options.inputJson !== undefined) {
    return parsed.options.inputJson;
  }

  switch (operation) {
    case "session.open":
      return {
        ...(parsed.rest[0] === undefined ? {} : { url: parsed.rest[0] }),
        ...(parsed.options.workspace === undefined ? {} : { workspace: parsed.options.workspace }),
        ...(parsed.options.browser === undefined ? {} : { browser: parsed.options.browser }),
        ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
        ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
      };
    case "page.goto":
      if (parsed.rest[0] === undefined) {
        throw new Error("goto requires a URL.");
      }
      return {
        url: parsed.rest[0],
        ...(parsed.options.captureNetwork === undefined
          ? {}
          : { captureNetwork: parsed.options.captureNetwork }),
      };
    case "page.snapshot":
      return parsed.rest[0] === undefined ? {} : { mode: parsed.rest[0] };
    case "dom.click":
    case "dom.hover":
      return normalizeTargetInput(parsed, {
        ...(parsed.options.captureNetwork === undefined
          ? {}
          : { captureNetwork: parsed.options.captureNetwork }),
      });
    case "dom.input":
      if (parsed.options.text === undefined) {
        throw new Error('input requires "--text <value>".');
      }
      return {
        ...normalizeTargetInput(parsed, {
          ...(parsed.options.captureNetwork === undefined
            ? {}
            : { captureNetwork: parsed.options.captureNetwork }),
        }),
        text: parsed.options.text,
        ...(parsed.options.pressEnter === undefined
          ? {}
          : { pressEnter: parsed.options.pressEnter }),
      };
    case "dom.scroll":
      if (parsed.options.direction === undefined || parsed.options.amount === undefined) {
        throw new Error('scroll requires "--direction" and "--amount".');
      }
      return {
        ...normalizeTargetInput(parsed, {
          ...(parsed.options.captureNetwork === undefined
            ? {}
            : { captureNetwork: parsed.options.captureNetwork }),
        }),
        direction: parsed.options.direction,
        amount: parsed.options.amount,
      };
    case "dom.extract":
      if (parsed.options.description === undefined) {
        throw new Error('extract requires "--description <text>".');
      }
      return {
        description: parsed.options.description,
        ...(parsed.options.schemaJson === undefined ? {} : { schema: parsed.options.schemaJson }),
      };
    case "network.query":
      return {
        ...(parsed.options.capture === undefined ? {} : { capture: parsed.options.capture }),
        ...(parsed.options.urlFilter === undefined ? {} : { url: parsed.options.urlFilter }),
        ...(parsed.options.hostname === undefined ? {} : { hostname: parsed.options.hostname }),
        ...(parsed.options.path === undefined ? {} : { path: parsed.options.path }),
        ...(parsed.options.method === undefined ? {} : { method: parsed.options.method }),
        ...(parsed.options.status === undefined ? {} : { status: parsed.options.status }),
        ...(parsed.options.resourceType === undefined
          ? {}
          : { resourceType: parsed.options.resourceType }),
        ...(parsed.options.json === true ? { json: true } : {}),
        ...(parsed.options.before === undefined ? {} : { before: parsed.options.before }),
        ...(parsed.options.after === undefined ? {} : { after: parsed.options.after }),
        ...(parsed.options.limit === undefined ? {} : { limit: parsed.options.limit }),
      };
    case "network.detail": {
      const recordId = parsed.rest[0];
      if (recordId === undefined) {
        throw new Error("network detail requires a record id.");
      }
      return { recordId };
    }
    case "network.replay": {
      const recordId = parsed.rest[0];
      if (recordId === undefined) {
        throw new Error("replay requires a record id.");
      }
      return {
        recordId,
        ...(parsed.options.query === undefined ? {} : { query: parsed.options.query }),
        ...(parsed.options.header === undefined ? {} : { headers: parsed.options.header }),
        ...(parsed.options.bodyJson === undefined ? {} : { body: { json: parsed.options.bodyJson } }),
        ...(parsed.options.variables === undefined ? {} : { variables: parsed.options.variables }),
      };
    }
    case "session.cookies":
    case "session.storage":
    case "session.state":
      return parsed.options.domain === undefined ? {} : { domain: parsed.options.domain };
    case "session.close":
      return {};
    default:
      return {};
  }
}

function normalizeTargetInput(
  parsed: ParsedCommandLine,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const hasElement = parsed.options.element !== undefined;
  const hasSelector = parsed.options.selector !== undefined;
  const hasDescription = parsed.options.description !== undefined;

  // Build the target: --element takes precedence over --selector; --description alone is a target.
  // When --description is combined with --element or --selector, it becomes persistAsDescription.
  const target = hasElement
    ? { kind: "element", element: parsed.options.element! }
    : hasSelector
      ? { kind: "selector", selector: parsed.options.selector! }
      : hasDescription
        ? { kind: "description", description: parsed.options.description! }
        : undefined;

  if (target === undefined) {
    throw new Error('Specify at least one of "--element", "--selector", or "--description".');
  }

  const persistAsDescription =
    hasDescription && (hasElement || hasSelector) ? parsed.options.description! : undefined;

  return {
    ...input,
    target,
    ...(persistAsDescription !== undefined ? { persistAsDescription } : {}),
  };
}

function resolveOperation(command: readonly string[]): OpensteerSemanticOperationName | undefined {
  for (let length = Math.min(3, command.length); length >= 1; length -= 1) {
    const key = command.slice(0, length).join(" ");
    const operation = OPERATION_ALIASES.get(key);
    if (operation) {
      return operation;
    }
  }
  return undefined;
}

interface ParsedCliOptions {
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
  readonly inputJson?: Record<string, unknown>;
  readonly schemaJson?: Record<string, unknown>;
  readonly attachEndpoint?: string;
  readonly attachHeaders?: Readonly<Record<string, string>>;
  readonly sourceUserDataDir?: string;
  readonly sourceProfileDirectory?: string;
  readonly selector?: string;
  readonly description?: string;
  readonly element?: number;
  readonly text?: string;
  readonly pressEnter?: boolean;
  readonly captureNetwork?: string;
  readonly capture?: string;
  readonly urlFilter?: string;
  readonly hostname?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: number;
  readonly resourceType?: string;
  readonly before?: string;
  readonly after?: string;
  readonly limit?: number;
  readonly query?: Readonly<Record<string, string>>;
  readonly header?: Readonly<Record<string, string>>;
  readonly bodyJson?: Record<string, unknown>;
  readonly variables?: Record<string, unknown>;
  readonly domain?: string;
  readonly direction?: "up" | "down" | "left" | "right";
  readonly amount?: number;
}

interface ParsedCommandLine {
  readonly command: readonly string[];
  readonly rest: readonly string[];
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
  "attach-endpoint": { kind: "value" },
  "attach-header": { kind: "value", multiple: true },
  "fresh-tab": { kind: "boolean" },
  headless: { kind: "boolean" },
  "executable-path": { kind: "value" },
  arg: { kind: "value", multiple: true },
  "timeout-ms": { kind: "value" },
  "context-json": { kind: "value" },
  "input-json": { kind: "value" },
  "schema-json": { kind: "value" },
  "source-user-data-dir": { kind: "value" },
  "source-profile-directory": { kind: "value" },
  selector: { kind: "value" },
  description: { kind: "value" },
  element: { kind: "value" },
  text: { kind: "value" },
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
  "body-json": { kind: "value" },
  variables: { kind: "value" },
  domain: { kind: "value" },
  direction: { kind: "value" },
  amount: { kind: "value" },
} as const satisfies Record<string, { readonly kind: "boolean" | "value"; readonly multiple?: true }>;

function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const leadingTokens: string[] = [];
  let index = 0;
  while (index < argv.length && !argv[index]!.startsWith("--")) {
    leadingTokens.push(argv[index]!);
    index += 1;
  }

  const commandLength = resolveCommandLength(leadingTokens);
  const commandTokens = leadingTokens.slice(0, commandLength);
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
      const value = token.slice(separator + 1);
      rawOptions.set(key, [...(rawOptions.get(key) ?? []), value]);
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

    if (next === undefined || next.startsWith("--")) {
      throw new Error(
        `Option "--${key}" requires a value.${next?.startsWith("--") === true ? ` Use "--${key}=<value>" when the value begins with "--".` : ``}`,
      );
    }

    rawOptions.set(key, [...(rawOptions.get(key) ?? []), next]);
    index += 2;
  }

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

  const workspace = readSingle(rawOptions, "workspace");
  const url = readSingle(rawOptions, "url");
  const output = readSingle(rawOptions, "output");
  const sourceUserDataDir = readSingle(rawOptions, "source-user-data-dir");
  const sourceProfileDirectory = readSingle(rawOptions, "source-profile-directory");
  const selector = readSingle(rawOptions, "selector");
  const description = readSingle(rawOptions, "description");
  const element = readOptionalNumber(rawOptions, "element");
  const text = readSingle(rawOptions, "text");
  const pressEnter = readOptionalBoolean(rawOptions, "press-enter");
  const captureNetwork = readSingle(rawOptions, "capture-network");
  const capture = readSingle(rawOptions, "capture");
  const urlFilter = readSingle(rawOptions, "url");
  const hostname = readSingle(rawOptions, "hostname");
  const pathValue = readSingle(rawOptions, "path");
  const method = readSingle(rawOptions, "method");
  const status = readOptionalNumber(rawOptions, "status");
  const resourceType = readSingle(rawOptions, "type");
  const before = readSingle(rawOptions, "before");
  const after = readSingle(rawOptions, "after");
  const limit = readOptionalNumber(rawOptions, "limit");
  const query = parseKeyValueList(rawOptions.get("query"));
  const header = parseKeyValueList(rawOptions.get("header"));
  const bodyJson = readJsonObject(rawOptions, "body-json");
  const variables = readJsonObject(rawOptions, "variables");
  const domain = readSingle(rawOptions, "domain");
  const direction = readSingle(rawOptions, "direction") as
    | ParsedCliOptions["direction"]
    | undefined;
  const amount = readOptionalNumber(rawOptions, "amount");
  const contextJson = readJsonObject(rawOptions, "context-json");
  const inputJson = readJsonObject(rawOptions, "input-json");
  const schemaJson = readJsonObject(rawOptions, "schema-json");
  const providerValue = readSingle(rawOptions, "provider");
  const provider =
    providerValue === undefined
      ? undefined
      : normalizeOpensteerProviderMode(providerValue, "--provider");
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
  const global = readOptionalBoolean(rawOptions, "global");
  const yes = readOptionalBoolean(rawOptions, "yes");
  const copy = readOptionalBoolean(rawOptions, "copy");
  const all = readOptionalBoolean(rawOptions, "all");
  const list = readOptionalBoolean(rawOptions, "list");

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
    ...(global === undefined ? {} : { global }),
    ...(yes === undefined ? {} : { yes }),
    ...(copy === undefined ? {} : { copy }),
    ...(all === undefined ? {} : { all }),
    ...(list === undefined ? {} : { list }),
    ...(browser === undefined ? {} : { browser }),
    ...(Object.keys(launch).length === 0 ? {} : { launch }),
    ...(contextJson === undefined ? {} : { context: contextJson }),
    ...(inputJson === undefined ? {} : { inputJson }),
    ...(schemaJson === undefined ? {} : { schemaJson }),
    ...(attachEndpoint === undefined ? {} : { attachEndpoint }),
    ...(attachHeaders === undefined ? {} : { attachHeaders }),
    ...(sourceUserDataDir === undefined ? {} : { sourceUserDataDir }),
    ...(sourceProfileDirectory === undefined ? {} : { sourceProfileDirectory }),
    ...(selector === undefined ? {} : { selector }),
    ...(description === undefined ? {} : { description }),
    ...(element === undefined ? {} : { element }),
    ...(text === undefined ? {} : { text }),
    ...(pressEnter === undefined ? {} : { pressEnter }),
    ...(captureNetwork === undefined ? {} : { captureNetwork }),
    ...(capture === undefined ? {} : { capture }),
    ...(urlFilter === undefined ? {} : { urlFilter }),
    ...(hostname === undefined ? {} : { hostname }),
    ...(pathValue === undefined ? {} : { path: pathValue }),
    ...(method === undefined ? {} : { method }),
    ...(status === undefined ? {} : { status }),
    ...(resourceType === undefined ? {} : { resourceType }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
    ...(query === undefined ? {} : { query }),
    ...(header === undefined ? {} : { header }),
    ...(bodyJson === undefined ? {} : { bodyJson }),
    ...(variables === undefined ? {} : { variables }),
    ...(domain === undefined ? {} : { domain }),
    ...(direction === undefined ? {} : { direction }),
    ...(amount === undefined ? {} : { amount }),
  };

  return {
    command: commandTokens,
    rest,
    options,
  };
}

function resolveCliBootstrapAction(argv: readonly string[]): "help" | "version" | undefined {
  if (argv.length === 0) {
    return "help";
  }

  for (const token of argv) {
    if (token === "--version") {
      return "version";
    }
    if (token === "--help" || token === "-h") {
      return "help";
    }
  }

  return undefined;
}

function buildCliBrowserProfile(
  parsed: ParsedCommandLine,
): { readonly profileId: string; readonly reuseIfActive?: true } | undefined {
  if (
    parsed.options.cloudProfileReuseIfActive === true &&
    parsed.options.cloudProfileId === undefined
  ) {
    throw new Error('"--cloud-profile-reuse-if-active" requires "--cloud-profile-id <id>".');
  }

  return parsed.options.cloudProfileId === undefined
    ? undefined
    : {
        profileId: parsed.options.cloudProfileId,
        ...(parsed.options.cloudProfileReuseIfActive === true ? { reuseIfActive: true } : {}),
      };
}

function buildCliExplicitProvider(parsed: ParsedCommandLine): OpensteerProviderOptions | undefined {
  if (parsed.options.provider === "local") {
    return { mode: "local" };
  }
  if (parsed.options.provider === "cloud") {
    return { mode: "cloud" };
  }
  return undefined;
}

function resolveCliEngineName(parsed: ParsedCommandLine): OpensteerEngineName {
  return resolveOpensteerEngineName({
    ...(parsed.options.requestedEngineName === undefined
      ? {}
      : { requested: parsed.options.requestedEngineName }),
    ...(process.env.OPENSTEER_ENGINE === undefined
      ? {}
      : { environment: process.env.OPENSTEER_ENGINE }),
  });
}

function resolveCliProvider(parsed: ParsedCommandLine): OpensteerResolvedProvider {
  const explicitProvider = buildCliExplicitProvider(parsed);
  return resolveOpensteerProvider({
    ...(explicitProvider === undefined ? {} : { provider: explicitProvider }),
    ...(process.env.OPENSTEER_PROVIDER === undefined
      ? {}
      : { environmentProvider: process.env.OPENSTEER_PROVIDER }),
  });
}

function buildCliRuntimeProvider(
  parsed: ParsedCommandLine,
  providerMode: OpensteerProviderMode,
): OpensteerProviderOptions | undefined {
  const explicitProvider = buildCliExplicitProvider(parsed);
  if (providerMode === "local") {
    return explicitProvider?.mode === "local" ? explicitProvider : undefined;
  }

  const browserProfile = buildCliBrowserProfile(parsed);
  const hasCloudOverrides =
    parsed.options.cloudBaseUrl !== undefined ||
    parsed.options.cloudApiKey !== undefined ||
    parsed.options.cloudAppBaseUrl !== undefined ||
    browserProfile !== undefined;
  if (!hasCloudOverrides && explicitProvider?.mode !== "cloud") {
    return undefined;
  }

  return {
    mode: "cloud",
    ...(parsed.options.cloudBaseUrl === undefined ? {} : { baseUrl: parsed.options.cloudBaseUrl }),
    ...(parsed.options.cloudApiKey === undefined ? {} : { apiKey: parsed.options.cloudApiKey }),
    ...(parsed.options.cloudAppBaseUrl === undefined
      ? {}
      : { appBaseUrl: parsed.options.cloudAppBaseUrl }),
    ...(browserProfile === undefined ? {} : { browserProfile }),
  };
}

function assertCloudCliOptionsMatchProvider(
  parsed: ParsedCommandLine,
  providerMode: OpensteerProviderMode,
): void {
  if (
    providerMode !== "cloud" &&
    (parsed.options.cloudBaseUrl !== undefined ||
      parsed.options.cloudApiKey !== undefined ||
      parsed.options.cloudAppBaseUrl !== undefined ||
      parsed.options.cloudProfileId !== undefined ||
      parsed.options.cloudProfileReuseIfActive === true)
  ) {
    throw new Error(
      'Cloud-specific options require provider=cloud. Set "--provider cloud" or OPENSTEER_PROVIDER=cloud.',
    );
  }
}

async function handleStatusCommand(parsed: ParsedCommandLine): Promise<void> {
  const provider = resolveCliProvider(parsed);
  assertCloudCliOptionsMatchProvider(parsed, provider.mode);
  const runtimeProvider = buildCliRuntimeProvider(parsed, provider.mode);
  const runtimeConfig = resolveOpensteerRuntimeConfig({
    ...(runtimeProvider === undefined ? {} : { provider: runtimeProvider }),
    environment: process.env,
  });
  const status = await collectOpensteerStatus({
    rootDir: process.cwd(),
    ...(parsed.options.workspace === undefined ? {} : { workspace: parsed.options.workspace }),
    provider,
    ...(runtimeConfig.cloud === undefined ? {} : { cloudConfig: runtimeConfig.cloud }),
  });

  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }

  process.stdout.write(renderOpensteerStatus(status));
}

function parseKeyValueList(
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

function readSingle(options: Map<string, string[]>, name: string): string | undefined {
  const values = options.get(name);
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  return values[values.length - 1];
}

function readOptionalBoolean(options: Map<string, string[]>, name: string): boolean | undefined {
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

function readOptionalNumber(options: Map<string, string[]>, name: string): number | undefined {
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

function readJsonObject(
  options: Map<string, string[]>,
  name: string,
): Record<string, unknown> | undefined {
  const value = readSingle(options, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Option "--${name}" must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function resolveCommandLength(tokens: readonly string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  if (tokens[0] === "browser") {
    return Math.min(tokens.length, 2);
  }
  if (tokens[0] === "skills") {
    return Math.min(tokens.length, 2);
  }
  if (tokens[0] === "run") {
    return 1;
  }
  if (tokens[0] === "status") {
    return 1;
  }
  if (tokens[0] === "record") {
    return 1;
  }
  for (let length = Math.min(3, tokens.length); length >= 1; length -= 1) {
    if (OPERATION_ALIASES.has(tokens.slice(0, length).join(" "))) {
      return length;
    }
  }
  return Math.min(tokens.length, 1);
}

function renderOperationOutput(
  operation: OpensteerSemanticOperationName,
  result: unknown,
  asJson: boolean,
): string {
  if (asJson) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  switch (operation) {
    case "page.snapshot":
      return formatSnapshotOutput(result);
    case "network.query":
      return formatNetworkQueryOutput(result);
    case "network.detail":
      return formatNetworkDetailOutput(result);
    case "network.replay":
      return formatReplayOutput(result);
    case "session.cookies":
      return formatCookiesOutput(result);
    case "session.storage":
      return formatStorageOutput(result);
    case "session.state":
      return formatStateOutput(result);
    default:
      return `${JSON.stringify(result, null, 2)}\n`;
  }
}

function formatSnapshotOutput(result: unknown): string {
  if (
    result !== null &&
    typeof result === "object" &&
    typeof (result as { readonly html?: unknown }).html === "string"
  ) {
    return `${(result as { readonly html: string }).html}\n`;
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

function formatNetworkQueryOutput(result: unknown): string {
  const records = readArrayField(result, "records");
  const capture = summarizeCapture(records);
  const lines = [`[network.query] ${records.length} record${records.length === 1 ? "" : "s"}${capture === undefined ? "" : ` from capture "${capture}"`}`];
  for (const record of records) {
    const graphql = readObjectField(record, "graphql");
    const operationName = readStringField(graphql, "operationName");
    lines.push(
      `${readStringField(record, "recordId") ?? "rec:unknown"}  ${readStringField(record, "method") ?? "GET"} ${readStatus(record)}  ${readStringField(record, "resourceType") ?? "unknown"}  ${readStringField(record, "url") ?? ""}${operationName === undefined ? "" : `  [query: ${operationName}]`}`,
    );
    const request = readObjectField(record, "request");
    const response = readObjectField(record, "response");
    const websocket = readObjectField(record, "websocket");
    if (request !== undefined) {
      lines.push(`  request: ${formatBodySummary(request)}`);
    }
    if (response !== undefined) {
      lines.push(`  response: ${formatBodySummary(response)}`);
    }
    const subprotocol = readStringField(websocket, "subprotocol");
    if (subprotocol !== undefined) {
      lines.push(`  subprotocol: ${subprotocol}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatNetworkDetailOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const lines = [`[network.detail] ${readStringField(result, "recordId") ?? "unknown"}`, ""];
  const summary = readObjectField(result, "summary");
  if (summary !== undefined) {
    lines.push(
      `${readStringField(summary, "method") ?? "GET"} ${readStatus(summary)} ${readStringField(summary, "url") ?? ""}`,
    );
  }

  const graphql = readObjectField(result, "graphql");
  if (graphql !== undefined) {
    const operationType = readStringField(graphql, "operationType");
    const operationName = readStringField(graphql, "operationName");
    lines.push(
      `${["GraphQL:", operationType, operationName].filter((value) => value !== undefined).join(" ")}`,
    );
    const variables = (graphql as { readonly variables?: unknown }).variables;
    if (variables !== undefined) {
      lines.push("Variables:");
      lines.push(indentLines(stringifyValue(variables)));
    }
  }

  const requestHeaders = readArrayField(result, "requestHeaders");
  if (requestHeaders.length > 0) {
    lines.push("", "Request headers:");
    lines.push(...requestHeaders.map((header) => formatHeaderLine(header)));
  }

  const responseHeaders = readArrayField(result, "responseHeaders");
  if (responseHeaders.length > 0) {
    lines.push("", "Response headers:");
    lines.push(...responseHeaders.map((header) => formatHeaderLine(header)));
  }

  const cookiesSent = readArrayField(result, "cookiesSent");
  if (cookiesSent.length > 0) {
    lines.push("", "Cookies sent:");
    lines.push(
      ...cookiesSent.map((cookie) => {
        const name = readStringField(cookie, "name") ?? "cookie";
        const value = readStringField(cookie, "value") ?? "";
        return `  ${name}: ${truncateInline(value, 80)}`;
      }),
    );
  }

  const requestBody = readObjectField(result, "requestBody");
  if (requestBody !== undefined) {
    lines.push("", formatBodyPreview("Request body", requestBody));
  }

  const responseBody = readObjectField(result, "responseBody");
  if (responseBody !== undefined) {
    lines.push("", formatBodyPreview("Response body", responseBody));
  }

  const redirectChain = readArrayField(result, "redirectChain");
  if (redirectChain.length > 0) {
    lines.push("", `Redirect chain (${redirectChain.length} hop${redirectChain.length === 1 ? "" : "s"}):`);
    redirectChain.forEach((hop, index) => {
      const location = readStringField(hop, "location");
      lines.push(
        `  ${index + 1}. ${readStringField(hop, "method") ?? "GET"} ${readStatus(hop)} ${readStringField(hop, "url") ?? ""}${location === undefined ? "" : `  ->  Location: ${location}`}`,
      );
    });
  }

  const notes = readArrayField(result, "notes")
    .map((entry) => (typeof entry === "string" ? entry : undefined))
    .filter((entry): entry is string => entry !== undefined);
  if (notes.length > 0) {
    lines.push("", ...notes.map((note) => `Note: ${note}`));
  }

  return `${lines.join("\n")}\n`;
}

function formatReplayOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const attempts = readArrayField(result, "attempts");
  const transport = readStringField(result, "transport");
  const response = readObjectField(result, "response");
  const status = response === undefined ? "FAILED" : String(readNumberField(response, "status") ?? "FAILED");
  const lines = [
    transport === undefined
      ? `[replay] ${readStringField(result, "recordId") ?? "unknown"} -> ${status}`
      : `[replay] ${readStringField(result, "recordId") ?? "unknown"} -> ${status} (${transport})`,
  ];

  const note = readStringField(result, "note");
  if (note !== undefined) {
    lines.push(`  note: ${note}`);
  }

  if (response !== undefined) {
    const contentType = findHeaderValue(readArrayField(response, "headers"), "content-type");
    lines.push(
      "",
      ...(contentType === undefined ? [] : [`content-type: ${contentType}`]),
      ...(readObjectField(response, "body") === undefined
        ? []
        : [`body: ${formatBodyBytes(readObjectField(response, "body"))}`]),
    );
    const data = (result as { readonly data?: unknown }).data;
    if (data !== undefined) {
      lines.push("", stringifyValue(data));
    }
  }

  if (attempts.length > 0) {
    lines.push("", "Attempts:");
    lines.push(
      ...attempts.map((attempt) => {
        const attemptNote = readStringField(attempt, "note");
        const error = readStringField(attempt, "error");
        return `  ${readStringField(attempt, "transport") ?? "unknown"}: ${readNumberField(attempt, "status") ?? "error"}${attemptNote === undefined ? "" : ` (${attemptNote})`}${error === undefined ? "" : ` ${error}`}`;
      }),
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatCookiesOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const cookies = readArrayField(result, "cookies");
  const domain = readStringField(result, "domain");
  const lines = [`[cookies] ${cookies.length} cookie${cookies.length === 1 ? "" : "s"}${domain === undefined ? "" : ` for ${domain}`}`];
  for (const cookie of cookies) {
    const flags = [
      readBooleanField(cookie, "session") === true ? "session" : undefined,
      readBooleanField(cookie, "httpOnly") === true ? "httpOnly" : undefined,
      readBooleanField(cookie, "secure") === true ? "secure" : undefined,
      readStringField(cookie, "expiresAt"),
    ].filter((value) => value !== undefined);
    lines.push(
      `  ${padRight(readStringField(cookie, "name") ?? "cookie", 20)} ${truncateInline(readStringField(cookie, "value") ?? "", 48)}${flags.length === 0 ? "" : `  ${flags.join("  ")}`}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatStorageOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const domains = readArrayField(result, "domains");
  const lines: string[] = [];
  for (const domain of domains) {
    const domainName = readStringField(domain, "domain") ?? "unknown";
    const localStorage = readArrayField(domain, "localStorage");
    const sessionStorage = readArrayField(domain, "sessionStorage");
    lines.push(`[storage] localStorage for ${domainName} (${localStorage.length} key${localStorage.length === 1 ? "" : "s"})`, "");
    lines.push(...localStorage.map((entry) => formatStorageEntry(entry)));
    lines.push("", `[storage] sessionStorage for ${domainName} (${sessionStorage.length} key${sessionStorage.length === 1 ? "" : "s"})`, "");
    lines.push(...sessionStorage.map((entry) => formatStorageEntry(entry)), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatStateOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const domains = readArrayField(result, "domains");
  const lines: string[] = [];
  for (const domain of domains) {
    const name = readStringField(domain, "domain") ?? "unknown";
    lines.push(`[state] ${name}`, "");
    const cookies = readArrayField(domain, "cookies");
    lines.push(`Cookies (${cookies.length}):`);
    lines.push(
      ...cookies.map(
        (cookie) =>
          `  ${padRight(readStringField(cookie, "name") ?? "cookie", 16)} ${truncateInline(readStringField(cookie, "value") ?? "", 36)}`,
      ),
    );
    const hiddenFields = readArrayField(domain, "hiddenFields");
    lines.push("", `Hidden fields (${hiddenFields.length}):`);
    lines.push(
      ...hiddenFields.map(
        (field) =>
          `  ${readStringField(field, "path") ?? "input"}  = ${JSON.stringify(readStringField(field, "value") ?? "")}`,
      ),
    );
    const localStorage = readArrayField(domain, "localStorage");
    lines.push("", `localStorage (${localStorage.length} key${localStorage.length === 1 ? "" : "s"}):`);
    lines.push(...localStorage.map((entry) => formatStorageEntry(entry)));
    const sessionStorage = readArrayField(domain, "sessionStorage");
    lines.push("", `sessionStorage (${sessionStorage.length} key${sessionStorage.length === 1 ? "" : "s"}):`);
    lines.push(...sessionStorage.map((entry) => formatStorageEntry(entry)));
    const globals = readObjectField(domain, "globals");
    if (globals !== undefined) {
      lines.push("", "Globals:");
      for (const [key, value] of Object.entries(globals)) {
        lines.push(`  ${key} = ${truncateInline(stringifyScalarLike(value), 80)}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatBodySummary(body: unknown): string {
  if (body === null || typeof body !== "object") {
    return "unknown";
  }
  if (readBooleanField(body, "streaming") === true) {
    return `streaming (${readStringField(body, "contentType") ?? "unknown"})`;
  }
  return `${formatBytes(readNumberField(body, "bytes"))} (${readStringField(body, "contentType") ?? "unknown"})`;
}

function formatBodyPreview(label: string, preview: unknown): string {
  const header = `${label} (${formatBytes(readNumberField(preview, "bytes"))}${readStringField(preview, "contentType") === undefined ? "" : `, ${readStringField(preview, "contentType")}`}${readBooleanField(preview, "truncated") === true ? ", truncated" : ""}):`;
  const data = readUnknownField(preview, "data");
  if (data === undefined) {
    return header;
  }
  return `${header}\n${indentLines(stringifyValue(data))}`;
}

function formatStorageEntry(entry: unknown): string {
  return `  ${padRight(readStringField(entry, "key") ?? "key", 18)} ${truncateInline(readStringField(entry, "value") ?? "", 80)}`;
}

function formatHeaderLine(header: unknown): string {
  return `  ${readStringField(header, "name") ?? "header"}: ${readStringField(header, "value") ?? ""}`;
}

function readArrayField(value: unknown, key: string): readonly unknown[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

function readObjectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return field !== null && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function readUnknownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readStringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function readNumberField(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}

function readStatus(value: unknown): string {
  const status = readNumberField(value, "status");
  return status === undefined ? "-" : String(status);
}

function findHeaderValue(headers: readonly unknown[], name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const header of headers) {
    if (readStringField(header, "name")?.toLowerCase() === normalized) {
      return readStringField(header, "value");
    }
  }
  return undefined;
}

function formatBodyBytes(body: Record<string, unknown> | undefined): string {
  if (body === undefined) {
    return "0 bytes";
  }
  return formatBytes(readNumberField(body, "bytes"));
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "unknown";
  }
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function summarizeCapture(records: readonly unknown[]): string | undefined {
  const captures = new Set(
    records
      .map((record) => readStringField(record, "capture"))
      .filter((capture): capture is string => capture !== undefined),
  );
  return captures.size === 1 ? [...captures][0] : undefined;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function truncateInline(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 18))}...${value.length} chars`;
}

function stringifyValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function stringifyScalarLike(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function indentLines(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function printHelp(): void {
  process.stdout.write(`Opensteer v2 CLI

Browser lifecycle:
  opensteer open <url> [--workspace <id>] [--attach-endpoint <url>]
  opensteer close --workspace <id>
  opensteer status [--workspace <id>] [--json]
  opensteer browser status --workspace <id>
  opensteer browser clone --workspace <id> --source-user-data-dir <path>
  opensteer browser reset --workspace <id>
  opensteer browser delete --workspace <id>

Navigation:
  opensteer goto <url> --workspace <id> [--capture-network <label>]

DOM inspection:
  opensteer snapshot [action|extraction] --workspace <id>

DOM interaction (all support --capture-network <label>):
  opensteer click --workspace <id> (--element <n> | --selector <css> | --description <text>)
  opensteer input --workspace <id> --text <value> (--element <n> | --selector <css> | --description <text>)
  When used with --element or --selector, --description persists a reusable descriptor.
  opensteer extract --workspace <id> --description <text> [--schema-json <json>]

Network inspection:
  opensteer network query --workspace <id> [--json] [--url <pattern>] [--capture <label>] [filters...]
  opensteer network detail <recordId> --workspace <id>

Replay:
  opensteer replay <recordId> --workspace <id> [--query key=value] [--header key=value]

Browser state:
  opensteer cookies --workspace <id> [--domain <domain>]
  opensteer storage --workspace <id> [--domain <domain>]
  opensteer state --workspace <id> [--domain <domain>]

Advanced:
  opensteer record --workspace <id> --url <url> [--output <path>]
  opensteer skills install [--skill <name>] [--agent <name>] [--global] [--yes]
  opensteer run <semantic-operation> --workspace <id> --input-json <json>

Common options:
  --help
  --version
  --workspace <id>
  --url <url>
  --output <path>
  --provider local|cloud
  --cloud-base-url <url>
  --cloud-api-key <key>
  --cloud-app-base-url <url>
  --cloud-profile-id <id>
  --cloud-profile-reuse-if-active <true|false>
  --json <true|false>
  --engine playwright|abp
  --attach-endpoint <url>
  --fresh-tab <true|false>
  --headless <true|false>
  --executable-path <path>
  --arg <value>        repeatable
  --timeout-ms <ms>
  --context-json <json>
  --input-json <json>
  --capture-network <label>
  --capture <label>
  --url <pattern>
  --hostname <host>
  --path <pattern>
  --method <verb>
  --status <code>
  --type <resource-type>
  --before <recordId>
  --after <recordId>
  --limit <n>
  --query <key=value>  repeatable
  --header <key=value> repeatable
  --body-json <json>
  --variables <json>
  --domain <domain>
  --skill <name>      repeatable
  --agent <name>      repeatable
`);
}

function printVersion(): void {
  process.stdout.write(`${opensteerPackage.version}\n`);
}

main().catch((error) => {
  const payload =
    error instanceof Error
      ? {
          error: {
            name: error.name,
            message: error.message,
          },
        }
      : {
          error: {
            name: "Error",
            message: String(error),
          },
        };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
