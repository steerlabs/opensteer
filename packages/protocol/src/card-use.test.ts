import { describe, expect, it } from "vitest";
import { CardApprovalSchema, CardFieldSchema, CardRefSchema } from "./card-use.js";
import { passwordsBrokerRequests, passwordsBrokerResults } from "./passwords-broker.js";

const transactionId = "00000000-0000-4000-8000-000000000001";
const card = {
  id: transactionId,
  revision: 1,
  brand: "Visa",
  lastFour: "4242",
  label: null,
  expiryMonth: 1,
  expiryYear: 2030,
};

describe("card broker isolation", () => {
  it("accepts strict v7 requests without widening legacy login shapes", () => {
    const request = {
      protocolVersion: 7,
      permissionVersion: 7,
      transactionId,
      expiresAt: "2030-01-01T00:00:00.000Z",
      site: "https://example.com",
      workspaceId: "wsp_00000000-0000-4000-8000-000000000002",
      deploymentId: "test",
      deploymentName: "Test",
      workspaceName: "Main",
      threadTitle: "Checkout",
      reason: "Fill checkout",
    };
    expect(passwordsBrokerRequests["card.request"].safeParse(request).success).toBe(true);
    expect(passwordsBrokerRequests["signin.request"].safeParse(request).success).toBe(false);
    for (const protocolVersion of [4, 5, 6]) {
      expect(
        passwordsBrokerRequests["card.request"].safeParse({ ...request, protocolVersion }).success,
      ).toBe(false);
    }
    expect(
      passwordsBrokerResults["card.request"].safeParse({ decision: "authorized", card }).success,
    ).toBe(false);
    expect(
      passwordsBrokerResults["card.request"].parse({ decision: "approve", cards: [card] }),
    ).toEqual({ decision: "approve", cards: [card] });
  });

  it("requires fresh card approval and rejects login approval and remembered grants", () => {
    const approval = { cardId: transactionId, revision: 1, permissionVersion: 7 };
    expect(CardApprovalSchema.parse(approval)).toEqual(approval);
    expect(CardApprovalSchema.safeParse({ ...approval, remember: false }).success).toBe(false);
    expect(
      passwordsBrokerRequests["signin.approve"].safeParse({ transactionId, ...approval }).success,
    ).toBe(false);
    expect(
      passwordsBrokerRequests["card.approve"].safeParse({
        transactionId,
        loginId: transactionId,
        revision: 1,
        permissionVersion: 5,
        remember: false,
      }).success,
    ).toBe(false);
  });

  it("separates merchant and payment origins and refuses login and app release shapes", () => {
    const release = {
      transactionId,
      topOrigin: "https://shop.example.com",
      frameOrigin: "https://payments.example.net",
      field: "number",
    };
    expect(passwordsBrokerRequests["card.release"].parse(release)).toEqual(release);
    expect(passwordsBrokerRequests["signin.release"].safeParse(release).success).toBe(false);
    for (const change of [
      { kind: "app" },
      { field: "password" },
      { frameOrigin: "about:blank" },
      { topOrigin: "http://example.com" },
    ]) {
      expect(
        passwordsBrokerRequests["card.release"].safeParse({ ...release, ...change }).success,
      ).toBe(false);
    }
    expect(CardFieldSchema.safeParse("billing-city").success).toBe(false);
    expect(CardRefSchema.safeParse(`lgn_${"a".repeat(32)}`).success).toBe(false);
    expect(
      passwordsBrokerResults["card.release"].parse({ released: false, reason: "no-field" }),
    ).toEqual({ released: false, reason: "no-field" });
  });
});
