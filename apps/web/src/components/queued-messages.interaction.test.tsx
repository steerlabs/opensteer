// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpHostClient, queuedMessages, type HostClient } from "@opensteer/client/host";
import { AttachmentReader } from "./attachments/message-attachments.js";
import { TranscriptMessage } from "./agent-activity.js";
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
  userId = "me",
): ThreadInputQueue["items"][number] {
  return {
    ...flags,
    canMove: flags.canCancel,
    input: { policy: "queue", state: "pending" },
    message: {
      author: { displayName: userId === "me" ? "Me" : "Sam", kind: "human", userId },
      content: [{ text, type: "text" }],
      createdAt: "2026-10-31T12:00:00.000Z",
      id,
      kind: "input",
      runId: null,
      sequence: "1",
    },
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
  it("keeps one image read when a queued message is taken before download finishes", async () => {
    const client = new HttpHostClient({ baseUrl: "http://127.0.0.1", refreshIntervalMs: 0 });
    const bytes = {
      ok: true as const,
      data: {
        bytes: new Uint8Array([1]),
        metadata: {
          contentType: "image/png",
          etag: "image",
          modifiedAt: null,
          sizeBytes: 1,
          truncated: false as const,
        },
      },
    };
    let complete!: (value: typeof bytes) => void;
    const rpc = vi.fn<(typeof client.rpc)["attachment.content"]>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    Object.defineProperty(client.rpc, "attachment.content", { value: rpc });
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const pending = item("image-message", "Photo", { canCancel: false, canSteer: false });
      const queue = queueOf({
        items: [
          {
            ...pending,
            message: {
              ...pending.message,
              content: [
                {
                  artifactId: "image",
                  type: "artifact",
                  mediaType: "image/png",
                  name: "photo.png",
                  sizeBytes: 1,
                },
              ],
            },
          },
        ],
        paused: false,
        steerRunId: null,
        threadId: "thread",
      });
      const container = mount(
        <AttachmentReader value={client}>
          <QueuedMessages
            client={client}
            disabled={false}
            onEdit={vi.fn()}
            onError={vi.fn()}
            queue={queue}
            viewerUserId="me"
            workspaces={[]}
          />
        </AttachmentReader>,
      );
      expect(rpc).toHaveBeenCalledTimes(1);
      act(() =>
        root?.render(
          <AttachmentReader value={client}>
            <TranscriptMessage
              message={queuedMessages(queue)[0]!.entry}
              reveal={null}
              viewerUserId="me"
              workspaces={[]}
            />
          </AttachmentReader>,
        ),
      );
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      await act(async () => complete(bytes));
      expect(container.querySelector('img[src="blob:preview"]')).not.toBeNull();
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root?.unmount());
      root = null;
      client.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

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
        viewerUserId="me"
        workspaces={[]}
        queue={queueOf({
          items: [
            item("mine", "Use the new direction", { canCancel: true, canSteer: true }),
            item("theirs", "Someone else's message", { canCancel: false, canSteer: false }, "sam"),
          ],
          paused: false,
          steerRunId: "run",
          threadId: "thread",
        })}
      />,
    );
    // Each is the bubble it will be once sent, marked as waiting by its edge.
    const mine = container.querySelector('[data-message-id="mine"]');
    expect(mine?.classList.contains("msg--queued")).toBe(true);
    expect(mine?.querySelector(".msg--user")?.textContent).toBe("Use the new direction");
    const theirs = container.querySelector('[data-message-id="theirs"]');
    expect(theirs?.classList.contains("msg--queued")).toBe(true);
    expect(theirs?.querySelector(".input-card")?.textContent).toContain("Someone else's message");
    expect(
      [...container.querySelectorAll(".queued__status")].map((node) => node.textContent),
    ).toEqual(["Up next", "Queued"]);
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
        viewerUserId="me"
        workspaces={[]}
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

  it("holds a paused queue behind Resume, and disables every action when the reader cannot respond", async () => {
    const resumeThreadInputQueue = vi.fn(async () => undefined);
    const queue = queueOf({
      items: [item("mine", "Waiting", { canCancel: true, canSteer: true })],
      paused: true,
      steerRunId: "run",
      threadId: "thread",
    });
    const props = { onEdit: vi.fn(), onError: vi.fn(), queue, viewerUserId: "me", workspaces: [] };
    const client = { resumeThreadInputQueue } as unknown as HostClient;
    const container = mount(<QueuedMessages client={client} disabled={false} {...props} />);
    expect(container.querySelector(".queued__paused")?.textContent).toContain("Paused");
    // Paused, no message is the one the next Run takes.
    expect(container.querySelector(".queued__status")?.textContent).toBe("Queued");
    const resume = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Resume",
    );
    await act(async () => resume!.click());
    expect(resumeThreadInputQueue).toHaveBeenCalledWith("thread");

    act(() => root?.render(<QueuedMessages client={client} disabled {...props} />));
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("folds a long queue behind the messages next in line", () => {
    const container = mount(
      <QueuedMessages
        client={{} as HostClient}
        disabled={false}
        onEdit={vi.fn()}
        onError={vi.fn()}
        queue={queueOf({
          items: ["a", "b", "c", "d", "e"].map((id) =>
            item(id, `Message ${id}`, { canCancel: true, canSteer: false }),
          ),
          paused: false,
          steerRunId: null,
          threadId: "thread",
        })}
        viewerUserId="me"
        workspaces={[]}
      />,
    );
    const shown = () =>
      [...container.querySelectorAll(".queued__item")].map((node) =>
        node.querySelector("[data-message-id]")?.getAttribute("data-message-id"),
      );
    expect(shown()).toEqual(["a", "b"]);
    const more = container.querySelector<HTMLButtonElement>(".queued__more")!;
    expect(more.textContent).toBe("Show 3 more");
    act(() => more.click());
    expect(shown()).toEqual(["a", "b", "c", "d", "e"]);
    expect(more.textContent).toBe("Show fewer");
  });
});
