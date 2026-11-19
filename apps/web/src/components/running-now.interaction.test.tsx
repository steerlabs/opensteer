// @vitest-environment happy-dom

import type { HostClient, TranscriptFixtureSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { scopedTranscriptFixture, testHostConnection } from "@opensteer/client/test-support";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ hostClient: null as HostClient | null }));
vi.mock("./app-shell.js", () => ({ useShell: () => shell }));

const { RunningNow } = await import("./running-now.js");

const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
});

it("shows what runs from the thread's transcript, which a real Host snapshot does not carry", async () => {
  const client = new MockHostClient({ latencyMs: 0, places: "absent", subagents: "three" });
  clients.push(client);
  await client.load();
  const fixture: TranscriptFixtureSnapshot = { ...client.getSnapshot(), connection: "connected" };
  const thread = fixture.threads.find(({ title }) => title === "Fix checkout on mobile")!;
  // A real client's snapshot holds no transcripts; the detail store does.
  const { transcripts: _transcripts, requests: _requests, ...snapshot } = fixture;
  const subscribe = () => () => undefined;
  const hostClient = {
    ...client,
    ...scopedTranscriptFixture(() => fixture, subscribe),
    getSnapshot: () => snapshot,
    subscribe,
  } as unknown as HostClient;
  Object.assign(hostClient, { connection: testHostConnection(hostClient) });
  shell.hostClient = hostClient;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <RunningNow
        live
        onOpenChange={() => undefined}
        open={false}
        scroller={{ current: null }}
        threadId={thread.id}
      />,
    ),
  );
  expect(container.querySelector('[aria-label="Running now"]')).not.toBeNull();
  expect(container.textContent).toContain("2 subagents");
});
