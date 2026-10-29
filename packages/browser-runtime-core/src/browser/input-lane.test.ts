import { expect, it, vi } from "vitest";
import { type BrowserClientMessage, BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { BrowserInputLane } from "./input-lane.js";

it("accounts for every key exactly once when the full 128-entry queue saturates", async () => {
  const held = Promise.withResolvers<void>();
  const execute = vi.fn(async (_message: BrowserClientMessage) => held.promise);
  const refused = vi.fn(async (_message: BrowserClientMessage, _reason: string) => undefined);
  const lane = new BrowserInputLane(128, execute, refused);
  const surfaceId = BrowserSurfaceIdSchema.parse("surface_pressure");
  const key = (sequence: number) => ({
    type: "input.key" as const,
    surfaceId,
    inputSequence: sequence,
    action: "down" as const,
    key: "x",
    code: "KeyX",
    text: "x",
    modifiers: [],
  });
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const active = lane.enqueue(key(0));
  const pending = Array.from({ length: 150 }, (_, index) => lane.enqueue(key(index + 1)));
  try {
    expect(execute).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledTimes(22);
    expect(refused.mock.calls.map(([message]) => message)).toEqual(
      Array.from({ length: 22 }, (_, index) => key(index + 129)),
    );
  } finally {
    held.resolve();
    await Promise.all([active, ...pending]);
    await lane.idle();
    clock.mockRestore();
  }
  expect(execute).toHaveBeenCalledTimes(129);
  expect(execute.mock.calls.map(([message]) => message)).toEqual(
    Array.from({ length: 129 }, (_, index) => key(index)),
  );
  expect(lane.diagnostics.filter((entry) => entry.outcome === "completed")).toHaveLength(129);
});
