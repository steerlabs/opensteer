import type { NormalizedChannelEvent } from "@opensteer/channel-core";
import type { WebSocketFrame } from "@opensteer/shared/webSocketFrame";
import { describe, expect, it, vi } from "vitest";
import { inspectSlackSetup, runSlackSocketConnection, type SlackWebSocket } from "./connection.js";

describe("inspectSlackSetup", () => {
  it("names every missing bot scope rather than the first one", async () => {
    await expect(
      inspectSlackSetup(
        { appToken: "xapp-test", botToken: "xoxb-test" },
        "socket",
        slackFetch({ scopes: "chat:write" }),
      ),
    ).resolves.toMatchObject({
      issues: [
        {
          code: "slack.bot_scopes_missing",
          kind: "permissions",
          missing: [
            "channels:history",
            "groups:history",
            "im:history",
            "mpim:history",
            "users:read",
          ],
        },
      ],
      ready: false,
    });
  });

  it("reports a ready installation with the bot identity mentions are matched against", async () => {
    await expect(
      inspectSlackSetup({ appToken: "xapp-test", botToken: "xoxb-test" }, "socket", slackFetch()),
    ).resolves.toMatchObject({
      identity: { externalAccountId: "T1", externalIdentityId: "U0BOT" },
      ready: true,
    });
  });
});

describe("runSlackSocketConnection", () => {
  it("rejects valid tokens from different Slack apps before reporting connected", async () => {
    const harness = await connect({ hello: false });
    harness.socket.deliver({ connection_info: { app_id: "A-OTHER" }, type: "hello" });
    await expect(harness.run).rejects.toMatchObject({
      issue: { code: "slack.app_mismatch", kind: "credentials" },
      retryable: false,
    });
    expect(harness.ready).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });

  it("does not admit messages before the socket's app identity is verified", async () => {
    const harness = await connect({ hello: false });
    harness.socket.deliver(eventEnvelope("env-unverified"));
    await expect(harness.run).rejects.toMatchObject({ issue: { code: "slack.hello_required" } });
    expect(harness.events).toEqual([]);
    expect(harness.socket.sent).toEqual([]);
  });

  it("refuses credentials that belong to another workspace before opening a socket", async () => {
    const socket = new FakeSlackSocket();
    await expect(
      runSlackSocketConnection({
        credentials: { appToken: "xapp-test", botToken: "xoxb-test" },
        displayName: async () => "Ada",
        expectedAccountExternalId: "T-OTHER",
        fetch: slackFetch(),
        onEvent: vi.fn(),
        onReady: vi.fn(),
        signal: new AbortController().signal,
        transportKind: "socket",
        webSocket: () => socket,
      }),
    ).rejects.toMatchObject({ issue: { code: "slack.account_mismatch", kind: "configuration" } });
  });

  it("reports a close nobody asked for as a retryable transport fault", async () => {
    const harness = await connect();
    harness.socket.close();
    await expect(harness.run).rejects.toMatchObject({
      issue: { code: "slack.socket_disconnected" },
      retryable: true,
    });
  });
});

class FakeSlackSocket implements SlackWebSocket {
  readonly sent: string[] = [];
  readyState = 1;
  #closed = false;
  readonly #messageListeners: ((data: WebSocketFrame, isBinary: boolean) => void)[] = [];
  readonly #once = new Map<string, (argument?: unknown) => void>();
  #tail = Promise.resolve();

  on(event: "message", listener: (data: WebSocketFrame, isBinary: boolean) => void): unknown {
    if (event === "message") this.#messageListeners.push(listener);
    return this;
  }

  once(event: "open" | "close" | "error", listener: (error: Error) => void): unknown {
    this.#once.set(event, listener as (argument?: unknown) => void);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = 3;
    // A real socket closes after the handler that asked for it has returned.
    this.#tail = this.#tail.then(() => this.#once.get("close")?.());
  }

  deliver(envelope: Record<string, unknown>): void {
    this.deliverRaw(JSON.stringify(envelope));
  }

  deliverRaw(frame: string): void {
    for (const listener of this.#messageListeners) listener(Buffer.from(frame, "utf8"), false);
  }

  get attached(): boolean {
    return this.#messageListeners.length > 0;
  }
}

async function connect(
  overrides: { readonly afterEvent?: () => Promise<void>; readonly hello?: boolean } = {},
) {
  const socket = new FakeSlackSocket();
  const calls: string[] = [];
  const events: NormalizedChannelEvent[] = [];
  const ready = vi.fn(async () => undefined);
  const run = runSlackSocketConnection({
    credentials: { appToken: "xapp-test", botToken: "xoxb-test" },
    displayName: async () => "Ada",
    expectedAccountExternalId: "T1",
    fetch: slackFetch({ calls }),
    onEvent: async (event) => {
      events.push(event);
      await overrides.afterEvent?.();
    },
    onReady: ready,
    signal: new AbortController().signal,
    transportKind: "socket",
    webSocket: () => socket,
  });
  void run.catch(() => undefined);
  await vi.waitFor(() => expect(socket.attached).toBe(true));
  if (overrides.hello !== false) {
    socket.deliver({ connection_info: { app_id: "A1" }, type: "hello" });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  }
  return { calls, events, ready, run, socket };
}

function eventEnvelope(envelopeId: string): Record<string, unknown> {
  return {
    accepts_response_payload: false,
    envelope_id: envelopeId,
    payload: {
      event: {
        channel: "C1",
        channel_type: "channel",
        text: "<@U0BOT> hello",
        ts: `1786320000.000${envelopeId.length}00`,
        type: "message",
        user: "U1",
      },
      event_id: `Ev-${envelopeId}`,
      event_time: 1_786_320_000,
      team_id: "T1",
      type: "event_callback",
    },
    type: "events_api",
  };
}

function slackFetch(
  options: { readonly calls?: string[]; readonly scopes?: string } = {},
): typeof fetch {
  return async (input) => {
    const url = String(input);
    options.calls?.push(url);
    if (url.includes("bots.info")) return Response.json({ ok: true, bot: { app_id: "A1" } });
    if (url.includes("auth.test")) {
      return new Response(
        JSON.stringify({
          bot_id: "B1",
          ok: true,
          team: "Acme",
          team_id: "T1",
          user: "opensteer",
          user_id: "U0BOT",
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes":
              options.scopes ??
              "channels:history,chat:write,groups:history,im:history,mpim:history,users:read",
          },
          status: 200,
        },
      );
    }
    return new Response(JSON.stringify({ ok: true, url: "wss://wss-primary.slack.com/link" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
}
