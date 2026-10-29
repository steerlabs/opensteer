import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isLoopbackHostname, OpensteerError } from "@opensteer/core";
import type { ModelServer, ModelServerRuntime } from "@opensteer/protocol";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { isRecord } from "@opensteer/shared/isRecord";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";
import { z } from "zod";
import {
  CompatibleEndpointHttpError,
  CompatibleEndpointTimeoutError,
  compatibleEndpointBaseUrlSchema,
  compatibleEndpointFailureDetail,
  compatibleEndpointHost,
  discoverCompatibleEndpointModels,
} from "./compatible-endpoint.js";
import type { HarnessSetupMethod } from "./types.js";

/*
 * Model servers are found where they say they are. Each server app keeps its
 * own settings on the computer it runs on; the Runner is on that computer, so
 * it reads them instead of anyone guessing a port. A server is named by what
 * it answers, never by the port alone: a port proves nothing about who is
 * listening on it. Discovery only ever contacts 127.0.0.1 — a server's
 * network addresses are for other computers, and reaching them would be local
 * network traffic nobody asked for.
 */

export interface ModelServerProbeOptions {
  readonly signal: AbortSignal;
  /** Where the server apps keep their settings: the Runner's own home. */
  readonly home?: string;
  /** Where oMLX looks first for its settings, as oMLX itself reads it. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

type LocalRuntime = Exclude<ModelServerRuntime, "generic">;

/** How each server answers a question only it answers, without a key. */
const identities: Record<
  LocalRuntime,
  { readonly path: string; readonly matches: (status: number, body: unknown) => boolean }
> = {
  // oMLX answers 503 while pinned models load; it is still oMLX.
  omlx: {
    path: "/health",
    matches: (status, body) =>
      (status === 200 || status === 503) && isRecord(body) && isRecord(body.engine_pool),
  },
  ollama: {
    path: "/api/version",
    matches: (status, body) => status === 200 && isRecord(body) && typeof body.version === "string",
  },
  lmstudio: {
    path: "/lmstudio-greeting",
    matches: (status, body) => status === 200 && isRecord(body) && body.lmstudio === true,
  },
};
const localRuntimes = ["omlx", "ollama", "lmstudio"] as const satisfies readonly LocalRuntime[];

const runtimeLabels: Record<ModelServerRuntime, string> = {
  generic: "The server",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  omlx: "oMLX",
};

const identityTimeoutMs = 1_500;
const modelListTimeoutMs = 5_000;
const settingsMaximumBytes = 256 * 1_024;
const ollamaPort = 11_434;
const lmStudioDefaultPort = 1_234;
const omlxDefaultPort = 8_000;

type Probe =
  | { readonly kind: "answered"; readonly status: number; readonly body: unknown }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Where a server's own paths start: the base URL without the `/v1` (or
 * `/api/v1`) its OpenAI API lives under, keeping any prefix a gateway put in
 * front of both — the same root the catalog reads a known server's API from.
 */
function serverRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/u, "").replace(/\/(?:api\/)?v1$/u, "")}`;
}

/** Keeps a sentence within what one server's detail may carry on the wire. */
function detailOf(text: string): string {
  return text.slice(0, 500);
}

async function probe(root: string, path: string, options: ModelServerProbeOptions): Promise<Probe> {
  const deadline = AbortSignal.timeout(identityTimeoutMs);
  const signal = AbortSignal.any([options.signal, deadline]);
  try {
    const response = await (options.fetch ?? fetch)(new URL(`${root}${path}`), {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal,
    });
    const body = await readBoundedJson(response, {
      emptyValue: undefined,
      fatalUtf8: false,
      maximumBytes: 64 * 1_024,
      signal,
    }).catch(() => undefined);
    return { body, kind: "answered", status: response.status };
  } catch (error) {
    if (options.signal.aborted) throw error;
    return {
      error: deadline.aborted ? new CompatibleEndpointTimeoutError(identityTimeoutMs) : error,
      kind: "failed",
    };
  }
}

function refused(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    const code = nodeErrorCode(cause);
    if (code === "ECONNREFUSED") return true;
    if (cause instanceof AggregateError && cause.errors.some(refused)) return true;
  }
  return false;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true;
}

/** A small settings file, or nothing: an unreadable one tells us nothing. */
async function readSettings(path: string): Promise<unknown> {
  const unreadable = () => new Error("Settings file is unreadable");
  try {
    const bytes = await readBoundedRegularFile(path, settingsMaximumBytes, {
      changedError: unreadable,
      invalidFileError: unreadable,
      missing: "null",
      sizeError: unreadable,
    });
    return bytes === null ? undefined : (JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
}

async function readPointer(path: string): Promise<string | undefined> {
  const unreadable = () => new Error("Pointer file is unreadable");
  try {
    const bytes = await readBoundedRegularFile(path, 4_096, {
      changedError: unreadable,
      invalidFileError: unreadable,
      missing: "null",
      sizeError: unreadable,
    });
    const value = bytes?.toString("utf8").trim();
    return value && isAbsolute(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const OmlxSettingsSchema = z.object({
  auth: z
    .object({
      api_key: z.string().optional(),
      skip_api_key_verification: z.boolean().optional(),
      sub_keys: z.array(z.object({ key: z.string() })).optional(),
    })
    .optional(),
  server: z.object({ port: z.number().int().min(1).max(65_535).optional() }).optional(),
});

interface OmlxSettings {
  readonly port: number;
  /** What oMLX requires on its API, if anything. */
  readonly key: string | undefined;
}

/**
 * oMLX's settings, from the folder oMLX itself uses: `OMLX_BASE_PATH`, else
 * the app's base-path pointer, else `~/.omlx`. Its API accepts a sub key as
 * well as the main key, and the main key is also its admin login, so a sub key
 * is what an account gets when one exists.
 */
async function omlxSettings(options: ModelServerProbeOptions): Promise<OmlxSettings | null> {
  const home = options.home ?? homedir();
  const configured = (options.environment ?? process.env).OMLX_BASE_PATH?.trim();
  const base =
    (configured && isAbsolute(configured) ? configured : undefined) ??
    (await readPointer(join(home, "Library", "Application Support", "oMLX", "base-path"))) ??
    join(home, ".omlx");
  const settings = OmlxSettingsSchema.safeParse(await readSettings(join(base, "settings.json")));
  if (!settings.success) return null;
  const auth = settings.data.auth;
  const key = auth?.skip_api_key_verification
    ? undefined
    : auth?.sub_keys?.map(({ key: subKey }) => subKey.trim()).find(Boolean) ||
      auth?.api_key?.trim() ||
      undefined;
  return { key, port: settings.data.server?.port ?? omlxDefaultPort };
}

/** LM Studio's home, resolved as LM Studio's own tools resolve it. */
async function lmStudioPort(home: string): Promise<number | null> {
  const pointer = await readPointer(join(home, ".lmstudio-home-pointer"));
  const candidates = pointer
    ? [pointer]
    : [join(home, ".cache", "lm-studio"), join(home, ".lmstudio")];
  for (const candidate of candidates) {
    if (!(await isDirectory(candidate))) continue;
    const config = await readSettings(join(candidate, ".internal", "http-server-config.json"));
    const port = z
      .number()
      .int()
      .min(1)
      .max(65_535)
      .safeParse(isRecord(config) ? config.port : 0);
    return port.success ? port.data : lmStudioDefaultPort;
  }
  return null;
}

function localBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

/**
 * What a server's model list says about it: every model it serves, how many
 * of them could run a Thread, or why it could not be read. The list is read
 * without a key: finding servers is something the Runner does on its own, and
 * nothing it does on its own sends a credential — only a person's Connect
 * does, through the `local-import` sign-in.
 */
async function withModels(
  runtime: ModelServerRuntime,
  baseUrl: string,
  options: ModelServerProbeOptions,
): Promise<ModelServer> {
  const host = compatibleEndpointHost(baseUrl);
  try {
    const models = await discoverCompatibleEndpointModels(
      { baseUrl, modelIdentity: "canonical", models: {}, runtime },
      { kind: "none" },
      {
        ...(options.fetch ? { fetchModels: options.fetch } : {}),
        signal: options.signal,
        timeoutMs: modelListTimeoutMs,
      },
    );
    const runnable = models.filter((model) => !model.unavailableReason);
    return {
      baseUrl,
      models: models.length,
      runnableModels: runnable.length,
      runtime,
      status: "ready",
      ...(runnable.length > 0
        ? {}
        : {
            detail: detailOf(
              models[0]?.unavailableReason ?? `${runtimeLabels[runtime]} has no chat models yet`,
            ),
          }),
    };
  } catch (error) {
    if (options.signal.aborted) throw error;
    if (
      error instanceof CompatibleEndpointHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      return { baseUrl, runtime, status: "needs-key" };
    }
    return {
      baseUrl,
      detail: detailOf(compatibleEndpointFailureDetail(host, error)),
      runtime,
      status: "unavailable",
    };
  }
}

/**
 * oMLX whose own settings hold the key it requires: its list is behind that
 * key, so what it is and how many models it has come from its `/health`, and
 * Connect copies the key in with the person's click.
 */
function omlxWithSettingsKey(baseUrl: string, health: unknown): ModelServer {
  const pool = isRecord(health) && isRecord(health.engine_pool) ? health.engine_pool : {};
  const count = z.number().int().nonnegative().max(8_192).safeParse(pool.model_count);
  return {
    baseUrl,
    ...(count.success ? { models: count.data } : {}),
    runtime: "omlx",
    status: "ready",
  };
}

async function localModelServer(
  runtime: LocalRuntime,
  port: number,
  settingsHoldKey: boolean,
  options: ModelServerProbeOptions,
): Promise<ModelServer> {
  const baseUrl = localBaseUrl(port);
  const empty = { baseUrl, runtime } as const;
  const answer = await probe(serverRoot(baseUrl), identities[runtime].path, options);
  if (answer.kind === "failed") {
    return refused(answer.error)
      ? { ...empty, status: "not-running" }
      : {
          ...empty,
          detail: detailOf(compatibleEndpointFailureDetail(`127.0.0.1:${port}`, answer.error)),
          status: "unavailable",
        };
  }
  if (!identities[runtime].matches(answer.status, answer.body)) {
    // LM Studio's greeting sits behind its API key when that is required;
    // the port came from LM Studio's own settings, so this is LM Studio.
    if (runtime === "lmstudio" && (answer.status === 401 || answer.status === 403)) {
      return { ...empty, status: "needs-key" };
    }
    return {
      ...empty,
      detail: `Another program is answering on port ${port}, where ${runtimeLabels[runtime]} is set to listen.`,
      status: "unavailable",
    };
  }
  return settingsHoldKey
    ? omlxWithSettingsKey(baseUrl, answer.body)
    : withModels(runtime, baseUrl, options);
}

/**
 * The model servers installed on this computer: every one whose app has its
 * settings here, whether or not it is running now.
 */
export async function discoverModelServers(
  options: ModelServerProbeOptions,
): Promise<readonly ModelServer[]> {
  const home = options.home ?? homedir();
  const [omlx, ollama, lmStudio] = await Promise.all([
    omlxSettings(options),
    isDirectory(join(home, ".ollama")),
    lmStudioPort(home),
  ]);
  return Promise.all([
    ...(omlx ? [localModelServer("omlx", omlx.port, omlx.key !== undefined, options)] : []),
    ...(ollama ? [localModelServer("ollama", ollamaPort, false, options)] : []),
    ...(lmStudio === null ? [] : [localModelServer("lmstudio", lmStudio, false, options)]),
  ]);
}

/**
 * What the server at an address the person typed is. The one server whose
 * own question it answers names it; a server that answers none of them is a
 * `generic` OpenAI-compatible server, read through its `/models` list.
 */
export async function identifyModelServer(
  address: string,
  options: ModelServerProbeOptions,
): Promise<ModelServer> {
  const baseUrl = compatibleEndpointBaseUrlSchema.parse(address);
  const root = serverRoot(baseUrl);
  const answers = await Promise.all(
    localRuntimes.map(async (runtime) => ({
      answer: await probe(root, identities[runtime].path, options),
      runtime,
    })),
  );
  const identified = answers.find(
    ({ answer, runtime: candidate }) =>
      answer.kind === "answered" && identities[candidate].matches(answer.status, answer.body),
  );
  const runtime = identified?.runtime ?? "generic";
  if (
    runtime === "omlx" &&
    identified?.answer.kind === "answered" &&
    (await omlxSettingsFor(new URL(baseUrl), options))?.key !== undefined
  ) {
    return omlxWithSettingsKey(baseUrl, identified.answer.body);
  }
  return withModels(runtime, baseUrl, options);
}

function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** oMLX's settings, when `url` is the oMLX they describe: this computer, on their port. */
async function omlxSettingsFor(
  url: URL,
  options: ModelServerProbeOptions,
): Promise<OmlxSettings | null> {
  if (!isLoopbackHostname(url.hostname)) return null;
  const settings = await omlxSettings(options);
  return settings?.port === portOf(url) ? settings : null;
}

/**
 * The key a server on this computer keeps in its own settings, for the
 * endpoint an account names — only oMLX keeps one. It is offered only to the
 * port oMLX's settings name, on this computer, and only after the server
 * there answers as oMLX.
 */
export async function modelServerSettingsKey(
  endpoint: { readonly baseUrl?: string | undefined; readonly runtime: ModelServerRuntime },
  options: ModelServerProbeOptions,
): Promise<string | undefined> {
  if (endpoint.runtime !== "omlx" || endpoint.baseUrl === undefined) return undefined;
  const settings = await omlxSettingsFor(new URL(endpoint.baseUrl), options);
  if (settings?.key === undefined) return undefined;
  const answer = await probe(serverRoot(endpoint.baseUrl), identities.omlx.path, options);
  return answer.kind === "answered" && identities.omlx.matches(answer.status, answer.body)
    ? settings.key
    : undefined;
}

export const modelServerSettingsMethodId = "model-server-settings";

/**
 * The sign-in that copies a key the server's own settings hold into the
 * account, with one click. The copy is the account's own from then on, like a
 * pasted key; if the server's key changes, the account says the key was
 * refused and offers this again.
 */
export function modelServerSettingsMethod(runtime: ModelServerRuntime): HarnessSetupMethod {
  return {
    connectionSlot: "primary",
    detail: `Opensteer reads it from ${runtimeLabels[runtime]}'s settings on this computer.`,
    kind: "local-import",
    label: `Use ${runtimeLabels[runtime]}'s key`,
    methodId: modelServerSettingsMethodId,
  };
}

/**
 * Stores the key a server keeps in its own settings once the server accepts
 * it, so "ready" means the server said yes, not only that a file was written.
 */
export async function importModelServerSettingsKey(
  endpoint: {
    readonly baseUrl?: string | undefined;
    readonly modelIdentity: "legacy" | "canonical";
    readonly runtime: ModelServerRuntime;
  },
  store: (key: string) => Promise<void>,
  options: ModelServerProbeOptions,
): Promise<void> {
  const label = runtimeLabels[endpoint.runtime];
  const key = await modelServerSettingsKey(endpoint, options);
  if (key === undefined) {
    throw new OpensteerError({
      code: "conflict",
      message: `${label} on this computer no longer holds a key for this address. Open ${label} and try again.`,
    });
  }
  try {
    await discoverCompatibleEndpointModels(
      { ...endpoint, models: {} },
      { apiKey: key, kind: "api-key" },
      {
        ...(options.fetch ? { fetchModels: options.fetch } : {}),
        signal: options.signal,
        timeoutMs: modelListTimeoutMs,
      },
    );
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new OpensteerError({
      code: "conflict",
      message:
        error instanceof CompatibleEndpointHttpError &&
        (error.status === 401 || error.status === 403)
          ? `${label} refused the key in its own settings.`
          : compatibleEndpointFailureDetail(compatibleEndpointHost(endpoint.baseUrl ?? ""), error),
    });
  }
  await store(key);
}
