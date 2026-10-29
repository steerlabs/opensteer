import { describe, expect, it } from "vitest";
import { ChannelAccessPolicySchema, ChannelBindingViewSchema } from "./models.js";
import { ChannelAccountIdSchema, ChannelBindingIdSchema } from "./ids.js";
import { createId } from "@opensteer/core";

const policy = {
  channels: {
    conversationIds: ["C123"],
    scope: "selected",
    sender: { allowedExternalUserIds: [], mode: "anyone" },
  },
  directMessages: { allowedExternalUserIds: [], mode: "owner" },
};

describe("channel admission contract", () => {
  it("refuses legacy and ambiguous policy commands instead of widening them", () => {
    expect(
      ChannelAccessPolicySchema.safeParse({ mode: "anyone", allowedExternalUserIds: [] }).success,
    ).toBe(false);
    expect(ChannelAccessPolicySchema.safeParse({ ...policy, mode: "anyone" }).success).toBe(false);
    expect(
      ChannelAccessPolicySchema.safeParse({ ...policy, directMessages: { mode: "selected" } })
        .success,
    ).toBe(false);
    expect(
      ChannelAccessPolicySchema.safeParse({
        ...policy,
        channels: { ...policy.channels, conversationIds: [""] },
      }).success,
    ).toBe(false);
  });

  it("tolerates future response fields at every policy boundary", () => {
    const binding = ChannelBindingViewSchema.parse({
      accessPolicy: {
        ...policy,
        future: true,
        channels: {
          ...policy.channels,
          future: true,
          sender: { ...policy.channels.sender, future: true },
        },
        directMessages: { ...policy.directMessages, future: true },
      },
      accountId: ChannelAccountIdSchema.parse("cha_00000000-0000-4000-8000-000000000001"),
      createdAt: new Date().toISOString(),
      createdBy: createId("user"),
      executionPolicy: { harness: "default", harnessInstanceId: null },
      id: ChannelBindingIdSchema.parse("chb_00000000-0000-4000-8000-000000000001"),
      revision: 1,
      selector: { conversationId: null, conversationType: null, scopeId: null, threadId: null },
      status: "active",
      updatedAt: new Date().toISOString(),
      workspaceId: createId("workspace"),
    });
    expect(binding.accessPolicy).toEqual(policy);
  });
});
