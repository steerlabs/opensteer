import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gate } from "@opensteer/shared/test-support/observation";
import { BrowserSessionIdSchema, LocalProfileBindingSchema } from "@opensteer/protocol";
import { BrowserRuntime } from "./runtime.js";
import {
  FakeIsolatingLauncher,
  FakeProfileStateClient,
  FakeSink,
  FakeTicketVerifier,
  validClaims,
} from "./test-support/fakes.js";
import type { LocalProfileEngine } from "./browser/backend.js";

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
      importAndFlush: vi.fn(async () => {}),
      release: vi.fn<LocalProfileEngine["release"]>(async () => "released"),
    } satisfies LocalProfileEngine,
  });
  const state = new FakeProfileStateClient();
  const initializationClient = {
    load: vi.fn(async () => state.snapshot),
    complete: vi.fn(async () => {}),
  };
  const verifier = new FakeTicketVerifier();
  const filesRoot = path.join(root, "..", `${path.basename(root)}-files-${roots.length}`);
  roots.push(filesRoot);
  const runtime = new BrowserRuntime({
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
  const open = (profile: number, session: number, initial = false) => {
    verifier.setClaims(String(session), claims(profile, session, initial));
    return runtime.attach(String(session), new FakeSink(), {
      localProfiles: true,
      initialNavigation: true,
    });
  };
  return { root, runtime, launcher, state, initializationClient, verifier, claims, open, binding };
}
describe("native profile runtime", () => {
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
  it("retains a live engine's deleted data until the next exclusive owner starts", async () => {
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
      expect.objectContaining({ phase: "deleted", erasure: "deleted" }),
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
