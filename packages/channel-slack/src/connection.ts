import {
  ChannelConnectionError,
  ChannelDeliveryError,
  type ChannelConnectionInspection,
  type ChannelTransportKind,
  type NormalizedChannelEvent,
} from "@opensteer/channel-core";
import { rawDataBuffer, type WebSocketFrame } from "@opensteer/shared/webSocketFrame";
import WebSocket from "ws";
import { inspectSlackConnection, openSlackSocket, slackBotAppId } from "./api.js";
import {
  SlackSocketEnvelopeSchema,
  normalizeSlackEvent,
  type SlackSocketEnvelope,
} from "./events.js";

/** The bot scopes the catalog manifest asks for; anything less cannot work. */
export const requiredSlackBotScopes = [
  "channels:history",
  "chat:write",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
] as const;

/**
 * The part of a `ws` socket this adapter uses. Naming it keeps the socket
 * injectable, so the Socket Mode loop is exercised by a unit test instead of a
 * live connection to Slack.
 */
export interface SlackWebSocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: WebSocketFrame, isBinary: boolean) => void): unknown;
  once(event: "open" | "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  send(data: string): void;
}

export type SlackWebSocketFactory = (url: URL) => SlackWebSocket;

export const openSlackWebSocket: SlackWebSocketFactory = (url) =>
  new WebSocket(url, { maxPayload: 1 * 1_024 * 1_024, perMessageDeflate: false });

export async function inspectSlackSetup(
  credentials: Readonly<Record<string, string>>,
  transportKind: ChannelTransportKind,
  fetch_: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<ChannelConnectionInspection> {
  const botToken = credentials.botToken?.trim();
  const appToken = credentials.appToken?.trim();
  const issues: ChannelConnectionInspection["issues"][number][] = [];
  if (transportKind !== "socket") {
    issues.push({
      code: "slack.unsupported_transport",
      kind: "configuration",
      message: "This Slack adapter requires Socket Mode.",
      missing: ["socket"],
    });
  }
  if (!botToken || !botToken.startsWith("xoxb-")) {
    issues.push({
      code: "slack.bot_token_required",
      kind: "credentials",
      message: "Add a valid Slack Bot User OAuth token.",
      missing: ["botToken"],
    });
  }
  if (!appToken || !appToken.startsWith("xapp-")) {
    issues.push({
      code: "slack.app_token_required",
      kind: "credentials",
      message: "Add a valid Slack app-level token for Socket Mode.",
      missing: ["appToken"],
    });
  }
  if (issues.length > 0 || !botToken || !appToken) {
    return { capabilities: [], identity: null, issues, ready: false };
  }

  let installation: Awaited<ReturnType<typeof inspectSlackConnection>>;
  try {
    // Both tokens are checked, because either one alone leaves the connection
    // half-working in a way the person cannot see.
    [installation] = await Promise.all([
      inspectSlackConnection(botToken, fetch_),
      openSlackSocket(appToken, fetch_),
    ]);
  } catch (error) {
    if (error instanceof ChannelDeliveryError && error.kind === "dead") {
      return {
        capabilities: [],
        identity: null,
        issues: [
          {
            code: "slack.credentials_rejected",
            kind: "credentials",
            message: error.message,
            missing: [],
          },
        ],
        ready: false,
      };
    }
    throw new ChannelConnectionError(
      {
        code: "slack.inspection_unavailable",
        kind: "transport",
        message: error instanceof Error ? error.message : "Slack could not be reached.",
        missing: [],
      },
      { cause: error, retryable: true },
    );
  }

  const missingScopes = requiredSlackBotScopes.filter(
    (scope) => !installation.grantedScopes.includes(scope),
  );
  if (missingScopes.length > 0) {
    issues.push({
      code: "slack.bot_scopes_missing",
      kind: "permissions",
      message: "Reinstall the Slack app to grant its updated bot permissions.",
      missing: [...missingScopes],
    });
  }
  const capabilities = [
    ...(installation.grantedScopes.includes("chat:write") ? ["messages.send"] : []),
    ...(missingScopes.length === 0 ? ["messages.receive", "threads"] : []),
  ];
  return {
    capabilities,
    identity: {
      accountDisplayName: installation.botDisplayName,
      connectionDisplayName: `${installation.botDisplayName} · ${installation.teamName}`,
      externalAccountId: installation.teamId,
      externalIdentityId: installation.botUserId,
      handle: installation.botHandle,
      metadata: {
        botUserId: installation.botUserId,
        grantedScopes: installation.grantedScopes,
        teamName: installation.teamName,
      },
    },
    issues,
    ready: issues.length === 0,
  };
}

export interface SlackConnectionRunInput {
  readonly credentials: Readonly<Record<string, string>>;
  readonly displayName: (botToken: string, externalUserId: string) => Promise<string>;
  readonly expectedAccountExternalId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly onEvent: (event: NormalizedChannelEvent) => Promise<void>;
  readonly onReady: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly transportKind: ChannelTransportKind;
  readonly webSocket: SlackWebSocketFactory;
}

/**
 * Hold one Socket Mode connection open.
 *
 * `auth.test` runs once, to learn which user id a mention has to name, and
 * `apps.connections.open` runs once, because each call mints a single-use
 * endpoint. Nothing here inspects the installation again: that is what
 * `connection.inspect` is for, and doing it here opened a second socket per
 * connect that Slack counted against the app.
 */
export async function runSlackSocketConnection(input: SlackConnectionRunInput): Promise<void> {
  if (input.transportKind !== "socket") {
    throw new ChannelConnectionError({
      code: "slack.unsupported_transport",
      kind: "configuration",
      message: "This Slack adapter requires Socket Mode.",
      missing: ["socket"],
    });
  }
  const botToken = input.credentials.botToken;
  const appToken = input.credentials.appToken;
  if (!botToken || !appToken) {
    throw new ChannelConnectionError({
      code: "slack.tokens_required",
      kind: "credentials",
      message: "The Slack bot and app-level tokens are unavailable.",
      missing: [...(botToken ? [] : ["botToken"]), ...(appToken ? [] : ["appToken"])],
    });
  }

  const installation = await inspectSlackConnection(botToken, input.fetch).catch(
    (error: unknown) => {
      throw connectionErrorFrom(error, "slack.bot_token_rejected", "credentials");
    },
  );
  if (installation.teamId !== input.expectedAccountExternalId) {
    throw new ChannelConnectionError({
      code: "slack.account_mismatch",
      kind: "configuration",
      message: "These credentials belong to a different Slack workspace.",
      missing: [],
    });
  }
  const botAppId = await slackBotAppId(botToken, installation.botId, input.fetch).catch(
    (error: unknown) => {
      throw connectionErrorFrom(error, "slack.bot_app_unavailable", "credentials");
    },
  );
  input.signal.throwIfAborted();
  const url = await openSlackSocket(appToken, input.fetch).catch((error: unknown) => {
    throw connectionErrorFrom(error, "slack.socket_open_failed", "transport");
  });

  const socket = input.webSocket(url);
  const abort = () => socket.close(1_000, "Connection stopped");
  input.signal.addEventListener("abort", abort, { once: true });
  let disconnectRequested = false;
  let ready = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForSocketOpen(socket, input.signal);
    let tail = Promise.resolve();
    await new Promise<void>((resolve, reject) => {
      helloTimer = setTimeout(
        () =>
          reject(
            new ChannelConnectionError(
              {
                code: "slack.hello_timeout",
                kind: "transport",
                message: "Slack did not finish opening Socket Mode. Retrying the connection.",
                missing: [],
              },
              { retryable: true },
            ),
          ),
        15_000,
      );
      helloTimer.unref();
      socket.on("message", (raw, isBinary) => {
        tail = tail.then(async () => {
          const envelope = readEnvelope(raw, isBinary);
          if (!envelope) return;
          if (envelope.type === "hello") {
            if (ready) return;
            if (envelope.connection_info?.app_id !== botAppId) {
              throw new ChannelConnectionError({
                code: "slack.app_mismatch",
                kind: "credentials",
                message:
                  "The bot token and app-level token belong to different Slack apps. Copy both tokens from the same app.",
                missing: [],
              });
            }
            clearTimeout(helloTimer);
            ready = true;
            await input.onReady();
            return;
          }
          if (envelope.type === "disconnect") {
            disconnectRequested = true;
            socket.close(1_000, envelope.reason?.slice(0, 123) ?? "Slack requested reconnect");
            return;
          }
          if (!ready)
            throw new ChannelConnectionError(
              {
                code: "slack.hello_required",
                kind: "transport",
                message: "Slack sent events before identifying this Socket Mode connection.",
                missing: [],
              },
              { retryable: true },
            );
          if (!envelope.envelope_id) return;
          if (envelope.type !== "events_api") {
            // Interactions, slash commands and rate-limit notices are not this
            // adapter's business, but an unacknowledged envelope is retried.
            socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            return;
          }
          const event = await normalizeSlackEvent(envelope.payload, {
            botUserId: installation.botUserId,
            displayName: (externalUserId) => input.displayName(botToken, externalUserId),
            receivedAt: new Date(),
          });
          if (event && event.accountExternalId !== input.expectedAccountExternalId) {
            throw new ChannelConnectionError({
              code: "slack.event_account_mismatch",
              kind: "configuration",
              message: "Slack delivered an event for a different workspace.",
              missing: [],
            });
          }
          if (event) {
            try {
              await input.onEvent(event);
            } catch (error) {
              // The Host could not record it. Leaving the envelope unacknowledged
              // is what makes Slack send it again; dropping the socket would only
              // delay that and lose every other conversation with it.
              reportSlackError("channel-slack.ingress-rejected", error, {
                eventId: event.eventId,
              });
              return;
            }
          }
          socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        });
        // The serial tail is also the failure path: once it rejects, every
        // later `message` handler chains onto that rejected promise, so its
        // body never runs and the envelope is left unacknowledged — which is
        // what we want, because this rejection is already closing the socket.
        void tail.catch(reject);
      });
      socket.once("close", () => void tail.then(resolve, reject));
      socket.once("error", reject);
    });
  } finally {
    clearTimeout(helloTimer);
    input.signal.removeEventListener("abort", abort);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      socket.close();
  }
  // Slack asks every connection to move periodically. That is routine, so the
  // supervisor reconnects without the session ever being reported unhealthy.
  if (disconnectRequested || input.signal.aborted) return;
  throw new ChannelConnectionError(
    {
      code: "slack.socket_disconnected",
      kind: "transport",
      message: "Slack Socket Mode disconnected.",
      missing: [],
    },
    { retryable: true },
  );
}

/**
 * A frame this adapter cannot read is not a reason to drop the socket: Slack
 * adds envelope shapes over time, and the next frame is probably ordinary.
 */
function readEnvelope(raw: WebSocketFrame, isBinary: boolean): SlackSocketEnvelope | null {
  if (isBinary) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(rawDataBuffer(raw).toString("utf8"));
  } catch {
    return null;
  }
  const parsed = SlackSocketEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function connectionErrorFrom(
  error: unknown,
  code: string,
  kind: "credentials" | "transport",
): ChannelConnectionError {
  const retryable = !(error instanceof ChannelDeliveryError && error.kind === "dead");
  return new ChannelConnectionError(
    {
      code,
      kind: retryable ? "transport" : kind,
      message: error instanceof Error ? error.message : "Slack could not be reached.",
      missing: [],
    },
    { cause: error, retryable },
  );
}

function reportSlackError(
  event: string,
  error: unknown,
  details: Readonly<Record<string, unknown>>,
): void {
  const message = error instanceof Error ? error.message.slice(0, 500) : "Slack event failed";
  process.stderr.write(`${JSON.stringify({ ...details, event, message })}\n`);
}

async function waitForSocketOpen(socket: SlackWebSocket, signal: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Slack Socket Mode timed out")), 15_000);
    timer.unref();
    const abort = () => reject(signal.reason ?? new Error("Slack connection stopped"));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("open", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}
