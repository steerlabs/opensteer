#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

import {
  connectOpensteerService,
  ensureOpensteerService,
  OpensteerCliServiceError,
  requireOpensteerService,
} from "./client.js";
import {
  normalizeOpensteerEngineName,
  resolveOpensteerEngineName,
} from "../internal/engine-selection.js";
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

  if (parsed.command === "service-host") {
    await runOpensteerServiceHost({
      name: readStringOption(parsed.options, "name") ?? "default",
      ...(readStringOption(parsed.options, "root-dir") === undefined
        ? {}
        : { rootDir: readStringOption(parsed.options, "root-dir")! }),
      ...(readStringOption(parsed.options, "engine") === undefined
        ? {}
        : { engine: normalizeOpensteerEngineName(readStringOption(parsed.options, "engine")!, "--engine") }),
    });
    return;
  }

  if (parsed.command === "mcp") {
    await runOpensteerMcpServer({
      name: readStringOption(parsed.options, "name") ?? "default",
      ...(readStringOption(parsed.options, "root-dir") === undefined
        ? {}
        : { rootDir: readStringOption(parsed.options, "root-dir")! }),
      engine: resolveOpensteerEngineName({
        requested: readStringOption(parsed.options, "engine"),
        environment: process.env.OPENSTEER_ENGINE,
      }),
    });
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
      const engine = resolveOpensteerEngineName({
        requested: readStringOption(parsed.options, "engine"),
        environment: process.env.OPENSTEER_ENGINE,
      });
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
      const browser = parseBrowserOptions(parsed.options);
      const context = parseContextOptions(parsed.options);
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
      const result = await client.invoke("page.goto", { url });
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
      const result = await client.invoke("dom.click", target);
      writeJson(result);
      return;
    }

    case "hover": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(parsed.positionals, parsed.options);
      const result = await client.invoke("dom.hover", target);
      writeJson(result);
      return;
    }

    case "input": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(parsed.positionals, parsed.options);
      const text = readStringOption(parsed.options, "text") ?? consumeTextPositional(parsed.positionals);
      if (!text) {
        throw new Error("input requires text");
      }
      const result = await client.invoke("dom.input", {
        ...target,
        text,
        ...(readBooleanOption(parsed.options, "press-enter") ? { pressEnter: true } : {}),
      });
      writeJson(result);
      return;
    }

    case "scroll": {
      const client = await requireOpensteerService(sessionOptions);
      const target = parseTargetInput(parsed.positionals, parsed.options);
      const direction =
        readStringOption(parsed.options, "direction") ?? consumeRemainingPositionals(parsed.positionals)[0];
      const amountRaw =
        readStringOption(parsed.options, "amount") ?? consumeRemainingPositionals(parsed.positionals)[1];
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

    case "capture": {
      const action = parsed.positionals[0];
      const client = await requireOpensteerService(sessionOptions);

      if (action === "start") {
        const resourceTypes = parseCsvOption(readStringOption(parsed.options, "types"));
        const result = await client.invoke("request-capture.start", {
          ...(readStringOption(parsed.options, "scope") === undefined
            ? {}
            : { scope: readStringOption(parsed.options, "scope") }),
          ...(resourceTypes === undefined ? {} : { resourceTypes }),
        });
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      if (action === "stop") {
        const result = await client.invoke("request-capture.stop", {});
        await writeJsonOutput(result, readStringOption(parsed.options, "output"));
        return;
      }

      throw new Error('capture requires a subcommand: "start" or "stop"');
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

      throw new Error('plan requires a subcommand: "write", "get", or "list"');
    }

    case "request": {
      const client = await requireOpensteerService(sessionOptions);
      const key = parsed.positionals[0] ?? readStringOption(parsed.options, "key");
      if (!key) {
        throw new Error("request requires a plan key");
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
      const result = await client.invoke("computer.execute", {
        action: parseJsonObject(actionRaw, "action"),
        ...(screenshot === undefined ? {} : { screenshot }),
      });
      writeJson(result);
      return;
    }

    case "close": {
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
        `unsupported command "${parsed.command}". Supported commands: open, goto, snapshot, click, hover, input, scroll, extract, capture, plan, request, computer, mcp, close.`,
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

  const parsed = {
    ...(readBooleanOption(options, "headless") === undefined
      ? {}
      : { headless: readBooleanOption(options, "headless") }),
    ...(readStringOption(options, "executable-path") === undefined
      ? {}
      : { executablePath: readStringOption(options, "executable-path") }),
    ...(readStringOption(options, "channel") === undefined
      ? {}
      : { channel: readStringOption(options, "channel") }),
    ...(readBooleanOption(options, "devtools") === undefined
      ? {}
      : { devtools: readBooleanOption(options, "devtools") }),
    ...(readNumberOption(options, "timeout-ms") === undefined
      ? {}
      : { timeoutMs: readNumberOption(options, "timeout-ms") }),
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
    throw new Error(
      "Specify only one of --body-json, --body-text, --body-base64, or --body-file.",
    );
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
  const annotations = parseCsvOption(readStringOption(options, "annotations"));

  if (
    screenshotJson !== undefined &&
    (format !== undefined || includeCursor !== undefined || annotations !== undefined)
  ) {
    throw new Error(
      "Specify either --screenshot-json or individual screenshot flags (--format, --include-cursor, --annotations).",
    );
  }

  if (screenshotJson !== undefined) {
    return parseJsonObject(screenshotJson, "screenshot-json");
  }

  const parsed = {
    ...(format === undefined ? {} : { format }),
    ...(includeCursor === undefined ? {} : { includeCursor }),
    ...(annotations === undefined ? {} : { annotations }),
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
