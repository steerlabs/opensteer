// @vitest-environment happy-dom
import { TeamChannelIdSchema, OpensteerError } from "@opensteer/core";
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

  it("keeps text locally if draft storage refuses it before send admission", async () => {
    await openChannel();
    vi.spyOn(teamSession!, "setDraft").mockRejectedValue(new Error("Storage full"));
    const text = "😀".repeat(5000);
    await write(field(), text);
    expect(field().value).toBe(text);
    await click(element(".channel .composer__send"));
    expect(field().value).toBe(text);
    expect(teamSession!.getSnapshot().pending).toEqual([]);
  });
  it("opens an old reply link in its parent thread with the target row mounted", async () => {
    await mount("/", { team: true });
    const host = teamHost!,
      channelId = host.bootstrap.sidebar.channels[0]!.channel.id;
    const root = host.post({ channelId, bodyMarkdown: "Old root" });
    const reply = host.post({ channelId, threadRootId: root.id, bodyMarkdown: "The linked reply" });
    for (let index = 0; index < 100; index++)
      host.post({ channelId, threadRootId: root.id, bodyMarkdown: `Newer reply ${index}` });
    await act(async () => goTo!(`/teams/${host.teamId}/c/${channelId}/m/${reply.id}`));
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(history.at(-1)!.path).toBe(
            `/teams/${host.teamId}/c/${channelId}/t/${root.id}/m/${reply.id}`,
          );
          expect(element(`.thread-pane [data-row-id="${reply.id}"]`).textContent).toContain(
            "The linked reply",
          );
        },
        { timeout: 1000 },
      );
    });
  });

  it("pages the search channel directory and chooses a channel beyond its first page", async () => {
    await mount("/", { team: true });
    const host = teamHost!,
      template = host.channels.values().next().value!;
    for (let index = 2; index <= 51; index++) {
      const id = TeamChannelIdSchema.parse(
        `tch_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      host.channels.set(id, { ...template, id, name: `Directory ${index}` });
    }
    const target = TeamChannelIdSchema.parse("tch_00000000-0000-4000-8000-000000000051");
    host.post({ channelId: target, bodyMarkdown: "Needle in the old channel" });
    await act(async () => goTo!(`/teams/${host.teamId}/search?q=Needle`));
    await click(element(".filter-chip"));
    const more = [...document.querySelectorAll<HTMLButtonElement>(".picker__row")].find(
      (button) => button.textContent === "More channels",
    );
    expect(more).toBeTruthy();
    await click(more!);
    const option = [...document.querySelectorAll<HTMLButtonElement>(".picker__row")].find(
      (button) => button.textContent?.includes("Directory 51"),
    );
    expect(option).toBeTruthy();
    await click(option!);
    expect(new URLSearchParams(history.at(-1)!.search).get("in")).toBe(target);
    await act(async () => {
      await vi.waitFor(
        () =>
          expect(document.querySelector(".search-hit")?.textContent).toContain(
            "Needle in the old channel",
          ),
        { timeout: 1000 },
      );
    });
  });
  it("edits a refused pending message into the composer and removes the original unsent row", async () => {
    await openChannel();
    const host = teamHost!,
      read = host.read.bind(host);
    vi.spyOn(host, "read").mockImplementation((name, input) => {
      if (name === "commands.dispatch" && (input as { type?: string }).type === "team.message.send")
        throw new OpensteerError({ code: "forbidden", message: "Posting refused" });
      return read(name, input);
    });
    await write(field(), "Refused original");
    await click(element(".channel .composer__send"));
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector(".tmsg--failed")).not.toBeNull(), {
        timeout: 1000,
      });
    });
    const edit = [
      ...document.querySelectorAll<HTMLButtonElement>(".tmsg--failed .tmsg__state button"),
    ].find((button) => button.textContent === "Edit");
    expect(edit).toBeTruthy();
    await click(edit!);
    const editor = element<HTMLTextAreaElement>('[aria-label="Edit message"]');
    await write(editor, "Revised unsent message");
    await act(async () =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    await act(async () => {
      await vi.waitFor(() => expect(teamSession!.getSnapshot().pending).toEqual([]), {
        timeout: 1000,
      });
    });
    expect(field().value).toBe("Revised unsent message");
    expect(host.messages.size).toBe(0);
  });
});
