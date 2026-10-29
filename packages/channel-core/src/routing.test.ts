import { describe, expect, it } from "vitest";
import { assertUnambiguousBinding, resolveChannelBinding } from "./routing.js";
import type { ChannelBinding, RouteCandidate } from "./models.js";

const candidate: RouteCandidate = {
  conversationId: "C-support",
  conversationType: "channel",
  scopeId: "T-acme",
  threadId: null,
};

function binding(id: string, selector: Partial<ChannelBinding["selector"]>): ChannelBinding {
  return {
    accessPolicy: {
      channels: {
        scope: "all",
        conversationIds: [],
        sender: { allowedExternalUserIds: [], mode: "linked-members" },
      },
      directMessages: { allowedExternalUserIds: [], mode: "linked-members" },
    },
    accountId: "cha_00000000-0000-4000-8000-000000000001" as ChannelBinding["accountId"],
    createdAt: "2026-08-10T00:00:00.000Z",
    createdBy: "usr_00000000-0000-4000-8000-000000000001" as ChannelBinding["createdBy"],
    executionPolicy: { harness: "default", harnessInstanceId: null },
    id: id as ChannelBinding["id"],
    revision: 1,
    selector: {
      conversationId: null,
      conversationType: null,
      scopeId: null,
      threadId: null,
      ...selector,
    },
    status: "active",
    updatedAt: "2026-08-10T00:00:00.000Z",
    workspaceId: "wsp_00000000-0000-4000-8000-000000000001" as ChannelBinding["workspaceId"],
  };
}

describe("channel routing", () => {
  it("selects the most specific matching binding", () => {
    const fallback = binding("chb_00000000-0000-4000-8000-000000000001", { scopeId: "T-acme" });
    const support = binding("chb_00000000-0000-4000-8000-000000000002", {
      conversationId: "C-support",
      scopeId: "T-acme",
    });
    expect(resolveChannelBinding([fallback, support], candidate)?.id).toBe(support.id);
  });

  it("rejects equal-specificity routes that can match the same conversation", () => {
    const left = binding("chb_00000000-0000-4000-8000-000000000001", { scopeId: "T-acme" });
    const right = binding("chb_00000000-0000-4000-8000-000000000002", {
      conversationType: "channel",
    });
    expect(() => assertUnambiguousBinding(right, [left])).toThrow(/equal specificity/);
  });

  it("permits equal-specificity routes that cannot overlap", () => {
    const support = binding("chb_00000000-0000-4000-8000-000000000001", {
      conversationId: "C-support",
    });
    const sales = binding("chb_00000000-0000-4000-8000-000000000002", {
      conversationId: "C-sales",
    });
    expect(() => assertUnambiguousBinding(sales, [support])).not.toThrow();
  });
});
