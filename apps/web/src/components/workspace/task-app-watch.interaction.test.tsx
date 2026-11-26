// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi, type MockInstance } from "vitest";
import {
  mockAgentWorkThreads,
  mockConnectedAgents,
  type MockHostClient,
} from "@opensteer/client/mock";
import type { WebSocketClient } from "@opensteer/client/host";
import { client, goTo, history, mount } from "./workspace.interaction.test-support.js";

/*
 * Watch on a task whose agent is using a Mac app: the person sees that app's live picture where
 * the launcher shows otherwise, view only, with Stop and their own view as the way to take over.
 * The preview Home's task "Build the new architecture" holds Notes on the Home's Mac.
 */
const usingNotes = "thr_00000000-0000-4000-8000-000000000001";

/** WebCodecs, as a browser that can show the picture has it; happy-dom has none. */
class FakeVideoDecoder extends EventTarget {
  static async isConfigSupported(config: VideoDecoderConfig) {
    return { supported: true, config };
  }
  state: CodecState = "unconfigured";
  decodeQueueSize = 0;
  configure() {
    this.state = "configured";
  }
  decode() {}
  reset() {
    this.state = "unconfigured";
  }
  close() {
    this.state = "closed";
  }
}
Object.assign(globalThis, {
  VideoDecoder: FakeVideoDecoder,
  EncodedVideoChunk: class {
    readonly timestamp: number;
    constructor(init: { timestamp: number }) {
      this.timestamp = init.timestamp;
    }
  },
});
const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
const numbers = { bundleId: "com.apple.iWork.Numbers", displayName: "Numbers", teamId: null };

function sessionOf(source: MockHostClient, threadId: string) {
  for (const machine of source.getSnapshot().machines)
    for (const session of machine.computerUse?.sessions ?? [])
      if (session.threadId === threadId) return { machine, session };
  return null;
}

/** The display connections the page asked of the Home, with whether each is still open. */
async function opened(
  path: (source: MockHostClient) => string,
  options: Omit<NonNullable<Parameters<typeof mount>[1]>, "hostClient"> & {
    readonly prepare?: (source: MockHostClient) => void;
  } = {},
) {
  let connect!: MockInstance<MockHostClient["connectComputerDisplay"]>;
  const sockets: { source: unknown; socket: WebSocketClient; closed: boolean }[] = [];
  const { prepare, ...rest } = options;
  await mount((source) => {
    prepare?.(source);
    const original = source.connectComputerDisplay.bind(source);
    connect = vi.spyOn(source, "connectComputerDisplay").mockImplementation((displaySource) => {
      const socket = original(displaySource);
      const entry = { source: displaySource, socket, closed: false };
      socket.addEventListener("close", () => {
        entry.closed = true;
      });
      sockets.push(entry);
      return socket;
    });
    return path(source);
  }, rest);
  return { connect, sockets };
}

const middle = (threadId: string) => `/tasks/${threadId}?panel=browser`;
const pane = () => document.querySelector<HTMLElement>(".place--watch");
const launcher = () => document.querySelector<HTMLElement>(".place--launcher");
const button = (label: string, parent: ParentNode = document) =>
  [...parent.querySelectorAll("button")].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
  );
const taskSessionAsks = (connect: MockInstance<MockHostClient["connectComputerDisplay"]>) =>
  connect.mock.calls.map(([source]) => source).filter((source) => source.kind === "task-session");

it("lands Watch in On your computer now on the live picture of the app the agent is using", async () => {
  const { connect, sockets } = await opened(() => "/", {
    mock: mockConnectedAgents("seeded"),
    prepare(source) {
      source.mockAgentWork({ livePanel: "three" });
      source.mockComputerUseSessionTask(mockAgentWorkThreads.shopping);
    },
  });
  const { session, machine } = sessionOf(client, mockAgentWorkThreads.shopping)!;
  const opener = document.querySelector<HTMLButtonElement>(".agents-now__trigger")!;
  vi.spyOn(opener, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  await act(async () => opener.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"].agents-now-panel')!;
  await act(async () => button("Watch ChatGPT", dialog)!.click());
  expect(history.at(-1)?.path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
  await vi.waitFor(() => expect(pane()).not.toBeNull());
  expect(launcher()).toBeNull();
  expect(pane()!.textContent).toContain(
    `“ChatGPT” is using Notes on ${machine.name}. You are watching it.`,
  );
  await vi.waitFor(() =>
    expect(taskSessionAsks(connect)).toContainEqual({
      kind: "task-session",
      sessionId: session.sessionId,
      appKey: "com.apple.notes",
    }),
  );
  expect(sockets.some(({ closed }) => !closed)).toBe(true);
  // View only, with Stop.
  expect(pane()!.querySelector(".computer-watch__stage")).not.toBeNull();
  expect(button("Stop the agent using Notes", pane()!)).toBeDefined();
});

it("offers the person's own view of the same app as the way to take over", async () => {
  await opened(() => middle(usingNotes));
  const open = vi.spyOn(client, "openTab");
  const { machine } = sessionOf(client, usingNotes)!;
  await vi.waitFor(() => expect(pane()).not.toBeNull());
  await act(async () => button("Use Notes yourself", pane()!)!.click());
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(open.mock.calls[0]![0]).toMatchObject({ kind: "window", computerId: machine.id });
  const tab = (await open.mock.results[0]!.value) as { tabId: string };
  await vi.waitFor(() => expect(history.at(-1)?.search).toContain(`tab=${tab.tabId}`));
});

it("shows the app it used last, and lets the person pick another it holds", async () => {
  const { connect } = await opened(() => middle(usingNotes), {
    prepare: (source) =>
      source.mockComputerUseSessionTask(usingNotes, {
        apps: [numbers, notes],
        actingAppKeys: ["com.apple.notes"],
      }),
  });
  const { session, machine } = sessionOf(client, usingNotes)!;
  await vi.waitFor(() => expect(pane()).not.toBeNull());
  expect(pane()!.textContent).toContain(`is using Notes on ${machine.name}.`);
  const apps = () => pane()!.querySelector<HTMLElement>('[aria-label="Apps it is using"]')!;
  expect(button("Notes", apps())!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => button("Numbers", apps())!.click());
  expect(pane()!.textContent).toContain(`is using Numbers on ${machine.name}.`);
  expect(button("Numbers", apps())!.getAttribute("aria-pressed")).toBe("true");
  await vi.waitFor(() =>
    expect(taskSessionAsks(connect).at(-1)).toEqual({
      kind: "task-session",
      sessionId: session.sessionId,
      appKey: "com.apple.iwork.numbers",
    }),
  );
});

it("shows the launcher, and asks for no picture, on a task with no app in use for this person", async () => {
  // The Home shows a person their own computers' sessions alone: another person's task, or a
  // task using nothing, has none here, so the page never asks for its picture.
  const { connect } = await opened((source) => {
    const other = source
      .getSnapshot()
      .threads.map(({ id }) => id)
      .find((threadId) => sessionOf(source, threadId) === null);
    if (!other) throw new Error("Missing a task with no session");
    return middle(other);
  });
  await vi.waitFor(() => expect(launcher()).not.toBeNull());
  expect(pane()).toBeNull();
  expect(taskSessionAsks(connect)).toEqual([]);
});

it("keeps New tab a start page on a task whose agent is using an app", async () => {
  const { connect } = await opened(() => middle(usingNotes));
  await vi.waitFor(() => expect(pane()).not.toBeNull());
  const asked = taskSessionAsks(connect).length;
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '.side-section--tabs .side-head__action[aria-label="New tab"]',
      )!
      .click(),
  );
  await vi.waitFor(() => expect(launcher()).not.toBeNull());
  expect(pane()).toBeNull();
  expect(document.querySelector(".start-page__input")).not.toBeNull();
  expect(taskSessionAsks(connect)).toHaveLength(asked);
});

it("goes back to the launcher, with nothing left behind, when the session ends while watched", async () => {
  const { sockets } = await opened(() => middle(usingNotes));
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  await act(async () => button("Stop the agent using Notes", pane()!)!.click());
  await vi.waitFor(() => expect(sessionOf(client, usingNotes)).toBeNull());
  await vi.waitFor(() => expect(launcher()).not.toBeNull());
  expect(pane()).toBeNull();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  await vi.waitFor(() => expect(sockets.every(({ closed }) => closed)).toBe(true));
});

it("ends the picture when the person leaves the task", async () => {
  const { sockets } = await opened(() => middle(usingNotes));
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  await act(async () => goTo!("/settings/general"));
  await vi.waitFor(() => expect(sockets.every(({ closed }) => closed)).toBe(true));
});
