// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadReadStateSchema } from "@opensteer/core";
import type { TranscriptEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import {
  threadActivityScenarios,
  withAccountPreparing,
  type ThreadActivityScenario,
} from "@opensteer/client/test-support";
import { AppShell } from "./app-shell.js";
import { ThreadRoute } from "./thread-view.js";
import { ToastProvider } from "./toast.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let client: MockHostClient | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.dispose();
  client = null;
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

// The seeded Thread, on the account the mock names Codex.
const thread = { harnessLabel: "Codex", id: "thr_00000000-0000-4000-8000-000000000004" };

/** Draws the seeded Thread's real route over the Host state a scenario describes. */
async function renderScenario(scenario: ThreadActivityScenario): Promise<HTMLElement> {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    Object.assign(new EventTarget(), {
      addListener: () => undefined,
      matches: false,
      media: query,
      onchange: null,
      removeListener: () => undefined,
    }),
  );
  client = new MockHostClient({ latencyMs: 0 });
  const base = client.getSnapshot();
  const summary = base.threads.find(({ id }) => id === thread.id);
  const harness = base.harnesses.find(({ id }) => id === summary?.harnessInstanceId);
  if (!harness) throw new Error("The seeded Thread's account is missing.");
  vi.spyOn(client, "getSnapshot").mockReturnValue({
    ...base,
    connection: "connected",
    environments: scenario.accountPreparing
      ? withAccountPreparing(base.environments, harness)
      : base.environments,
    runQueue: [...scenario.runQueue],
    threads: base.threads.map((candidate) =>
      candidate.id === thread.id ? { ...candidate, status: scenario.status } : candidate,
    ),
    threadReadStates: {
      ...base.threadReadStates,
      [thread.id]: ThreadReadStateSchema.parse({
        threadId: thread.id,
        readSequence: null,
        unreadSequence: null,
        placement: null,
        placementRevision: "0",
        asOfSequence: "100",
      }),
    },
    transcripts: { ...base.transcripts, [thread.id]: [...scenario.entries] },
  });
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const hostClient = client;
  await act(async () =>
    root?.render(
      <ToastProvider>
        <MemoryRouter initialEntries={[`/threads/${thread.id}`]}>
          <Routes>
            <Route element={<AppShell hostClient={hostClient} loadError={null} />}>
              <Route path="threads/:threadId" element={<ThreadRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    ),
  );
  return node;
}

describe("a Thread's activity on the web", () => {
  it.each(threadActivityScenarios(thread).map((scenario) => [scenario.name, scenario] as const))(
    "shows the line and Stop every client shows when %s",
    async (_name, scenario) => {
      const node = await renderScenario(scenario);

      expect(node.querySelector(".conv-header__name")?.textContent).toBe(
        "Reconcile August expenses",
      );
      expect(node.querySelector(".working__label")?.textContent ?? null).toBe(
        scenario.expected.line,
      );
      const stop = node.querySelector<HTMLButtonElement>(".composer__stop");
      expect(stop === null ? "absent" : stop.disabled ? "disabled" : "enabled").toBe(
        scenario.expected.stop,
      );
    },
  );

  it.each(["queued input", "claimed input", "cancelled input", "assignment return"])(
    "marks only published conversation messages when a %s is drawn",
    async (kind) => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const mark = vi.spyOn(MockHostClient.prototype, "markThreadRead").mockResolvedValue();
      const published: TranscriptEntry = {
        kind: "message",
        messageKind: "input",
        author: { kind: "human", displayName: "Reader", principalId: "reader" },
        body: "Published",
        createdAt: "2026-10-19T00:00:00Z",
        id: "published",
        runId: null,
        sequence: "1",
      };
      const unpublishable: TranscriptEntry =
        kind === "assignment return"
          ? {
              kind: "assignment-return",
              assignmentId: "assignment",
              createdAt: published.createdAt,
              id: "returned",
              runId: null,
              sequence: "2",
            }
          : {
              ...published,
              id: "waiting",
              body: "Still visible to its sender",
              sequence: "2",
              policy: "queue",
              runId: kind === "claimed input" ? "run" : null,
              published: false,
            };
      const scenario = threadActivityScenarios(thread)[0]!;
      await renderScenario({
        ...scenario,
        accountPreparing: false,
        entries: [published, unpublishable],
        runQueue: [],
        status: "idle",
      });
      expect(mark).toHaveBeenCalledWith(thread.id, "1");
      expect(mark.mock.calls.every(([, sequence]) => sequence === "1")).toBe(true);
    },
  );

  it("stops a Run still waiting for its AI account to get ready", async () => {
    const waiting = threadActivityScenarios(thread).find(
      ({ accountPreparing, runQueue }) => accountPreparing && runQueue[0]?.status === "queued",
    );
    if (!waiting) throw new Error("The waiting scenario is missing.");
    const node = await renderScenario(waiting);
    const dispatch = vi
      .spyOn(client!, "dispatch")
      .mockResolvedValue({ type: "run.interrupt", wasDuplicate: false });

    await act(async () => node.querySelector<HTMLButtonElement>(".composer__stop")?.click());

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: waiting.runQueue[0]?.id,
        threadId: thread.id,
        type: "run.interrupt",
      }),
    );
  });
});
