import { randomBytes } from "node:crypto";
import type {
  ChannelConnectionIssueKind,
  ChannelProvider,
  IntegrationConnectionId,
  NormalizedChannelEvent,
} from "@opensteer/channel-core";
import {
  ChannelCredentialLeaseSchema,
  ChannelResponseSchema,
  ClaimChannelDeliveryResultSchema,
  CommitChannelIngressResultSchema,
  HostChannelRequestSchema,
  HostToMessagingRelayMessageSchema,
  type ChannelCredentialLease,
  type ChannelCredentialPurpose,
  type ClaimedChannelDelivery,
  type FinishChannelDeliveryAttempt,
  type HostChannelRequest,
} from "@opensteer/channel-protocol";
import type { RunnerModuleStream } from "@opensteer/runner-client";

const requestTimeoutMs = 15_000;

export interface ChannelHostClient {
  claimDelivery(): Promise<ClaimedChannelDelivery | null>;
  commitIngress(
    connectionId: IntegrationConnectionId,
    event: NormalizedChannelEvent,
  ): Promise<void>;
  finishDelivery(input: FinishChannelDeliveryAttempt): Promise<void>;
  reportConnectionHealth(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly detail: string | null;
    readonly reason: ChannelConnectionIssueKind | null;
    readonly status: "connecting" | "connected" | "needs-attention";
  }): Promise<void>;
  resolveCredential(
    connectionId: IntegrationConnectionId,
    provider: ChannelProvider,
    purpose: ChannelCredentialPurpose,
  ): Promise<ChannelCredentialLease>;
  startDelivery(deliveryId: string, claimToken: string): Promise<void>;
}

export interface MessagingStreamContext {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export type HostRequestHandler = (
  request: HostChannelRequest,
  context: MessagingStreamContext,
) => Promise<unknown>;

export interface MessagingStreamLifecycle {
  readonly closed: (generation: number) => Promise<void>;
  readonly opened: (generation: number) => Promise<void>;
}

/**
 * The two lanes of one messaging module stream.
 *
 * A `host.request` handler may itself issue a `runtime.request` — `connections.sync`
 * resolves credentials — so the answer to that request arrives as a frame while the
 * handler is still running. Responses are therefore resolved inline, waiting on
 * nothing, and `host.request` frames are chained on a serial tail of their own: they
 * stay in arrival order without ever standing in front of the frame that unblocks
 * them.
 */
export class MessagingFrameRouter {
  readonly #pending = new Map<
    string,
    {
      readonly reject: (error: Error) => void;
      readonly resolve: (result: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #requestTimeoutMs: number;
  #generation = 0;
  #handler: HostRequestHandler | undefined;
  #requestTail = Promise.resolve();
  #stream: RunnerModuleStream | undefined;

  constructor(options: { readonly requestTimeoutMs?: number } = {}) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? requestTimeoutMs;
  }

  get attached(): boolean {
    return this.#stream !== undefined;
  }

  get generation(): number {
    return this.#generation;
  }

  setHandler(handler: HostRequestHandler): void {
    if (this.#handler) throw new Error("Messaging module request handler is already set");
    this.#handler = handler;
  }

  attach(stream: RunnerModuleStream): number {
    this.#stream = stream;
    this.#generation += 1;
    return this.#generation;
  }

  detach(reason: Error, stream?: RunnerModuleStream): void {
    if (stream && this.#stream !== stream) return;
    this.#stream = undefined;
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(reason);
    }
  }

  async request(operation: string, payload: unknown): Promise<unknown> {
    const stream = this.#stream;
    if (!stream) throw new Error("The messaging module stream is not connected");
    const requestId = `crq_${randomBytes(24).toString("base64url")}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("The Host did not answer the messaging request in time"));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(requestId, { reject, resolve, timer });
    });
    try {
      // Observe both promises before the write can fail or detach can reject
      // the response. A socket callback need not finish before disconnect.
      const [, answer] = await Promise.all([
        Promise.resolve().then(() =>
          stream.send(
            JSON.stringify({
              ...stream.fence,
              operation,
              payload,
              requestId,
              type: "runtime.request",
            }),
            false,
          ),
        ),
        result,
      ]);
      return answer;
    } finally {
      const pending = this.#pending.get(requestId);
      if (pending) clearTimeout(pending.timer);
      this.#pending.delete(requestId);
    }
  }

  async handleFrame(frame: Buffer, isBinary: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (isBinary) throw new Error("The messaging module stream carries JSON only");
    const message = HostToMessagingRelayMessageSchema.parse(JSON.parse(frame.toString("utf8")));
    if (!("type" in message)) return;
    if (message.type === "host.response") {
      const response = ChannelResponseSchema.parse(message);
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error.message));
      return;
    }
    if (message.type !== "host.request") return;
    const request = HostChannelRequestSchema.parse(message);
    const context = { generation: this.#generation, signal };
    this.#requestTail = this.#requestTail.then(() =>
      this.#answer(request, context).catch((error: unknown) => {
        reportError("channel-runtime.request-failed", error, { operation: request.operation });
      }),
    );
  }

  async #answer(request: HostChannelRequest, context: MessagingStreamContext): Promise<void> {
    const stream = this.#stream;
    const handler = this.#handler;
    if (!stream) return;
    if (!handler) throw new Error("Messaging module request handler is not installed");
    try {
      const result = await handler(request, context);
      if (!this.#isCurrentStream(stream, context)) return;
      await stream.send(
        JSON.stringify({
          ...stream.fence,
          ok: true,
          requestId: request.requestId,
          result,
          type: "runtime.response",
        }),
        false,
      );
    } catch (error) {
      if (!this.#isCurrentStream(stream, context)) return;
      await stream.send(
        JSON.stringify({
          ...stream.fence,
          error: {
            code: "bad_request",
            message: error instanceof Error ? error.message.slice(0, 500) : "Request failed",
            retryable: false,
          },
          ok: false,
          requestId: request.requestId,
          type: "runtime.response",
        }),
        false,
      );
    }
  }

  #isCurrentStream(stream: RunnerModuleStream, context: MessagingStreamContext): boolean {
    return (
      !context.signal.aborted && context.generation === this.#generation && stream === this.#stream
    );
  }
}

/**
 * The Host's end of the messaging stream as the supervisor and the delivery
 * worker use it: every operation a `runtime.request` on the router.
 */
export class RoutedChannelHostClient implements ChannelHostClient {
  readonly #router: MessagingFrameRouter;

  constructor(router: MessagingFrameRouter) {
    this.#router = router;
  }

  async resolveCredential(
    connectionId: IntegrationConnectionId,
    provider: ChannelProvider,
    purpose: ChannelCredentialPurpose,
  ): Promise<ChannelCredentialLease> {
    return ChannelCredentialLeaseSchema.parse(
      await this.#router.request("credential.resolve", { connectionId, provider, purpose }),
    );
  }

  async commitIngress(
    connectionId: IntegrationConnectionId,
    event: NormalizedChannelEvent,
  ): Promise<void> {
    CommitChannelIngressResultSchema.parse(
      await this.#router.request("ingress.commit", { connectionId, event }),
    );
  }

  async claimDelivery(): Promise<ClaimedChannelDelivery | null> {
    return ClaimChannelDeliveryResultSchema.parse(
      await this.#router.request("delivery.claim", { leaseSeconds: 30 }),
    ).claimed;
  }

  async startDelivery(deliveryId: string, claimToken: string): Promise<void> {
    await this.#router.request("delivery.start", { claimToken, deliveryId });
  }

  async finishDelivery(input: FinishChannelDeliveryAttempt): Promise<void> {
    await this.#router.request("delivery.finish", input);
  }

  async reportConnectionHealth(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly detail: string | null;
    readonly reason: ChannelConnectionIssueKind | null;
    readonly status: "connecting" | "connected" | "needs-attention";
  }): Promise<void> {
    await this.#router.request("connection.health", input);
  }
}

function reportError(
  event: string,
  error: unknown,
  details: Readonly<Record<string, unknown>>,
): void {
  const message = error instanceof Error ? error.message.slice(0, 500) : "Messaging request failed";
  process.stderr.write(`${JSON.stringify({ ...details, event, message })}\n`);
}
