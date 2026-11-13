// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { HostSnapshot, NodeEntry } from "@opensteer/client/host";
import type { Request } from "@opensteer/core";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { client, goTo, mount, settle } from "./workspace/workspace.interaction.test-support.js";

const laptopId = "rnr_33333333-3333-4333-8333-333333333333";
vi.mock("./computers/here.js", () => ({ useHereId: () => laptopId }));

let accessibility: "denied" | "granted" = "denied";
const bridge = {
  browserIsLocal: async () => false,
  browserWindowFocused: async () => true,
  checkFullDiskAccess: async () => ({ granted: true }),
  computerUsePermissionsGet: async () => ({ accessibility, screenRecording: "granted" }),
  getLocalVisibility: async () => true,
  onLocalVisibilityChanged: () => () => undefined,
  onPersonalTabCommand: () => () => undefined,
  setBadgeCount: async () => undefined,
} as unknown as OpensteerDesktopBridge;

/**
 * The seeded device.access Request, asked by a subagent: the subagent's own
 * view docks it only while it is pending, so fulfilling it unmounts the dock.
 */
function askedBySubagent(source: typeof client) {
  const snapshot = source.getSnapshot();
  const thread = snapshot.threads.find(({ title }) => title === "Subagents everywhere")!;
  const asking = snapshot.requests[thread.id]!.find(
    (request) => request.status === "pending" && request.originatingNodeId,
  )!;
  const node = snapshot.transcripts[thread.id]!.find(
    (entry): entry is NodeEntry =>
      entry.kind === "node" && entry.nodeId === asking.originatingNodeId,
  )!;
  const device = Object.values(snapshot.requests)
    .flat()
    .find((request) => request.payload.kind === "device.access")!;
  if (device.status !== "pending") throw new Error("The seeded device question is not pending");
  const moved: Extract<Request, { status: "pending" }> = {
    ...device,
    originatingNodeId: asking.originatingNodeId,
    originatingRunId: asking.originatingRunId,
    originatingThreadId: asking.originatingThreadId,
  };
  const real = source.getSnapshot;
  let copy: { readonly from: HostSnapshot; readonly to: HostSnapshot } | null = null;
  vi.spyOn(source, "getSnapshot").mockImplementation(() => {
    const base = real();
    if (copy?.from === base) return copy.to;
    const pending = Object.values(base.requests)
      .flat()
      .some((request) => request.id === device.id && request.status === "pending");
    const requests = Object.fromEntries(
      Object.entries(base.requests).map(([threadId, list]) => [
        threadId,
        list.filter((request) => request.id !== device.id && request.id !== asking.id),
      ]),
    );
    requests[thread.id] = [...(requests[thread.id] ?? []), ...(pending ? [moved] : [])];
    const waitingRequests = base.waitingRequests.flatMap((entry) =>
      entry.request.id === device.id
        ? []
        : entry.request.id === asking.id
          ? pending
            ? [{ ...entry, request: moved }]
            : []
          : [entry],
    );
    const to = { ...base, requests, waitingRequests };
    copy = { from: base, to };
    return to;
  });
  return { device, nodeId: node.nodeId, threadId: thread.id };
}

it("keeps the macOS grant after Turn it on resolves a subagent's last Request and its pane drops the dock", async () => {
  let asked: ReturnType<typeof askedBySubagent> | null = null;
  await mount(
    (source) => {
      asked = askedBySubagent(source);
      return `/tasks/${asked.threadId}?subagent=${asked.nodeId}`;
    },
    { mock: { devices: "seeded" }, shell: { desktopBridge: bridge } },
  );
  const { device, threadId } = asked!;
  const pane = () => document.querySelector(".subagent-pane");
  const button = (scope: Element | null, name: string) =>
    [...(scope?.querySelectorAll("button") ?? [])].find(
      (entry) => entry.textContent?.trim() === name,
    );
  await vi.waitFor(
    () => {
      if (!button(pane(), "Turn it on"))
        throw new Error(
          `The subagent never docked its Request: ${pane()?.textContent?.slice(-400)}`,
        );
    },
    { timeout: 3_000 },
  );

  await act(async () => button(pane(), "Turn it on")!.click());
  await vi.waitFor(
    () => {
      const pending = Object.values(client.getSnapshot().requests)
        .flat()
        .some((entry) => entry.id === device.id);
      if (pending) throw new Error("The Request was never resolved");
      if (!pane()?.textContent?.includes("Apps is on for"))
        throw new Error("The macOS follow-up left with the subagent's dock");
    },
    { timeout: 2_000 },
  );
  expect(button(pane(), "Turn it on")).toBeUndefined();
  expect(pane()?.textContent).toContain("macOS still has to allow it here.");

  // The conversation it was asked in still has it, and it turns green when macOS allows it.
  await act(async () => goTo!(`/tasks/${threadId}`));
  await settle();
  expect(pane()).toBeNull();
  expect(document.body.textContent).toContain("Apps is on for");
  accessibility = "granted";
  await act(async () => window.dispatchEvent(new Event("focus")));
  await vi.waitFor(
    () => {
      if (!document.body.textContent?.includes("macOS allows it now."))
        throw new Error("The grant never turned green");
    },
    { timeout: 2_000 },
  );
  await act(async () => button(document.body, "Done")!.click());
  expect(document.body.textContent).not.toContain("Apps is on for");
});
