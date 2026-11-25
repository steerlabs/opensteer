// @vitest-environment happy-dom
import { mockConnectedAgents } from "@opensteer/client/mock";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { client, mount, typeInto } from "./workspace/workspace.interaction.test-support.js";

const row = (id: string) =>
  document.querySelector<HTMLElement>(`.side-task[data-thread-id="${id}"]`);
const line = (id: string) => row(id)?.querySelector(".side-task__origin");

it("shows verified and isolated self-declared origins in Tasks, search and Done while leaving bridges and unresolved origins out", async () => {
  const seeded = mockConnectedAgents("seeded");
  const verified = seeded.connections.find(({ label }) => label === "ChatGPT")!;
  const declared = {
    ...seeded.connections.find(({ label }) => label === "Grok")!,
    label: "Opensteer",
    clientName: "Opensteer",
  };
  const bridge = mockConnectedAgents("chats").connections.find(({ bridge }) => bridge)!;
  const ended = seeded.connections.find(({ label }) => label === "Shop helper")!;
  const readCatalog = vi.fn();
  let verifiedTask = "";
  let declaredTask = "";
  let bridgeTask = "";
  let unknownTask = "";
  let endedTask = "";
  let ordinaryTask = "";
  await mount("/", {
    mock: { ...seeded, connections: [verified, declared, bridge, ended] },
    hostClient: (host) => {
      const original = host.rpc["connections.list"];
      Object.defineProperty(host.rpc, "connections.list", {
        value: (...args: Parameters<typeof original>) => {
          readCatalog();
          return original(...args);
        },
      });
      ordinaryTask = host.getSnapshot().tasks!.entries[0]!.thread.id;
      verifiedTask = host.mockStartedTask(verified.id);
      declaredTask = host.mockStartedTask(declared.id, "Follow up on the notes");
      bridgeTask = host.mockStartedTask(bridge.id, "Notes from Slack");
      unknownTask = host.mockStartedTask(
        "mcn_00000000-0000-4000-8000-0000000000ff",
        "Unknown origin",
      );
      endedTask = host.mockStartedTask(ended.id, "Notes from a disconnected agent");
      return host;
    },
  });
  expect(line(verifiedTask)?.textContent).toBe("started by ChatGPT");
  expect(line(declaredTask)?.textContent).toBe("started by “Opensteer”");
  expect(line(declaredTask)?.querySelector("bdi")?.textContent).toBe("Opensteer");
  expect(row(declaredTask)?.querySelector("a")?.getAttribute("aria-label")).toContain(
    "started by “\u2068Opensteer\u2069”",
  );
  for (const id of [bridgeTask, unknownTask, endedTask, ordinaryTask]) {
    expect(row(id)).not.toBeNull();
    expect(line(id)).toBeNull();
  }
  expect(readCatalog).toHaveBeenCalledTimes(1);

  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Search"]')!.click(),
  );
  await typeInto(
    document.querySelector<HTMLInputElement>("#sidebar-search")!,
    "Summarize my notes",
  );
  expect(document.querySelector(".side-results .side-task__origin")?.textContent).toBe(
    "started by ChatGPT",
  );
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

  await act(async () => client.setTaskDone(verifiedTask, true));
  await act(async () => document.querySelector<HTMLButtonElement>(".side-done__main")!.click());
  expect(line(verifiedTask)?.textContent).toBe("started by ChatGPT");
});

it("does not read the connection catalog for ordinary Tasks", async () => {
  const readCatalog = vi.fn();
  await mount("/", {
    mock: mockConnectedAgents("seeded"),
    hostClient: (host) => {
      const original = host.rpc["connections.list"];
      Object.defineProperty(host.rpc, "connections.list", {
        value: (...args: Parameters<typeof original>) => {
          readCatalog();
          return original(...args);
        },
      });
      return host;
    },
  });
  expect(document.querySelector(".side-section--tasks [data-thread-id]")).not.toBeNull();
  expect(document.querySelector(".side-task__origin")).toBeNull();
  expect(readCatalog).not.toHaveBeenCalled();
});
