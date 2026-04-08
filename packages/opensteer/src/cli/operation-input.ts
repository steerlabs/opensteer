import type { OpensteerSemanticOperationName } from "@opensteer/protocol";
import type { OpensteerSemanticRuntime } from "@opensteer/runtime-core";

import {
  parseCommaSeparatedList,
  parseKeyValueList,
  readJsonArray,
  readJsonObject,
  readJsonValue,
  readOptionalBoolean,
  readOptionalNumber,
  readSingle,
  type ParsedCommandLine,
} from "./parse.js";

const CLICK_BUTTONS = new Set(["left", "middle", "right"]);
const FETCH_TRANSPORTS = new Set(["auto", "direct", "matched-tls", "page"]);
const CAPTCHA_PROVIDERS = new Set(["2captcha", "capsolver"]);
const CAPTCHA_TYPES = new Set(["recaptcha-v2", "hcaptcha", "turnstile"]);
const SANDBOX_FIDELITIES = new Set(["minimal", "standard", "full"]);
const SANDBOX_CLOCK_MODES = new Set(["real", "manual"]);
const SCREENSHOT_FORMATS = new Set(["png", "jpeg", "webp"]);
const KEY_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);
const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

export async function buildOperationInput(
  operation: OpensteerSemanticOperationName,
  parsed: ParsedCommandLine,
  runtime: OpensteerSemanticRuntime,
): Promise<Record<string, unknown>> {
  switch (operation) {
    case "session.open": {
      const url = parsed.rest[0];
      if (url === undefined) {
        throw new Error("open requires a URL.");
      }
      return {
        url,
        ...(parsed.options.workspace === undefined ? {} : { workspace: parsed.options.workspace }),
        ...(parsed.options.browser === undefined ? {} : { browser: parsed.options.browser }),
        ...(parsed.options.launch === undefined ? {} : { launch: parsed.options.launch }),
        ...(parsed.options.context === undefined ? {} : { context: parsed.options.context }),
      };
    }
    case "page.list":
      return {};
    case "page.new":
      return parsed.rest[0] === undefined ? {} : { url: parsed.rest[0] };
    case "page.activate": {
      const index = readRequiredPositiveInteger(parsed.rest[0], "tab requires an index.");
      return {
        pageRef: await resolvePageRefByIndex(runtime, index),
      };
    }
    case "page.close": {
      if (parsed.rest[0] === undefined) {
        return {};
      }
      return {
        pageRef: await resolvePageRefByIndex(
          runtime,
          readRequiredPositiveInteger(parsed.rest[0], "tab close requires an index."),
        ),
      };
    }
    case "page.goto": {
      if (parsed.rest[0] === undefined) {
        throw new Error("goto requires a URL.");
      }
      const captureNetwork = readSingle(parsed.rawOptions, "capture-network");
      return {
        url: parsed.rest[0],
        ...(captureNetwork === undefined ? {} : { captureNetwork }),
      };
    }
    case "page.snapshot":
      return parsed.rest[0] === undefined ? {} : { mode: parsed.rest[0] };
    case "page.evaluate":
      if (parsed.rest[0] === undefined) {
        throw new Error("evaluate requires a script.");
      }
      return {
        script: joinRest(parsed.rest, 0),
      };
    case "page.add-init-script":
      if (parsed.rest[0] === undefined) {
        throw new Error("init-script requires a script.");
      }
      return {
        script: joinRest(parsed.rest, 0),
      };
    case "dom.click": {
      const button = readSingle(parsed.rawOptions, "button");
      return {
        ...buildElementTargetInput(parsed, "click"),
        ...(button === undefined ? {} : { button: readClickButton(button) }),
      };
    }
    case "dom.hover":
      return buildElementTargetInput(parsed, "hover");
    case "dom.input": {
      if (parsed.rest[1] === undefined) {
        throw new Error("input requires an element number and text.");
      }
      const pressEnter = readOptionalBoolean(parsed.rawOptions, "press-enter");
      return {
        ...buildElementTargetInput(parsed, "input"),
        text: joinRest(parsed.rest, 1),
        ...(pressEnter === undefined ? {} : { pressEnter }),
      };
    }
    case "dom.scroll": {
      const direction = readSingleDirection(parsed.rest[0]);
      const amount = readRequiredPositiveInteger(parsed.rest[1], "scroll requires an amount.");
      const element = readOptionalNumber(parsed.rawOptions, "element");
      const persist = readPersistKey(parsed, "scroll");
      const captureNetwork = readSingle(parsed.rawOptions, "capture-network");
      return {
        target:
          element === undefined
            ? {
                kind: "selector",
                selector: "html",
              }
            : {
                kind: "element",
                element,
              },
        direction,
        amount,
        ...(persist === undefined ? {} : { persist }),
        ...(captureNetwork === undefined ? {} : { captureNetwork }),
      };
    }
    case "dom.extract": {
      if (parsed.rest[0] === undefined) {
        throw new Error("extract requires a schema.");
      }
      const persist = readExtractPersistKey(parsed);
      return {
        schema: parseRequiredJsonObjectArgument(joinRest(parsed.rest, 0), "extract schema"),
        ...(persist === undefined ? {} : { persist }),
      };
    }
    case "network.query": {
      const capture = readSingle(parsed.rawOptions, "capture");
      const url = readSingle(parsed.rawOptions, "url");
      const hostname = readSingle(parsed.rawOptions, "hostname");
      const path = readSingle(parsed.rawOptions, "path");
      const method = readSingle(parsed.rawOptions, "method");
      const status = readOptionalNumber(parsed.rawOptions, "status");
      const resourceType = readSingle(parsed.rawOptions, "type");
      const json = readOptionalBoolean(parsed.rawOptions, "json");
      const before = readSingle(parsed.rawOptions, "before");
      const after = readSingle(parsed.rawOptions, "after");
      const limit = readOptionalNumber(parsed.rawOptions, "limit");
      return {
        ...(capture === undefined ? {} : { capture }),
        ...(url === undefined ? {} : { url }),
        ...(hostname === undefined ? {} : { hostname }),
        ...(path === undefined ? {} : { path }),
        ...(method === undefined ? {} : { method }),
        ...(status === undefined ? {} : { status }),
        ...(resourceType === undefined ? {} : { resourceType }),
        ...(json === true ? { json: true } : {}),
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    case "network.detail":
      if (parsed.rest[0] === undefined) {
        throw new Error("network detail requires a record id.");
      }
      return {
        recordId: parsed.rest[0],
      };
    case "network.replay": {
      if (parsed.rest[0] === undefined) {
        throw new Error("replay requires a record id.");
      }
      const query = parseKeyValueList(parsed.rawOptions.get("query"));
      const headers = parseKeyValueList(parsed.rawOptions.get("header"));
      const bodyJson = readJsonValue(parsed.rawOptions, "body");
      const variables = readJsonObject(parsed.rawOptions, "variables");
      return {
        recordId: parsed.rest[0],
        ...(query === undefined ? {} : { query }),
        ...(headers === undefined ? {} : { headers }),
        ...(bodyJson === undefined ? {} : { body: { json: bodyJson } }),
        ...(variables === undefined ? {} : { variables }),
      };
    }
    case "session.fetch": {
      const url = parsed.rest[0];
      if (url === undefined) {
        throw new Error("fetch requires a URL.");
      }
      const bodyJson = readJsonValue(parsed.rawOptions, "body");
      const bodyText = readSingle(parsed.rawOptions, "body-text");
      const method = readSingle(parsed.rawOptions, "method");
      const query = parseKeyValueList(parsed.rawOptions.get("query"));
      const headers = parseKeyValueList(parsed.rawOptions.get("header"));
      if (bodyJson !== undefined && bodyText !== undefined) {
        throw new Error('Use either "--body" or "--body-text", not both.');
      }
      const transport = readSingle(parsed.rawOptions, "transport");
      const cookies = readOptionalBoolean(parsed.rawOptions, "cookies");
      const followRedirects = readOptionalBoolean(parsed.rawOptions, "follow-redirects");
      return {
        url,
        ...(method === undefined ? {} : { method }),
        ...(query === undefined ? {} : { query }),
        ...(headers === undefined ? {} : { headers }),
        ...(bodyJson === undefined ? {} : { body: { json: bodyJson } }),
        ...(bodyText === undefined ? {} : { body: { text: bodyText } }),
        ...(transport === undefined ? {} : { transport: readFetchTransport(transport) }),
        ...(cookies === undefined ? {} : { cookies }),
        ...(followRedirects === undefined ? {} : { followRedirects }),
      };
    }
    case "session.cookies":
    case "session.storage":
    case "session.state":
      return parsed.rest[0] === undefined ? {} : { domain: parsed.rest[0] };
    case "computer.execute":
      return buildComputerExecuteInput(parsed);
    case "captcha.solve": {
      const provider = readSingle(parsed.rawOptions, "provider");
      const apiKey = readSingle(parsed.rawOptions, "api-key");
      const timeoutMs =
        readOptionalNumber(parsed.rawOptions, "timeout") ??
        readOptionalNumber(parsed.rawOptions, "timeout-ms");
      const type = readSingle(parsed.rawOptions, "type");
      const siteKey = readSingle(parsed.rawOptions, "site-key");
      const pageUrl = readSingle(parsed.rawOptions, "page-url");
      if (provider === undefined || apiKey === undefined) {
        throw new Error('captcha solve requires "--provider" and "--api-key".');
      }
      return {
        provider: readCaptchaProvider(provider),
        apiKey,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(type === undefined ? {} : { type: readCaptchaType(type) }),
        ...(siteKey === undefined ? {} : { siteKey }),
        ...(pageUrl === undefined ? {} : { pageUrl }),
      };
    }
    case "scripts.capture": {
      const urlFilter = readSingle(parsed.rawOptions, "url-filter");
      const persist = readOptionalBoolean(parsed.rawOptions, "persist");
      const includeInline = readOptionalBoolean(parsed.rawOptions, "inline");
      const includeExternal = readOptionalBoolean(parsed.rawOptions, "external");
      const includeDynamic = readOptionalBoolean(parsed.rawOptions, "dynamic");
      const includeWorkers = readOptionalBoolean(parsed.rawOptions, "workers");
      return {
        ...(urlFilter === undefined ? {} : { urlFilter }),
        ...(persist === undefined ? {} : { persist }),
        ...(includeInline === undefined ? {} : { includeInline }),
        ...(includeExternal === undefined ? {} : { includeExternal }),
        ...(includeDynamic === undefined ? {} : { includeDynamic }),
        ...(includeWorkers === undefined ? {} : { includeWorkers }),
      };
    }
    case "scripts.beautify":
    case "scripts.deobfuscate": {
      if (parsed.rest[0] === undefined) {
        throw new Error(`${parsed.command.join(" ")} requires an artifact id.`);
      }
      const persist = readOptionalBoolean(parsed.rawOptions, "persist");
      return {
        artifactId: parsed.rest[0],
        ...(persist === undefined ? {} : { persist }),
      };
    }
    case "scripts.sandbox":
      if (parsed.rest[0] === undefined) {
        throw new Error("scripts sandbox requires an artifact id.");
      }
      {
        const fidelity = readSingle(parsed.rawOptions, "fidelity");
        const timeoutMs =
          readOptionalNumber(parsed.rawOptions, "timeout") ??
          readOptionalNumber(parsed.rawOptions, "timeout-ms");
        const clock = readSingle(parsed.rawOptions, "clock");
        const cookies = readJsonObject(parsed.rawOptions, "cookies");
        const globals = readJsonObject(parsed.rawOptions, "globals");
        const ajaxRoutes = readJsonArray(parsed.rawOptions, "ajax-routes");
        return {
          artifactId: parsed.rest[0],
          ...(fidelity === undefined ? {} : { fidelity: readSandboxFidelity(fidelity) }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(clock === undefined ? {} : { clockMode: readSandboxClockMode(clock) }),
          ...(cookies === undefined ? {} : { cookies }),
          ...(globals === undefined ? {} : { globals }),
          ...(ajaxRoutes === undefined ? {} : { ajaxRoutes }),
        };
      }
    case "interaction.capture": {
      const key = readSingle(parsed.rawOptions, "key");
      const durationMs = readOptionalNumber(parsed.rawOptions, "duration");
      const script = readSingle(parsed.rawOptions, "script");
      const includeStorage = readOptionalBoolean(parsed.rawOptions, "include-storage");
      const includeSessionStorage = readOptionalBoolean(
        parsed.rawOptions,
        "include-session-storage",
      );
      const includeIndexedDb = readOptionalBoolean(parsed.rawOptions, "include-indexed-db");
      const globalNames = parseCommaSeparatedList(readSingle(parsed.rawOptions, "global-names"));
      const caseId = readSingle(parsed.rawOptions, "case-id");
      const notes = readSingle(parsed.rawOptions, "notes");
      const tags = parseCommaSeparatedList(readSingle(parsed.rawOptions, "tags"));
      return {
        ...(key === undefined ? {} : { key }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(script === undefined ? {} : { script }),
        ...(includeStorage === undefined ? {} : { includeStorage }),
        ...(includeSessionStorage === undefined ? {} : { includeSessionStorage }),
        ...(includeIndexedDb === undefined ? {} : { includeIndexedDb }),
        ...(globalNames === undefined ? {} : { globalNames }),
        ...(caseId === undefined ? {} : { caseId }),
        ...(notes === undefined ? {} : { notes }),
        ...(tags === undefined ? {} : { tags }),
      };
    }
    case "interaction.get":
    case "interaction.replay":
      if (parsed.rest[0] === undefined) {
        throw new Error(`${parsed.command.join(" ")} requires a trace id.`);
      }
      return {
        traceId: parsed.rest[0],
      };
    case "interaction.diff":
      if (parsed.rest[0] === undefined || parsed.rest[1] === undefined) {
        throw new Error("interaction diff requires two trace ids.");
      }
      return {
        leftTraceId: parsed.rest[0],
        rightTraceId: parsed.rest[1],
      };
    case "artifact.read":
      if (parsed.rest[0] === undefined) {
        throw new Error("artifact read requires an artifact id.");
      }
      return {
        artifactId: parsed.rest[0],
      };
    case "session.close":
      return {};
    default:
      throw new Error(
        `${operation} does not have a direct CLI input shape. Use a supported command or the SDK.`,
      );
  }
}

function buildElementTargetInput(
  parsed: ParsedCommandLine,
  verb: "click" | "hover" | "input",
): Record<string, unknown> {
  const element = readRequiredPositiveInteger(
    parsed.rest[0],
    `${verb} requires an element number.`,
  );
  const persist = readPersistKey(parsed, verb);
  const captureNetwork = readSingle(parsed.rawOptions, "capture-network");
  return {
    target: {
      kind: "element",
      element,
    },
    ...(persist === undefined ? {} : { persist }),
    ...(captureNetwork === undefined ? {} : { captureNetwork }),
  };
}

function buildComputerExecuteInput(parsed: ParsedCommandLine): Record<string, unknown> {
  const subcommand = parsed.command[1];
  const screenshotFormat = readSingle(parsed.rawOptions, "format");
  const screenshot =
    screenshotFormat === undefined
      ? undefined
      : {
          format: readScreenshotFormat(screenshotFormat),
        };
  const captureNetwork = readSingle(parsed.rawOptions, "capture-network");

  switch (subcommand) {
    case "click": {
      const button = readSingle(parsed.rawOptions, "button");
      const clickCount = readOptionalNumber(parsed.rawOptions, "count");
      const modifiers = readKeyModifiers(readSingle(parsed.rawOptions, "modifiers"));
      return {
        action: {
          type: "click",
          x: readRequiredNumber(parsed.rest[0], "computer click requires x."),
          y: readRequiredNumber(parsed.rest[1], "computer click requires y."),
          ...(button === undefined ? {} : { button: readClickButton(button) }),
          ...(clickCount === undefined ? {} : { clickCount }),
          ...(modifiers === undefined ? {} : { modifiers }),
        },
        ...(captureNetwork === undefined ? {} : { captureNetwork }),
      };
    }
    case "type":
      if (parsed.rest[0] === undefined) {
        throw new Error("computer type requires text.");
      }
      return {
        action: {
          type: "type",
          text: joinRest(parsed.rest, 0),
        },
        ...(captureNetwork === undefined ? {} : { captureNetwork }),
      };
    case "key": {
      if (parsed.rest[0] === undefined) {
        throw new Error("computer key requires a key.");
      }
      const modifiers = readKeyModifiers(readSingle(parsed.rawOptions, "modifiers"));
      return {
        action: {
          type: "key",
          key: parsed.rest[0],
          ...(modifiers === undefined ? {} : { modifiers }),
        },
        ...(captureNetwork === undefined ? {} : { captureNetwork }),
      };
    }
    case "scroll": {
      const dx = readOptionalNumber(parsed.rawOptions, "dx");
      const dy = readOptionalNumber(parsed.rawOptions, "dy");
      if (dx === undefined || dy === undefined) {
        throw new Error('computer scroll requires "--dx" and "--dy".');
      }
      return {
        action: {
          type: "scroll",
          x: readRequiredNumber(parsed.rest[0], "computer scroll requires x."),
          y: readRequiredNumber(parsed.rest[1], "computer scroll requires y."),
          deltaX: dx,
          deltaY: dy,
        },
        ...(captureNetwork === undefined ? {} : { captureNetwork }),
      };
    }
    case "move":
      return {
        action: {
          type: "move",
          x: readRequiredNumber(parsed.rest[0], "computer move requires x."),
          y: readRequiredNumber(parsed.rest[1], "computer move requires y."),
        },
        ...(captureNetwork === undefined ? {} : { captureNetwork }),
      };
    case "drag": {
      const steps = readOptionalNumber(parsed.rawOptions, "steps");
      return {
        action: {
          type: "drag",
          start: {
            x: readRequiredNumber(parsed.rest[0], "computer drag requires start x."),
            y: readRequiredNumber(parsed.rest[1], "computer drag requires start y."),
          },
          end: {
            x: readRequiredNumber(parsed.rest[2], "computer drag requires end x."),
            y: readRequiredNumber(parsed.rest[3], "computer drag requires end y."),
          },
          ...(steps === undefined ? {} : { steps }),
        },
        ...(captureNetwork === undefined ? {} : { captureNetwork }),
      };
    }
    case "screenshot":
      return {
        action: {
          type: "screenshot",
        },
        ...(screenshot === undefined ? {} : { screenshot }),
      };
    case "wait":
      return {
        action: {
          type: "wait",
          durationMs: readRequiredPositiveInteger(parsed.rest[0], "computer wait requires ms."),
        },
      };
    default:
      throw new Error(`Unknown computer command: ${parsed.command.join(" ")}`);
  }
}

async function resolvePageRefByIndex(
  runtime: OpensteerSemanticRuntime,
  index: number,
): Promise<string> {
  const pages = (await runtime.listPages({})).pages;
  const page = pages[index - 1];
  if (page === undefined) {
    throw new Error(`tab ${String(index)} does not exist.`);
  }
  return page.pageRef;
}

function readRequiredPositiveInteger(value: string | undefined, message: string): number {
  const parsed = readRequiredNumber(value, message);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(message);
  }
  return parsed;
}

function readRequiredNumber(value: string | undefined, message: string): number {
  if (value === undefined) {
    throw new Error(message);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(message);
  }
  return parsed;
}

function readSingleDirection(value: string | undefined): "up" | "down" | "left" | "right" {
  if (value === undefined || !SCROLL_DIRECTIONS.has(value)) {
    throw new Error("scroll requires a direction: up, down, left, or right.");
  }
  return value as "up" | "down" | "left" | "right";
}

function readClickButton(value: string | undefined): "left" | "middle" | "right" {
  if (value === undefined || !CLICK_BUTTONS.has(value)) {
    throw new Error('Expected "--button" to be one of: left, middle, right.');
  }
  return value as "left" | "middle" | "right";
}

function readFetchTransport(value: string | undefined): "auto" | "direct" | "matched-tls" | "page" {
  if (value === undefined || !FETCH_TRANSPORTS.has(value)) {
    throw new Error('Expected "--transport" to be one of: auto, direct, matched-tls, page.');
  }
  return value as "auto" | "direct" | "matched-tls" | "page";
}

function readCaptchaProvider(value: string | undefined): "2captcha" | "capsolver" {
  if (value === undefined || !CAPTCHA_PROVIDERS.has(value)) {
    throw new Error('Expected "--provider" to be one of: 2captcha, capsolver.');
  }
  return value as "2captcha" | "capsolver";
}

function readCaptchaType(
  value: string | undefined,
): "recaptcha-v2" | "hcaptcha" | "turnstile" {
  if (value === undefined || !CAPTCHA_TYPES.has(value)) {
    throw new Error(
      'Expected "--type" to be one of: recaptcha-v2, hcaptcha, turnstile.',
    );
  }
  return value as "recaptcha-v2" | "hcaptcha" | "turnstile";
}

function readSandboxFidelity(value: string | undefined): "minimal" | "standard" | "full" {
  if (value === undefined || !SANDBOX_FIDELITIES.has(value)) {
    throw new Error('Expected "--fidelity" to be one of: minimal, standard, full.');
  }
  return value as "minimal" | "standard" | "full";
}

function readSandboxClockMode(value: string | undefined): "real" | "manual" {
  if (value === undefined || !SANDBOX_CLOCK_MODES.has(value)) {
    throw new Error('Expected "--clock" to be one of: real, manual.');
  }
  return value as "real" | "manual";
}

function readScreenshotFormat(value: string | undefined): "png" | "jpeg" | "webp" {
  if (value === undefined || !SCREENSHOT_FORMATS.has(value)) {
    throw new Error('Expected "--format" to be one of: png, jpeg, webp.');
  }
  return value as "png" | "jpeg" | "webp";
}

function readKeyModifiers(
  value: string | undefined,
): readonly ("Shift" | "Control" | "Alt" | "Meta")[] | undefined {
  const modifiers = parseCommaSeparatedList(value);
  if (modifiers === undefined) {
    return undefined;
  }
  for (const modifier of modifiers) {
    if (!KEY_MODIFIERS.has(modifier)) {
      throw new Error('Expected "--modifiers" to contain only: Shift, Control, Alt, Meta.');
    }
  }
  return [...new Set(modifiers)] as readonly ("Shift" | "Control" | "Alt" | "Meta")[];
}

function readPersistKey(
  parsed: ParsedCommandLine,
  verb: "click" | "hover" | "input" | "scroll",
): string | undefined {
  const value = readSingle(parsed.rawOptions, "persist");
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || value === "false") {
    throw new Error(`${verb} requires "--persist <key>" when using --persist.`);
  }
  if (verb === "scroll" && readOptionalNumber(parsed.rawOptions, "element") === undefined) {
    throw new Error('scroll requires "--element <n>" when using "--persist <key>".');
  }
  return value;
}

function readExtractPersistKey(parsed: ParsedCommandLine): string | undefined {
  const value = readSingle(parsed.rawOptions, "persist");
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || value === "false") {
    throw new Error('extract requires "--persist <key>" when using --persist.');
  }
  return value;
}

function parseRequiredJsonObjectArgument(
  value: string,
  label: string,
): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function joinRest(rest: readonly string[], startIndex: number): string {
  return rest.slice(startIndex).join(" ");
}
