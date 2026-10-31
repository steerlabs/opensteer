// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer.js";

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
    const render = (disabled: boolean) =>
      act(() =>
        root.render(
          <Composer disabled={disabled} onSend={send} onStop={stop} placeholder="Reply…" running />,
        ),
      );
    render(false);
    const field = node.querySelector("textarea")!;
    field.focus();
    render(true);
    expect(field.disabled).toBe(false);
    expect(field.readOnly).toBe(false);
    expect(document.activeElement).toBe(field);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "Keep this draft",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
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
      replay: false,
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
    const field = node.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "Preserve me",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(),
    );
    expect(field.value).toBe("Preserve me");
    expect(node.textContent).toContain("Not sent");
    render(true);
    expect(field.readOnly).toBe(true);
    expect(node.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(
      true,
    );
  });
});

it("places leading footer content before the trailing model control", () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  act(() =>
    root.render(
      <Composer
        placeholder="What should Opensteer do?"
        onSend={async () => {}}
        leadingFooter={<button type="button">Opensteer</button>}
        footerExtras={<button type="button">GPT</button>}
      />,
    ),
  );
  const footer = node.querySelector(".composer__footer")!;
  expect(
    [...footer.querySelectorAll("button")].map(
      (button) => button.textContent || button.getAttribute("aria-label"),
    ),
  ).toEqual(["Opensteer", "GPT", "Send message"]);
});
