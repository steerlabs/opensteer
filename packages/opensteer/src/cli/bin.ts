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
import { runOpensteerRecordCommand } from "./record.js";

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
  ["network tag", "network.tag"],
  ["network clear", "network.clear"],
  ["network minimize", "network.minimize"],
  ["network diff", "network.diff"],
  ["network probe", "network.probe"],
  ["reverse discover", "reverse.discover"],
  ["reverse query", "reverse.query"],
  ["reverse package create", "reverse.package.create"],
  ["reverse package run", "reverse.package.run"],
  ["reverse export", "reverse.export"],
  ["reverse report", "reverse.report"],
  ["reverse package get", "reverse.package.get"],
  ["reverse package list", "reverse.package.list"],
  ["reverse package patch", "reverse.package.patch"],
  ["interaction capture", "interaction.capture"],
  ["interaction get", "interaction.get"],
  ["interaction diff", "interaction.diff"],
  ["interaction replay", "interaction.replay"],
  ["artifact read", "artifact.read"],
  ["scripts capture", "scripts.capture"],
  ["scripts beautify", "scripts.beautify"],
  ["scripts deobfuscate", "scripts.deobfuscate"],
  ["scripts sandbox", "scripts.sandbox"],
  ["captcha solve", "captcha.solve"],
  ["inspect cookies", "inspect.cookies"],
  ["inspect storage", "inspect.storage"],
  ["request raw", "request.raw"],
  ["request-plan infer", "request-plan.infer"],
  ["request-plan write", "request-plan.write"],
  ["request-plan get", "request-plan.get"],
  ["request-plan list", "request-plan.list"],
  ["recipe write", "recipe.write"],
  ["recipe get", "recipe.get"],
  ["recipe list", "recipe.list"],
  ["recipe run", "recipe.run"],
  ["auth-recipe write", "auth-recipe.write"],
  ["auth-recipe get", "auth-recipe.get"],
  ["auth-recipe list", "auth-recipe.list"],
  ["auth-recipe run", "auth-recipe.run"],
  ["request execute", "request.execute"],
  ["computer execute", "computer.execute"],
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
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    process.stdout.write(`${JSON.stringify({ closed: true }, null, 2)}\n`);
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

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  if (provider.mode !== "local") {
    throw new Error(
      'record requires provider=local. Set "--provider local" or clear OPENSTEER_PROVIDER.',
    );
  }

  const engineName = resolveCliEngineName(parsed);
  if (engineName !== "playwright") {
    throw new Error('record requires engine=playwright.');
  }

  if (parsed.options.browser !== undefined && parsed.options.browser !== "persistent") {
    throw new Error('record only supports "--browser persistent".');
  }

  if (parsed.options.launch?.headless === true) {
    throw new Error('record requires a headed browser. Remove "--headless true".');
  }

  const rootDir = process.cwd();
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
      };
    case "page.snapshot":
      return parsed.rest[0] === undefined ? {} : { mode: parsed.rest[0] };
    case "dom.click":
    case "dom.hover":
      return normalizeTargetInput(parsed, {});
    case "dom.input":
      if (parsed.options.text === undefined) {
        throw new Error('input requires "--text <value>".');
      }
      return {
        ...normalizeTargetInput(parsed, {}),
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
        ...normalizeTargetInput(parsed, {}),
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
  const selected = Number(hasElement) + Number(hasSelector) + Number(hasDescription);
  if (selected !== 1) {
    throw new Error('Specify exactly one of "--element", "--selector", or "--description".');
  }

  return {
    ...input,
    target: hasElement
      ? { kind: "element", element: parsed.options.element! }
      : hasSelector
        ? { kind: "selector", selector: parsed.options.selector! }
        : { kind: "description", description: parsed.options.description! },
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
  browser: { kind: "value" },
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

  const browserKind = readSingle(rawOptions, "browser");
  const requestedEngineName = readSingle(rawOptions, "engine");
  const attachEndpoint = readSingle(rawOptions, "attach-endpoint");
  const attachHeaders = parseKeyValueList(rawOptions.get("attach-header"));
  const freshTab = readOptionalBoolean(rawOptions, "fresh-tab");
  const headless = readOptionalBoolean(rawOptions, "headless");
  const executablePath = readSingle(rawOptions, "executable-path");
  const launchArgs = rawOptions.get("arg");
  const timeoutMs = readOptionalNumber(rawOptions, "timeout-ms");
  const browser =
    browserKind === undefined
      ? attachEndpoint === undefined
        ? undefined
        : ({
            mode: "attach",
            endpoint: attachEndpoint,
            ...(attachHeaders === undefined ? {} : { headers: attachHeaders }),
            ...(freshTab === undefined ? {} : { freshTab }),
          } satisfies OpensteerBrowserOptions)
      : browserKind === "temporary" || browserKind === "persistent"
        ? browserKind
        : ({
            mode: "attach",
            ...(attachEndpoint === undefined ? {} : { endpoint: attachEndpoint }),
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
    browserProfile !== undefined;
  if (!hasCloudOverrides && explicitProvider?.mode !== "cloud") {
    return undefined;
  }

  return {
    mode: "cloud",
    ...(parsed.options.cloudBaseUrl === undefined ? {} : { baseUrl: parsed.options.cloudBaseUrl }),
    ...(parsed.options.cloudApiKey === undefined ? {} : { apiKey: parsed.options.cloudApiKey }),
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

function printHelp(): void {
  process.stdout.write(`Opensteer v2 CLI

Usage:
  opensteer open <url> --workspace <id> [--browser persistent|temporary|attach]
  opensteer goto <url> --workspace <id>
  opensteer snapshot [action|extraction] --workspace <id>
  opensteer click --workspace <id> (--element <n> | --selector <css> | --description <text>)
  opensteer input --workspace <id> --text <value> (--element <n> | --selector <css> | --description <text>)
  opensteer extract --workspace <id> --description <text> [--schema-json <json>]
  opensteer record --workspace <id> --url <url> [--output <path>]
  opensteer close --workspace <id>
  opensteer status [--workspace <id>] [--json]

  opensteer browser status --workspace <id>
  opensteer browser clone --workspace <id> --source-user-data-dir <path> [--source-profile-directory <name>]
  opensteer browser reset --workspace <id>
  opensteer browser delete --workspace <id>
  opensteer browser discover
  opensteer browser inspect --attach-endpoint <url>
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
  --cloud-profile-id <id>
  --cloud-profile-reuse-if-active <true|false>
  --json <true|false>
  --engine playwright|abp
  --browser temporary|persistent|attach
  --attach-endpoint <url>
  --fresh-tab <true|false>
  --headless <true|false>
  --executable-path <path>
  --arg <value>        repeatable
  --timeout-ms <ms>
  --context-json <json>
  --input-json <json>
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
