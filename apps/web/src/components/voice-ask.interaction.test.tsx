// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { HostSnapshot } from "@opensteer/client/host";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import type { VoiceSnapshot } from "@opensteer/client/voice";
import { client, mount, settle } from "./workspace/workspace.interaction.test-support.js";

const asking: VoiceSnapshot = {
  available: true,
  phase: "listening",
  muted: false,
  heard: null,
  spoken: null,
  since: null,
  activity: null,
  tasks: 0,
  ask: { kind: "request", requestId: "asked", others: 0 },
  notice: null,
};

const voiceListeners = vi.hoisted(() => new Set<() => void>());
const call = vi.hoisted(() => ({
  call: () => null,
  dispose: () => undefined,
  getSnapshot: () => undefined as unknown,
  refreshContext: () => undefined,
  subscribe: (listener: () => void) => {
    voiceListeners.add(listener);
    return () => voiceListeners.delete(listener);
  },
  subscribeLevel: () => () => undefined,
}));
let voice: VoiceSnapshot = asking;
call.getSnapshot = () => voice;

const laptopId = "rnr_33333333-3333-4333-8333-333333333333";
vi.mock("./computers/here.js", () => ({ useHereId: () => laptopId }));

vi.mock("./voice.js", async (actual) => ({
  ...(await actual<typeof import("./voice.js")>()),
  useVoiceRuntime: () => call,
}));

it("shows what a call asks in the real shell, live on a page with a stable shell", async () => {
  const listeners = new Set<() => void>();
  let raised = false;
  let title = "";
  await mount((source) => {
    const snapshot = source.getSnapshot();
    const [threadId, requests] = Object.entries(snapshot.requests).find(([, list]) =>
      list.some(
        ({ status, presentation }) => status === "pending" && presentation.kind === "choice",
      ),
    )!;
    const request = requests.find(({ status }) => status === "pending")!;
    title = request.presentation.title;
    const subscribe = source.subscribe;
    vi.spyOn(source, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      const off = subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    });
    const real = source.getSnapshot;
    let copy: { readonly from: HostSnapshot; readonly raised: boolean; to: HostSnapshot } | null =
      null;
    // The Voice Thread starts with nothing pending; only its Requests change, as a stable shell ignores.
    vi.spyOn(source, "getSnapshot").mockImplementation(() => {
      const base = real();
      if (copy?.from !== base || copy.raised !== raised)
        copy = {
          from: base,
          raised,
          to: {
            ...base,
            voiceThreadId: threadId,
            requests: { ...base.requests, [threadId]: raised ? [request] : [] },
          },
        };
      return copy.to;
    });
    return "/settings/ai-engines";
  });
  await settle();
  const island = document.querySelector('[aria-label="Voice"]');
  expect(island).not.toBeNull();
  expect(document.body.textContent).not.toContain(title);

  raised = true;
  await act(async () => {
    for (const listener of listeners) listener();
  });
  await settle();
  expect(document.querySelector(".request-card")?.textContent).toContain(title);
});

it("keeps the macOS grant on the call after Turn it on resolves the Request and the ask ends", async () => {
  voice = asking;
  const bridge = {
    browserIsLocal: async () => false,
    browserWindowFocused: async () => true,
    checkFullDiskAccess: async () => ({ granted: true }),
    computerUsePermissionsGet: async () => ({
      accessibility: "denied",
      screenRecording: "granted",
    }),
    getLocalVisibility: async () => true,
    onLocalVisibilityChanged: () => () => undefined,
    onPersonalTabCommand: () => () => undefined,
    setBadgeCount: async () => undefined,
  } as unknown as OpensteerDesktopBridge;
  let requestId = "";
  await mount(
    (source) => {
      const [threadId, requests] = Object.entries(source.getSnapshot().requests).find(([, list]) =>
        list.some(({ payload }) => payload.kind === "device.access"),
      )!;
      requestId = requests.find(({ payload }) => payload.kind === "device.access")!.id;
      voice = { ...asking, ask: { kind: "request", requestId, others: 0 } };
      const real = source.getSnapshot;
      let copy: { readonly from: HostSnapshot; readonly to: HostSnapshot } | null = null;
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const base = real();
        // Only the device question is on the call.
        const asked = (base.requests[threadId] ?? []).filter(({ id }) => id === requestId);
        if (copy?.from !== base)
          copy = {
            from: base,
            to: {
              ...base,
              requests: { ...base.requests, [threadId]: asked },
              voiceThreadId: threadId,
            },
          };
        return copy.to;
      });
      return "/settings/ai-engines";
    },
    { mock: { devices: "seeded" }, shell: { desktopBridge: bridge } },
  );
  await settle();
  const island = () => document.querySelector('[aria-label="Voice"]')?.parentElement ?? null;
  const button = (name: string) =>
    [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
  expect(button("Turn it on")).toBeDefined();

  await act(async () => button("Turn it on")!.click());
  await vi.waitFor(
    () => {
      const pending = Object.values(client.getSnapshot().requests)
        .flat()
        .some((entry) => entry.id === requestId);
      if (pending) throw new Error("The Request was never resolved");
    },
    { timeout: 2_000 },
  );
  // Voice derives its ask from pending Requests, so resolving it ends the ask.
  voice = { ...asking, ask: null };
  await act(async () => {
    for (const listener of voiceListeners) listener();
  });
  await settle();
  expect(button("Turn it on")).toBeUndefined();
  expect(island()?.textContent).toContain("Apps is on for");
  expect(island()?.textContent).toContain("macOS still has to allow it here.");

  await act(async () => button("Do this later")!.click());
  expect(document.body.textContent).not.toContain("Apps is on for");
});
