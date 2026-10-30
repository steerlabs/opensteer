import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { RunnerToHostMessageSchema } from "@opensteer/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readCodexRunCaptures } from "./codex-capture.test-support.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";
import type { WireRecord } from "./runner-wire.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const fixture = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const evidence: unknown[] = [];

(databaseUrl ? describe : describe.skip)("Runner boot readiness", () => {
  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-runner-readiness-"));
    const path = join(directory, "readiness.json");
    await writeFile(
      path,
      JSON.stringify(
        {
          command:
            "pnpm test:integration apps/host/src/agents/runner-readiness.integration.test.ts",
          evidence,
        },
        null,
        2,
      ) + "\n",
    );
    console.info(`Runner readiness evidence: ${path}`);
  });

  it("waits for gated preparation and observes its invalidation recapture", async () => {
    const preparation = Promise.withResolvers<void>();
    const preparing = Promise.withResolvers<void>();
    let completed = false;
    let active: VerticalStack | undefined;
    const starting = startVerticalStack({
      databaseUrl: databaseUrl!,
      harnesses: () => {
        const registry = new HarnessRegistry();
        const driver = new CodexHarnessDriver({
          launch: {
            executable: process.execPath,
            arguments: [fixture, "--scenario=happy"],
          },
        });
        const prepare = driver.prepare.bind(driver);
        vi.spyOn(driver, "prepare").mockImplementation(async (context) => {
          await preparation.promise;
          await prepare(context);
        });
        registry.registerDriver(driver);
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      catalogTimeoutMs: 30_000,
      runTimeoutMs: 30_000,
      runnerWire: {
        filter: (direction, frame) => {
          if (direction === "runner" && frame.type === "runner.harness-catalog") {
            const response = RunnerToHostMessageSchema.parse(frame);
            if (
              response.type === "runner.harness-catalog" &&
              response.catalogs.some((catalog) => catalog.status === "preparing")
            )
              preparing.resolve();
          }
          return true;
        },
      },
    }).then((stack) => {
      active = stack;
      completed = true;
      return stack;
    });
    void starting.catch(() => undefined);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Preparation gate not reached within 30000 ms")),
          30_000,
        );
      });
      await Promise.race([preparing.promise, starting.then(() => preparing.promise), deadline]);
      expect(completed).toBe(false);
      preparation.resolve();
      const stack = await starting;
      expect(stack.catalog.status).toBe("ready");
      expect(
        stack.wire!.frames.some(({ frame }) => frame.type === "runner.harness-catalog-invalidated"),
      ).toBe(true);
      evidence.push({
        kind: "preparation",
        preparingObserved: true,
        readyAfterInvalidation: completed,
      });
    } finally {
      clearTimeout(timeout);
      preparation.resolve();
      await starting.catch(() => undefined);
      await active?.close();
    }
  }, 90_000);

  it.each([false, true])(
    "owns an unready replacement during assertion-failure teardown (child=%s)",
    async (child) => {
      const scratch = await mkdtemp(join(tmpdir(), "opensteer-unready-teardown-"));
      const capture = join(scratch, "capture.jsonl");
      const release = join(scratch, "preparation-release");
      const gatedEngine = fileURLToPath(
        new URL("./dispatch-readiness-engine.test-support.ts", import.meta.url),
      );
      const arguments_ = [
        `--fixture=${fixture}`,
        `--scratch=${scratch}`,
        "--capture-records",
        `--capture=${capture}`,
        `--preparation-release=${release}`,
        "--scenario=happy",
        "--capture-process-id",
      ];
      await writeFile(release, "");
      let active: VerticalStack | undefined;
      let restart: Promise<void> | undefined;
      let restartSettled = false;
      try {
        active = await startVerticalStack({
          databaseUrl: databaseUrl!,
          harnesses: () => {
            const registry = new HarnessRegistry();
            registry.registerDriver(
              new CodexHarnessDriver({
                launch: {
                  executable: process.execPath,
                  arguments: [gatedEngine, ...arguments_, `--readiness-runner-pid=${process.pid}`],
                },
              }),
            );
            return registry;
          },
          ...(child
            ? {
                runnerChild: {
                  fixture: gatedEngine,
                  arguments: [...arguments_, "--readiness-runner-pid=self"],
                },
              }
            : {}),
          harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
          harnessInstance: {
            config: {},
            driverKind: "codex",
            sourceId: "openai",
            stateKind: "isolated",
          },
          catalogTimeoutMs: 30_000,
          runTimeoutMs: 30_000,
        });
        const stack = active;
        await rm(release);
        restart = stack.restartRunner().finally(() => {
          restartSettled = true;
        });
        void restart.catch(() => undefined);
        await expect
          .poll(
            async () =>
              (await readCodexRunCaptures(capture)).some((entry) => entry.preparationHeld),
            { timeout: 30_000 },
          )
          .toBe(true);
        const held = z
          .object({
            pid: z.number().int().positive(),
            runnerPid: z.number().int().positive(),
            enginePid: z.number().int().positive(),
          })
          .parse(
            (await readCodexRunCaptures(capture)).findLast((entry) => entry.preparationHeld)
              ?.preparationHeld,
          );
        const ownedPids = [held.pid, held.enginePid, ...(child ? [held.runnerPid] : [])];
        if (child) expect(held.runnerPid).not.toBe(process.pid);
        for (const pid of ownedPids) expect(process.kill(pid, 0)).toBe(true);
        expect(restartSettled).toBe(false);
        const survivingPids = () =>
          ownedPids.filter((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
              throw error;
            }
          });
        const beforeHostClose: {
          readonly survivors: readonly number[];
          readonly restartSettled: boolean;
        }[] = [];
        const closeHost = stack.host.close.bind(stack.host);
        vi.spyOn(stack.host, "close").mockImplementation(async () => {
          beforeHostClose.push({ survivors: survivingPids(), restartSettled });
          await closeHost();
        });
        await expect(
          (async () => {
            try {
              expect(false, "Injected assertion failure while preparation is held").toBe(true);
            } finally {
              // Model afterEach directly: no preparation release and no successful restart first.
              await stack.close();
            }
          })(),
        ).rejects.toThrow("Injected assertion failure while preparation is held");
        await expect(restart).rejects.toThrow("Vertical stack closed");
        const survivors = survivingPids();
        evidence.push({
          kind: "assertion-failure teardown",
          child,
          ownedPids,
          beforeHostClose,
          survivors,
          restartSettled,
        });
        expect(beforeHostClose).toEqual([{ survivors: [], restartSettled: true }]);
        expect(survivors).toEqual([]);
        expect(restartSettled).toBe(true);
      } finally {
        // Also contain the intentionally failing baseline: let its orphaned startup settle.
        await writeFile(release, "");
        await restart?.catch(() => undefined);
        await active?.close();
        await rm(scratch, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it.each(["restart", "child restart", "crash", "companion"] as const)(
    "%s ignores a stale ready catalog until the new boot commits its own",
    async (kind) => {
      const held = Promise.withResolvers<WireRecord>();
      let gate = false;
      let stale: WireRecord | undefined;
      let active: VerticalStack | undefined;
      let operation: Promise<unknown> | undefined;
      let proceeded = false;
      const frames: WireRecord[] = [];
      try {
        active = await startVerticalStack({
          databaseUrl: databaseUrl!,
          harnesses: () => {
            const registry = new HarnessRegistry();
            registry.registerDriver(
              new CodexHarnessDriver({
                launch: {
                  executable: process.execPath,
                  arguments: [fixture, "--scenario=happy"],
                },
              }),
            );
            return registry;
          },
          harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
          harnessInstance: {
            config: {},
            driverKind: "codex",
            sourceId: "openai",
            stateKind: "isolated",
          },
          ...(kind === "child restart" || kind === "crash"
            ? {
                runnerChild: { fixture, arguments: ["--scenario=happy"] },
              }
            : {}),
          catalogTimeoutMs: 30_000,
          runTimeoutMs: 30_000,
          runnerWire: {
            filter: (direction, frame) => {
              if (direction !== "runner" || frame.type !== "runner.harness-catalog") return true;
              const response = RunnerToHostMessageSchema.parse(frame);
              if (
                response.type !== "runner.harness-catalog" ||
                !response.catalogs.some(
                  (catalog) =>
                    catalog.driverKind === "codex" &&
                    catalog.status === "ready" &&
                    (!active ||
                      (kind === "companion"
                        ? catalog.harnessInstanceId !== active.harnessInstanceId
                        : catalog.harnessInstanceId === active.harnessInstanceId)),
                )
              )
                return true;
              if (!gate) {
                stale = frame;
                return true;
              }
              frames.push(frame);
              held.resolve(frame);
              return false;
            },
          },
        });
        const stack = active;
        const prior = (await stack.host.store.listHarnessCatalogs([stack.environmentId])).find(
          (record) => record.harnessInstanceId === stack.harnessInstanceId,
        )!;
        expect(prior.catalog.status).toBe("ready");
        gate = true;
        operation = (
          kind === "companion"
            ? stack.startAdditionalRunner()
            : kind === "crash"
              ? stack.crashRunner()
              : stack.restartRunner()
        ).then(async () => {
          proceeded = true;
          return stack.api["bootstrap.get"]({});
        });
        void operation.catch(() => undefined);
        // Observe the actual new-boot response, rather than waiting an elapsed interval.
        let timeout: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("New boot did not reach its ready catalog gate within 30000 ms")),
            30_000,
          );
        });
        let pending: WireRecord;
        try {
          pending = await Promise.race([
            held.promise,
            operation.then(() => held.promise),
            deadline,
          ]);
        } finally {
          clearTimeout(timeout);
        }
        expect(pending.bootId).not.toBe(stale!.bootId);
        // Deliver the previous boot's ready observation through the real Host API.
        // Replaying its wire fence would intentionally disconnect the new boot.
        const response = RunnerToHostMessageSchema.parse(pending);
        if (response.type !== "runner.harness-catalog")
          throw new Error("Expected catalog response");
        const accountId =
          kind === "companion"
            ? response.catalogs.find((catalog) => catalog.driverKind === "codex")!.harnessInstanceId
            : stack.harnessInstanceId;
        const harness = (await stack.host.store.getHarnessInstance(accountId))!;
        await stack.host.store.recordHarnessCatalogs({
          environmentId: harness.environmentId,
          catalogs: [{ ...prior.catalog, harnessInstanceId: accountId }],
          expectedRevisions: new Map([[accountId, harness.runtimeRevision]]),
        });
        expect(
          (await stack.host.store.listHarnessCatalogs([harness.environmentId])).find(
            (record) => record.harnessInstanceId === accountId,
          )!.catalog.status,
        ).toBe("ready");
        const bootstrap = await stack.api["bootstrap.get"]({});
        if (!bootstrap.ok) throw new Error(bootstrap.error.message);
        const environment = bootstrap.data.environments.find(
          (entry) => entry.id === harness.environmentId,
        )!;
        expect(environment.connected).toBe(true);
        expect(
          environment.harnessCatalogs.find((catalog) => catalog.harnessInstanceId === accountId)
            ?.status,
        ).toBe("ready");
        evidence.push({
          kind,
          staleReadyDelivered: true,
          oldBoot: stale!.bootId,
          newBoot: pending.bootId,
          proceededWhileHeld: proceeded,
        });
        expect(proceeded).toBe(false);
        gate = false;
        for (const frame of frames.splice(0)) stack.wire!.sendRunner(frame);
        await operation;
        expect(proceeded).toBe(true);
        expect(
          (await stack.host.store.listHarnessCatalogs([harness.environmentId])).find(
            (record) => record.harnessInstanceId === accountId,
          )!.catalog,
        ).toEqual(response.catalogs.find((catalog) => catalog.harnessInstanceId === accountId));
        evidence.push({ kind, released: true, proceeded });
      } finally {
        gate = false;
        if (active) {
          for (const frame of frames.splice(0)) active.wire!.sendRunner(frame);
          await operation?.catch(() => undefined);
          await active.close();
        }
      }
    },
    90_000,
  );
});
