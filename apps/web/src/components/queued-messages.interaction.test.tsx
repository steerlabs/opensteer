// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import type { ThreadInputQueue } from "@opensteer/core";
import { QueuedMessages } from "./queued-messages.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function item(
  id: string,
  text: string,
  flags: { canCancel: boolean; canSteer: boolean },
): ThreadInputQueue["items"][number] {
  return {
    ...flags,
    canMove: flags.canCancel,
    input: {},
    message: { author: { kind: "human" }, content: [{ text, type: "text" }], id },
  } as unknown as ThreadInputQueue["items"][number];
}

function queueOf(queue: {
  items: ThreadInputQueue["items"];
  paused: boolean;
  steerRunId: string | null;
  threadId: string;
}): ThreadInputQueue {
  return queue as unknown as ThreadInputQueue;
}

function mount(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function buttons(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent ?? "",
  );
}

describe("QueuedMessages", () => {
  it("offers Steer, Edit and Remove only where the Host said it would honour them", async () => {
    const steerThreadInput = vi.fn(async () => undefined);
    const cancelThreadInput = vi.fn(async () => undefined);
    const client = { cancelThreadInput, steerThreadInput } as unknown as HostClient;
    const container = mount(
      <QueuedMessages
        client={client}
        disabled={false}
        onEdit={vi.fn()}
        onError={vi.fn()}
        queue={queueOf({
          items: [
            item("mine", "Use the new direction", { canCancel: true, canSteer: true }),
            item("theirs", "Someone else's message", { canCancel: false, canSteer: false }),
          ],
          paused: false,
          steerRunId: "run",
          threadId: "thread",
        })}
      />,
    );
    expect(container.textContent).toContain("Use the new direction");
    expect(container.textContent).toContain("Someone else's message");
    expect(buttons(container)).toEqual([
      "Steer the current run with this message",
      "Edit this message",
      "Remove this message from the queue",
    ]);

    const [steer, , remove] = container.querySelectorAll("button");
    await act(async () => steer!.click());
    expect(steerThreadInput).toHaveBeenCalledWith("thread", "mine");
    await act(async () => remove!.click());
    expect(cancelThreadInput).toHaveBeenCalledWith("thread", "mine");
  });

  it("reports a refused action and frees the row for another try", async () => {
    const onError = vi.fn();
    const steerThreadInput = vi
      .fn()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue(undefined);
    const client = { steerThreadInput } as unknown as HostClient;
    const container = mount(
      <QueuedMessages
        client={client}
        disabled={false}
        onEdit={vi.fn()}
        onError={onError}
        queue={queueOf({
          items: [item("mine", "Course correct", { canCancel: false, canSteer: true })],
          paused: false,
          steerRunId: "run",
          threadId: "thread",
        })}
      />,
    );
    const steer = () => container.querySelector("button")!;
    await act(async () => steer().click());
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(steer().disabled).toBe(false);
    await act(async () => steer().click());
    expect(steerThreadInput).toHaveBeenCalledTimes(2);
  });

  it("disables every action when the reader cannot respond", () => {
    const container = mount(
      <QueuedMessages
        client={{} as HostClient}
        disabled
        onEdit={vi.fn()}
        onError={vi.fn()}
        queue={queueOf({
          items: [item("mine", "Waiting", { canCancel: true, canSteer: true })],
          paused: true,
          steerRunId: "run",
          threadId: "thread",
        })}
      />,
    );
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });
});
