import { expect, it } from "vitest";
import { taskView } from "./personal-snapshot-store.js";

const task = (runStartHoldReason: "previous-stop-unconfirmed" | "waiting-for-run" | null) =>
  taskView({
    askedAt: new Date(0),
    doneAt: null,
    externalWork: null,
    latestRunCompletedAt: null,
    originConnectionId: null,
    runStartHoldReason,
  } as unknown as Parameters<typeof taskView>[0]);

it("sends a Run waiting for another as its own field, which apps inside the wire window ignore", () => {
  expect(task("waiting-for-run")).toMatchObject({ runWaitingForRun: true });
  expect(task("waiting-for-run")).not.toHaveProperty("runStartHoldReason");
  // The stop hold every app knows is sent as it was.
  expect(task("previous-stop-unconfirmed")).toMatchObject({
    runStartHoldReason: "previous-stop-unconfirmed",
  });
  expect(task("previous-stop-unconfirmed")).not.toHaveProperty("runWaitingForRun");
  expect(task(null)).not.toHaveProperty("runStartHoldReason");
});
