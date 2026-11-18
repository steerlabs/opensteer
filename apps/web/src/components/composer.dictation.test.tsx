// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DictationController } from "@opensteer/client/dictation";
import type {
  DictationAvailability,
  DictationEvent,
  DictationPort,
} from "@opensteer/protocol/dictation";
import { composerDrafts } from "./composer-drafts.js";
import { Composer } from "./composer.js";
import {
  composerField,
  mod,
  pressKey,
  rewrite,
  textareaView,
} from "./composer-editor.test-support.js";
import * as dictationHooks from "./dictation.js";
import { DictationContext } from "./dictation.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let controller: DictationController;
afterEach(() => {
  act(() => root?.unmount());
  controller?.dispose();
  document.body.replaceChildren();
});
const ready: DictationAvailability = {
  available: true,
  languageName: "English",
  locale: "en-US",
  model: "installed",
  microphone: "granted",
};
async function setup(
  availability: DictationAvailability | null = ready,
  draftKey: string | null = null,
) {
  let receive: (event: DictationEvent) => void = () => {};
  let session = "";
  let seq = 0;
  const port: DictationPort = {
    availability: async () => availability!,
    subscribe: (listener) => {
      receive = listener;
      return () => {};
    },
    start: vi.fn(async (id) => {
      session = id;
      seq = 0;
    }),
    download: vi.fn(async (id) => {
      session = id;
      seq = 0;
    }),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    openMicrophoneSettings: vi.fn(async () => {}),
  };
  controller = new DictationController({
    port: availability ? port : null,
    createId: () => "12345678-1234-4123-8123-123456789abc",
  });
  await controller.refresh();
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const send = vi.fn(async (_body: string) => {});
  const restore = { key: 1, text: "a bad day" };
  const render = (disabled = false, second = false, hidden = false) =>
    act(() =>
      root!.render(
        <DictationContext value={controller}>
          <Composer
            disabled={disabled}
            draftKey={draftKey}
            hidden={hidden}
            onSend={send}
            placeholder="Reply…"
            restore={restore}
          />
          {second ? <Composer onSend={send} placeholder="Second" /> : null}
        </DictationContext>,
      ),
    );
  render();
  const field = textareaView(composerField(node));
  const click = async (label: string) =>
    act(async () => node.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  const emit = async (
    event:
      | Omit<Extract<DictationEvent, { type: "text" }>, "session" | "seq">
      | Omit<Extract<DictationEvent, { type: "ended" }>, "session" | "seq">
      | { type: "listening" }
      | { type: "downloading"; progress: number }
      | { type: "level"; level: number },
  ) => act(async () => receive({ ...event, session, seq: ++seq } as DictationEvent));
  const start = async () => {
    field.setSelectionRange(2, 5);
    await click("Start dictation (English)");
    await emit({ type: "listening" });
  };
  const text = () => emit({ type: "text", finalized: [], volatile: ["good"] });
  const end = (reason: "completed" | "cancelled" | "failed" = "completed") =>
    emit({ type: "ended", reason, error: reason === "failed" ? "recognition-failed" : null });
  const key = async (key: string, composing = false) =>
    act(async () =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, isComposing: composing }),
      ),
    );
  const edit = async (value: string) => rewrite(field.element, value);
  return { node, port, field, send, render, click, emit, start, text, end, key, edit };
}
it.each([null, { available: false, reason: "os" } as const])(
  "hides unsupported dictation: %s",
  async (availability) => {
    const { node } = await setup(availability);
    expect(node.querySelector('[title="Dictate"]')).toBeNull();
  },
);
it("previews a selection without changing the draft, places the caret, and cancels exactly", async () => {
  const t = await setup();
  await t.start();
  await t.text();
  expect(t.field.value).toBe("a good day");
  expect(t.field.selectionStart).toBe(6);
  await t.click("Cancel dictation");
  expect(t.field.value).toBe("a bad day");
  expect(t.field.selectionStart).toBe(2);
  expect(t.field.selectionEnd).toBe(5);
});
it("disables another composer and leaves on hide", async () => {
  const t = await setup();
  t.render(false, true);
  await t.start();
  expect(t.node.querySelectorAll<HTMLButtonElement>('[title="Dictate"]')[0]!.disabled).toBe(true);
  t.render(false, true, true);
  expect(t.port.stop).toHaveBeenCalledOnce();
});
it.each([false, true])(
  "adopts typing while finishing=%s and aborts a pending send",
  async (finishing) => {
    const t = await setup();
    await t.start();
    await t.text();
    if (finishing) await t.click("Send message");
    await t.edit("a good day!");
    await t.end();
    expect(t.field.value).toBe("a good day!");
    expect(t.port.cancel).toHaveBeenCalledOnce();
    expect(t.send).not.toHaveBeenCalled();
  },
);
it("preserves IME precedence and adopts the displayed text at composition start", async () => {
  const t = await setup();
  await t.start();
  await t.text();
  await t.key("Enter", true);
  expect(t.port.stop).not.toHaveBeenCalled();
  await act(async () => t.field.dispatchEvent(new Event("compositionstart", { bubbles: true })));
  expect(t.port.cancel).toHaveBeenCalledOnce();
  expect(t.field.value).toBe("a good day");
});
it("Escape stops and retains finalized text", async () => {
  const t = await setup();
  await t.start();
  await t.key("Escape");
  expect(t.port.stop).toHaveBeenCalledOnce();
  await t.emit({ type: "text", finalized: ["good"], volatile: [] });
  await t.end();
  expect(t.field.value).toBe("a good day");
  expect(t.send).not.toHaveBeenCalled();
});
it.each([
  ["Enter", null],
  ["Send message", "dictated-send"],
] as const)("%s finishes and sends the exact committed text once", async (action, draftKey) => {
  const t = await setup(ready, draftKey);
  await t.start();
  await t.text();
  if (action === "Enter") {
    await t.key(action);
    await t.key(action);
  } else {
    await t.click(action);
    await t.click(action);
  }
  expect(t.send).not.toHaveBeenCalled();
  await t.emit({ type: "text", finalized: ["great"], volatile: [] });
  await t.end();
  await vi.waitFor(() => expect(t.send).toHaveBeenCalledOnce());
  expect(t.send.mock.calls[0]?.[0]).toBe("a great day");
  if (draftKey) await vi.waitFor(() => expect(composerDrafts.read(draftKey)).toBeNull());
});
it.each(["completed", "failed", "cancelled"] as const)(
  "handles empty/failed/aborted finish: %s",
  async (reason) => {
    const t = await setup();
    await t.start();
    await t.click("Send message");
    await t.end(reason);
    expect(t.send).toHaveBeenCalledTimes(reason === "completed" ? 1 : 0);
  },
);
it("rechecks send gates after awaiting", async () => {
  const t = await setup();
  await t.start();
  await t.click("Send message");
  t.render(true);
  await t.end();
  expect(t.send).not.toHaveBeenCalled();
});
it("leaves on unmount and never sends afterwards", async () => {
  const t = await setup();
  await t.start();
  await t.click("Send message");
  act(() => root!.unmount());
  root = undefined;
  await t.end();
  expect(t.send).not.toHaveBeenCalled();
});
it("keeps words recognised after leaving in the draft they were spoken into", async () => {
  const draft = "dictated-draft";
  const t = await setup(ready, draft);
  await vi.waitFor(() => expect(composerDrafts.read(draft)?.text).toBe("a bad day"));
  await t.start();
  await t.text();
  act(() => root!.unmount());
  root = undefined;
  await t.end();
  expect(t.port.stop).toHaveBeenCalled();
  await vi.waitFor(() => expect(composerDrafts.read(draft)?.text).toBe("a good day"));
  await composerDrafts.clear(draft);
});
it("opens microphone settings from the owner notice", async () => {
  const t = await setup({ ...ready, microphone: "denied" } as DictationAvailability);
  await t.click("Start dictation (English)");
  await act(async () =>
    [...t.node.querySelectorAll("button")].find((b) => b.textContent === "Open Settings")!.click(),
  );
  expect(t.port.openMicrophoneSettings).toHaveBeenCalledOnce();
});
it("shows download progress and readiness without starting capture", async () => {
  const t = await setup({ ...ready, model: "download" } as DictationAvailability);
  await t.click("Start dictation (English)");
  await t.emit({ type: "downloading", progress: 0.42 });
  expect(t.node.textContent).toContain("42%");
  await t.end();
  expect(t.node.textContent).toContain("English is ready.");
  expect(t.port.start).not.toHaveBeenCalled();
});

it("inserts at the caret, respects selection moves until new words, and keeps failure text", async () => {
  const t = await setup();
  t.field.setSelectionRange(1, 1);
  await t.click("Start dictation (English)");
  await t.emit({ type: "listening" });
  await t.text();
  expect(t.field.value).toBe("a good bad day");
  t.field.setSelectionRange(0, 0);
  await t.emit({ type: "downloading", progress: 0.2 });
  expect(t.field.selectionStart).toBe(0);
  await t.emit({ type: "text", finalized: [], volatile: ["very good"] });
  expect(t.field.selectionStart).toBe(11);
  await t.end("failed");
  expect(t.field.value).toBe("a very good bad day");
  expect(t.send).not.toHaveBeenCalled();
});

it("keeps downloading when the person edits their message", async () => {
  const t = await setup({ ...ready, model: "download" } as DictationAvailability);
  await t.click("Start dictation (English)");
  await t.edit("Keep writing during download");
  expect(t.port.cancel).not.toHaveBeenCalled();
  await t.emit({ type: "downloading", progress: 0.42 });
  expect(t.node.textContent).toContain("42%");
  t.field.setSelectionRange(10, 10);
  await t.click("Cancel download");
  expect(t.field.value).toBe("Keep writing during download");
  expect(t.field.selectionStart).toBe(10);
});

it("dictates beside a reference without breaking it, and undoes the words as one step", async () => {
  const t = await setup();
  const link = "[Fix the build](opensteer:thr_12345678-1234-4234-8234-123456789abc)";
  await t.edit(`${link} bad day`);
  const at = link.length + 1;
  const dictate = async () => {
    t.field.setSelectionRange(at, at + 3);
    await t.click("Start dictation (English)");
    await t.emit({ type: "listening" });
    await t.text();
    expect(t.field.value).toBe(`${link} good day`);
  };
  await dictate();
  await t.click("Cancel dictation");
  expect(t.field.value).toBe(`${link} bad day`);
  expect([t.field.selectionStart, t.field.selectionEnd]).toEqual([at, at + 3]);
  await dictate();
  await t.end();
  expect(t.field.value).toBe(`${link} good day`);
  pressKey(t.field.element, "z", mod);
  expect(t.field.value).toBe(`${link} bad day`);
});

it("consumes the committed caret even when final text matches the preview", async () => {
  const t = await setup();
  await t.start();
  await t.text();
  await t.emit({ type: "text", finalized: ["good"], volatile: [] });
  await t.end();
  await t.edit("a good day!");
  expect(t.field.selectionStart).toBe(11);
  expect(t.field.selectionEnd).toBe(11);
});

it("returns keyboard mic activation to the field and handles Escape from toolbar focus", async () => {
  const t = await setup();
  const mic = t.node.querySelector<HTMLButtonElement>('[title="Dictate"]')!;
  mic.focus();
  await t.click("Start dictation (English)");
  expect(document.activeElement).toBe(t.field.element);
  const cancel = t.node.querySelector<HTMLButtonElement>('[aria-label="Cancel dictation"]')!;
  cancel.focus();
  await act(async () =>
    cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(t.port.stop).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(t.field.element);
});
it.each(["stop", "cancel"])(
  "announces a quiet %s once and never announces ticks",
  async (ending) => {
    const t = await setup();
    await t.start();
    await t.text();
    const status = t.node.querySelector('[aria-live="polite"]')!;
    expect(status.textContent).toBe("Listening");
    await t.click(ending === "stop" ? "Stop dictation" : "Cancel dictation");
    if (ending === "stop") await t.end();
    expect(status.textContent).toBe("Dictation stopped");
    await t.edit(t.field.value + "!");
    expect(status.textContent).toBe("Dictation stopped");
  },
);

it("shows quiet and loud speech without dropping levels or rendering the composer", async () => {
  const render = vi.spyOn(dictationHooks, "useDictation");
  const t = await setup();
  vi.useFakeTimers();
  await t.start();
  const before = render.mock.calls.length;
  const scales = () =>
    [...t.node.querySelectorAll<HTMLElement>(".dictation-level i")].map((bar) =>
      Number(bar.style.transform.match(/scaleY\(([^)]+)\)/)?.[1] ?? 0),
    );
  try {
    await t.emit({ type: "level", level: 0.03 });
    const speech = scales().at(-1)!;
    expect(speech).toBeGreaterThan(0.5);
    // IPC delivery can bunch events together; capture already limits their rate.
    await t.emit({ type: "level", level: 0.15 });
    expect(scales().at(-1)).toBeGreaterThan(speech);
    expect(scales().at(-2)).toBe(speech);
    await t.emit({ type: "level", level: 0 });
    expect(scales().at(-1)).toBeCloseTo(3 / 22);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(t.node.querySelector('[aria-label="Dictation duration"]')!.textContent).toBe("0:03");
    expect(render.mock.calls.length).toBe(before);
    expect(t.node.querySelector('[aria-live="polite"]')!.textContent).toBe("Listening");
    await t.click("Stop dictation");
    expect(scales().every((scale) => Math.abs(scale - 3 / 22) < 0.001)).toBe(true);
  } finally {
    vi.useRealTimers();
    render.mockRestore();
  }
});
it("rescues a focused Stop when finalization disables it", async () => {
  const t = await setup();
  await t.start();
  const stop = t.node.querySelector<HTMLButtonElement>('[aria-label="Stop dictation"]')!;
  stop.focus();
  await t.key("Enter");
  expect(stop.disabled).toBe(true);
  expect(document.activeElement).toBe(t.field.element);
  await t.end();
});

it("starts on primary pointerdown and shows the bar before listening without double start", async () => {
  const t = await setup();
  const mic = t.node.querySelector<HTMLButtonElement>('[title="Dictate"]')!;
  await act(async () =>
    mic.dispatchEvent(new PointerEvent("pointerdown", { button: 2, bubbles: true })),
  );
  expect(t.port.start).not.toHaveBeenCalled();
  await act(async () =>
    mic.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true })),
  );
  expect(t.port.start).toHaveBeenCalledOnce();
  expect(t.node.querySelector(".dictation-live")).not.toBeNull();
  expect(t.node.querySelector('[aria-label="Dictation duration"]')?.textContent).toBe("0:00");
  expect(t.node.querySelector(".dictation-live")?.textContent).not.toContain("Starting");
  await act(async () => mic.click());
  expect(t.port.start).toHaveBeenCalledOnce();
});
