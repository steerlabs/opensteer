import { parseHttpEndpointBaseUrl } from "@opensteer/shared/httpEndpoint";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import {
  canonicalModelReference,
  modelDisplayName,
  ModelIdSchema,
  ModelProviderIdSchema,
} from "@opensteer/core";
import {
  HarnessModelSettingsMapSchema,
  maxHarnessModelsPerCatalog,
  ModelServerRuntimeSchema,
} from "@opensteer/protocol";
import { z } from "zod";
import type { HarnessModelDescriptor } from "./types.js";

const positiveTokenCount = z.number().int().positive().max(10_000_000);

/** A base URL is joined with API paths; URL credentials and suffixes cannot survive that join. */
export const compatibleEndpointBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) => parseHttpEndpointBaseUrl(value) !== null,
    "Enter an HTTP or HTTPS base URL without credentials, query, or fragment",
  );

export const CompatibleEndpointConfigSchema = z.strictObject({
  baseUrl: compatibleEndpointBaseUrlSchema.optional(),
  runtime: ModelServerRuntimeSchema.default("generic"),
  models: HarnessModelSettingsMapSchema.default({}),
  modelIdentity: z.enum(["legacy", "canonical"]).default("canonical"),
});
export type CompatibleEndpointConfig = z.infer<typeof CompatibleEndpointConfigSchema>;
export const CompatibleEndpointAuthSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("api-key"), apiKey: z.string().min(1) }),
]);
export type CompatibleEndpointAuth = z.infer<typeof CompatibleEndpointAuthSchema>;

/** What the person recognises the endpoint by — "openrouter.ai", "localhost:11434". */
export function compatibleEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Retained for existing accounts; new discovery uses a stable `custom` fallback. */
export function compatibleModelHint(baseUrl: string, sourceId: string): string {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return sourceId;
  }
  return ModelProviderIdSchema.safeParse(hostname).success ? hostname : sourceId;
}

type EndpointModelEntry = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly acceptsImages?: boolean | undefined;
  readonly unavailableReason?: string | undefined;
  readonly needsContextWindow?: boolean | undefined;
};

/** Keep the native id while grouping known model spellings under their lab. */
export function compatibleModelDescriptors(
  entries: readonly EndpointModelEntry[],
  hint: string,
  identityMode: "legacy" | "canonical" = "canonical",
): readonly HarnessModelDescriptor[] {
  const indexes = new Map<string, number>();
  const descriptors: HarnessModelDescriptor[] = [];
  for (const entry of entries) {
    const id = entry.id.trim();
    if (id.length > 255) continue;
    const historicalReference = canonicalModelReference(id, hint);
    // The wider family rule belongs only to new compatible accounts; old pairs stay stable.
    const versionFamily =
      identityMode === "canonical" && historicalReference.providerId === hint && !id.includes("/")
        ? /^(?:qwen|qwq)\d/iu.test(id)
          ? "qwen"
          : /^(?:llama|muse)\d/iu.test(id)
            ? "meta"
            : /^(?:gemini|gemma)\d/iu.test(id)
              ? "google"
              : undefined
        : undefined;
    const reference = versionFamily
      ? { ...historicalReference, providerId: versionFamily }
      : historicalReference;
    const modelId = ModelIdSchema.safeParse(reference.modelId);
    const providerId = ModelProviderIdSchema.safeParse(reference.providerId);
    if (!id || !modelId.success || !providerId.success) continue;
    const key = JSON.stringify([providerId.data, modelId.data]);
    const previousIndex = indexes.get(key);
    if (previousIndex !== undefined && !descriptors[previousIndex]?.unavailableReason) continue;
    if (previousIndex !== undefined && entry.unavailableReason) continue;
    const descriptor: HarnessModelDescriptor = {
      displayName: (entry.name?.trim() || modelDisplayName(reference.modelId)).slice(0, 120),
      isDefault: false,
      modelId: modelId.data,
      nativeModelId: id,
      options: [],
      providerId: providerId.data,
      ...(entry.description ? { description: entry.description.slice(0, 500) } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      ...(entry.acceptsImages !== undefined ? { acceptsImages: entry.acceptsImages } : {}),
      ...(entry.unavailableReason
        ? { unavailableReason: entry.unavailableReason.slice(0, 500) }
        : {}),
      ...(entry.unavailableReason && entry.needsContextWindow
        ? { needsContextWindow: true as const }
        : {}),
    };
    if (previousIndex === undefined) {
      indexes.set(key, descriptors.length);
      descriptors.push(descriptor);
    } else {
      descriptors[previousIndex] = descriptor;
    }
  }
  const firstRunnable = descriptors.findIndex((descriptor) => !descriptor.unavailableReason);
  return descriptors.map((descriptor, index) =>
    index === firstRunnable ? { ...descriptor, isDefault: true } : descriptor,
  );
}

const responseLimit = 2 * 1024 * 1024;
const requestTimeoutMs = 6_000;
const maxModels = maxHarnessModelsPerCatalog;
const object = z.record(z.string(), z.unknown());

export class CompatibleEndpointHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Endpoint returned HTTP ${status}`);
    this.name = "CompatibleEndpointHttpError";
    this.status = status;
  }
}

/** The endpoint answered, but not with something discovery can use. */
export class CompatibleEndpointResponseError extends Error {
  readonly reason: "not-a-model-list" | "too-large" | "too-many-models";
  readonly modelCount: number | undefined;

  constructor(
    reason: CompatibleEndpointResponseError["reason"],
    message: string,
    modelCount?: number,
  ) {
    super(message);
    this.name = "CompatibleEndpointResponseError";
    this.reason = reason;
    this.modelCount = modelCount;
  }
}

/** Discovery's own deadline passed; a caller's cancellation stays an abort. */
export class CompatibleEndpointTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Endpoint did not answer within ${timeoutMs} ms`);
    this.name = "CompatibleEndpointTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function notAModelList(field: "data" | "models"): CompatibleEndpointResponseError {
  return new CompatibleEndpointResponseError(
    "not-a-model-list",
    field === "data"
      ? "Endpoint response is not an OpenAI model list"
      : "Endpoint response is not a model list",
  );
}

function tooManyModels(count: number): CompatibleEndpointResponseError {
  return new CompatibleEndpointResponseError(
    "too-many-models",
    `${count} models exceeds the ${maxModels} model catalog limit`,
    count,
  );
}

function parseModelList(value: unknown, field: "data" | "models"): Record<string, unknown>[] {
  const response = object.safeParse(value);
  const rows = response.success ? response.data[field] : undefined;
  if (!Array.isArray(rows)) throw notAModelList(field);
  if (rows.length > maxModels) throw tooManyModels(rows.length);
  const parsed = z.array(object).safeParse(rows);
  if (!parsed.success) throw notAModelList(field);
  return parsed.data;
}

function errorCodes(error: unknown): readonly string[] {
  if (!(error instanceof Error)) return [];
  const own = "code" in error && typeof error.code === "string" ? [error.code] : [];
  const nested = error instanceof AggregateError ? error.errors.flatMap(errorCodes) : [];
  return [...own, ...nested, ...(error.cause === undefined ? [] : errorCodes(error.cause))];
}

/** One sentence a person can act on when an endpoint's model list cannot be read. */
export function compatibleEndpointFailureDetail(host: string, error: unknown): string {
  const notAList = `${host} answered, but not with a model list. Check the address and the server type.`;
  if (error instanceof CompatibleEndpointTimeoutError) {
    return `${host} didn't answer within ${Math.ceil(error.timeoutMs / 1_000)} seconds.`;
  }
  if (error instanceof CompatibleEndpointHttpError) {
    return error.status === 404 ? notAList : `${host} answered with HTTP ${error.status}.`;
  }
  if (error instanceof CompatibleEndpointResponseError) {
    if (error.reason === "too-large")
      return `${host} answered with a model list too large to read.`;
    if (error.reason === "too-many-models") {
      return `${host} lists ${error.modelCount} models, more than the ${maxModels} one account can hold.`;
    }
    return notAList;
  }
  const codes = errorCodes(error);
  if (codes.some((code) => code === "ECONNREFUSED" || code === "ECONNRESET")) {
    return `Nothing is answering at ${host}. Start the server, then try again.`;
  }
  if (codes.some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN")) {
    return `${host} can't be found from this computer.`;
  }
  // Node's fetch reports every network failure as "fetch failed"; the cause names it.
  let cause: unknown = error;
  while (cause instanceof Error && cause.message === "fetch failed" && cause.cause) {
    cause = cause.cause;
  }
  const message = cause instanceof Error ? cause.message.trim().slice(0, 200) : "";
  return message ? `${host} couldn't be reached: ${message}` : `${host} couldn't be reached.`;
}

export interface CompatibleEndpointDiscoveryOptions {
  readonly signal?: AbortSignal;
  readonly fetchModels?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * The one native model a session start needs. Runtimes that read each model
   * separately (Ollama's `/api/show`) skip the others; the rest return their
   * whole list, since it is a single request either way.
   */
  readonly nativeModelId?: string;
}

function boundedTimeout(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(Math.max(value, 1), 10_000)
    : requestTimeoutMs;
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveField(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return positiveTokenCount.safeParse(value).success ? (value as number) : undefined;
}

function lowestPositiveField(
  row: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  const values = keys.flatMap((key) => {
    const value = positiveField(row, key);
    return value === undefined ? [] : [value];
  });
  return values.length ? Math.min(...values) : undefined;
}

/**
 * The `num_ctx` a Modelfile sets is the context Ollama loads the model with
 * for OpenAI-compatible requests. Only an exact `num_ctx <integer>` line
 * counts; conflicting lines leave the context unknown rather than guessed.
 */
function ollamaModelfileContext(show: Record<string, unknown>): number | undefined {
  const parameters = show.parameters;
  if (typeof parameters !== "string") return undefined;
  const values = new Set<number>();
  for (const line of parameters.split(/\r?\n/u)) {
    const match = /^num_ctx\s+(\d{1,9})$/u.exec(line.trim());
    if (match) values.add(Number(match[1]));
  }
  if (values.size !== 1) return undefined;
  const [value] = values;
  return positiveTokenCount.safeParse(value).success ? value : undefined;
}

function stringArray(row: Record<string, unknown>, key: string): readonly string[] | undefined {
  const parsed = z.array(z.string()).safeParse(row[key]);
  return parsed.success ? parsed.data : undefined;
}

function APIUrl(baseUrl: string, runtime: CompatibleEndpointConfig["runtime"], path: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const prefix = runtime === "generic" ? basePath : basePath.replace(/\/(?:api\/)?v1$/u, "");
  url.pathname = `${prefix}${path}`;
  return url;
}

async function requestJSON(
  url: URL,
  auth: CompatibleEndpointAuth,
  options: CompatibleEndpointDiscoveryOptions & { readonly body?: Record<string, string> },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedTimeout(options.timeoutMs));
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const response = await (options.fetchModels ?? fetch)(url, {
      method: options.body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(auth.kind === "api-key" ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) throw new CompatibleEndpointHttpError(response.status);
    return readBoundedJson(response, {
      emptyError: () =>
        new CompatibleEndpointResponseError(
          "not-a-model-list",
          "Endpoint returned no response body",
        ),
      invalidJsonError: () =>
        new CompatibleEndpointResponseError("not-a-model-list", "Endpoint response is not JSON"),
      fatalUtf8: false,
      maximumBytes: responseLimit,
      signal: controller.signal,
      sizeError: () =>
        new CompatibleEndpointResponseError("too-large", "Endpoint response is too large"),
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function effectiveEntry(
  entry: EndpointModelEntry,
  config: CompatibleEndpointConfig,
): EndpointModelEntry {
  const override = Object.prototype.hasOwnProperty.call(config.models, entry.id)
    ? config.models[entry.id]
    : undefined;
  let unavailableReason = entry.unavailableReason;
  let contextWindow = entry.contextWindow;
  if (override) {
    if (contextWindow !== undefined && override.contextWindow > contextWindow) {
      unavailableReason ??= `Configured context ${override.contextWindow} exceeds the endpoint's served context ${contextWindow}`;
    }
    contextWindow =
      contextWindow === undefined
        ? override.contextWindow
        : Math.min(contextWindow, override.contextWindow);
  }
  const reportedMaxOutput = entry.maxOutputTokens;
  const configuredMaxOutput = override?.maxOutputTokens;
  if (
    configuredMaxOutput !== undefined &&
    reportedMaxOutput !== undefined &&
    configuredMaxOutput > reportedMaxOutput
  ) {
    unavailableReason ??= `Configured output ${configuredMaxOutput} exceeds the endpoint's output limit ${reportedMaxOutput}`;
  }
  let maxOutputTokens: number | undefined;
  // Clients offer a context setting only when nothing else blocks the model.
  const needsContextWindow = contextWindow === undefined && unavailableReason === undefined;
  if (contextWindow === undefined) {
    unavailableReason ??= "Effective context window is unknown";
    maxOutputTokens = configuredMaxOutput;
  } else {
    maxOutputTokens =
      configuredMaxOutput === undefined
        ? Math.min(reportedMaxOutput ?? 8_192, 8_192, Math.floor(contextWindow / 4))
        : Math.min(configuredMaxOutput, reportedMaxOutput ?? configuredMaxOutput);
    if (maxOutputTokens < 1 || maxOutputTokens + 256 >= contextWindow) {
      unavailableReason ??= "Model needs at least 256 context tokens beyond its maximum output";
    }
  }
  return {
    ...entry,
    contextWindow,
    maxOutputTokens,
    unavailableReason,
    needsContextWindow,
  };
}

async function genericModels(
  config: CompatibleEndpointConfig,
  auth: CompatibleEndpointAuth,
  options: CompatibleEndpointDiscoveryOptions,
): Promise<EndpointModelEntry[]> {
  const rows = parseModelList(
    await requestJSON(APIUrl(config.baseUrl!, "generic", "/models"), auth, options),
    "data",
  );
  if (
    rows.some((row) => {
      const id = stringField(row, "id");
      return !id || id.length > 255;
    })
  ) {
    throw notAModelList("data");
  }
  return rows.flatMap((row) => {
    const id = stringField(row, "id");
    if (!id) return [];
    const type = stringField(row, "type") ?? stringField(row, "model_type");
    if (
      type &&
      ["embedding", "embeddings", "reranker", "image", "audio", "transcription"].includes(type)
    )
      return [];
    const modalities = stringArray(row, "output_modalities");
    if (modalities && !modalities.includes("text")) return [];
    const capabilities = stringArray(row, "capabilities");
    if (capabilities && !capabilities.includes("completion") && !capabilities.includes("chat"))
      return [];
    return [
      {
        id,
        name: stringField(row, "name") ?? stringField(row, "display_name"),
        description: stringField(row, "description"),
        contextWindow: lowestPositiveField(row, ["served_context_window", "max_model_len"]),
        maxOutputTokens: positiveField(row, "served_max_output_tokens"),
        acceptsImages: stringArray(row, "input_modalities")?.includes("image"),
      },
    ];
  });
}

async function ollamaModels(
  config: CompatibleEndpointConfig,
  auth: CompatibleEndpointAuth,
  options: CompatibleEndpointDiscoveryOptions,
): Promise<EndpointModelEntry[]> {
  const base = config.baseUrl!;
  const [tags, ps] = await Promise.all([
    requestJSON(APIUrl(base, "ollama", "/api/tags"), auth, options).then((value) =>
      parseModelList(value, "models"),
    ),
    requestJSON(APIUrl(base, "ollama", "/api/ps"), auth, options).then((value) =>
      parseModelList(value, "models"),
    ),
  ]);
  const running = new Map<string, number>();
  for (const row of ps) {
    const id = stringField(row, "model") ?? stringField(row, "name");
    const context = positiveField(row, "context_length");
    if (id && context) running.set(id, context);
  }
  const rows =
    options.nativeModelId === undefined
      ? tags
      : tags.filter(
          (row) =>
            (stringField(row, "model") ?? stringField(row, "name")) === options.nativeModelId,
        );
  const results: EndpointModelEntry[] = [];
  for (let index = 0; index < rows.length; index += 8) {
    const batch = rows.slice(index, index + 8);
    const entries = await Promise.all(
      batch.map(async (row): Promise<EndpointModelEntry | undefined> => {
        const id = stringField(row, "model") ?? stringField(row, "name");
        if (!id) return undefined;
        const listedCloudHost = stringField(row, "remote_host");
        try {
          const show = object.parse(
            await requestJSON(APIUrl(base, "ollama", "/api/show"), auth, {
              ...options,
              body: { model: id },
            }),
          );
          const capabilities = stringArray(show, "capabilities");
          if (capabilities && !capabilities.includes("completion")) return undefined;
          const cloudHost = stringField(show, "remote_host") ?? listedCloudHost;
          const cloudDescription = cloudHost
            ? `Ollama cloud model served by ${cloudHost}`
            : id.endsWith("-cloud")
              ? "Possibly cloud-backed; Ollama did not report a remote host"
              : undefined;
          return {
            id,
            // A loaded model's context is what it serves now; the Modelfile's
            // is what it will be loaded with.
            contextWindow: running.get(id) ?? ollamaModelfileContext(show),
            acceptsImages: capabilities?.includes("vision"),
            description: cloudDescription,
            unavailableReason:
              capabilities && !capabilities.includes("tools")
                ? "Ollama reports no tool support for this model"
                : undefined,
          };
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (
            error instanceof CompatibleEndpointHttpError &&
            (error.status === 401 || error.status === 403)
          ) {
            throw error;
          }
          return {
            id,
            contextWindow: running.get(id),
            description: listedCloudHost
              ? `Ollama cloud model served by ${listedCloudHost}`
              : id.endsWith("-cloud")
                ? "Possibly cloud-backed; Ollama did not report a remote host"
                : undefined,
            unavailableReason: "Model capabilities could not be read",
          };
        }
      }),
    );
    for (const entry of entries) if (entry) results.push(entry);
  }
  return results;
}

async function lmstudioModels(
  config: CompatibleEndpointConfig,
  auth: CompatibleEndpointAuth,
  options: CompatibleEndpointDiscoveryOptions,
): Promise<EndpointModelEntry[]> {
  const rows = parseModelList(
    await requestJSON(APIUrl(config.baseUrl!, "lmstudio", "/api/v1/models"), auth, options),
    "models",
  );
  return rows.flatMap((row): EndpointModelEntry[] => {
    if (stringField(row, "type") !== "llm") return [];
    const id = stringField(row, "key");
    if (!id) return [];
    const instances = z.array(object).safeParse(row.loaded_instances);
    const loaded = instances.success ? instances.data : [];
    const capabilities = object.safeParse(row.capabilities);
    const name = stringField(row, "display_name");
    const description = stringField(row, "description");
    const acceptsImages = capabilities.success ? capabilities.data.vision === true : undefined;
    if (!loaded.length)
      return [{ id, name, description, acceptsImages, unavailableReason: "Model is not loaded" }];
    return loaded.flatMap((instance) => {
      const instanceId = stringField(instance, "id");
      if (!instanceId) return [];
      const configRow = object.safeParse(instance.config);
      return [
        {
          id: instanceId,
          name: loaded.length > 1 && name ? `${name} (${instanceId})` : name,
          description,
          contextWindow: configRow.success
            ? positiveField(configRow.data, "context_length")
            : undefined,
          acceptsImages,
        },
      ];
    });
  });
}

async function omlxModels(
  config: CompatibleEndpointConfig,
  auth: CompatibleEndpointAuth,
  options: CompatibleEndpointDiscoveryOptions,
): Promise<EndpointModelEntry[]> {
  const rows = parseModelList(
    await requestJSON(APIUrl(config.baseUrl!, "omlx", "/v1/models/status"), auth, options),
    "models",
  );
  return rows.flatMap((row) => {
    const id = stringField(row, "id");
    if (!id) return [];
    if (row.is_hidden === true || row.is_helper === true) return [];
    const type = stringField(row, "model_type");
    if (type && type !== "llm" && type !== "vlm") return [];
    return [
      {
        id,
        name: stringField(row, "display_name"),
        description: stringField(row, "description"),
        contextWindow: positiveField(row, "max_context_window"),
        maxOutputTokens: positiveField(row, "max_tokens"),
        acceptsImages: type === "vlm",
        unavailableReason: stringField(row, "disabled_reason"),
      },
    ];
  });
}

/** Read endpoint metadata without loading a model or assuming its served limits. */
export async function discoverCompatibleEndpointModels(
  input: CompatibleEndpointConfig,
  auth: CompatibleEndpointAuth,
  options: CompatibleEndpointDiscoveryOptions = {},
): Promise<readonly HarnessModelDescriptor[]> {
  // Drivers embed these fields in a larger engine config; validate only the
  // endpoint slice before using it for HTTP requests.
  const config = CompatibleEndpointConfigSchema.parse({
    baseUrl: input.baseUrl,
    runtime: input.runtime,
    models: input.models,
    modelIdentity: input.modelIdentity,
  });
  const parsedAuth = CompatibleEndpointAuthSchema.parse(auth);
  if (!config.baseUrl) throw new Error("Configure the endpoint base URL");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedTimeout(options.timeoutMs));
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const requestOptions = { ...options, signal: controller.signal };
    const entries =
      config.runtime === "ollama"
        ? await ollamaModels(config, parsedAuth, requestOptions)
        : config.runtime === "lmstudio"
          ? await lmstudioModels(config, parsedAuth, requestOptions)
          : config.runtime === "omlx"
            ? await omlxModels(config, parsedAuth, requestOptions)
            : await genericModels(config, parsedAuth, requestOptions);
    if (entries.length > maxModels) throw tooManyModels(entries.length);
    return compatibleModelDescriptors(
      entries.map((entry) => effectiveEntry(entry, config)),
      config.modelIdentity === "legacy"
        ? compatibleModelHint(config.baseUrl, "openai-compatible")
        : "custom",
      config.modelIdentity,
    );
  } catch (error) {
    const aborted =
      controller.signal.aborted ||
      (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
    if (aborted && !options.signal?.aborted) {
      throw new CompatibleEndpointTimeoutError(boundedTimeout(options.timeoutMs));
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
