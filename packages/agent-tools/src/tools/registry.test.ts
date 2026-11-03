import { describe, expect, it } from "vitest";
import { agentTools } from "./index.js";
import { person_message } from "./person.js";
import { trigger_write } from "./triggers.js";

describe("Opensteer tool registry", () => {
  it("has one specification per product and integration tool", () => {
    expect(agentTools).toHaveLength(35);
    expect(new Set(agentTools.map(({ name }) => name)).size).toBe(35);
    const runs = agentTools.filter((t) => t.callers.some((c) => c === "run")).map((t) => t.name);
    expect(runs).toContain("integration_call");
    expect(runs).toContain("thread_delegate");
    const programs = agentTools
      .filter((t) => t.callers.some((c) => c === "program"))
      .map((t) => t.name);
    expect(programs).toContain("thread_delegate");
    expect(programs).not.toContain("person_show");
    expect(programs).not.toContain("computer");
  });
  it("strips an unnamed secret from a tool result", () => {
    expect(
      person_message.output.parse({
        messageId: "msg_11111111-1111-4111-8111-111111111111",
        surpriseSecret: "never leave the Host",
      }),
    ).not.toHaveProperty("surpriseSecret");
  });
  it("retains safe Trigger details and cancellation receipts", () => {
    const detail = {
      activation: null,
      anchorThreadTitle: "Anchor",
      createdByThreadTitle: null,
      downstreamRuns: [],
      downstreamRunsTruncated: false,
      canceledOccurrenceIds: ["toc_11111111-1111-4111-8111-111111111111"],
    };
    expect(trigger_write.output.parse({ ...detail, unnamedSecret: "hidden" })).toEqual(detail);
  });
  it("does not expose webhook credentials", () => {
    expect(
      trigger_write.output.parse({
        webhook: { secret: "oswh_private", url: "https://example.test/private" },
      }),
    ).toEqual({});
  });
});
