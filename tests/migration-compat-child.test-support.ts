import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const [root, phase, authority, url, receipt, control] = z
  .tuple([
    z.string().min(1),
    z.enum(["seed", "migrate", "replay"]),
    z.enum(["host", "controlPlane"]),
    z.url(),
    z.string(),
    z.enum(["", "break-column", "timeout"]),
  ])
  .parse(process.argv.slice(2));
const load = (name: string) => import(pathToFileURL(join(root, name)).href);

async function main(): Promise<void> {
  if (authority === "controlPlane") {
    const {
      createControlPlaneDatabase,
    }: typeof import("../apps/control-plane/src/database/database.js") = await load(
      "apps/control-plane/src/database/database.ts",
    );
    const database = createControlPlaneDatabase({ connectionString: url!, maxConnections: 1 });
    try {
      if (phase === "migrate") {
        const {
          migrateControlPlaneToLatest,
        }: typeof import("../apps/control-plane/src/database/migrations.js") = await load(
          "apps/control-plane/src/database/migrations.ts",
        );
        await migrateControlPlaneToLatest(database);
      } else {
        const { ControlPlaneStore }: typeof import("../apps/control-plane/src/database/store.js") =
          await load("apps/control-plane/src/database/store.ts");
        const store = new ControlPlaneStore(
          database,
          new URL("https://accounts.migration.invalid"),
          { managedDeploymentDomain: "migration.invalid" },
        );
        const core: typeof import("../packages/core/src/index.js") = await load(
          "packages/core/src/index.ts",
        );
        const account: typeof import("../packages/control-plane-protocol/src/index.js") =
          await load("packages/control-plane-protocol/src/index.ts");
        const accountId = account.ControlPlaneAccountIdSchema.parse(
          "acct_00000000-0000-4000-8000-000000000001",
        );
        const deploymentId = core.DeploymentIdSchema.parse(
          "dep_00000000-0000-4000-8000-000000000001",
        );
        const canonicalOrigin = `https://${deploymentId}.migration.invalid`;
        if (phase === "seed") {
          const now = new Date("2026-01-01T00:00:00Z");
          await database
            .insertInto("users")
            .values({
              id: accountId,
              displayName: "Migration Account",
              email: "owner@migration.invalid",
              emailVerified: true,
              image: null,
              createdAt: now,
              updatedAt: now,
            })
            .execute();
          await database.transaction().execute((transaction) =>
            store.provisionManagedDeployment(
              accountId,
              {
                canonicalOrigin,
                deploymentId,
                hostInstanceId: core.HostInstanceIdSchema.parse(
                  "hst_00000000-0000-4000-8000-000000000001",
                ),
                hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
                name: "Migration deployment",
                reachability: "canonical",
              },
              transaction,
            ),
          );
        } else {
          assert.equal(await store.hasActiveDeploymentOrigin(canonicalOrigin), true);
          await store.revokeAccountSessions(accountId);
        }
        // The previous store both inserts and updates its own persisted client.
        await store.ensureOfficialPortalClient({
          clientId: "migration-portal",
          redirectUri: "https://migration.invalid/callback",
          scopes: ["openid", "profile"],
        });
        const client = await database
          .selectFrom("oauthClients")
          .selectAll()
          .where("clientId", "=", "migration-portal")
          .executeTakeFirstOrThrow();
        assert.equal(client.clientId, "migration-portal");
        console.info("PREVIOUS_STORE_READ_WRITE_OK controlPlane");
      }
    } finally {
      await database.destroy();
    }
    return;
  }
  assert.equal(authority, "host");
  const core: typeof import("../packages/core/src/index.js") = await load(
    "packages/core/src/index.ts",
  );
  const protocol: typeof import("../packages/protocol/src/index.js") = await load(
    "packages/protocol/src/index.ts",
  );
  const { createDatabase }: typeof import("../packages/database/src/connection.js") = await load(
    "packages/database/src/connection.ts",
  );
  const database = createDatabase({ connectionString: url!, maxConnections: 1 });
  try {
    if (phase === "migrate") {
      const migrations: typeof import("../packages/database/src/migrations.js") = await load(
        "packages/database/src/migrations.ts",
      );
      if (!control) await migrations.migrateToLatest(database);
      else {
        const {
          migrateWithCompatibilityControl,
        }: typeof import("../packages/database/src/migration-compat-control.test-support.js") =
          await load("packages/database/src/migration-compat-control.test-support.ts");
        await migrateWithCompatibilityControl(database, control, () =>
          writeFile(`${receipt}.control`, control),
        );
      }
      return;
    }
    const { OpensteerStore }: typeof import("../packages/database/src/store.js") = await load(
      "packages/database/src/store.ts",
    );
    const store = new OpensteerStore(database);
    const uuid = "00000000-0000-4000-8000-000000000001";
    const userId = core.UserIdSchema.parse(`usr_${uuid}`);
    const runnerId = core.RunnerIdSchema.parse(`rnr_${uuid}`);
    const environmentId = core.EnvironmentIdSchema.parse(`env_${uuid}`);
    const workspaceId = core.WorkspaceIdSchema.parse(`wsp_${uuid}`);
    const threadId = core.ThreadIdSchema.parse(`thr_${uuid}`);
    const modelSelection = core.ModelSelectionSchema.parse({
      providerId: "openai",
      modelId: "migration-fixture",
      options: {},
    });
    const continuationIdentity = {
      driverKind: core.HarnessIdSchema.parse("native"),
      continuationKey: `runner:v1:${"a".repeat(43)}`,
    };
    if (phase === "seed") {
      await store.ensureDeployment({
        canonicalOrigin: "https://migration.invalid",
        deploymentId: core.DeploymentIdSchema.parse(`dep_${uuid}`),
        hostInstanceId: core.HostInstanceIdSchema.parse(`hst_${uuid}`),
        deploymentShape: { kind: "server", defaultWorkspaceBacking: "portablefs" },
      });
      await store.createUser("Migration fixture owner", userId);
      await store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: userId,
        expiresAt: new Date("2099-01-01"),
        id: `ren_${uuid}`,
        idempotencyKey: "migration-runner",
        name: "Migration runner",
        requestFingerprint: "sha256:migration-fixture",
        runnerKind: "managed",
        tokenHash: "sha256:migration-fixture",
      });
      await store.enrollRunnerConnection({
        descriptor: {
          bootId: protocol.RunnerBootIdSchema.parse(`rbt_${uuid}`),
          capabilities: [],
          name: "Migration runner",
          runnerId,
          runnerKind: "managed",
          runtimeVersion: "migration-fixture",
          modules: {
            agents: {
              environmentIds: [environmentId],
              harnessDrivers: [
                {
                  accessModes: ["full-access"],
                  driverKind: core.HarnessIdSchema.parse("native"),
                  readiness: "configured",
                  steering: true,
                  sources: [
                    {
                      fields: [],
                      kind: "first-party",
                      label: "Native",
                      quota: "none",
                      sourceId: "native",
                      stateKinds: ["isolated"],
                    },
                  ],
                },
              ],
              localStorage: null,
              maxConcurrentRuns: 1,
              providerStateModes: ["isolated"],
              workspaceBackings: ["portablefs"],
              workspaceMounts: [],
            },
          },
        },
        enrollmentTokenHash: "sha256:migration-fixture",
        publicKeyFingerprint: "sha256:migration-fixture",
        publicKeyPem: "migration-fixture-public-key",
      });
      await store.createWorkspace({
        id: workspaceId,
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "migration-fixture",
          volumeId: "migration-fixture",
        },
        capacityPolicy: {
          kind: "hard-quota",
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
        },
        createdBy: userId,
        idempotencyKey: "migration-workspace",
        name: "Migration workspace",
        status: "ready",
      });
      const harness = await store.createHarnessInstance({
        config: {},
        driverKind: core.HarnessIdSchema.parse("native"),
        environmentId,
        name: "Migration engine",
        stateKind: "isolated",
      });
      await store.recordHarnessCatalogs({
        environmentId,
        expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
        catalogs: [
          protocol.HarnessInstanceCatalogSchema.parse({
            continuationIdentity,
            driverKind: core.HarnessIdSchema.parse("native"),
            harnessInstanceId: harness.id,
            models: [
              { displayName: "Migration model", isDefault: true, ...modelSelection, options: [] },
            ],
            status: "ready",
          }),
        ],
      });
      await store.createThread({
        id: threadId,
        createdBy: userId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: "migration-task",
        modelSelection,
        title: "Migration task",
        workspaceId,
      });
      await store.rememberExecutionChoice(userId, {
        accessMode: "full-access",
        selection: { environmentId, harnessInstanceId: harness.id, modelSelection },
      });
      const turn = await store.enqueueThreadInput({
        content: [{ type: "text", text: "Migration representative Run" }],
        idempotencyKey: "migration-input",
        policy: "queue",
        requestedBy: userId,
        source: { kind: "human" },
        threadId,
      });
      assert.ok(turn.command && turn.run);
      await store.claimCommand(turn.command.id, "migration-dispatcher");
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date("2099-01-01"),
        continuationIdentity,
        harnessInstanceId: harness.id,
        leaseTokenHash: "migration-lease",
        membershipGeneration: 1,
        runnerBootId: "migration-boot",
        runnerId,
        runId: turn.run.id,
        threadId,
      });
      await writeFile(receipt!, JSON.stringify({ runId: turn.run.id, grantId: binding.grantId }));
    } else {
      const state = z
        .object({ runId: core.RunIdSchema, grantId: core.GrantIdSchema })
        .parse(JSON.parse(await readFile(receipt!, "utf8")));
      assert.equal((await store.userById(userId))?.displayName, "Migration fixture owner");
      assert.equal((await store.getDeployment())?.canonicalOrigin, "https://migration.invalid");
      assert.equal((await store.getWorkspace(workspaceId))?.name, "Migration workspace");
      assert.ok(await store.readThreadForOwner(threadId, userId));
      assert.equal(await store.runRequester({ runId: state.runId, threadId, workspaceId }), userId);
      assert.equal((await store.runCapabilityScope(state.runId))?.grantId, state.grantId);
      assert.ok(
        (await store.taskPageForUser({ userId })).tasks.some(
          ({ thread }) => thread.id === threadId,
        ),
      );
      assert.equal((await store.getExecutionPreferences(userId)).history.length, 1);
      await store.createUser(
        "Previous store writes after upgrade",
        core.UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000002"),
      );
      await store.renameThread({
        idempotencyKey: "migration-rename",
        requestedBy: userId,
        threadId,
        title: "Updated by previous store",
      });
      assert.equal(
        (await store.readThreadForOwner(threadId, userId))?.thread.title,
        "Updated by previous store",
      );
      await store.rememberExecutionChoice(userId, { accessMode: "approval-required" });
      assert.equal((await store.getExecutionPreferences(userId)).accessMode, "approval-required");
      assert.equal((await store.workspaceSnapshot(workspaceId)).workspace.id, workspaceId);
      console.info(
        "PREVIOUS_STORE_READ_WRITE_OK host: users deployments workspaces threads runs tasks settings grants",
      );
    }
  } finally {
    await database.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  // The bounded process runner retains the diagnostic tail, after long SDK stacks.
  console.error(
    `MIGRATION_COMPAT_ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
