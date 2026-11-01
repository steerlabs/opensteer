import {
  createId,
  HarnessIdSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { HarnessRegistry } from "./registry.js";
import {
  nativeUserHarnessRuntimeBoundary,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessInstanceDefinition,
  type HarnessPreparationContext,
  type HarnessProviderState,
  type HarnessSourceDescriptor,
} from "./types.js";

const driverKind = HarnessIdSchema.parse("inspection-contract-test");
const testSourceId = "inspection-contract-test";
const testSources: readonly HarnessSourceDescriptor[] = [
  {
    fields: [],
    kind: "first-party",
    label: "Inspection contract test",
    quota: "none",
    sourceId: testSourceId,
    stateKinds: ["ambient", "isolated"],
  },
];
const definition = {
  config: {},
  driverKind,
  id: createId("harnessInstance"),
  name: "Inspection contract test",
  runtimeRevision: 1,
  sourceId: testSourceId,
  stateKind: "isolated",
} as const;

describe("HarnessRegistry inspection contract", () => {
  it("owns one preparation across inspections and caller cancellation", async () => {
    const registry = new HarnessRegistry();
    let finish!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prepare = vi.fn(async (_context: HarnessPreparationContext) => prepared);
    const inspectDriver = vi.fn(async () => ({ models: [model], status: "ready" as const }));
    registry.registerDriver(driver({ inspect: inspectDriver, prepare }));
    registry.configureInstance(definition);
    const caller = new AbortController();

    await expect(inspect(registry, definition, caller.signal)).resolves.toEqual({
      detail: `Preparing ${definition.name}…`,
      status: "preparing",
    });
    caller.abort();
    await expect(inspect(registry)).resolves.toMatchObject({ status: "preparing" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0].signal.aborted).toBe(false);
    expect(inspectDriver).not.toHaveBeenCalled();

    finish();
    await prepared;
    await nextTask();
    await expect(inspect(registry)).resolves.toMatchObject({ status: "ready" });
    expect(inspectDriver).toHaveBeenCalledTimes(1);
  });

  it("shares driver-keyed preparation across accounts without one account cancelling it", async () => {
    const registry = new HarnessRegistry();
    let finish!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prepare = vi.fn(async ({ signal }: HarnessPreparationContext) => {
      expect(signal.aborted).toBe(false);
      await prepared;
    });
    registry.registerDriver(
      driver({
        inspect: async () => ({ models: [model], status: "ready" }),
        preparationKey: () => "shared-release",
        prepare,
      }),
    );
    const second = { ...definition, id: createId("harnessInstance"), name: "Second account" };
    registry.configureInstance(definition);
    registry.configureInstance(second);

    await expect(inspect(registry, definition)).resolves.toMatchObject({ status: "preparing" });
    await expect(inspect(registry, second)).resolves.toMatchObject({ status: "preparing" });
    expect(prepare).toHaveBeenCalledTimes(1);

    await registry.removeInstance(definition.id);
    expect(prepare.mock.calls[0]?.[0].signal.aborted).toBe(false);
    finish();
    await prepared;
    await nextTask();
    await expect(inspect(registry, second)).resolves.toMatchObject({ status: "ready" });
  });

  it("notifies subscribers once for current preparation and cleans subscriptions up", async () => {
    const registry = new HarnessRegistry();
    const releases: Array<() => void> = [];
    registry.registerDriver(
      driver({
        inspect: async () => ({ models: [model], status: "ready" }),
        prepare: async () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      }),
    );
    registry.configureInstance(definition);
    const settled: string[] = [];
    registry.subscribePreparations(() => {
      throw new Error("broken preparation observer");
    });
    const unsubscribe = registry.subscribePreparations((instanceId) => {
      settled.push(instanceId);
    });

    await inspect(registry);
    await nextTask();
    releases[0]?.();
    await nextTask();
    expect(settled).toEqual([definition.id]);

    unsubscribe();
    await inspect(registry, definition, new AbortController().signal, testProviderState, {
      TEST_LOCATION: "relocated",
    });
    await nextTask();
    releases[1]?.();
    await nextTask();
    expect(settled).toEqual([definition.id]);

    await registry.close();
    expect(() => registry.subscribePreparations(() => undefined)).toThrow("registry is closed");
  });

  it("reuses partial-inspection preparation without changing the configured definition", async () => {
    const registry = new HarnessRegistry();
    let finish!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finish = resolve;
    });
    registry.registerDriver(
      driver({
        create: async ({ instanceId }) => adapter(instanceId, () => undefined),
        inspect: async () => ({ models: [model], status: "ready" }),
        prepare: async () => prepared,
      }),
    );

    await inspect(registry);
    expect(registry.state(definition.id)).toBeUndefined();
    registry.configureInstance(definition);
    finish();
    await prepared;
    await nextTask();
    await expect(inspect(registry)).resolves.toMatchObject({ status: "ready" });
    expect(registry.state(definition.id)?.definition).toEqual(definition);
    await expect(registry.adapter(definition.id)).resolves.toMatchObject({
      instanceId: definition.id,
    });
  });

  it("drains preparation before starting the same profile with relocated inputs", async () => {
    const registry = new HarnessRegistry();
    const lifecycle: string[] = [];
    let releaseSecond!: () => void;
    const implementation = driver({
      inspect: async () => ({ models: [model], status: "ready" }),
      prepare: async function ({ environment, signal }) {
        expect(this).toBe(implementation);
        const location = environment.TEST_LOCATION;
        lifecycle.push(`start:${location}`);
        await new Promise<void>((resolve) => {
          if (location !== "first") {
            releaseSecond = resolve;
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              lifecycle.push("abort:first");
              resolve();
            },
            { once: true },
          );
        });
        lifecycle.push("cleanup:first");
      },
    });
    registry.registerDriver(implementation);
    registry.configureInstance(definition);
    const settled: string[] = [];
    registry.subscribePreparations((instanceId) => settled.push(instanceId));

    await inspect(registry, definition, new AbortController().signal, testProviderState, {
      TEST_LOCATION: "first",
    });
    await nextTask();
    await expect(
      inspect(registry, definition, new AbortController().signal, testProviderState, {
        TEST_LOCATION: "second",
      }),
    ).resolves.toMatchObject({ status: "preparing" });
    expect(lifecycle).toEqual(["start:first", "abort:first", "cleanup:first", "start:second"]);
    expect(settled).toEqual([]);
    releaseSecond();
    await nextTask();
    expect(settled).toEqual([definition.id]);
  });

  it("does not let stale inspection or shutdown start preparation", async () => {
    const registry = new HarnessRegistry();
    const prepare = vi.fn(async () => undefined);
    registry.registerDriver(
      driver({ inspect: async () => ({ models: [model], status: "ready" }), prepare }),
    );
    const current = { ...definition, runtimeRevision: 2 };
    registry.configureInstance(current);

    await expect(inspect(registry, definition)).rejects.toMatchObject({ code: "conflict" });
    expect(prepare).not.toHaveBeenCalled();
    await registry.close();
    await expect(inspect(registry, current)).rejects.toMatchObject({ code: "conflict" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("surfaces a preparation failure once and retries on the next inspection", async () => {
    const registry = new HarnessRegistry();
    let attempts = 0;
    registry.registerDriver(
      driver({
        inspect: async () => ({ models: [model], status: "ready" }),
        prepare: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("cold preparation failed");
        },
      }),
    );

    await expect(inspect(registry)).resolves.toMatchObject({ status: "preparing" });
    await Promise.resolve();
    await expect(inspect(registry)).rejects.toThrow("cold preparation failed");
    await expect(inspect(registry)).resolves.toMatchObject({ status: "preparing" });
    await Promise.resolve();
    await expect(inspect(registry)).resolves.toMatchObject({ status: "ready" });
    expect(attempts).toBe(2);
  });

  it("starts preparation from authentication but gates the sign-in until it completes", async () => {
    const registry = new HarnessRegistry();
    let finish!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const authenticateDriver = vi.fn(async () => ({ status: "ready" as const }));
    registry.registerDriver(
      driver({ authenticate: authenticateDriver, prepare: async () => prepared }),
    );

    await expect(
      authenticate(registry, { connectionSlot: "primary", methodId: "test" }),
    ).rejects.toMatchObject({ code: "conflict", retryable: true });
    expect(authenticateDriver).not.toHaveBeenCalled();
    finish();
    await prepared;
    await nextTask();
    await expect(
      authenticate(registry, { connectionSlot: "primary", methodId: "test" }),
    ).resolves.toEqual({ status: "ready" });
  });

  it("returns expected installation and configuration conditions as unavailable data", async () => {
    const missing = new HarnessRegistry();
    await expect(inspect(missing)).resolves.toEqual({
      detail: `Harness driver ${driverKind} is not installed`,
      status: "unavailable",
    });

    const invalid = new HarnessRegistry();
    invalid.registerDriver(driver({ configSchema: z.strictObject({ required: z.string() }) }));
    await expect(inspect(invalid)).resolves.toMatchObject({ status: "unavailable" });

    const empty = new HarnessRegistry();
    empty.registerDriver(
      driver({
        inspect: async () => ({ models: [], status: "ready" }),
      }),
    );
    await expect(inspect(empty)).resolves.toEqual({
      detail: `Harness ${definition.name} did not report any available models`,
      status: "unavailable",
    });
  });

  it("accepts sign-in performed outside the Runner without a managed authentication action", async () => {
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver({
        inspect: async () => ({ detail: "Sign in", status: "authentication-required" }),
      }),
    );

    await expect(inspect(registry)).resolves.toEqual({
      detail: "Sign in",
      status: "authentication-required",
    });
  });

  it("requires an authentication handler for advertised managed setup methods", async () => {
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver({
        inspect: async () => ({
          detail: "Sign in",
          setupMethods: [
            { methodId: "key", label: "API key", inputLabel: "API key", kind: "secret-input" },
          ],
          status: "authentication-required",
        }),
      }),
    );
    await expect(inspect(registry)).rejects.toMatchObject({ code: "harness_error" });
  });

  it("accepts an authentication-required result from a driver with a setup action", async () => {
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver({
        authenticate: async () => ({ status: "ready" }),
        inspect: async () => ({ detail: "Sign in", status: "authentication-required" }),
      }),
    );

    await expect(inspect(registry)).resolves.toEqual({
      detail: "Sign in",
      status: "authentication-required",
    });
  });

  it("keeps setup methods distinct for two connection slots in one multiplexing profile", async () => {
    const registry = new HarnessRegistry();
    const selections: Array<{ connectionSlot?: string; methodId: string }> = [];
    registry.registerDriver(
      driver({
        authenticate: async (_context, selection) => {
          selections.push(selection);
          return { status: "ready" };
        },
        inspect: async () => ({
          connections: [
            {
              accountLabel: "team@openrouter.example",
              billingLabel: "OpenRouter credits",
              connectionSlot: "openrouter",
              label: "OpenRouter",
              status: "connected",
            },
            {
              billingLabel: "OpenCode Go subscription",
              connectionSlot: "go",
              label: "OpenCode Go",
              status: "authentication-required",
            },
          ],
          detail: "Connect an account",
          setupMethods: [
            {
              connectionSlot: "openrouter",
              inputLabel: "OpenRouter API key",
              kind: "secret-input",
              label: "OpenRouter API key",
              methodId: "openrouter-api-key",
            },
            {
              connectionSlot: "go",
              inputLabel: "OpenCode Go API key",
              kind: "secret-input",
              label: "OpenCode Go API key",
              methodId: "go-api-key",
            },
          ],
          status: "authentication-required",
        }),
      }),
    );

    await expect(inspect(registry)).resolves.toMatchObject({
      connections: [
        { connectionSlot: "openrouter", status: "connected" },
        { connectionSlot: "go", status: "authentication-required" },
      ],
      setupMethods: [
        { connectionSlot: "openrouter", methodId: "openrouter-api-key" },
        { connectionSlot: "go", methodId: "go-api-key" },
      ],
    });
    await authenticate(registry, { connectionSlot: "openrouter", methodId: "openrouter-api-key" });
    await authenticate(registry, { connectionSlot: "go", methodId: "go-api-key" });
    expect(selections).toEqual([
      { connectionSlot: "openrouter", methodId: "openrouter-api-key" },
      { connectionSlot: "go", methodId: "go-api-key" },
    ]);
  });

  it("projects only the environment variables declared by a driver", () => {
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver({ environmentVariables: ["TEST_PROVIDER_HOME", "TEST_PROVIDER_HOME"] }),
    );

    expect(registry.environmentVariables(driverKind)).toEqual(["TEST_PROVIDER_HOME"]);
    expect(() =>
      new HarnessRegistry().registerDriver(driver({ environmentVariables: ["invalid-name"] })),
    ).toThrow(/environment variable name/u);
  });
});

describe("HarnessRegistry instance reconciliation", () => {
  it("cancels and drains superseded preparation before the replacement can prepare", async () => {
    const registry = new HarnessRegistry();
    const lifecycle: string[] = [];
    let releaseFirst!: () => void;
    registry.registerDriver(
      driver({
        configSchema: z.strictObject({ revision: z.number().int() }),
        inspect: async () => ({ models: [model], status: "ready" }),
        prepare: async ({ config, signal }) => {
          const revision = (config as { revision: number }).revision;
          lifecycle.push(`prepare:${revision}`);
          if (revision !== 1) return;
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
            signal.addEventListener(
              "abort",
              () => {
                lifecycle.push("abort:1");
                resolve();
              },
              { once: true },
            );
          });
          lifecycle.push("cleanup:1");
        },
      }),
    );
    const first = { ...definition, config: { revision: 1 }, runtimeRevision: 1 };
    const second = { ...first, config: { revision: 2 }, runtimeRevision: 2 };
    registry.configureInstance(first);
    await inspect(registry, first);
    await Promise.resolve();

    await registry.upsertInstance(second);
    expect(lifecycle).toEqual(["prepare:1", "abort:1", "cleanup:1"]);
    await expect(inspect(registry, second)).resolves.toMatchObject({ status: "preparing" });
    await Promise.resolve();
    await expect(inspect(registry, second)).resolves.toMatchObject({ status: "ready" });
    expect(lifecycle).toEqual(["prepare:1", "abort:1", "cleanup:1", "prepare:2"]);
    releaseFirst();
  });

  it("gates adapter creation while a configured instance is preparing", async () => {
    const registry = new HarnessRegistry();
    let finish!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finish = resolve;
    });
    registry.registerDriver(
      driver({
        create: async ({ instanceId }) => adapter(instanceId, () => undefined),
        inspect: async () => ({ models: [model], status: "ready" }),
        prepare: async () => prepared,
      }),
    );
    registry.configureInstance(definition);
    await inspect(registry);

    await expect(registry.adapter(definition.id)).rejects.toMatchObject({
      code: "conflict",
      retryable: true,
    });
    finish();
    await withTimeout(prepared, 2_000, {
      timeoutError: () => new Error("Timed out completing harness preparation"),
    });
    await nextTask();
    await expect(registry.adapter(definition.id)).resolves.toMatchObject({
      instanceId: definition.id,
    });
  });

  it("retains adapters for presentation changes and recreates runtime changes close-first", async () => {
    const registry = new HarnessRegistry();
    const lifecycle: string[] = [];
    registry.registerDriver(
      driver({
        configSchema: z.strictObject({ revision: z.number().int() }),
        create: async ({ config, instanceId }) => {
          const revision = (config as { revision: number }).revision;
          lifecycle.push(`create:${revision}`);
          return adapter(instanceId, () => lifecycle.push(`close:${revision}`));
        },
      }),
    );
    const instanceId = createId("harnessInstance");

    await registry.upsertInstance({
      config: { revision: 1 },
      driverKind,
      id: instanceId,
      name: "Personal",
      runtimeRevision: 1,
      sourceId: testSourceId,
      stateKind: "isolated",
    });
    const first = await registry.adapter(instanceId);
    await registry.upsertInstance({
      config: { revision: 1 },
      driverKind,
      id: instanceId,
      name: "Renamed",
      runtimeRevision: 1,
      sourceId: testSourceId,
      stateKind: "isolated",
    });
    expect(await registry.adapter(instanceId)).toBe(first);

    await expect(
      registry.upsertInstance({
        config: { revision: 2 },
        driverKind,
        id: instanceId,
        name: "Invalid same-revision change",
        runtimeRevision: 1,
        sourceId: testSourceId,
        stateKind: "isolated",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await registry.upsertInstance({
      config: { revision: 2 },
      driverKind,
      id: instanceId,
      name: "Renamed",
      runtimeRevision: 2,
      sourceId: testSourceId,
      stateKind: "isolated",
    });
    const second = await registry.adapter(instanceId);
    expect(second).not.toBe(first);
    expect(lifecycle).toEqual(["create:1", "close:1", "create:2"]);
    await expect(
      registry.upsertInstance({
        config: { revision: 1 },
        driverKind,
        id: instanceId,
        name: "Stale",
        runtimeRevision: 1,
        sourceId: testSourceId,
        stateKind: "isolated",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("removes absent instances and retries adapter creation", async () => {
    const registry = new HarnessRegistry();
    const closed: string[] = [];
    let attempts = 0;
    registry.registerDriver(
      driver({
        create: async ({ instanceId }) => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient start failure");
          return adapter(instanceId, () => closed.push(instanceId));
        },
      }),
    );
    const firstId = createId("harnessInstance");
    const secondId = createId("harnessInstance");
    const first = {
      config: {},
      driverKind,
      id: firstId,
      name: "First",
      runtimeRevision: 1,
      sourceId: testSourceId,
      stateKind: "isolated",
    } as const;
    const second = {
      config: {},
      driverKind,
      id: secondId,
      name: "Second",
      runtimeRevision: 1,
      sourceId: testSourceId,
      stateKind: "isolated",
    } as const;

    await registry.reconcileInstances([first, second]);
    await expect(registry.adapter(firstId)).rejects.toThrow("transient start failure");
    await expect(registry.adapter(firstId)).resolves.toMatchObject({ instanceId: firstId });
    await registry.adapter(secondId);

    await registry.reconcileInstances([second]);
    expect(registry.listInstances().map(({ definition }) => definition.id)).toEqual([secondId]);
    expect(registry.state(firstId)).toBeUndefined();
    expect(closed).toContain(firstId);
    await registry.reconcileInstances([]);
    expect(registry.listInstances()).toEqual([]);
    expect(closed).toContain(secondId);
  });

  it("isolates one refused definition instead of poisoning the rest of the set", async () => {
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver({
        create: async ({ instanceId }) => adapter(instanceId, () => undefined),
      }),
    );
    const poisonId = createId("harnessInstance");
    const healthyId = createId("harnessInstance");
    const poison = {
      config: {},
      driverKind,
      id: poisonId,
      name: "Poison",
      runtimeRevision: 2,
      sourceId: testSourceId,
      stateKind: "isolated",
    } as const;
    const healthy = {
      config: {},
      driverKind,
      id: healthyId,
      name: "Healthy",
      runtimeRevision: 1,
      sourceId: testSourceId,
      stateKind: "isolated",
    } as const;

    await registry.reconcileInstances([poison, healthy]);
    await registry.adapter(healthyId);

    // A Host database rollback replays an older revision for one profile only.
    const states = await registry.reconcileInstances([
      { ...poison, runtimeRevision: 1 },
      { ...healthy, name: "Healthy renamed" },
    ]);

    expect(states).toHaveLength(2);
    expect(registry.state(poisonId)).toMatchObject({
      reason: expect.stringContaining("stale runtime revision"),
      status: "unavailable",
    });
    expect(registry.state(healthyId)).toMatchObject({
      definition: { name: "Healthy renamed" },
      status: "available",
    });
    await expect(registry.adapter(healthyId)).resolves.toMatchObject({ instanceId: healthyId });
    await expect(registry.adapter(poisonId)).rejects.toMatchObject({ code: "harness_error" });
  });

  it("retires a replaced entry before its adapter closes so no run can revive it", async () => {
    const registry = new HarnessRegistry();
    const lifecycle: string[] = [];
    let releaseClose!: () => void;
    const closed = new Promise<void>((resolvePromise) => {
      releaseClose = resolvePromise;
    });
    registry.registerDriver(
      driver({
        configSchema: z.strictObject({ revision: z.number().int() }),
        create: async ({ config, instanceId }) => {
          const revision = (config as { revision: number }).revision;
          lifecycle.push(`create:${revision}`);
          return adapter(instanceId, () => {
            lifecycle.push(`close:${revision}`);
            return revision === 1 ? closed : undefined;
          });
        },
      }),
    );
    const instanceId = createId("harnessInstance");
    const base = {
      driverKind,
      id: instanceId,
      name: "Serialized",
      sourceId: testSourceId,
      stateKind: "isolated",
    } as const;

    await registry.upsertInstance({ ...base, config: { revision: 1 }, runtimeRevision: 1 });
    await registry.adapter(instanceId);

    const replacement = registry.upsertInstance({
      ...base,
      config: { revision: 2 },
      runtimeRevision: 2,
    });
    // The old entry is unreachable the moment the replacement starts, and the
    // concurrent adapter request is serialized behind it.
    const concurrent = registry.adapter(instanceId);
    releaseClose();
    await replacement;

    await expect(concurrent).resolves.toMatchObject({ instanceId });
    expect(lifecycle).toEqual(["create:1", "close:1", "create:2"]);
  });

  it("closes the live adapter before provider-owned profile cleanup", async () => {
    const registry = new HarnessRegistry();
    const lifecycle: string[] = [];
    const removeProfile = vi.fn(async () => {
      lifecycle.push("provider-cleanup");
    });
    registry.registerDriver(
      driver({
        create: async ({ instanceId }) => adapter(instanceId, () => lifecycle.push("close")),
        removeProfile,
      }),
    );
    const profile = {
      ...definition,
      id: createId("harnessInstance"),
      name: "Removed profile",
    };
    registry.configureInstance(profile);
    await registry.adapter(profile.id);
    await registry.removeDefinition(
      profile,
      {},
      nativeUserHarnessRuntimeBoundary,
      {
        continuationKey: "removed-profile",
        kind: "isolated",
        privateStateRoot: "/tmp/opensteer-private",
        providerHomeDirectory: "/tmp/opensteer-removed-profile/provider-home",
        store: { directory: "/tmp/opensteer-private/harness-stores/test/store", id: "store-1" },
      },
      "/tmp",
      new AbortController().signal,
    );
    expect(lifecycle).toEqual(["close", "provider-cleanup"]);
    expect(registry.state(profile.id)).toBeUndefined();
  });
});

/**
 * An engine that declares the person's own install runs it for accounts that
 * use the person's own sign-in. The ways that goes wrong:
 *
 * - the person has no CLI, and their account silently runs the shipped engine;
 * - the person has no CLI, and the Runner still offers their sign-in;
 * - an Opensteer-managed account runs the person's CLI rather than the engine
 *   Opensteer ships;
 * - a CLI the person installs after the Runner started is never used;
 * - every call constructs another driver, so one account's preparation and
 *   adapter belong to different instances.
 */
describe("HarnessRegistry installed engines", () => {
  const ambient = { ...definition, id: createId("harnessInstance"), stateKind: "ambient" } as const;
  const ambientProviderState = { ...testProviderState, kind: "ambient" } as const;
  const missing = "The CLI is not installed on this computer";

  function installedEngine(locate: () => string | undefined) {
    const created: string[] = [];
    const engine = {
      create: (executable: string) => {
        created.push(executable);
        return driver({
          create: async ({ instanceId }) => adapter(instanceId, () => undefined),
          inspect: async () => ({
            models: [{ ...model, displayName: `Installed at ${executable}` }],
            status: "ready" as const,
          }),
        });
      },
      locate,
      missing,
    };
    return { created, engine };
  }

  const shipped = driver({
    inspect: async () => ({
      models: [{ ...model, displayName: "Shipped" }],
      status: "ready" as const,
    }),
  });

  it("runs the person's CLI for their own sign-in and the shipped engine for a managed account", async () => {
    const registry = new HarnessRegistry();
    const { created, engine } = installedEngine(() => "/home/person/bin/engine");
    registry.registerDriver(shipped, { status: "runtime-check" }, engine);
    registry.configureInstance(ambient);

    await expect(
      inspect(registry, ambient, undefined, ambientProviderState),
    ).resolves.toMatchObject({
      models: [{ displayName: "Installed at /home/person/bin/engine" }],
    });
    await expect(inspect(registry)).resolves.toMatchObject({
      models: [{ displayName: "Shipped" }],
    });
    await registry.adapter(ambient.id);
    expect(created).toEqual(["/home/person/bin/engine"]);
  });

  it("reports a missing CLI rather than running the shipped engine for the person's sign-in", async () => {
    const registry = new HarnessRegistry();
    const { engine } = installedEngine(() => undefined);
    registry.registerDriver(shipped, { status: "runtime-check" }, engine);
    registry.configureInstance(ambient);

    await expect(inspect(registry, ambient, undefined, ambientProviderState)).resolves.toEqual({
      detail: missing,
      status: "unavailable",
    });
    await expect(registry.adapter(ambient.id)).rejects.toMatchObject({ message: missing });
  });

  it.each([
    { scope: "ambient", ambientOnly: false },
    { scope: "ambient", ambientOnly: true },
    { scope: "all", ambientOnly: false },
  ] as const)(
    "advertises only runnable sources and recovers profiles (%j)",
    async ({ scope, ambientOnly }) => {
      const registry = new HarnessRegistry();
      let installed: string | undefined;
      const { engine } = installedEngine(() => installed);
      const sources = ambientOnly
        ? testSources.map((source) => ({ ...source, stateKinds: ["ambient"] as const }))
        : testSources;
      registry.registerDriver(
        {
          ...shipped,
          configSchema: z.strictObject({ timeout: z.number().default(30_000) }),
          sources,
        },
        { status: "runtime-check" },
        { ...engine, scope },
      );
      const runnableWithoutInstall = scope === "ambient" && !ambientOnly;
      const missingReadiness = runnableWithoutInstall
        ? { status: "runtime-check" }
        : { reason: missing, status: "unavailable" };
      const configured = { ...ambient, config: { timeout: 30_000 } };

      expect(registry.listDrivers()).toEqual([{ kind: driverKind, readiness: missingReadiness }]);
      expect(registry.canRunDriver(driverKind)).toBe(runnableWithoutInstall);
      expect(registry.driverSources(driverKind)?.map((source) => source.stateKinds)).toEqual(
        runnableWithoutInstall ? [["isolated"]] : undefined,
      );
      expect(registry.driverAccessModes(driverKind)).toEqual(
        runnableWithoutInstall ? shipped.accessModes : undefined,
      );
      expect(registry.driverCapabilities(driverKind)).toEqual(
        runnableWithoutInstall ? shipped.capabilities : undefined,
      );
      await registry.reconcileInstances([ambient]);
      expect(registry.state(ambient.id)?.definition).toEqual(configured);

      installed = "/home/person/bin/engine";
      expect(registry.listDrivers()).toEqual([
        { kind: driverKind, readiness: { status: "runtime-check" } },
      ]);
      expect(registry.driverSources(driverKind)).toEqual(sources);
      expect(registry.driverAccessModes(driverKind)).toEqual(shipped.accessModes);
      expect(registry.driverCapabilities(driverKind)).toEqual(shipped.capabilities);
      await registry.reconcileInstances([ambient]);
      expect(registry.state(ambient.id)).toEqual({ definition: configured, status: "available" });
      await expect(
        inspect(registry, ambient, undefined, ambientProviderState),
      ).resolves.toMatchObject({ status: "ready" });

      installed = undefined;
      await registry.reconcileInstances([ambient]);
      expect(registry.listDrivers()).toEqual([{ kind: driverKind, readiness: missingReadiness }]);
      expect(registry.state(ambient.id)?.definition).toEqual(configured);
      await expect(inspect(registry, ambient, undefined, ambientProviderState)).resolves.toEqual({
        detail: missing,
        status: "unavailable",
      });
      await expect(registry.adapter(ambient.id)).rejects.toMatchObject({ message: missing });

      installed = "/home/person/bin/engine";
      await registry.reconcileInstances([ambient]);
      expect(registry.listInstances()).toEqual([{ definition: configured, status: "available" }]);
      await expect(
        inspect(registry, ambient, undefined, ambientProviderState),
      ).resolves.toMatchObject({ status: "ready" });
      await registry.adapter(ambient.id);
      await registry.close();
    },
  );
});

function driver(overrides: Partial<HarnessDriver>): HarnessDriver {
  return {
    accessModes: ThreadAccessModeSchema.options,
    capabilities: testCapabilities,
    configSchema: z.strictObject({}),
    create: async () => {
      throw new Error("Unexpected adapter creation");
    },
    kind: driverKind,
    sources: testSources,
    ...overrides,
  };
}

function inspect(
  registry: HarnessRegistry,
  target: HarnessInstanceDefinition = definition,
  signal = new AbortController().signal,
  providerState: HarnessProviderState = testProviderState,
  environment: Readonly<Record<string, string>> = {},
) {
  return registry.inspectDefinition(
    target,
    environment,
    nativeUserHarnessRuntimeBoundary,
    providerState,
    "/tmp/opensteer-inspection-contract-test",
    signal,
  );
}

const testProviderState = {
  continuationKey: "test-profile",
  kind: "isolated",
  privateStateRoot: "/tmp/opensteer-inspection-contract-test",
  providerHomeDirectory: "/tmp/opensteer-inspection-contract-test/profile/provider-home",
  store: {
    directory: "/tmp/opensteer-inspection-contract-test/profile/provider-home",
    id: "store-1",
  },
} as const;

function authenticate(
  registry: HarnessRegistry,
  selection: { connectionSlot: string; methodId: string },
) {
  return registry.authenticateDefinition(
    definition,
    {},
    nativeUserHarnessRuntimeBoundary,
    {
      continuationKey: "test-profile",
      kind: "isolated",
      privateStateRoot: "/tmp/opensteer-inspection-contract-test",
      providerHomeDirectory: "/tmp/opensteer-inspection-contract-test/profile/provider-home",
      store: {
        directory: "/tmp/opensteer-inspection-contract-test/profile/provider-home",
        id: "store-1",
      },
    },
    "/tmp/opensteer-inspection-contract-test",
    new AbortController().signal,
    selection,
  );
}

const testCapabilities: HarnessCapabilities = {
  approvals: false,
  attachments: false,
  mcpImageContent: false,
  interruption: false,
  resume: false,
  steering: false,
  toolCalls: false,
  userInput: false,
};

const model = {
  displayName: "Test model",
  isDefault: true,
  modelId: ModelIdSchema.parse("test-model"),
  options: [],
  providerId: ModelProviderIdSchema.parse("test-provider"),
} as const;

function adapter(
  instanceId: Parameters<HarnessDriver["create"]>[0]["instanceId"],
  close: () => unknown,
): HarnessAdapter {
  return {
    capabilities: testCapabilities,
    close: async () => {
      await close();
    },
    instanceId,
    resumeSession: async () => {
      throw new Error("Unexpected resume");
    },
    startSession: async () => {
      throw new Error("Unexpected start");
    },
  };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
