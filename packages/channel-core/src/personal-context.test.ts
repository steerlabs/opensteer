import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { channelAllowsPersonalContext } from "./personal-context.js";

it("keeps shared and non-owner Messaging input outside private personal context", () => {
  const ownerId = createId("user");
  expect(
    channelAllowsPersonalContext({ conversationType: "dm", linkedSenderId: ownerId, ownerId }),
  ).toBe(true);
  for (const conversationType of ["group", "channel"] as const)
    expect(
      channelAllowsPersonalContext({ conversationType, linkedSenderId: ownerId, ownerId }),
    ).toBe(false);
  for (const linkedSenderId of [null, createId("user")])
    expect(channelAllowsPersonalContext({ conversationType: "dm", linkedSenderId, ownerId })).toBe(
      false,
    );
});
