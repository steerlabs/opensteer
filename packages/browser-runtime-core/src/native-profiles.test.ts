import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gate } from "@opensteer/shared/test-support/observation";
import { BrowserSessionIdSchema, LocalProfileBindingSchema } from "@opensteer/protocol";
import { sessionFilesRoot } from "./browser/session-files.js";
import { BrowserRuntime, type BrowserOpenTiming } from "./runtime.js";
import {
  FakeIsolatingLauncher,
  FakeContext,
  FakePage,
  FakeLaunchedBrowser,
  FakeProfileStateClient,
  FakeSink,
  FakeTicketVerifier,
  validClaims,
} from "./test-support/fakes.js";
import type { LocalProfileEngine } from "./browser/backend.js";
import type { ProfileInitializationClient } from "./profile-initialization-client.js";

const runtimes: BrowserRuntime[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});
async function fixture(maxProfileHosts = 8, existingRoot?: string) {
  const root = existingRoot ?? (await mkdtemp(path.join(tmpdir(), "native-runtime-")));
  if (!existingRoot) roots.push(root);
  const launcher = Object.assign(new FakeIsolatingLauncher(), {
    localProfiles: {
      engine: "chromium",
      preparation: 1,
      importAndFlush: vi.fn(async () => {}),
      release: vi.fn<LocalProfileEngine["release"]>(async () => "released"),
    } satisfies LocalProfileEngine,
  });
  const state = new FakeProfileStateClient();
  const initializationClient = {
    load: vi.fn<ProfileInitializationClient["load"]>(async () => state.snapshot),
    complete: vi.fn(async () => {}),
  };
  const verifier = new FakeTicketVerifier();
  const filesRoot = sessionFilesRoot(root);
  const timings: BrowserOpenTiming[] = [];
  const runtime = new BrowserRuntime({
    onOpenTiming: (timing) => timings.push(timing),
    launcher,
    profileStateClient: state,
    ticketVerifier: verifier,
    localProfiles: { root },
    initializationClient,
    maxProfileHosts,
    runtimeId: "runtime_test",
    sessionFilesRoot: filesRoot,
  });
  runtimes.push(runtime);
  await runtime.prepare();
  const storage = runtime.localProfileStorage!;
  const binding = (id: number) =>
    LocalProfileBindingSchema.parse({
      version: 1,
      deploymentId: "dep_00000000-0000-4000-8000-000000000001",
      runnerId: "rnr_00000000-0000-4000-8000-000000000001",
      profileId: `bpr_00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      storageInstanceId: storage.storageInstanceId,
      bindingId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      engine: "chromium",
    });
  const claims = (profile: number, session: number, initial = false) =>
    validClaims({
      identity: {
        kind: "profile-local",
        binding: binding(profile),
        initialization: {
          seed: { revision: 0, digest: "a".repeat(64) },
          initializationUrl: "https://host.test/init",
          initializationToken: "a".repeat(43),
        },
      },
      sessionId: BrowserSessionIdSchema.parse(
        `bsn_00000000-0000-4000-8000-${String(session).padStart(12, "0")}`,
      ),
      ...(initial
        ? {
            initialNavigationVersion: 1,
            initialNavigation: { operationKey: `open-${session}`, url: "https://example.test/" },
          }
        : {}),
    });
  const open = (profile: number, session: number, initial = false, signal?: AbortSignal) => {
    verifier.setClaims(String(session), claims(profile, session, initial));
    return runtime.attach(String(session), new FakeSink(), {
      localProfiles: true,
      initialNavigation: true,
      ...(signal ? { signal } : {}),
    });
  };
  return {
    prepare: (profile: number, signal?: AbortSignal) => {
      const c = claims(profile, profile);
      if (c.identity.kind !== "profile-local") throw Error("expected local");
      const identity = c.identity;
      verifier.verifyPreparation = vi.fn(async () => ({
        audience: c.audience,
        purpose: "profile-prepare" as const,
        identity,
        runtimeId: c.runtimeId,
        subject: c.subject,
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
        nonce: c.nonce,
      }));
      return runtime.prepareProfile("prepare", {
        localProfiles: true,
        profilePrepare: true,
        ...(signal ? { signal } : {}),
      });
    },
    timings,
    root,
    runtime,
    launcher,
    state,
    initializationClient,
    verifier,
    claims,
    open,
    binding,
  };
}
describe("native profile runtime", () => {
  it("does not submit a second blank navigation to an already-created initial page", async () => {
    const f = await fixture();
    const navigation = vi.spyOn(FakePage.prototype, "submitNavigation");
    const claims = f.claims(1, 1);
    f.verifier.setClaims("blank", {
      ...claims,
      initialNavigationVersion: 1,
      initialNavigation: { operationKey: "blank" },
    });
    try {
      const attachment = await f.runtime.attach("blank", new FakeSink(), {
        localProfiles: true,
        initialNavigation: true,
      });
      expect(attachment.initialPage).toMatchObject({ navigation: "blank" });
      expect(navigation).not.toHaveBeenCalled();
      await attachment.close();
    } finally {
      navigation.mockRestore();
    }
  });
  it.each(["load", "import"])(
    "cancels a normal open during %s before promotion or completion",
    async (stage) => {
      const f = await fixture();
      const held = gate({ label: `attach ${stage}`, deadlineMs: 2000 });
      if (stage === "load")
        f.initializationClient.load.mockImplementationOnce(async () => {
          await held.enter();
          return f.state.snapshot;
        });
      else f.launcher.localProfiles.importAndFlush.mockImplementationOnce(() => held.enter());
      const cancellation = new AbortController();
      const opening = f.open(1, 1, false, cancellation.signal);
      const refused = expect(opening).rejects.toThrow();
      await held.entered;
      cancellation.abort();
      held.release();
      await refused;
      expect(f.initializationClient.load.mock.calls[0]?.[1]).toBe(cancellation.signal);
      expect(f.initializationClient.complete).not.toHaveBeenCalled();
      expect(f.launcher.launchCount).toBe(0);
      const marker = JSON.parse(
        await readFile(
          path.join(f.root, "profiles", f.binding(1).profileId, "binding.v1.json"),
          "utf8",
        ),
      );
      expect(marker.phase).toBe("initializing");
      if (stage === "load") expect(f.launcher.localProfiles.importAndFlush).not.toHaveBeenCalled();
    },
  );
  it("prepares Chromium conversion without retaining a browser, and ready preparation does no work", async () => {
    const f = await fixture();
    Object.assign(f.launcher.localProfiles, { preparation: "conversion" });
    const held = gate({ label: "conversion-only prepare", deadlineMs: 2000 });
    f.launcher.localProfiles.importAndFlush.mockImplementationOnce(() => held.enter());
    const preparing = f.prepare(1);
    await held.entered;
    const opening = f.open(1, 2);
    held.release();
    expect((await preparing).retained).toBe(false);
    const tab = await opening;
    expect(f.initializationClient.load).toHaveBeenCalledTimes(1);
    expect(f.initializationClient.complete).toHaveBeenCalledTimes(2);
    expect(f.launcher.localProfiles.importAndFlush).toHaveBeenCalledTimes(1);
    expect(f.launcher.launchCount).toBe(1);
    await tab.close();
    await f.runtime.shutdown();
    const next = await fixture(8, f.root);
    Object.assign(next.launcher.localProfiles, { preparation: "conversion" });
    expect((await next.prepare(1)).retained).toBe(false);
    expect(next.launcher.launchCount).toBe(0);
    expect(next.initializationClient.load).not.toHaveBeenCalled();
    expect(next.launcher.localProfiles.importAndFlush).not.toHaveBeenCalled();
  });
  it("prepares without pages or sessions and the first open shares acquisition", async () => {
    const f = await fixture();
    const held = gate({ label: "prepared import", deadlineMs: 2000 });
    f.launcher.localProfiles.importAndFlush.mockImplementationOnce(() => held.enter());
    let launchSignal: AbortSignal | undefined;
    vi.spyOn(f.launcher, "launch").mockImplementation(async (request, signal) => {
      launchSignal = signal;
      f.launcher.requests.push(request);
      f.launcher.launchCount++;
      const browser = new FakeLaunchedBrowser(new FakeContext([]));
      f.launcher.browsersByPartition.set(request.partitionKey, browser);
      return browser;
    });
    const claims = f.claims(1, 1);
    if (claims.identity.kind !== "profile-local") throw Error("expected local identity");
    f.verifier.verifyPreparation = vi.fn(async () => ({
      audience: "opensteer-browser-runtime" as const,
      purpose: "profile-prepare" as const,
      identity: claims.identity as Extract<typeof claims.identity, { kind: "profile-local" }>,
      runtimeId: claims.runtimeId,
      subject: claims.subject,
      nonce: claims.nonce,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    }));
    const preparing = f.runtime.prepareProfile("prepare", {
      localProfiles: true,
      profilePrepare: true,
    });
    await held.entered;
    const opening = f.open(1, 2);
    held.release();
    const prepared = await preparing;
    expect(f.runtime.health().sessionCount).toBe(0);
    const tab = await opening;
    expect(f.launcher.launchCount).toBe(1);
    expect(f.initializationClient.load).toHaveBeenCalledTimes(1);
    expect(f.launcher.requests[0]).toMatchObject({ preparation: true });
    await prepared.close();
    expect(launchSignal?.aborted, "Transferred preparation aborted its admitted host").toBe(false);
    expect(f.initializationClient.complete).toHaveBeenCalledTimes(1);
    expect(f.runtime.health().sessionCount).toBe(1);
    await tab.close();
  });
  it("retains zero pages and bounds speculation without evicting a useful host", async () => {
    const f = await fixture(1);
    const active = await f.open(2, 2);
    const claims = f.claims(1, 1);
    f.verifier.verifyPreparation = vi.fn(async () => ({
      audience: claims.audience,
      runtimeId: claims.runtimeId,
      subject: claims.subject,
      nonce: claims.nonce,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      purpose: "profile-prepare" as const,
      identity: claims.identity as Extract<typeof claims.identity, { kind: "profile-local" }>,
    }));
    const skipped = await f.runtime.prepareProfile("prepare", {
      localProfiles: true,
      profilePrepare: true,
    });
    expect(f.launcher.launchCount).toBe(1);
    expect(f.initializationClient.load).toHaveBeenCalledTimes(1);
    await skipped.close();
    await active.close();
  });
  it("retains a single speculative host with no user pages or sessions", async () => {
    const f = await fixture();
    const prepared = await f.prepare(1);
    expect(prepared.retained).toBe(true);
    expect(f.runtime.health()).toMatchObject({ profileHostCount: 1, sessionCount: 0 });
    expect([...f.launcher.browsersByPartition.values()][0]!.context.pages()).toEqual([]);
    const skipped = await f.prepare(2);
    expect(skipped.retained).toBe(false);
    expect(f.launcher.launchCount).toBe(1);
    await prepared.close();
    expect(f.runtime.health().profileHostCount).toBe(0);
    expect((await f.prepare(1)).retained).toBe(false);
    expect(f.launcher.launchCount).toBe(1);
  });
  it.each(["cancel", "delete", "shutdown"] as const)(
    "%s wins over pending preparation and preserves the failed initialization fence",
    async (stop) => {
      const f = await fixture();
      const held = gate({ label: "preparation import", deadlineMs: 2000 });
      f.launcher.localProfiles.importAndFlush.mockImplementationOnce(() => held.enter());
      const cancellation = new AbortController();
      const preparing = f.prepare(1, cancellation.signal);
      const refused = expect(preparing).rejects.toThrow();
      await held.entered;
      let ending: Promise<unknown> | undefined;
      if (stop === "cancel") cancellation.abort();
      else if (stop === "delete")
        ending = f.runtime.deleteLocalProfile(f.binding(1), "00000000-0000-4000-8000-000000000019");
      else ending = f.runtime.shutdown();
      held.release();
      await refused;
      await ending;
      expect(f.initializationClient.complete).not.toHaveBeenCalled();
      expect(f.launcher.launchCount).toBe(0);
      if (stop === "cancel")
        await expect(f.open(1, 3)).rejects.toThrow(/initializ|process|retained|in use/i);
    },
  );
  it("lets an unrelated profile open during speculative conversion", async () => {
    const f = await fixture();
    const held = gate({ label: "speculative import", deadlineMs: 2000 });
    f.launcher.localProfiles.importAndFlush.mockImplementationOnce(() => held.enter());
    const preparing = f.prepare(1);
    await held.entered;
    try {
      const other = await f.open(2, 3);
      expect(f.launcher.launchCount).toBe(1);
      await other.close();
    } finally {
      held.release();
    }
    await (await preparing).close();
  });
  it("allows only one runtime to own a storage root", async () => {
    const f = await fixture();
    await expect(fixture(8, f.root)).rejects.toThrow(/in use/);
  });
  it("durably fences deletion while an admitted conversion is still running", async () => {
    const f = await fixture();
    const held = gate({ label: "admitted import", deadlineMs: 2000 });
    f.launcher.localProfiles.importAndFlush.mockImplementationOnce(() => held.enter());
    const opening = f.open(1, 1);
    const refused = expect(opening).rejects.toThrow(/deleted/);
    await held.entered;
    const removing = f.runtime.deleteLocalProfile(
      f.binding(1),
      "00000000-0000-4000-8000-000000000006",
    );
    // The directory still belongs to the admitted engine, but deletion already
    // survives process death and prevents promotion/completion.
    await vi.waitFor(
      async () =>
        expect(
          JSON.parse(
            await readFile(
              path.join(f.root, "tombstones", `${f.binding(1).profileId}.json`),
              "utf8",
            ),
          ),
        ).toMatchObject({ phase: "deleted", erasure: "pending-restart" }),
      { timeout: 1000 },
    );
    held.release();
    await refused;
    expect(await removing).toBe("deleted");
    expect(f.initializationClient.complete).not.toHaveBeenCalled();
    expect(f.launcher.launchCount).toBe(0);
  });
  it("retains a live engine's deleted data across logical runtime restarts", async () => {
    const f = await fixture();
    const tab = await f.open(1, 1);
    f.launcher.localProfiles.release.mockResolvedValue("retained-until-exit");
    expect(
      await f.runtime.deleteLocalProfile(f.binding(1), "00000000-0000-4000-8000-000000000007"),
    ).toBe("pending-restart");
    expect(await f.runtime.localProfileInventory()).toEqual([
      expect.objectContaining({ phase: "deleted", erasure: "pending-restart" }),
    ]);
    await tab.close();
    await f.runtime.shutdown();
    const next = await fixture(8, f.root);
    expect(await next.runtime.localProfileInventory()).toEqual([
      expect.objectContaining({ phase: "deleted", erasure: "pending-restart" }),
    ]);
    await expect(next.open(1, 2)).rejects.toThrow(/deleted/);
    expect(next.launcher.launchCount).toBe(0);
  });
  it("evicts the least recently used host when several hosts are idle", async () => {
    const f = await fixture(2);
    const a = await f.open(1, 1);
    const b = await f.open(2, 2);
    await a.close();
    await b.close();
    const again = await f.open(1, 3);
    await again.close();
    const third = await f.open(3, 4);
    expect(
      f.launcher.browsersByPartition.get("profile:" + f.binding(1).profileId)?.closeCount,
    ).toBe(0);
    expect(
      f.launcher.browsersByPartition.get("profile:" + f.binding(2).profileId)?.closeCount,
    ).toBe(1);
    await third.close();
    expect(f.launcher.localProfiles.release).not.toHaveBeenCalled();
  });
  it("never imports or completes a ready profile whose native directory disappeared", async () => {
    const f = await fixture();
    const tab = await f.open(1, 1);
    await tab.close();
    await rm(path.join(f.root, "profiles", f.binding(1).profileId, "native"), { recursive: true });
    const completions = f.initializationClient.complete.mock.calls.length;
    await expect(f.open(1, 2)).rejects.toThrow(/missing/);
    expect(f.initializationClient.complete).toHaveBeenCalledTimes(completions);
    expect(f.launcher.localProfiles.importAndFlush).toHaveBeenCalledTimes(1);
  });

  it("lets profile B start while A imports and coalesces same-profile acquisition", async () => {
    const f = await fixture();
    const held = gate({ label: "profile A import", deadlineMs: 2000 });
    f.launcher.localProfiles.importAndFlush.mockImplementationOnce(() => held.enter());
    const a = f.open(1, 1);
    await held.entered;
    const same = f.open(1, 2);
    try {
      const b = await f.open(2, 3);
      expect(f.launcher.launchCount).toBe(1);
      await b.close();
    } finally {
      held.release();
    }
    const [first, second] = await Promise.all([a, same]);
    expect(f.launcher.launchCount).toBe(2);
    expect(f.initializationClient.load).toHaveBeenCalledTimes(2);
    expect(f.state.loads).toBe(0);
    const exports = [...f.launcher.browsersByPartition.values()].map((browser) =>
      vi.spyOn(browser, "exportSnapshot"),
    );
    await first.close();
    await second.close();
    expect(
      f.launcher.browsersByPartition.get("profile:" + f.binding(1).profileId)?.closeCount,
    ).toBe(0);
    expect(f.state.commits).toHaveLength(0);
    await f.runtime.shutdown();
    for (const exported of exports) expect(exported).not.toHaveBeenCalled();
    expect(f.state.commits).toHaveLength(0);
  });
  it("opens ready local tickets without a seed and fences old Host snapshot tickets", async () => {
    const f = await fixture();
    const first = await f.open(1, 1);
    await first.close();
    const claims = f.claims(1, 2);
    if (claims.identity.kind !== "profile-local") throw new Error("expected local claims");
    f.verifier.setClaims("local", {
      ...claims,
      identity: { kind: "profile-local", binding: claims.identity.binding },
    });
    const native = await f.runtime.attach("local", new FakeSink(), { localProfiles: true });
    expect(f.initializationClient.load).toHaveBeenCalledTimes(1);
    expect(f.initializationClient.complete).toHaveBeenCalledTimes(1);
    f.verifier.setClaims(
      "old-host",
      validClaims({
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
      }),
    );
    await expect(f.runtime.attach("old-host", new FakeSink())).rejects.toThrow(/Update this Host/);
    const missing = f.claims(2, 4);
    if (missing.identity.kind !== "profile-local") throw new Error("expected local claims");
    f.verifier.setClaims("missing", {
      ...missing,
      identity: { kind: "profile-local", binding: missing.identity.binding },
    });
    await expect(
      f.runtime.attach("missing", new FakeSink(), { localProfiles: true }),
    ).rejects.toThrow(/missing/);
    expect(f.launcher.launchCount).toBe(1);
    expect(f.state.loads).toBe(0);
    await native.close();
  });

  it("keeps native hosts warm and evicts only the least recently used idle host", async () => {
    const f = await fixture(2);
    const a = await f.open(1, 1);
    const b = await f.open(2, 2);
    await expect(f.open(3, 3)).rejects.toThrow(/capacity/);
    await a.close();
    const c = await f.open(3, 4);
    expect(
      f.launcher.browsersByPartition.get("profile:" + f.binding(1).profileId)?.closeCount,
    ).toBe(1);
    expect(
      f.launcher.browsersByPartition.get("profile:" + f.binding(2).profileId)?.closeCount,
    ).toBe(0);
    await b.close();
    await c.close();
  });
  it("never starts another browser when an initial start has an uncertain outcome", async () => {
    const f = await fixture();
    f.verifier.setClaims("uncertain", f.claims(1, 1, true));
    const sink = new FakeSink();
    sink.sendServerImplementation = async () => {
      throw new Error("lost attachment response");
    };
    await expect(
      f.runtime.attach("uncertain", sink, { localProfiles: true, initialNavigation: true }),
    ).rejects.toThrow();
    await expect(
      f.runtime.attach("uncertain", new FakeSink(), {
        localProfiles: true,
        initialNavigation: true,
      }),
    ).rejects.toThrow(/outcome/);
    expect(f.launcher.launchCount).toBe(1);
  });

  it("records opaque stage durations for conversion and warm opens without browser data", async () => {
    const f = await fixture();
    const first = await f.open(1, 1, true);
    await first.close();
    const warm = await f.open(1, 2, true);
    expect(f.timings.map((timing) => timing.stage)).toEqual([
      "lane-wait",
      "profile-acquire",
      "root-page-ready",
      "navigation-submitted",
      "lane-wait",
      "profile-acquire",
      "root-page-ready",
      "navigation-submitted",
    ]);
    expect(
      f.timings
        .filter((timing) => timing.stage === "profile-acquire")
        .map((timing) => timing.acquisition),
    ).toEqual(["conversion", "warm"]);
    expect(new Set(f.timings.map((timing) => timing.correlationId)).size).toBe(2);
    for (const timing of f.timings) {
      expect(timing.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(timing.elapsedSinceStartMs).toBeGreaterThanOrEqual(timing.elapsedMs);
      expect(timing.correlationId).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(JSON.stringify(f.timings)).not.toContain("example.test");
    await warm.close();
  });
  it("returns initial readiness before commit and replays the same page", async () => {
    const f = await fixture();
    const first = await f.open(1, 1, true);
    expect(first.initialPage).toMatchObject({ operationKey: "open-1", navigation: "submitted" });
    const browser = f.launcher.browsersByPartition.get("profile:" + f.binding(1).profileId)!;
    expect(browser.context.pages()[0]?.url()).toBe("about:blank");
    const replay = await f.runtime.attach("1", new FakeSink(), {
      localProfiles: true,
      initialNavigation: true,
    });
    expect(replay.initialPage).toEqual(first.initialPage);
    expect(f.launcher.launchCount).toBe(1);
    expect(browser.context.pages()).toHaveLength(1);
    await first.close();
    expect(f.runtime.health().sessionCount).toBe(1);
    await replay.close();
    expect(f.runtime.health().sessionCount).toBe(0);
  });
  it("does not launch a normal page until the Host acknowledges completion", async () => {
    const f = await fixture();
    const held = gate({ label: "Host profile completion", deadlineMs: 2000 });
    f.initializationClient.complete.mockImplementationOnce(() => held.enter());
    const opening = f.open(1, 1, true);
    try {
      await held.entered;
      expect(f.launcher.launchCount).toBe(0);
      held.release();
      await (await opening).close();
      expect(f.launcher.launchCount).toBe(1);
    } finally {
      held.release();
      await opening.catch(() => undefined);
    }
  });
  it("fences failed conversion in-process and replays completion after ready", async () => {
    const f = await fixture();
    f.initializationClient.complete.mockRejectedValueOnce(new Error("response lost"));
    await expect(f.open(1, 1)).rejects.toThrow();
    const next = await f.open(1, 2);
    expect(f.launcher.localProfiles.importAndFlush).toHaveBeenCalledTimes(1);
    expect(f.initializationClient.complete).toHaveBeenCalledTimes(2);
    await next.close();
    f.launcher.localProfiles.importAndFlush.mockRejectedValueOnce(new Error("import interrupted"));
    await expect(f.open(2, 3)).rejects.toThrow();
    await expect(f.open(2, 4)).rejects.toThrow(/process/);
  });
  it("tombstones before closing, rejects stale tickets and inventories deletion", async () => {
    const f = await fixture();
    const a = await f.open(1, 1);
    expect(
      await f.runtime.deleteLocalProfile(f.binding(1), "00000000-0000-4000-8000-000000000005"),
    ).toBe("deleted");
    await expect(f.open(1, 2)).rejects.toThrow(/deleted/);
    expect(await f.runtime.localProfileInventory()).toEqual([
      expect.objectContaining({ phase: "deleted", erasure: "deleted" }),
    ]);
    await a.close();
  });
});
