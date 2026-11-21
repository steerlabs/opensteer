import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  browserPoolControlBytes,
  type BrowserPoolControl,
  type BrowserPoolRuntimeFence,
} from "./browser-pool.js";
import { BrowserRuntime } from "./runtime.js";
import { BrowserSessionIdSchema } from "@opensteer/protocol/browser";
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

type PoolOptions = NonNullable<ConstructorParameters<typeof BrowserRuntime>[0]["pool"]>;

async function fixture(
  options: {
    probePage?: PoolOptions["probePage"];
    adoptionWindowMs?: number;
    actor?: "person" | "agent";
  } = {},
) {
  const keys = generateKeyPairSync("ed25519");
  const page = new FakePage();
  const context = new FakeContext([page]);
  const verifier = new FakeTicketVerifier();
  const runtime = new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(context)),
    runtimeId: "runtime_test",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: verifier,
    pool: {
      controllerKey: keys.publicKey,
      probePage: options.probePage ?? (async () => []),
      ...(options.adoptionWindowMs ? { adoptionWindowMs: options.adoptionWindowMs } : {}),
    },
  });
  const signed = (control: BrowserPoolControl) =>
    runtime.controlPool(control, sign(null, browserPoolControlBytes(control), keys.privateKey));
  // Stands in for the controller: it numbers its controls and names the fence each replaces.
  let sequence = 0;
  let held: BrowserPoolRuntimeFence | null = null;
  const issue = (control: Omit<BrowserPoolControl, "sequence" | "expect">) => {
    const full = { ...control, sequence: ++sequence, expect: held } as BrowserPoolControl;
    if (control.kind === "install" || control.kind === "adopt") held = control.fence;
    return { control: full, apply: () => signed(full) };
  };
  let fence: BrowserPoolRuntimeFence = {
    slot: "slot",
    term: 1,
    instance: randomUUID(),
    epoch: 1,
  };
  const actor = options.actor ?? "person";
  const claims = freshClaims({
    actor,
    creationOrigin: actor,
    ...(actor === "person" ? { tabRestoreVersion: 1 } : {}),
  });
  const ticket = (name: string, attachment: number, reattach = false) =>
    verifier.setClaims(name, {
      ...claims,
      ...(reattach ? { reattach: true, initialNavigation: undefined } : {}),
      pool: { ...fence, attachment },
    });
  const controls = (kind: BrowserPoolControl["kind"], intentSequence = 1, attempt?: number) =>
    issue({
      kind,
      fence,
      intent: { id: `intent-${intentSequence}`, sequence: intentSequence },
      ...(attempt ? { attempt } : {}),
    }).apply();
  const install = (next = fence) => {
    fence = next;
    return issue({ kind: "install", fence }).apply();
  };
  const resume = (intentSequence = 1) => {
    fence = { ...fence, epoch: fence.epoch + 1 };
    return issue({
      kind: "adopt",
      fence,
      intent: { id: `intent-${intentSequence}`, sequence: intentSequence },
    }).apply();
  };
  const state = () =>
    JSON.stringify({ type: "session.state", runs: 0, personUsed: [], viewed: [], pinned: [] });
  const open = async (sink = new FakeSink()) => {
    ticket("open", 1);
    const attachment = await runtime.attach("open", sink);
    await attachment.handle(state());
    return attachment;
  };
  const reattach = async (attachment: number, sink = new FakeSink()) => {
    ticket(`reattach-${attachment}`, attachment, true);
    return runtime.attach(`reattach-${attachment}`, sink);
  };
  return {
    runtime,
    context,
    controls,
    install,
    resume,
    page,
    verifier,
    claims,
    open,
    reattach,
    signed,
    issue,
    keys,
    fence: () => fence,
  };
}

it("refuses every send until the controller installs a fence, and refuses a fence that moves back", async () => {
  const f = await fixture();
  try {
    expect(f.runtime.poolState()).toMatchObject({ phase: "uninstalled", fence: null });
    await expect(f.open()).rejects.toThrow("parked");
    const install = { kind: "install", fence: f.fence(), sequence: 1, expect: null } as const;
    await expect(f.runtime.controlPool(install, Buffer.alloc(64))).rejects.toThrow(
      "not authorized",
    );
    const first = f.issue({ kind: "install", fence: f.fence() });
    await first.apply();
    await f.open();
    // The same signed install, applied again, and an older one, are refused.
    await expect(f.signed(first.control)).rejects.toThrow("superseded");
    // Two starts in the same term: the older install can never replace the newer instance.
    const older = f.issue({ kind: "install", fence: { ...f.fence(), instance: randomUUID() } });
    await older.apply();
    const newer = { ...f.fence(), instance: randomUUID() };
    await f.issue({ kind: "install", fence: newer }).apply();
    expect(f.runtime.poolState()?.fence).toEqual(newer);
    await expect(f.signed(older.control)).rejects.toThrow("superseded");
    // An install that does not name the current fence is refused even with a higher sequence.
    const stray = f.issue({ kind: "install", fence: { ...newer, instance: randomUUID() } });
    await expect(
      f.signed({
        ...stray.control,
        sequence: stray.control.sequence + 5,
        expect: first.control.fence,
      }),
    ).rejects.toThrow("not the expected one");
    expect(f.runtime.poolState()?.fence).toEqual(newer);
  } finally {
    await f.runtime.shutdown();
  }
});

it("records cancellation before retire arrives and rejects superseded controls", async () => {
  const f = await fixture();
  try {
    await f.install();
    await f.open();
    const released = await f.controls("release");
    expect(released).toMatchObject({ phase: "running", cancelled: true });
    await expect(f.controls("release")).resolves.toMatchObject({ phase: "running" });
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

it("keeps an agent's page through retire and release, and adopts it under a newer attachment", async () => {
  const f = await fixture({ actor: "agent" });
  try {
    await f.install();
    const sink = new FakeSink();
    const handle = await f.open(sink);
    const tab = [...sink.tabs.rows.values()][0]!;
    const retired = await f.controls("retire");
    expect(retired).toMatchObject({
      phase: "retired",
      retired: {
        documents: [{ sessionId: f.claims.sessionId, surfaceId: tab.id }],
        sessions: [f.claims.sessionId],
      },
    });
    expect(await f.controls("retire")).toEqual(retired);
    await expect(handle.handle("{}")).rejects.toThrow("parked");
    await handle.close();
    expect(f.page.isClosed()).toBe(false);
    const released = await f.controls("release");
    expect(released).toMatchObject({
      phase: "adopting",
      cancelled: true,
      adoption: { cause: "release", sessions: [f.claims.sessionId] },
    });
    await expect(f.controls("seal")).rejects.toThrow("unresolved");
    const fresh = new FakeSink();
    await f.reattach(2, fresh);
    expect([...fresh.tabs.rows.values()].map((row) => row.id)).toEqual([tab.id]);
    await expect(f.reattach(2)).rejects.toThrow("attachment is stale");
    const completed = await f.controls("complete", 1, 2);
    expect(completed).toMatchObject({
      phase: "running",
      adoption: { outcome: { adopted: [f.claims.sessionId], lost: [] } },
    });
    expect(await f.controls("complete", 1, 2)).toEqual(completed);
    expect(f.page.isClosed()).toBe(false);
    expect(
      f.page.cdpSession.sent.filter(({ method }) => method === "Page.setWebLifecycleState"),
    ).toEqual([
      { method: "Page.setWebLifecycleState", parameters: { state: "frozen" } },
      { method: "Page.setWebLifecycleState", parameters: { state: "active" } },
    ]);
  } finally {
    await f.runtime.shutdown();
  }
});

it("ends a page its session opens during the park, outside the retained pages, and reports it", async () => {
  const f = await fixture();
  try {
    await f.install();
    const sink = new FakeSink();
    await f.open(sink);
    const tab = [...sink.tabs.rows.values()][0]!;
    const retired = await f.controls("retire");
    expect(retired).toMatchObject({ phase: "retired", dropped: 0 });
    // A popup the retired page opens after the final probe: it is not kept and is said.
    const popup = new FakePage({ opener: f.page });
    f.context.addPage(popup);
    await vi.waitFor(() => expect(popup.isClosed()).toBe(true));
    const state = f.runtime.poolState();
    expect(state).toMatchObject({ phase: "retired", dropped: 1 });
    expect(state?.retired?.documents.map((document) => document.surfaceId)).toEqual([tab.id]);
    expect(f.page.isClosed()).toBe(false);
  } finally {
    await f.runtime.shutdown();
  }
});

it("recovers a retire that threw after detaching by release and adoption", async () => {
  const f = await fixture();
  try {
    await f.install();
    const sink = Object.assign(new FakeSink(), {
      closeForPool: () => {
        throw new Error("The channel close failed");
      },
    });
    await f.open(sink);
    const failed = await f.controls("retire");
    expect(failed).toMatchObject({ phase: "retiring", blockers: ["retire-failed"] });
    await expect(f.controls("seal")).rejects.toThrow("not retired");
    const released = await f.controls("release");
    expect(released).toMatchObject({
      phase: "adopting",
      adoption: { sessions: [f.claims.sessionId] },
    });
    await f.reattach(2);
    await expect(f.controls("complete", 1, 2)).resolves.toMatchObject({
      phase: "running",
      adoption: { outcome: { adopted: [f.claims.sessionId], lost: [] } },
    });
    expect(f.page.isClosed()).toBe(false);
  } finally {
    await f.runtime.shutdown();
  }
});

it("loses only the page that did not thaw, closed with its note, and keeps both sessions", async () => {
  const f = await fixture();
  try {
    await f.install();
    const sinkA = new FakeSink();
    await f.open(sinkA);
    // A second session of the same runtime, with a page of its own.
    const other = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    f.verifier.setClaims("open-b", {
      ...f.claims,
      sessionId: other,
      pool: { ...f.fence(), attachment: 1 },
    });
    const sinkB = new FakeSink();
    const b = await f.runtime.attach("open-b", sinkB);
    await b.handle(
      JSON.stringify({ type: "session.state", runs: 0, personUsed: [], viewed: [], pinned: [] }),
    );
    const pageB = f.context.pages().find((page) => page !== f.page) as FakePage;
    expect(pageB).toBeDefined();
    const tabB = [...sinkB.tabs.rows.values()][0]!;
    await f.controls("retire");
    await f.controls("seal");
    // Chromium refuses to thaw session B's page.
    pageB.cdpSession.responses.set(
      "Page.setWebLifecycleState",
      (parameters: Record<string, unknown> | undefined) => {
        if (parameters?.state === "active") throw new Error("The page cannot be thawed.");
        return {};
      },
    );
    await f.resume();
    await f.reattach(2);
    f.verifier.setClaims("reattach-b", {
      ...f.claims,
      sessionId: other,
      reattach: true,
      initialNavigation: undefined,
      pool: { ...f.fence(), attachment: 2 },
    });
    await f.runtime.attach("reattach-b", new FakeSink());
    const completed = await f.controls("complete", 1, 2);
    expect(completed.adoption?.outcome).toEqual({
      adopted: [f.claims.sessionId, other].sort(),
      lost: [],
      pagesLost: [{ sessionId: other, surfaceId: tabB.id, reason: "thaw-failed" }],
    });
    // The page that did not thaw is closed, never shown frozen as usable; the other is kept.
    expect(pageB.isClosed()).toBe(true);
    expect(f.page.isClosed()).toBe(false);
  } finally {
    await f.runtime.shutdown();
  }
});

it("ends the adoption by itself at its window and loses only what was not reattached", async () => {
  const f = await fixture({ adoptionWindowMs: 40 });
  try {
    await f.install();
    await f.open();
    await f.controls("retire");
    await f.controls("seal");
    const adopting = await f.resume();
    expect(adopting).toMatchObject({ phase: "adopting", fence: { epoch: 2 } });
    await vi.waitFor(() => expect(f.runtime.poolState()?.phase).toBe("running"));
    expect(f.runtime.poolState()).toMatchObject({
      phase: "running",
      adoption: {
        outcome: {
          adopted: [],
          lost: [{ sessionId: f.claims.sessionId, reason: "adoption-window-expired" }],
        },
      },
    });
    expect(f.page.isClosed()).toBe(true);
    await expect(f.controls("complete", 1, 2)).resolves.toMatchObject({
      adoption: { outcome: { adopted: [] } },
    });
  } finally {
    await f.runtime.shutdown();
  }
});

it("keeps a session whose channel closed during adoption and refuses an older attempt's completion", async () => {
  const g = await fixture();
  try {
    await g.install();
    await g.open();
    await g.controls("retire");
    await g.controls("seal");
    await expect(g.controls("release")).rejects.toThrow("committed");
    const stale = g.fence();
    await g.resume();
    g.verifier.setClaims("stale", {
      ...g.claims,
      reattach: true,
      initialNavigation: undefined,
      pool: { ...stale, attachment: 5 },
    });
    await expect(g.runtime.attach("stale", new FakeSink())).rejects.toThrow(
      "authority has changed",
    );
    const first = await g.reattach(2);
    await first.close();
    expect(g.page.isClosed()).toBe(false);
    expect(g.runtime.poolState()).toMatchObject({ phase: "adopting" });
    await g.reattach(3);
    await expect(g.controls("complete", 1, 2)).rejects.toThrow("newer adoption attempt");
    await expect(g.controls("complete", 1, 3)).resolves.toMatchObject({
      adoption: { outcome: { adopted: [g.claims.sessionId], lost: [] } },
    });
    expect(g.page.isClosed()).toBe(false);
  } finally {
    await g.runtime.shutdown();
  }
});

it("discards every page of the previous instance when a fresh one is installed", async () => {
  const f = await fixture();
  try {
    await f.install();
    await f.open();
    await f.controls("retire");
    await f.controls("seal");
    await expect(
      f.install({ ...f.fence(), instance: randomUUID(), epoch: 1 }),
    ).resolves.toMatchObject({ phase: "running", intent: null, retired: null });
    expect(f.page.isClosed()).toBe(true);
  } finally {
    await f.runtime.shutdown();
  }
});

it("thaws without detaching when the frozen probe finds blockers", async () => {
  const f = await fixture({
    probePage: async (_page, phase) => (phase === "frozen" ? ["upload", "download"] : []),
  });
  try {
    await f.install();
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
