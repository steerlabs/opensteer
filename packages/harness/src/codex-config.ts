import { isRecord } from "@opensteer/shared/isRecord";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Result of checking whether Opensteer can build a clean, Opensteer-owned
 * `CODEX_HOME` for a task that is not the person's own.
 */
export type CodexOthersHomeCheck =
  | { readonly ok: true; readonly mode: "isolated" }
  | {
      readonly ok: true;
      readonly mode: "ambient";
      readonly authPath: string;
      readonly configTomlText: string;
      readonly sourceHome: string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The person's ambient Codex home from the process environment. Never falls
 * back to `os.homedir()` when no environment is supplied, so tests and callers
 * without an environment fail closed instead of reading the host's `~/.codex`.
 */
export function codexAmbientHome(
  environment?: Readonly<Record<string, string>>,
): string | undefined {
  const configured = environment?.CODEX_HOME?.trim();
  if (configured) return configured;
  const home = environment?.HOME?.trim();
  if (home) return join(home, ".codex");
  return undefined;
}

/**
 * Decides whether Codex can run a task that is not the person's own from an
 * Opensteer-owned `CODEX_HOME` that shares their file login without copying it.
 *
 * Codex 0.162.0 writes `auth.json` in place through a symbolic link on both
 * login and OAuth token refresh (`FileAuthStorage::save`), while its keyring
 * stores key credentials by a hash of `CODEX_HOME.canonicalize()`. So another
 * home can share a file login, never a keyring login.
 */
export function checkCodexOthersHome(context: {
  readonly environment?: Readonly<Record<string, string>>;
  readonly providerState?: { readonly kind: "ambient" | "isolated" };
}): CodexOthersHomeCheck {
  if (context.providerState?.kind === "isolated") {
    return { ok: true, mode: "isolated" };
  }
  const sourceHome = codexAmbientHome(context.environment);
  if (!sourceHome) {
    return {
      ok: false,
      message:
        'Codex has no file login (auth.json) Opensteer can locate, so it runs only tasks you started yourself. Sign in with codex login (with cli_auth_credentials_store = "file") to allow Codex on tasks a connected agent or chat started.',
    };
  }
  let parsedConfig: Record<string, unknown> = {};
  const configPath = join(sourceHome, "config.toml");
  try {
    const raw = readFileSync(configPath, "utf8");
    parsedConfig = parseCodexConfigToml(raw);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      return {
        ok: false,
        message:
          "Opensteer could not read your Codex config.toml to build a separate Codex home for tasks a connected agent or chat started. Fix your Codex config.toml or run this task on another engine.",
      };
    }
  }
  const extracted = extractCodexModelConfig(parsedConfig);
  if (!extracted.ok) return extracted;

  const authPath = join(sourceHome, "auth.json");
  let hasFileLogin = false;
  try {
    hasFileLogin = statSync(authPath).isFile();
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      return {
        ok: false,
        message:
          "Opensteer could not read your Codex auth.json to share your sign-in for tasks a connected agent or chat started.",
      };
    }
  }
  if (!hasFileLogin) {
    return {
      ok: false,
      message:
        extracted.storeMode === "auto"
          ? 'Codex has no auth.json file in your Codex home (your sign-in may be in your system keyring). Set cli_auth_credentials_store = "file" in your Codex config.toml and run codex login again to allow Codex on tasks a connected agent or chat started.'
          : 'Codex has no file login (auth.json) in your Codex home, so Opensteer cannot share your sign-in into a separate Codex home for tasks a connected agent or chat started. Sign in with codex login (with cli_auth_credentials_store = "file") to allow Codex on those tasks.',
    };
  }
  return {
    ok: true,
    mode: "ambient",
    authPath,
    configTomlText: serializeCodexOthersConfigToml(extracted.modelConfig),
    sourceHome,
  };
}

interface CodexModelConfig {
  readonly model_provider?: string;
  readonly openai_base_url?: string;
  readonly chatgpt_base_url?: string;
  readonly forced_chatgpt_workspace_id?: string | readonly string[];
  readonly forced_login_method?: string;
  readonly oss_provider?: string;
  readonly model_providers: Readonly<Record<string, Readonly<Record<string, TomlValue>>>>;
}

type TomlPrimitive = string | number | boolean;
type TomlValue = TomlPrimitive | readonly TomlValue[] | { readonly [key: string]: TomlValue };

const safeProviderStringKeys = [
  "name",
  "base_url",
  "model_catalog_url",
  "env_key",
  "env_key_instructions",
  "experimental_bearer_token",
  "wire_api",
] as const;

const safeProviderBooleanKeys = [
  "requires_openai_auth",
  "supports_websockets",
  "supports_standalone_web_search",
] as const;

const safeProviderNumberKeys = [
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "websocket_connect_timeout_ms",
] as const;

const safeProviderStringMapKeys = ["query_params", "http_headers", "env_http_headers"] as const;

function providerUsesCommandAuth(provider: Record<string, unknown>): boolean {
  if (provider.auth !== undefined) return true;
  if (isRecord(provider.aws)) {
    if (provider.aws.credential_export !== undefined || provider.aws.auth_refresh !== undefined) {
      return true;
    }
  }
  return false;
}

function sanitizeSafeTomlObject(value: unknown): Record<string, TomlValue> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, TomlValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number") {
      if (typeof entry === "number" && !Number.isFinite(entry)) continue;
      out[key] = entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      out[key] = [...entry];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Extracts ONLY the settings Codex needs to reach and sign in to its model
 * provider. Every personal rule, hook, notify command, instruction, agent,
 * project trust entry, MCP server, skill, feature or sandbox setting is left out.
 */
export function extractCodexModelConfig(parsed: Record<string, unknown>):
  | {
      readonly ok: true;
      readonly storeMode: "file" | "auto";
      readonly modelConfig: CodexModelConfig;
    }
  | { readonly ok: false; readonly message: string } {
  const rawStore = parsed.cli_auth_credentials_store;
  let storeMode: "file" | "auto" = "file";
  if (rawStore !== undefined) {
    if (rawStore === "file" || rawStore === "auto") {
      storeMode = rawStore;
    } else if (rawStore === "keyring") {
      return {
        ok: false,
        message:
          'Codex stores your sign-in in your system keyring, which Opensteer cannot share into a separate Codex home for tasks a connected agent or chat started. Set cli_auth_credentials_store = "file" in your Codex config.toml and run codex login again to allow Codex on those tasks.',
      };
    } else {
      return {
        ok: false,
        message:
          'Codex is not configured to store its sign-in in a file, so Opensteer cannot share it into a separate Codex home for tasks a connected agent or chat started. Set cli_auth_credentials_store = "file" in your Codex config.toml and run codex login again to allow Codex on those tasks.',
      };
    }
  }

  const profileTable =
    typeof parsed.profile === "string" &&
    isRecord(parsed.profiles) &&
    isRecord(parsed.profiles[parsed.profile])
      ? (parsed.profiles[parsed.profile] as Record<string, unknown>)
      : undefined;

  const stringFromProfileOrTop = (key: string): string | undefined => {
    const fromProfile = profileTable?.[key];
    if (typeof fromProfile === "string") return fromProfile;
    const fromTop = parsed[key];
    return typeof fromTop === "string" ? fromTop : undefined;
  };

  const model_provider = stringFromProfileOrTop("model_provider");
  const openai_base_url = stringFromProfileOrTop("openai_base_url");
  const chatgpt_base_url = stringFromProfileOrTop("chatgpt_base_url");
  const oss_provider = stringFromProfileOrTop("oss_provider");
  const forced_login_method =
    typeof parsed.forced_login_method === "string" ? parsed.forced_login_method : undefined;
  const rawWorkspace = parsed.forced_chatgpt_workspace_id;
  const forced_chatgpt_workspace_id =
    typeof rawWorkspace === "string"
      ? rawWorkspace
      : Array.isArray(rawWorkspace) && rawWorkspace.every((entry) => typeof entry === "string")
        ? ([...rawWorkspace] as string[])
        : undefined;

  const activeProviderId = model_provider ?? "openai";
  const model_providers: Record<string, Record<string, TomlValue>> = {};
  if (isRecord(parsed.model_providers)) {
    for (const [providerId, rawProvider] of Object.entries(parsed.model_providers)) {
      if (!isRecord(rawProvider)) continue;
      if (providerUsesCommandAuth(rawProvider)) {
        if (providerId === activeProviderId) {
          return {
            ok: false,
            message:
              "Your Codex model provider runs a local command to sign in, which Opensteer does not run for tasks a connected agent or chat started.",
          };
        }
        continue;
      }
      const clean: Record<string, TomlValue> = {};
      for (const key of safeProviderStringKeys) {
        if (typeof rawProvider[key] === "string") clean[key] = rawProvider[key];
      }
      for (const key of safeProviderBooleanKeys) {
        if (typeof rawProvider[key] === "boolean") clean[key] = rawProvider[key];
      }
      for (const key of safeProviderNumberKeys) {
        const value = rawProvider[key];
        if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
      }
      for (const key of safeProviderStringMapKeys) {
        const map = sanitizeStringMap(rawProvider[key]);
        if (map) clean[key] = map;
      }
      const capabilities = sanitizeSafeTomlObject(rawProvider.capabilities);
      if (capabilities) clean.capabilities = capabilities;
      if (isRecord(rawProvider.aws)) {
        const aws: Record<string, string> = {};
        if (typeof rawProvider.aws.profile === "string") aws.profile = rawProvider.aws.profile;
        if (typeof rawProvider.aws.region === "string") aws.region = rawProvider.aws.region;
        if (Object.keys(aws).length > 0) clean.aws = aws;
      }
      if (Object.keys(clean).length > 0) model_providers[providerId] = clean;
    }
  }

  return {
    ok: true,
    storeMode,
    modelConfig: {
      ...(model_provider !== undefined ? { model_provider } : {}),
      ...(openai_base_url !== undefined ? { openai_base_url } : {}),
      ...(chatgpt_base_url !== undefined ? { chatgpt_base_url } : {}),
      ...(forced_chatgpt_workspace_id !== undefined ? { forced_chatgpt_workspace_id } : {}),
      ...(forced_login_method !== undefined ? { forced_login_method } : {}),
      ...(oss_provider !== undefined ? { oss_provider } : {}),
      model_providers,
    },
  };
}

const bareTomlKeyPattern = /^[A-Za-z0-9_-]+$/u;

function formatTomlKey(key: string): string {
  return bareTomlKeyPattern.test(key) ? key : JSON.stringify(key);
}

function formatTomlValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatTomlValue(item)).join(", ")}]`;
  }
  const entries = Object.entries(value).map(
    ([key, entry]) => `${formatTomlKey(key)} = ${formatTomlValue(entry)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

export function serializeCodexOthersConfigToml(config: CodexModelConfig): string {
  const lines: string[] = ['cli_auth_credentials_store = "file"'];
  if (config.model_provider !== undefined) {
    lines.push(`model_provider = ${JSON.stringify(config.model_provider)}`);
  }
  if (config.openai_base_url !== undefined) {
    lines.push(`openai_base_url = ${JSON.stringify(config.openai_base_url)}`);
  }
  if (config.chatgpt_base_url !== undefined) {
    lines.push(`chatgpt_base_url = ${JSON.stringify(config.chatgpt_base_url)}`);
  }
  if (config.forced_chatgpt_workspace_id !== undefined) {
    lines.push(
      `forced_chatgpt_workspace_id = ${formatTomlValue(config.forced_chatgpt_workspace_id)}`,
    );
  }
  if (config.forced_login_method !== undefined) {
    lines.push(`forced_login_method = ${JSON.stringify(config.forced_login_method)}`);
  }
  if (config.oss_provider !== undefined) {
    lines.push(`oss_provider = ${JSON.stringify(config.oss_provider)}`);
  }
  for (const [providerId, provider] of Object.entries(config.model_providers)) {
    lines.push("", `[model_providers.${formatTomlKey(providerId)}]`);
    for (const [key, value] of Object.entries(provider)) {
      lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Parses a Codex `config.toml` document into plain JS objects/arrays/scalars.
 * Supports TOML 1.0 syntax (tables, arrays of tables, dotted keys, basic/literal
 * single- and multi-line strings, arrays, inline tables, numbers, booleans,
 * comments, and RFC 3339 date/time literals as strings).
 */
export function parseCodexConfigToml(source: string): Record<string, unknown> {
  const input = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let index = 0;
  const length = input.length;

  function fail(message: string): never {
    throw new Error(`Invalid TOML at offset ${index}: ${message}`);
  }

  const skipSpaces = () => {
    while (index < length && (input[index] === " " || input[index] === "\t")) index += 1;
  };

  const skipComment = () => {
    if (input[index] === "#") {
      while (index < length && input[index] !== "\n") index += 1;
    }
  };

  const skipWhitespaceAndComments = () => {
    while (index < length) {
      const ch = input[index];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        index += 1;
      } else if (ch === "#") {
        skipComment();
      } else {
        break;
      }
    }
  };

  const skipLineEnd = () => {
    skipSpaces();
    skipComment();
    if (index >= length) return;
    if (input[index] === "\r") index += 1;
    if (input[index] === "\n") {
      index += 1;
      return;
    }
    fail(`Expected newline, found ${JSON.stringify(input[index])}`);
  };

  const parseHex = (digits: number): string => {
    const slice = input.slice(index, index + digits);
    if (slice.length !== digits || !/^[0-9a-fA-F]+$/u.test(slice)) {
      fail("Invalid unicode escape");
    }
    index += digits;
    return String.fromCodePoint(Number.parseInt(slice, 16));
  };

  const parseBasicString = (multiline: boolean): string => {
    index += multiline ? 3 : 1;
    if (multiline) {
      if (input[index] === "\r" && input[index + 1] === "\n") index += 2;
      else if (input[index] === "\n") index += 1;
    }
    let out = "";
    while (index < length) {
      if (multiline && input.startsWith('"""', index)) {
        // Up to two extra quotes before the closing delimiter belong to the string.
        let quotes = 0;
        while (input[index + quotes] === '"') quotes += 1;
        if (quotes <= 5) {
          out += '"'.repeat(quotes - 3);
          index += quotes;
          return out;
        }
        fail("Too many consecutive quotes in multiline basic string");
      }
      const ch = input[index]!;
      if (!multiline && ch === '"') {
        index += 1;
        return out;
      }
      if (!multiline && (ch === "\n" || ch === "\r")) {
        fail("Unterminated basic string");
      }
      if (ch === "\\") {
        index += 1;
        if (index >= length) fail("Unterminated escape sequence");
        const esc = input[index]!;
        if (multiline && (esc === " " || esc === "\t" || esc === "\r" || esc === "\n")) {
          while (index < length && (input[index] === " " || input[index] === "\t")) index += 1;
          if (input[index] === "\r") index += 1;
          if (input[index] !== "\n") fail("Invalid line-ending backslash escape");
          while (
            index < length &&
            (input[index] === " " ||
              input[index] === "\t" ||
              input[index] === "\r" ||
              input[index] === "\n")
          ) {
            index += 1;
          }
          continue;
        }
        index += 1;
        switch (esc) {
          case "b":
            out += "\b";
            break;
          case "t":
            out += "\t";
            break;
          case "n":
            out += "\n";
            break;
          case "f":
            out += "\f";
            break;
          case "r":
            out += "\r";
            break;
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "u":
            out += parseHex(4);
            break;
          case "U":
            out += parseHex(8);
            break;
          default:
            fail(`Unsupported escape \\${esc}`);
        }
        continue;
      }
      out += ch;
      index += 1;
    }
    fail("Unterminated basic string");
  };

  const parseLiteralString = (multiline: boolean): string => {
    index += multiline ? 3 : 1;
    if (multiline) {
      if (input[index] === "\r" && input[index + 1] === "\n") index += 2;
      else if (input[index] === "\n") index += 1;
    }
    let out = "";
    while (index < length) {
      if (multiline && input.startsWith("'''", index)) {
        let quotes = 0;
        while (input[index + quotes] === "'") quotes += 1;
        if (quotes <= 5) {
          out += "'".repeat(quotes - 3);
          index += quotes;
          return out;
        }
        fail("Too many consecutive quotes in multiline literal string");
      }
      const ch = input[index]!;
      if (!multiline && ch === "'") {
        index += 1;
        return out;
      }
      if (!multiline && (ch === "\n" || ch === "\r")) {
        fail("Unterminated literal string");
      }
      out += ch;
      index += 1;
    }
    fail("Unterminated literal string");
  };

  const parseKeySegment = (): string => {
    skipSpaces();
    if (index >= length) fail("Expected key");
    if (input[index] === '"') return parseBasicString(false);
    if (input[index] === "'") return parseLiteralString(false);
    const start = index;
    while (index < length && /[A-Za-z0-9_-]/u.test(input[index]!)) index += 1;
    if (index === start) fail(`Expected key, found ${JSON.stringify(input[index])}`);
    return input.slice(start, index);
  };

  const parseKeyPath = (): string[] => {
    const path = [parseKeySegment()];
    while (true) {
      skipSpaces();
      if (input[index] !== ".") break;
      index += 1;
      path.push(parseKeySegment());
    }
    return path;
  };

  const parseValue = (): unknown => {
    skipSpaces();
    if (index >= length) fail("Expected value");
    if (input.startsWith('"""', index)) return parseBasicString(true);
    if (input[index] === '"') return parseBasicString(false);
    if (input.startsWith("'''", index)) return parseLiteralString(true);
    if (input[index] === "'") return parseLiteralString(false);
    if (input[index] === "[") return parseArray();
    if (input[index] === "{") return parseInlineTable();

    const start = index;
    while (index < length && !/[\s,#\]}]/u.test(input[index]!)) {
      index += 1;
    }
    // RFC 3339 date-times may contain a single space separating date and time.
    const raw = input.slice(start, index);
    if (!raw) fail("Expected value");
    if (
      /^\d{4}-\d{2}-\d{2}$/u.test(raw) &&
      input[index] === " " &&
      /^\d{2}:\d{2}/u.test(input.slice(index + 1))
    ) {
      index += 1;
      while (index < length && !/[\s,#\]}]/u.test(input[index]!)) index += 1;
      return input.slice(start, index);
    }
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (
      /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/u.test(
        raw,
      ) ||
      /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.test(raw)
    ) {
      return raw;
    }
    const cleanNum = raw.replaceAll("_", "");
    if (/^[+-]?(?:0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/u.test(cleanNum)) {
      return Number(cleanNum);
    }
    if (/^[+-]?(?:inf|nan)$/u.test(cleanNum)) {
      if (cleanNum.endsWith("nan")) return Number.NaN;
      return cleanNum.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(cleanNum)) {
      const value = Number(cleanNum);
      if (!Number.isNaN(value)) return value;
    }
    fail(`Unexpected token ${JSON.stringify(raw)}`);
  };

  const parseArray = (): unknown[] => {
    index += 1; // '['
    const items: unknown[] = [];
    while (true) {
      skipWhitespaceAndComments();
      if (index >= length) fail("Unterminated array");
      if (input[index] === "]") {
        index += 1;
        return items;
      }
      items.push(parseValue());
      skipWhitespaceAndComments();
      if (input[index] === ",") {
        index += 1;
        continue;
      }
      if (input[index] === "]") {
        index += 1;
        return items;
      }
      fail(`Expected ',' or ']' in array, found ${JSON.stringify(input[index])}`);
    }
  };

  const assignPath = (target: Record<string, unknown>, path: readonly string[], value: unknown) => {
    let cursor = target;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i]!;
      const existing = cursor[segment];
      if (existing === undefined) {
        const created: Record<string, unknown> = {};
        cursor[segment] = created;
        cursor = created;
      } else if (isRecord(existing)) {
        cursor = existing;
      } else {
        fail(`Key conflict at ${segment}`);
      }
    }
    cursor[path.at(-1)!] = value;
  };

  const parseInlineTable = (): Record<string, unknown> => {
    index += 1; // '{'
    const table: Record<string, unknown> = {};
    skipWhitespaceAndComments();
    if (input[index] === "}") {
      index += 1;
      return table;
    }
    while (true) {
      skipWhitespaceAndComments();
      const path = parseKeyPath();
      skipSpaces();
      if (input[index] !== "=") fail("Expected '=' in inline table");
      index += 1;
      const value = parseValue();
      assignPath(table, path, value);
      skipWhitespaceAndComments();
      if (input[index] === ",") {
        index += 1;
        skipWhitespaceAndComments();
        if (input[index] === "}") {
          index += 1;
          return table;
        }
        continue;
      }
      if (input[index] === "}") {
        index += 1;
        return table;
      }
      fail(`Expected ',' or '}' in inline table, found ${JSON.stringify(input[index])}`);
    }
  };

  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;

  const navigateTable = (path: readonly string[], isArray: boolean): Record<string, unknown> => {
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i]!;
      const existing = cursor[segment];
      if (existing === undefined) {
        const created: Record<string, unknown> = {};
        cursor[segment] = created;
        cursor = created;
      } else if (Array.isArray(existing) && existing.length > 0 && isRecord(existing.at(-1))) {
        cursor = existing.at(-1) as Record<string, unknown>;
      } else if (isRecord(existing)) {
        cursor = existing;
      } else {
        fail(`Table conflict at ${segment}`);
      }
    }
    const leaf = path.at(-1)!;
    const existing = cursor[leaf];
    if (isArray) {
      const entry: Record<string, unknown> = {};
      if (existing === undefined) {
        cursor[leaf] = [entry];
      } else if (Array.isArray(existing)) {
        existing.push(entry);
      } else {
        fail(`Array-of-tables conflict at ${leaf}`);
      }
      return entry;
    }
    if (existing === undefined) {
      const created: Record<string, unknown> = {};
      cursor[leaf] = created;
      return created;
    }
    if (isRecord(existing)) return existing;
    fail(`Table conflict at ${leaf}`);
  };

  while (true) {
    skipWhitespaceAndComments();
    if (index >= length) break;
    if (input[index] === "[") {
      const isArray = input[index + 1] === "[";
      index += isArray ? 2 : 1;
      const path = parseKeyPath();
      skipSpaces();
      if (isArray) {
        if (!input.startsWith("]]", index)) fail("Expected ']]'");
        index += 2;
      } else {
        if (input[index] !== "]") fail("Expected ']'");
        index += 1;
      }
      skipLineEnd();
      current = navigateTable(path, isArray);
      continue;
    }
    const path = parseKeyPath();
    skipSpaces();
    if (input[index] !== "=") fail("Expected '='");
    index += 1;
    const value = parseValue();
    skipLineEnd();
    assignPath(current, path, value);
  }

  return root;
}
