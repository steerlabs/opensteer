import { describe, expect, it } from "vitest";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { editingClipboardPartMaxBytes } from "@opensteer/protocol/editing";
import { BrowserEditingStore } from "./browser-editing.js";
import type { BrowserCommand } from "./client.js";
const surfaceId = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000001");
const sessionId = "browser-a";
const encoder = new TextEncoder();
function setup(negotiated = true) {
  const commands: BrowserCommand[] = [];
  const store = new BrowserEditingStore(
    (_session, _surface, command) => commands.push(command),
    () => "pc",
  );
  store.negotiate(sessionId, negotiated ? 1 : undefined);
  const target = store.target(sessionId, surfaceId);
  return { store, target, commands };
}
describe("browser editing transport", () => {
  it.each(["mac", "pc", null] as const)(
    "uses runtime primary for v2 text clipboard from %s viewers",
    async (platform) => {
      const commands: BrowserCommand[] = [];
      const store = new BrowserEditingStore(
        (_session, _surface, command) => commands.push(command),
        () => platform,
      );
      store.negotiate(sessionId, 2, undefined, false);
      const target = store.target(sessionId, surfaceId);
      expect(target.get()).toMatchObject({
        negotiated: true,
        abilities: { composition: true, rangeEdits: true, commands: true, clipboard: "text" },
      });
      const contextId = crypto.randomUUID();
      await target.send({
        kind: "compose",
        composition: { contextId, text: "한", selectionStart: 1, selectionEnd: 1 },
      });
      await target.send({ kind: "edit", edit: { contextId, before: "e", after: "", text: "é" } });
      await target.send({ kind: "command", command: "selectAll" });
      expect(commands.map((command) => command.type)).toEqual([
        "input.compose",
        "input.text",
        "input.command",
      ]);
      for (const kind of ["copy", "cut"] as const) {
        const pending = target.send({ kind });
        expect(commands.at(-2)).toMatchObject({
          type: "input.key",
          action: "down",
          key: kind === "copy" ? "c" : "x",
          modifiers: ["primary"],
        });
        store.receive(sessionId, { type: "clipboard.data", surfaceId, text: kind });
        expect(await pending).toEqual({
          outcome: kind === "copy" ? "copied" : "cut",
          items: [{ type: "text/plain", bytes: encoder.encode(kind) }],
        });
      }
      await target.send({
        kind: "paste",
        items: [{ type: "text/plain", bytes: encoder.encode("text") }],
      });
      expect(commands.at(-1)).toEqual({ type: "clipboard.paste", surfaceId, text: "text" });
      await expect(
        target.send({ kind: "paste", items: [{ type: "image/png", bytes: new Uint8Array([1]) }] }),
      ).rejects.toThrow("rich");
      store.dispose();
    },
  );
  it.each([1, 2] as const)("retains full clipboard for version %s", async (version) => {
    const { store, target, commands } = setup();
    store.negotiate(sessionId, version, undefined, version === 2 ? true : undefined);
    expect(target.get().abilities.clipboard).toBe("full");
    const pending = target.send({ kind: "copy" });
    const command = commands.at(-1);
    expect(command?.type).toBe("clipboard.copy");
    if (command?.type !== "clipboard.copy") throw new Error("No full clipboard operation");
    store.receive(sessionId, {
      type: "clipboard.result",
      surfaceId,
      operationId: command.operationId,
      outcome: "empty",
    });
    await pending;
    store.dispose();
  });
  it("routes a copy only to the operation that awaits it, after all ordered parts", async () => {
    const { store, target, commands } = setup();
    const copy = target.send({ kind: "copy" });
    const command = commands[0];
    if (command?.type !== "clipboard.copy") throw new Error("Copy was not sent as an operation.");
    store.receive(sessionId, {
      type: "clipboard.result",
      surfaceId,
      operationId: crypto.randomUUID(),
      outcome: "copied",
      items: [{ type: "text/plain", size: 5 }],
    });
    store.receive(sessionId, {
      type: "clipboard.result",
      surfaceId,
      operationId: command.operationId,
      outcome: "copied",
      items: [{ type: "text/plain", size: 5 }],
    });
    store.receive(sessionId, {
      type: "clipboard.part",
      part: { operationId: command.operationId, index: 0, data: btoa("hello") },
    });
    expect(await copy).toEqual({
      outcome: "copied",
      items: [{ type: "text/plain", bytes: encoder.encode("hello") }],
    });
    store.dispose();
  });
  it("sends binary paste in bounded parts on the same target", async () => {
    const { store, target, commands } = setup();
    const bytes = new Uint8Array(editingClipboardPartMaxBytes + 3).fill(71);
    const paste = target.send({ kind: "paste", items: [{ type: "image/png", bytes }] });
    const command = commands[0];
    if (command?.type !== "clipboard.paste-data") throw new Error("No rich paste.");
    expect(
      commands.slice(1).map((c) => (c.type === "clipboard.part" ? atob(c.part.data).length : -1)),
    ).toEqual([editingClipboardPartMaxBytes, 3]);
    store.receive(sessionId, {
      type: "clipboard.result",
      surfaceId,
      operationId: command.operationId,
      outcome: "pasted",
    });
    expect(await paste).toEqual({ outcome: "pasted", items: [] });
    store.dispose();
  });
  it("refuses malformed parts and cancels pending operations at disconnect", async () => {
    const { store, target, commands } = setup();
    const copy = target.send({ kind: "copy" });
    const rejection = expect(copy).rejects.toThrow("order");
    const command = commands[0];
    if (command?.type !== "clipboard.copy") throw new Error("No copy");
    store.receive(sessionId, {
      type: "clipboard.result",
      surfaceId,
      operationId: command.operationId,
      outcome: "copied",
      items: [{ type: "text/plain", size: 1 }],
    });
    store.receive(sessionId, {
      type: "clipboard.part",
      part: { operationId: command.operationId, index: 1, data: "YQ==" },
    });
    await rejection;
    const pending = target.send({ kind: "cut" });
    const canceled = expect(pending).rejects.toThrow("disconnected");
    store.disconnect(sessionId);
    await canceled;
    store.dispose();
  });
  it("delivers page writes only to the active viewer and drops unawaited parts", async () => {
    const { store, target } = setup();
    const written: unknown[] = [];
    const release = target.activate((items) => written.push(items));
    const operationId = crypto.randomUUID();
    store.receive(sessionId, {
      type: "clipboard.written",
      surfaceId,
      operationId,
      items: [{ type: "text/plain", size: 1 }],
    });
    store.receive(sessionId, {
      type: "clipboard.part",
      part: { operationId, index: 0, data: "YQ==" },
    });
    await Promise.resolve();
    expect(written).toEqual([[{ type: "text/plain", bytes: encoder.encode("a") }]]);
    release();
    store.receive(sessionId, {
      type: "clipboard.written",
      surfaceId,
      operationId: crypto.randomUUID(),
      items: [{ type: "text/plain", size: 1 }],
    });
    expect(written).toHaveLength(1);
    store.dispose();
  });
  it("projects only exactly representable operations on baseline sessions", async () => {
    const { store, target, commands } = setup(false);
    await target.send({
      kind: "key",
      keystroke: {
        action: "down",
        code: "KeyA",
        key: "a",
        modifiers: ["primary"],
        location: 0,
        repeat: false,
      },
    });
    expect(commands[0]).toMatchObject({ type: "input.key", modifiers: ["control"] });
    expect(commands[0]).not.toHaveProperty("location");
    await expect(
      target.send({
        kind: "edit",
        edit: { contextId: crypto.randomUUID(), text: "é", before: "e", after: "" },
      }),
    ).rejects.toThrow("range");
    await expect(
      target.send({
        kind: "paste",
        items: [{ type: "text/html", bytes: encoder.encode("<b>a</b>") }],
      }),
    ).rejects.toThrow("rich");
    const pending = target.send({ kind: "copy" });
    store.receive(sessionId, { type: "clipboard.data", surfaceId, text: "legacy" });
    expect(await pending).toEqual({
      outcome: "copied",
      items: [{ type: "text/plain", bytes: encoder.encode("legacy") }],
    });
    store.dispose();
  });
});
