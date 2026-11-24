// @vitest-environment happy-dom
import { countRenders } from "./render-count.test-support.js";
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { MockHostClient } from "@opensteer/client/mock";
import type { HostClient, HostSnapshot, ThreadSummary } from "@opensteer/client/host";
import { mount, until } from "./workspace/workspace.interaction.test-support.js";

/**
 * The open task follows the stable shell and reads its live parts for itself: another task, tab,
 * assignment, browser use or question changing never redraws it, and its own always shows.
 */

type Patch = (snapshot: HostSnapshot) => HostSnapshot;

/** The mock Host, with snapshot changes the test publishes on top of its own, as the Host would. */
function patchableHost(source: MockHostClient) {
  const patches: Patch[] = [];
  const listeners = new Set<() => void>();
  let base: HostSnapshot | null = null;
  let held: HostSnapshot | null = null;
  const getSnapshot = () => {
    const current = source.getSnapshot();
    if (current !== base || held === null) {
      base = current;
      held = patches.reduce<HostSnapshot>((snapshot, patch) => patch(snapshot), current);
    }
    return held;
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    const off = source.subscribe(listener);
    return () => {
      listeners.delete(listener);
      off();
    };
  };
  const host = new Proxy(source, {
    get(target, name) {
      if (name === "getSnapshot") return getSnapshot;
      if (name === "subscribe") return subscribe;
      const value: unknown = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as HostClient;
  return {
    host,
    source,
    publish(patch: Patch) {
      patches.push(patch);
      held = null;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    /** One tab's row patched, as the tab stream patches it: the other rows keep theirs. */
    retitleTab(tabId: string, title: string) {
      const tabs = host.getSnapshot().tabs;
      act(() =>
        tabs.replaceRows(
          [...tabs.rows.values()].map((tab) => (tab.tabId === tabId ? { ...tab, title } : tab)),
          tabs.complete,
        ),
      );
    },
  };
}

const architecture = "thr_00000000-0000-4000-8000-000000000001";
const expenses = "thr_00000000-0000-4000-8000-000000000004";
const slack = "thr_00000000-0000-4000-8000-000000000005";
/** A listed tab no task here names. */
const flightAlerts = "mock-tab-13-0";
/** The tab the architecture task's Run stopped in, "Le Petit Jardin". */
const restaurant = "mock-tab-0-1";

let fixture: ReturnType<typeof patchableHost>;

async function open(threadId: string) {
  await mount(`/tasks/${threadId}`, {
    hostClient: (source) => {
      fixture = patchableHost(source);
      return fixture.host;
    },
  });
  await until("the task never drew", () => {
    expect(document.querySelector(".conv-header__name")).not.toBeNull();
    expect(document.querySelector(".transcript [data-transcript-row]")).not.toBeNull();
  });
}

function withThread(threadId: string, change: (thread: ThreadSummary) => ThreadSummary): Patch {
  return (snapshot) => ({
    ...snapshot,
    threads: snapshot.threads.map((thread) => (thread.id === threadId ? change(thread) : thread)),
  });
}

/** How many times each of the task's parts drew while `work` ran. */
async function drawsDuring(work: () => void | Promise<void>) {
  const counts = await countRenders(async () => {
    await work();
    // Whatever the change scheduled, effects and their renders included, lands before counting stops.
    await act(async () => {});
  });
  const total = (component: string) =>
    [...(counts.get(component)?.values() ?? [])].reduce((sum, count) => sum + count, 0);
  return {
    ThreadView: total("ThreadView"),
    AgentTranscript: total("AgentTranscript"),
    ConversationHeader: total("ConversationHeader"),
    ConversationActivity: total("ConversationActivity"),
  };
}

const untouched = {
  ThreadView: 0,
  AgentTranscript: 0,
  ConversationHeader: 0,
  ConversationActivity: 0,
};

describe("what does not concern the open task", () => {
  beforeEach(() => open(expenses));

  it("never redraws it when another task's row changes", async () => {
    expect(
      await drawsDuring(() =>
        fixture.publish(withThread(slack, (thread) => ({ ...thread, title: "Renamed elsewhere" }))),
      ),
      "another task renamed",
    ).toEqual(untouched);
    expect(
      await drawsDuring(() =>
        fixture.publish(withThread(slack, (thread) => ({ ...thread, status: "running" }))),
      ),
      "another task started",
    ).toEqual(untouched);
    expect(
      await drawsDuring(() =>
        fixture.publish(
          withThread(slack, (thread) => ({ ...thread, updatedAt: new Date().toISOString() })),
        ),
      ),
      "another task's activity",
    ).toEqual(untouched);
  });

  it("never redraws it for another task's tab, assignment, browser use or question", async () => {
    expect(
      await drawsDuring(() => fixture.retitleTab(flightAlerts, "Fares dropped")),
      "an unrelated tab",
    ).toEqual(untouched);
    expect(
      await drawsDuring(() =>
        fixture.publish((snapshot) => ({
          ...snapshot,
          assignments: Object.fromEntries(
            Object.entries(snapshot.assignments).map(([id, assignment]) => [
              id,
              { ...assignment, revision: assignment.revision + 1 },
            ]),
          ),
        })),
      ),
      "another task's assignments",
    ).toEqual(untouched);
    expect(
      await drawsDuring(() =>
        fixture.publish((snapshot) => ({
          ...snapshot,
          browserUses: snapshot.browserUses.map((use) => ({
            ...use,
            lastUsedAt: new Date().toISOString(),
          })),
        })),
      ),
      "another task's browser uses",
    ).toEqual(untouched);
    expect(
      await drawsDuring(() =>
        fixture.publish((snapshot) => ({
          ...snapshot,
          waitingRequests: snapshot.waitingRequests.filter(
            ({ request }) => request.originatingThreadId === expenses,
          ),
        })),
      ),
      "other tasks' questions answered",
    ).toEqual(untouched);
    expect(
      await drawsDuring(() =>
        fixture.publish((snapshot) => ({
          ...snapshot,
          needsYouCount: (snapshot.needsYouCount ?? 0) + 3,
        })),
      ),
      "how many tasks need the reader",
    ).toEqual(untouched);
  });
});

describe("what the open task's view does for itself", () => {
  it("redraws the view, not its transcript, and the transcript still follows its own changes", async () => {
    await open(expenses);
    // Find opens over the task: the view's own state changes, and nothing the transcript shows.
    const find = await drawsDuring(() =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
      }),
    );
    expect(document.querySelector(".thread-find"), "Find never opened").not.toBeNull();
    expect(find.ThreadView, "the view").toBeGreaterThan(0);
    expect(find.AgentTranscript, "its transcript").toBe(0);

    // Something said in the task is the transcript's own news.
    const said = await drawsDuring(async () => {
      await act(async () => {
        await fixture.host.dispatch({
          content: [{ type: "text", text: "Also the hotel receipts" }],
          delivery: "queue",
          idempotencyKey: "thread-view-scope-said",
          threadId: expenses,
          type: "thread.sendMessage",
        });
      });
      await until("the new message never showed", () =>
        expect(document.querySelector(".transcript")?.textContent).toContain(
          "Also the hotel receipts",
        ),
      );
    });
    expect(said.AgentTranscript, "its transcript").toBeGreaterThan(0);
  });

  it("redraws a conversation's open Run details only for what they show", async () => {
    await open(expenses);
    fixture.publish(withThread(expenses, (thread) => ({ ...thread, purpose: "voice" })));
    const more = await until("no reply offered its menu", () => {
      const button = document.querySelector<HTMLButtonElement>(".reply__more");
      expect(button).not.toBeNull();
      return button!;
    });
    act(() => more.click());
    const details = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Run details"),
    );
    expect(details, "Run details").toBeDefined();
    act(() => details!.click());
    await until("Run details never opened", () =>
      expect(document.querySelector('[aria-label="Close run details"]')).not.toBeNull(),
    );
    const find = await drawsDuring(() =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
      }),
    );
    expect(find.ThreadView, "the view").toBeGreaterThan(0);
    expect(find.ConversationActivity, "its Run details").toBe(0);
    expect(find.AgentTranscript, "its transcript").toBe(0);
  });
});

describe("what the open task shows of itself", () => {
  it("follows its own row, including what the stable shell leaves out", async () => {
    await open(expenses);
    fixture.publish(withThread(expenses, (thread) => ({ ...thread, title: "Close August" })));
    await until("its new name never showed", () =>
      expect(document.querySelector(".conv-header__name")?.textContent).toBe("Close August"),
    );
    fixture.publish(withThread(expenses, (thread) => ({ ...thread, status: "waiting" })));
    await until("it never waited", () =>
      expect(document.querySelector(".conv-header__cause")).toBeNull(),
    );
    // A paused queue alone leaves the stable projection as it was: only this row's own read sees it.
    fixture.publish(withThread(expenses, (thread) => ({ ...thread, inputQueuePaused: true })));
    await until("its paused queue never showed", () =>
      expect(document.querySelector(".conv-header__cause")?.textContent).toBe("Queue paused"),
    );
    // Its access mode, too, is drawn from the row as the stable projection never compares it.
    const access = () => document.querySelector('.composer-dock [aria-label^="Access mode:"]');
    expect(access()).toBeNull();
    fixture.publish(
      withThread(expenses, (thread) => ({ ...thread, accessMode: "approval-required" })),
    );
    await until("its access mode never showed", () => expect(access()).not.toBeNull());
    fixture.publish(withThread(expenses, (thread) => ({ ...thread, status: "archived" })));
    await until("its archive never showed", () =>
      expect(document.querySelector(".thread__connection-label")?.textContent).toBe("Archived"),
    );
  });

  it("follows the assignment it works on", async () => {
    await open(expenses);
    expect(document.querySelector(".conv-header__cause")).toBeNull();
    fixture.publish((snapshot) => {
      const model = Object.values(snapshot.assignments)[0]!;
      return {
        ...snapshot,
        assignments: {
          ...snapshot.assignments,
          dlg_scope_test: {
            ...model,
            id: "dlg_scope_test" as typeof model.id,
            parentThreadId: architecture as typeof model.parentThreadId,
            returnStatus: "undeliverable",
            status: "completed",
            workerThread: { ...model.workerThread, id: expenses as typeof model.workerThread.id },
          },
        },
      };
    });
    await until("its undeliverable result never showed", () =>
      expect(document.querySelector(".conv-header__cause")?.textContent).toBe(
        "The result could not be returned to Build the new architecture.",
      ),
    );
  });

  it("follows the tasks it handed out and the questions they ask", async () => {
    await open(architecture);
    const tasks = () => document.querySelector(".agent-tasks")?.textContent ?? "";
    expect(tasks()).toContain("Book a table for Friday");
    expect(tasks()).not.toContain("Finished");
    fixture.publish((snapshot) => ({
      ...snapshot,
      assignments: Object.fromEntries(
        Object.entries(snapshot.assignments).map(([id, assignment]) => [
          id,
          assignment.parentThreadId === architecture
            ? { ...assignment, revision: assignment.revision + 1, status: "completed" as const }
            : assignment,
        ]),
      ),
    }));
    await until("its task's finish never showed", () => expect(tasks()).toContain("Finished"));

    // One question of its own, and one from work it handed out.
    const stack = () => document.querySelector(".request-stack")?.textContent ?? "";
    expect(stack()).toContain("1 of 2");
    fixture.publish((snapshot) => ({
      ...snapshot,
      waitingRequests: snapshot.waitingRequests.filter(
        ({ assignments }) =>
          !assignments.some(({ parentThreadId }) => parentThreadId === architecture),
      ),
    }));
    await until("the answered question never left", () => expect(stack()).not.toContain("of 2"));
  });

  it("follows the tabs its own transcript names, each where it is drawn", async () => {
    await open(architecture);
    const stop = () => document.querySelector(".trace-place__title")?.textContent;
    expect(stop()).toBe("Le Petit Jardin");
    const counts = await drawsDuring(() => fixture.retitleTab(restaurant, "Le Petit Jardin · Fri"));
    // The stop reads its own tab: the transcript around it is not drawn again.
    expect(counts.AgentTranscript, "its transcript").toBe(0);
    await until("its tab's new title never showed", () =>
      expect(stop()).toBe("Le Petit Jardin · Fri"),
    );
  });

  it("follows the pages its finished reply used", async () => {
    await open(expenses);
    const runId = document.querySelector<HTMLElement>(".turn[data-run-id]")?.dataset.runId;
    expect(runId, "a finished reply").toBeDefined();
    const used = () =>
      document.querySelector('[aria-label="Pages and apps this reply used"]')?.textContent ?? "";
    expect(used()).toBe("");
    fixture.publish((snapshot) => ({
      ...snapshot,
      browserUses: [
        ...snapshot.browserUses,
        {
          firstUsedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          pageSite: "https://bank.example",
          pageTitle: "August statement",
          runId: runId!,
          sessionId: "bsn_00000000-0000-4000-8000-000000000800",
          tabId: "tab_00000000-0000-4000-8000-00000000c0de",
          threadId: expenses,
        },
      ],
    }));
    await until("the page it used never showed", () =>
      expect(used()).toContain("August statement"),
    );
  });

  it("follows its computer's connection and whether it is the Voice Thread", async () => {
    await open(expenses);
    const environmentId = fixture.host
      .getSnapshot()
      .threads.find(({ id }) => id === expenses)!.environmentId;
    act(() => fixture.source.setEnvironmentConnected(environmentId, false));
    await until("its computer going offline never showed", () =>
      expect(document.querySelector(".thread__connection-label")?.textContent).toMatch(/offline$/),
    );
    expect(document.querySelector("[data-composer-input]")).not.toBeNull();
    fixture.publish((snapshot) => ({ ...snapshot, voiceThreadId: expenses }));
    await until("becoming the Voice Thread never showed", () =>
      expect(document.querySelector("[data-composer-input]")).toBeNull(),
    );
  });
});
