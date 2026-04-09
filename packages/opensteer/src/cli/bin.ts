#!/usr/bin/env node

import process from "node:process";

import opensteerPackage from "../../package.json" with { type: "json" };

import { OpensteerBrowserManager } from "../browser-manager.js";
import {
  resolveOpensteerEngineName,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import { discoverLocalCdpBrowsers, inspectCdpEndpoint } from "../local-browser/cdp-discovery.js";
import {
  assertProviderSupportsEngine,
  resolveOpensteerProvider,
  type OpensteerProviderMode,
  type OpensteerProviderOptions,
  type OpensteerResolvedProvider,
} from "../provider/config.js";
import {
  createOpensteerSemanticRuntime,
  resolveOpensteerRuntimeConfig,
} from "../sdk/runtime-resolution.js";
import { dispatchSemanticOperation } from "./dispatch.js";
import { loadCliEnvironment } from "./env-loader.js";
import { getHelpText } from "./help.js";
import { buildOperationInput } from "./operation-input.js";
import { renderOperationOutput } from "./output.js";
import { parseCommandLine, type ParsedCommandLine } from "./parse.js";
import { runOpensteerCloudRecordCommand, runOpensteerRecordCommand } from "./record.js";
import { runOpensteerSkillsInstaller } from "./skills-installer.js";
import { collectOpensteerStatus, renderOpensteerStatus } from "./status.js";
import { resolveOperation } from "./commands.js";
import { runExecExpression } from "./exec.js";

const emitProcessWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const name =
    warning instanceof Error
      ? warning.name
      : typeof args[0] === "string"
        ? args[0]
        : undefined;
  const message = warning instanceof Error ? warning.message : warning;
  if (
    name === "ExperimentalWarning" &&
    typeof message === "string" &&
    message.includes("SQLite is an experimental feature")
  ) {
    return;
  }
  return emitProcessWarning(warning, ...(args as []));
}) as typeof process.emitWarning;

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

  if (parsed.command[0] === "exec") {
    await handleExecCommand(parsed);
    return;
  }

  const operation = resolveOperation(parsed.command);
  if (!operation) {
    throw new Error(`Unknown command: ${parsed.command.join(" ")}`);
  }

  if (parsed.options.workspace === undefined) {
    throw new Error(
      'Stateful commands require "--workspace <id>" or OPENSTEER_WORKSPACE.',
    );
  }

  const { engineName, provider, runtimeProvider } = resolveCliRuntimeSelection(parsed);

  if (operation === "session.close") {
    await handleCloseCommand(parsed, engineName, provider.mode, runtimeProvider);
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
  let renderOperation = operation;
  try {
    const input = await buildOperationInput(operation, parsed, runtime);
    result = await dispatchSemanticOperation(runtime, operation, input);

    if (parsed.command[0] === "tab" && operation !== "page.list") {
      renderOperation = "page.list";
      result = await runtime.listPages({});
    }

    process.stdout.write(renderOperationOutput(renderOperation, result, input));
  } finally {
    await runtime.disconnect().catch(() => undefined);
  }
}

async function handleExecCommand(parsed: ParsedCommandLine): Promise<void> {
  if (parsed.options.workspace === undefined) {
    throw new Error('exec requires "--workspace <id>" or OPENSTEER_WORKSPACE.');
  }
  const expression = parsed.rest.join(" ");
  if (!expression) {
    throw new Error("exec requires an expression. Example: exec \"await this.evaluate('document.title')\"");
  }

  const { engineName, runtimeProvider } = resolveCliRuntimeSelection(parsed);
  const { Opensteer } = await import("../sdk/opensteer.js");
  const opensteer = new Opensteer({
    workspace: parsed.options.workspace,
    rootDir: process.cwd(),
    ...(runtimeProvider === undefined ? {} : { provider: runtimeProvider }),
    engineName,
    ...(parsed.options.browser === undefined ? {} : { browser: parsed.options.browser }),
    ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
    ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
  });

  try {
    const result = await runExecExpression(opensteer, expression);
    if (result !== undefined) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
  } finally {
    await opensteer.disconnect().catch(() => undefined);
  }
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
    throw new Error(
      'Browser workspace commands require "--workspace <id>" or OPENSTEER_WORKSPACE.',
    );
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

async function handleCloseCommand(
  parsed: ParsedCommandLine,
  engineName: OpensteerEngineName,
  providerMode: OpensteerProviderMode,
  runtimeProvider: OpensteerProviderOptions | undefined,
): Promise<void> {
  if (providerMode === "cloud") {
    const runtime = createOpensteerSemanticRuntime({
      ...(runtimeProvider === undefined ? {} : { provider: runtimeProvider }),
      engine: engineName,
      runtimeOptions: {
        workspace: parsed.options.workspace!,
        rootDir: process.cwd(),
        browser: "persistent",
        ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
        ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
      },
    });
    const result = await runtime.close();
    process.stdout.write(renderOperationOutput("session.close", result));
    return;
  }

  const manager = new OpensteerBrowserManager({
    rootDir: process.cwd(),
    workspace: parsed.options.workspace!,
    engineName,
    browser: "persistent",
    ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
    ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
  });
  await manager.close();
  process.stdout.write(renderOperationOutput("session.close", { closed: true }));
}

async function handleRecordCommandEntry(parsed: ParsedCommandLine): Promise<void> {
  if (parsed.options.workspace === undefined) {
    throw new Error('record requires "--workspace <id>" or OPENSTEER_WORKSPACE.');
  }

  const url = parsed.options.url ?? parsed.rest[0];
  if (url === undefined) {
    throw new Error('record requires "--url <value>" or a positional URL.');
  }

  const provider = resolveCliProvider(parsed);
  assertCloudCliOptionsMatchProvider(parsed, provider.mode);
  const engineName = resolveCliEngineName(parsed);
  if (engineName !== "playwright") {
    throw new Error("record requires engine=playwright.");
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
  runtime: ReturnType<typeof createOpensteerSemanticRuntime>,
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

function resolveCliRuntimeSelection(parsed: ParsedCommandLine): {
  readonly engineName: OpensteerEngineName;
  readonly provider: OpensteerResolvedProvider;
  readonly runtimeProvider: OpensteerProviderOptions | undefined;
} {
  const engineName = resolveCliEngineName(parsed);
  const provider = resolveCliProvider(parsed);
  assertProviderSupportsEngine(provider.mode, engineName);
  assertCloudCliOptionsMatchProvider(parsed, provider.mode);
  const runtimeProvider = buildCliRuntimeProvider(parsed, provider.mode);
  return {
    engineName,
    provider,
    runtimeProvider,
  };
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

function printHelp(): void {
  process.stdout.write(getHelpText());
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
