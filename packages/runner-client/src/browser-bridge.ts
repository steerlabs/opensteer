import {
  standardCdpBufferedMaxBytes,
  standardCdpDetachFrame,
  standardCdpSettledReason,
  standardCdpMessageMaxBytes,
  standardCdpPath,
  standardCdpLeasePath,
  StandardCdpLeaseEvidenceSchema,
  type StandardCdpAttemptReconciliation,
  type StandardCdpLeaseReconciliation,
} from "@opensteer/protocol/standard-cdp";
import { isLoopbackHostname } from "@opensteer/core";
import { requestOverTunnel } from "@opensteer/shared/poolRelay";
import type { Duplex } from "node:stream";
import {
  BrowserAttachPublicKeysSchema,
  BrowserClientMessageSchema,
  BrowserEngineSchema,
  BrowserRuntimeServerMessageSchema,
  createBrowserBridgeAttachedSchema,
  HeldLocalProfileSchema,
  serializeJsonFrame,
  type BrowserAttachPublicKey,
  type BrowserBridgeAttached,
  type BrowserClientMessage,
  type BrowserRuntimeServerMessage,
  type LocalProfileBinding,
  type ProtocolError,
} from "@opensteer/protocol";
import {
  validateBrowserRuntimeFrame,
  type BrowserChannelId,
  type BrowserRuntimeHealth,
} from "@opensteer/protocol/browser-relay";
import { readBoundedText } from "@opensteer/shared/boundedJson";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";

const LocalHealthSchema = z.object({
  wireVersion: z.number().int().optional(),
  standardCdp: z.literal(1).optional(),
  standardCdpLineage: z.literal(1).optional(),
  connectionCommands: z.literal(1).optional(),
  wholeContextCdp: z.literal(1).optional(),
  standardCdpLeaseRecovery: z.literal(1).optional(),
  standardCdpAttemptRecovery: z.literal(1).optional(),
  runtimeId: z.string().min(1).max(255),
  sessionId: z.string().max(255).nullable().optional(),
  state: z.enum(["closed", "closing", "idle", "ready", "starting"]),
  localProfileStorage: z
    .object({ storageInstanceId: z.uuid(), engine: BrowserEngineSchema })
    .optional()
    .catch(undefined),
});

export interface BrowserChannelSink {
  onClosed(channelId: BrowserChannelId, code: number, reason: string): void;
  onRawCdp?(channelId: BrowserChannelId, frame: Buffer): void;
  onFrame(channelId: BrowserChannelId, frame: Buffer): void;
  onServerMessage(channelId: BrowserChannelId, message: BrowserRuntimeServerMessage): void;
}

export class BrowserRelayError extends Error {
  readonly retryable: boolean;
  /** The Browser Runtime's own refusal, relayed as it sent it. */
  readonly runtimeError: ProtocolError | undefined;

  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly retryable?: boolean;
      readonly runtimeError?: ProtocolError;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserRelayError";
    this.retryable = options.retryable ?? false;
    this.runtimeError = options.runtimeError;
  }
}

/**
 * The loopback hop between a Runner's browser module and the Chromium runtime
 * it drives.
 *
 * It exists so the Runner key never has to travel: the relay authenticates to
 * the Host with the machine's identity, and reaches its own browser over an
 * uncredentialed loopback origin plus a bridge token that is worthless anywhere
 * else. Attach tickets are passed through untouched — the browser runtime is
 * what verifies them.
 */
/**
 * How a pooled target's bridge is reached (pool-runtime-in-guest.md, decision 6): each request
 * and each channel gets its own tunnel, and that tunnel's bridge token. The bridge protocol
 * inside is unchanged.
 */
export interface BrowserBridgeTransport {
  open(signal?: AbortSignal): Promise<{ readonly socket: Duplex; readonly bridgeToken: string }>;
}

export class LocalBrowserRuntimeBridge {
  readonly #channels = new Map<BrowserChannelId, { readonly socket: WebSocket }>();
  readonly #bridgeToken: string;
  readonly #maxBufferedBytes: number;
  readonly #maxTextFrameBytes: number | undefined;
  readonly #maxBinaryFrameBytes: number | undefined;
  readonly #runtimeId: string;
  readonly #url: URL;
  #passkeys = false;
  setPasskeysEnabled(enabled: boolean): void {
    this.#passkeys = enabled;
  }

  async localProfileInventory(signal?: AbortSignal) {
    const maintenanceSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    return z
      .strictObject({
        storage: z.strictObject({ storageInstanceId: z.uuid(), engine: BrowserEngineSchema }),
        profiles: z.array(HeldLocalProfileSchema),
      })
      .parse(await this.#maintenance("/v1/local-profiles", undefined, maintenanceSignal));
  }
  async deleteLocalProfile(
    binding: LocalProfileBinding,
    deletionId: string,
  ): Promise<"pending-restart" | "deleted"> {
    return z
      .strictObject({ state: z.enum(["pending-restart", "deleted"]) })
      .parse(await this.#maintenance("/v1/local-profiles/delete", { binding, deletionId })).state;
  }
  async reconcileStandardCdpLease(
    request: StandardCdpLeaseReconciliation | StandardCdpAttemptReconciliation | undefined,
    signal: AbortSignal,
  ) {
    return StandardCdpLeaseEvidenceSchema.parse(
      await this.#maintenance(standardCdpLeasePath, request, signal),
    );
  }

  async #maintenance(
    pathname: string,
    input?: object,
    signal = AbortSignal.timeout(120_000),
  ): Promise<unknown> {
    if (this.#transport) {
      signal.throwIfAborted();
      const { socket, bridgeToken } = await this.#transport.open(signal);
      if (signal.aborted) {
        socket.destroy();
        throw signal.reason;
      }
      const answer = await requestOverTunnel(socket, {
        method: input ? "POST" : "GET",
        path: pathname,
        signal,
        maximumBytes: 16 * 1024 * 1024,
        headers: {
          "x-opensteer-browser-bridge-token": bridgeToken,
          ...(input ? { "content-type": "application/json" } : {}),
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      if (answer.status < 200 || answer.status > 299)
        throw new BrowserRelayError("Local browser profile maintenance failed.");
      return JSON.parse(answer.text);
    }
    const response = await fetch(new URL(pathname, this.#url), {
      method: input ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: {
        "x-opensteer-browser-bridge-token": this.#bridgeToken,
        ...(input ? { "content-type": "application/json" } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new BrowserRelayError("Local browser profile maintenance failed.");
    }
    return JSON.parse(await readBoundedText(response, { maximumBytes: 16 * 1024 * 1024 }));
  }
  #attachKeysHeader: string | undefined;

  readonly #transport: BrowserBridgeTransport | undefined;

  constructor(
    options:
      | {
          readonly bridgeToken: string;
          readonly maxBufferedBytes?: number;
          readonly maxTextFrameBytes?: number;
          readonly maxBinaryFrameBytes?: number;
          readonly runtimeId: string;
          readonly url: URL;
        }
      | {
          /** A pooled target: every connection is a tunnel with its own token. */
          readonly transport: BrowserBridgeTransport;
          readonly maxBufferedBytes?: number;
          readonly maxTextFrameBytes?: number;
          readonly maxBinaryFrameBytes?: number;
          readonly runtimeId: string;
        },
  ) {
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1_024 * 1_024;
    this.#maxTextFrameBytes = options.maxTextFrameBytes;
    this.#maxBinaryFrameBytes = options.maxBinaryFrameBytes;
    this.#runtimeId = options.runtimeId;
    if ("transport" in options) {
      this.#transport = options.transport;
      this.#bridgeToken = "";
      this.#url = new URL("http://pool-guest/");
      return;
    }
    this.#transport = undefined;
    if (options.bridgeToken.length < 32 || options.bridgeToken.length > 4_096) {
      throw new BrowserRelayError("The local browser bridge token is invalid.");
    }
    this.#bridgeToken = options.bridgeToken;
    this.#url = new URL(options.url);
    if (
      this.#url.protocol !== "http:" ||
      !isLoopbackHostname(this.#url.hostname) ||
      this.#url.username ||
      this.#url.password ||
      this.#url.search ||
      this.#url.hash ||
      (this.#url.pathname !== "/" && this.#url.pathname !== "")
    ) {
      throw new BrowserRelayError(
        "The browser bridge target must be an uncredentialed loopback HTTP origin.",
      );
    }
  }

  get runtimeId(): string {
    return this.#runtimeId;
  }

  setAttachPublicKeys(keys: readonly BrowserAttachPublicKey[]): void {
    const parsed = BrowserAttachPublicKeysSchema.parse(keys);
    if (new Set(parsed.map((key) => key.keyId)).size !== parsed.length) {
      throw new BrowserRelayError("The Host browser attach key IDs are not unique.");
    }
    const encoded = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
    if (encoded.length > 12_000) {
      throw new BrowserRelayError("The Host browser attach key set is too large.");
    }
    this.#attachKeysHeader = encoded;
  }

  async #healthText(signal?: AbortSignal): Promise<string> {
    if (this.#transport) {
      signal?.throwIfAborted();
      const healthSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000);
      const { socket } = await this.#transport.open(healthSignal);
      if (healthSignal.aborted) {
        socket.destroy();
        throw healthSignal.reason;
      }
      const answer = await requestOverTunnel(socket, {
        method: "GET",
        path: "/health",
        headers: { accept: "application/json" },
        maximumBytes: 32 * 1_024,
        signal: healthSignal,
      });
      if (answer.status !== 200) throw new BrowserRelayError("Browser health is unavailable.");
      return answer.text;
    }
    const fetchSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
      : AbortSignal.timeout(2_000);
    const response = await fetch(new URL("/health", this.#url), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: fetchSignal,
    });
    if (!response.ok) throw new BrowserRelayError("Browser health is unavailable.");
    return readBoundedText(response, { maximumBytes: 32 * 1_024 });
  }

  async #readHealth(signal?: AbortSignal) {
    const health = LocalHealthSchema.parse(JSON.parse(await this.#healthText(signal)));
    if (health.runtimeId !== this.#runtimeId)
      throw new BrowserRelayError("Browser runtime identity does not match configuration.");
    return health;
  }

  /** Facts from the running engine, before the Host negotiates its auxiliary stream. */
  async capabilities(signal?: AbortSignal) {
    const health = await this.#readHealth(signal);
    return {
      wireVersion: health.wireVersion,
      ...(health.standardCdp === 1 ? { standardCdp: 1 as const } : {}),
      ...(health.standardCdpLineage === 1 ? { standardCdpLineage: 1 as const } : {}),
      ...(health.connectionCommands === 1 ? { connectionCommands: 1 as const } : {}),
      ...(health.wholeContextCdp === 1 ? { wholeContextCdp: 1 as const } : {}),
      ...(health.standardCdpLeaseRecovery === 1 ? { standardCdpLeaseRecovery: 1 as const } : {}),
      ...(health.standardCdpAttemptRecovery === 1
        ? { standardCdpAttemptRecovery: 1 as const }
        : {}),
      ...(health.localProfileStorage
        ? {
            localProfileStorage: health.localProfileStorage,
          }
        : {}),
    };
  }

  async health(): Promise<BrowserRuntimeHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const health = await this.#readHealth();
      return {
        runtimeId: health.runtimeId,
        state: health.state,
        sessionId: health.sessionId ?? null,
        checkedAt,
        detail: null,
      };
    } catch {
      return {
        checkedAt,
        detail: "The configured browser runtime is unavailable.",
        runtimeId: this.#runtimeId,
        sessionId: null,
        state: "unavailable",
      };
    }
  }

  async attach(
    channelId: BrowserChannelId,
    attachTicket: string,
    sink: BrowserChannelSink,
    standardCdp = false,
  ): Promise<BrowserBridgeAttached> {
    if (this.#channels.has(channelId)) {
      throw new BrowserRelayError("The browser relay channel already exists.");
    }
    if (
      Buffer.byteLength(attachTicket, "utf8") > 16_384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(attachTicket)
    ) {
      throw new BrowserRelayError("The browser attach ticket is malformed.");
    }
    const attachKeysHeader = this.#attachKeysHeader;
    if (!attachKeysHeader) {
      throw new BrowserRelayError("The Host has not provided browser attach keys.");
    }
    const url = new URL(standardCdp ? standardCdpPath : "/v1/browser", this.#url);
    url.protocol = "ws:";
    // A pooled target: the channel is its own tunnel, with that tunnel's token.
    const tunnel = this.#transport ? await this.#transport.open() : undefined;
    if (this.#channels.has(channelId)) {
      tunnel?.socket.destroy();
      throw new BrowserRelayError("The browser relay channel already exists.");
    }
    const socket = new WebSocket(url, {
      followRedirects: false,
      headers: {
        ...(this.#passkeys ? { "x-opensteer-browser-passkeys": "1" } : {}),
        authorization: `Bearer ${attachTicket}`,
        ...(standardCdp ? { "x-opensteer-browser-cdp-bridge": "1" } : {}),
        "x-opensteer-browser-attach-keys": attachKeysHeader,
        "x-opensteer-browser-bridge-token": tunnel?.bridgeToken ?? this.#bridgeToken,
      },
      maxPayload: standardCdp ? standardCdpMessageMaxBytes : this.#maxBufferedBytes,
      perMessageDeflate: false,
      ...(tunnel ? { createConnection: () => tunnel.socket as never } : {}),
    });
    tunnel?.socket.resume();
    this.#channels.set(channelId, { socket });
    let attached = false;
    const readiness = Promise.withResolvers<BrowserBridgeAttached>();
    // Observe rejection even if the transport fails before waitForOpen returns.
    void readiness.promise.catch(() => undefined);

    socket.on("message", (raw, isBinary) => {
      try {
        const frame = normalizeRawData(raw);
        if (standardCdp && attached) {
          if (isBinary || !sink.onRawCdp) throw new Error("Unexpected raw CDP frame.");
          sink.onRawCdp(channelId, frame);
        } else if (isBinary) {
          if (standardCdp) throw new Error("Unexpected raw CDP readiness.");
          if (
            this.#maxBinaryFrameBytes !== undefined &&
            frame.byteLength > this.#maxBinaryFrameBytes
          )
            throw new Error("Browser runtime binary frame exceeds the size limit.");
          validateBrowserRuntimeFrame(frame);
          sink.onFrame(channelId, frame);
        } else {
          if (this.#maxTextFrameBytes !== undefined && frame.byteLength > this.#maxTextFrameBytes)
            throw new Error("Browser runtime text frame exceeds the size limit.");
          const value: unknown = JSON.parse(frame.toString("utf8"));
          const ready = createBrowserBridgeAttachedSchema().safeParse(value);
          if (ready.success) {
            if (standardCdp && !ready.data.standardCdpMode)
              throw new Error("Missing raw CDP readiness.");
            readiness.resolve(ready.data);
            return;
          }
          const message = BrowserRuntimeServerMessageSchema.parse(value);
          if (message.type === "browser.error")
            readiness.reject(
              new BrowserRelayError(message.error.message, {
                retryable: message.error.retryable,
                runtimeError: message.error,
              }),
            );
          sink.onServerMessage(channelId, message);
        }
      } catch {
        readiness.reject(new BrowserRelayError("Invalid browser runtime readiness."));
        socket.close(1007, "invalid browser runtime frame");
      }
    });
    socket.once("close", (code, reason) => {
      readiness.reject(new BrowserRelayError("The browser runtime closed before attachment."));
      if (this.#channels.get(channelId)?.socket !== socket) return;
      this.#channels.delete(channelId);
      if (!attached) return;
      try {
        sink.onClosed(channelId, code, reason.toString("utf8").slice(0, 1_000));
      } catch {
        // The owning Host stream is already unavailable.
      }
    });
    socket.on("error", () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1011, "local browser transport failed");
      }
    });
    try {
      await waitForOpen(socket, 5_000);
      const result = await withTimeout(readiness.promise, 20_000, {
        timeoutError: () => new BrowserRelayError("Browser runtime readiness timed out."),
      });
      attached = true;
      return result;
    } catch (error) {
      this.#channels.delete(channelId);
      socket.terminate();
      if (error instanceof BrowserRelayError && error.runtimeError) throw error;
      throw new BrowserRelayError("The local browser runtime rejected the relay.", {
        cause: error,
        retryable: true,
      });
    }
  }

  send(channelId: BrowserChannelId, message: BrowserClientMessage): Promise<void> {
    return this.#send(
      channelId,
      serializeJsonFrame(BrowserClientMessageSchema.parse(message)),
      this.#maxBufferedBytes,
    );
  }

  sendRawCdp(channelId: BrowserChannelId, frame: Buffer): Promise<void> {
    if (frame.length > standardCdpMessageMaxBytes)
      return Promise.reject(new BrowserRelayError("Raw CDP frame is too large."));
    return this.#send(channelId, frame, standardCdpBufferedMaxBytes);
  }

  #send(channelId: BrowserChannelId, frame: string | Buffer, limit: number): Promise<void> {
    const socket = this.#channels.get(channelId)?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new BrowserRelayError("The browser relay channel is not open."));
    if (socket.bufferedAmount + Buffer.byteLength(frame) > limit) {
      socket.close(1013, "slow local browser consumer");
      return Promise.reject(
        new BrowserRelayError("The local browser runtime is not consuming commands.", {
          retryable: true,
        }),
      );
    }
    return new Promise<void>((resolve, reject) => {
      socket.send(frame, { binary: false }, (error) => (error ? reject(error) : resolve()));
    });
  }

  async settleStandardCdp(channelId: BrowserChannelId): Promise<boolean> {
    const socket = this.#channels.get(channelId)?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    this.#channels.delete(channelId);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => socket.terminate(), 4_000);
      timer.unref();
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        resolve(code === 1000 && reason.toString("utf8") === standardCdpSettledReason);
      });
      socket.send(standardCdpDetachFrame, (error) => {
        if (error) socket.terminate();
      });
    });
  }

  /** A bridge to a pool guest's runtime through its relay tunnel, not a local runtime. */
  get pooled(): boolean {
    return this.#transport !== undefined;
  }

  /**
   * Closes a channel the way `close` does and waits for the runtime's own close of it: its code
   * is what the runtime answered, 1000 only when it took the close. A runtime that does not
   * answer within the bound, or a tunnel that broke, answers 1006: never a clean close.
   */
  async closeWithReceipt(
    channelId: BrowserChannelId,
    timeoutMs: number,
    reason = "relay closed",
  ): Promise<number> {
    const socket = this.#channels.get(channelId)?.socket;
    if (!socket) return 1006;
    this.#channels.delete(channelId);
    if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) {
      return socket.readyState === WebSocket.CLOSED ? 1006 : await closeCode(socket, timeoutMs);
    }
    const answered = closeCode(socket, timeoutMs);
    socket.close(1000, reason);
    return answered;
  }

  close(channelId: BrowserChannelId, code = 1000, reason = "relay closed"): void {
    const socket = this.#channels.get(channelId)?.socket;
    if (!socket) return;
    this.#channels.delete(channelId);
    socket.close(code, reason);
  }

  closeAll(code = 1001, reason = "browser stream closed"): void {
    // Closing removes the channel, so iterate a snapshot of the keys.
    for (const channelId of Array.from(this.#channels.keys())) this.close(channelId, code, reason);
  }
}

/** The code the peer closed with, or 1006 once the bound passes (the socket is then ended). */
function closeCode(socket: WebSocket, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(1006);
    }, timeoutMs);
    timer.unref();
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Browser runtime connection timed out.")),
      timeoutMs,
    );
    timer.unref();
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Browser runtime connection closed before attach."));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function normalizeRawData(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  throw new Error("Unsupported browser runtime frame representation.");
}
