import { describe, expect, it } from "vitest";
import { requestSettlementLabel } from "./request-settlement.js";
import { createId } from "@opensteer/core";

it("names an agent answer without attributing a human decision", () => {
  const settlementProvenance = {
    kind: "agent" as const,
    runId: createId("run"),
    threadId: createId("thread"),
    title: "Research lead",
  };
  expect(requestSettlementLabel({ status: "fulfilled", settlementProvenance })).toBe(
    "Answered by Research lead",
  );
  expect(requestSettlementLabel({ status: "declined", settlementProvenance })).toBe(
    "Answered by Research lead",
  );
  expect(requestSettlementLabel({ status: "pending", settlementProvenance })).toBeNull();
});

describe("Request settlement label", () => {
  it("names the human device for allowed and declined computer app access", () => {
    const settlementProvenance = { deviceLabel: "iPhone" };
    expect(requestSettlementLabel({ status: "fulfilled", settlementProvenance })).toBe(
      "Allowed on iPhone",
    );
    expect(requestSettlementLabel({ status: "declined", settlementProvenance })).toBe(
      "Declined on iPhone",
    );
    expect(requestSettlementLabel({ status: "pending", settlementProvenance })).toBeNull();
    expect(requestSettlementLabel({ status: "cancelled", settlementProvenance })).toBeNull();
    expect(requestSettlementLabel({ status: "fulfilled", settlementProvenance: null })).toBeNull();
  });
});
