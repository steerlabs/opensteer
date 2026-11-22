import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EditingOperation } from "../packages/client/src/editing/types.js";
import type { CdpSession } from "../packages/browser-runtime-core/src/browser/backend.js";
import { editingCommandParameters } from "../packages/browser-runtime-core/src/browser/editing-commands.js";
import { PageEditingObserver } from "../packages/browser-runtime-core/src/browser/editing-observer.js";
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
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
});
afterAll(async () => {
  await browser?.close();
});

function handle(session: CDPSession): CdpSession {
  const send = session.send.bind(session) as unknown as CdpSession["send"];
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

  /** Sends one operation to the real page as the controller does: text, composition or command. */
  const send = async (operation: EditingOperation) => {
    if (operation.kind === "edit") return observer.edit(operation.edit, false);
    if (operation.kind === "compose") return observer.edit(operation.composition, true);
    if (operation.kind === "command")
      await observer.input(() =>
        cdp.send(
          "Input.dispatchKeyEvent",
          editingCommandParameters(operation.command, process.platform),
        ),
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

  const totals = { operations: 0, refusals: 0, sequences: 0 };
  for (let chunk = 1; chunk <= seeds; chunk += 20) {
    const last = Math.min(chunk + 19, seeds);
    it(`agrees on text, caret and refusals over seeds ${chunk} to ${last}`, async () => {
      for (let current = chunk; current <= last; current++) {
        const next = random(current * 7919 + (kind === "textarea" ? 1 : 2));
        const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
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
        const steps: string[] = [`seed ${JSON.stringify(initial)} at ${caret}`];
        for (let step = 0; step < opsPerSeed; step++) {
          const where = boundaries(far.value);
          const choice = next();
          let operation: EditingOperation;
          if (choice < 0.55) {
            // An edit around the caret, as the reducer restates it: what is before and after it.
            const from = pick(where.filter((at) => at <= far.caret));
            const to = pick(where.filter((at) => at >= far.caret));
            const wrong = next() < 0.1;
            operation = {
              kind: "edit",
              edit: {
                contextId: observer.context.contextId,
                text: next() < 0.2 ? "" : pick(alphabet),
                before: wrong ? "zz" : far.value.slice(from, far.caret),
                after: far.value.slice(far.caret, to),
              },
            };
          } else {
            operation = { kind: "command", command: pick(commands) };
          }
          steps.push(
            JSON.stringify(
              operation.kind === "edit"
                ? { ...operation.edit, contextId: undefined }
                : operation.command,
            ),
          );
          const refusedBefore = far.refused.length;
          far.take(operation);
          let real = true;
          if (operation.kind === "edit") real = await observer.edit(operation.edit, false);
          else
            await observer.input(() =>
              cdp.send(
                "Input.dispatchKeyEvent",
                editingCommandParameters(operation.command, process.platform),
              ),
            );
          const modelRefused = far.refused.length > refusedBefore;
          totals.operations += 1;
          if (!real) {
            totals.refusals += 1;
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
        totals.sequences += 1;
      }
    });
  }
  afterAll(() => {
    process.stdout.write(
      `far-field model, ${kind}: ${totals.sequences} sequences, ${totals.operations} operations, ${totals.refusals} refused\n`,
    );
  });
});
