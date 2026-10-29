// @vitest-environment happy-dom
import { act } from "react";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import {
  assignmentPresentation,
  HostClientRequestError,
  taskList,
  type ActionReview,
  type HostSnapshot,
  type ReviewedAction,
} from "@opensteer/client/host";
import { useActionReview } from "@opensteer/client/react";
import { ActionReviewSheet } from "./action-review.js";
import type { ReactNode } from "react";

// Native presentation stands in for the OS; the client subscription and review are real.
vi.mock("./sheet.js", () => ({
  Sheet: (props: { open: boolean; title: string; children: ReactNode }) =>
    props.open ? <section aria-label={props.title}>{props.children}</section> : null,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./primitives.js", () => ({
  AppText: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  SecondaryButton: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let client: MockHostClient;
let snapshot: HostSnapshot;
const listeners = new Set<() => void>();
const errors = vi.fn();
let heldReview: ActionReview | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.dispose();
  listeners.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  errors.mockReset();
});
async function setup() {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  snapshot = client.getSnapshot();
  vi.spyOn(client, "getSnapshot").mockImplementation(() => snapshot);
  vi.spyOn(client, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
}
async function emit(next: HostSnapshot) {
  await act(async () => {
    snapshot = next;
    for (const listener of listeners) listener();
  });
}
function Panel({ action }: { action: ReviewedAction }) {
  const { review, ask, dismiss } = useActionReview(client);
  heldReview = review;
  return (
    <>
      <button onClick={() => ask(action)}>Review</button>
      <ActionReviewSheet
        review={review}
        title="Confirm action"
        detail="Reviewed consequence"
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        onClose={dismiss}
        onError={errors}
      />
    </>
  );
}
async function mount(action: ReviewedAction) {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root?.render(<Panel action={action} />));
  await press("Review");
  expect(document.querySelector("section")).not.toBeNull();
}
async function press(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  )!;
  await act(async () => button.click());
}

it("Expo dismisses a delegated Stop when the task settles, and a retained confirmation is harmless", async () => {
  await setup();
  const assignment = Object.values(snapshot.assignments).find((item) => {
    const presentation = assignmentPresentation(item, snapshot);
    return presentation.open && presentation.stopBlocked === null;
  })!;
  expect(assignment).toBeDefined();
  const cancel = vi.spyOn(client, "cancelAssignment");
  await mount({ kind: "stop-assignment", assignmentId: assignment.id });
  const retained = heldReview!;
  await emit({
    ...snapshot,
    assignments: {
      ...snapshot.assignments,
      [assignment.id]: { ...assignment, status: "cancelled" },
    },
  });
  expect(document.querySelector("section")).toBeNull();
  expect(await retained.confirm()).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});

it("Expo dismisses tab-close review when its holders change, without closing their replacement work", async () => {
  await setup();
  const session = snapshot.browserSessions.find(
    (item) =>
      item.state === "ready" && item.attachedRunIds.length > 0 && item.tabCatalog?.tabs.length,
  )!;
  const close = vi.spyOn(client, "closeBrowserTab");
  await mount({ kind: "close-tab", sessionId: session.id, tabId: session.tabCatalog!.tabs[0]!.id });
  await emit({
    ...snapshot,
    browserSessions: snapshot.browserSessions.map((item) =>
      item.id === session.id ? { ...item, attachedRunIds: [] } : item,
    ),
  });
  expect(document.querySelector("section")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});

it("a retained Stop cannot interrupt a newer run and a cancelled review cannot revive", async () => {
  await setup();
  const thread = snapshot.threads.find(
    (item) =>
      snapshot.runQueue.some((run) => run.threadId === item.id) && item.status === "running",
  )!;
  const stop = vi.spyOn(client, "stopRun");
  await mount({ kind: "stop-run", threadId: thread.id });
  const review = heldReview!;
  const original = snapshot;
  await emit({
    ...snapshot,
    runQueue: snapshot.runQueue.map((run) =>
      run.threadId === thread.id ? { ...run, id: "run-replacement" } : run,
    ),
  });
  expect(document.querySelector("section")).toBeNull();
  await emit(original);
  expect(await review.confirm()).toBe(false);
  expect(stop).not.toHaveBeenCalled();
});

it("a stale Mark Done is a no-op after the task starts work again", async () => {
  await setup();
  const row = taskList(snapshot).ready[0]!;
  expect(row).toBeDefined();
  const done = vi.spyOn(client, "setTaskDone");
  await mount({ kind: "task-done", threadId: row.threadId, done: true });
  await emit({
    ...snapshot,
    threads: snapshot.threads.map((item) =>
      item.id === row.threadId ? { ...item, status: "running" } : item,
    ),
    tasks: snapshot.tasks
      ? {
          ...snapshot.tasks,
          entries: snapshot.tasks.entries.map((item) =>
            item.thread.id === row.threadId
              ? { ...item, thread: { ...item.thread, status: "running" } }
              : item,
          ),
        }
      : null,
  });
  expect(document.querySelector("section")).toBeNull();
  expect(done).not.toHaveBeenCalled();
});

it("confirming twice dispatches once, while current failures are reported", async () => {
  await setup();
  const session = snapshot.browserSessions.find(
    (item) => item.state === "ready" && item.tabCatalog?.tabs.length,
  )!;
  const failure = new Error("Host unavailable");
  const close = vi.spyOn(client, "closeBrowserTab").mockRejectedValue(failure);
  await mount({ kind: "close-tab", sessionId: session.id, tabId: session.tabCatalog!.tabs[0]!.id });
  const confirm = document.querySelector<HTMLButtonElement>("section button:last-child")!;
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(close).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledExactlyOnceWith(failure);
  expect(document.querySelector("section")).toBeNull();
});

it.each(["viewer", "offline", "cancel", "unmount"] as const)(
  "dismisses and revokes a review on %s",
  async (change) => {
    await setup();
    const session = snapshot.browserSessions.find(
      (item) => item.state === "ready" && item.tabCatalog?.tabs.length,
    )!;
    const close = vi.spyOn(client, "closeBrowserTab");
    await mount({
      kind: "close-tab",
      sessionId: session.id,
      tabId: session.tabCatalog!.tabs[0]!.id,
    });
    const retained = heldReview!;
    if (change === "viewer") await emit({ ...snapshot, user: null });
    if (change === "offline") await emit({ ...snapshot, connection: "offline" });
    if (change === "cancel") await press("Cancel");
    if (change === "unmount") {
      await act(async () => root?.unmount());
      root = null;
    }
    expect(document.querySelector("section")).toBeNull();
    expect(await retained.confirm()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  },
);

it("dismisses a tab review when its last-tab consequence changes", async () => {
  await setup();
  const session = snapshot.browserSessions.find(
    (item) => item.state === "ready" && item.tabCatalog?.tabs.length,
  )!;
  const tab = session.tabCatalog!.tabs[0]!;
  const close = vi.spyOn(client, "closeBrowserTab");
  await mount({ kind: "close-tab", sessionId: session.id, tabId: tab.id });
  const retained = heldReview!;
  await emit({
    ...snapshot,
    browserSessions: snapshot.browserSessions.map((item) =>
      item.id === session.id
        ? {
            ...item,
            tabCatalog: {
              ...item.tabCatalog!,
              inventoryRevision:
                (item.tabCatalog!.inventoryRevision ?? item.tabCatalog!.revision) + 1,
              tabs: [tab],
            },
          }
        : item,
    ),
  });
  expect(document.querySelector("section")).toBeNull();
  expect(await retained.confirm()).toBe(false);
  expect(close).not.toHaveBeenCalled();
});

it("keeps a tab review while the browser's other tabs open and close, and closes the current inventory", async () => {
  await setup();
  const session = snapshot.browserSessions.find(
    (item) => item.state === "ready" && (item.tabCatalog?.tabs.length ?? 0) > 1,
  )!;
  const [tab, other] = session.tabCatalog!.tabs;
  const close = vi.spyOn(client, "closeBrowserTab").mockResolvedValue(undefined as never);
  await mount({ kind: "close-tab", sessionId: session.id, tabId: tab!.id });
  // An agent opens a tab and closes another while the question is up.
  const changed = {
    ...session.tabCatalog!,
    revision: session.tabCatalog!.revision + 2,
    inventoryRevision: (session.tabCatalog!.inventoryRevision ?? session.tabCatalog!.revision) + 2,
    tabs: [
      ...session.tabCatalog!.tabs.filter((item) => item.id !== other!.id),
      { ...other!, id: BrowserSurfaceIdSchema.parse("agent-opened-tab") },
    ],
  };
  await emit({
    ...snapshot,
    browserSessions: snapshot.browserSessions.map((item) =>
      item.id === session.id ? { ...item, tabCatalog: changed } : item,
    ),
  });
  expect(document.querySelector("section")).not.toBeNull();
  await press("Confirm");
  expect(close).toHaveBeenCalledExactlyOnceWith(session.id, tab!.id, {
    generation: changed.generation,
    revision: changed.revision,
    inventoryRevision: changed.inventoryRevision,
  });
  expect(errors).not.toHaveBeenCalled();
});

it("a delegated review closes when its summary's run ends before the worker has been observed", async () => {
  await setup();
  const assignment = Object.values(snapshot.assignments).find(
    (item) => item.status === "open" && item.currentRunId,
  )!;
  snapshot = {
    ...snapshot,
    threads: snapshot.threads.filter((item) => item.id !== assignment.workerThread.id),
  };
  const cancel = vi.spyOn(client, "cancelAssignment");
  await mount({ kind: "stop-assignment", assignmentId: assignment.id });
  const retained = heldReview!;
  await emit({
    ...snapshot,
    assignments: {
      ...snapshot.assignments,
      [assignment.id]: { ...assignment, currentRunStatus: "completed" },
    },
  });
  expect(document.querySelector("section")).toBeNull();
  expect(await retained.confirm()).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
});

it("a Host conflict that reveals an already ended action is quiet", async () => {
  await setup();
  const session = snapshot.browserSessions.find(
    (item) => item.state === "ready" && item.tabCatalog?.tabs.length,
  )!;
  vi.spyOn(client, "closeBrowserTab").mockRejectedValue(
    new HostClientRequestError({ code: "conflict", status: 409, message: "Already finished" }),
  );
  const refresh = vi.spyOn(client, "refresh").mockImplementation(async () => {
    snapshot = {
      ...snapshot,
      browserSessions: snapshot.browserSessions.filter((item) => item.id !== session.id),
    };
    for (const listener of listeners) listener();
  });
  await mount({ kind: "close-tab", sessionId: session.id, tabId: session.tabCatalog!.tabs[0]!.id });
  await press("Confirm");
  expect(refresh).toHaveBeenCalledOnce();
  expect(errors).not.toHaveBeenCalled();
  expect(document.querySelector("section")).toBeNull();
});

it("a current delegated Stop still stops exactly that task once", async () => {
  await setup();
  const assignment = Object.values(snapshot.assignments).find((item) => {
    const presentation = assignmentPresentation(item, snapshot);
    return presentation.open && presentation.stopBlocked === null;
  })!;
  const cancel = vi.spyOn(client, "cancelAssignment");
  await mount({ kind: "stop-assignment", assignmentId: assignment.id });
  await press("Confirm");
  expect(cancel).toHaveBeenCalledExactlyOnceWith(assignment.id);
  expect(errors).not.toHaveBeenCalled();
  expect(document.querySelector("section")).toBeNull();
});

it("an old app-view close cannot close a reopened generation", async () => {
  await setup();
  const app = (await client.listApprovedComputerApps()).find((item) => item.target.kind === "app")!;
  const view = await client.openComputerView(app.machineId, app.target);
  snapshot = {
    ...snapshot,
    machines: snapshot.machines.map((machine) =>
      machine.id === app.machineId && machine.computerUse
        ? { ...machine, computerUse: { ...machine.computerUse, ownerViews: [view] } }
        : machine,
    ),
  };
  const close = vi.spyOn(client, "closeComputerView");
  await mount({ kind: "close-view", viewId: view.viewId, generation: view.generation });
  const retained = heldReview!;
  await emit({
    ...snapshot,
    machines: snapshot.machines.map((machine) =>
      machine.id === app.machineId && machine.computerUse
        ? {
            ...machine,
            computerUse: {
              ...machine.computerUse,
              ownerViews: [{ ...view, generation: view.generation + 1 }],
            },
          }
        : machine,
    ),
  });
  expect(document.querySelector("section")).toBeNull();
  expect(await retained.confirm()).toBe(false);
  expect(close).not.toHaveBeenCalled();
});
