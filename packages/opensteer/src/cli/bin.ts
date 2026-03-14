#!/usr/bin/env node

import {
  connectOpensteerService,
  ensureOpensteerService,
  OpensteerCliServiceError,
  requireOpensteerService,
} from "./client.js";
import { runOpensteerServiceHost } from "./service-host.js";

interface ParsedCliArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseCliArgs(argv);

  if (parsed.command === "service-host") {
    await runOpensteerServiceHost({
      name: readStringOption(parsed.options, "name") ?? "default",
      ...(readStringOption(parsed.options, "root-dir") === undefined
        ? {}
        : { rootDir: readStringOption(parsed.options, "root-dir")! }),
    });
    return;
  }

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
      const client = await ensureOpensteerService({
        ...sessionOptions,
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
        `unsupported command "${parsed.command}". Supported commands: open, goto, snapshot, click, hover, input, scroll, extract, close.`,
      );
  }
}

function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const command = argv[0] ?? "help";
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

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
      options[name] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[name] = next;
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
  options: Readonly<Record<string, string | boolean>>,
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
  options: Readonly<Record<string, string | boolean>>,
): Record<string, unknown> | undefined {
  const browserJson = readStringOption(options, "browser-json");
  if (browserJson) {
    return parseJsonObject(browserJson, "browser-json");
  }

  const parsed = {
    ...(readBooleanOption(options, "headless", true) === undefined
      ? {}
      : { headless: readBooleanOption(options, "headless", true) }),
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
  options: Readonly<Record<string, string | boolean>>,
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

function readStringOption(
  options: Readonly<Record<string, string | boolean>>,
  key: string,
): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function readBooleanOption(
  options: Readonly<Record<string, string | boolean>>,
  key: string,
  bareTrue = false,
): boolean | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    return bareTrue ? true : true;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`${key} must be a boolean value`);
}

function readNumberOption(
  options: Readonly<Record<string, string | boolean>>,
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

function readNumericPositional(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 10);
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
