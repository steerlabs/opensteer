import { normalizeToolOutput } from "@opensteer/core";
import { expect, it } from "vitest";
import { readCardUseResult } from "./cards.js";
import {
  mockCardUseScenario,
  mockCardUseRequest,
  MockHostClient,
} from "../mock/mock-host-client.js";
import { passwordSignInOutcome } from "./passwords.js";
import { requestReceipt } from "./transcript.js";

it("settles card consent without reporting a login or payment and keeps choices transient", async () => {
  const request = mockCardUseRequest();
  const client = new MockHostClient({ latencyMs: 0, pendingRequests: [request] });
  try {
    const read = await client.rpc["browser.password-sign-in.get"]({ requestId: request.id });
    if (!read.ok || read.data.stage !== "card-approval") throw new Error("Missing card chooser");
    const card = read.data.cards[0]!;
    expect(JSON.stringify(client.getSnapshot())).not.toContain(card.label);
    await expect(
      client.dispatch({
        type: "browser.password-sign-in.respond",
        requestId: request.id,
        idempotencyKey: "wrong-kind",
        decision: {
          kind: "approve",
          loginId: card.id,
          revision: card.revision,
          remember: true,
          permissionVersion: 6,
        },
      }),
    ).rejects.toThrow();
    const result = await client.dispatch({
      type: "browser.password-sign-in.respond",
      requestId: request.id,
      idempotencyKey: "card",
      decision: {
        kind: "approve-card",
        cardId: card.id,
        revision: card.revision,
        permissionVersion: 7,
      },
    });
    expect(result).toMatchObject({ status: "fulfilled" });
    expect(JSON.stringify(client.getSnapshot())).not.toContain(card.label);
    const resolved = mockCardUseRequest({
      status: "fulfilled",
      response: { outcome: "authorized", account: "Visa ending 4242" },
    });
    const outcome = passwordSignInOutcome(resolved);
    expect(outcome?.text).toContain("Allowed card use");
    expect(outcome?.text).not.toMatch(/sign.?in|paid|purchased/iu);
    if (resolved.status !== "fulfilled") throw new Error("Expected settlement");
    expect(requestReceipt(resolved).title).not.toMatch(/sign.?in/iu);
  } finally {
    client.dispose();
  }
});
it("refuses stale selections and exposes an empty chooser without persisting metadata", async () => {
  const request = mockCardUseRequest();
  const client = new MockHostClient({ latencyMs: 0, pendingRequests: [request] });
  try {
    client.cardUseMockStates.set(request.id, "changed");
    const changed = await client.dispatch({
      type: "browser.password-sign-in.respond",
      requestId: request.id,
      idempotencyKey: "stale-card",
      decision: {
        kind: "approve-card",
        cardId: "00000000-0000-4000-8000-000000000042",
        revision: 1,
        permissionVersion: 7,
      },
    });
    expect(changed).toMatchObject({
      status: "pending",
      card: { stage: "card-approval", cards: [{ revision: 2 }] },
    });
    client.cardUseMockStates.set(request.id, "no-card");
    expect(
      await client.rpc["browser.password-sign-in.get"]({ requestId: request.id }),
    ).toMatchObject({ ok: true, data: { stage: "card-approval", cards: [] } });
    for (const state of ["expired", "declined", "gone", "off", "not-set-up"] as const) {
      client.cardUseMockStates.set(request.id, state);
      expect(
        await client.rpc["browser.password-sign-in.get"]({ requestId: request.id }),
      ).toMatchObject({ ok: true, data: { stage: "gone" } });
    }
  } finally {
    client.dispose();
  }
});

it.each(["no-card", "off", "not-set-up"] as const)(
  "returns actionable %s without opening a Request",
  (state) => {
    const scenario = mockCardUseScenario(state);
    expect(scenario.request).toBeNull();
    expect(scenario.result.status).toBe("unavailable");
  },
);

it("reads a held card result with its outcome prose after it", () => {
  const record = { status: "declined", site: "https://example.com" };
  const { text } = normalizeToolOutput({
    content: [
      { type: "text", text: JSON.stringify(record) },
      { type: "text", text: "The person declined this card." },
    ],
  });
  expect(readCardUseResult(text)).toEqual(record);
});
