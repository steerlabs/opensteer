import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { browserPoolControlBytes, type BrowserPoolControl } from "./browser-pool.js";
import { BrowserRuntime } from "./runtime.js";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeSink,
  FakeTicketVerifier,
  freshClaims,
  testSessionFilesRoot,
} from "./test-support/fakes.js";

function fixture(
  probePage: NonNullable<
    ConstructorParameters<typeof BrowserRuntime>[0]["pool"]
  >["probePage"] = async () => [],
) {
  const keys = generateKeyPairSync("ed25519");
  const page = new FakePage();
  const verifier = new FakeTicketVerifier();
  const runtime = new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([page]))),
    runtimeId: "runtime_test",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: verifier,
    pool: { term: 1, controllerKey: keys.publicKey, probePage },
  });
  const fence = runtime.poolState()!.fence;
  const claims = freshClaims({ actor: "person", tabRestoreVersion: 1 });
  verifier.setClaims("open", { ...claims, pool: { ...fence, attachment: 1 } });
  const controls = (kind: BrowserPoolControl["kind"], sequence = 1) => {
    const control = { kind, fence, intent: { id: `intent-${sequence}`, sequence } };
    return runtime.controlPool(
      control,
      sign(null, browserPoolControlBytes(control), keys.privateKey),
    );
  };
  const open = async (sink = new FakeSink()) => {
    const attachment = await runtime.attach("open", sink);
    await attachment.handle(
      JSON.stringify({ type: "session.state", runs: 0, personUsed: [], viewed: [], pinned: [] }),
    );
    return attachment;
  };
  return { runtime, controls, page, verifier, claims, fence, open };
}

it("records cancellation before retire arrives and rejects unsigned and superseded controls", async () => {
  const f = fixture();
  try {
    await f.open();
    const retire = {
      kind: "retire",
      fence: f.fence,
      intent: { id: "intent-1", sequence: 1 },
    } as const;
    await expect(f.runtime.controlPool(retire, Buffer.alloc(64))).rejects.toThrow("not authorized");
    const released = await f.controls("release");
    expect(released).toMatchObject({ phase: "running", cancelled: true });
    await expect(f.controls("release")).resolves.toEqual(released);
    await expect(f.controls("retire")).rejects.toThrow("cancelled");
    await f.controls("release", 2);
    await expect(f.controls("retire")).rejects.toThrow("superseded");
    expect(
      f.page.cdpSession.sent.some(({ method }) => method === "Page.setWebLifecycleState"),
    ).toBe(false);
  } finally {
    await f.runtime.shutdown();
  }
});

it("reports the same retired document on replay and detaches its old control handle", async () => {
  const f = fixture();
  const closeForPool = () => {
    closed++;
  };
  let closed = 0;
  const sink = Object.assign(new FakeSink(), { closeForPool });
  try {
    const handle = await f.open(sink);
    const tab = [...sink.tabs.rows.values()][0]!;
    const retired = await f.controls("retire");
    expect(retired).toMatchObject({
      phase: "retired",
      result: {
        retained: [
          {
            sessionId: f.claims.sessionId,
            surfaceId: tab.id,
            documentId: expect.any(String),
            typed: false,
          },
        ],
        dropped: [],
      },
    });
    expect(await f.controls("retire")).toEqual(retired);
    expect(closed).toBe(1);
    await handle.close();
    expect(f.page.isClosed()).toBe(false);
    await expect(handle.handle("{}")).rejects.toThrow("parked");
    const released = await f.controls("release");
    expect(await f.controls("release")).toEqual(released);
    expect(released).toMatchObject({ phase: "running", fence: { epoch: 2 } });
    await expect(f.runtime.attach("open", new FakeSink())).rejects.toThrow("authority has changed");
    f.verifier.setClaims("reattach", {
      ...f.claims,
      reattach: true,
      pool: { ...released.fence, attachment: 2 },
    });
    const fresh = new FakeSink();
    await f.runtime.attach("reattach", fresh);
    expect([...fresh.tabs.rows.values()].map((row) => row.id)).toEqual([tab.id]);
    expect(
      f.page.cdpSession.sent.filter(({ method }) => method === "Page.setWebLifecycleState"),
    ).toEqual([
      { method: "Page.setWebLifecycleState", parameters: { state: "frozen" } },
      { method: "Page.setWebLifecycleState", parameters: { state: "active" } },
    ]);
    await expect(f.runtime.attach("reattach", new FakeSink())).rejects.toThrow(
      "attachment is stale",
    );
  } finally {
    await f.runtime.shutdown();
  }
});

it("thaws without detaching when the frozen probe finds blockers", async () => {
  const f = fixture(async (_page, phase) => (phase === "frozen" ? ["upload", "download"] : []));
  try {
    const handle = await f.open();
    expect(await f.controls("retire")).toMatchObject({
      phase: "running",
      blockers: ["download", "upload"],
    });
    await handle.handle(
      JSON.stringify({ type: "session.state", runs: 0, personUsed: [], viewed: [], pinned: [] }),
    );
    expect(f.page.isClosed()).toBe(false);
  } finally {
    await f.runtime.shutdown();
  }
});
