// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ThreadIdSchema, createId } from "@opensteer/core";
import type { HostSnapshot } from "@opensteer/client/host";
import type { MockHostClient } from "@opensteer/client/mock";
import { click, element, history, mount, settle } from "./workspace.interaction.test-support.js";

/**
 * The mock's tasks with one made a helper: unlisted, with no row of its own,
 * and handed out by `parent`. It is a Thread no assignment names, so its way
 * back is its lineage alone.
 */
function withHelper(
  client: MockHostClient,
  parent: (snapshot: HostSnapshot, task: string) => string,
): { readonly helper: string; readonly task: string } {
  const read = client.getSnapshot.bind(client);
  const base = read();
  const workers = new Set<string>(
    Object.values(base.assignments).map(({ workerThread }) => workerThread.id),
  );
  const listed = base.threads.filter(
    ({ id, listed, role }) => role === "work" && listed && id !== base.homeThreadId,
  );
  const task = listed.find(({ id }) => workers.has(id)) ?? listed[0]!;
  const helper = listed.find(({ id }) => id !== task.id && !workers.has(id))!;
  const parentThreadId = parent(base, task.id);
  const unlisted = <Entry extends { readonly thread: { readonly id: string } }>(
    entries: readonly Entry[],
  ) => entries.filter(({ thread }) => thread.id !== helper.id);
  const cache = new WeakMap<HostSnapshot, HostSnapshot>();
  vi.spyOn(client, "getSnapshot").mockImplementation(() => {
    const snapshot = read();
    let held = cache.get(snapshot);
    if (!held) {
      held = {
        ...snapshot,
        activeTasks: unlisted(snapshot.activeTasks),
        tasks: snapshot.tasks && { ...snapshot.tasks, entries: unlisted(snapshot.tasks.entries) },
        threads: snapshot.threads.map((thread) =>
          thread.id === helper.id ? { ...thread, listed: false, parentThreadId } : thread,
        ),
        workspaceTasks: Object.fromEntries(
          Object.entries(snapshot.workspaceTasks).map(([id, list]) => [
            id,
            { ...list, entries: unlisted(list.entries) },
          ]),
        ),
        // A helper hands nothing out and runs no automations of its own, so its
        // header shows only the way back.
        assignments: Object.fromEntries(
          Object.entries(snapshot.assignments).filter(
            ([, assignment]) => assignment.parentThreadId !== helper.id,
          ),
        ),
        threadAutomations: { ...snapshot.threadAutomations, [helper.id]: [] },
      };
      cache.set(snapshot, held);
    }
    return held;
  });
  return { helper: helper.id, task: task.id };
}

const current = () =>
  [...document.querySelectorAll<HTMLElement>('.sidebar [aria-current="page"]')].map(
    (link) =>
      link.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId ??
      (link.classList.contains("side-home__main") ? "chat" : link.textContent),
  );

// Ways a helper's page can fail its reader: the sidebar marks nothing, since
// the helper has no row, so the reader cannot tell where they are; the page
// gives no way back to the work it was for; or it offers one into a
// conversation the reader cannot open.
describe("a helper's place among the reader's tasks", () => {
  it("marks the task it works for and leads back to it", async () => {
    let lineage!: ReturnType<typeof withHelper>;
    await mount((client) => {
      lineage = withHelper(client, (_, task) => task);
      return `/threads/${lineage.helper}`;
    });
    const { helper, task } = lineage;
    const title = element(`.side-task[data-thread-id="${task}"] .side-task__main`).textContent;
    expect(document.querySelector(`.side-task[data-thread-id="${helper}"]`)).toBeNull();
    expect(current()).toEqual([task]);
    const back = element<HTMLAnchorElement>(".conv-header__back");
    expect(back.closest(".conv-header")?.firstElementChild).toBe(back.parentElement);
    expect(back.getAttribute("aria-label")).toMatch(/^Back to /u);
    expect(title).toContain(back.textContent);
    await click(back);
    expect(history.at(-1)!.path).toBe(`/threads/${task}`);
    expect(current()).toEqual([task]);
  });

  it("marks Chat for work under Chat and leads back to Chat by name", async () => {
    let lineage!: ReturnType<typeof withHelper>;
    await mount((client) => {
      lineage = withHelper(client, (snapshot) => snapshot.homeThreadId!);
      return `/threads/${lineage.helper}`;
    });
    expect(current()).toEqual(["chat"]);
    const back = element<HTMLAnchorElement>(".conv-header__back");
    expect(back.textContent).toBe("Chat");
    expect(back.getAttribute("aria-label")).toBe("Back to Chat");
    await click(back);
    expect(history.at(-1)!.path).toBe("/");
    await settle();
    expect(document.querySelector(".conv-header__back")).toBeNull();
  });

  it("offers no way back into a conversation the reader cannot open, and marks nothing", async () => {
    let lineage!: ReturnType<typeof withHelper>;
    await mount((client) => {
      lineage = withHelper(client, () => createId("thread"));
      return `/threads/${lineage.helper}`;
    });
    expect(document.querySelector(".conv-header__back")).toBeNull();
    expect(element(".conv-header").classList.contains("conv-header--trail")).toBe(false);
    expect(current()).toEqual([]);
  });
});

function withFamily(client: MockHostClient, earlierOnly = false) {
  const read = client.getSnapshot.bind(client);
  const base = read();
  const firstAssignment = Object.values(base.assignments)[0]!;
  const assignments = [
    firstAssignment,
    ...base.threads
      .filter((thread) => thread.role === "work" && thread.id !== firstAssignment.workerThread.id)
      .slice(0, 5)
      .map((thread) => ({
        ...firstAssignment,
        id: createId("delegation"),
        workerThread: {
          ...firstAssignment.workerThread,
          id: ThreadIdSchema.parse(thread.id),
          title: thread.title,
        },
      })),
  ];
  const parent = ThreadIdSchema.parse(base.homeThreadId);
  const first = assignments[0]!;
  const cache = new WeakMap<HostSnapshot, HostSnapshot>();
  vi.spyOn(client, "getSnapshot").mockImplementation(() => {
    const snapshot = read();
    let held = cache.get(snapshot);
    if (!held) {
      held = {
        ...snapshot,
        waitingRequests: earlierOnly
          ? []
          : [
              {
                ...base.waitingRequests[0]!,
                assignments: [
                  { id: first.id, parentThreadId: parent, workerThread: first.workerThread },
                ],
              },
            ],
        assignments: Object.fromEntries(
          assignments.map((assignment, index) => [
            assignment.id,
            {
              ...assignment,
              parentThreadId: parent,
              status: earlierOnly || index > 0 ? ("completed" as const) : ("open" as const),
              finishedAt: earlierOnly || index > 0 ? new Date().toISOString() : null,
            },
          ]),
        ),
        threadAutomations: earlierOnly
          ? {}
          : {
              [parent]: [
                {
                  id: "family-automation",
                  name: "Morning check",
                  kind: "schedule",
                  paused: false,
                  nextFireAt: new Date(Date.now() + 3600_000).toISOString(),
                },
              ],
            },
      };
      cache.set(snapshot, held);
    }
    return held;
  });
  return { first, count: assignments.length };
}

describe("the conversation's family", () => {
  it("shows running work, automations and collapsed earlier work, and returns focus on Escape", async () => {
    await mount((client) => {
      withFamily(client);
      return "/";
    });
    const button = element<HTMLButtonElement>(".task-family-button");
    expect(button.getAttribute("aria-label")).toContain("1 task running");
    expect(button.getAttribute("aria-label")).toContain("1 automation");
    expect(button.getAttribute("aria-label")).toContain("one needs you");
    expect(button.querySelector(".task-family-button__attention")).not.toBeNull();
    await click(button);
    expect(element('[aria-label="Running"]').textContent).toContain("Running · 1");
    expect(element('[aria-label="Automations"]').textContent).toContain("Morning check");
    expect(element<HTMLAnchorElement>(".task-family a").getAttribute("href")).toContain(
      "/automations/family-automation",
    );
    const earlier = element('[aria-label="Earlier"]');
    {
      expect(earlier.querySelector(".task-family__row")).toBeNull();
      await click(element<HTMLButtonElement>(".task-family__toggle"));
      expect(earlier.querySelector(".task-family__row")).not.toBeNull();
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(document.querySelector(".popover--task-family")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(document.querySelector(".conv-header__menu")).toBeNull();
    await click(button);
    await click(element<HTMLAnchorElement>(".task-family a"));
    expect(history.at(-1)!.path).toBe("/automations/family-automation");
    expect(document.querySelector(".popover--task-family")).toBeNull();
  });

  it("shows earlier-only work expanded", async () => {
    let count = 0;
    await mount((client) => {
      count = withFamily(client, true).count;
      return "/";
    });
    expect(element(".task-family-button").textContent).toBe(`${count} earlier`);
    await click(element(".task-family-button"));
    expect(document.querySelectorAll('[aria-label="Earlier"] .task-family__row')).toHaveLength(4);
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".task-family button")].find(
        (button) => button.textContent === "Show all",
      )!,
    );
    expect(document.querySelectorAll('[aria-label="Earlier"] .task-family__row')).toHaveLength(
      count,
    );
    expect(document.querySelector('[aria-label="Running"]')).toBeNull();
    expect(document.querySelector('[aria-label="Automations"]')).toBeNull();
  });
});

it("keeps children out of a task's title menu", async () => {
  await mount((client) => {
    const { first } = withFamily(client);
    return `/threads/${first.workerThread.id}`;
  });
  await click(element(".conv-header__menu"));
  expect(element(".popover--conversation-menu").textContent).not.toContain("Started here");
  expect(document.querySelector(".popover--conversation-menu .task-family__row")).toBeNull();
});
