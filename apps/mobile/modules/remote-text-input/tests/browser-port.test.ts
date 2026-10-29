import { BrowserEditingStore, type BrowserCommand } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import { createMobileBrowserEditing } from "../../../src/browser/browser-editing.js";
const surface = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000001");
it("uses the shared negotiated target and writes only activated clipboard results", async () => {
  const send = vi.fn((_command: BrowserCommand) => true);
  const editing = new BrowserEditingStore((_session, _surface, command) => send(command));
  const write = vi.fn(async () => "written" as const);
  const target = createMobileBrowserEditing(
    { browserFrames: { editing } },
    "session",
    surface,
    send,
    { write },
  );
  editing.negotiate("session", 1);
  expect(target.get().negotiated).toBe(true);
  const stop = target.activate(() => undefined);
  const result = target.send({ kind: "copy" });
  const command = send.mock.calls[0]?.[0];
  if (command?.type !== "clipboard.copy") throw new Error("No copy operation was sent.");
  const operationId = command.operationId;
  editing.receive("session", {
    type: "clipboard.result",
    surfaceId: surface,
    operationId,
    outcome: "copied",
    items: [{ type: "text/plain", size: 2 }],
  });
  editing.receive("session", {
    type: "clipboard.part",
    part: { operationId, index: 0, data: "aGk=" },
  });
  expect(result).toBe(true);
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(write).toHaveBeenCalledExactlyOnceWith([
    { type: "text/plain", bytes: new TextEncoder().encode("hi") },
  ]);
  stop();
  await target.send({ kind: "copy" });
  expect(write).toHaveBeenCalledOnce();
});
it("uses shared exact legacy projection and reports synchronous admission refusal", async () => {
  const send = vi.fn((_command: BrowserCommand) => true);
  const target = createMobileBrowserEditing({}, "session", surface, send, {
    write: async () => "written",
  });
  const stop = target.activate(() => undefined);
  await target.send({
    kind: "edit",
    edit: { contextId: "legacy", before: "", after: "", text: "hello" },
  });
  await target.send({
    kind: "key",
    keystroke: { action: "down", key: "a", code: "KeyA", text: "a", modifiers: [] },
  });
  expect(send.mock.calls.map(([command]) => command)).toEqual([
    { type: "clipboard.paste", surfaceId: surface, text: "hello" },
    {
      type: "input.key",
      surfaceId: surface,
      action: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: [],
    },
  ]);
  send.mockReturnValue(false);
  expect(
    target.send({ kind: "edit", edit: { contextId: "legacy", before: "", after: "", text: "x" } }),
  ).toBe(false);
  stop();
});
