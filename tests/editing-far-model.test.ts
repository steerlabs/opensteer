import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EditingOperation, EditingProxyEvent } from "../packages/client/src/editing/types.js";
import { createEditingState, reduceEditing } from "../packages/client/src/editing/reducer.js";
import type { CdpSession } from "../packages/browser-runtime-core/src/browser/backend.js";
import { editingCommandParameters } from "../packages/browser-runtime-core/src/browser/editing-commands.js";
import { PageEditingObserver } from "../packages/browser-runtime-core/src/browser/editing-observer.js";
import type { BrowserPage } from "../packages/browser-runtime-core/src/index.js";
import { ChromiumClipboard } from "../apps/browser-runtime/src/browser/chromium-clipboard.js";
import { FarField } from "../apps/mobile/modules/remote-text-input/tests/remote-input-port.js";

/*
 * The mobile typing test's far side is a model (FarField). Here it is held to the real page
 * applier: seeded random operations go to the model and, through PageEditingObserver.edit and
 * the controller's command path, to a real Chromium textarea and contenteditable; after every
 * operation the text, the caret and whether it was refused must agree.
 */

const kinds = ["textarea", "contenteditable"] as const;
// Left-to-right and right-to-left letters, precomposed and decomposed é, a joined emoji.
const alphabet = ["a", "b", "\u00e9", "e\u0301", "👩‍💻", " ", "א", "ب"];
const commands = ["moveBackward", "moveForward", "deleteBackward", "deleteForward"] as const;
const seeds = Number(process.env.OPENSTEER_FAR_MODEL_SEEDS ?? 60);
const opsPerSeed = 10;

let browser: Browser;
/** The browser's clipboard, as the runtime installs a paste's bytes into it. */
let clipboard: ChromiumClipboard;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
  clipboard = await ChromiumClipboard.create(browser);
});
afterAll(async () => {
  await clipboard?.close();
  await browser?.close();
});

/** What the Home sent as text, and to whom it attributed input, in order. */
const record: string[] = [];
/** CW1, CY3: what the page does after the close's last read of its composition, before it sends. */
let between: null | (() => Promise<unknown>) = null;
function handle(session: CDPSession): CdpSession {
  const raw = session.send.bind(session) as unknown as CdpSession["send"];
  const send = (async (method: string, params?: Record<string, unknown>) => {
    if (method === "Input.insertText") {
      // The real remaining hop (CY3): after every read of the observer's, as its insertion goes.
      if (between) {
        const act = between;
        between = null;
        await act();
      }
      record.push(`text ${String(params?.text)}`);
    }
    return raw(method as never, params as never);
  }) as CdpSession["send"];
  return {
    send,
    on: (event, listener) => session.on(event as never, listener as never),
    off: (event, listener) => session.off(event as never, listener as never),
    // The observer subscribes through on(); only child frames would use onEvent, and this page
    // has none.
    onEvent: () => () => undefined,
    close: () => session.detach(),
    detach: () => session.detach(),
  };
}

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Grapheme boundaries of `text`, in UTF-16 offsets. */
function boundaries(text: string): number[] {
  const ends = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
    ({ index, segment }) => index + segment.length,
  );
  return [0, ...ends];
}

async function field(page: Page, kind: (typeof kinds)[number]) {
  await page.setContent(
    kind === "textarea"
      ? `<textarea id="f" style="font: 16px monospace; width: 600px"></textarea>`
      : `<div id="f" contenteditable style="font: 16px monospace; width: 600px; white-space: pre-wrap"></div>`,
  );
  await page.focus("#f");
}

/** The real field's text and caret, as UTF-16 offsets in its text. */
async function read(page: Page, kind: (typeof kinds)[number]) {
  return page.evaluate((kind) => {
    const element = document.getElementById("f")!;
    if (kind === "textarea") {
      const area = element as HTMLTextAreaElement;
      return {
        value: area.value,
        caret: area.selectionEnd,
        collapsed: area.selectionStart === area.selectionEnd,
      };
    }
    const selection = getSelection()!;
    const range = document.createRange();
    range.setStart(element, 0);
    range.setEnd(selection.focusNode ?? element, selection.focusOffset);
    return {
      value: (element.textContent ?? "").replaceAll(" ", " "),
      caret: range.toString().length,
      collapsed: selection.isCollapsed,
    };
  }, kind);
}

async function seed(page: Page, kind: (typeof kinds)[number], value: string, caret: number) {
  await page.evaluate(
    ({ kind, value, caret }) => {
      const element = document.getElementById("f")!;
      element.focus();
      if (kind === "textarea") {
        const area = element as HTMLTextAreaElement;
        area.value = value;
        area.setSelectionRange(caret, caret);
        return;
      }
      element.textContent = value;
      const range = document.createRange();
      const text = element.firstChild;
      if (text) range.setStart(text, caret);
      else range.setStart(element, 0);
      range.collapse(true);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    },
    { kind, value, caret },
  );
}

describe.each(kinds)("the far-field model against the real page applier, in a %s", (kind) => {
  let page: Page;
  let observer: PageEditingObserver;
  let cdp: CdpSession;
  beforeAll(async () => {
    page = await browser.newPage();
    await field(page, kind);
    cdp = handle(await page.context().newCDPSession(page));
    observer = new PageEditingObserver(cdp, () => undefined);
    await observer.start();
    await vi.waitUntil(() => observer.context.field !== null, { timeout: 5000, interval: 10 });
  });
  afterAll(async () => {
    await observer?.close();
    await page?.close();
  });
  /**
   * The observer has heard the page as it stands: the page reports on its next frame, and a
   * round trip on the same session after that frame arrives behind the report.
   */
  const settle = async () => {
    observer.refresh();
    await cdp.send("Runtime.evaluate", {
      expression: "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
      awaitPromise: true,
    });
    await cdp.send("Runtime.evaluate", { expression: "0" });
    await vi.waitUntil(() => observer.context.field !== null, { timeout: 5000, interval: 5 });
  };

  /**
   * Sends one operation to the real page as the controller does: text, composition, command, or
   * a paste (its bytes installed in the browser's clipboard, then the paste command).
   */
  const send = async (operation: EditingOperation, producer = "A") => {
    // The controller's admitted: input from here on is this producer's.
    const admitted = () => record.push(`attributed ${producer}`);
    if (operation.kind === "edit") return observer.edit(operation.edit, false, admitted, producer);
    if (operation.kind === "compose")
      return observer.edit(operation.composition, true, admitted, producer);
    if (operation.kind === "paste") {
      const scope = await clipboard.open({} as BrowserPage, operation.items);
      try {
        await observer.input(
          () =>
            cdp.send("Input.dispatchKeyEvent", editingCommandParameters("paste", process.platform)),
          producer,
        );
      } finally {
        await scope.close();
      }
      return true;
    }
    // Stamped as the client's store stamps it: its own context (a late one's), else the field's now.
    if (operation.kind === "command")
      return observer.command(
        operation.contextId ?? observer.context.contextId,
        operation.command,
        () =>
          cdp.send(
            "Input.dispatchKeyEvent",
            editingCommandParameters(operation.command, process.platform),
          ),
        producer,
      );
    return true;
  };

  /*
   * What the mobile reducer sent for the random typing test's seed 15915, recorded from its run
   * through the real proxy and reducer over the port: typing, a composition committed by
   * unmarkText, the person's caret moved to 1 before the commit's turn (six moveBackward), then
   * the next keystroke "x". The native caret there ends at 1; the real far caret must too, and
   * the "x" must go in at 1.
   */
  it("puts the far caret where the person moved it while a composition's commit waited (seed 15915)", async () => {
    await seed(page, kind, "", 0);
    await settle();
    const far = new FarField();
    far.contextId = observer.context.contextId;
    const contextId = observer.context.contextId!;
    const edit = (text: string, before = "") =>
      ({ kind: "edit", edit: { contextId, text, before, after: "" } }) as const;
    const operations: EditingOperation[] = [
      edit("b"),
      edit("a"),
      edit("👩‍💻"),
      edit("א"),
      edit("", "א"),
      edit("👩‍💻"),
      edit("ب"),
      {
        kind: "compose",
        composition: {
          contextId,
          text: "日本",
          selectionStart: 2,
          selectionEnd: 2,
          before: "",
          after: "",
        },
      },
      edit("日本"),
      ...Array.from({ length: 6 }, () => ({ kind: "command", command: "moveBackward" }) as const),
    ];
    for (const [index, operation] of operations.entries()) {
      far.take(operation);
      expect(await send(operation), `operation ${index} refused`).toBe(true);
      const real = await read(page, kind);
      expect(real.value, `operation ${index}: text`).toBe(far.value);
      expect(real.caret, `operation ${index}: caret`).toBe(far.caret);
    }
    // The native field's caret after the same sequence, with the composition's commit putting
    // back the caret the person chose (typing-order.interaction.test.tsx, seed 15915).
    const nativeCaret = 1;
    expect((await read(page, kind)).caret).toBe(nativeCaret);
    const keystroke = edit("x");
    far.take(keystroke);
    expect(await send(keystroke)).toBe(true);
    expect(await read(page, kind)).toEqual({
      value: "bxa👩‍💻👩‍💻ب日本",
      caret: 2,
      collapsed: true,
    });
    expect(far.refused).toEqual([]);
  });

  /*
   * CR4: an empty edit during a composition. The reducer never sends one today (a cancel is an
   * empty composition, a commit carries text), but the model and the page must agree on it.
   */
  it("agrees on an empty edit during a composition", async () => {
    await seed(page, kind, "ab", 2);
    await settle();
    const far = new FarField();
    far.value = "ab";
    far.caret = 2;
    far.contextId = observer.context.contextId;
    const contextId = observer.context.contextId!;
    const operations: EditingOperation[] = [
      {
        kind: "compose",
        composition: {
          contextId,
          text: "日本",
          selectionStart: 2,
          selectionEnd: 2,
          before: "",
          after: "",
        },
      },
      { kind: "edit", edit: { contextId, text: "", before: "", after: "" } },
    ];
    for (const [index, operation] of operations.entries()) {
      far.take(operation);
      expect(await send(operation), `operation ${index} refused`).toBe(true);
      const real = await read(page, kind);
      expect({ value: real.value, caret: real.caret }, `operation ${index}`).toEqual({
        value: far.value,
        caret: far.caret,
      });
    }
  });

  /*
   * CS1: a composition belongs to the context that started it. A refusal does not end it (the
   * page's composition events say whether the field composes); the next operation, of the new
   * context, finds it open, and the old context closes it first: exactly its marked text,
   * committed and attributed to the context that composed it. The new operation then goes in
   * after it, attributed to its own producer.
   */
  it("keeps the composed text when a keystroke follows a refusal during a composition", async () => {
    await seed(page, kind, "", 0);
    await settle();
    record.length = 0;
    const far = new FarField();
    far.contextId = observer.context.contextId;
    const contextId = observer.context.contextId!;
    const compose: EditingOperation = {
      kind: "compose",
      composition: {
        contextId,
        text: "日本",
        selectionStart: 2,
        selectionEnd: 2,
        before: "",
        after: "",
      },
    };
    far.take(compose, "A");
    expect(await send(compose, "A")).toBe(true);
    const stale: EditingOperation = {
      kind: "edit",
      edit: { contextId: crypto.randomUUID(), text: "x", before: "", after: "" },
    };
    far.take(stale, "A");
    expect(await send(stale, "A")).toBe(false);
    await settle();
    far.contextId = observer.context.contextId;
    const keystroke: EditingOperation = {
      kind: "edit",
      edit: { contextId: observer.context.contextId!, text: "x", before: "", after: "" },
    };
    far.take(keystroke, "B");
    expect(await send(keystroke, "B")).toBe(true);
    const real = await read(page, kind);
    expect(real.value).toBe("日本x");
    expect({ value: far.value, caret: far.caret }).toEqual({
      value: real.value,
      caret: real.caret,
    });
    // The record: 日本 under the context that composed it, x under the next one; the refused
    // edit sent nothing.
    expect(record).toEqual(["attributed A", "attributed A", "text 日本", "attributed B", "text x"]);
    expect(far.closed).toEqual([{ contextId, producer: "A", text: "日本" }]);
  });

  // CS1: another viewer taking the input while a composition is open ends the composing
  // context too: the composer's text is closed as theirs, then the other viewer's edit goes in.
  it("closes a composition as its composer's when another viewer's operation comes", async () => {
    await seed(page, kind, "a", 1);
    await settle();
    record.length = 0;
    const contextId = observer.context.contextId!;
    expect(
      await send(
        {
          kind: "compose",
          composition: {
            contextId,
            text: "に",
            selectionStart: 1,
            selectionEnd: 1,
            before: "",
            after: "",
          },
        },
        "A",
      ),
    ).toBe(true);
    expect(await send({ kind: "command", command: "moveBackward" }, "B")).toBe(true);
    expect(await read(page, kind)).toEqual({ value: "aに", caret: 1, collapsed: true });
    expect(record).toEqual(["attributed A", "attributed A", "text に"]);
  });

  /*
   * CW1: the close commits only what the page still holds, in the field it read, and only for an
   * operation that is admitted. Focus moving between the read and the send, or the composition
   * ending by itself there, sends nothing; another viewer's refused edit leaves the composition
   * and the record as they were.
   */
  const composeA = async (text: string) =>
    send(
      {
        kind: "compose",
        composition: {
          contextId: observer.context.contextId!,
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
          before: "",
          after: "",
        },
      },
      "A",
    );
  it("types nothing into a field that took focus between the close's read and its send", async () => {
    await seed(page, kind, "", 0);
    await settle();
    expect(await composeA("日本")).toBe(true);
    record.length = 0;
    between = () =>
      page.evaluate(() => {
        const other = document.createElement("input");
        other.id = "g";
        document.body.append(other);
        other.focus();
      });
    await send(
      {
        kind: "edit",
        edit: { contextId: observer.context.contextId!, text: "x", before: "", after: "" },
      },
      "B",
    );
    expect(
      await page.evaluate(() => (document.getElementById("g") as HTMLInputElement).value),
    ).toBe("");
    // The composition stays its composer's, in the field it was made in.
    expect((await read(page, kind)).value).toBe("日本");
    await page.evaluate(() => {
      document.getElementById("g")!.remove();
      document.getElementById("f")!.focus();
    });
    await settle();
  });
  it("sends nothing for a composition that ended by itself between the close's read and its send", async () => {
    await seed(page, kind, "", 0);
    await settle();
    expect(await composeA("日本")).toBe(true);
    record.length = 0;
    between = () =>
      page.evaluate(() => {
        const field = document.getElementById("f")!;
        field.blur();
        field.focus();
      });
    await settle();
    const contextId = observer.context.contextId!;
    await send({ kind: "edit", edit: { contextId, text: "x", before: "", after: "" } }, "B");
    // Committed once, by the page itself, whatever the close sent in the hop.
    expect((await read(page, kind)).value).not.toContain("日本日本");
  });
  it("leaves the composition and the record as they were when another viewer's edit is refused", async () => {
    await seed(page, kind, "", 0);
    await settle();
    expect(await composeA("日本")).toBe(true);
    record.length = 0;
    const refused = await send(
      {
        kind: "edit",
        edit: { contextId: observer.context.contextId!, text: "x", before: "WRONG", after: "" },
      },
      "B",
    );
    expect(refused).toBe(false);
    expect(record).toEqual([]);
    expect((await read(page, kind)).value).toBe("日本");
    expect(
      await page.evaluate(
        () =>
          (document.getElementById("f") as HTMLTextAreaElement).value ||
          document.getElementById("f")!.textContent,
      ),
    ).toBe("日本");
    // The page ends the composition (focus leaves and comes back), keeping its text.
    await page.evaluate(() => {
      const field = document.getElementById("f")!;
      field.blur();
      field.focus();
    });
    await settle();
  });

  // The walk: the phone sends undo and redo as commands; the applier turns them into the page's
  // own (editing-commands.ts, the page platform's chord), and the page's text changes.
  it("undoes and redoes what was typed with the page's own undo", async () => {
    await seed(page, kind, "", 0);
    await settle();
    const contextId = observer.context.contextId!;
    for (const text of ["a", "b"])
      expect(await send({ kind: "edit", edit: { contextId, text, before: "", after: "" } })).toBe(
        true,
      );
    expect((await read(page, kind)).value).toBe("ab");
    expect(await send({ kind: "command", command: "undo" })).toBe(true);
    const undone = (await read(page, kind)).value;
    expect(undone).not.toBe("ab");
    expect("ab".startsWith(undone)).toBe(true);
    expect(await send({ kind: "command", command: "redo" })).toBe(true);
    expect((await read(page, kind)).value).toBe("ab");
  });

  /*
   * CY1: a field that becomes another kind of field is another field. A page that reuses one
   * <input> for a username and then a password gives it a new context, and nothing typed for the
   * one lands in the other: an insertion and a Backspace in flight under the old context are each
   * refused alone. And the reverse.
   */
  it.each([
    ["text", "password"],
    ["password", "text"],
  ] as const)("refuses what was typed for a %s field once it is a %s field", async (from, to) => {
    await page.evaluate((type) => {
      const input = document.createElement("input");
      input.id = "k";
      input.type = type;
      document.body.append(input);
      input.focus();
    }, from);
    await settle();
    const before = observer.context.contextId!;
    expect(
      await send({ kind: "edit", edit: { contextId: before, text: "u", before: "", after: "" } }),
    ).toBe(true);
    await page.evaluate((type) => {
      const input = document.getElementById("k") as HTMLInputElement;
      input.type = type;
      input.value = "";
    }, to);
    await settle();
    expect(observer.context.contextId).not.toBe(before);
    expect(
      await send({ kind: "edit", edit: { contextId: before, text: "x", before: "", after: "" } }),
    ).toBe(false);
    expect(await send({ kind: "command", command: "deleteBackward", contextId: before })).toBe(
      false,
    );
    expect(
      await page.evaluate(() => (document.getElementById("k") as HTMLInputElement).value),
    ).toBe("");
    await page.evaluate(() => {
      document.getElementById("k")!.remove();
      document.getElementById("f")!.focus();
    });
    await settle();
  });

  /*
   * CY6: a command is applied under its own context, and nothing read before an await is used
   * after it. (A) A late Backspace of an earlier context while the current one composes: the
   * composition is closed by its composer first, never typed into. (B) Focus moving to another
   * field while the close runs: the command is refused there, and that field is untouched.
   */
  it("closes the current composition before a late command of an earlier context", async () => {
    await seed(page, kind, "ab", 2);
    await settle();
    const earlier = observer.context.contextId!;
    await seed(page, kind, "ab", 2);
    await page.evaluate(() => getSelection()?.collapseToEnd());
    // The page rewrites the field: the context before is an earlier one of the same field.
    await page.evaluate((kind) => {
      const element = document.getElementById("f")!;
      if (kind === "textarea") (element as HTMLTextAreaElement).value = "abc";
      else element.textContent = "abc";
    }, kind);
    await seed(page, kind, "abc", 3);
    await settle();
    expect(observer.context.contextId).not.toBe(earlier);
    expect(await composeA("日本")).toBe(true);
    record.length = 0;
    expect(
      await send({ kind: "command", command: "deleteBackward", contextId: earlier }, "A"),
    ).toBe(true);
    expect(record.slice(0, 2)).toEqual(["attributed A", "text 日本"]);
    expect((await read(page, kind)).value).toBe("abc日");
  });
  it("refuses a command whose field lost focus while the close ran", async () => {
    await seed(page, kind, "", 0);
    await settle();
    expect(await composeA("日本")).toBe(true);
    const contextId = observer.context.contextId!;
    between = () =>
      page.evaluate(() => {
        const other = document.createElement("input");
        other.id = "g";
        other.value = "keep";
        document.body.append(other);
        other.focus();
        other.setSelectionRange(4, 4);
      });
    expect(await send({ kind: "command", command: "deleteBackward", contextId }, "B")).toBe(false);
    expect(
      await page.evaluate(() => (document.getElementById("g") as HTMLInputElement).value),
    ).toBe("keep");
    await page.evaluate(() => {
      document.getElementById("g")!.remove();
      document.getElementById("f")!.focus();
    });
    await settle();
  });

  // CY3: an insertion the page then refuses closes nothing and records nothing.
  it("closes and records nothing for another viewer's insertion that is refused", async () => {
    await seed(page, kind, "", 0);
    await settle();
    expect(await composeA("日本")).toBe(true);
    record.length = 0;
    const contextId = observer.context.contextId!;
    // The field can no longer be edited, and the observer has not heard yet.
    await page.evaluate(() => {
      const field = document.getElementById("f")!;
      if (field instanceof HTMLTextAreaElement) field.readOnly = true;
      else field.contentEditable = "false";
    });
    expect(
      await send({ kind: "edit", edit: { contextId, text: "x", before: "", after: "" } }, "B"),
    ).toBe(false);
    expect(record).toEqual([]);
    await page.evaluate(() => {
      const field = document.getElementById("f")!;
      if (field instanceof HTMLTextAreaElement) field.readOnly = false;
      else field.contentEditable = "true";
      field.blur();
      field.focus();
    });
    await settle();
  });

  /*
   * CY5: a refusal takes with it what was computed from it. Typing over a selection away from
   * the caret is the selection's deletion, moves back to where it was, then the insertion; when
   * the deletion is refused under an earlier context the moves computed from it are refused too,
   * and what was typed lands at the page's caret.
   */
  it("refuses the moves computed from a refused deletion, and lands the text at the caret", async () => {
    await seed(page, kind, "abcd", 4);
    await settle();
    const earlier = observer.context.contextId!;
    // The page rewrites the field before the phone hears of it.
    await seed(page, kind, "ab-cd", 5);
    await settle();
    expect(observer.context.contextId).not.toBe(earlier);
    // What the reducer sends for "X" typed over "ab" with the far caret after "abcd".
    expect(
      await send({
        kind: "edit",
        edit: { contextId: earlier, text: "cd", before: "abcd", after: "" },
      }),
    ).toBe(false);
    for (let index = 0; index < 2; index++)
      expect(await send({ kind: "command", command: "moveBackward", contextId: earlier })).toBe(
        false,
      );
    expect(
      await send({ kind: "edit", edit: { contextId: earlier, text: "X", before: "", after: "" } }),
    ).toBe(true);
    expect(await read(page, kind)).toEqual({ value: "ab-cdX", caret: 6, collapsed: true });
    // The person's own swipe afterwards moves as ever.
    expect(await send({ kind: "command", command: "moveBackward", contextId: earlier })).toBe(true);
    expect((await read(page, kind)).caret).toBe(5);
  });

  // CY7: under an earlier context of the same field only the commands in the protocol's relative
  // list (the backward deletion and the plain caret moves the phone sends) apply at the caret.
  // Every other command is refused alone: the text and the caret stay, and the next relative
  // command still applies.
  it.each([
    "deleteWordBackward",
    "deleteForward",
    "moveWordLeftAndModifySelection",
    "moveToBeginningOfDocument",
    "moveUp",
    "selectAll",
  ] as const)("refuses %s under an earlier context, alone", async (command) => {
    await seed(page, kind, "one two", 7);
    await settle();
    const earlier = observer.context.contextId!;
    await seed(page, kind, "one two!", 8);
    await settle();
    expect(observer.context.contextId).not.toBe(earlier);
    const current = observer.context.contextId;
    expect(await send({ kind: "command", command, contextId: earlier })).toBe(false);
    expect(await read(page, kind)).toEqual({ value: "one two!", caret: 8, collapsed: true });
    expect(observer.context.contextId).toBe(current);
    expect(await send({ kind: "command", command: "deleteBackward", contextId: earlier })).toBe(
      true,
    );
    expect(await read(page, kind)).toEqual({ value: "one two", caret: 7, collapsed: true });
  });

  // CS1: a refusal inside the context while composing. The page moved the selection under an
  // open composition (Blink keeps the composition open), so the next update is refused for the
  // changed selection; the composition stays the composer's. The person keeps what they
  // composed where they composed it, and their next keystroke goes in after it, where the
  // close leaves the caret.
  it("keeps the composition through a refusal for a selection the page moved", async () => {
    await seed(page, kind, "ab", 2);
    await settle();
    record.length = 0;
    const contextId = observer.context.contextId!;
    const composition = (text: string) =>
      ({
        kind: "compose",
        composition: { contextId, text, selectionStart: text.length, selectionEnd: text.length },
      }) as const;
    expect(await send(composition("日本"), "A")).toBe(true);
    await page.evaluate((kind) => {
      const element = document.getElementById("f")!;
      if (kind === "textarea") (element as HTMLTextAreaElement).setSelectionRange(0, 0);
      else {
        const range = document.createRange();
        range.setStart(element.firstChild!, 0);
        range.collapse(true);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
      }
    }, kind);
    expect(await send(composition("日本語"), "A")).toBe(false);
    await settle();
    expect(
      await send(
        {
          kind: "edit",
          edit: { contextId: observer.context.contextId!, text: "x", before: "", after: "" },
        },
        "A",
      ),
    ).toBe(true);
    expect(await read(page, kind)).toEqual({ value: "ab日本x", caret: 5, collapsed: true });
    expect(record).toEqual(["attributed A", "attributed A", "text 日本", "attributed A", "text x"]);
  });

  /*
   * CU5: a composition the transport refused before it left (no change of context: the page never
   * saw it) is sent again as a fresh start, restating what it replaces. A recomposition of "ab"
   * whose first update was refused would otherwise go on without its before, and the page would
   * hold "ababcd". The reducer runs as the editing proxy drives it: what sendOperation refuses is
   * told back to it.
   */
  it("sends a composition the transport refused again as a fresh start", async () => {
    await seed(page, kind, "", 0);
    await settle();
    const context = observer.context;
    let state = createEditingState("ios", {
      composition: true,
      rangeEdits: true,
      commands: true,
      clipboard: "full",
    });
    let refuseCompose = true;
    const sent: EditingOperation[] = [];
    const step = async (event: EditingProxyEvent) => {
      const result = reduceEditing(state, event);
      state = result.state;
      for (const operation of result.operations) {
        // The transport is down for the first composition: nothing leaves.
        if (operation.kind === "compose" && refuseCompose) {
          refuseCompose = false;
          state = reduceEditing(state, { type: "refused", operation } as EditingProxyEvent).state;
          continue;
        }
        sent.push(operation);
        expect(await send(operation), `${operation.kind} refused by the page`).toBe(true);
      }
    };
    const proxy = (value: string, at: number, marked?: [number, number]) => ({
      value,
      selectionStart: at,
      selectionEnd: at,
      ...(marked ? { markedRange: { start: marked[0], end: marked[1] } } : {}),
    });
    await step({ type: "context", context });
    await step({ type: "beforeinput", inputType: "insertText", data: "ab" });
    await step({ type: "input", inputType: "insertText", composing: false, proxy: proxy("ab", 2) });
    // The input method takes "ab" back into a composition and adds to it.
    await step({ type: "beforeinput", inputType: "insertCompositionText", data: "abc" });
    await step({ type: "compositionstart", proxy: proxy("abc", 3, [0, 3]) });
    await step({ type: "compositionupdate", data: "abc", proxy: proxy("abc", 3, [0, 3]) });
    await step({
      type: "input",
      inputType: "insertCompositionText",
      composing: true,
      proxy: proxy("abc", 3, [0, 3]),
    });
    await step({ type: "beforeinput", inputType: "insertCompositionText", data: "abcd" });
    await step({ type: "compositionupdate", data: "abcd", proxy: proxy("abcd", 4, [0, 4]) });
    await step({
      type: "input",
      inputType: "insertCompositionText",
      composing: true,
      proxy: proxy("abcd", 4, [0, 4]),
    });
    await step({ type: "beforeinput", inputType: "insertFromComposition", data: "abcd" });
    await step({ type: "compositionend", data: "abcd", proxy: proxy("abcd", 4) });
    expect(sent.filter((operation) => operation.kind === "compose")).toMatchObject([
      { composition: { text: "abcd", before: "ab", after: "" } },
    ]);
    expect(await read(page, kind)).toEqual({ value: "abcd", caret: 4, collapsed: true });
  });

  /*
   * CV1: what the person types is an insertion at the page's caret, and nothing around it can
   * make the page refuse it. The page rewrites its own value as they type (a mask that inserts
   * characters, one that deletes, one that moves the caret): each rewrite gives the field a new
   * context, and an insertion still in flight under an earlier context of the same field lands
   * at the caret. A replacement that no longer matches is refused alone, and what was typed
   * after it still lands. Nothing crosses to another field: there, an earlier field's
   * insertion is refused, and the new field's context is not rotated for it.
   */
  it("lands every insertion at the page's caret while the page rewrites its value", async () => {
    await seed(page, kind, "", 0);
    await settle();
    const first = observer.context.contextId!;
    const insert = (contextId: string, text: string) =>
      send({ kind: "edit", edit: { contextId, text, before: "", after: "" } });
    expect(await insert(first, "5")).toBe(true);
    // A mask that inserts characters: the page writes "(5" itself.
    await seed(page, kind, "(5", 2);
    await settle();
    const masked = observer.context.contextId!;
    expect(masked).not.toBe(first);
    expect(await insert(first, "1"), "an insertion in flight under the earlier context").toBe(true);
    expect(await read(page, kind)).toEqual({ value: "(51", caret: 3, collapsed: true });
    // A mask that deletes, then one that moves the caret.
    await seed(page, kind, "51", 2);
    await settle();
    expect(await insert(masked, "2")).toBe(true);
    await seed(page, kind, "512", 0);
    await settle();
    expect(await insert(first, "0")).toBe(true);
    expect(await read(page, kind)).toEqual({ value: "0512", caret: 1, collapsed: true });
    // A replacement that no longer matches is refused alone: under an earlier context it rotates
    // nothing; under the current one the field gets a new context, and what was typed after it
    // under either still lands.
    const current = observer.context.contextId!;
    expect(
      await send({
        kind: "edit",
        edit: { contextId: masked, text: "the", before: "teh", after: "" },
      }),
    ).toBe(false);
    expect(observer.context.contextId).toBe(current);
    expect(
      await send({
        kind: "edit",
        edit: { contextId: current, text: "the", before: "teh", after: "" },
      }),
    ).toBe(false);
    expect(observer.context.contextId).not.toBe(current);
    expect(await insert(current, "x")).toBe(true);
    expect(await insert(masked, "y")).toBe(true);
    expect(await read(page, kind)).toEqual({ value: "0xy512", caret: 3, collapsed: true });
    // A Backspace and a move in flight across the page's rewrite apply at its caret.
    const command = (contextId: string, name: "deleteBackward" | "moveBackward" | "selectAll") =>
      send({ kind: "command", command: name, contextId });
    expect(await command(first, "deleteBackward")).toBe(true);
    expect(await command(masked, "moveBackward")).toBe(true);
    expect(await read(page, kind)).toEqual({ value: "0x512", caret: 1, collapsed: true });
    // Only what is relative to the caret: anything else of an earlier context is refused alone.
    const now = observer.context.contextId!;
    expect(await command(first, "selectAll")).toBe(false);
    expect(observer.context.contextId).toBe(now);
    // Another field: nothing typed for the first lands there, and its context stays.
    await page.evaluate(() => {
      const other = document.createElement("textarea");
      other.id = "g";
      document.body.append(other);
      other.focus();
    });
    await settle();
    const other = observer.context.contextId!;
    expect(await insert(current, "z")).toBe(false);
    // A Backspace and a move of the field left are refused alone there too.
    expect(await command(current, "deleteBackward")).toBe(false);
    expect(await command(masked, "moveBackward")).toBe(false);
    expect(observer.context.contextId).toBe(other);
    expect(
      await page.evaluate(() => (document.getElementById("g") as HTMLTextAreaElement).value),
    ).toBe("");
    await page.evaluate(() => {
      document.getElementById("g")!.remove();
      document.getElementById("f")!.focus();
    });
  });

  // CS1: where the page itself moves on (focus leaves the field), Blink ends the composition by
  // itself, keeping its text; the Home sends nothing for it.
  it("sends nothing for a composition the page ended itself when focus left", async () => {
    await seed(page, kind, "", 0);
    await settle();
    const contextId = observer.context.contextId!;
    expect(
      await send(
        {
          kind: "compose",
          composition: {
            contextId,
            text: "日本",
            selectionStart: 2,
            selectionEnd: 2,
            before: "",
            after: "",
          },
        },
        "A",
      ),
    ).toBe(true);
    record.length = 0;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    expect(
      await page.evaluate(
        () =>
          document.getElementById("f")!.textContent ||
          (document.getElementById("f") as HTMLTextAreaElement).value,
      ),
    ).toBe("日本");
    await page.focus("#f");
    await settle();
    expect(
      await send(
        {
          kind: "edit",
          edit: { contextId: observer.context.contextId!, text: "x", before: "", after: "" },
        },
        "B",
      ),
    ).toBe(true);
    expect(record).toEqual(["attributed B", "text x"]);
  });

  const totals = {
    operations: 0,
    refusals: 0,
    sequences: 0,
    edits: 0,
    commands: 0,
    starts: 0,
    updates: 0,
    commits: 0,
    cancels: 0,
    pastes: 0,
    stale: 0,
    rewrites: 0,
    viewers: 0,
    closes: 0,
  };
  for (let chunk = 1; chunk <= seeds; chunk += 20) {
    const last = Math.min(chunk + 19, seeds);
    it(`agrees on text, caret and refusals over seeds ${chunk} to ${last}`, async () => {
      for (let current = chunk; current <= last; current++) {
        const next = random(current * 7919 + (kind === "textarea" ? 1 : 2));
        const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
        const word = () => {
          let text = "";
          for (let index = 1 + Math.floor(next() * 3); index > 0; index--) text += pick(alphabet);
          return text;
        };
        let initial = "";
        for (let index = Math.floor(next() * 6); index > 0; index--) initial += pick(alphabet);
        const caret = pick(boundaries(initial));
        await seed(page, kind, initial, caret);
        // The page reports the seeded field; the observer names its context anew if it changed.
        await settle();
        const far = new FarField();
        far.value = initial;
        far.caret = caret;
        far.contextId = observer.context.contextId;
        /** Who sends: another viewer taking the input ends the composing context. */
        let producer = "A";
        /** Contexts the page has left: an operation under one is refused by both. */
        const old: string[] = [];
        const steps: string[] = [`seed ${JSON.stringify(initial)} at ${caret}`];
        for (let step = 0; step < opsPerSeed; step++) {
          // CV1: the page rewrites its own value now and then, as a mask does (it inserts a
          // character, deletes one, or moves the caret). The field gets a new context; the one
          // before is an earlier context of the same field, and a stale insertion may use it.
          if (!far.composition && next() < 0.15) {
            const spots = boundaries(far.value);
            const way = next();
            let value = far.value;
            let at = far.caret;
            if (way < 1 / 3) {
              const index = pick(spots);
              value = value.slice(0, index) + "-" + value.slice(index);
              if (at >= index) at += 1;
              steps.push(`the page inserts "-" at ${index}`);
            } else if (way < 2 / 3 && spots.length > 1) {
              const index = Math.floor(next() * (spots.length - 1));
              const [from, to] = [spots[index]!, spots[index + 1]!];
              value = value.slice(0, from) + value.slice(to);
              at = at >= to ? at - (to - from) : at > from ? from : at;
              steps.push(`the page deletes ${from} to ${to}`);
            } else {
              at = pick(spots);
              steps.push(`the page moves its caret to ${at}`);
            }
            const before = observer.context.contextId!;
            await seed(page, kind, value, at);
            await settle();
            far.value = value;
            far.caret = at;
            totals.rewrites += 1;
            if (observer.context.contextId !== before) {
              far.rotate();
              far.contextId = observer.context.contextId;
              old.push(before);
            }
            const real = await read(page, kind);
            expect(real.value, `${kind} seed ${current}: ${steps.join("; ")}: rewritten`).toBe(
              far.value,
            );
          }
          const where = boundaries(far.value);
          const contextId = observer.context.contextId!;
          const around = () => {
            const from = pick(where.filter((at) => at <= far.caret));
            const to = pick(where.filter((at) => at >= far.caret));
            const wrong = next() < 0.1;
            return {
              before: wrong ? "zz" : far.value.slice(from, far.caret),
              after: far.value.slice(far.caret, to),
            };
          };
          /** A caret inside a composition's text, at a code-unit boundary of its graphemes. */
          const inner = (text: string) => {
            const at = pick(boundaries(text));
            return { selectionStart: at, selectionEnd: at };
          };
          const choice = next();
          let operation: EditingOperation;
          let label: string;
          if (far.composition) {
            // While composing, the reducer sends updates, a commit, a cancel, or (after the page
            // rotated) an operation under the context it had.
            if (choice < 0.4) {
              const text = word();
              operation = { kind: "compose", composition: { contextId, text, ...inner(text) } };
              label = "update";
              totals.updates += 1;
            } else if (choice < 0.65) {
              const text =
                next() < 0.5 ? far.value.slice(far.composition.start, far.composition.end) : word();
              operation = { kind: "edit", edit: { contextId, text, before: "", after: "" } };
              label = "commit";
              totals.commits += 1;
            } else if (choice < 0.8) {
              operation = {
                kind: "compose",
                composition: { contextId, text: "", selectionStart: 0, selectionEnd: 0 },
              };
              label = "cancel";
              totals.cancels += 1;
            } else if (choice < 0.85) {
              operation = { kind: "edit", edit: { contextId, text: "", before: "", after: "" } };
              label = "empty edit";
              totals.edits += 1;
            } else if (choice < 0.92) {
              // Another viewer takes the input while the composition is open: the composing
              // context ends, and closes its composition before the other viewer's operation.
              producer = producer === "A" ? "B" : "A";
              const way = next();
              operation =
                way < 0.4
                  ? {
                      kind: "edit",
                      edit: { contextId, text: pick(alphabet), before: "", after: "" },
                    }
                  : way < 0.8
                    ? { kind: "command", command: pick(commands) }
                    : // CW1: a replacement of the other viewer's, refused alone.
                      {
                        kind: "edit",
                        edit: { contextId, text: pick(alphabet), before: "zz", after: "" },
                      };
              label = `viewer ${producer}`;
              totals.viewers += 1;
            } else {
              operation = {
                kind: "compose",
                composition: {
                  contextId: old.at(-1) ?? crypto.randomUUID(),
                  text: word(),
                  selectionStart: 0,
                  selectionEnd: 0,
                },
              };
              label = "stale update";
              totals.stale += 1;
            }
          } else if (choice < 0.35) {
            operation = {
              kind: "edit",
              edit: { contextId, text: next() < 0.2 ? "" : pick(alphabet), ...around() },
            };
            label = "edit";
            totals.edits += 1;
          } else if (choice < 0.6) {
            operation = { kind: "command", command: pick(commands) };
            label = "command";
            totals.commands += 1;
          } else if (choice < 0.8) {
            // A composition's start, with the text around it restated (a refused one when the
            // text does not match).
            const text = word();
            operation = {
              kind: "compose",
              composition: { contextId, text, ...inner(text), ...around() },
            };
            label = "start";
            totals.starts += 1;
          } else if (choice < 0.9) {
            const text = pick(["pasted", "א b", "👩‍💻e\u0301"]);
            operation = {
              kind: "paste",
              items: [{ type: "text/plain", bytes: new TextEncoder().encode(text) }],
            };
            label = `paste ${JSON.stringify(text)}`;
            totals.pastes += 1;
          } else if (next() < 0.5) {
            operation = {
              kind: "edit",
              edit: {
                contextId: old.at(-1) ?? crypto.randomUUID(),
                text: pick(alphabet),
                before: "",
                after: "",
              },
            };
            label = "stale edit";
            totals.stale += 1;
          } else {
            // CV1: a command made in an earlier context (or another field's).
            operation = {
              kind: "command",
              // The model's commands (selectAll, which it does not model, is the named test's).
              command: pick(commands),
              contextId: old.at(-1) ?? crypto.randomUUID(),
            };
            label = "stale command";
            totals.stale += 1;
          }
          steps.push(
            `${label} ${JSON.stringify(
              operation.kind === "edit"
                ? { ...operation.edit, contextId: undefined }
                : operation.kind === "compose"
                  ? { ...operation.composition, contextId: undefined }
                  : operation.kind === "command"
                    ? operation.command
                    : "",
            )}`,
          );
          const refusedBefore = far.refused.length;
          far.take(operation, producer);
          const real = await send(operation, producer);
          const modelRefused = far.refused.length > refusedBefore;
          totals.operations += 1;
          if (!real) {
            totals.refusals += 1;
            old.push(contextId);
            // The page rotated its context; the model's own rotation names another id.
            await settle();
            far.contextId = observer.context.contextId;
          }
          const failure = `${kind} seed ${current}: ${steps.join("; ")}`;
          expect(modelRefused, `${failure}: refused`).toBe(!real);
          const page_ = await read(page, kind);
          expect(page_.value, `${failure}: text`).toBe(far.value);
          expect(page_.caret, `${failure}: caret`).toBe(far.caret);
        }
        // Whatever composition is open ends with its text, as the reducer's interrupt commits it.
        if (far.composition) {
          const commit: EditingOperation = {
            kind: "edit",
            edit: {
              contextId: observer.context.contextId!,
              text: far.value.slice(far.composition.start, far.composition.end),
              before: "",
              after: "",
            },
          };
          far.take(commit, producer);
          expect(await send(commit, producer)).toBe(true);
          const page_ = await read(page, kind);
          expect(page_.value, `${kind} seed ${current}: final commit`).toBe(far.value);
        }
        totals.closes += far.closed.length;
        totals.sequences += 1;
      }
    });
  }
  afterAll(() => {
    process.stdout.write(`far-field model, ${kind}: ${JSON.stringify(totals)}\n`);
  });
});
