import type { UserId } from "@opensteer/core";

export function channelAllowsPersonalContext(input: {
  readonly conversationType: "dm" | "group" | "channel";
  readonly linkedSenderId: UserId | null;
  readonly ownerId: UserId;
}): boolean {
  return input.conversationType === "dm" && input.linkedSenderId === input.ownerId;
}
