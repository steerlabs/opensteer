// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
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
