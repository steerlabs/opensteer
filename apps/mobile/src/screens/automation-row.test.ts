import type { ScheduleItem } from "@opensteer/client/host";
import { describe, expect, it } from "vitest";
import { automationRow } from "./automation-row.js";

function watch(observed: NonNullable<ScheduleItem["watch"]>["observed"]): ScheduleItem {
  return {
    anchor: { home: true, title: "Chat", visible: true },
    kind: "watch",
    latestOccurrence: null,
    name: "Downloads folder",
    nextFireAt: null,
    pauseReason: null,
    source: { kind: "watch" },
    status: "active",
    updatedAt: new Date(0).toISOString(),
    waitingReason: null,
    watch: { lastError: null, observed },
  } as unknown as ScheduleItem;
}

describe("a watch's row", () => {
  it("reads as active only while it is running", () => {
    const now = Date.now();
    expect(automationRow(watch("running"), null, now).trailing).toEqual({
      kind: "state",
      text: "Watching",
      tone: "accent",
    });
    expect(automationRow(watch("expired"), null, now).trailing).toEqual({
      kind: "state",
      text: "Waiting for its computer",
      tone: "warn",
    });
    expect(automationRow(watch("stopped"), null, now).trailing).toMatchObject({ tone: "muted" });
  });
});
