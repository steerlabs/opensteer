// @vitest-environment happy-dom

import type { HostClient } from "@opensteer/client/host";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadDraftStore, newTaskDraftKey } from "../client/thread-drafts.js";
import { homeDraftId } from "../home/home-draft.js";

const state = vi.hoisted(() => ({
  dispatch: vi.fn(),
  drafts: null as import("../client/thread-drafts.js").ThreadDraftStore | null,
  routes: [] as { name: string }[],
}));

vi.mock("@react-navigation/native", () => ({
  StackActions: {
    pop: (count: number) => ({ count, type: "POP" }),
    popTo: (name: string, params: object) => ({ name, params, type: "POP_TO" }),
    popToTop: () => ({ type: "POP_TO_TOP" }),
    push: (name: string, params: object) => ({ name, params, type: "PUSH" }),
  },
  useNavigation: () => ({
    dispatch: state.dispatch,
    getState: () => ({ index: state.routes.length - 1, routes: state.routes }),
  }),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ drafts: state.drafts }),
}));

const { useLeaveSheets } = await import("./leave-sheets.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  state.dispatch.mockReset();
});

const host = {
  getSnapshot: () => ({
    personalSettings: { agentHome: { computerId: "rnr_a", path: "/Users/alex/Opensteer" } },
    user: { id: "user-a" },
  }),
} as unknown as HostClient;

describe("a new task started from Settings", () => {
  it("lands its words in Home's one draft and returns to Home", async () => {
    const drafts = createThreadDraftStore({
      filePath: "/private/drafts.json",
      now: () => new Date("2026-11-11T10:00:00Z"),
      privateFiles: new MemoryPrivateFilesystem(),
    });
    await drafts.load();
    state.drafts = drafts;
    const home = newTaskDraftKey(homeDraftId);
    await drafts.writeDraft("deployment-a", "user-a", home, "Something half written");
    state.routes = [{ name: "Home" }, { name: "Thread" }, { name: "Settings" }];
    let leave: ReturnType<typeof useLeaveSheets> | null = null;
    function Probe(): ReactNode {
      leave = useLeaveSheets("deployment-a", host);
      return null;
    }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Probe />));

    await act(() => leave!.openNewTask("Fix my Kitchen speaker"));

    expect(drafts.readDraft("deployment-a", "user-a", home)?.text).toBe("Fix my Kitchen speaker");
    expect(state.dispatch.mock.calls).toEqual([[{ type: "POP_TO_TOP" }]]);
  });
});

describe("a task opened from Settings", () => {
  it("closes Settings and everything opened inside it, back to the screen it was opened over", async () => {
    // Settings opened over one automation, with a page of its own pushed inside it.
    state.routes = [
      { name: "Home" },
      { name: "Schedules" },
      { name: "Schedule" },
      { name: "Settings" },
      { name: "SettingsDevices" },
    ];
    let leave: ReturnType<typeof useLeaveSheets> | null = null;
    function Probe(): ReactNode {
      leave = useLeaveSheets("deployment-a", host);
      return null;
    }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Probe />));

    act(() => leave!.openThread("thread-b"));

    expect(state.dispatch.mock.calls).toEqual([
      [{ count: 2, type: "POP" }],
      [
        {
          name: "Thread",
          params: { deploymentId: "deployment-a", threadId: "thread-b" },
          type: "PUSH",
        },
      ],
    ]);
  });
});
