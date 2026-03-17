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
import { OpensteerLocalProfileUnavailableError } from "../local-browser/profile-inspection.js";
import { runOpensteerLocalProfileCli } from "./local-profile.js";
import { runOpensteerProfileUploadCli } from "./profile-upload.js";
import {
  opensteerCliSchema,
  parseCliArguments,
} from "./schema.js";
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

type ParsedCliOptions = Readonly<Record<string, unknown>>;

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "local-profile") {
    const exitCode = await runOpensteerLocalProfileCli(argv.slice(1));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (argv[0] === "profile") {
    const exitCode = await runOpensteerProfileUploadCli(argv.slice(1));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  const parsed = parseCliArguments({
    schema: opensteerCliSchema,
    programName: "opensteer",
    argv,
  });
  if (parsed.kind === "help") {
    process.stdout.write(parsed.text);
    return;
  }

  const invocation = parsed.invocation;
  const options = invocation.options as ParsedCliOptions;

  if (invocation.commandId === "service-host") {
    await runOpensteerServiceHost({
      name: readOptionalString(options.name) ?? "default",
      ...(readOptionalString(options.rootDir) === undefined
        ? {}
        : { rootDir: readOptionalString(options.rootDir)! }),
      ...(readOptionalString(options.engine) === undefined
        ? {}
        : {
            engine: normalizeOpensteerEngineName(
              readOptionalString(options.engine)!,
              "--engine",
            ),
          }),
    });
    return;
  }

  if (invocation.commandId === "mcp") {
    const mode = resolveCliExecutionMode(options);
    const engine = resolveOpensteerEngineName({
      requested: readOptionalString(options.engine),
      environment: process.env.OPENSTEER_ENGINE,
    });
    assertExecutionModeSupportsEngine(mode, engine);
    await runOpensteerMcpServer({
      name: readOptionalString(options.name) ?? "default",
      ...(readOptionalString(options.rootDir) === undefined
        ? {}
        : { rootDir: readOptionalString(options.rootDir)! }),
      engine,
      ...(mode === "cloud" ? { cloud: true } : {}),
    });
    return;
  }

  const sessionOptions = {
    ...(readOptionalString(options.name) === undefined ? {} : { name: readOptionalString(options.name)! }),
    ...(readOptionalString(options.rootDir) === undefined
      ? {}
      : { rootDir: readOptionalString(options.rootDir)! }),
  };

  switch (invocation.commandId) {
    case "open": {
      const mode = resolveCliExecutionMode(options);
      const engine = resolveOpensteerEngineName({
        requested: readOptionalString(options.engine),
        environment: process.env.OPENSTEER_ENGINE,
      });
      assertExecutionModeSupportsEngine(mode, engine);
      const browser = parseBrowserOptions(options);
      const context = parseContextOptions(options);
      if (mode === "cloud") {
        const client = new OpensteerCloudClient(
          resolveCloudConfig({
            enabled: true,
            mode,
            ...(readOptionalString(options.cloudProfileId) === undefined
              ? {}
              : {
                  browserProfile: {
                    profileId: readOptionalString(options.cloudProfileId)!,
                    ...(readOptionalBoolean(options.cloudProfileReuseIfActive) === true
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
          ...(readOptionalString(options.cloudProfileId) === undefined
            ? {}
            : {
                browserProfile: {
                  profileId: readOptionalString(options.cloudProfileId)!,
                  ...(readOptionalBoolean(options.cloudProfileReuseIfActive) === true
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
          ...(invocation.positionals[0] === undefined ? {} : { url: invocation.positionals[0] }),
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
        ...(invocation.positionals[0] === undefined ? {} : { url: invocation.positionals[0] }),
        ...(sessionOptions.name === undefined ? {} : { name: sessionOptions.name }),
        ...(browser === undefined ? {} : { browser }),
        ...(context === undefined ? {} : { context }),
      });
      writeJson(result);
      return;
    }

    case "goto": {
      const client = await requireOpensteerService(sessionOptions);
      const url = invocation.positionals[0];
      if (!url) {
        throw new Error("goto requires a URL");
      }
      const result = await client.invoke("page.goto", {
        url,
        ...buildNetworkTagInput(options),
      });
      writeJson(result);
      return;
    }

    case "snapshot": {
      const client = await requireOpensteerService(sessionOptions);
      const mode = invocation.positionals[0];
      const result = await client.invoke("page.snapshot", {
        ...(mode === undefined ? {} : { mode }),
      });
      writeJson(result);
      return;
    }

    case "click": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(invocation.positionals, options);
      const result = await client.invoke("dom.click", {
        ...target,
        ...buildNetworkTagInput(options),
      });
      writeJson(result);
      return;
    }

    case "hover": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(invocation.positionals, options);
      const result = await client.invoke("dom.hover", {
        ...target,
        ...buildNetworkTagInput(options),
      });
      writeJson(result);
      return;
    }

    case "input": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(invocation.positionals, options);
      const text = readOptionalString(options.text) ?? consumeTextPositional(invocation.positionals);
      if (!text) {
        throw new Error("input requires text");
      }
      const result = await client.invoke("dom.input", {
        ...target,
        text,
        ...(readOptionalBoolean(options.pressEnter) ? { pressEnter: true } : {}),
        ...buildNetworkTagInput(options),
      });
      writeJson(result);
      return;
    }

    case "scroll": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(invocation.positionals, options);
      const direction = readOptionalString(options.direction) ?? consumeRemainingPositionals(invocation.positionals)[0];
      const amountValue = readOptionalNumber(options.amount);
      const amountRaw = amountValue === undefined ? consumeRemainingPositionals(invocation.positionals)[1] : String(amountValue);
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
        ...buildNetworkTagInput(options),
      });
      writeJson(result);
      return;
    }

    case "extract": {
      const client = await requireOpensteerService(sessionOptions);
      const description = readOptionalString(options.description);
      if (!description) {
        throw new Error("extract requires --description");
      }
      const schema = readOptionalJsonObject(options.schema);
      const schemaRaw = schema ?? readJsonObjectPositional(invocation.positionals[0], "schema");
      const result = await client.invoke<
        {
          readonly description: string;
          readonly schema?: Record<string, unknown>;
        },
        { readonly data: unknown }
      >("dom.extract", {
        description,
        ...(schemaRaw === undefined ? {} : { schema: schemaRaw }),
      });
      writeJson(result.data);
      return;
    }

    case "network.query": {
      const client = await requireOpensteerService(sessionOptions);
      const result = await client.invoke("network.query", buildNetworkQueryInput(options));
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "network.save": {
      const client = await requireOpensteerService(sessionOptions);
      const tag = readOptionalString(options.tag);
      if (!tag) {
        throw new Error("network save requires --tag");
      }
      const result = await client.invoke("network.save", {
        ...buildNetworkFilterInput(options),
        tag,
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "network.clear": {
      const client = await requireOpensteerService(sessionOptions);
      const result = await client.invoke("network.clear", {
        ...(readOptionalString(options.tag) === undefined ? {} : { tag: readOptionalString(options.tag) }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "plan.write": {
      const client = await requireOpensteerService(sessionOptions);
      const key = readOptionalString(options.key);
      const version = readOptionalString(options.version);
      if (!key || !version) {
        throw new Error("plan write requires --key and --version");
      }
      const payload = await readJsonObjectOption(options, {
        inlineKey: "payload",
        fileKey: "payloadFile",
        label: "payload",
      });
      if (payload === undefined) {
        throw new Error("plan write requires --payload or --payload-file");
      }
      const result = await client.invoke("request-plan.write", {
        ...(readOptionalString(options.id) === undefined ? {} : { id: readOptionalString(options.id) }),
        key,
        version,
        ...(readOptionalString(options.lifecycle) === undefined
          ? {}
          : { lifecycle: readOptionalString(options.lifecycle) }),
        ...(parseCsvOption(readOptionalString(options.tags)) === undefined
          ? {}
          : { tags: parseCsvOption(readOptionalString(options.tags)) }),
        payload,
        ...(buildProvenanceInput(options) === undefined ? {} : { provenance: buildProvenanceInput(options) }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "plan.infer": {
      const client = await requireOpensteerService(sessionOptions);
      const recordId = readOptionalString(options.recordId);
      const key = readOptionalString(options.key);
      const version = readOptionalString(options.version);
      if (!recordId || !key || !version) {
        throw new Error("plan infer requires --record-id, --key, and --version");
      }
      const result = await client.invoke("request-plan.infer", {
        recordId,
        key,
        version,
        ...(readOptionalString(options.lifecycle) === undefined
          ? {}
          : { lifecycle: readOptionalString(options.lifecycle) }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "plan.get": {
      const client = await requireOpensteerService(sessionOptions);
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      if (!key) {
        throw new Error("plan get requires a key");
      }
      const version = invocation.positionals[1] ?? readOptionalString(options.version);
      const result = await client.invoke("request-plan.get", {
        key,
        ...(version === undefined ? {} : { version }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "plan.list": {
      const client = await requireOpensteerService(sessionOptions);
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      const result = await client.invoke("request-plan.list", {
        ...(key === undefined ? {} : { key }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "request.raw": {
      const client = await requireOpensteerService(sessionOptions);
      const url = invocation.positionals[0] ?? readOptionalString(options.url);
      if (!url) {
        throw new Error("request raw requires a URL");
      }
      const body = await parseRequestBodyInput(options);
      const headers = parseHeaderEntries(readOptionalStrings(options.header));
      const result = await client.invoke("request.raw", {
        url,
        ...(readOptionalString(options.method) === undefined ? {} : { method: readOptionalString(options.method) }),
        ...(body === undefined ? {} : { body }),
        ...(readOptionalBoolean(options.noFollowRedirects) ? { followRedirects: false } : {}),
        ...(headers.length === 0 ? {} : { headers }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "request.execute": {
      const client = await requireOpensteerService(sessionOptions);
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      if (!key) {
        throw new Error("request execute requires a plan key");
      }
      const body = await parseRequestBodyInput(options);
      const params = parseKeyValueOptions(readOptionalStrings(options.param));
      const query = parseKeyValueOptions(readOptionalStrings(options.query));
      const headers = parseKeyValueOptions(readOptionalStrings(options.header));
      const result = await client.invoke("request.execute", {
        key,
        ...(readOptionalString(options.version) === undefined
          ? {}
          : { version: readOptionalString(options.version) }),
        ...(params.size === 0 ? {} : { params: Object.fromEntries(params) }),
        ...(query.size === 0 ? {} : { query: Object.fromEntries(query) }),
        ...(headers.size === 0 ? {} : { headers: Object.fromEntries(headers) }),
        ...(body === undefined ? {} : { body }),
        ...(readOptionalBoolean(options.noValidate) === true ? { validateResponse: false } : {}),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "computer": {
      const client = await requireOpensteerService(sessionOptions);
      const action = readOptionalJsonObject(options.action) ?? readJsonObjectPositional(invocation.positionals[0], "action");
      if (!action) {
        throw new Error("computer requires an action JSON object");
      }
      const screenshot = parseComputerScreenshotOptions(options);
      const result = await client.invoke<
        OpensteerComputerExecuteInput,
        OpensteerComputerExecuteOutput
      >("computer.execute", {
        action: action as unknown as OpensteerComputerExecuteInput["action"],
        ...(screenshot === undefined ? {} : { screenshot }),
        ...buildNetworkTagInput(options),
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

      const result = await client.closeSession();
      await removeOpensteerServiceMetadata(metadata.rootPath, metadata.name).catch(() => undefined);
      writeJson(result);
      return;
    }
    default:
      throw new Error(`unsupported command "${invocation.commandId}".`);
  }
}

function resolveCliExecutionMode(options: ParsedCliOptions): "local" | "cloud" {
  return resolveOpensteerExecutionMode({
    local: readOptionalBoolean(options.local) === true,
    cloud: readOptionalBoolean(options.cloud) === true,
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

function parseTargetInput(
  positionals: readonly string[],
  options: ParsedCliOptions,
): {
  readonly target:
    | { readonly kind: "element"; readonly element: number }
    | { readonly kind: "description"; readonly description: string }
    | { readonly kind: "selector"; readonly selector: string };
  readonly persistAsDescription?: string;
} {
  const numericTarget = readNumericPositional(positionals[0]);
  const selector = readOptionalString(options.selector);
  const description = readOptionalString(options.description);

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
  options: ParsedCliOptions,
): Record<string, unknown> | undefined {
  const browserJson = readOptionalJsonObject(options.browserJson);
  if (browserJson) {
    return browserJson;
  }

  const browserKind = readOptionalString(options.browser);
  const headed = readOptionalBoolean(options.headed);
  const headless = readOptionalBoolean(options.headless);
  if (headed === true && headless === true) {
    throw new Error("Specify only one of --headed or --headless.");
  }
  const managed = {
    ...(headed === true ? { headless: false } : {}),
    ...(headed !== true && headless !== undefined ? { headless } : {}),
    ...(readOptionalString(options.executablePath) === undefined
      ? {}
      : { executablePath: readOptionalString(options.executablePath) }),
    ...(readOptionalStrings(options.browserArg).length === 0
      ? {}
      : { args: readOptionalStrings(options.browserArg) }),
    ...(readOptionalNumber(options.timeoutMs) === undefined
      ? {}
      : { timeoutMs: readOptionalNumber(options.timeoutMs) }),
  };

  const cdp = readOptionalString(options.cdp);
  const autoConnect = readOptionalBoolean(options.autoConnect) === true;
  const userDataDir = readOptionalString(options.userDataDir);
  const profileDirectory = readOptionalString(options.profileDirectory);
  const freshTab = readOptionalBoolean(options.freshTab);
  const cdpHeaders = parseHeaderEntries(readOptionalStrings(options.cdpHeader));

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
  options: ParsedCliOptions,
): Record<string, unknown> | undefined {
  const contextJson = readOptionalJsonObject(options.contextJson);
  if (contextJson) {
    return contextJson;
  }

  const viewport = parseViewportOption(readOptionalString(options.viewport));
  const parsed = {
    ...(readOptionalBoolean(options.ignoreHttpsErrors) === undefined
      ? {}
      : { ignoreHTTPSErrors: readOptionalBoolean(options.ignoreHttpsErrors) }),
    ...(readOptionalString(options.locale) === undefined
      ? {}
      : { locale: readOptionalString(options.locale) }),
    ...(readOptionalString(options.timezoneId) === undefined
      ? {}
      : { timezoneId: readOptionalString(options.timezoneId) }),
    ...(readOptionalString(options.userAgent) === undefined
      ? {}
      : { userAgent: readOptionalString(options.userAgent) }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(readOptionalBoolean(options.javascriptEnabled) === undefined
      ? {}
      : { javaScriptEnabled: readOptionalBoolean(options.javascriptEnabled) }),
    ...(readOptionalBoolean(options.bypassCsp) === undefined
      ? {}
      : { bypassCSP: readOptionalBoolean(options.bypassCsp) }),
    ...(readOptionalString(options.reducedMotion) === undefined
      ? {}
      : { reducedMotion: readOptionalString(options.reducedMotion) }),
    ...(readOptionalString(options.colorScheme) === undefined
      ? {}
      : { colorScheme: readOptionalString(options.colorScheme) }),
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
  options: ParsedCliOptions,
  input: {
    readonly inlineKey: string;
    readonly fileKey: string;
    readonly label: string;
  },
): Promise<Record<string, unknown> | undefined> {
  const inlineValue = readOptionalJsonObject(options[input.inlineKey]);
  const filePath = readOptionalString(options[input.fileKey]);
  if (inlineValue !== undefined && filePath !== undefined) {
    throw new Error(
      `Specify either --${toKebabCase(input.inlineKey)} or --${toKebabCase(input.fileKey)}, not both.`,
    );
  }
  if (inlineValue !== undefined) {
    return inlineValue;
  }
  if (filePath !== undefined) {
    return parseJsonObject(await readFile(filePath, "utf8"), `${input.label}-file`);
  }
  return undefined;
}

function buildProvenanceInput(
  options: ParsedCliOptions,
): Record<string, unknown> | undefined {
  const provenance = {
    ...(readOptionalString(options.provenanceSource) === undefined
      ? {}
      : { source: readOptionalString(options.provenanceSource) }),
    ...(readOptionalString(options.provenanceSourceId) === undefined
      ? {}
      : { sourceId: readOptionalString(options.provenanceSourceId) }),
    ...(readOptionalNumber(options.provenanceCapturedAt) === undefined
      ? {}
      : { capturedAt: readOptionalNumber(options.provenanceCapturedAt) }),
    ...(readOptionalString(options.provenanceNotes) === undefined
      ? {}
      : { notes: readOptionalString(options.provenanceNotes) }),
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
  options: ParsedCliOptions,
): Record<string, unknown> {
  return {
    ...(readOptionalString(options.pageRef) === undefined ? {} : { pageRef: readOptionalString(options.pageRef) }),
    ...(readOptionalString(options.recordId) === undefined ? {} : { recordId: readOptionalString(options.recordId) }),
    ...(readOptionalString(options.requestId) === undefined ? {} : { requestId: readOptionalString(options.requestId) }),
    ...(readOptionalString(options.actionId) === undefined ? {} : { actionId: readOptionalString(options.actionId) }),
    ...(readOptionalString(options.url) === undefined ? {} : { url: readOptionalString(options.url) }),
    ...(readOptionalString(options.hostname) === undefined ? {} : { hostname: readOptionalString(options.hostname) }),
    ...(readOptionalString(options.path) === undefined ? {} : { path: readOptionalString(options.path) }),
    ...(readOptionalString(options.method) === undefined ? {} : { method: readOptionalString(options.method) }),
    ...(readOptionalString(options.status) === undefined ? {} : { status: readOptionalString(options.status) }),
    ...(readOptionalString(options.resourceType) === undefined
      ? {}
      : { resourceType: readOptionalString(options.resourceType) }),
  };
}

function buildNetworkTagInput(
  options: ParsedCliOptions,
): Record<string, unknown> {
  return readOptionalString(options.networkTag) === undefined
    ? {}
    : { networkTag: readOptionalString(options.networkTag) };
}

function buildNetworkQueryInput(
  options: ParsedCliOptions,
): Record<string, unknown> {
  return {
    ...(readOptionalString(options.source) === undefined ? {} : { source: readOptionalString(options.source) }),
    ...(readOptionalBoolean(options.includeBodies) ? { includeBodies: true } : {}),
    ...(readOptionalNumber(options.limit) === undefined ? {} : { limit: readOptionalNumber(options.limit) }),
    ...(readOptionalString(options.tag) === undefined ? {} : { tag: readOptionalString(options.tag) }),
    ...buildNetworkFilterInput(options),
  };
}

async function parseRequestBodyInput(
  options: ParsedCliOptions,
): Promise<Record<string, unknown> | undefined> {
  const bodyJson = options.bodyJson;
  const bodyText = readOptionalString(options.bodyText);
  const bodyBase64 = readOptionalString(options.bodyBase64);
  const bodyFile = readOptionalString(options.bodyFile);
  const contentType = readOptionalString(options.contentType);

  const specifiedInputs = [bodyJson, bodyText, bodyBase64, bodyFile].filter(
    (value) => value !== undefined,
  );
  if (specifiedInputs.length > 1) {
    throw new Error("Specify only one of --body-json, --body-text, --body-base64, or --body-file.");
  }

  if (bodyJson !== undefined) {
    return {
      json: bodyJson,
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
  options: ParsedCliOptions,
): Record<string, unknown> | undefined {
  const screenshotJson = readOptionalJsonObject(options.screenshotJson);
  const format = readOptionalString(options.format);
  const includeCursor = readOptionalBoolean(options.includeCursor);
  const disableAnnotations = parseCsvOption(readOptionalString(options.disableAnnotations));

  if (
    screenshotJson !== undefined &&
    (format !== undefined || includeCursor !== undefined || disableAnnotations !== undefined)
  ) {
    throw new Error(
      "Specify either --screenshot-json or individual screenshot flags (--format, --include-cursor, --disable-annotations).",
    );
  }

  if (screenshotJson !== undefined) {
    return screenshotJson;
  }

  const parsed = {
    ...(format === undefined ? {} : { format }),
    ...(includeCursor === undefined ? {} : { includeCursor }),
    ...(disableAnnotations === undefined ? {} : { disableAnnotations }),
  };

  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function readOptionalStrings(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readOptionalJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readJsonObjectPositional(
  value: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : parseJsonObject(value, label);
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

  if (error instanceof OpensteerLocalProfileUnavailableError) {
    process.stderr.write(
      `${JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          name: error.name,
          details: {
            inspection: error.inspection,
          },
        },
      })}\n`,
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

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}
