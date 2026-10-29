import { describe, expect, it } from "vitest";
import { reconcileSlackDelivery, sendSlackDelivery } from "./outbound.js";
import { delivery, destination, lease } from "./test-fixtures.js";

describe("sendSlackDelivery", () => {
  it("posts an actor message normally in a direct message, where nothing else is visible", async () => {
    const calls: { body: unknown; url: string }[] = [];
    const fetch_ = respond(calls, () => ok({ channel: "D1", ts: "1.1" }));
    await sendSlackDelivery(
      {
        delivery: delivery({ audience: "actor", kind: "status" }),
        destination: destination({ externalConversationId: "D1", externalUserId: "U1" }),
        lease: lease(),
        signal: AbortSignal.timeout(1_000),
      },
      fetch_,
    );
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
  });

  it("gives up on refusals that will never change", async () => {
    for (const code of ["channel_not_found", "not_in_channel", "is_archived", "missing_scope"]) {
      const fetch_ = respond([], () => ok({}, { error: code, ok: false }));
      await expect(
        sendSlackDelivery(
          {
            delivery: delivery(),
            destination: destination(),
            lease: lease(),
            signal: AbortSignal.timeout(1_000),
          },
          fetch_,
        ),
      ).rejects.toMatchObject({ kind: "dead" });
    }
  });
});

describe("reconcileSlackDelivery", () => {
  it("will not take an unstamped message for this delivery, however alike it looks", async () => {
    const fetch_ = respond([], () =>
      ok({
        messages: [
          { bot_id: "B1", text: "hello", ts: "1786320000.000100" },
          { text: "unrelated", ts: "1786320000.000200", user: "U1" },
        ],
      }),
    );
    await expect(
      reconcileSlackDelivery(
        {
          delivery: delivery(),
          destination: destination(),
          lease: lease(),
          signal: AbortSignal.timeout(1_000),
        },
        fetch_,
      ),
    ).resolves.toEqual({ kind: "unknown" });
  });

  it("cannot reconcile an ephemeral message, which Slack never stores", async () => {
    const fetch_: typeof fetch = async () => {
      throw new Error("no Slack call should be made");
    };
    await expect(
      reconcileSlackDelivery(
        {
          delivery: delivery({ audience: "actor", kind: "status" }),
          destination: destination({ externalUserId: "U1" }),
          lease: lease(),
          signal: AbortSignal.timeout(1_000),
        },
        fetch_,
      ),
    ).resolves.toEqual({ kind: "unknown" });
  });
});

function ok(result: Record<string, unknown>, override?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...result, ...override }), {
    headers: { "content-type": "application/json" },
    status: 200,
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
