import { sql } from "kysely";
import { RunnerRegistry } from "@opensteer/orchestration";
import { createId } from "@opensteer/core";
import {
  describeStore,
  testRunnerDescriptor,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import { OpensteerStore } from "@opensteer/database";
import {
  RunnerDescriptorSchema,
  RunnerCommandSchema,
  type RunnerDescriptor,
  type HostToRunnerMessage,
} from "@opensteer/protocol";
import { generateKeyPairSync, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { legacyExecuteRunFixture } from "./legacy-execution-fixture.test-support.js";
import { RunnerAuthenticator } from "./runner-authenticator.js";
import {
  createRunnerAuthenticationSignature,
  hashRunnerEnrollmentToken,
  runnerPublicKeyFingerprint,
} from "@opensteer/runner-auth";

async function setup(f: StoreFixture, kind: "personal" | "server", model: 1 | 2) {
  await f.store.ensureDeployment({
    canonicalOrigin: "https://team.test",
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    deploymentShape: { kind, defaultWorkspaceBacking: "local-directory" },
  });
  const userId = await f.store.createUser("Operator");
  await f.database
    .updateTable("users")
    .set({ admittedAt: new Date(), instanceRole: "administrator" })
    .where("id", "=", userId)
    .execute();
  await f.database.updateTable("deployments").set({ authorityModelVersion: model }).execute();
  const counts: Record<string, number> = {};
  let phase = "setup";
  const database = f.database.withPlugin({
    transformQuery({ node }) {
      counts[phase] = (counts[phase] ?? 0) + 1;
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const store = new OpensteerStore(database);
  const keys = generateKeyPairSync("ed25519");
  const auth = new RunnerAuthenticator({ store, issuancePrivateKey: keys.privateKey });
  const descriptor = testRunnerDescriptor({
    runnerId: createId("runner"),
    environmentId: createId("environment"),
    name: "Fixed Linux",
    runnerKind: "main",
  });
  descriptor.device = { platform: "linux", form: "server" };
  descriptor.capabilities = [
    ...(model === 2 ? ["project-authority-v1" as const] : []),
    "filesystem",
    "voice-run-v1",
    "browser-profile-create-v1",
  ];
  descriptor.modules = {
    agents: {
      ...descriptor.modules.agents!,
      workspaceBackings: ["local-directory"],
      localStorage: {
        bindings: [],
        storageAuthorityId: createId("storageAuthority"),
        truncated: false,
      },
      computerTool: 1,
      knowledgeSkill: 1,
    },
    shell: {
      platform: "linux",
      fullDiskAccess: false,
      hostPublicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
    },
  };
  const parsed = RunnerDescriptorSchema.parse(descriptor);
  const issue = async () => {
    phase = "issuance";
    return auth.createInitialMainEnrollment({
      allowedModules: ["agents"],
      createdBy: userId,
      idempotencyKey: "operator-computer",
      lifetimeSeconds: 600,
    });
  };
  const admit = async (token: string) => {
    phase = "admission";
    return store.enrollRunnerConnection({
      descriptor: parsed,
      enrollmentTokenHash: hashRunnerEnrollmentToken(token),
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      publicKeyFingerprint: runnerPublicKeyFingerprint(keys.publicKey),
    });
  };
  const reconnect = async (updated: RunnerDescriptor = parsed) => {
    phase = "reconnect";
    return store.authenticateRunnerConnection(updated);
  };
  const listing = async () => {
    phase = "listing";
    return store.listRunners({
      ownerId: userId,
      includeDeployment: true,
      includeOtherOwners: true,
      limit: 100,
    });
  };
  return {
    auth,
    keys,
    store,
    userId,
    descriptor: parsed,
    issue,
    admit,
    reconnect,
    listing,
    counts,
    phase: (value: string) => {
      phase = value;
    },
  };
}
function normalized(value: unknown) {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) =>
      key === "publicKeyPem"
        ? "<public-key>"
        : key === "publicKeyFingerprint"
          ? "<fingerprint>"
          : item,
    )
      .replace(
        /(?:[a-z]+_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu,
        (id) => {
          if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`);
          return ids.get(id)!;
        },
      )
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/gu, "<time>"),
  );
}

describeStore("fixed team computer authority", (it) => {
  for (const kind of ["personal", "server"] as const)
    it(`matches untouched main grants, listings and query counts on ${kind} model 1`, async ({
      storeFixture,
    }) => {
      const f = await setup(storeFixture, kind, 1);
      const issued = await f.issue();
      f.phase("pending");
      const pending = await f.store.listPendingRunnerEnrollments({
        ownerId: f.userId,
        includeDeployment: true,
        limit: 100,
      });
      await f.admit(issued.token);
      await f.reconnect();
      f.phase("module-update");
      await f.store.authenticateRunnerConnection({
        ...f.descriptor,
        modules: {
          ...f.descriptor.modules,
          agents: { ...f.descriptor.modules.agents!, maxConcurrentRuns: 7 },
        },
      });
      const listing = await f.listing();
      f.phase("stored");
      const grants = await storeFixture.database
        .selectFrom("runnerEnrollments")
        .select(["allowedModules", "issuanceModules", "ownerKind", "ownerUserId"])
        .execute();
      const observed = normalized({ pending, listing, grants, counts: f.counts });
      const expected = JSON.parse(
        await readFile(new URL(`./team-computer-${kind}.expected.json`, import.meta.url), "utf8"),
      );
      expect(observed).toEqual(expected);
    });

  it("narrows operator issuance and preserves the fixed grant through admission and reconnect", async ({
    storeFixture,
  }) => {
    const f = await setup(storeFixture, "server", 2);
    const issued = await f.issue();
    expect(
      (
        await f.store.listPendingRunnerEnrollments({
          ownerId: f.userId,
          includeDeployment: true,
          limit: 100,
        })
      )[0]?.allowedModules,
    ).toEqual(["agents", "shell"]);
    const admitted = await f.admit(issued.token);
    expect(admitted.allowedModules).toEqual(["agents", "shell"]);
    expect(admitted.admittedCapabilities).toEqual(["project-authority-v1", "filesystem"]);
    expect(admitted.admittedModules?.agents?.computerTool).toBeUndefined();
    expect(admitted.admittedModules?.agents?.knowledgeSkill).toBeUndefined();
    await f.reconnect();
    const updated = await f.reconnect({
      ...f.descriptor,
      modules: {
        ...f.descriptor.modules,
        agents: { ...f.descriptor.modules.agents!, maxConcurrentRuns: 7 },
      },
    });
    expect(updated.allowedModules).toEqual(["agents", "shell"]);
    expect(updated.admittedModules?.agents?.maxConcurrentRuns).toBe(7);
    expect(
      (
        await storeFixture.database
          .selectFrom("executionEnvironments")
          .select("capabilities")
          .where("runnerId", "=", f.descriptor.runnerId)
          .execute()
      ).map((row) => row.capabilities),
    ).toEqual([["project-authority-v1", "filesystem"]]);
    for (const modules of [{ browser: {} }, { integrations: {} }, { messaging: {} }])
      await expect(
        f.reconnect({
          ...f.descriptor,
          modules: { ...f.descriptor.modules, ...modules },
        } as RunnerDescriptor),
      ).rejects.toMatchObject({ code: "forbidden" });
    for (const device of [
      { platform: "android", form: "phone" },
      { platform: "ios", form: "phone" },
      { platform: "windows", form: "desktop" },
      { platform: "linux", form: "server", app: "opensteer" },
    ] as const)
      await expect(f.reconnect({ ...f.descriptor, device })).rejects.toMatchObject({
        code: "forbidden",
      });
    const rows = await f.listing();
    expect(rows.runners[0]?.allowedModules).toEqual(["agents", "shell"]);
    expect(Object.keys(rows.runners[0]!.moduleDescriptors)).toEqual(["agents", "shell"]);
    expect(rows.runners[0]?.capabilities).toEqual(["project-authority-v1", "filesystem"]);
    expect(await f.store.effectiveMachineOwner(f.descriptor.runnerId)).toBeNull();
    await expect(
      f.auth.createPhoneEnrollment({
        createdBy: f.userId,
        idempotencyKey: "phone",
        lifetimeSeconds: 600,
        name: "Phone",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.createEnrollment({
        createdBy: f.userId,
        idempotencyKey: "member",
        lifetimeSeconds: 600,
        name: "Laptop",
        runnerKind: "local",
        allowedModules: ["agents"],
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    for (const allowedModules of [["browser"], ["integrations"], ["messaging"]] as const)
      await expect(
        f.auth.ensureConfiguredDeploymentEnrollment({
          allowedModules,
          idempotencyKey: allowedModules[0],
          lifetimeSeconds: 600,
          name: "Private service",
          token: "configured-service-token-with-32-characters",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: f.userId,
        ownerUserId: f.userId,
        expiresAt: new Date(Date.now() + 600_000),
        id: "member-managed",
        idempotencyKey: "member-managed",
        name: "Member managed",
        requestFingerprint: "member-managed",
        runnerKind: "managed",
        tokenHash: "member-managed",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const stored = await storeFixture.database
      .selectFrom("runnerEnrollments")
      .select(["allowedModules", "issuanceModules"])
      .where("id", "=", issued.enrollmentId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      allowedModules: ["agents", "shell"],
      issuanceModules: ["agents", "shell"],
    });
    await storeFixture.database
      .updateTable("runners")
      .set({
        device: sql`'{"platform":"linux","form":"server","app":"opensteer"}'::jsonb`,
      })
      .where("id", "=", f.descriptor.runnerId)
      .execute();
    await expect(f.reconnect()).rejects.toMatchObject({ code: "forbidden" });
  });
  it("uses the stored grant for wire readiness, auxiliary doors and dispatch, and pages past bulk foreign devices", async ({
    storeFixture,
  }) => {
    const f = await setup(storeFixture, "server", 2);
    const issued = await f.issue();
    await f.admit(issued.token);
    const challenge = f.auth.issueChallenge();
    const identity = await f.auth.authenticate(challenge, {
      type: "runner.authenticate",
      challengeId: challenge.challengeId,
      proofFormatVersion: 2,
      descriptor: f.descriptor,
      signature: createRunnerAuthenticationSignature(f.keys.privateKey, {
        challenge,
        descriptor: f.descriptor,
      }),
    });
    expect(identity.allowedModules).toEqual(["agents", "shell"]);
    expect(identity.capabilities).toEqual(["project-authority-v1", "filesystem"]);
    expect(identity.modules.agents?.computerTool).toBeUndefined();
    const frames: HostToRunnerMessage[] = [];
    const peer = {
      id: "fixed-computer",
      send: async (message: HostToRunnerMessage) => {
        frames.push(message);
      },
      close: () => undefined,
    };
    const registry = new RunnerRegistry({
      hooks: { authorize: async () => undefined, onEvent: async () => undefined },
    });
    try {
      await registry.register(identity, peer);
      await registry.handle(peer, {
        ...identity.fence,
        type: "runner.executions.attach",
        complete: true,
        executions: [],
      });
      for (const module of ["agents", "shell"] as const)
        await registry.handle(peer, {
          ...identity.fence,
          type: "runner.modules.report",
          modules: [
            { module, readiness: "ready", checkedAt: new Date().toISOString(), detail: null },
          ],
        });
      expect(registry.runnersForModule("agents")).toHaveLength(1);
      for (const module of ["browser", "integrations", "messaging"] as const)
        await expect(
          registry.handle(peer, {
            ...identity.fence,
            type: "runner.modules.report",
            modules: [
              { module, readiness: "ready", checkedAt: new Date().toISOString(), detail: null },
            ],
          }),
        ).rejects.toMatchObject({ code: "forbidden" });
      for (const module of ["browser", "integrations"] as const)
        expect(() => f.auth.issueAuxiliaryTicket(identity, module)).toThrow();
      await expect(
        registry.requestApp(
          identity.environmentIds[0]!,
          {} as Parameters<RunnerRegistry["requestApp"]>[1],
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        registry.voice(
          identity.environmentIds[0]!,
          f.userId,
          {} as Parameters<RunnerRegistry["voice"]>[2],
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        registry.dispatch(
          RunnerCommandSchema.parse({
            ...legacyExecuteRunFixture,
            environmentId: identity.environmentIds[0]!,
          }),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      const sent = frames.length;
      expect(registry.runnersForModule("browser")).toEqual([]);
      expect(frames).toHaveLength(sent);
      const olderDescriptor = {
        ...f.descriptor,
        capabilities: f.descriptor.capabilities.filter((name) => name !== "project-authority-v1"),
      };
      const olderChallenge = f.auth.issueChallenge();
      const older = await f.auth.authenticate(olderChallenge, {
        type: "runner.authenticate",
        challengeId: olderChallenge.challengeId,
        proofFormatVersion: 2,
        descriptor: olderDescriptor,
        signature: createRunnerAuthenticationSignature(f.keys.privateKey, {
          challenge: olderChallenge,
          descriptor: olderDescriptor,
        }),
      });
      const olderPeer = { ...peer, id: "older-computer" };
      await registry.register(older, olderPeer);
      await registry.handle(olderPeer, {
        ...older.fence,
        type: "runner.executions.attach",
        complete: true,
        executions: [],
      });
      await expect(
        registry.dispatch(
          RunnerCommandSchema.parse({
            type: "watch.reconcile.project",
            reconcileGeneration: 1,
            commandId: createId("command"),
            correlationId: "project",
            environmentId: older.environmentIds[0]!,
            desired: [],
          }),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect((await f.listing()).runners.map((item) => item.id)).toEqual([older.runnerId]);
    } finally {
      await registry.close();
    }
    const row = await storeFixture.database
      .selectFrom("runners")
      .selectAll()
      .where("id", "=", f.descriptor.runnerId)
      .executeTakeFirstOrThrow();
    const foreign = Array.from({ length: 32 }, (_, index) => ({
      ...row,
      capabilities: sql<typeof row.capabilities>`${JSON.stringify(row.capabilities)}::jsonb`,
      allowedModules: sql<typeof row.allowedModules>`${JSON.stringify(row.allowedModules)}::jsonb`,
      moduleDescriptors: sql<
        typeof row.moduleDescriptors
      >`${JSON.stringify(row.moduleDescriptors)}::jsonb`,
      accessPolicy: sql<typeof row.accessPolicy>`${JSON.stringify(row.accessPolicy)}::jsonb`,
      device: sql<typeof row.device>`${JSON.stringify(row.device)}::jsonb`,
      id: createId("runner"),
      ownerKind: index % 2 ? ("user" as const) : ("deployment" as const),
      ownerUserId: index % 2 ? f.userId : null,
      kind: index % 2 ? ("local" as const) : ("managed" as const),
      ...(index % 2 === 0
        ? {
            device: sql<
              typeof row.device
            >`${JSON.stringify({ platform: "android", form: "phone" })}::jsonb`,
          }
        : {}),
      enrollmentTokenHash: `sha256:${createHash("sha256").update(`foreign-${index}`).digest("base64url")}`,
      publicKeyFingerprint: `sha256:${createHash("sha256").update(`foreign-key-${index}`).digest("base64url")}`,
    }));
    await storeFixture.database.insertInto("runners").values(foreign).execute();
    const enrollment = await storeFixture.database
      .selectFrom("runnerEnrollments")
      .selectAll()
      .where("id", "=", issued.enrollmentId)
      .executeTakeFirstOrThrow();
    await storeFixture.database
      .insertInto("runnerEnrollments")
      .values(
        Array.from({ length: 32 }, (_, index) => ({
          ...enrollment,
          id: `foreign-enrollment-${index}`,
          idempotencyKey: `foreign-${index}`,
          tokenHash: `foreign-${index}`,
          consumedAt: null,
          runnerId: null,
          runnerKind: "managed" as const,
          allowedModules: sql<typeof enrollment.allowedModules>`'["browser"]'::jsonb`,
          issuanceModules: sql<typeof enrollment.issuanceModules>`'["browser"]'::jsonb`,
        })),
      )
      .execute();
    expect(
      await f.store.listPendingRunnerEnrollments({
        ownerId: f.userId,
        includeDeployment: true,
        limit: 1,
      }),
    ).toEqual([]);
    const page = await f.store.listRunners({
      ownerId: f.userId,
      includeDeployment: true,
      includeOtherOwners: true,
      limit: 1,
    });
    expect(page.runners.map((item) => item.id)).toEqual([row.id]);
    expect(page.nextCursor).toBeNull();
    await expect(f.store.listEligibleBrowserRunners(f.userId)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("serializes two operator admissions without admitting a second active computer", async ({
    storeFixture,
  }) => {
    const f = await setup(storeFixture, "server", 2);
    const candidates = await Promise.all(
      ["one", "two"].map(async (name) => {
        const grant = await f.auth.createEnrollment({
          createdBy: f.userId,
          runnerKind: "managed",
          name,
          allowedModules: ["agents", "browser"],
          idempotencyKey: name,
          lifetimeSeconds: 600,
        });
        const key = generateKeyPairSync("ed25519");
        const descriptor: RunnerDescriptor = {
          ...f.descriptor,
          runnerId: createId("runner"),
          runnerKind: "managed",
          modules: {
            ...f.descriptor.modules,
            agents: { ...f.descriptor.modules.agents!, environmentIds: [createId("environment")] },
          },
        };
        return {
          descriptor,
          enrollmentTokenHash: hashRunnerEnrollmentToken(grant.token),
          publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
          publicKeyFingerprint: runnerPublicKeyFingerprint(key.publicKey),
        };
      }),
    );
    const results = await Promise.allSettled(
      candidates.map((input) => f.store.enrollRunnerConnection(input)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      await storeFixture.database
        .selectFrom("runners")
        .select("id")
        .where("revokedAt", "is", null)
        .execute(),
    ).toHaveLength(1);
  });
});
