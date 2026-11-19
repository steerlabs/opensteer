import { classifyClientFailure } from "../connections/operation-error.js";
import {
  HostApiErrorSchema,
  expectedMutationSessionHeader,
  TranscriptFileContentSchema,
  transcriptFileContentMaxBytes,
  hostApi,
  type HostApiClient,
  type HostApiHandlers,
  type HostApiServerContext,
  type RpcCallOptions,
  type RpcDeclaration,
  type RpcInput,
  type RpcOutput,
} from "@opensteer/protocol";
import { apiVersionHeaders } from "@opensteer/deployment-authority";
import { attachmentMaxBytes } from "@opensteer/core";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { formatIssues } from "@opensteer/shared/validationIssues";
import { z } from "zod";
import {
  HostResponseDeadline,
  bufferedHostResponseTimeoutMs,
  hostResponseHeadersTimeoutMs,
  hostResponseStallTimeoutMs,
} from "../connections/host-response-deadline.js";
import {
  HostCapacityError,
  HostTransportError,
  isGatewayFailure,
} from "../connections/host-transport-error.js";

type Fetch = typeof globalThis.fetch;
type HostApiHandler<Name extends keyof typeof hostApi> = (
  payload: z.output<(typeof hostApi)[Name]["payload"]>,
  context: HostApiServerContext,
) => Promise<RpcOutput<(typeof hostApi)[Name]>>;

const responseEnvelopes = new Map(
  Object.entries(hostApi).map(([name, declaration]) => [
    name,
    z.discriminatedUnion("ok", [
      z.object({ data: declaration.success, ok: z.literal(true) }),
      z.object({ error: declaration.error, ok: z.literal(false) }),
    ]),
  ]),
);

export interface HttpHostApiClientOptions {
  readonly baseUrl: URL;
  readonly kind?: "personal" | "team";
  readonly personalVersion?: number;
  readonly fetch: Fetch;
  /**
   * The fetch queues uploads and bounds each one's wait for headers from when
   * it is sent, so the client's own header clock doesn't count the queue.
   */
  readonly pacedUploads?: boolean;
  readonly assertResponseCurrent?: (response: Response) => void;
  readonly onSignedOut?: () => void;
  readonly onAuthenticationRequired: (method: keyof typeof hostApi) => void;
  readonly onVersionMismatch?: () => void;
}

const scopedReadLimits = {
  "personal.shell.get": 96 * 1024,
  "thread.snapshot.get": 128 * 1024,
  "thread.items.page": 128 * 1024,
  "node.items.page": 128 * 1024,
  "transcript.item.get": 1024 * 1024,
  "thread.inputQueue.get": 96 * 1024,
  "thread.overlays.page": 16 * 1024,
  "resources.detail.get": 64 * 1024,
  "tasks.page": 64 * 1024,
  "needsYou.get": 64 * 1024,
} satisfies Partial<Record<keyof typeof hostApi, number>>;
const personalReadLimit: Partial<Record<keyof typeof hostApi, number>> = scopedReadLimits;

const maximumRpcPayloadBytes = 1 * 1_024 * 1_024;

function authenticationRefusal<Declaration extends RpcDeclaration>(
  reason = "sign-in-required",
): RpcOutput<Declaration> {
  return rpcError(reason, "Sign in to continue.", false, "unauthorized");
}

function rpcError<Declaration extends RpcDeclaration>(
  reason: string,
  message: string,
  retryable: boolean,
  code: z.infer<typeof HostApiErrorSchema>["code"] = "internal",
): RpcOutput<Declaration> {
  return {
    error: HostApiErrorSchema.parse({ code, message, reason, retryable }),
    ok: false,
  } as RpcOutput<Declaration>;
}

type Invoke = <Name extends keyof typeof hostApi>(
  name: Name,
  input: unknown,
  call: RpcCallOptions | undefined,
) => Promise<RpcOutput<(typeof hostApi)[Name]>>;
/** The declaration record is the member list, so a property the API does not
 * declare stays undefined rather than becoming a callable that 404s. */
function hostApiClientProxy(invoke: Invoke): HostApiClient {
  const client = new Proxy(
    {},
    {
      get: (target, property) => {
        if (Reflect.has(target, property)) return Reflect.get(target, property);
        if (typeof property !== "string" || !(property in hostApi)) return undefined;
        const name = property as keyof typeof hostApi;
        return (input: RpcInput<(typeof hostApi)[typeof name]>, call?: RpcCallOptions) =>
          invoke(name, input, call);
      },
    },
  ) as HostApiClient;
  return client;
}

const authenticationObservers = new WeakMap<HostApiClient, Set<() => void>>();
export function observeRpcAuthentication(client: HostApiClient, listener: () => void): () => void {
  const observers = authenticationObservers.get(client);
  observers?.add(listener);
  return () => {
    observers?.delete(listener);
  };
}
export function forwardRpcAuthentication(source: HostApiClient, wrapper: HostApiClient): void {
  const observers = authenticationObservers.get(source);
  if (observers) authenticationObservers.set(wrapper, observers);
}
export function createHttpHostApiClient(options: HttpHostApiClientOptions): HostApiClient {
  const observers = new Set<() => void>();
  const observedOptions = {
    ...options,
    onAuthenticationRequired: (method: keyof typeof hostApi) => {
      options.onAuthenticationRequired(method);
      observers.forEach((listener) => listener());
    },
  };
  const client = hostApiClientProxy((name, input, call) =>
    request(observedOptions, name, input, call),
  );
  authenticationObservers.set(client, observers);
  return client;
}

export function createInMemoryHostApiClient(
  handlers: HostApiHandlers,
  context: HostApiServerContext,
): HostApiClient {
  return hostApiClientProxy((name, input, call) =>
    dispatchInMemory(handlers, context, name, input, call),
  );
}

async function dispatchInMemory<Name extends keyof typeof hostApi>(
  handlers: HostApiHandlers,
  context: HostApiServerContext,
  name: Name,
  input: unknown,
  call: RpcCallOptions | undefined,
): Promise<RpcOutput<(typeof hostApi)[Name]>> {
  const declaration = hostApi[name];
  try {
    const handler = handlers[name] as HostApiHandler<Name>;
    const payload = declaration.payload.parse(input) as z.output<(typeof hostApi)[Name]["payload"]>;
    const binaryBody = call?.body === undefined ? undefined : binaryChunks(call.body);
    const output = await handler(payload, {
      ...context,
      ...(call?.signal ? { signal: call.signal } : {}),
      ...(binaryBody ? { binaryBody } : {}),
    });
    if (!output.ok) return output as RpcOutput<(typeof hostApi)[Name]>;
    return {
      data: declaration.success.parse(output.data),
      ok: true,
    } as RpcOutput<(typeof hostApi)[Name]>;
  } catch (error) {
    // As the Host answers: input it cannot read is the caller's mistake, said
    // in a sentence rather than as the validator's report.
    return {
      error: HostApiErrorSchema.parse(
        error instanceof z.ZodError
          ? {
              code: "bad_request",
              message: `Request is invalid: ${formatIssues(error.issues)}`,
              retryable: false,
            }
          : {
              code: "internal",
              message: error instanceof Error ? error.message : "The mock Host failed.",
              retryable: false,
            },
      ),
      ok: false,
    } as RpcOutput<(typeof hostApi)[Name]>;
  }
}

async function request<Name extends keyof typeof hostApi>(
  options: HttpHostApiClientOptions,
  name: Name,
  input: unknown,
  call: RpcCallOptions | undefined,
): Promise<RpcOutput<(typeof hostApi)[Name]>> {
  const declaration = hostApi[name];
  const parsedPayload = declaration.payload.safeParse(input);
  if (!parsedPayload.success)
    return rpcError("invalid-payload", `Invalid input for ${name}.`, false);
  const payload = parsedPayload.data;
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > maximumRpcPayloadBytes)
    return rpcError("invalid-payload", `Input for ${name} exceeds the RPC byte limit.`, false);
  const url = new URL(`/v1/rpc/${name}`, options.baseUrl);
  if (declaration.method === "GET" || "binaryRequest" in declaration) {
    url.searchParams.set("input", serialized);
  }
  const deadline = new HostResponseDeadline(call?.signal);
  const maximumBytes = declaration.stream
    ? name === "file.content"
      ? transcriptFileContentMaxBytes
      : attachmentMaxBytes
    : (options.personalVersion && personalReadLimit[name]) || 16 * 1_024 * 1_024;
  const headersTimeoutMs =
    // Opening or waking a tab may start its browser first.
    name === "commands.dispatch" &&
    "type" in payload &&
    (payload.type === "tab.open" || payload.type === "tab.activate")
      ? 25_000
      : "binaryRequest" in declaration
        ? options.pacedUploads
          ? null
          : bufferedHostResponseTimeoutMs(
              call?.body instanceof Uint8Array
                ? call.body.byteLength
                : (call?.body?.size ?? attachmentMaxBytes),
            )
        : hostResponseHeadersTimeoutMs;
  const stallTimeoutMs = hostResponseStallTimeoutMs;
  let authenticationRequired = false;
  let answered = false;
  try {
    call?.signal?.throwIfAborted();
    if (headersTimeoutMs !== null) deadline.reset(headersTimeoutMs);
    const response = await deadline.wait(
      options.fetch(url, {
        ...(declaration.method === "POST"
          ? {
              body:
                "binaryRequest" in declaration
                  ? call?.body instanceof Uint8Array
                    ? new Blob([Uint8Array.from(call.body)])
                    : (call?.body ?? null)
                  : serialized,
            }
          : {}),
        credentials: "include",
        headers: {
          accept: declaration.stream ? "*/*" : "application/json",
          ...(call?.expectedSessionId
            ? { [expectedMutationSessionHeader]: call.expectedSessionId }
            : {}),
          // Every rpc request states the versions this app speaks. It is sent from
          // here alone so no caller can reach a Host without having negotiated.
          ...apiVersionHeaders(options.kind ?? "personal", options.personalVersion),
          ...(declaration.method === "POST"
            ? {
                "content-type":
                  "binaryRequest" in declaration ? "application/octet-stream" : "application/json",
              }
            : {}),
        },
        method: declaration.method,
        signal: deadline.controller.signal,
      }),
    );
    deadline.controller.signal.throwIfAborted();
    // The refusal is known from its status; a body that then stalls must not
    // turn a sign-in prompt into a transport error.
    if (response.status === 401) {
      authenticationRequired = true;
      options.onAuthenticationRequired(name);
    }
    deadline.reset(response.body ? stallTimeoutMs : bufferedHostResponseTimeoutMs(maximumBytes));
    const bytes = await deadline.wait(
      readBoundedResponse(response, {
        maximumBytes,
        signal: deadline.controller.signal,
        onProgress: () => deadline.reset(stallTimeoutMs),
        sizeError: () => new HostTransportError("response-too-large"),
      }),
    );
    answered = true;
    if (declaration.stream && response.ok) {
      const modified = response.headers.get("last-modified");
      const metadata = TranscriptFileContentSchema.shape.metadata.parse({
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        etag: response.headers.get("etag") ?? "missing",
        modifiedAt: modified ? new Date(modified).toISOString() : null,
        sizeBytes: Number(response.headers.get("x-opensteer-file-size") ?? bytes.byteLength),
        truncated: false,
      });
      options.assertResponseCurrent?.(response);
      call?.signal?.throwIfAborted();
      return {
        data: declaration.success.parse({
          bytes,
          metadata,
        }),
        ok: true,
      } as RpcOutput<(typeof hostApi)[Name]>;
    }
    let body: unknown = null;
    try {
      // Invalid UTF-8 is a broken answer, not text to repair into one.
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      // Neither decodes to an envelope; the status below says what kind of answer it was.
    }
    const parsed = responseEnvelopes.get(name)!.safeParse(body);
    options.assertResponseCurrent?.(response);
    call?.signal?.throwIfAborted();
    if (
      parsed.success &&
      (!authenticationRequired || (!parsed.data.ok && parsed.data.error.code === "unauthorized"))
    ) {
      if (name === "auth.signOut" && parsed.data.ok) options.onSignedOut?.();
      if (
        !parsed.data.ok &&
        ["unsupported-version", "api-version-mismatch"].includes(parsed.data.error.reason ?? "")
      )
        options.onVersionMismatch?.();
      return parsed.data as RpcOutput<(typeof hostApi)[Name]>;
    }
    if (authenticationRequired) return authenticationRefusal();
    if (isGatewayFailure(response.status)) {
      const failure = new HostTransportError("unreachable");
      return rpcError("transport-unreachable", failure.message, failure.retryable);
    }
    // A Host from before this method answers its framework's plain 404.
    const missing = response.status === 404;
    return {
      error: HostApiErrorSchema.parse({
        code: missing ? "not_found" : "internal",
        message: missing
          ? "This Host doesn’t offer that yet."
          : "The Host returned an incompatible response.",
        reason: missing ? "unknown-method" : "invalid-response",
        retryable: false,
      }),
      ok: false,
    } as RpcOutput<(typeof hostApi)[Name]>;
  } catch (caught) {
    const error = deadline.controller.signal.aborted ? deadline.controller.signal.reason : caught;
    // An abort is the caller's own decision, not a Host failure. The rejection
    // is a DOMException in a browser and a plain Error elsewhere, so the name
    // is the only portable evidence.
    if (call?.signal?.aborted) throw call.signal.reason ?? error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (
      authenticationRequired ||
      (error instanceof HostTransportError && error.failure.code === "unauthorized")
    ) {
      if (!authenticationRequired) options.onAuthenticationRequired(name);
      return authenticationRefusal(
        error instanceof HostTransportError && error.failure.code === "unauthorized"
          ? error.failure.reason
          : undefined,
      );
    }
    if (error instanceof HostCapacityError)
      return rpcError("resource-exhausted", error.message, true, "resource_exhausted");
    if (
      !(error instanceof HostTransportError) &&
      !(error instanceof Error && error.name === "TimeoutError") &&
      (answered || error instanceof z.ZodError || error instanceof RangeError)
    ) {
      return rpcError("invalid-response", "The Host returned an incompatible response.", false);
    }
    const failure =
      error instanceof HostTransportError
        ? error
        : new HostTransportError(
            error instanceof Error && error.name === "TimeoutError" ? "timed-out" : "unreachable",
            { cause: error },
          );
    const observed = classifyClientFailure(failure);
    const code = HostApiErrorSchema.shape.code.safeParse(observed.code);
    return {
      ok: false,
      error: HostApiErrorSchema.parse({
        code: code.success ? code.data : "internal",
        message: failure.message,
        reason:
          observed.provenance === "transport" && !observed.reason.startsWith("transport-")
            ? `transport-${observed.reason}`
            : observed.reason,
        retryable: observed.retryable,
        provenance: observed.provenance,
      }),
    } as RpcOutput<(typeof hostApi)[Name]>;
  } finally {
    deadline.dispose();
  }
}

async function* binaryChunks(body: Blob | Uint8Array): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  const reader = body.stream().getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}
