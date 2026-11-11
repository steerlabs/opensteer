import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { createId, HarnessIdSchema, ThreadAccessModeSchema } from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  type RunnerDescriptor,
  type RunnerModuleName,
} from "@opensteer/protocol";
import type { OpensteerStore } from "./store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  ModelSelectionSchema,
  type HarnessInstanceId,
  type RunId,
  type ThreadId,
  type TaskFolder,
} from "@opensteer/core";
import type { PendingAgentEvent } from "@opensteer/protocol";
import { createDatabase } from "./connection.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";

export const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
export const testModelSelection = ModelSelectionSchema.parse({
  providerId: "openai",
  modelId: "fixture",
  options: {},
});
export const testContinuationIdentity = {
  driverKind: "native",
  continuationKey: "fixture",
  providerId: "openai",
  stateKind: "ambient",
} as const;

export interface PersonalRunFixturePort {
  createTask(input: {
    readonly ownerId: string;
    readonly folder: TaskFolder;
    readonly suffix: string;
  }): Promise<{ readonly threadId: ThreadId }>;
  startTask(threadId: ThreadId, text: string): Promise<{ readonly runId: RunId }>;
}
export async function createStoreFixture() {
  const clone = await cloneTestDatabase("host");
  try {
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({
        connectionString: clone.url,
        applicationName: "opensteer-integration-test",
        maxConnections: 6,
      });
      return { database, close: () => database.destroy() };
    });
    const { OpensteerStore } = await import("./store.js");
    const store = new OpensteerStore(database);
    async function createRunFixture(suffix: string, admission?: PersonalRunFixturePort) {
      if (!admission)
        throw new Error("Run fixtures require lane P's personal task admission implementation");
      const directory = await mkdtemp(join(tmpdir(), "opensteer-personal-fixture-"));
      await ownTestDatabaseProducer(clone.url, async () => ({
        close: () => rm(directory, { recursive: true, force: true }),
      }));
      const personal = await seedPersonalFixture(database, directory);
      const task = await admission.createTask({
        ownerId: personal.userId,
        folder: personal.agentHome,
        suffix,
      });
      return {
        ...personal,
        ...task,
        folder: personal.agentHome,
        close: () => rm(directory, { recursive: true, force: true }),
      };
    }
    async function startRunFixture(suffix: string, admission?: PersonalRunFixturePort) {
      if (!admission)
        throw new Error("Run fixtures require lane P's personal task admission implementation");
      const fixture = await createRunFixture(suffix, admission);
      return { ...fixture, ...(await admission.startTask(fixture.threadId, "Fixture input")) };
    }
    return Object.freeze({
      database,
      databaseUrl: clone.url,
      store,
      createRunFixture,
      startRunFixture,
      close: clone.drop,
    });
  } catch (error) {
    await clone.drop();
    throw error;
  }
}
export type StoreFixture = Awaited<ReturnType<typeof createStoreFixture>>;
const storeTest = it.extend<{ storeFixture: StoreFixture }>({
  storeFixture: async ({ task }, use) => {
    const started = performance.now();
    const fixture = await createStoreFixture();
    recordTestDatabaseSetup(task, started);
    await use(fixture);
  },
});
export function describeStore(name: string, body: (test: typeof storeTest) => void): void {
  describe(name, () => body(storeTest));
}

export function testReadyHarnessCatalog(harnessInstanceId: HarnessInstanceId) {
  return HarnessInstanceCatalogSchema.parse({
    continuationIdentity: testContinuationIdentity,
    driverKind: "native",
    harnessInstanceId,
    models: [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: testModelSelection.modelId,
        options: [],
        providerId: testModelSelection.providerId,
      },
    ],
    status: "ready",
  });
}

export async function enrollTestRunner(
  store: OpensteerStore,
  input: {
    /** What this computer may ever advertise; agents unless a caller says otherwise. */
    readonly allowedModules?: readonly RunnerModuleName[];
    /** Null when the Deployment authored this enrollment for its own Main Runner. */
    readonly createdBy: ReturnType<typeof createId<"user">> | null;
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    /** What this boot advertises; the full agents machine unless a caller says otherwise. */
    readonly modules?: RunnerDescriptor["modules"];
    readonly name: string;
    /** Present when a managed Runner was attached for one person. */
    readonly ownerUserId?: ReturnType<typeof createId<"user">>;
    readonly runnerId: ReturnType<typeof createId<"runner">>;
    readonly runnerKind?: "main" | "local" | "managed";
    readonly tokenSuffix: string;
  },
): Promise<void> {
  if (!(await store.getDeployment())) {
    await store.ensureDeployment({
      canonicalOrigin: "http://127.0.0.1:4310",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { kind: "personal" },
    });
  }
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
  const descriptor: RunnerDescriptor = testRunnerDescriptor({
    environmentId: input.environmentId,
    ...(input.modules ? { modules: input.modules } : {}),
    name: input.name,
    runnerId: input.runnerId,
    runnerKind: input.runnerKind ?? "main",
  });
  const enrollmentTokenHash = `sha256:${createHash("sha256")
    .update(`test-enrollment-${input.tokenSuffix}`, "utf8")
    .digest("base64url")}`;
  await store.createRunnerEnrollment({
    allowedModules: input.allowedModules ?? ["agents"],
    createdBy: input.createdBy,
    expiresAt: new Date(Date.now() + 60_000),
    id: `ren_${randomUUID()}`,
    idempotencyKey: `test-runner-${input.tokenSuffix}`,
    name: input.name,
    ...(input.runnerKind && input.runnerKind !== "main"
      ? {}
      : { mainEnrollmentPurpose: "initial" as const }),
    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
    requestFingerprint: `sha256:test-runner-${input.tokenSuffix}`,
    runnerKind: input.runnerKind ?? "main",
    tokenHash: enrollmentTokenHash,
  });
  await store.enrollRunnerConnection({
    descriptor,
    enrollmentTokenHash,
    publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
    publicKeyPem,
  });
}

export function testRunnerDescriptor(input: {
  readonly environmentId: ReturnType<typeof createId<"environment">>;
  /** What this boot advertises; the full agents machine unless a caller says otherwise. */
  readonly modules?: RunnerDescriptor["modules"];
  readonly name: string;
  readonly runnerId: ReturnType<typeof createId<"runner">>;
  readonly runnerKind: "main" | "local" | "managed";
}): RunnerDescriptor {
  return {
    bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
    capabilities: ["filesystem"],
    modules: input.modules ?? {
      agents: {
        environmentIds: [input.environmentId],
        harnessDrivers: [
          {
            accessModes: ThreadAccessModeSchema.options,
            driverKind: HarnessIdSchema.parse("native"),
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
        maxConcurrentRuns: 4,
        providerStateModes: ["isolated"],
      },
    },
    name: input.name,
    runnerId: input.runnerId,
    runnerKind: input.runnerKind,
    runtimeVersion: "test",
  };
}

export function fingerprint(publicKey: KeyObject): string {
  return `sha256:${createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url")}`;
}

export function pendingEvent<T extends PendingAgentEvent>(input: Omit<T, "emittedAt">): T {
  return { ...input, emittedAt: new Date().toISOString() } as T;
}
