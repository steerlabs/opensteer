import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createId, HarnessIdSchema } from "@opensteer/core";
import {
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
  profileHarnessProviderStoreScope,
  type HarnessInstanceDefinition,
  type HarnessProviderStoreScope,
  type HarnessRuntimeBoundary,
} from "@opensteer/harness";
import { afterEach, describe, expect, it } from "vitest";
import {
  existingIsolatedHarnessProviderState,
  prepareHarnessProviderState,
  removeHarnessProviderState,
  type HarnessProviderStateOptions,
} from "./harness-provider-state.js";

const temporaryDirectories: string[] = [];

const sharedScope: HarnessProviderStoreScope = {
  kind: "driver-shared",
  nativeUserHome: { environmentVariable: "TEST_HOME", relativeHomePath: ".test" },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("harness provider state", () => {
  it("gives isolated profiles independent homes and one shared store identity", async () => {
    const root = await temporaryRoot();
    const first = definition("isolated");
    const second = definition("isolated");
    const options = sharedOptions(root, isolatedServiceHarnessRuntimeBoundary);
    const { providerState: firstState } = await prepareHarnessProviderState(first, options);
    const { providerState: secondState } = await prepareHarnessProviderState(second, options);

    expect(firstState.providerHomeDirectory).toBe(
      join(root, "harness-profiles", first.id, "provider-home"),
    );
    expect(secondState.providerHomeDirectory).not.toBe(firstState.providerHomeDirectory);
    // Two profiles of one driver resume each other's conversations, which is the
    // whole point of separating credentials from the session store.
    expect(secondState.continuationKey).toBe(firstState.continuationKey);
    expect(secondState.store.directory).toBe(join(root, "harness-stores", "test", "store"));
    expect(firstState.continuationKey).toMatch(/^test:store:[^:]+$/u);
    expect(firstState.continuationKey).not.toContain(root);
    expect(firstState.continuationKey).not.toContain(first.id);
    expect((await stat(storeMetadataPath(root))).mode & 0o777).toBe(0o600);
    expect((await prepareHarnessProviderState(first, options)).providerState.continuationKey).toBe(
      firstState.continuationKey,
    );
  });

  it("keeps a profile-scoped driver's profiles mutually unresumable", async () => {
    const root = await temporaryRoot();
    const first = definition("isolated");
    const second = definition("isolated");
    const options = profileOptions(root, isolatedServiceHarnessRuntimeBoundary);
    const { providerState: firstState } = await prepareHarnessProviderState(first, options);
    const { providerState: secondState } = await prepareHarnessProviderState(second, options);

    expect(firstState.continuationKey).not.toBe(secondState.continuationKey);
    expect(firstState.store.directory).toBe(firstState.providerHomeDirectory);
  });

  it("makes the ambient provider home the store on a native-user Runner", async () => {
    const root = await temporaryRoot();
    const ambientHome = join(root, "ambient-codex-home");
    const options = ambientOptions(root, ambientHome);
    const ambient = await prepareHarnessProviderState(definition("ambient"), options);
    const isolated = await prepareHarnessProviderState(definition("isolated"), options);

    expect(ambient.providerState.store.directory).toBe(ambientHome);
    expect(isolated.providerState.store.directory).toBe(ambientHome);
    expect(isolated.providerState.continuationKey).toBe(ambient.providerState.continuationKey);
    // Opensteer's own record never lands inside the person's CLI home.
    await expect(stat(join(ambientHome, "metadata.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(ambientMetadataPath(root, ambientHome))).resolves.toBeDefined();
  });

  it("gives each ambient home its own store identity on a native-user Runner", async () => {
    const root = await temporaryRoot();
    const firstHome = join(root, "ambient-home-one");
    const secondHome = join(root, "ambient-home-two");
    const profile = definition("isolated");
    await mkdir(join(root, "harness-profiles", profile.id), { mode: 0o700, recursive: true });
    await writeFile(
      join(root, "harness-profiles", profile.id, "profile.json"),
      JSON.stringify({ authenticationEpoch: 1, stateId: "one" }),
    );

    const inFirst = await prepareHarnessProviderState(profile, ambientOptions(root, firstHome));
    const inSecond = await prepareHarnessProviderState(profile, ambientOptions(root, secondHome));

    expect(inFirst.supersededContinuationKeys).toEqual(["test:profile-state:one:auth:1"]);
    // A relocated ambient home is a different physical store, so it must not
    // publish the identity the conversations in the previous home answer to.
    expect(inSecond.providerState.continuationKey).not.toBe(inFirst.providerState.continuationKey);
    expect(inSecond.supersededContinuationKeys).toEqual([]);

    const backInFirst = await prepareHarnessProviderState(profile, ambientOptions(root, firstHome));
    expect(backInFirst.providerState.continuationKey).toBe(inFirst.providerState.continuationKey);
    expect(backInFirst.supersededContinuationKeys).toEqual(["test:profile-state:one:auth:1"]);
    await expect(stat(ambientMetadataPath(root, firstHome))).resolves.toBeDefined();
    await expect(stat(ambientMetadataPath(root, secondHome))).resolves.toBeDefined();
  });

  it("keeps one record for a service store whatever the environment names", async () => {
    const root = await temporaryRoot();
    const profile = definition("isolated");
    const options = sharedOptions(root, isolatedServiceHarnessRuntimeBoundary);
    const first = await prepareHarnessProviderState(profile, options);
    const second = await prepareHarnessProviderState(profile, {
      ...options,
      environment: { TEST_HOME: join(root, "unused-home") },
    });

    // The Runner owns this store, so its record identifies it and no ambient
    // home the environment happens to name can split or move it.
    expect(second.providerState.continuationKey).toBe(first.providerState.continuationKey);
    expect(second.providerState.store.directory).toBe(
      join(root, "harness-stores", "test", "store"),
    );
    await expect(stat(storeMetadataPath(root))).resolves.toBeDefined();
    await expect(stat(join(root, "harness-stores", "test", "ambient"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects ambient provider state on an isolated service", async () => {
    const root = await temporaryRoot();
    await expect(
      prepareHarnessProviderState(
        definition("ambient"),
        sharedOptions(root, isolatedServiceHarnessRuntimeBoundary),
      ),
    ).rejects.toThrow("require a native-user Runner");
  });

  it("adopts a legacy per-profile identity into the store it joins", async () => {
    const root = await temporaryRoot();
    const legacy = definition("isolated");
    const other = definition("isolated");
    const options = sharedOptions(root, isolatedServiceHarnessRuntimeBoundary);
    const legacyMetadata = join(root, "harness-profiles", legacy.id, "profile.json");
    await mkdir(join(root, "harness-profiles", legacy.id), { mode: 0o700, recursive: true });
    await writeFile(
      legacyMetadata,
      JSON.stringify({ authenticationEpoch: 2, lastAccountFingerprint: "a", stateId: "abc" }),
    );

    const adopted = await prepareHarnessProviderState(legacy, options);
    expect(adopted.supersededContinuationKeys).toEqual(["test:profile-state:abc:auth:2"]);
    await expect(stat(legacyMetadata)).rejects.toMatchObject({ code: "ENOENT" });

    // Adoption is recorded once and published by every profile on the store, so
    // a Host can migrate the Threads no matter which profile it hears about.
    const again = await prepareHarnessProviderState(legacy, options);
    expect(again.supersededContinuationKeys).toEqual(["test:profile-state:abc:auth:2"]);
    const sibling = await prepareHarnessProviderState(other, options);
    expect(sibling.supersededContinuationKeys).toEqual(["test:profile-state:abc:auth:2"]);
  });

  it("keeps a legacy profile record until the store durably owns its key", async () => {
    const root = await temporaryRoot();
    const options = sharedOptions(root, isolatedServiceHarnessRuntimeBoundary);
    const legacy = definition("isolated");
    const legacyMetadata = join(root, "harness-profiles", legacy.id, "profile.json");
    await mkdir(join(root, "harness-profiles", legacy.id), { mode: 0o700, recursive: true });
    await writeFile(legacyMetadata, JSON.stringify({ authenticationEpoch: 0, stateId: "late" }));
    // A store already holding every key it may carry cannot adopt another
    // profile, and the profile's own record must survive so nothing is lost.
    await mkdir(join(root, "harness-stores", "test"), { mode: 0o700, recursive: true });
    await writeFile(
      storeMetadataPath(root),
      JSON.stringify({
        id: "full",
        supersededKeys: Array.from({ length: 256 }, (_, index) => `test:profile-state:${index}`),
      }),
    );

    await expect(prepareHarnessProviderState(legacy, options)).rejects.toThrow(
      "cannot adopt any more legacy profiles",
    );
    await expect(stat(legacyMetadata)).resolves.toBeDefined();
  });

  it("removes an isolated profile on a native-user Runner without touching the CLI home", async () => {
    const root = await temporaryRoot();
    const ambientHome = join(root, "ambient-codex-home");
    const profile = definition("isolated");
    const options = ambientOptions(root, ambientHome);
    const { providerState } = await prepareHarnessProviderState(profile, options);
    const rollout = join(ambientHome, "sessions", "2026", "09", "rollout.jsonl");
    await mkdir(join(ambientHome, "sessions", "2026", "09"), { recursive: true });
    await writeFile(rollout, "kept\n");
    await writeFile(join(ambientHome, "auth.json"), "{}\n");
    await symlinkStoreEntry(providerState.providerHomeDirectory ?? "", ambientHome);

    await removeHarnessProviderState(profile, options);

    await expect(stat(join(root, "harness-profiles", profile.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(rollout, "utf8")).toBe("kept\n");
    await expect(stat(join(ambientHome, "auth.json"))).resolves.toBeDefined();
  });

  it("refuses a relative ambient home rather than guessing which directory it names", async () => {
    const root = await temporaryRoot();
    const options = {
      ...sharedOptions(root, nativeUserHarnessRuntimeBoundary),
      environment: { TEST_HOME: "relative/home" },
    };
    await expect(prepareHarnessProviderState(definition("ambient"), options)).rejects.toThrow(
      "TEST_HOME must be an absolute path",
    );
  });

  it("removes one profile without reaching into the store behind its symlinks", async () => {
    const root = await temporaryRoot();
    const retained = definition("isolated");
    const removed = definition("isolated");
    const options = sharedOptions(root, isolatedServiceHarnessRuntimeBoundary);
    const { providerState: retainedState } = await prepareHarnessProviderState(retained, options);
    const { providerState: removedState } = await prepareHarnessProviderState(removed, options);
    const rollout = join(removedState.store.directory, "sessions", "2026", "09", "rollout.jsonl");
    await mkdir(join(removedState.store.directory, "sessions", "2026", "09"), { recursive: true });
    await writeFile(rollout, "kept\n");
    await symlinkStoreEntry(removedState.providerHomeDirectory ?? "", removedState.store.directory);

    expect(await existingIsolatedHarnessProviderState(removed, options)).toBeDefined();
    await removeHarnessProviderState(removed, options);

    await expect(stat(join(root, "harness-profiles", retained.id))).resolves.toBeDefined();
    await expect(stat(join(root, "harness-profiles", removed.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The shared store is what every other profile resumes through.
    expect(await readFile(rollout, "utf8")).toBe("kept\n");
    expect(retainedState.privateStateRoot).toBe(dirname(root));
    await expect(stat(storeMetadataPath(root))).resolves.toBeDefined();
  });

  it("deletes a profile-scoped store with the profile that owned it", async () => {
    const root = await temporaryRoot();
    const profile = definition("isolated");
    const options = profileOptions(root, isolatedServiceHarnessRuntimeBoundary);
    await prepareHarnessProviderState(profile, options);
    await removeHarnessProviderState(profile, options);

    await expect(
      stat(join(root, "harness-stores", "test", "profiles", profile.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a profile whose store metadata never landed removable", async () => {
    const root = await temporaryRoot();
    const profile = definition("isolated");
    const options = sharedOptions(root, isolatedServiceHarnessRuntimeBoundary);
    await prepareHarnessProviderState(profile, options);
    // A process that died between the mkdir and the first metadata write.
    await rm(storeMetadataPath(root), { force: true });

    const state = await existingIsolatedHarnessProviderState(profile, options);
    expect(state).toMatchObject({
      continuationKey: expect.stringContaining("unidentified"),
      providerHomeDirectory: join(root, "harness-profiles", profile.id, "provider-home"),
    });
    await removeHarnessProviderState(profile, options);
    await expect(stat(join(root, "harness-profiles", profile.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes an ambient record without touching the machine's own CLI state", async () => {
    const root = await temporaryRoot();
    const ambientHome = join(root, "ambient-codex-home");
    const profile = definition("ambient");
    const options = ambientOptions(root, ambientHome);
    const { providerState } = await prepareHarnessProviderState(profile, options);
    // The CLI home is the person's own; Opensteer never creates it for them.
    await expect(stat(ambientHome)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(ambientHome, { recursive: true });
    await writeFile(join(ambientHome, "auth.json"), "{}\n");

    expect(providerState.providerHomeDirectory).toBeUndefined();
    await removeHarnessProviderState(profile, options);
    await expect(stat(join(root, "harness-profiles", profile.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(ambientHome, "auth.json"))).resolves.toBeDefined();
  });
});

/** The overlay the Codex driver materializes, reproduced for the removal test. */
async function symlinkStoreEntry(providerHome: string, store: string): Promise<void> {
  await symlink(join(store, "sessions"), join(providerHome, "sessions"));
  expect(await readlink(join(providerHome, "sessions"))).toBe(join(store, "sessions"));
}

function storeMetadataPath(root: string): string {
  return join(root, "harness-stores", "test", "metadata.json");
}

/** Pins the layout: a person-owned store's record is selected by its directory. */
function ambientMetadataPath(root: string, storeDirectory: string): string {
  const key = createHash("sha256").update(storeDirectory).digest("hex").slice(0, 16);
  return join(root, "harness-stores", "test", "ambient", key, "metadata.json");
}

function ambientOptions(root: string, ambientHome: string): HarnessProviderStateOptions {
  return {
    ...sharedOptions(root, nativeUserHarnessRuntimeBoundary),
    environment: { TEST_HOME: ambientHome },
  };
}

function sharedOptions(
  root: string,
  runtimeBoundary: HarnessRuntimeBoundary,
): HarnessProviderStateOptions {
  return {
    environment: {},
    // The Runner's data directory is one level above the state layout it holds.
    privateStateRoot: dirname(root),
    runtimeBoundary,
    stateDirectory: root,
    storeScope: sharedScope,
  };
}

function profileOptions(
  root: string,
  runtimeBoundary: HarnessRuntimeBoundary,
): HarnessProviderStateOptions {
  return {
    environment: {},
    privateStateRoot: dirname(root),
    runtimeBoundary,
    stateDirectory: root,
    storeScope: profileHarnessProviderStoreScope,
  };
}

function definition(stateKind: "ambient" | "isolated"): HarnessInstanceDefinition {
  return {
    config: {},
    driverKind: HarnessIdSchema.parse("test"),
    id: createId("harnessInstance"),
    name: "Test",
    runtimeRevision: 1,
    sourceId: "test",
    stateKind,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opensteer-harness-profile-test-"));
  temporaryDirectories.push(root);
  return root;
}
