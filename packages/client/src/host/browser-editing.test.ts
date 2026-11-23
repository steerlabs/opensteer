import { describe, expect, it, vi } from "vitest";
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
  // CZ3: a command carries the context it was computed for; the store never substitutes the
  // field's context now (it may already be another field's). Without one, it is not sent. A menu's
  // command carries the context the menu was opened in.
  it("sends a command only with its own context, and a menu's with the menu's", async () => {
    const { store, target, commands } = setup();
    target.activate(
      () => undefined,
      () => undefined,
    );
    const before = crypto.randomUUID();
    const after = crypto.randomUUID();
    const receive = (contextId: string) =>
      store.receive(sessionId, {
        type: "browser.editing",
        surfaceId,
        context: { contextId, field: null, caret: null },
      });
    receive(before);
    store.receive(sessionId, {
      type: "browser.contextmenu",
      surfaceId,
      editable: true,
      selection: false,
      x: 0.5,
      y: 0.5,
      geometryRevision: 0,
    });
    receive(after);
    await target.send({ kind: "command", command: "deleteBackward" });
    expect(commands.filter((command) => command.type === "input.command")).toEqual([]);
    expect(target.get().menuContext).toBe(before);
    await target.send({ kind: "command", command: "deleteBackward", contextId: before });
    expect(commands.filter((command) => command.type === "input.command")).toEqual([
      { type: "input.command", surfaceId, command: "deleteBackward", contextId: before },
    ]);
    store.dispose();
  });
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
      store.receive(sessionId, {
        type: "browser.editing",
        surfaceId,
        context: { contextId, field: null, caret: null },
      });
      await target.send({
        kind: "compose",
        composition: { contextId, text: "한", selectionStart: 1, selectionEnd: 1 },
      });
      await target.send({ kind: "edit", edit: { contextId, before: "e", after: "", text: "é" } });
      await target.send({ kind: "command", command: "selectAll", contextId });
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
        contextId,
      });
      expect(commands.at(-1)).toEqual({
        type: "clipboard.paste",
        surfaceId,
        text: "text",
        contextId,
      });
      await expect(
        target.send({
          kind: "paste",
          items: [{ type: "image/png", bytes: new Uint8Array([1]) }],
          contextId,
        }),
      ).rejects.toThrow("rich");
      store.dispose();
    },
  );
  it.each([1, 2] as const)("retains full clipboard for version %s", async (version) => {
    const { store, target, commands } = setup();
    store.negotiate(sessionId, version, undefined, version === 2 ? true : undefined);
    expect(target.get().abilities.clipboard).toBe("full");
    const pending = target.send({ kind: "copy", contextId: crypto.randomUUID() });
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
    const copy = target.send({ kind: "copy", contextId: crypto.randomUUID() });
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
    const paste = target.send({
      kind: "paste",
      items: [{ type: "image/png", bytes }],
      contextId: crypto.randomUUID(),
    });
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
    const copy = target.send({ kind: "copy", contextId: crypto.randomUUID() });
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
    const pendingCopy = target.send({ kind: "copy", contextId: crypto.randomUUID() });
    const pendingCut = target.send({ kind: "cut", contextId: crypto.randomUUID() });
    const canceled = expect(pendingCopy).rejects.toThrow("disconnected");
    store.disconnect(sessionId);
    await canceled;
    expect(await pendingCut).toEqual({ outcome: "unknown", items: [] });
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
        contextId: crypto.randomUUID(),
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
  it("settles clipboard operations only by their own operationId or carrier end, never unrelated browser.error", async () => {
    vi.useFakeTimers();
    const { store, target, commands } = setup();
    try {
      const paste = target.send({
        kind: "paste",
        items: [{ type: "text/plain", bytes: encoder.encode("hi") }],
        contextId: crypto.randomUUID(),
      });
      const copy = target.send({
        kind: "copy",
        contextId: crypto.randomUUID(),
      });
      const pasteCmd = commands.find((c) => c.type === "clipboard.paste-data");
      const copyCmd = commands.find((c) => c.type === "clipboard.copy");
      if (pasteCmd?.type !== "clipboard.paste-data" || copyCmd?.type !== "clipboard.copy")
        throw new Error("Missing clipboard commands.");

      // Unrelated browser.error messages (including stale-input, stale-document, reasonless conflict)
      // must not settle pending clipboard operations.
      for (const error of [
        {
          code: "conflict" as const,
          reason: "stale-input",
          message: "Stale input.",
          retryable: false,
        },
        {
          code: "conflict" as const,
          reason: "stale-document",
          message: "Field changed.",
          retryable: false,
        },
        { code: "conflict" as const, message: "The field changed. Paste again.", retryable: false },
        {
          code: "bad_message" as const,
          reason: "too-large",
          message: "Too large.",
          retryable: false,
        },
      ]) {
        store.receive(sessionId, { type: "browser.error", error });
      }
      const settledEarly = await Promise.race([
        paste.then(() => "paste-settled"),
        copy.then(() => "copy-settled"),
        Promise.resolve()
          .then(() => undefined)
          .then(() => undefined)
          .then(() => "still-pending"),
      ]);
      expect(settledEarly).toBe("still-pending");

      // The paste's own refusal settles only the paste; the sibling copy's late result is still delivered.
      store.receive(sessionId, {
        type: "clipboard.result",
        surfaceId,
        operationId: pasteCmd.operationId,
        outcome: "refused",
      });
      expect(await paste).toEqual({ outcome: "refused", items: [] });

      store.receive(sessionId, {
        type: "clipboard.result",
        surfaceId,
        operationId: copyCmd.operationId,
        outcome: "copied",
        items: [{ type: "text/plain", size: 4 }],
      });
      store.receive(sessionId, {
        type: "clipboard.part",
        part: { operationId: copyCmd.operationId, index: 0, data: btoa("late") },
      });
      expect(await copy).toEqual({
        outcome: "copied",
        items: [{ type: "text/plain", bytes: encoder.encode("late") }],
      });

      // When the carrier ends with a paste already sent, the outcome is unknown (never refused).
      const inFlightPaste = target.send({
        kind: "paste",
        items: [{ type: "text/plain", bytes: encoder.encode("maybe") }],
        contextId: crypto.randomUUID(),
      });
      store.disconnect(sessionId, surfaceId);
      expect(await inFlightPaste).toEqual({ outcome: "unknown", items: [] });
    } finally {
      store.dispose();
      vi.useRealTimers();
    }
  });
  it("resolves unknown on 10 s timeout or disconnect for a sent paste or cut, while unsent ones and copies still fail", async () => {
    vi.useFakeTimers();
    let failSend: string | null = null;
    const commands: BrowserCommand[] = [];
    const store = new BrowserEditingStore((_session, _surface, command) => {
      if (failSend && command.type === failSend) throw new Error("Transport closed before send.");
      commands.push(command);
    });
    store.negotiate(sessionId, 2, surfaceId, true);
    const target = store.target(sessionId, surfaceId);
    try {
      const contextId = crypto.randomUUID();
      // Paste NOT yet sent (transport refuses before command leaves client): rejects, never unknown.
      failSend = "clipboard.paste-data";
      await expect(
        target.send({
          kind: "paste",
          items: [{ type: "text/plain", bytes: encoder.encode("unsent") }],
          contextId,
        }),
      ).rejects.toThrow("Transport closed before send.");

      // Cut NOT yet sent: rejects, never unknown.
      failSend = "clipboard.cut";
      await expect(target.send({ kind: "cut", contextId })).rejects.toThrow(
        "Transport closed before send.",
      );
      failSend = null;

      // Paste SENT, then 10 s timer fires while parts/result are still in flight: unknown, never failure.
      const timedOutPaste = target.send({
        kind: "paste",
        items: [{ type: "text/plain", bytes: encoder.encode("slow-upload") }],
        contextId,
      });
      // Cut SENT, then 10 s timer fires: unknown, never failure.
      const timedOutCut = target.send({ kind: "cut", contextId });
      // Copy SENT, then 10 s timer fires: nothing changed on the far side, so timeout rejection is honest.
      const timedOutCopy = target.send({ kind: "copy", contextId });
      const copyRejection = expect(timedOutCopy).rejects.toThrow("timed out");

      vi.advanceTimersByTime(10_000);
      expect(await timedOutPaste).toEqual({ outcome: "unknown", items: [] });
      expect(await timedOutCut).toEqual({ outcome: "unknown", items: [] });
      await copyRejection;

      // Cut SENT, then carrier disconnects: unknown, never failure.
      const disconnectedCut = target.send({ kind: "cut", contextId });
      store.disconnect(sessionId, surfaceId);
      expect(await disconnectedCut).toEqual({ outcome: "unknown", items: [] });
    } finally {
      store.dispose();
      vi.useRealTimers();
    }
  });
  it("never settles an unnamed sent paste or cut as empty on unsupported-operation or target-suspended", async () => {
    const { store, target, commands } = setup();
    try {
      const paste = target.send({
        kind: "paste",
        items: [{ type: "text/plain", bytes: encoder.encode("hello") }],
        contextId: crypto.randomUUID(),
      });
      const cut = target.send({ kind: "cut", contextId: crypto.randomUUID() });
      const copy = target.send({ kind: "copy", contextId: crypto.randomUUID() });
      const pasteCmd = commands.find((c) => c.type === "clipboard.paste-data");
      const copyCmd = commands.find((c) => c.type === "clipboard.copy");
      if (pasteCmd?.type !== "clipboard.paste-data" || copyCmd?.type !== "clipboard.copy")
        throw new Error("Missing clipboard commands.");

      // An unnamed per-message unsupported-operation (e.g. surface.close or an unrelated command)
      // must NOT settle any pending paste, cut, or copy as empty.
      store.receive(
        sessionId,
        {
          type: "browser.error",
          error: {
            code: "conflict",
            reason: "unsupported-operation",
            message: "Close tabs through the Host.",
            retryable: false,
          },
        },
        surfaceId,
      );
      const afterUnnamed = await Promise.race([
        paste.then((r) => `paste:${r?.outcome}`),
        cut.then((r) => `cut:${r?.outcome}`),
        copy.then((r) => `copy:${r?.outcome}`),
        new Promise<string>((resolve) => setTimeout(() => resolve("all-pending"), 0)),
      ]);
      expect(afterUnnamed).toBe("all-pending");

      // Naming ONLY copy settles only copy; paste and cut stay pending.
      store.receive(
        sessionId,
        {
          type: "browser.error",
          operationId: copyCmd.operationId,
          error: {
            code: "conflict",
            reason: "unsupported-operation",
            message: "Only basic phone input is available.",
            retryable: false,
          },
        },
        surfaceId,
      );
      expect(await copy).toEqual({ outcome: "empty", items: [] });
      const afterNamedCopy = await Promise.race([
        paste.then((r) => `paste:${r?.outcome}`),
        cut.then((r) => `cut:${r?.outcome}`),
        new Promise<string>((resolve) => setTimeout(() => resolve("paste-and-cut-pending"), 0)),
      ]);
      expect(afterNamedCopy).toBe("paste-and-cut-pending");

      // Paste receives its own result normally.
      store.receive(sessionId, {
        type: "clipboard.result",
        surfaceId,
        operationId: pasteCmd.operationId,
        outcome: "pasted",
      });
      expect(await paste).toEqual({ outcome: "pasted", items: [] });

      // On surface-wide target-suspended, a sent paste or cut settles as unknown (never empty).
      const paste2 = target.send({
        kind: "paste",
        items: [{ type: "text/plain", bytes: encoder.encode("world") }],
        contextId: crypto.randomUUID(),
      });
      store.receive(
        sessionId,
        {
          type: "browser.error",
          error: {
            code: "conflict",
            reason: "target-suspended",
            message: "Tab suspended.",
            retryable: false,
          },
        },
        surfaceId,
      );
      expect(await paste2).toEqual({ outcome: "unknown", items: [] });
      expect(await cut).toEqual({ outcome: "unknown", items: [] });
    } finally {
      store.dispose();
    }
  });
});

describe("browser autofill offers", () => {
  const consumerToken = crypto.randomUUID();
  const account = (username: string) => ({
    id: crypto.randomUUID(),
    revision: 3,
    username,
    label: null,
    ready: false,
  });
  const offer = (offerId: string, accounts: ReturnType<typeof account>[], y = 0.2) =>
    ({
      type: "browser.autofill.offer",
      consumerToken,
      surfaceId,
      offerId,
      role: "username",
      geometryRevision: 1,
      anchor: { x: 0.1, y, width: 0.3, height: 0.05 },
      accounts,
    }) as const;

  it("keeps an offer's place across anchor moves, fills once, and ends on withdrawal", () => {
    const { store, target, commands } = setup();
    const first = crypto.randomUUID();
    const accounts = [account("alex@acme.co"), account("alex.admin@acme.co")];
    store.receive(sessionId, offer(first, accounts));
    target.moveAutofill(1);
    target.dismissAutofill();
    store.receive(sessionId, offer(first, accounts, 0.4));
    expect(target.get().autofill).toMatchObject({
      open: false,
      highlighted: 1,
      offer: { anchor: { y: 0.4 } },
    });

    target.fillAutofill(accounts[1]!.id);
    target.fillAutofill(accounts[0]!.id);
    target.fillAutofill(crypto.randomUUID());
    expect(commands).toEqual([
      { type: "autofill.fill", surfaceId, offerId: first, loginId: accounts[1]!.id, revision: 3 },
    ]);

    store.receive(sessionId, {
      type: "browser.autofill.result",
      consumerToken,
      surfaceId,
      offerId: crypto.randomUUID(),
      status: "filled",
    });
    expect(target.get().autofill?.pending).toBe(accounts[1]!.id);
    store.receive(sessionId, {
      type: "browser.autofill.result",
      consumerToken,
      surfaceId,
      offerId: first,
      status: "cancelled",
    });
    expect(target.get().autofill).toMatchObject({ pending: null, result: "cancelled" });

    const second = crypto.randomUUID();
    store.receive(sessionId, offer(second, [accounts[0]!]));
    expect(target.get().autofill).toMatchObject({ open: true, highlighted: 0, result: null });
    store.receive(sessionId, {
      type: "browser.autofill.withdrawn",
      consumerToken,
      surfaceId,
      offerId: first,
    });
    expect(target.get().autofill?.offer.offerId).toBe(second);
    store.receive(sessionId, {
      type: "browser.autofill.withdrawn",
      consumerToken,
      surfaceId,
      offerId: second,
    });
    expect(target.get().autofill).toBeNull();
    store.dispose();
  });

  it("lets the person choose again when the choice never left this viewer", () => {
    const store = new BrowserEditingStore(() => {
      throw new Error("The browser socket is closed.");
    });
    const target = store.target(sessionId, surfaceId);
    const offerId = crypto.randomUUID();
    const only = account("alex@acme.co");
    store.receive(sessionId, offer(offerId, [only]));
    target.fillAutofill(only.id);
    expect(target.get().autofill).toMatchObject({ pending: null, result: "unavailable" });
    store.dispose();
  });
});

describe("browser password save offers", () => {
  const consumerToken = crypto.randomUUID();
  const offer = (offerId: string) =>
    ({
      type: "browser.passwordSave.offer",
      consumerToken,
      surfaceId,
      offerId,
      offer: { kind: "save", origin: "https://acme.co", username: "alex@acme.co" },
    }) as const;
  const ended = (offerId: string, status: "saved" | "dismissed" | "ended") =>
    ({ type: "browser.passwordSave.ended", consumerToken, surfaceId, offerId, status }) as const;

  it("answers once, keeps a result to show, and forgets an offer that ended quietly", () => {
    const { store, target, commands } = setup();
    const first = crypto.randomUUID();
    store.receive(sessionId, offer(first));
    target.answerPasswordSave(true);
    target.answerPasswordSave(false);
    expect(commands).toEqual([
      { type: "passwordSave.answer", surfaceId, offerId: first, save: true },
    ]);
    expect(target.get().passwordSave).toMatchObject({ pending: true, result: null });
    store.receive(sessionId, ended(crypto.randomUUID(), "saved"));
    expect(target.get().passwordSave?.pending).toBe(true);
    store.receive(sessionId, ended(first, "saved"));
    expect(target.get().passwordSave).toMatchObject({ pending: false, result: "saved" });
    target.clearPasswordSave();
    expect(target.get().passwordSave).toBeNull();

    const second = crypto.randomUUID();
    store.receive(sessionId, offer(second));
    store.receive(sessionId, ended(second, "ended"));
    expect(target.get().passwordSave).toBeNull();
    store.dispose();
  });

  it("says it could not save when the answer never left this viewer", () => {
    const store = new BrowserEditingStore(() => {
      throw new Error("The browser socket is closed.");
    });
    const target = store.target(sessionId, surfaceId);
    store.receive(sessionId, offer(crypto.randomUUID()));
    target.answerPasswordSave(true);
    expect(target.get().passwordSave).toMatchObject({ pending: false, result: "unavailable" });
    store.dispose();
  });
});
