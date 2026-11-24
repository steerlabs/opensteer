import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  browserPoolControlBytes,
  type BrowserPoolControl,
  type BrowserPoolRuntimeFence,
} from "./browser-pool.js";
import { SessionFiles } from "./browser/session-files.js";
import { BrowserRuntime, pooledSessionWithoutChannelMs } from "./runtime.js";
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

it("refuses a control before it moves the high-water mark, so an earlier one that applies still does", async () => {
  const f = await fixture();
  try {
    await f.install();
    await f.open();
    const intent = { id: "intent-1", sequence: 1 };
    const retire = f.issue({ kind: "retire", fence: f.fence(), intent });
    const seal = f.issue({ kind: "seal", fence: f.fence(), intent });
    // The seal arrives first, before its retire: refused, and nothing is superseded by it.
    await expect(seal.apply()).rejects.toThrow("unresolved");
    await expect(retire.apply()).resolves.toMatchObject({ phase: "retired" });
    await expect(seal.apply()).resolves.toMatchObject({ phase: "sealed" });
    // Signed again, a step of the same intent returns the state it reached.
    await expect(f.controls("seal")).resolves.toMatchObject({ phase: "sealed" });
    // An install of the fence already installed is refused, and discards nothing.
    await expect(
      f.signed({
        kind: "install",
        fence: f.fence(),
        sequence: 100,
        expect: f.fence(),
      }),
    ).rejects.toThrow("moved backwards");
    expect(f.runtime.poolState()).toMatchObject({ phase: "sealed", fence: f.fence() });
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

it("poolPageRetireBlockers vetoes retire during an active download or upload and clears once done", async () => {
  const { poolPageRetireBlockers } = await import("./browser-pool.js");
  let active: readonly ("download" | "upload")[] = ["download"];
  const f = await fixture({
    probePage: (page, phase) => poolPageRetireBlockers(page, phase),
  });
  try {
    await f.install();
    await f.open();
    f.page.activeTransfers = () => active;
    expect(await f.controls("retire")).toMatchObject({
      phase: "running",
      blockers: ["download"],
    });
    active = [];
    expect(await f.controls("retire", 2)).toMatchObject({
      phase: "retired",
      blockers: [],
    });
  } finally {
    await f.runtime.shutdown();
  }
});

it("keeps a pooled session without a channel for its whole window, and ends it with its pages after", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await fixture();
  try {
    await f.install();
    const attachment = await f.open();
    // The Runner's channel is lost; the Home is away for longer than the old 20 seconds.
    await attachment.close(false, false, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.page.isClosed()).toBe(false);
    await vi.advanceTimersByTimeAsync(pooledSessionWithoutChannelMs - 30_000 - 1_000);
    expect(f.page.isClosed()).toBe(false);
    // Past the window, the session ends and its pages close in the guest.
    await vi.advanceTimersByTimeAsync(2_000);
    for (let turn = 0; turn < 20 && !f.page.isClosed(); turn++)
      await vi.advanceTimersByTimeAsync(100);
    expect(f.page.isClosed()).toBe(true);
  } finally {
    vi.useRealTimers();
    await f.runtime.shutdown();
  }
});

it("ends an ordinary runtime's session with its channel, with no window", async () => {
  const page = new FakePage();
  const verifier = new FakeTicketVerifier();
  const runtime = new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([page]))),
    runtimeId: "runtime_ordinary",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: verifier,
  });
  try {
    verifier.setClaims(
      "open",
      freshClaims({ actor: "person", creationOrigin: "person", tabRestoreVersion: 1 }),
    );
    const attachment = await runtime.attach("open", new FakeSink());
    await attachment.handle(
      JSON.stringify({ type: "session.state", runs: 0, personUsed: [], viewed: [], pinned: [] }),
    );
    expect(page.isClosed()).toBe(false);
    await attachment.close(false, false, true);
    await vi.waitFor(() => expect(page.isClosed()).toBe(true));
  } finally {
    await runtime.shutdown();
  }
});

// ---- P15: the Home's request to end a session, answered after the runtime's own teardown ------

/** The Home's end ticket for the fixture's session, under the fence it holds now. */
function endRequest(f: Awaited<ReturnType<typeof fixture>>, name: string, fence = f.fence()) {
  f.verifier.setClaims(name, {
    ...f.claims,
    initialNavigation: undefined,
    pool: { ...fence, end: true },
  });
  return f.runtime.endPoolSession(name);
}

/** The page's close waits until it is let go; then it closes. */
function holdClose(page: FakePage) {
  const held = Promise.withResolvers<void>();
  const close = page.close.bind(page);
  const spy = vi.spyOn(page, "close").mockImplementation(async () => {
    await held.promise;
    await close();
  });
  return { spy, release: () => held.resolve() };
}

it("ends a session it still holds when the Home asks, and says ended only once its pages are gone", async () => {
  const f = await fixture();
  try {
    await f.install();
    // The channel stays open: the guest has not seen it close.
    await f.open();
    const closing = holdClose(f.page);
    const first = endRequest(f, "end-1");
    await vi.waitFor(() => expect(closing.spy).toHaveBeenCalled());
    // While its pages close, the answer is not yet.
    expect((await endRequest(f, "end-2")).outcome).toBe("not-yet");
    expect(f.page.isClosed()).toBe(false);
    closing.release();
    expect(await first).toMatchObject({
      outcome: "ended",
      state: { phase: "running", fence: f.fence() },
    });
    expect(f.page.isClosed()).toBe(true);
    // Nothing held and nothing being torn down: ended; and the session is never attached again.
    expect((await endRequest(f, "end-3")).outcome).toBe("ended");
    await expect(f.reattach(5)).rejects.toThrow("has ended");
  } finally {
    await f.runtime.shutdown();
  }
});

it("answers unknown after a teardown that failed, never ended, and ends the session when asked again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const filesDisposed = Promise.withResolvers<void>();
  const realDispose = SessionFiles.prototype.dispose;
  const disposeSpy = vi.spyOn(SessionFiles.prototype, "dispose").mockImplementation(async function (
    this: SessionFiles,
  ) {
    try {
      await realDispose.call(this);
    } finally {
      filesDisposed.resolve();
    }
  });
  const f = await fixture();
  try {
    await f.install();
    await f.open();
    const closing = holdClose(f.page);
    const first = endRequest(f, "end-1");
    await vi.waitFor(() => expect(closing.spy).toHaveBeenCalled());
    let answered = false;
    void first.finally(() => {
      answered = true;
    });
    // Its teardown's bound (5 s), then wait for real fs.rm in active.files.dispose() so busy
    // filesystem I/O cannot burn fake time before the ledger's own page wait (2 s) starts.
    await vi.advanceTimersByTimeAsync(5_000);
    await filesDisposed.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(answered).toBe(true);
    expect((await first).outcome).toBe("unknown");
    expect(f.page.isClosed()).toBe(false);
    closing.release();
    await vi.waitFor(() => expect(f.page.isClosed()).toBe(true));
    const again = endRequest(f, "end-2");
    await vi.advanceTimersByTimeAsync(100);
    expect((await again).outcome).toBe("ended");
  } finally {
    disposeSpy.mockRestore();
    vi.useRealTimers();
    await f.runtime.shutdown();
  }
});

it("never says ended for a session whose channel's teardown failed, and ends it when asked", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await fixture();
  try {
    await f.install();
    const attachment = await f.open();
    const closing = holdClose(f.page);
    // The channel ends the session; its pages do not close.
    const closed = attachment.close().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(6_000);
    await closed;
    expect(f.page.isClosed()).toBe(false);
    // Its page's close is still being asked of the engine: not yet (V3: from what the ledger
    // holds, a close under way is not-yet; it was unknown from the old teardown bookkeeping).
    const first = endRequest(f, "end-1");
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).outcome).toBe("not-yet");
    closing.release();
    await vi.waitFor(() => expect(f.page.isClosed()).toBe(true));
    const again = endRequest(f, "end-2");
    await vi.advanceTimersByTimeAsync(100);
    expect((await again).outcome).toBe("ended");
  } finally {
    vi.useRealTimers();
    await f.runtime.shutdown();
  }
});

it("ends a session kept for its lost channel without reviving it or extending its window", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await fixture();
  try {
    await f.install();
    const attachment = await f.open();
    await attachment.close(false, false, true);
    expect(f.page.isClosed()).toBe(false);
    const answer = endRequest(f, "end-1");
    await vi.advanceTimersByTimeAsync(100);
    expect((await answer).outcome).toBe("ended");
    expect(f.page.isClosed()).toBe(true);
    await expect(f.reattach(5)).rejects.toThrow("has ended");
  } finally {
    vi.useRealTimers();
    await f.runtime.shutdown();
  }
});

it("refuses an end ticket on attach, an attach ticket as an end, another fence, and a runtime outside the pool", async () => {
  const f = await fixture();
  try {
    await f.install();
    f.verifier.setClaims("end-as-attach", {
      ...f.claims,
      pool: { ...f.fence(), attachment: 1, end: true },
    });
    await expect(f.runtime.attach("end-as-attach", new FakeSink())).rejects.toThrow(
      "only ends a browser session",
    );
    expect(f.context.pages()).toHaveLength(1);
    await f.open();
    f.verifier.setClaims("attach-as-end", {
      ...f.claims,
      initialNavigation: undefined,
      pool: { ...f.fence(), attachment: 2 },
    });
    await expect(f.runtime.endPoolSession("attach-as-end")).rejects.toThrow(
      "does not end a browser session",
    );
    await expect(
      endRequest(f, "other-fence", { ...f.fence(), epoch: f.fence().epoch + 1 }),
    ).rejects.toThrow("authority has changed");
    expect(f.page.isClosed()).toBe(false);
    // A runtime that does not serve traffic now ends nothing, and says not yet.
    await f.controls("retire");
    expect((await endRequest(f, "retired")).outcome).toBe("not-yet");
    expect(f.page.isClosed()).toBe(false);
  } finally {
    await f.runtime.shutdown();
  }
  const ordinary = new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([new FakePage()]))),
    runtimeId: "runtime_ordinary",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: new FakeTicketVerifier(),
  });
  await expect(ordinary.endPoolSession("any")).rejects.toThrow("unavailable");
  await ordinary.shutdown();
});

it("answers not yet while an attach of the session is still opening, and that attach never keeps it", async () => {
  const f = await fixture();
  try {
    await f.install();
    // The attach waits for its browser to launch: it is opening when the Home asks.
    const launched = Promise.withResolvers<void>();
    const launch = vi
      .spyOn(FakeLauncher.prototype, "launch")
      .mockImplementationOnce(async function (this: FakeLauncher) {
        await launched.promise;
        return this.browser;
      });
    f.verifier.setClaims("opening", { ...f.claims, pool: { ...f.fence(), attachment: 1 } });
    const opening = f.runtime.attach("opening", new FakeSink());
    void opening.catch(() => undefined);
    await vi.waitFor(() => expect(launch).toHaveBeenCalled());
    expect((await endRequest(f, "end-1")).outcome).toBe("not-yet");
    launched.resolve();
    // The attach is refused before it keeps the session, and the page it opened is closed.
    await expect(opening).rejects.toThrow("has ended");
    await vi.waitFor(() => expect(f.page.isClosed()).toBe(true));
    expect((await endRequest(f, "end-2")).outcome).toBe("ended");
  } finally {
    await f.runtime.shutdown();
  }
});

it("refuses a standard CDP attach of a session whose end the Home asked, though the runtime still holds it", async () => {
  const f = await fixture();
  try {
    await f.install();
    await f.open();
    // The seam: the session's lane is held, so the end's teardown and the attach both wait
    // behind it; the end is recorded at once, before either runs.
    const lane = Promise.withResolvers<void>();
    const lanes = (
      f.runtime as unknown as {
        lanes: { run(key: string, work: () => Promise<void>): Promise<void> };
      }
    ).lanes;
    const held = lanes.run(`session:${f.claims.sessionId}`, () => lane.promise);
    f.verifier.setClaims("standard", {
      ...f.claims,
      initialNavigation: undefined,
      access: "read-write",
      standardCdp: "session",
      standardCdpAttempt: {
        attachmentId: randomUUID(),
        runtimeBootId: f.runtime.standardCdpBootId,
      },
      pool: { ...f.fence(), attachment: 1 },
    });
    // A standard CDP ticket issued before the end arrives first; then the Home asks the end.
    const attach = f.runtime.attachStandardCdp("standard", () => {}, new AbortController().signal);
    void attach.catch(() => undefined);
    // One turn of the event loop: its ticket is read and it waits in the lane, first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ending = endRequest(f, "end");
    lane.resolve();
    await held;
    // When the attach runs the session is still held, and its end recorded: never admitted.
    await expect(attach).rejects.toThrow("does not authorize a live Browser Session");
    expect((await ending).outcome).toBe("ended");
  } finally {
    await f.runtime.shutdown();
  }
});

it("says a pooled session closed at a host's quiesce only once its pages are confirmed gone (W17)", async () => {
  const f = await fixture();
  try {
    await f.install();
    const sink = new FakeSink();
    // Whether its page was gone when each `closed` status was sent.
    const closedSaid: boolean[] = [];
    sink.sendServerImplementation = async (message) => {
      if (message.type === "browser.status" && message.state === "closed")
        closedSaid.push(f.page.isClosed());
    };
    await f.open(sink);
    // The page's close is taken and never happens: past the bound a page close is waited for.
    vi.spyOn(f.page, "close").mockImplementation(async () => {
      f.page.closeCount += 1;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runtime = f.runtime as unknown as {
      hosts: Map<string, unknown>;
      quiesceHost(host: unknown, reason: string): Promise<void>;
    };
    const quiesced = runtime.quiesceHost([...runtime.hosts.values()][0], "session-ended");
    void quiesced.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    // Never "closed" while its page is still open: the guest's word must be true.
    expect(closedSaid.filter((pageGone) => !pageGone)).toEqual([]);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await f.runtime.shutdown().catch(() => undefined);
  }
});

it("can refuse an install only in a runtime that already held an instance: a fresh guest's runtime installs at once", async () => {
  // A fresh guest: its runtime has never held a fence, so an install has no live page to end.
  const fresh = await fixture();
  try {
    const first = fresh.issue({ kind: "install", fence: fresh.fence() });
    await expect(first.apply()).resolves.toMatchObject({ phase: "running" });
  } finally {
    await fresh.runtime.shutdown();
  }
  // A runtime that already held an instance (the loopback guest standing for a new one): the
  // install must end that instance's pages first, and a page that will not close fails it.
  const shared = await fixture();
  try {
    await shared.install();
    await shared.open();
    vi.spyOn(shared.page, "close").mockImplementation(async () => {
      shared.page.closeCount += 1;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const next = shared.issue({
      kind: "install",
      fence: { ...shared.fence(), instance: randomUUID() },
    });
    const installing = next.apply();
    void installing.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(installing).rejects.toThrow();
    // Its sequence is spent: the same signed install is superseded. Only this shared runtime
    // reaches that; the coordinator's fresh start always meets a fresh guest's runtime.
    await expect(shared.signed(next.control)).rejects.toThrow("superseded");
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await shared.runtime.shutdown().catch(() => undefined);
  }
});
