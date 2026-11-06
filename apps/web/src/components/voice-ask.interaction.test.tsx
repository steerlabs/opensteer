// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { HostSnapshot } from "@opensteer/client/host";
import type { VoiceSnapshot } from "@opensteer/client/voice";
import { mount, settle } from "./workspace/workspace.interaction.test-support.js";

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

vi.mock("@opensteer/client/react", async (actual) => ({
  ...(await actual<typeof import("@opensteer/client/react")>()),
  useVoice: () => ({
    controller: { subscribeLevel: () => () => undefined },
    snapshot: asking,
  }),
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
