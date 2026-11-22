import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EditingOperation } from "../packages/client/src/editing/types.js";
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
function handle(session: CDPSession): CdpSession {
  const raw = session.send.bind(session) as unknown as CdpSession["send"];
  const send = ((method: string, params?: Record<string, unknown>) => {
    if (method === "Input.insertText") record.push(`text ${String(params?.text)}`);
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
    if (operation.kind === "command")
      await observer.input(
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
              operation =
                next() < 0.5
                  ? {
                      kind: "edit",
                      edit: { contextId, text: pick(alphabet), before: "", after: "" },
                    }
                  : { kind: "command", command: pick(commands) };
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
          } else {
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
