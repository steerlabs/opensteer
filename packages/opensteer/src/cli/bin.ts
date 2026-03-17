#!/usr/bin/env node

import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import type {
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
} from "@opensteer/protocol";

import {
  connectOpensteerService,
  ensureOpensteerService,
  OpensteerCliServiceError,
  requireOpensteerService,
} from "./client.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { resolveCloudConfig } from "../cloud/config.js";
import {
  normalizeOpensteerEngineName,
  resolveOpensteerEngineName,
} from "../internal/engine-selection.js";
import { fileUriToPath } from "../internal/filesystem.js";
import { runOpensteerLocalProfileCli } from "./local-profile.js";
import { runOpensteerProfileUploadCli } from "./profile-upload.js";
import {
  assertExecutionModeSupportsEngine,
  resolveOpensteerExecutionMode,
} from "../mode/config.js";
import {
  getOpensteerServiceMetadataPath,
  parseOpensteerServiceMetadata,
  readOpensteerServiceMetadata,
  removeOpensteerServiceMetadata,
  writeOpensteerServiceMetadata,
} from "./service-metadata.js";
import { runOpensteerMcpServer } from "./mcp.js";
import { runOpensteerServiceHost } from "./service-host.js";

interface ParsedCliArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, CliOptionValue>>;
}

type CliOptionValue = string | true | readonly string[];

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (parsed.options.connect !== undefined) {
    throw new Error('--connect has been removed. Use --cdp or --auto-connect with "open" instead.');
  }

  if (parsed.command === "service-host") {
    await runOpensteerServiceHost({
      name: readStringOption(parsed.options, "name") ?? "default",
      ...(readStringOption(parsed.options, "root-dir") === undefined
        ? {}
        : { rootDir: readStringOption(parsed.options, "root-dir")! }),
      ...(readStringOption(parsed.options, "engine") === undefined
        ? {}
        : {
            engine: normalizeOpensteerEngineName(
              readStringOption(parsed.options, "engine")!,
              "--engine",
            ),
          }),
    });
    return;
  }

  if (parsed.command === "mcp") {
    const mode = resolveCliExecutionMode(parsed.options);
    const engine = resolveOpensteerEngineName({
      requested: readStringOption(parsed.options, "engine"),
      environment: process.env.OPENSTEER_ENGINE,
    });
    assertExecutionModeSupportsEngine(mode, engine);
    await runOpensteerMcpServer({
      name: readStringOption(parsed.options, "name") ?? "default",
      ...(readStringOption(parsed.options, "root-dir") === undefined
        ? {}
        : { rootDir: readStringOption(parsed.options, "root-dir")! }),
      engine,
      ...(mode === "cloud" ? { cloud: true } : {}),
    });
    return;
  }

  if (parsed.command === "local-profile") {
    const exitCode = await runOpensteerLocalProfileCli(argv.slice(1));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (parsed.command === "profile") {
    const exitCode = await runOpensteerProfileUploadCli(argv.slice(1));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  assertEngineOptionAllowed(parsed);

  const sessionOptions = {
    ...(readStringOption(parsed.options, "name") === undefined
      ? {}
      : { name: readStringOption(parsed.options, "name")! }),
    ...(readStringOption(parsed.options, "root-dir") === undefined
      ? {}
      : { rootDir: readStringOption(parsed.options, "root-dir")! }),
  };

  switch (parsed.command) {
    case "open": {
      const mode = resolveCliExecutionMode(parsed.options);
      const engine = resolveOpensteerEngineName({
        requested: readStringOption(parsed.options, "engine"),
        environment: process.env.OPENSTEER_ENGINE,
      });
      assertExecutionModeSupportsEngine(mode, engine);
      const browser = parseBrowserOptions(parsed.options);
      const context = parseContextOptions(parsed.options);
      if (mode === "cloud") {
        const client = new OpensteerCloudClient(
          resolveCloudConfig({
            enabled: true,
            mode,
            ...(readStringOption(parsed.options, "cloud-profile-id") === undefined
              ? {}
              : {
                  browserProfile: {
                    profileId: readStringOption(parsed.options, "cloud-profile-id")!,
                    ...(readBooleanOption(parsed.options, "cloud-profile-reuse-if-active") === true
                      ? { reuseIfActive: true }
                      : {}),
                  },
                }),
          })!,
        );
        const rootPath = resolveOpensteerRootPath(sessionOptions.rootDir);
        const sessionName = sessionOptions.name ?? "default";
        const session = await client.createSession({
          name: sessionName,
          ...(browser === undefined ? {} : { browser }),
          ...(context === undefined ? {} : { context }),
          ...(readStringOption(parsed.options, "cloud-profile-id") === undefined
            ? {}
            : {
                browserProfile: {
                  profileId: readStringOption(parsed.options, "cloud-profile-id")!,
                  ...(readBooleanOption(parsed.options, "cloud-profile-reuse-if-active") === true
                    ? { reuseIfActive: true }
                    : {}),
                },
              }),
        });
        await writeOpensteerServiceMetadata(rootPath, {
          mode: "cloud",
          name: sessionName,
          rootPath,
          startedAt: Date.now(),
          baseUrl: session.baseUrl,
          sessionId: session.sessionId,
          authSource: "env",
        });
        const cloudSession = await requireOpensteerService(sessionOptions);
        const result = await cloudSession.invoke("session.open", {
          ...(parsed.positionals[0] === undefined ? {} : { url: parsed.positionals[0] }),
          ...(sessionOptions.name === undefined ? {} : { name: sessionOptions.name }),
        });
        writeJson(result);
        return;
      }

      const client = await ensureOpensteerService({
        ...sessionOptions,
        engine,
        launchContext: {
          execPath: process.execPath,
          execArgv: process.execArgv,
          scriptPath: process.argv[1]!,
          cwd: process.cwd(),
        },
      });
      const result = await client.invoke("session.open", {
        ...(parsed.positionals[0] === undefined ? {} : { url: parsed.positionals[0] }),
        ...(sessionOptions.name === undefined ? {} : { name: sessionOptions.name }),
        ...(browser === undefined ? {} : { browser }),
        ...(context === undefined ? {} : { context }),
      });
      writeJson(result);
      return;
    }

    case "goto": {
      const client = await requireOpensteerService(sessionOptions);
      const url = parsed.positionals[0];
      if (!url) {
        throw new Error("goto requires a URL");
      }
      const result = await client.invoke("page.goto", {
        url,
        ...buildNetworkTagInput(parsed.options),
      });
      writeJson(result);
      return;
    }

    case "snapshot": {
      const client = await requireOpensteerService(sessionOptions);
      const mode = parsed.positionals[0];
      const result = await client.invoke("page.snapshot", {
        ...(mode === undefined ? {} : { mode }),
      });
      writeJson(result);
      return;
    }

    case "click": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(parsed.positionals, parsed.options);
      const result = await client.invoke("dom.click", {
        ...target,
        ...buildNetworkTagInput(parsed.options),
      });
      writeJson(result);
      return;
    }

    case "hover": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(parsed.positionals, parsed.options);
      const result = await client.invoke("dom.hover", {
        ...target,
        ...buildNetworkTagInput(parsed.options),
      });
      writeJson(result);
      return;
    }

    case "input": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(parsed.positionals, parsed.options);
      const text =
        readStringOption(parsed.options, "text") ?? consumeTextPositional(parsed.positionals);
      if (!text) {
        throw new Error("input requires text");
      }
      const result = await client.invoke("dom.input", {
        ...target,
        text,
        ...(readBooleanOption(parsed.options, "press-enter") ? { pressEnter: true } : {}),
        ...buildNetworkTagInput(parsed.options),
      });
      writeJson(result);
      return;
    }

    case "scroll": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(parsed.positionals, parsed.options);
      const direction =
        readStringOption(parsed.options, "direction") ??
        consumeRemainingPositionals(parsed.positionals)[0];
      const amountRaw =
        readStringOption(parsed.options, "amount") ??
        consumeRemainingPositionals(parsed.positionals)[1];
      if (!direction || !amountRaw) {
        throw new Error("scroll requires direction and amount");
      }
      const amount = Number(amountRaw);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`scroll amount must be a positive number, received ${amountRaw}`);
      }
      const result = await client.invoke("dom.scroll", {
        ...target,
        direction,
        amount,
        ...buildNetworkTagInput(parsed.options),
      });
      writeJson(result);
      return;
    }

    case "extract": {
      const client = await requireOpensteerService(sessionOptions);
      const description = readStringOption(parsed.options, "description");
      if (!description) {
        throw new Error("extract requires --description");
      }
      const schemaRaw = readStringOption(parsed.options, "schema") ?? parsed.positionals[0];
      const result = await client.invoke<
        {
          readonly description: string;
          readonly schema?: Record<string, unknown>;
        },
        { readonly data: unknown }
      >("dom.extract", {
        description,
        ...(schemaRaw === undefined ? {} : { schema: parseJsonObject(schemaRaw, "schema") }),
      });
      writeJson(result.data);
      return;
    }

    case "network": {
      const action = parsed.positionals[0];
      const client = await requireOpensteerService(sessionOptions);

      if (action === "query") {
        const result = await client.invoke("network.query", buildNetworkQueryInput(parsed.options));
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      if (action === "save") {
        const tag = readStringOption(parsed.options, "tag");
        if (!tag) {
          throw new Error("network save requires --tag");
        }
        const result = await client.invoke("network.save", {
          ...buildNetworkFilterInput(parsed.options),
          tag,
        });
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      if (action === "clear") {
        const result = await client.invoke("network.clear", {
          ...(readStringOption(parsed.options, "tag") === undefined
            ? {}
            : { tag: readStringOption(parsed.options, "tag") }),
        });
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      throw new Error('network requires a subcommand: "query", "save", or "clear"');
    }

    case "plan": {
      const action = parsed.positionals[0];
      const client = await requireOpensteerService(sessionOptions);

      if (action === "write") {
        const key = readStringOption(parsed.options, "key");
        const version = readStringOption(parsed.options, "version");
        if (!key || !version) {
          throw new Error("plan write requires --key and --version");
        }

        const payload = await readJsonObjectOption(parsed.options, {
          inlineKey: "payload",
          fileKey: "payload-file",
          label: "payload",
        });
        if (payload === undefined) {
          throw new Error("plan write requires --payload or --payload-file");
        }
        const result = await client.invoke("request-plan.write", {
          ...(readStringOption(parsed.options, "id") === undefined
            ? {}
            : { id: readStringOption(parsed.options, "id") }),
          key,
          version,
          ...(readStringOption(parsed.options, "lifecycle") === undefined
            ? {}
            : { lifecycle: readStringOption(parsed.options, "lifecycle") }),
          ...(parseCsvOption(readStringOption(parsed.options, "tags")) === undefined
            ? {}
            : { tags: parseCsvOption(readStringOption(parsed.options, "tags")) }),
          payload,
          ...(buildProvenanceInput(parsed.options) === undefined
            ? {}
            : { provenance: buildProvenanceInput(parsed.options) }),
        });
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      if (action === "infer") {
        const recordId = readStringOption(parsed.options, "record-id");
        const key = readStringOption(parsed.options, "key");
        const version = readStringOption(parsed.options, "version");
        if (!recordId || !key || !version) {
          throw new Error("plan infer requires --record-id, --key, and --version");
        }
        const result = await client.invoke("request-plan.infer", {
          recordId,
          key,
          version,
          ...(readStringOption(parsed.options, "lifecycle") === undefined
            ? {}
            : { lifecycle: readStringOption(parsed.options, "lifecycle") }),
        });
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      if (action === "get") {
        const key = parsed.positionals[1] ?? readStringOption(parsed.options, "key");
        if (!key) {
          throw new Error("plan get requires a key");
        }
        const version = parsed.positionals[2] ?? readStringOption(parsed.options, "version");
        const result = await client.invoke("request-plan.get", {
          key,
          ...(version === undefined ? {} : { version }),
        });
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      if (action === "list") {
        const key = parsed.positionals[1] ?? readStringOption(parsed.options, "key");
        const result = await client.invoke("request-plan.list", {
          ...(key === undefined ? {} : { key }),
        });
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      throw new Error('plan requires a subcommand: "write", "infer", "get", or "list"');
    }

    case "request": {
      const client = await requireOpensteerService(sessionOptions);

      if (parsed.positionals[0] === "raw") {
        const url = parsed.positionals[1] ?? readStringOption(parsed.options, "url");
        if (!url) {
          throw new Error("request raw requires a URL");
        }
        const body = await parseRequestBodyInput(parsed.options);
        const result = await client.invoke("request.raw", {
          url,
          ...(readStringOption(parsed.options, "method") === undefined
            ? {}
            : { method: readStringOption(parsed.options, "method") }),
          ...(body === undefined ? {} : { body }),
          ...(readBooleanOption(parsed.options, "no-follow-redirects")
            ? { followRedirects: false }
            : {}),
          ...(parseHeaderEntries(readStringOptions(parsed.options, "header")).length === 0
            ? {}
            : { headers: parseHeaderEntries(readStringOptions(parsed.options, "header")) }),
        });
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      const executeOffset = parsed.positionals[0] === "execute" ? 1 : 0;
      const key = parsed.positionals[executeOffset] ?? readStringOption(parsed.options, "key");
      if (!key) {
        throw new Error("request execute requires a plan key");
      }
      const body = await parseRequestBodyInput(parsed.options);
      const params = parseKeyValueOptions(readStringOptions(parsed.options, "param"));
      const query = parseKeyValueOptions(readStringOptions(parsed.options, "query"));
      const headers = parseKeyValueOptions(readStringOptions(parsed.options, "header"));
      const result = await client.invoke("request.execute", {
        key,
        ...(readStringOption(parsed.options, "version") === undefined
          ? {}
          : { version: readStringOption(parsed.options, "version") }),
        ...(params.size === 0 ? {} : { params: Object.fromEntries(params) }),
        ...(query.size === 0 ? {} : { query: Object.fromEntries(query) }),
        ...(headers.size === 0 ? {} : { headers: Object.fromEntries(headers) }),
        ...(body === undefined ? {} : { body }),
        ...(readBooleanOption(parsed.options, "no-validate") === true
          ? { validateResponse: false }
          : {}),
      });
      await writeJsonOutput(result, readStringOption(parsed.options, "output"));
      return;
    }

    case "computer": {
      const client = await requireOpensteerService(sessionOptions);
      const actionRaw = readStringOption(parsed.options, "action") ?? parsed.positionals[0];
      if (!actionRaw) {
        throw new Error("computer requires an action JSON object");
      }
      const screenshot = parseComputerScreenshotOptions(parsed.options);
      const action = parseJsonObject(
        actionRaw,
        "action",
      ) as unknown as OpensteerComputerExecuteInput["action"];
      const result = await client.invoke<
        OpensteerComputerExecuteInput,
        OpensteerComputerExecuteOutput
      >("computer.execute", {
        action,
        ...(screenshot === undefined ? {} : { screenshot }),
        ...buildNetworkTagInput(parsed.options),
      });
      writeJson(projectCliComputerOutput(result));
      return;
    }

    case "close": {
      const metadata = await loadSessionMetadata(sessionOptions);
      if (!metadata) {
        writeJson({ closed: true });
        return;
      }

      if (metadata.mode === "cloud") {
        const cloud = new OpensteerCloudClient(
          resolveCloudConfig({
            enabled: true,
            mode: "cloud",
          })!,
        );
        await cloud.closeSession(metadata.sessionId);
        await removeOpensteerServiceMetadata(metadata.rootPath, metadata.name);
        writeJson({ closed: true });
        return;
      }

      const client = await connectOpensteerService(sessionOptions);
      if (!client) {
        writeJson({ closed: true });
        return;
      }

      const result = await client.invoke("session.close", {});
      writeJson(result);
      return;
    }

    case "help":
    case "--help":
    case "-h":
    default:
      throw new Error(
        `unsupported command "${parsed.command}". Supported commands: open, goto, snapshot, click, hover, input, scroll, extract, network, plan, request, computer, local-profile, profile, mcp, close.`,
      );
  }
}

function assertEngineOptionAllowed(parsed: ParsedCliArgs): void {
  const engineOption = parsed.options.engine;
  if (engineOption === undefined) {
    return;
  }

  if (engineOption === true) {
    throw new Error("--engine requires a value.");
  }

  if (parsed.command === "open" || parsed.command === "service-host" || parsed.command === "mcp") {
    return;
  }

  throw new Error('--engine is only supported on "open".');
}

function resolveCliExecutionMode(
  options: Readonly<Record<string, CliOptionValue>>,
): "local" | "cloud" {
  return resolveOpensteerExecutionMode({
    local: readBooleanOption(options, "local") === true,
    cloud: readBooleanOption(options, "cloud") === true,
    ...(process.env.OPENSTEER_MODE === undefined ? {} : { environment: process.env.OPENSTEER_MODE }),
  });
}

function resolveOpensteerRootPath(rootDir: string | undefined): string {
  return path.resolve(rootDir ?? process.cwd(), ".opensteer");
}

async function loadSessionMetadata(sessionOptions: {
  readonly name?: string;
  readonly rootDir?: string;
}) {
  const name = sessionOptions.name ?? "default";
  const rootPath = resolveOpensteerRootPath(sessionOptions.rootDir);
  const raw = await readOpensteerServiceMetadata(rootPath, name);
  if (!raw) {
    return undefined;
  }
  return parseOpensteerServiceMetadata(raw, getOpensteerServiceMetadataPath(rootPath, name)).metadata;
}

function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const command = argv[0] ?? "help";
  const positionals: string[] = [];
  const options: Record<string, CliOptionValue> = {};

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    const [name, inlineValue] = trimmed.split("=", 2);
    if (!name) {
      throw new Error("invalid option syntax");
    }
    if (inlineValue !== undefined) {
      options[name] = appendOptionValue(options[name], inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[name] = appendOptionValue(options[name], next);
      index += 1;
      continue;
    }

    options[name] = true;
  }

  return {
    command,
    positionals,
    options,
  };
}

function parseTargetInput(
  positionals: readonly string[],
  options: Readonly<Record<string, CliOptionValue>>,
): {
  readonly target:
    | { readonly kind: "element"; readonly element: number }
    | { readonly kind: "description"; readonly description: string }
    | { readonly kind: "selector"; readonly selector: string };
  readonly persistAsDescription?: string;
} {
  const numericTarget = readNumericPositional(positionals[0]);
  const selector = readStringOption(options, "selector");
  const description = readStringOption(options, "description");

  if (numericTarget !== undefined && selector !== undefined) {
    throw new Error("Specify only one of a positional element counter or --selector.");
  }

  if (numericTarget !== undefined) {
    return {
      target: {
        kind: "element",
        element: numericTarget,
      },
      ...(description === undefined ? {} : { persistAsDescription: description }),
    };
  }

  if (selector !== undefined) {
    return {
      target: {
        kind: "selector",
        selector,
      },
      ...(description === undefined ? {} : { persistAsDescription: description }),
    };
  }

  if (description === undefined) {
    throw new Error("Specify an element counter, --selector, or --description.");
  }

  return {
    target: {
      kind: "description",
      description,
    },
  };
}

function parseBrowserOptions(
  options: Readonly<Record<string, CliOptionValue>>,
): Record<string, unknown> | undefined {
  const browserJson = readStringOption(options, "browser-json");
  if (browserJson) {
    return parseJsonObject(browserJson, "browser-json");
  }

  const browserKind = readStringOption(options, "browser");
  const headed = readBooleanOption(options, "headed");
  const headless = readBooleanOption(options, "headless");
  if (headed === true && headless === true) {
    throw new Error("Specify only one of --headed or --headless.");
  }
  const managed = {
    ...(headed === true ? { headless: false } : {}),
    ...(headed !== true && headless !== undefined ? { headless } : {}),
    ...(readStringOption(options, "executable-path") === undefined
      ? {}
      : { executablePath: readStringOption(options, "executable-path") }),
    ...(readStringOptions(options, "browser-arg").length === 0
      ? {}
      : { args: readStringOptions(options, "browser-arg") }),
    ...(readNumberOption(options, "timeout-ms") === undefined
      ? {}
      : { timeoutMs: readNumberOption(options, "timeout-ms") }),
  };

  const cdp = readStringOption(options, "cdp");
  const autoConnect = readBooleanOption(options, "auto-connect") === true;
  const userDataDir = readStringOption(options, "user-data-dir");
  const profileDirectory = readStringOption(options, "profile-directory");
  const freshTab = readBooleanOption(options, "fresh-tab");
  const cdpHeaders = parseHeaderEntries(readStringOptions(options, "cdp-header"));

  const inferredKind =
    browserKind
    ?? (cdp !== undefined ? "cdp" : undefined)
    ?? (autoConnect ? "auto-connect" : undefined)
    ?? (userDataDir !== undefined ? "profile" : undefined);

  if (cdp !== undefined && autoConnect) {
    throw new Error("Specify only one of --cdp or --auto-connect.");
  }
  if ((cdp !== undefined || autoConnect) && userDataDir !== undefined) {
    throw new Error("Specify either attach flags (--cdp/--auto-connect) or launch flags (--user-data-dir), not both.");
  }

  if (inferredKind === "profile") {
    if (userDataDir === undefined) {
      throw new Error('browser kind "profile" requires --user-data-dir.');
    }
    return {
      kind: "profile" as const,
      ...managed,
      userDataDir,
      ...(profileDirectory === undefined ? {} : { profileDirectory }),
    };
  }

  if (inferredKind === "cdp") {
    if (cdp === undefined) {
      throw new Error('browser kind "cdp" requires --cdp.');
    }
    return {
      kind: "cdp" as const,
      endpoint: cdp,
      ...(freshTab === undefined ? {} : { freshTab }),
      ...(cdpHeaders.length === 0 ? {} : { headers: Object.fromEntries(cdpHeaders.map((entry) => [entry.name, entry.value])) }),
    };
  }

  if (inferredKind === "auto-connect") {
    return {
      kind: "auto-connect" as const,
      ...(freshTab === undefined ? {} : { freshTab }),
    };
  }

  if (inferredKind !== undefined && inferredKind !== "managed") {
    throw new Error(`browser must be "managed", "profile", "cdp", or "auto-connect"; received "${inferredKind}"`);
  }

  const parsed = {
    ...(browserKind === "managed" ? { kind: "managed" as const } : {}),
    ...managed,
  };
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function parseContextOptions(
  options: Readonly<Record<string, CliOptionValue>>,
): Record<string, unknown> | undefined {
  const contextJson = readStringOption(options, "context-json");
  if (contextJson) {
    return parseJsonObject(contextJson, "context-json");
  }

  const viewport = parseViewportOption(readStringOption(options, "viewport"));
  const parsed = {
    ...(readBooleanOption(options, "ignore-https-errors") === undefined
      ? {}
      : { ignoreHTTPSErrors: readBooleanOption(options, "ignore-https-errors") }),
    ...(readStringOption(options, "locale") === undefined
      ? {}
      : { locale: readStringOption(options, "locale") }),
    ...(readStringOption(options, "timezone-id") === undefined
      ? {}
      : { timezoneId: readStringOption(options, "timezone-id") }),
    ...(readStringOption(options, "user-agent") === undefined
      ? {}
      : { userAgent: readStringOption(options, "user-agent") }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(readBooleanOption(options, "javascript-enabled") === undefined
      ? {}
      : { javaScriptEnabled: readBooleanOption(options, "javascript-enabled") }),
    ...(readBooleanOption(options, "bypass-csp") === undefined
      ? {}
      : { bypassCSP: readBooleanOption(options, "bypass-csp") }),
    ...(readStringOption(options, "reduced-motion") === undefined
      ? {}
      : { reducedMotion: readStringOption(options, "reduced-motion") }),
    ...(readStringOption(options, "color-scheme") === undefined
      ? {}
      : { colorScheme: readStringOption(options, "color-scheme") }),
  };

  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function parseViewportOption(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === "null" || value === "none") {
    return null;
  }

  const match = value.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(`viewport must be WIDTHxHEIGHT, "null", or "none"; received "${value}"`);
  }

  return {
    width: Number.parseInt(match[1]!, 10),
    height: Number.parseInt(match[2]!, 10),
  };
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function readJsonObjectOption(
  options: Readonly<Record<string, CliOptionValue>>,
  input: {
    readonly inlineKey: string;
    readonly fileKey: string;
    readonly label: string;
  },
): Promise<Record<string, unknown> | undefined> {
  const inlineValue = readStringOption(options, input.inlineKey);
  const filePath = readStringOption(options, input.fileKey);
  if (inlineValue !== undefined && filePath !== undefined) {
    throw new Error(`Specify either --${input.inlineKey} or --${input.fileKey}, not both.`);
  }
  if (inlineValue !== undefined) {
    return parseJsonObject(inlineValue, input.label);
  }
  if (filePath !== undefined) {
    return parseJsonObject(await readFile(filePath, "utf8"), `${input.label}-file`);
  }
  return undefined;
}

function buildProvenanceInput(
  options: Readonly<Record<string, CliOptionValue>>,
): Record<string, unknown> | undefined {
  const provenance = {
    ...(readStringOption(options, "provenance-source") === undefined
      ? {}
      : { source: readStringOption(options, "provenance-source") }),
    ...(readStringOption(options, "provenance-source-id") === undefined
      ? {}
      : { sourceId: readStringOption(options, "provenance-source-id") }),
    ...(readNumberOption(options, "provenance-captured-at") === undefined
      ? {}
      : { capturedAt: readNumberOption(options, "provenance-captured-at") }),
    ...(readStringOption(options, "provenance-notes") === undefined
      ? {}
      : { notes: readStringOption(options, "provenance-notes") }),
  };

  return Object.keys(provenance).length === 0 ? undefined : provenance;
}

function parseKeyValueOptions(values: readonly string[]): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const value of values) {
    const equalsIndex = value.indexOf("=");
    if (equalsIndex <= 0 || equalsIndex === value.length - 1) {
      throw new Error(`expected NAME=VALUE but received "${value}"`);
    }
    entries.set(value.slice(0, equalsIndex), value.slice(equalsIndex + 1));
  }
  return entries;
}

function parseHeaderEntries(values: readonly string[]): readonly {
  readonly name: string;
  readonly value: string;
}[] {
  return [...parseKeyValueOptions(values).entries()].map(([name, value]) => ({
    name,
    value,
  }));
}

function buildNetworkFilterInput(
  options: Readonly<Record<string, CliOptionValue>>,
): Record<string, unknown> {
  return {
    ...(readStringOption(options, "page-ref") === undefined
      ? {}
      : { pageRef: readStringOption(options, "page-ref") }),
    ...(readStringOption(options, "record-id") === undefined
      ? {}
      : { recordId: readStringOption(options, "record-id") }),
    ...(readStringOption(options, "request-id") === undefined
      ? {}
      : { requestId: readStringOption(options, "request-id") }),
    ...(readStringOption(options, "action-id") === undefined
      ? {}
      : { actionId: readStringOption(options, "action-id") }),
    ...(readStringOption(options, "url") === undefined
      ? {}
      : { url: readStringOption(options, "url") }),
    ...(readStringOption(options, "hostname") === undefined
      ? {}
      : { hostname: readStringOption(options, "hostname") }),
    ...(readStringOption(options, "path") === undefined
      ? {}
      : { path: readStringOption(options, "path") }),
    ...(readStringOption(options, "method") === undefined
      ? {}
      : { method: readStringOption(options, "method") }),
    ...(readStringOption(options, "status") === undefined
      ? {}
      : { status: readStringOption(options, "status") }),
    ...(readStringOption(options, "resource-type") === undefined
      ? {}
      : { resourceType: readStringOption(options, "resource-type") }),
  };
}

function buildNetworkTagInput(
  options: Readonly<Record<string, CliOptionValue>>,
): Record<string, unknown> {
  return readStringOption(options, "network-tag") === undefined
    ? {}
    : { networkTag: readStringOption(options, "network-tag") };
}

function buildNetworkQueryInput(
  options: Readonly<Record<string, CliOptionValue>>,
): Record<string, unknown> {
  return {
    ...(readStringOption(options, "source") === undefined
      ? {}
      : { source: readStringOption(options, "source") }),
    ...(readBooleanOption(options, "include-bodies") ? { includeBodies: true } : {}),
    ...(readNumberOption(options, "limit") === undefined
      ? {}
      : { limit: readNumberOption(options, "limit") }),
    ...(readStringOption(options, "tag") === undefined
      ? {}
      : { tag: readStringOption(options, "tag") }),
    ...buildNetworkFilterInput(options),
  };
}

async function parseRequestBodyInput(
  options: Readonly<Record<string, CliOptionValue>>,
): Promise<Record<string, unknown> | undefined> {
  const bodyJson = readStringOption(options, "body-json");
  const bodyText = readStringOption(options, "body-text");
  const bodyBase64 = readStringOption(options, "body-base64");
  const bodyFile = readStringOption(options, "body-file");
  const contentType = readStringOption(options, "content-type");

  const specifiedInputs = [bodyJson, bodyText, bodyBase64, bodyFile].filter(
    (value) => value !== undefined,
  );
  if (specifiedInputs.length > 1) {
    throw new Error("Specify only one of --body-json, --body-text, --body-base64, or --body-file.");
  }

  if (bodyJson !== undefined) {
    return {
      json: JSON.parse(bodyJson) as unknown,
      ...(contentType === undefined ? {} : { contentType }),
    };
  }

  if (bodyText !== undefined) {
    return {
      text: bodyText,
      ...(contentType === undefined ? {} : { contentType }),
    };
  }

  if (bodyBase64 !== undefined) {
    return {
      base64: bodyBase64,
      ...(contentType === undefined ? {} : { contentType }),
    };
  }

  if (bodyFile === undefined) {
    return undefined;
  }

  const raw = await readFile(bodyFile, "utf8");
  const shouldParseJson =
    bodyFile.endsWith(".json") ||
    contentType?.toLowerCase().startsWith("application/json") === true;
  if (shouldParseJson) {
    return {
      json: JSON.parse(raw) as unknown,
      ...(contentType === undefined ? {} : { contentType }),
    };
  }

  return {
    text: raw,
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function parseComputerScreenshotOptions(
  options: Readonly<Record<string, CliOptionValue>>,
): Record<string, unknown> | undefined {
  const screenshotJson = readStringOption(options, "screenshot-json");
  const format = readStringOption(options, "format");
  const includeCursor = readBooleanOption(options, "include-cursor");
  const disableAnnotations = parseCsvOption(readStringOption(options, "disable-annotations"));

  if (
    screenshotJson !== undefined &&
    (format !== undefined || includeCursor !== undefined || disableAnnotations !== undefined)
  ) {
    throw new Error(
      "Specify either --screenshot-json or individual screenshot flags (--format, --include-cursor, --disable-annotations).",
    );
  }

  if (screenshotJson !== undefined) {
    return parseJsonObject(screenshotJson, "screenshot-json");
  }

  const parsed = {
    ...(format === undefined ? {} : { format }),
    ...(includeCursor === undefined ? {} : { includeCursor }),
    ...(disableAnnotations === undefined ? {} : { disableAnnotations }),
  };

  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function readStringOption(
  options: Readonly<Record<string, CliOptionValue>>,
  key: string,
): string | undefined {
  const value = options[key];
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  return typeof value === "string" ? value : undefined;
}

function readBooleanOption(
  options: Readonly<Record<string, CliOptionValue>>,
  key: string,
): boolean | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return readBooleanOption({ [key]: value[value.length - 1]! }, key);
  }
  if (value === true || value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`${key} must be a boolean value`);
}

function readNumberOption(
  options: Readonly<Record<string, CliOptionValue>>,
  key: string,
): number | undefined {
  const value = readStringOption(options, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number`);
  }
  return parsed;
}

function readStringOptions(
  options: Readonly<Record<string, CliOptionValue>>,
  key: string,
): readonly string[] {
  const value = options[key];
  if (value === undefined || value === true) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  return value;
}

function readNumericPositional(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 10);
}

function parseCsvOption(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries;
}

function consumeTextPositional(positionals: readonly string[]): string | undefined {
  const numericTarget = readNumericPositional(positionals[0]);
  return numericTarget === undefined ? positionals[0] : positionals[1];
}

function consumeRemainingPositionals(positionals: readonly string[]): readonly string[] {
  const numericTarget = readNumericPositional(positionals[0]);
  return numericTarget === undefined ? positionals : positionals.slice(1);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function writeJsonOutput(value: unknown, outputPath: string | undefined): Promise<void> {
  if (outputPath === undefined) {
    writeJson(value);
    return;
  }

  await writeFile(outputPath, `${JSON.stringify(value)}\n`, "utf8");
}

function projectCliComputerOutput(
  output: OpensteerComputerExecuteOutput,
): OpensteerComputerExecuteOutput & {
  readonly screenshot: OpensteerComputerExecuteOutput["screenshot"] & {
    readonly path: string;
  };
} {
  return {
    ...output,
    screenshot: {
      ...output.screenshot,
      path: fileUriToPath(output.screenshot.payload.uri),
    },
  };
}

function writeError(error: unknown): void {
  if (error instanceof OpensteerCliServiceError) {
    process.stderr.write(
      `${JSON.stringify({ error: error.opensteerError, statusCode: error.statusCode })}\n`,
    );
    return;
  }

  if (error instanceof Error) {
    process.stderr.write(
      `${JSON.stringify({ error: { message: error.message, name: error.name } })}\n`,
    );
    return;
  }

  process.stderr.write(`${JSON.stringify({ error: { value: error } })}\n`);
}

void main(process.argv.slice(2)).catch((error) => {
  writeError(error);
  process.exitCode = 1;
});

function appendOptionValue(
  current: CliOptionValue | undefined,
  next: string,
): string | readonly string[] {
  if (current === undefined || current === true) {
    return next;
  }
  if (typeof current === "string") {
    return [current, next];
  }
  return [...current, next];
}
