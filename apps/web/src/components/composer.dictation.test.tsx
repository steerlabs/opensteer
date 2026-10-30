// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DictationController } from "@opensteer/client/dictation";
import type {
  DictationAvailability,
  DictationEvent,
  DictationPort,
} from "@opensteer/protocol/dictation";
import { Composer } from "./composer.js";
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
async function setup(availability: DictationAvailability | null = ready) {
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
  const field = node.querySelector("textarea")!;
  const click = async (label: string) =>
    act(async () => node.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  const emit = async (
    event:
      | Omit<Extract<DictationEvent, { type: "text" }>, "session" | "seq">
      | Omit<Extract<DictationEvent, { type: "ended" }>, "session" | "seq">
      | { type: "listening" }
      | { type: "downloading"; progress: number },
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
  const edit = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
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
  expect(t.node.querySelectorAll<HTMLButtonElement>('[title="Dictate"]')[1]!.disabled).toBe(true);
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
it.each(["Enter", "Send message"])(
  "%s finishes and sends the exact committed text once",
  async (action) => {
    const t = await setup();
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
    expect(t.send).toHaveBeenCalledOnce();
    expect(t.send.mock.calls[0]?.[0]).toBe("a great day");
  },
);
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
