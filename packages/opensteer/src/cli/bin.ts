#!/usr/bin/env node

import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import {
  opensteerAuthRecipePayloadSchema,
  opensteerRequestPlanPayloadSchema,
  isPageRef,
  validateJsonSchema,
} from "@opensteer/protocol";

import type {
  OpensteerAuthRecipePayload,
  OpensteerCaptureScriptsInput,
  OpensteerComputerAction,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerRecipePayload,
  OpensteerRequestBodyInput,
  OpensteerRegistryProvenance,
  OpensteerRequestPlanLifecycle,
  OpensteerRequestPlanPayload,
} from "@opensteer/protocol";

import {
  connectOpensteerService,
  ensureOpensteerService,
  OpensteerCliServiceError,
  requireOpensteerService,
} from "./client.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { resolveCloudConfig } from "../cloud/config.js";
import { toCanonicalJsonValue } from "../json.js";
import {
  normalizeOpensteerEngineName,
  resolveOpensteerEngineName,
} from "../internal/engine-selection.js";
import { fileUriToPath } from "../internal/filesystem.js";
import { OpensteerLocalProfileUnavailableError } from "../local-browser/profile-inspection.js";
import { runOpensteerBrowserCli } from "./browser.js";
import { runOpensteerLocalProfileCli } from "./local-profile.js";
import { runOpensteerProfileSyncCli } from "./profile-sync.js";
import { opensteerCliSchema, parseCliArguments } from "./schema.js";
import {
  assertExecutionModeSupportsEngine,
  resolveOpensteerExecutionMode,
} from "../mode/config.js";
import { OpensteerSessionRuntime } from "../sdk/runtime.js";
import { createOpensteerSemanticRuntime } from "../sdk/runtime-resolution.js";
import {
  getOpensteerServiceMetadataPath,
  parseOpensteerServiceMetadata,
  readOpensteerServiceMetadata,
  removeOpensteerServiceMetadata,
  writeOpensteerServiceMetadata,
} from "./service-metadata.js";
import { LocalOpensteerSessionProxy } from "../session-service/local-session-proxy.js";
import { runOpensteerMcpServer } from "./mcp.js";
import { runOpensteerServiceHost } from "./service-host.js";

type ParsedCliOptions = Readonly<Record<string, unknown>>;

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "browser") {
    const exitCode = await runOpensteerBrowserCli(argv.slice(1));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (argv[0] === "local-profile") {
    const exitCode = await runOpensteerLocalProfileCli(argv.slice(1));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (argv[0] === "profile") {
    const exitCode = await runOpensteerProfileSyncCli(argv.slice(1));
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
            engine: normalizeOpensteerEngineName(readOptionalString(options.engine)!, "--engine"),
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
    ...(readOptionalString(options.name) === undefined
      ? {}
      : { name: readOptionalString(options.name)! }),
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
      const text =
        readOptionalString(options.text) ?? consumeTextPositional(invocation.positionals);
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
      const direction =
        readOptionalString(options.direction) ??
        consumeRemainingPositionals(invocation.positionals)[0];
      const amountValue = readOptionalNumber(options.amount);
      const amountRaw =
        amountValue === undefined
          ? consumeRemainingPositionals(invocation.positionals)[1]
          : String(amountValue);
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
        ...(readOptionalString(options.tag) === undefined
          ? {}
          : { tag: readOptionalString(options.tag) }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "scripts.capture": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const pageRef = readOptionalString(options.pageRef);
      if (pageRef !== undefined && !isPageRef(pageRef)) {
        throw new Error("--page-ref must be a valid page reference");
      }
      const includeInline = readOptionalBoolean(options.includeInline);
      const includeExternal = readOptionalBoolean(options.includeExternal);
      const includeDynamic = readOptionalBoolean(options.includeDynamic);
      const includeWorkers = readOptionalBoolean(options.includeWorkers);
      const urlFilter = readOptionalString(options.urlFilter);
      const captureInput: OpensteerCaptureScriptsInput = {
        ...(pageRef === undefined ? {} : { pageRef }),
        ...(includeInline === undefined ? {} : { includeInline }),
        ...(includeExternal === undefined ? {} : { includeExternal }),
        ...(includeDynamic === undefined ? {} : { includeDynamic }),
        ...(includeWorkers === undefined ? {} : { includeWorkers }),
        ...(urlFilter === undefined ? {} : { urlFilter }),
        ...(readOptionalBoolean(options.noPersist) === true ? { persist: false } : {}),
      };
      const result = await runtime.captureScripts(captureInput);
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "plan.write": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
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
      const writePlanInput: {
        id?: string;
        key: string;
        version: string;
        lifecycle?: OpensteerRequestPlanLifecycle;
        tags?: readonly string[];
        provenance?: OpensteerRegistryProvenance;
        payload: OpensteerRequestPlanPayload;
      } = {
        key,
        version,
        payload: parseRequestPlanPayload(payload),
      };
      const id = readOptionalString(options.id);
      if (id !== undefined) {
        writePlanInput.id = id;
      }
      const lifecycle = readOptionalString(options.lifecycle);
      if (lifecycle !== undefined) {
        writePlanInput.lifecycle = parseRequestPlanLifecycle(lifecycle);
      }
      const tags = parseCsvOption(readOptionalString(options.tags));
      if (tags !== undefined) {
        writePlanInput.tags = tags;
      }
      const provenance = buildProvenanceInput(options);
      if (provenance !== undefined) {
        writePlanInput.provenance = provenance;
      }
      const result = await runtime.writeRequestPlan(writePlanInput);
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "plan.infer": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const recordId = readOptionalString(options.recordId);
      const key = readOptionalString(options.key);
      const version = readOptionalString(options.version);
      if (!recordId || !key || !version) {
        throw new Error("plan infer requires --record-id, --key, and --version");
      }
      const result = await runtime.inferRequestPlan({
        recordId,
        key,
        version,
        ...(readOptionalString(options.lifecycle) === undefined
          ? {}
          : { lifecycle: parseRequestPlanLifecycle(readOptionalString(options.lifecycle)!) }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "plan.get": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      if (!key) {
        throw new Error("plan get requires a key");
      }
      const version = invocation.positionals[1] ?? readOptionalString(options.version);
      const result = await runtime.getRequestPlan({
        key,
        ...(version === undefined ? {} : { version }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "plan.list": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      const result = await runtime.listRequestPlans({
        ...(key === undefined ? {} : { key }),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "inspect.cookies": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const urls = readOptionalStrings(options.url);
      const result = await runtime.getCookies(urls.length === 0 ? {} : { urls });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "inspect.storage": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const result = await runtime.getStorageSnapshot({
        ...(readOptionalBoolean(options.includeSessionStorage) === true
          ? { includeSessionStorage: true }
          : {}),
        ...(readOptionalBoolean(options.includeIndexedDb) === true
          ? { includeIndexedDb: true }
          : {}),
      });
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "recipe.write":
    case "auth-recipe.write": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const recipeCommandName =
        invocation.commandId === "recipe.write" ? "recipe write" : "auth-recipe write";
      const key = readOptionalString(options.key);
      const version = readOptionalString(options.version);
      if (!key || !version) {
        throw new Error(`${recipeCommandName} requires --key and --version`);
      }
      const payload = await readJsonObjectOption(options, {
        inlineKey: "payload",
        fileKey: "payloadFile",
        label: "payload",
      });
      if (payload === undefined) {
        throw new Error(`${recipeCommandName} requires --payload or --payload-file`);
      }
      const writeRecipeInput: {
        id?: string;
        key: string;
        version: string;
        tags?: readonly string[];
        provenance?: OpensteerRegistryProvenance;
        payload: OpensteerRecipePayload;
      } = {
        key,
        version,
        payload: parseRecipePayload(payload),
      };
      const recipeId = readOptionalString(options.id);
      if (recipeId !== undefined) {
        writeRecipeInput.id = recipeId;
      }
      const recipeTags = parseCsvOption(readOptionalString(options.tags));
      if (recipeTags !== undefined) {
        writeRecipeInput.tags = recipeTags;
      }
      const recipeProvenance = buildProvenanceInput(options);
      if (recipeProvenance !== undefined) {
        writeRecipeInput.provenance = recipeProvenance;
      }
      const result =
        invocation.commandId === "recipe.write"
          ? await runtime.writeRecipe(writeRecipeInput)
          : await runtime.writeAuthRecipe(writeRecipeInput);
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "recipe.get":
    case "auth-recipe.get": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const recipeCommandName =
        invocation.commandId === "recipe.get" ? "recipe get" : "auth-recipe get";
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      if (!key) {
        throw new Error(`${recipeCommandName} requires a key`);
      }
      const version = invocation.positionals[1] ?? readOptionalString(options.version);
      const recipeRef = {
        key,
        ...(version === undefined ? {} : { version }),
      };
      const result =
        invocation.commandId === "recipe.get"
          ? await runtime.getRecipe(recipeRef)
          : await runtime.getAuthRecipe(recipeRef);
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "recipe.list":
    case "auth-recipe.list": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      const listInput = {
        ...(key === undefined ? {} : { key }),
      };
      const result =
        invocation.commandId === "recipe.list"
          ? await runtime.listRecipes(listInput)
          : await runtime.listAuthRecipes(listInput);
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "recipe.run":
    case "auth-recipe.run": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const recipeCommandName =
        invocation.commandId === "recipe.run" ? "recipe run" : "auth-recipe run";
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      if (!key) {
        throw new Error(`${recipeCommandName} requires a key`);
      }
      const runRecipeInput: {
        key: string;
        version?: string;
        variables?: Record<string, string>;
      } = { key };
      const recipeVersion = readOptionalString(options.version);
      if (recipeVersion !== undefined) {
        runRecipeInput.version = recipeVersion;
      }
      const initialVariables = readOptionalJsonObject(options.variablesJson);
      if (initialVariables !== undefined) {
        runRecipeInput.variables = parseStringRecord(initialVariables, "--variables");
      }
      const result =
        invocation.commandId === "recipe.run"
          ? await runtime.runRecipe(runRecipeInput)
          : await runtime.runAuthRecipe(runRecipeInput);
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "request.raw": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const url = invocation.positionals[0] ?? readOptionalString(options.url);
      if (!url) {
        throw new Error("request raw requires a URL");
      }
      const body = await parseRequestBodyInput(options);
      const headers = parseHeaderEntries(readOptionalStrings(options.header));
      const rawRequestInput: {
        url: string;
        transport?: "context-http" | "direct-http" | "page-eval-http" | "session-http";
        method?: string;
        body?: OpensteerRequestBodyInput;
        followRedirects?: boolean;
        headers?: readonly { readonly name: string; readonly value: string }[];
      } = { url };
      const transport = readOptionalString(options.transport);
      if (transport !== undefined) {
        rawRequestInput.transport = parseRequestTransport(transport);
      }
      const method = readOptionalString(options.method);
      if (method !== undefined) {
        rawRequestInput.method = method;
      }
      if (body !== undefined) {
        rawRequestInput.body = body;
      }
      if (readOptionalBoolean(options.noFollowRedirects)) {
        rawRequestInput.followRedirects = false;
      }
      if (headers.length > 0) {
        rawRequestInput.headers = headers;
      }
      const result = await runtime.rawRequest(rawRequestInput);
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "request.execute": {
      const runtime = await resolveCliSemanticRuntime(
        sessionOptions,
        resolveCliExecutionMode(options),
      );
      const key = invocation.positionals[0] ?? readOptionalString(options.key);
      if (!key) {
        throw new Error("request execute requires a plan key");
      }
      const body = await parseRequestBodyInput(options);
      const params = parseKeyValueOptions(readOptionalStrings(options.param));
      const query = parseKeyValueOptions(readOptionalStrings(options.query));
      const headers = parseKeyValueOptions(readOptionalStrings(options.header));
      const requestInput: {
        key: string;
        version?: string;
        params?: Record<string, string>;
        query?: Record<string, string>;
        headers?: Record<string, string>;
        body?: OpensteerRequestBodyInput;
        validateResponse?: boolean;
      } = { key };
      const requestVersion = readOptionalString(options.version);
      if (requestVersion !== undefined) {
        requestInput.version = requestVersion;
      }
      if (params.size > 0) {
        requestInput.params = Object.fromEntries(params);
      }
      if (query.size > 0) {
        requestInput.query = Object.fromEntries(query);
      }
      if (headers.size > 0) {
        requestInput.headers = Object.fromEntries(headers);
      }
      if (body !== undefined) {
        requestInput.body = body;
      }
      if (readOptionalBoolean(options.noValidate) === true) {
        requestInput.validateResponse = false;
      }
      const result = await runtime.request(requestInput);
      await writeJsonOutput(result, readOptionalString(options.output));
      return;
    }

    case "computer": {
      const client = await requireOpensteerService(sessionOptions);
      const action =
        readOptionalJsonObject(options.action) ??
        readJsonObjectPositional(invocation.positionals[0], "action");
      if (!action) {
        throw new Error("computer requires an action JSON object");
      }
      const screenshot = parseComputerScreenshotOptions(options);
      const result = await client.invoke<
        OpensteerComputerExecuteInput,
        OpensteerComputerExecuteOutput
      >("computer.execute", {
        action: parseComputerAction(action),
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
    ...(process.env.OPENSTEER_MODE === undefined
      ? {}
      : { environment: process.env.OPENSTEER_MODE }),
  });
}

async function resolveCliSemanticRuntime(
  sessionOptions: {
    readonly name?: string;
    readonly rootDir?: string;
  },
  mode: "local" | "cloud",
) {
  if (mode === "cloud") {
    return createOpensteerSemanticRuntime({
      runtimeOptions: {
        ...(sessionOptions.name === undefined ? {} : { name: sessionOptions.name }),
        ...(sessionOptions.rootDir === undefined ? {} : { rootDir: sessionOptions.rootDir }),
      },
      cloud: true,
    });
  }

  const attached = await connectOpensteerService(sessionOptions);
  if (attached) {
    return new LocalOpensteerSessionProxy(sessionOptions);
  }

  return new OpensteerSessionRuntime({
    ...(sessionOptions.name === undefined ? {} : { name: sessionOptions.name }),
    ...(sessionOptions.rootDir === undefined ? {} : { rootDir: sessionOptions.rootDir }),
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
  return parseOpensteerServiceMetadata(raw, getOpensteerServiceMetadataPath(rootPath, name))
    .metadata;
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

function parseBrowserOptions(options: ParsedCliOptions): Record<string, unknown> | undefined {
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

  const attachEndpoint = readOptionalString(options.attachEndpoint);
  const userDataDir = readOptionalString(options.userDataDir);
  const profileDirectory = readOptionalString(options.profileDirectory);
  const cloneFrom = readOptionalString(options.cloneFrom);
  const cloneProfileDirectory = readOptionalString(options.cloneProfileDirectory);
  const freshTab = readOptionalBoolean(options.freshTab);
  const attachHeaders = parseHeaderEntries(readOptionalStrings(options.attachHeader));

  const inferredKind =
    browserKind ??
    (attachEndpoint !== undefined ? "attach" : undefined) ??
    (userDataDir !== undefined ? "profile" : undefined);
  const inferredWithClone = inferredKind ?? (cloneFrom !== undefined ? "cloned" : undefined);

  if ((attachEndpoint !== undefined || attachHeaders.length > 0) && userDataDir !== undefined) {
    throw new Error(
      "Specify either attach flags (--attach-endpoint/--attach-header) or launch flags (--user-data-dir), not both.",
    );
  }
  if ((attachEndpoint !== undefined || attachHeaders.length > 0) && cloneFrom !== undefined) {
    throw new Error(
      "Specify either attach flags (--attach-endpoint/--attach-header) or cloned launch flags (--clone-from), not both.",
    );
  }
  if (attachHeaders.length > 0 && attachEndpoint === undefined) {
    throw new Error("--attach-header requires --attach-endpoint.");
  }
  if (cloneFrom !== undefined && userDataDir !== undefined) {
    throw new Error("Specify either --clone-from or --user-data-dir, not both.");
  }

  if (inferredWithClone === "profile") {
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

  if (inferredWithClone === "cloned") {
    if (cloneFrom === undefined) {
      throw new Error('browser kind "cloned" requires --clone-from.');
    }
    return {
      kind: "cloned" as const,
      ...managed,
      sourceUserDataDir: cloneFrom,
      ...(cloneProfileDirectory === undefined
        ? {}
        : { sourceProfileDirectory: cloneProfileDirectory }),
    };
  }

  if (inferredWithClone === "attach") {
    return {
      kind: "attach" as const,
      ...(attachEndpoint === undefined ? {} : { endpoint: attachEndpoint }),
      ...(freshTab === undefined ? {} : { freshTab }),
      ...(attachHeaders.length === 0
        ? {}
        : {
            headers: Object.fromEntries(attachHeaders.map((entry) => [entry.name, entry.value])),
          }),
    };
  }

  if (inferredWithClone !== undefined && inferredWithClone !== "managed") {
    throw new Error(
      `browser must be "managed", "profile", "cloned", or "attach"; received "${inferredWithClone}"`,
    );
  }

  const parsed = {
    ...(browserKind === "managed" ? { kind: "managed" as const } : {}),
    ...managed,
  };
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function parseContextOptions(options: ParsedCliOptions): Record<string, unknown> | undefined {
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

function buildProvenanceInput(options: ParsedCliOptions): OpensteerRegistryProvenance | undefined {
  const source = readOptionalString(options.provenanceSource);
  const sourceId = readOptionalString(options.provenanceSourceId);
  const capturedAt = readOptionalNumber(options.provenanceCapturedAt);
  const notes = readOptionalString(options.provenanceNotes);
  if (source === undefined) {
    if (sourceId !== undefined || capturedAt !== undefined || notes !== undefined) {
      throw new Error(
        "--provenance-source is required when using --provenance-source-id, --provenance-captured-at, or --provenance-notes",
      );
    }
    return undefined;
  }
  const provenance = {
    source,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(notes === undefined ? {} : { notes }),
  };
  return provenance;
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

function buildNetworkFilterInput(options: ParsedCliOptions): Record<string, unknown> {
  return {
    ...(readOptionalString(options.pageRef) === undefined
      ? {}
      : { pageRef: readOptionalString(options.pageRef) }),
    ...(readOptionalString(options.recordId) === undefined
      ? {}
      : { recordId: readOptionalString(options.recordId) }),
    ...(readOptionalString(options.requestId) === undefined
      ? {}
      : { requestId: readOptionalString(options.requestId) }),
    ...(readOptionalString(options.actionId) === undefined
      ? {}
      : { actionId: readOptionalString(options.actionId) }),
    ...(readOptionalString(options.url) === undefined
      ? {}
      : { url: readOptionalString(options.url) }),
    ...(readOptionalString(options.hostname) === undefined
      ? {}
      : { hostname: readOptionalString(options.hostname) }),
    ...(readOptionalString(options.path) === undefined
      ? {}
      : { path: readOptionalString(options.path) }),
    ...(readOptionalString(options.method) === undefined
      ? {}
      : { method: readOptionalString(options.method) }),
    ...(readOptionalString(options.status) === undefined
      ? {}
      : { status: readOptionalString(options.status) }),
    ...(readOptionalString(options.resourceType) === undefined
      ? {}
      : { resourceType: readOptionalString(options.resourceType) }),
  };
}

function buildNetworkTagInput(options: ParsedCliOptions): Record<string, unknown> {
  return readOptionalString(options.networkTag) === undefined
    ? {}
    : { networkTag: readOptionalString(options.networkTag) };
}

function buildNetworkQueryInput(options: ParsedCliOptions): Record<string, unknown> {
  return {
    ...(readOptionalString(options.source) === undefined
      ? {}
      : { source: readOptionalString(options.source) }),
    ...(readOptionalBoolean(options.includeBodies) ? { includeBodies: true } : {}),
    ...(readOptionalNumber(options.limit) === undefined
      ? {}
      : { limit: readOptionalNumber(options.limit) }),
    ...(readOptionalString(options.tag) === undefined
      ? {}
      : { tag: readOptionalString(options.tag) }),
    ...buildNetworkFilterInput(options),
  };
}

async function parseRequestBodyInput(
  options: ParsedCliOptions,
): Promise<OpensteerRequestBodyInput | undefined> {
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
      json: toCanonicalJsonValue(bodyJson),
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
      json: toCanonicalJsonValue(JSON.parse(raw) as unknown),
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
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readOptionalJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`${label} must be a string`);
}

function readRequiredNumber(value: unknown, label: string): number {
  if (typeof value === "number") {
    return value;
  }
  throw new Error(`${label} must be a number`);
}

function readOptionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function parseMouseButton(value: unknown, label: string): "left" | "middle" | "right" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "left" || value === "middle" || value === "right") {
    return value;
  }
  throw new Error(`${label} must be left, middle, or right`);
}

function parseKeyModifiers(
  value: unknown,
  label: string,
): readonly ("Shift" | "Control" | "Alt" | "Meta")[] | undefined {
  const modifiers = readOptionalStringArray(value, label);
  if (modifiers === undefined) {
    return undefined;
  }
  const parsed: ("Shift" | "Control" | "Alt" | "Meta")[] = [];
  for (const modifier of modifiers) {
    if (
      modifier !== "Shift" &&
      modifier !== "Control" &&
      modifier !== "Alt" &&
      modifier !== "Meta"
    ) {
      throw new Error(`${label} contains invalid modifier "${modifier}"`);
    }
    parsed.push(modifier);
  }
  return parsed;
}

function parsePoint(value: unknown, label: string): { readonly x: number; readonly y: number } {
  const point = readOptionalJsonObject(value);
  if (point === undefined) {
    throw new Error(`${label} must be an object`);
  }
  return {
    x: readRequiredNumber(point.x, `${label}.x`),
    y: readRequiredNumber(point.y, `${label}.y`),
  };
}

function parseRequestPlanPayload(value: Record<string, unknown>): OpensteerRequestPlanPayload {
  assertValidJsonObject<OpensteerRequestPlanPayload>(
    value,
    opensteerRequestPlanPayloadSchema,
    "request plan payload",
  );
  return value;
}

function parseRecipePayload(value: Record<string, unknown>): OpensteerRecipePayload {
  assertValidJsonObject<OpensteerRecipePayload>(
    value,
    opensteerAuthRecipePayloadSchema,
    "recipe payload",
  );
  return value;
}

function parseRequestPlanLifecycle(value: string): OpensteerRequestPlanLifecycle {
  if (value === "draft" || value === "active" || value === "deprecated" || value === "retired") {
    return value;
  }
  throw new Error(`invalid lifecycle "${value}"`);
}

function parseRequestTransport(
  value: string,
): "context-http" | "direct-http" | "page-eval-http" | "session-http" {
  if (
    value === "context-http" ||
    value === "direct-http" ||
    value === "page-eval-http" ||
    value === "session-http"
  ) {
    return value;
  }
  throw new Error(`invalid transport "${value}"`);
}

function parseStringRecord(value: Record<string, unknown>, label: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`${label} must be a JSON object of string values (invalid "${key}")`);
    }
    parsed[key] = entry;
  }
  return parsed;
}

function parseComputerAction(value: Record<string, unknown>): OpensteerComputerAction {
  const type = readOptionalString(value.type);
  switch (type) {
    case "click": {
      const button = parseMouseButton(value.button, "action.button");
      const clickCount = readOptionalNumber(value.clickCount);
      const modifiers = parseKeyModifiers(value.modifiers, "action.modifiers");
      return {
        type,
        x: readRequiredNumber(value.x, "action.x"),
        y: readRequiredNumber(value.y, "action.y"),
        ...(button === undefined ? {} : { button }),
        ...(clickCount === undefined ? {} : { clickCount }),
        ...(modifiers === undefined ? {} : { modifiers }),
      };
    }
    case "move":
      return {
        type,
        x: readRequiredNumber(value.x, "action.x"),
        y: readRequiredNumber(value.y, "action.y"),
      };
    case "scroll":
      return {
        type,
        x: readRequiredNumber(value.x, "action.x"),
        y: readRequiredNumber(value.y, "action.y"),
        deltaX: readRequiredNumber(value.deltaX, "action.deltaX"),
        deltaY: readRequiredNumber(value.deltaY, "action.deltaY"),
      };
    case "type":
      return {
        type,
        text: readRequiredString(value.text, "action.text"),
      };
    case "key": {
      const modifiers = parseKeyModifiers(value.modifiers, "action.modifiers");
      return {
        type,
        key: readRequiredString(value.key, "action.key"),
        ...(modifiers === undefined ? {} : { modifiers }),
      };
    }
    case "drag": {
      const steps = readOptionalNumber(value.steps);
      return {
        type,
        start: parsePoint(value.start, "action.start"),
        end: parsePoint(value.end, "action.end"),
        ...(steps === undefined ? {} : { steps }),
      };
    }
    case "screenshot":
      return { type };
    case "wait":
      return {
        type,
        durationMs: readRequiredNumber(value.durationMs, "action.durationMs"),
      };
    default:
      throw new Error(
        "action.type must be one of click, move, scroll, type, key, drag, screenshot, or wait",
      );
  }
}

function assertValidJsonObject<T>(
  value: unknown,
  schema: Parameters<typeof validateJsonSchema>[0],
  label: string,
): asserts value is T {
  const issues = validateJsonSchema(schema, value);
  if (issues.length === 0) {
    return;
  }
  const issue = issues[0]!;
  throw new Error(`invalid ${label} at ${issue.path}: ${issue.message}`);
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
