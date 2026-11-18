// @vitest-environment happy-dom
import { act } from "react";
import { controlledClientSession } from "@opensteer/client/test-support";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer.js";
import { composerField, rewrite, textareaView } from "./composer-editor.test-support.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("composer connection transitions", () => {
  it("keeps typing and focus through disconnects, blocks Enter and Stop, and sends once after recovery", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const send = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const { connection } = controlledClientSession();
    const render = (disabled: boolean) =>
      act(() =>
        root.render(
          <Composer
            connection={connection}
            disabled={disabled}
            onSend={send}
            onStop={stop}
            placeholder="Reply…"
            running
          />,
        ),
      );
    render(false);
    const field = textareaView(composerField(node));
    field.focus();
    render(true);
    expect(field.disabled).toBe(false);
    expect(field.readOnly).toBe(false);
    expect(document.activeElement).toBe(field.element);
    act(() => {
      rewrite(field.element, "Keep this draft");
    });
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(send).not.toHaveBeenCalled();
    const stopButton = node.querySelector<HTMLButtonElement>('[aria-label="Stop the run"]')!;
    expect(stopButton.disabled).toBe(true);
    await act(async () => stopButton.click());
    expect(stop).not.toHaveBeenCalled();
    render(false);
    expect(field.value).toBe("Keep this draft");
    // Typed against a running turn, the draft is queued: the send arrow says so
    // and sits beside Stop rather than replacing it.
    const sendButton = node.querySelector<HTMLButtonElement>('[aria-label="Queue message"]')!;
    expect(sendButton.disabled).toBe(false);
    expect(node.querySelector('[aria-label="Stop the run"]')).not.toBeNull();
    await act(async () => sendButton.click());
    expect(send).toHaveBeenCalledExactlyOnceWith("Keep this draft", {
      attachments: [],
      idempotencyKey: expect.any(String),
      places: [],
      scope: connection.getSnapshot().scope,
    });
    expect(field.value).toBe("");
    expect(node.querySelector('[aria-label="Queue message"]')).toBeNull();
    expect(node.textContent).not.toContain("Reconnect");
  });

  // In Chat a message sent while Opensteer replies joins that reply; nothing
  // waits in a queue, so the arrow never says it queues.
  it("calls Send what it is in Chat while a reply runs, and keeps Queue message for work", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const draw = (variant: "conversation" | "work") =>
      act(() =>
        root.render(
          <Composer
            onSend={vi.fn(async () => undefined)}
            onStop={vi.fn(async () => undefined)}
            placeholder="Ask anything…"
            restore={{ key: 1, text: "Keep it short" }}
            running
            stopLabel={variant === "conversation" ? "Stop the reply" : "Stop the run"}
            variant={variant}
          />,
        ),
      );
    draw("conversation");
    const send = node.querySelector<HTMLButtonElement>(".composer__send");
    expect(send?.getAttribute("aria-label")).toBe("Send message");
    expect(send?.title).toBe("Send message");
    expect(node.querySelector('[aria-label="Stop the reply"]')).not.toBeNull();
    draw("work");
    expect(node.querySelector(".composer__send")?.getAttribute("aria-label")).toBe("Queue message");
  });

  it("restores a failed submission and keeps archived threads read-only", async () => {
    const node = document.createElement("div");
    root = createRoot(node);
    const send = vi.fn(async () => {
      throw new Error("Not sent");
    });
    const render = (readOnly: boolean) =>
      act(() => root.render(<Composer onSend={send} placeholder="Reply…" readOnly={readOnly} />));
    render(false);
    const field = textareaView(composerField(node));
    // A refused message comes back as the exact Markdown it was sent as.
    const words = "Preserve [the plan](opensteer:thr_12345678-1234-4234-8234-123456789abc) me";
    act(() => {
      rewrite(field.element, words);
    });
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(),
    );
    expect(send).toHaveBeenCalledWith(words, expect.anything());
    expect(field.value).toBe(words);
    expect(node.textContent).toContain("Couldn't confirm");
    render(true);
    expect(field.readOnly).toBe(true);
    expect(node.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(
      true,
    );
  });
});
