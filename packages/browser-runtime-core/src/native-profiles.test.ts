import { BrowserSessionIdSchema, LocalProfileBindingSchema } from "@opensteer/protocol";
import { gate } from "@opensteer/shared/test-support/observation";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalProfileEngine } from "./browser/backend.js";
import { sessionFilesRoot } from "./browser/session-files.js";
import { BrowserRuntime, type BrowserOpenTiming } from "./runtime.js";
import { LocalProfileStore } from "./local-profile-store.js";
import { LifecycleLanes } from "./async.js";
import {
  FakeIsolatingLauncher,
  FakePage,
  FakeSink,
  FakeTicketVerifier,
  validClaims,
} from "./test-support/fakes.js";

const runtimes: BrowserRuntime[] = [];
const roots: string[] = [];
const profileIo = vi.hoisted(() => ({
  publish: undefined as { destination: string; enter: () => Promise<void> } | undefined,
  remove: undefined as
    { directory: string; enter?: () => Promise<void>; after?: () => Promise<void> } | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    rename: async (...args: Parameters<typeof filesystem.rename>) => {
      if (args[1] === profileIo.publish?.destination) await profileIo.publish.enter();
      return filesystem.rename(...args);
    },
    rm: async (...args: Parameters<typeof filesystem.rm>) => {
      const fault = args[0] === profileIo.remove?.directory ? profileIo.remove : undefined;
      await fault?.enter?.();
      await filesystem.rm(...args);
      await fault?.after?.();
    },
  };
});
afterEach(async () => {
  profileIo.publish = undefined;
  profileIo.remove = undefined;
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});
async function fixture(maxProfileHosts = 8, existingRoot?: string) {
  const root = await realpath(
    existingRoot ?? (await mkdtemp(path.join(tmpdir(), "native-runtime-"))),
  );
  if (!existingRoot) roots.push(root);
  const launcher = Object.assign(new FakeIsolatingLauncher(), {
    localProfiles: {
      engine: "chromium",
      createFiles: vi.fn(async () => {}),
      release: vi.fn<LocalProfileEngine["release"]>(async () => "released"),
    } satisfies LocalProfileEngine,
  });
  const initialized = new Set<number>();
  const acknowledge = vi.fn(
    async (
      identity: Extract<
        import("@opensteer/protocol").BrowserAttachTicketIdentity,
        { kind: "profile-local" }
      >,
    ) => {
      initialized.add(Number(identity.binding.profileId.split("-").at(-1)));
    },
  );
  const verifier = new FakeTicketVerifier();
  const filesRoot = sessionFilesRoot(root);
  const timings: BrowserOpenTiming[] = [];
  const runtime = new BrowserRuntime({
    onOpenTiming: (timing) => timings.push(timing),
    launcher,
    ticketVerifier: verifier,
    localProfiles: { root },
    acknowledgeProfileReady: acknowledge,
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
        initialized: initialized.has(profile),
        readyUrl: "https://host.test/ready",
      },
      sessionId: BrowserSessionIdSchema.parse(
        `bsn_00000000-0000-4000-8000-${String(session).padStart(12, "0")}`,
      ),
      ...(initial
        ? {
            initialNavigation: { operationKey: `open-${session}`, url: "https://example.test/" },
          }
        : {}),
    });
  const open = (profile: number, session: number, initial = false, signal?: AbortSignal) => {
    verifier.setClaims(String(session), claims(profile, session, initial));
    return runtime.attach(String(session), new FakeSink(), signal ? { signal } : {});
  };
  return {
    timings,
    root,
    runtime,
    launcher,
    acknowledge,
    verifier,
    claims,
    open,
    binding,
  };
}
describe("native profile runtime", () => {
  it("refuses expired signed opening authority before creating native storage", async () => {
    const f = await fixture();
    const claims = f.claims(1, 1, true);
    f.verifier.setClaims("expired", {
      ...claims,
      operationExpiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await expect(f.runtime.attach("expired", new FakeSink())).rejects.toMatchObject({
      reason: "browser-open.timeout",
    });
    expect(f.launcher.localProfiles.createFiles).not.toHaveBeenCalled();
    expect(f.launcher.launchCount).toBe(0);
  });
  it("expires a hung restore, retries the same profile without releasing it, and bounds shutdown", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const never = new Promise<void>(() => {});
    const launch = f.launcher.launch.bind(f.launcher);
    vi.spyOn(f.launcher, "launch").mockImplementationOnce(async (request, signal) => {
      const browser = await launch(request, signal);
      return Object.assign(browser, {
        profile: {
          ready: () => {
            entered.resolve();
            return never;
          },
          admit: async () => {},
        },
      });
    });
    vi.useFakeTimers();
    const opening = f.open(1, 1);
    const settled = vi.fn();
    void opening.then(settled, settled);
    await entered.promise;
    try {
      const other = await f.open(2, 2);
      await other.close();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled, "expired restore must release the profile lane").toHaveBeenCalled();
      await expect(opening).rejects.toThrow();
      await (await f.open(1, 3)).close();
      const stopped = vi.fn();
      const shutdown = f.runtime.shutdown().then(stopped);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stopped, "shutdown must not join the abandoned restore").toHaveBeenCalled();
      await shutdown;
    } finally {
      vi.useRealTimers();
      // A red regression must not make fixture cleanup join the deliberately hung collaborator.
      if (!settled.mock.calls.length) runtimes.splice(runtimes.indexOf(f.runtime), 1);
    }
  });
  it("does not submit a second blank navigation to an already-created initial page", async () => {
    const f = await fixture();
    const navigation = vi.spyOn(FakePage.prototype, "cdp");
    const claims = f.claims(1, 1);
    f.verifier.setClaims("blank", {
      ...claims,
      initialNavigation: { operationKey: "blank" },
    });
    try {
      const attachment = await f.runtime.attach("blank", new FakeSink(), {});
      expect(attachment.initialPage).toMatchObject({ navigation: "blank" });
      const browser = f.launcher.browsersByPartition.get("profile:" + f.binding(1).profileId)!;
      expect(
        (browser.context.pages()[0] as FakePage).cdpSession.sent.filter(
          (command) => command.method === "Page.navigate",
        ),
      ).toEqual([]);
      await attachment.close();
    } finally {
      navigation.mockRestore();
    }
  });
  it("allows only one runtime to own a storage root", async () => {
    const f = await fixture();
    await expect(fixture(8, f.root)).rejects.toThrow(/in use/);
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
    await expect(f.runtime.attach("uncertain", sink, {})).rejects.toThrow();
    await expect(f.runtime.attach("uncertain", new FakeSink(), {})).rejects.toThrow(/outcome/);
    expect(f.launcher.launchCount).toBe(1);
  });

  it("records opaque stage durations for cold and warm opens without browser data", async () => {
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
    ).toEqual(["cold", "warm"]);
    expect(new Set(f.timings.map((timing) => timing.correlationId)).size).toBe(2);
    for (const timing of f.timings) {
      expect(timing.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(timing.elapsedSinceStartMs).toBeGreaterThanOrEqual(timing.elapsedMs);
      expect(timing.correlationId).toMatch(/^open-/);
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
    const replay = await f.runtime.attach("1", new FakeSink(), {});
    expect(replay.initialPage).toEqual(first.initialPage);
    expect(f.launcher.launchCount).toBe(1);
    expect(browser.context.pages()).toHaveLength(1);
    await first.close();
    expect(f.runtime.health().sessionCount).toBe(1);
    await replay.close();
    expect(f.runtime.health().sessionCount).toBe(0);
  });
  it("replays readiness acknowledgement without creating or importing an established store", async () => {
    const f = await fixture();
    const acknowledge = f.acknowledge.getMockImplementation()!;
    f.acknowledge.mockImplementationOnce(async (identity) => {
      await acknowledge(identity);
      throw new Error("readiness response lost");
    });
    await expect(f.open(1, 1)).rejects.toThrow();
    await (await f.open(1, 2)).close();
    expect(f.launcher.localProfiles.createFiles).toHaveBeenCalledOnce();
    expect(f.launcher.launchCount).toBe(1);
    expect(f.acknowledge).toHaveBeenCalledOnce();
    const sentinel = path.join(
      f.root,
      "profiles",
      f.binding(1).profileId,
      "native",
      "opensteer.v1.json",
    );
    await rm(path.dirname(sentinel), { recursive: true });
    await expect(f.open(1, 3)).rejects.toThrow(/missing/);
    expect(f.launcher.localProfiles.createFiles).toHaveBeenCalledOnce();
  });

  it("does not launch a page until the Host acknowledges native readiness", async () => {
    const f = await fixture();
    const held = gate({ label: "Host profile completion", deadlineMs: 2000 });
    f.acknowledge.mockImplementationOnce(() => held.enter());
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
  it("does not acknowledge erasure while its filesystem removal is unfinished", async () => {
    const fixtureState = await fixture();
    await (await fixtureState.open(1, 1)).close();
    const directory = path.join(fixtureState.root, "profiles", fixtureState.binding(1).profileId);
    const removing = gate({ label: "profile directory removal", deadlineMs: 2000 });
    profileIo.remove = { directory, enter: removing.enter };
    const acknowledged = vi.fn();
    const deletion = fixtureState.runtime
      .deleteLocalProfile(fixtureState.binding(1), "00000000-0000-4000-8000-000000000006")
      .then(acknowledged);
    try {
      await removing.entered;
      await access(directory);
      expect(acknowledged).not.toHaveBeenCalled();
      expect(await fixtureState.runtime.localProfileInventory()).toEqual([
        expect.objectContaining({ phase: "deleted", erasure: "pending-restart" }),
      ]);
    } finally {
      removing.release();
      await deletion;
    }
    expect(acknowledged).toHaveBeenCalledWith("deleted");
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("drains an already issued profile publication before acknowledging deletion", async () => {
    const fixtureState = await fixture();
    const directory = path.join(fixtureState.root, "profiles", fixtureState.binding(1).profileId);
    const publishing = gate({ label: "native profile publication", deadlineMs: 2000 });
    profileIo.publish = { destination: directory, enter: publishing.enter };
    const provision = LocalProfileStore.prototype.provision;
    let publication: Promise<string> | undefined;
    vi.spyOn(LocalProfileStore.prototype, "provision").mockImplementation(function (
      this: LocalProfileStore,
      ...args
    ) {
      publication = provision.apply(this, args);
      return publication;
    });
    const cancellation = new AbortController();
    const laneOperations = vi.spyOn(LifecycleLanes.prototype, "run");
    const opening = fixtureState.open(1, 1, false, cancellation.signal);
    const refused = expect(opening).rejects.toThrow("cancel native profile opening");
    const acknowledged = vi.fn();
    let deletion: Promise<unknown> | undefined;
    try {
      await publishing.entered;
      cancellation.abort(new Error("cancel native profile opening"));
      await refused;
      const acquisitionSettled = vi.fn();
      void laneOperations.mock.results[0]!.value.then(acquisitionSettled, acquisitionSettled);
      await fixtureState.runtime.localProfileInventory();
      expect(
        acquisitionSettled,
        "Cancellation released the profile lane before its already issued publication finished",
      ).not.toHaveBeenCalled();
      deletion = fixtureState.runtime
        .deleteLocalProfile(fixtureState.binding(1), "00000000-0000-4000-8000-000000000008")
        .then(acknowledged);
      publishing.release();
      await publication;
      await deletion;
      expect(acknowledged).toHaveBeenCalledWith("deleted");
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fixtureState.launcher.launchCount).toBe(0);
    } finally {
      publishing.release();
      await opening.catch(() => undefined);
      await publication;
      await deletion;
    }
  });
  it.each(["failed", "recreated"] as const)(
    "keeps %s physical erasure pending and retries it without reopening the profile",
    async (fault) => {
      const fixtureState = await fixture();
      await (await fixtureState.open(1, 1)).close();
      const binding = fixtureState.binding(1);
      const directory = path.join(fixtureState.root, "profiles", binding.profileId);
      const deletionId = "00000000-0000-4000-8000-000000000009";
      profileIo.remove = {
        directory,
        ...(fault === "failed"
          ? {
              enter: async () => {
                throw new Error("Injected profile removal failure");
              },
            }
          : {
              after: async () => {
                await mkdir(directory, { recursive: true });
              },
            }),
      };
      await expect(fixtureState.runtime.deleteLocalProfile(binding, deletionId)).rejects.toThrow(
        fault === "failed" ? "Injected profile removal failure" : /still exists after erasure/,
      );
      await access(directory);
      expect(await fixtureState.runtime.localProfileInventory()).toEqual([
        expect.objectContaining({ phase: "deleted", erasure: "pending-restart" }),
      ]);
      await expect(fixtureState.open(1, 2)).rejects.toThrow(/deleted/);
      profileIo.remove = undefined;
      expect(await fixtureState.runtime.deleteLocalProfile(binding, deletionId)).toBe("deleted");
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
