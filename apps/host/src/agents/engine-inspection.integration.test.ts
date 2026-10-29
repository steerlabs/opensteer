import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { threadPlacementOptions, unwrapRpcResult } from "@opensteer/client/host";
import { HarnessRegistry, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorHarnessDriver } from "@opensteer/harness-cursor";
import { RunnerRegistry } from "@opensteer/orchestration";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { testRpcData } from "../server/test-host-api-request.js";
import { reconcileHarnessCatalogs, type HarnessCatalogInspector } from "./harness-catalogs.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";
import { startEngineInspectionStack } from "./engine-inspection.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fixture = fileURLToPath(
  new URL(
    "../../../../packages/harness-cursor/src/test-fixtures/fake-cursor-agent.mjs",
    import.meta.url,
  ),
);

integration("engine inspection sign-in lifecycle", () => {
  let stack: VerticalStack | undefined;
  let scratch: string | undefined;
  afterEach(async () => {
    await stack?.close();
    stack = undefined;
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }, 60_000);

  it("keeps external sign-in required stable without probes and discovers authentication on refresh", async () => {
    scratch = await mkdtemp(join(tmpdir(), "opensteer-engine-inspection-"));
    const state = join(scratch, "scenario");
    const capture = join(scratch, "invocations.jsonl");
    const executable = join(scratch, "agent");
    await writeFile(state, "happy");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { readFileSync } from "node:fs";
process.env.FAKE_CURSOR_SCENARIO = readFileSync(${JSON.stringify(state)}, "utf8");
process.env.FAKE_CURSOR_CAPTURE_PATH = ${JSON.stringify(capture)};
await import(${JSON.stringify(new URL(fixture, "file:").href)});
`,
    );
    await chmod(executable, 0o700);
    const registry = new HarnessRegistry();
    registry.registerDriver(
      new CursorHarnessDriver({ executable, nodeExecutable: process.execPath }),
    );
    const inspectionErrors: string[] = [];
    stack = await startVerticalStack({
      databaseUrl: databaseUrl!,
      runnerLogger: {
        info: () => undefined,
        error: (message) => {
          inspectionErrors.push(message);
        },
      },
      harnesses: registry,
      harnessInstance: {
        config: {},
        driverKind: "cursor",
        sourceId: "cursor",
        stateKind: "ambient",
      },
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      catalogTimeoutMs: 10_000,
      runTimeoutMs: 10_000,
    });
    const active = stack;
    const headers = { cookie: active.sessionCookie, origin: active.hostOrigin.origin };
    const refresh = () =>
      testRpcData(
        active.hostOrigin,
        "harness.catalog.refresh",
        {
          environmentId: active.environmentId,
          harnessInstanceId: active.harnessInstanceId,
        },
        { headers },
      );
    const read = async () => {
      const bootstrap = await testRpcData(active.hostOrigin, "bootstrap.get", {}, { headers });
      const catalog = bootstrap.environments
        .flatMap((environment) => environment.harnessCatalogs)
        .find((candidate) => candidate.harnessInstanceId === active.harnessInstanceId);
      const placement = threadPlacementOptions(bootstrap.environments, bootstrap.harnesses).find(
        (candidate) => candidate.harnessInstanceId === active.harnessInstanceId,
      );
      if (!catalog || !placement) throw new Error("Engine state missing from bootstrap");
      return { catalog, placement };
    };
    const observations = [await read()];
    // The status command still says signed in, but model discovery loses auth.
    // A caller-requested refresh must bypass every private driver cache.
    await writeFile(state, "models-auth-required");
    await refresh();
    const signedOut = await read();
    expect(signedOut.catalog).toMatchObject({
      status: "authentication-required",
      models: [],
      setupMethods: [],
    });
    expect(signedOut.placement).toMatchObject({
      availability: "authentication-required",
      available: false,
      setupAvailable: false,
    });
    expect(signedOut.placement.detail).toContain("Sign in to use Cursor");
    observations.push(signedOut);
    const beforeIdle = await readFile(capture, "utf8");
    let convergenceRequests = 0;
    const inspector: HarnessCatalogInspector = {
      inspectHarnesses: async () => {
        convergenceRequests++;
        await refresh();
        return (await active.host.store.listHarnessCatalogs([active.environmentId])).map(
          ({ catalog }) => catalog,
        );
      },
    };
    // Drive real durable convergence at successive ticks, including beyond the
    // ready-catalog freshness window, without waiting an hour of wall time.
    for (const age of [40_000, 80_000, 120_000, 3_600_000]) {
      await reconcileHarnessCatalogs({
        catalogs: active.host.store,
        connectedEnvironmentIds: [active.environmentId],
        runners: inspector,
        now: Date.now() + age,
        signal: AbortSignal.timeout(10_000),
      });
      observations.push(await read());
    }
    expect(convergenceRequests).toBe(0);
    expect(await readFile(capture, "utf8")).toBe(beforeIdle);
    // Both a logged-out status and an auth refusal from status are normal.
    for (const scenario of ["logged-out", "status-auth-required"]) {
      await writeFile(state, scenario);
      await refresh();
      const observation = await read();
      expect(observation.catalog.status).toBe("authentication-required");
      observations.push(observation);
    }
    await writeFile(state, "happy");
    await refresh();
    const authenticated = await read();
    expect(authenticated.catalog.status).toBe("ready");
    expect(authenticated.placement.available).toBe(true);
    expect(authenticated.catalog.models.length).toBeGreaterThan(0);
    observations.push(authenticated);
    expect(inspectionErrors).toEqual([]);
    const artifactDirectory =
      process.env.OPENSTEER_ENGINE_INSPECTION_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-engine-inspection-evidence-")));
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "inspection.json"),
      JSON.stringify(
        {
          inspectionErrors,
          convergenceRequests,
          observations,
          invocations: (await readFile(capture, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown),
        },
        null,
        2,
      ) + "\n",
    );
    console.info(`Engine inspection evidence: ${artifactDirectory}/inspection.json`);
  }, 60_000);

  it.each(["refresh", "reconnect"] as const)(
    "recovers an invalidated sign-in answer after the first %s capture fails, without another action",
    async (invalidation) => {
      scratch = await mkdtemp(join(tmpdir(), "opensteer-engine-recapture-"));
      const reconcileClock = new ManualClock();
      const started = await startEngineInspectionStack(databaseUrl!, scratch, reconcileClock);
      stack = started.stack;
      const { state } = started;
      const active = stack;
      const refresh = async () =>
        unwrapRpcResult(
          await active.api["harness.catalog.refresh"]({
            environmentId: active.environmentId,
            harnessInstanceId: active.harnessInstanceId,
          }),
        );
      const read = () => active.host.store.listHarnessCatalogs([active.environmentId]);
      await writeFile(state, "logged-out");
      await refresh();
      expect((await read())[0]?.catalog.status).toBe("authentication-required");
      await writeFile(state, "happy");
      const capture = vi.spyOn(active.host.store, "recordHarnessCatalogs");
      if (invalidation === "refresh") {
        // Fail before reaching the Runner: its retained sign-in answer is
        // still cached, so convergence must bypass it as well as the database.
        vi.spyOn(RunnerRegistry.prototype, "inspectHarnesses").mockRejectedValueOnce(
          new Error("Injected first replacement inspection failure"),
        );
        await expect(refresh()).rejects.toThrow("Internal server error");
      } else {
        capture.mockRejectedValueOnce(new Error("Injected first replacement write failure"));
        // Exercise reconnection while its replacement capture is still unready.
        // A process restart now waits for readiness and would hide the empty-store assertion.
        active.network.drop();
        await expect.poll(() => capture.mock.calls.length, { timeout: 10_000 }).toBeGreaterThan(0);
      }
      // The superseded answer must be gone even though its replacement failed.
      expect(await read()).toEqual([]);
      const failedAt = new Date().toISOString();
      // Use the real periodic Host loop, not another refresh or a test-driven
      // call to the reconciler. Only read durable state while waiting. Domain
      // time brings its next pass now rather than up to 45 seconds from now.
      reconcileClock.advanceBy(45_000);
      await expect
        .poll(async () => (await read())[0]?.catalog.status, {
          interval: 250,
          timeout: 45_000,
        })
        .toBe("ready");
      const recovered = unwrapRpcResult(await active.api["bootstrap.get"]({}));
      const placement = threadPlacementOptions(recovered.environments, recovered.harnesses).find(
        (candidate) => candidate.harnessInstanceId === active.harnessInstanceId,
      );
      expect(placement?.available).toBe(true);
      expect(placement?.models.length).toBeGreaterThan(0);
      const artifactDirectory =
        process.env.OPENSTEER_ENGINE_INSPECTION_ARTIFACT_DIR ??
        (await mkdtemp(join(tmpdir(), "opensteer-engine-recapture-evidence-")));
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, `recapture-${invalidation}.json`),
        JSON.stringify(
          {
            invalidation,
            failedAt,
            recoveredAt: new Date().toISOString(),
            captureAttempts: capture.mock.calls.length,
            placement,
            catalogs: await read(),
          },
          null,
          2,
        ) + "\n",
      );
    },
    75_000,
  );
});
