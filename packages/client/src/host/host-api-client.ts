import {
  HostApiErrorSchema,
  AttachmentContentMetadataSchema,
  WorkspaceFilePreviewMetadataSchema,
  hostApi,
  hostApiVersionHeader,
  workspaceFilePreviewMaxBytes,
  type HostApiClient,
  type HostApiHandlers,
  type HostApiServerContext,
  type RpcCallOptions,
  type RpcDeclaration,
  type RpcInput,
  type RpcOutput,
} from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
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
import { HostTransportError } from "../connections/host-transport-error.js";

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
  readonly fetch: Fetch;
  /** IPC adapters return buffered bodies together with their headers. */
  readonly bufferedResponses?: boolean;
  readonly onAuthenticationRequired: () => void;
}

const maximumRpcPayloadBytes = 1 * 1_024 * 1_024;

function rpcError<Declaration extends RpcDeclaration>(
  reason: string,
  message: string,
  retryable: boolean,
): RpcOutput<Declaration> {
  return {
    error: HostApiErrorSchema.parse({ code: "internal", message, reason, retryable }),
    ok: false,
  } as RpcOutput<Declaration>;
}

type Invoke = <Name extends keyof typeof hostApi>(
  name: Name,
  input: RpcInput<(typeof hostApi)[Name]>,
  call: RpcCallOptions | undefined,
) => Promise<RpcOutput<(typeof hostApi)[Name]>>;

/** The declaration record is the member list, so a property the API does not
 * declare stays undefined rather than becoming a callable that 404s. */
function hostApiClientProxy(invoke: Invoke): HostApiClient {
  return new Proxy(
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
}

export function createHttpHostApiClient(options: HttpHostApiClientOptions): HostApiClient {
  return hostApiClientProxy((name, input, call) => request(options, name, input, call));
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
  input: RpcInput<(typeof hostApi)[Name]>,
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
  input: RpcInput<(typeof hostApi)[Name]>,
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
    ? name === "attachment.content"
      ? attachmentMaxBytes
      : workspaceFilePreviewMaxBytes
    : 16 * 1_024 * 1_024;
  const headersTimeoutMs = options.bufferedResponses
    ? bufferedHostResponseTimeoutMs(maximumBytes)
    : "binaryRequest" in declaration
      ? bufferedHostResponseTimeoutMs(
          call?.body instanceof Uint8Array
            ? call.body.byteLength
            : (call?.body?.size ?? attachmentMaxBytes),
        )
      : hostResponseHeadersTimeoutMs;
  const stallTimeoutMs = hostResponseStallTimeoutMs;
  try {
    call?.signal?.throwIfAborted();
    deadline.reset(headersTimeoutMs);
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
          // Every rpc request states the epoch this app speaks. It is sent from
          // here alone so no caller can reach a Host without having negotiated.
          [hostApiVersionHeader]: String(hostApiVersion),
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
    if (response.status === 401) options.onAuthenticationRequired();
    deadline.reset(response.body ? stallTimeoutMs : bufferedHostResponseTimeoutMs(maximumBytes));
    const bytes = await deadline.wait(
      readBoundedResponse(response, {
        maximumBytes,
        signal: deadline.controller.signal,
        onProgress: () => deadline.reset(stallTimeoutMs),
        sizeError: () => new HostTransportError("response-too-large"),
      }),
    );
    call?.signal?.throwIfAborted();
    if (declaration.stream && response.ok) {
      const modified = response.headers.get("last-modified");
      const metadata =
        name === "attachment.content"
          ? AttachmentContentMetadataSchema.parse({
              contentType: response.headers.get("content-type") ?? "application/octet-stream",
              etag: response.headers.get("etag") ?? "missing",
              modifiedAt: modified ? new Date(modified).toISOString() : null,
              sizeBytes: Number(response.headers.get("x-opensteer-file-size") ?? bytes.byteLength),
              truncated: false,
            })
          : WorkspaceFilePreviewMetadataSchema.parse({
              contentType: response.headers.get("content-type") ?? "application/octet-stream",
              etag: response.headers.get("etag") ?? "missing",
              modifiedAt: modified ? new Date(modified).toISOString() : null,
              sizeBytes: Number(response.headers.get("x-opensteer-file-size") ?? bytes.byteLength),
              truncated: response.headers.get("x-opensteer-file-truncated") === "true",
            });
      return {
        data: declaration.success.parse({
          bytes,
          metadata,
        }),
        ok: true,
      } as RpcOutput<(typeof hostApi)[Name]>;
    }
    const body: unknown = await Promise.resolve()
      .then(() => JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      .catch((error: unknown) => {
        if (error instanceof SyntaxError) return null;
        throw error;
      });
    const parsed = responseEnvelopes.get(name)!.safeParse(body);
    if (parsed.success) return parsed.data as RpcOutput<(typeof hostApi)[Name]>;
    return {
      error: HostApiErrorSchema.parse({
        code: "internal",
        message: "The Host returned an incompatible response.",
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
    if (error instanceof z.ZodError || error instanceof RangeError) {
      return rpcError("invalid-response", "The Host returned an incompatible response.", false);
    }
    const failure =
      error instanceof HostTransportError
        ? error
        : new HostTransportError(
            error instanceof Error && error.name === "TimeoutError" ? "timed-out" : "unreachable",
            { cause: error },
          );
    return rpcError(`transport-${failure.code}`, failure.message, failure.retryable);
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
