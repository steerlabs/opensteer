// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act } from "react";

import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "@opensteer/client/host";

import {
  client,
  history,
  goTo,
  mount,
  until,
  element,
  click,
  pageTab,
  typeInto,
} from "./workspace.interaction.test-support.js";
describe("task marks", () => {
  it("fades long task text rather than cutting it with an ellipsis", async () => {
    await mount("/");
    const style = document.createElement("style");
    style.textContent = ["tokens", "workspace"]
      .map((name) => readFileSync(`apps/web/src/styles/${name}.css`, "utf8"))
      .join("\n");
    document.body.append(style);
    const texts = document.querySelectorAll(".side-task__title, .side-task__ask");
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(getComputedStyle(text).textOverflow).not.toBe("ellipsis");
      expect(getComputedStyle(text).maskImage).toContain("linear-gradient");
    }
  });

  const flights = "thr_b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912";
  /** Opens a task the sidebar lists, working when asked, and answers its id. */
  async function openLiveTask(state?: "working"): Promise<string> {
    await mount("/");
    const row = [...document.querySelectorAll<HTMLElement>(".side-task[data-thread-id]")].find(
      (candidate) =>
        state === undefined ||
        candidate.querySelector(".task-state")?.getAttribute("data-state") === state,
    );
    if (!row) throw new Error(`The sidebar lists no ${state ?? ""} task`);
    const id = row.dataset.threadId!;
    await act(async () => goTo!(`/tasks/${id}`));
    await until("The task never opened", () => {
      expect(history.at(-1)!.path).toBe(`/tasks/${id}`);
      element(".conv-header__menu");
    });
    return id;
  }
  /** Presses a key and waits until `done` holds: what the key is for. */
  async function press(target: Element, key: string, done: () => void) {
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })),
    );
    await until(`${key} never took effect`, done);
  }
  async function picker() {
    await click(element(".conv-header__menu"));
    await click(element('[data-action="change-icon"]'));
  }
  it("shows a task's subject and separate working state in its row and header", async () => {
    await mount("/");
    const row = [...document.querySelectorAll<HTMLElement>(".side-task[data-thread-id]")].find(
      (candidate) =>
        candidate.querySelector(".task-state")?.getAttribute("data-state") === "working",
    );
    if (!row) throw new Error("The sidebar lists no working task");
    const icon = element(".task-mark", row).getAttribute("data-icon");
    await click(element(".side-task__main", row));
    expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe(icon);
    // Working shows on the task's mark and is spoken with its name, never as a word beside it.
    expect(element(".conv-header__mark > .working-ring").getAttribute("aria-hidden")).toBe("true");
    expect(element(".conv-header__menu").getAttribute("aria-label")).toContain("working");
    expect(element(".conv-header").textContent).not.toContain("Working");
    expect(element(".task-mark").getAttribute("aria-hidden")).toBe("true");
  });
  it("keeps a task the reader stopped bright while open, then lets it step back once left", async () => {
    const id = await openLiveTask("working");
    const row = () => element(`.side-task[data-thread-id="${id}"]`);
    await act(async () => client.stopRun(id));
    await until("The stop never reached the row", () =>
      expect(element(".task-state", row()).getAttribute("data-state")).toBe("finished"),
    );
    // Open, it reads like the conversation beside it; nothing about it is news.
    expect(row().classList.contains("is-quiet")).toBe(false);
    expect(element(".task-mark", row()).classList.contains("task-mark--quiet")).toBe(false);
    expect(row().querySelector(".task-row__unread")).toBeNull();
    await act(async () => goTo!("/"));
    await until("The stopped task never stepped back", () => {
      expect(row().classList.contains("is-quiet")).toBe(true);
      expect(element(".task-mark", row()).classList.contains("task-mark--quiet")).toBe(true);
    });
    expect(row().querySelector(".task-row__unread")).toBeNull();
  });
  it("updates every occupant in place on an icon-only edit, keeping the acting task hue", async () => {
    await mount(`/tasks/${flights}`);
    const place = pageTab();
    await act(async () => client.actInPlace(flights, place.key));
    const occupants = () => [
      ...document.querySelectorAll(`.occupant-mark[data-thread-id="${flights}"]`),
    ];
    await until("The acting task never showed as an occupant", () =>
      expect(occupants().length).toBeGreaterThan(0),
    );
    expect(occupants().every((el) => el.querySelector('.task-mark[data-icon="plane"]'))).toBe(true);
    await act(async () => {
      await client.dispatch({
        type: "thread.icon.set",
        threadId: flights,
        icon: "hotel",
        idempotencyKey: "occupant-icon-edit",
      });
    });
    expect(occupants().every((el) => el.querySelector('.task-mark[data-icon="hotel"]'))).toBe(true);
    expect(occupants()[0]?.getAttribute("aria-label")).toContain("working");
    expect(occupants()[0]?.querySelector(".task-badge")).toBeNull();
    // The ring hugs the mark, in the task's hue, whatever size its button is.
    expect(
      occupants()[0]
        ?.querySelector<HTMLElement>(".occupant-mark__mark > .working-ring")
        ?.style.getPropertyValue("--working-hue"),
    ).toBeTruthy();
  });
  it("makes overflow occupants keyboard reachable by task name", async () => {
    await mount("/");
    const place = pageTab();
    const ids = [
      ...new Set(
        client
          .getSnapshot()
          .runQueue.filter((run) => run.status === "running" || run.status === "waiting")
          .map((run) => run.threadId),
      ),
    ].slice(0, 4);
    expect(ids).toHaveLength(4);
    await act(async () => {
      for (const id of ids) client.actInPlace(id, place.key);
    });
    const more = await until("The tab never folded its occupants under More", () =>
      element<HTMLButtonElement>(`.side-tab[data-place-key="${place.key}"] .occupant-marks__more`),
    );
    more.focus();
    await click(more);
    const menu = element('[role="menu"][aria-label^="Tasks at "]');
    const task = element<HTMLElement>('[role="menuitem"][data-thread-id]', menu);
    expect(task.getAttribute("aria-label")).toContain(place.title);
    const id = task.getAttribute("data-thread-id");
    await click(task);
    expect(history.at(-1)?.path).toBe(`/tasks/${id}`);
  });
  it("opens Change icon from the sidebar context menu and returns keyboard focus to its row", async () => {
    const id = await openLiveTask();
    const row = element<HTMLElement>(`.side-task[data-thread-id="${id}"] .side-task__main`);
    row.focus();
    await act(async () =>
      row.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "F10",
          shiftKey: true,
        }),
      ),
    );
    await click(element('[data-action="change-icon"]'));
    const options = document.querySelectorAll(".workspace-icon-picker__grid button");
    (options[0] as HTMLElement).focus();
    await press(options[0]!, "ArrowRight", () => expect(document.activeElement).toBe(options[1]));
    await press(options[1]!, "Escape", () => expect(document.activeElement).toBe(row));
  });
  it("edits from the header with keyboard search, locks Use default and restores focus", async () => {
    await mount(`/tasks/${flights}`);
    const dispatch = vi.spyOn(client, "dispatch");
    const opener = element(".conv-header__menu");
    await picker();
    expect(document.querySelector('[aria-label="Initials"]')).toBeNull();
    expect(document.querySelectorAll(".workspace-icon-picker__grid button")).toHaveLength(130);
    const search = element<HTMLInputElement>('[aria-label="Search icons"]');
    expect(document.activeElement).toBe(search);
    await typeInto(search, "hotel");
    await press(search, "Enter", () => expect(document.activeElement).toBe(opener));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.icon.set", threadId: flights, icon: "hotel" }),
    );
    expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe("hotel");
    expect(document.activeElement).toBe(opener);
    await picker();
    await click(element('[aria-label="Use default"]'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.icon.set", icon: null }),
    );
    expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe("document");
    await picker();
    await press(element('[aria-label="Search icons"]'), "Escape", () =>
      expect(document.activeElement).toBe(opener),
    );
  });
  it("keeps a refused icon edit reviewable and restores its authoritative mark", async () => {
    await mount(`/tasks/${flights}`);
    vi.spyOn(client, "dispatch").mockRejectedValueOnce(new Error("Icon refused"));
    await picker();
    await click(element('[aria-label="Hotel"]'));
    expect(document.body.textContent).toContain("Couldn't confirm this icon changed.");
    expect(document.body.textContent).not.toContain("Icon refused");
    expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe("plane");
  });
  it("hides task mark edits on a Host without task marks", async () => {
    let last: HostSnapshot | null = null;
    let held: HostSnapshot | null = null;
    await mount(`/tasks/${flights}`, {
      hostClient: (source) =>
        new Proxy(source, {
          get(target, name) {
            if (name === "getSnapshot")
              return () => {
                const current = target.getSnapshot();
                if (current !== last) {
                  last = current;
                  held = { ...current, taskMarksAvailable: false };
                }
                return held!;
              };
            const value = Reflect.get(target, name);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    await click(element(".conv-header__menu"));
    expect(document.querySelector('[data-action="change-icon"]')).toBeNull();
  });
});
