import { isLoopbackHostname } from "@opensteer/core";
import {
  BrowserAttachPublicKeysSchema,
  BrowserClientMessageSchema,
  BrowserEngineSchema,
  BrowserServerMessageSchema,
  createBrowserBridgeAttachedSchema,
  HeldLocalProfileSchema,
  serializeJsonFrame,
  type BrowserAttachPublicKey,
  type BrowserBridgeAttached,
  type BrowserClientMessage,
  type BrowserServerMessage,
  type LocalProfileBinding,
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

const maxBrowserRelayChannels = 32;

const LocalHealthSchema = z.object({
  wireVersion: z.number().int().optional(),
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
  onFrame(channelId: BrowserChannelId, frame: Buffer): void;
  onServerMessage(channelId: BrowserChannelId, message: BrowserServerMessage): void;
}

export class BrowserRelayError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly cause?: unknown; readonly retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserRelayError";
    this.retryable = options.retryable ?? false;
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
export class LocalBrowserRuntimeBridge {
  readonly #channels = new Map<BrowserChannelId, { readonly socket: WebSocket }>();
  readonly #bridgeToken: string;
  readonly #maxBufferedBytes: number;
  readonly #runtimeId: string;
  readonly #url: URL;
  #passkeys = false;
  setPasskeysEnabled(enabled: boolean): void {
    this.#passkeys = enabled;
  }

  async localProfileInventory() {
    return z
      .strictObject({
        storage: z.strictObject({ storageInstanceId: z.uuid(), engine: BrowserEngineSchema }),
        profiles: z.array(HeldLocalProfileSchema),
      })
      .parse(await this.#maintenance("/v1/local-profiles"));
  }
  async deleteLocalProfile(
    binding: LocalProfileBinding,
    deletionId: string,
  ): Promise<"pending-restart" | "deleted"> {
    return z
      .strictObject({ state: z.enum(["pending-restart", "deleted"]) })
      .parse(await this.#maintenance("/v1/local-profiles/delete", { binding, deletionId })).state;
  }
  async #maintenance(pathname: string, input?: object): Promise<unknown> {
    const response = await fetch(new URL(pathname, this.#url), {
      method: input ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
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

  constructor(options: {
    readonly bridgeToken: string;
    readonly maxBufferedBytes?: number;
    readonly runtimeId: string;
    readonly url: URL;
  }) {
    if (options.bridgeToken.length < 32 || options.bridgeToken.length > 4_096) {
      throw new BrowserRelayError("The local browser bridge token is invalid.");
    }
    this.#bridgeToken = options.bridgeToken;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1_024 * 1_024;
    this.#runtimeId = options.runtimeId;
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

  async #readHealth() {
    const response = await fetch(new URL("/health", this.#url), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new BrowserRelayError("Browser health is unavailable.");
    const health = LocalHealthSchema.parse(
      JSON.parse(await readBoundedText(response, { maximumBytes: 32 * 1_024 })),
    );
    if (health.runtimeId !== this.#runtimeId)
      throw new BrowserRelayError("Browser runtime identity does not match configuration.");
    return health;
  }

  /** Facts from the running engine, before the Host negotiates its auxiliary stream. */
  async capabilities() {
    const health = await this.#readHealth();
    return {
      wireVersion: health.wireVersion,
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
  ): Promise<BrowserBridgeAttached> {
    if (this.#channels.has(channelId)) {
      throw new BrowserRelayError("The browser relay channel already exists.");
    }
    if (this.#channels.size >= maxBrowserRelayChannels) {
      throw new BrowserRelayError("The local browser runtime relay capacity is full.");
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
    const url = new URL("/v1/browser", this.#url);
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      followRedirects: false,
      headers: {
        ...(this.#passkeys ? { "x-opensteer-browser-passkeys": "1" } : {}),
        authorization: `Bearer ${attachTicket}`,
        "x-opensteer-browser-attach-keys": attachKeysHeader,
        "x-opensteer-browser-bridge-token": this.#bridgeToken,
      },
      maxPayload: this.#maxBufferedBytes,
      perMessageDeflate: false,
    });
    this.#channels.set(channelId, { socket });
    let attached = false;
    const readiness = Promise.withResolvers<BrowserBridgeAttached>();
    // Observe rejection even if the transport fails before waitForOpen returns.
    void readiness.promise.catch(() => undefined);

    socket.on("message", (raw, isBinary) => {
      try {
        const frame = normalizeRawData(raw);
        if (isBinary) {
          validateBrowserRuntimeFrame(frame);
          sink.onFrame(channelId, frame);
        } else {
          const value: unknown = JSON.parse(frame.toString("utf8"));
          const ready = createBrowserBridgeAttachedSchema().safeParse(value);
          if (ready?.success) {
            readiness.resolve(ready.data);
            return;
          }
          const message = BrowserServerMessageSchema.parse(value);
          if (message.type === "browser.error")
            readiness.reject(new BrowserRelayError(message.error.message));
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
      throw new BrowserRelayError("The local browser runtime rejected the relay.", {
        cause: error,
        retryable: true,
      });
    }
  }

  send(channelId: BrowserChannelId, message: BrowserClientMessage): Promise<void> {
    const socket = this.#channels.get(channelId)?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrowserRelayError("The browser relay channel is not open."));
    }
    const frame = serializeJsonFrame(BrowserClientMessageSchema.parse(message));
    const bytes = Buffer.byteLength(frame, "utf8");
    if (socket.bufferedAmount + bytes > this.#maxBufferedBytes) {
      socket.close(1013, "slow local browser consumer");
      return Promise.reject(
        new BrowserRelayError("The local browser runtime is not consuming commands.", {
          retryable: true,
        }),
      );
    }
    return new Promise<void>((resolve, reject) => {
      socket.send(frame, (error) => (error ? reject(error) : resolve()));
    });
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
