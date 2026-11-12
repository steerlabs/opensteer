// @vitest-environment happy-dom
import { createId } from "@opensteer/core";
import { mockCardUseRequest } from "@opensteer/client/mock";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  click,
  element,
  mount,
  settle,
  goTo,
  history,
  client,
  teamHost,
  teamSession,
  write,
} from "../components/workspace/workspace.interaction.test-support.js";

const field = () => element<HTMLTextAreaElement>(".team-composer__input");
const rowsSaying = (text: string) =>
  [...document.querySelectorAll<HTMLElement>(".channel .tmsg")].filter((row) =>
    row.textContent?.includes(text),
  );

async function openChannel() {
  await mount("/", { team: true });
  await click(element('.side-switch__option:not([data-value="tasks"])'));
  await click(element(".team-row__main"));
  await settle();
}

async function send(text: string) {
  await write(field(), text);
  await click(element(".channel .composer__send"));
  await settle(50);
}

describe("sending in a channel", () => {
  it("shows a message whose answer was lost once, and still once after reconnecting", async () => {
    await openChannel();
    const stored = teamHost!.messages.size;
    teamHost!.loseNextSendAck = true;

    await send("Hello once");
    // The Host kept it and the socket delivered it; the unconfirmed send is the same message.
    expect(teamSession!.getSnapshot().pending).toHaveLength(1);
    expect(rowsSaying("Hello once")).toHaveLength(1);

    await act(async () => {
      teamSession!.disconnect();
      teamSession!.connect();
    });
    await settle(50);
    expect(teamSession!.getSnapshot().pending).toHaveLength(0);
    expect(rowsSaying("Hello once")).toHaveLength(1);
    expect(teamHost!.messages.size).toBe(stored + 1);
  });

  it("holds a message written offline as waiting, and sends it once on reconnecting", async () => {
    await openChannel();
    const stored = teamHost!.messages.size;
    await act(async () => teamSession!.disconnect());

    await send("Written offline");
    expect(rowsSaying("Written offline")).toHaveLength(1);
    expect(rowsSaying("Written offline")[0]!.textContent).toContain("Waiting for connection");

    await act(async () => teamSession!.connect());
    await settle(50);
    expect(rowsSaying("Written offline")).toHaveLength(1);
    expect(rowsSaying("Written offline")[0]!.textContent).not.toContain("Waiting for connection");
    expect(teamHost!.messages.size).toBe(stored + 1);
  });
  it("restores separate channel and thread drafts after navigation and retains a refused local send", async () => {
    await openChannel();
    const path = history.at(-1)!.path;
    await write(field(), "Channel draft");
    await act(async () => goTo!("/"));
    await act(async () => goTo!(path));
    expect(field().value).toBe("Channel draft");
    const result = await teamHost!.rpc["commands.dispatch"]({
      type: "team.message.send",
      channelId: teamHost!.bootstrap.sidebar.channels[0]!.channel.id,
      threadRootId: null,
      bodyMarkdown: "Root",
      mentions: [],
      attachmentIds: [],
      clientMessageId: crypto.randomUUID(),
    });
    if (!result.ok || result.data.type !== "team.message.send") throw new Error("Missing root");
    const rootId = result.data.message.id;
    await act(async () => goTo!(`${path}/t/${rootId}`));
    await act(async () => {
      await vi.waitFor(
        () => expect(document.querySelector(".thread-pane .team-composer__input")).not.toBeNull(),
        { timeout: 1000 },
      );
    });
    const threadField = element<HTMLTextAreaElement>(".thread-pane .team-composer__input");
    await write(threadField, "Thread draft");
    await act(async () => goTo!(path));
    expect(field().value).toBe("Channel draft");
    const text = "😀".repeat(5000);
    await write(field(), text);
    await click(element(".channel .composer__send"));
    expect(field().value).toBe(text);
    expect(teamSession!.getSnapshot().pending).toEqual([]);
    expect(Object.values(teamSession!.getSnapshot().drafts)).toContain(text);
    await act(async () => goTo!(`${path}/t/${rootId}`));
    await act(async () => {
      await vi.waitFor(
        () =>
          expect(element<HTMLTextAreaElement>(".thread-pane .team-composer__input").value).toBe(
            "Thread draft",
          ),
        { timeout: 1000 },
      );
    });
  });

  it("changes the existing Tasks/team control with standard radio keys", async () => {
    await mount("/", { team: true });
    const tasks = element<HTMLButtonElement>('[role="radio"][data-value="tasks"]');
    tasks.focus();
    await act(async () =>
      tasks.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      ),
    );
    const selected = element<HTMLButtonElement>('[role="radio"][aria-checked="true"]');
    expect(selected.dataset.value).not.toBe("tasks");
    expect(document.activeElement).toBe(selected);
    expect(document.querySelector(".team-side")).not.toBeNull();
    await act(async () =>
      selected.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      ),
    );
    expect(tasks.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(tasks);
  });

  it("reaches a second Needs you request page, keeping two asks on one task as separate cards", async () => {
    const request = mockCardUseRequest();
    const requests = Array.from({ length: 55 }, (_, index) => ({
      ...request,
      id: createId("request"),
      presentation: { ...request.presentation, title: `Ask ${index + 1}` },
    }));
    await mount("/tasks?filter=needs-you", { mock: { pendingRequests: requests } });
    expect(client.getSnapshot().needsYou?.entries).toHaveLength(50);
    expect(document.querySelectorAll(".needs-card").length).toBeGreaterThan(1);
    const more = element<HTMLButtonElement>(".all-tasks__more button");
    await click(more);
    expect(client.getSnapshot().needsYou?.entries.length).toBeGreaterThan(50);
    expect(client.getSnapshot().needsYou?.window.hasMore).toBe(false);
    expect(document.querySelector(".all-tasks__more")).toBeNull();
  });
});
