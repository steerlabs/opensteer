import { describe, expect, it } from "vitest";
import { sendSlackDelivery } from "./outbound.js";
import { delivery, destination, lease } from "./test-fixtures.js";

const send = (fetch_: typeof fetch) =>
  sendSlackDelivery(
    {
      delivery: delivery(),
      destination: destination(),
      lease: lease(),
      signal: AbortSignal.timeout(1_000),
    },
    fetch_,
  );

describe("sendSlackDelivery", () => {
  it("posts one message where the delivery came from, and nothing else", async () => {
    const calls: { body: unknown; url: string }[] = [];
    const fetch_ = respond(calls, () => ok({ channel: "C1", ts: "1.1" }));
    await expect(send(fetch_)).resolves.toEqual({ receipt: { channel: "C1", ts: "1.1" } });
    expect(calls.map(({ url }) => url)).toEqual(["https://slack.com/api/chat.postMessage"]);
  });

  it("gives up on refusals that will never change", async () => {
    for (const code of ["channel_not_found", "not_in_channel", "is_archived", "missing_scope"]) {
      const fetch_ = respond([], () => ok({}, { error: code, ok: false }));
      await expect(send(fetch_)).rejects.toMatchObject({ kind: "dead" });
    }
  });

  it("retries only a rate limit, after the delay Slack names", async () => {
    await expect(
      send(
        respond([], () => slack(429, { error: "ratelimited", ok: false }, { "retry-after": "7" })),
      ),
    ).rejects.toMatchObject({ kind: "retryable", retryAfterSeconds: 7 });
    await expect(
      send(respond([], () => ok({}, { error: "ratelimited", ok: false }))),
    ).rejects.toMatchObject({ kind: "retryable" });
  });

  it("leaves Slack's own trouble unknown, since the message may already be posted", async () => {
    const answers: Array<() => Response> = [
      () => slack(500, { error: "internal_error", ok: false }),
      () => slack(503, { ok: false }),
      () => ok({}, { error: "internal_error", ok: false }),
      () => ok({}, { error: "fatal_error", ok: false }),
      () => ok({}, { error: "request_timeout", ok: false }),
      () => ok({}, { error: "service_unavailable", ok: false }),
      () => new Response("<html>gateway</html>", { status: 504 }),
    ];
    for (const answer of answers)
      await expect(send(respond([], answer))).rejects.toMatchObject({ kind: "unknown" });
    // A request that never got an answer at all.
    await expect(
      send(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    ).rejects.toMatchObject({ kind: "unknown" });
  });
});

function ok(result: Record<string, unknown>, override?: Record<string, unknown>): Response {
  return slack(200, { ok: true, ...result, ...override });
}

function slack(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function respond(
  calls: { body: unknown; url: string }[],
  handler: (url: string) => Response,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const body = init?.body;
    calls.push({ body: typeof body === "string" ? JSON.parse(body) : undefined, url });
    return handler(url);
  };
}
