import { fork, type Serializable } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DeploymentCatalogSchema } from "../packages/client/src/connections/index.js";
import { HostDescriptorSchema } from "../packages/deployment-authority/src/index.js";
import { shippedHarnessKindRecord } from "../packages/core/src/index.js";
import { readDesktopConfiguration } from "../apps/desktop/src/config.js";
import { DesktopLocalRunnerTargetResolver } from "../apps/desktop/src/supervisor/local-runner-authority.js";
import {
  LocalRunnerService,
  type UtilityProcessLike,
} from "../apps/desktop/src/supervisor/local-runner-service.js";
import {
  createMachineAccessDatabase,
  enrollmentToken,
  nativeFsHelperBinary,
  startMachineAccessHost,
} from "../apps/host/src/runtime/machine-access.test-support.js";
import { testRpcData } from "../apps/host/src/server/test-host-api-request.js";
import { integrationBundleEntrySync } from "@opensteer/shared/test-support/integrationRunnerBuild";

const identityReadGate = vi.hoisted(() => ({
  current: undefined as { path: string; reached: () => void; resume: Promise<void> } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const metadata = await fs.lstat(...args);
      const gate = identityReadGate.current;
      if (gate && args[0] === gate.path) {
        identityReadGate.current = undefined;
        gate.reached();
        await gate.resume;
      }
      return metadata;
    },
  };
});

const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

integration("local Runner startup with a real credentialed worker", () => {
  it.each(["catalog", "credentials", "output"] as const)(
    "reaps a post-fork %s failure once and can connect on a later start",
    async (fault) => {
      const root = await mkdtemp(path.join(tmpdir(), "opensteer-startup-e2e-"));
      const artifactDirectory = process.env.OPENSTEER_LOCAL_RUNNER_STARTUP_ARTIFACT_DIR ?? root;
      const events: string[] = [];
      const workers: ReturnType<typeof fork>[] = [];
      const exits: Promise<unknown>[] = [];
      const resources: Awaited<ReturnType<typeof resource>>[] = [];
      const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
      const observations: Promise<void>[] = [];
      const statuses: Awaited<ReturnType<LocalRunnerService["status"]>>[] = [];
      const observationErrors: unknown[] = [];
      const identityReadReached = Promise.withResolvers<void>();
      const resumeIdentityRead = Promise.withResolvers<void>();
      let unsubscribe: (() => void) | undefined;
      let service: LocalRunnerService | undefined;
      let host: Awaited<ReturnType<typeof startMachineAccessHost>> | undefined;
      try {
        host = await startMachineAccessHost(database.url);
        const descriptor = HostDescriptorSchema.parse(
          await (await fetch(`${host.origin}/.well-known/opensteer`)).json(),
        );
        const now = new Date().toISOString();
        const catalog = DeploymentCatalogSchema.parse({
          deployments: [
            {
              authority: descriptor.authority,
              bootstrapMethods: descriptor.bootstrapMethods,
              createdAt: now,
              endpoints: [{ kind: "canonical", origin: host.origin, verifiedAt: now }],
              kind: "self-hosted",
              lastUsedAt: null,
              name: "Startup E2E",
              reachability: "canonical",
              source: { kind: "manual" },
              updatedAt: now,
            },
          ],
          revision: 1,
          schemaVersion: 4,
          selectedDeploymentId: host.runtime.deployment.id,
          updatedAt: now,
        });
        const cause = new Error("catalog storage read failed");
        const failure = new Error(`post-fork ${fault} unavailable`, { cause });
        const originalStack = failure.stack;
        const credentials = Promise.withResolvers<void>();
        const observeStatus = () => {
          observations.push(
            service!.status(host!.runtime.deployment.id).then(
              (value) => {
                statuses.push(value);
              },
              (error: unknown) => {
                observationErrors.push(error);
              },
            ),
          );
        };
        let inject = true;
        const targets = new DesktopLocalRunnerTargetResolver({
          catalog: {
            load: async () => {
              if (fault === "catalog" && inject && workers.length > 0) {
                await credentials.promise;
                events.push("catalog-failed-after-credentials");
                throw failure;
              }
              return catalog;
            },
            subscribe: () => () => undefined,
          },
          supervisedDeploymentId: async () => null,
        });
        const workerPath = path.resolve("apps/desktop/dist/runner-worker.js");
        await access(workerPath);
        const { config } = readDesktopConfiguration({
          appDataDirectory: root,
          defaultMode: "development",
          environment: {
            OPENSTEER_DESKTOP_DATA_DIR: root,
            OPENSTEER_DESKTOP_NATIVE_FS_HELPER: nativeFsHelperBinary,
            OPENSTEER_DESKTOP_RUNNER_WORKER: workerPath,
          },
          packaged: false,
        });
        await mkdir(path.join(root, "skills"));
        service = new LocalRunnerService(config, {
          browser: async ({ runtimeId }) => {
            const browser = await resource("browser");
            resources.push(browser);
            return { bridgeToken: "b".repeat(43), runtimeId, signIn: false, ...browser };
          },
          computerName: async () => "Startup E2E Mac",
          computerUse: {
            startForSlot: async () => {
              if (!inject) return null;
              const bridge = await resource("computer-use");
              resources.push(bridge);
              return { token: "c".repeat(43), url: bridge.url };
            },
            stopForSlot: async () => {
              await resources.find((value) => value.name === "computer-use")?.stop();
            },
          },
          fork: (_module, _args, options) => {
            expect(integrationBundleEntrySync(path.resolve("."), "desktop")).toBe(workerPath);
            const child = fork(
              path.resolve("tests/runner-utility-process.test-support.ts"),
              [pathToFileURL(workerPath).href],
              { cwd: options.cwd, env: options.env, execArgv: [], silent: true },
            );
            workers.push(child);
            exits.push(once(child, "exit").then(() => events.push("worker-exited")));
            child.on("message", (value) => {
              if (
                typeof value === "object" &&
                value !== null &&
                "type" in value &&
                value.type === "fixture.credentials-received"
              ) {
                events.push("credentials-received");
                credentials.resolve();
              }
            });
            if (workers.length === 1) unsubscribe = service!.subscribe(observeStatus);
            const utility: UtilityProcessLike = {
              get stdout() {
                if (inject && fault === "output") throw failure;
                return child.stdout;
              },
              stderr: child.stderr,
              kill: () => {
                events.push("worker-killed");
                return child.kill("SIGKILL");
              },
              on: (event, listener) => {
                child.on(event, listener);
                return utility;
              },
              once: (event, listener) => {
                child.once(event, listener);
                return utility;
              },
              postMessage: (value) => {
                child.send(value as Serializable);
                if (inject && fault === "credentials") throw failure;
              },
            };
            return utility;
          },
          homeDirectory: root,
          runtimeRelease: async () => ({
            agentSkillsDirectory: path.join(root, "skills"),
            browserHarnessExecutable: process.execPath,
            harnessExecutables: shippedHarnessKindRecord(() => process.execPath),
            nodeExecutable: process.execPath,
          }),
          targets,
          userEnvironment: { resolve: async () => ({ HOME: root, PATH: "/usr/bin:/bin" }) },
        });
        const token = await enrollmentToken(host, {
          allowedModules: ["agents", "browser", "integrations", "messaging", "shell"],
          idempotencyKey: "startup-e2e",
          name: "Startup E2E Mac",
        });
        const input = {
          deploymentId: host.runtime.deployment.id,
          enrollmentToken: token,
          runAgents: true,
          runnerName: "Startup E2E Mac",
        };
        const error = await service.start(input).then(
          () => null,
          (value: unknown) => value,
        );
        events.push("start-rejected");
        expect(error).toBe(failure);
        expect(failure.cause).toBe(cause);
        expect(failure.stack).toBe(originalStack);
        expect(workers[0]!.signalCode).toBe("SIGKILL");
        expect(resources).toHaveLength(2);
        expect(resources.every((value) => !value.server.listening && value.stops === 1)).toBe(true);
        const status = await service.status(input.deploymentId);
        expect(status.runner.state).toBe("failed");
        expect(status.runner.detail).toContain(failure.message);
        unsubscribe?.();
        await Promise.all(observations);
        expect(observationErrors).toEqual([]);
        const diagnostics = statuses.filter((value) => value.runner.state === "failed");
        expect(diagnostics).toHaveLength(1);
        expect(events.indexOf("worker-exited")).toBeLessThan(events.indexOf("start-rejected"));
        inject = false;
        const retry = await service.start({ ...input, runAgents: false });
        expect(retry.runner.state).toBe("running");
        const machines = await testRpcData(
          host.origin,
          "machines.list",
          {},
          {
            headers: host.ownerHeaders,
          },
        );
        expect(machines.machines.some((machine) => machine.id === retry.runner.runnerId)).toBe(
          true,
        );
        // Hold a real status observer after identity lstat, then remove the slot
        // before open. The test-only fs wrapper changes scheduling, not file data.
        identityReadGate.current = {
          path: path.join(
            config.localExecution.dataDirectory,
            "deployments",
            input.deploymentId,
            "identity.json",
          ),
          reached: () => {
            events.push("observer-identity-statted");
            identityReadReached.resolve();
          },
          resume: resumeIdentityRead.promise,
        };
        unsubscribe = service.subscribe(observeStatus);
        await service.shutdown();
        await identityReadReached.promise;
        await service.remove(input.deploymentId);
        events.push("slot-removed-before-observer-open");
        unsubscribe();
        resumeIdentityRead.resolve();
        await Promise.all(observations);
        expect(observationErrors).toEqual([]);
        const removedStatus = await service.status(input.deploymentId);
        expect(removedStatus.runner.enrolled).toBe(false);
        await expect(
          access(path.join(config.localExecution.dataDirectory, "deployments", input.deploymentId)),
        ).rejects.toThrow();
        expect(await service.enrolledRunners()).toEqual([]);
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          path.join(artifactDirectory, `startup-cleanup-${fault}.json`),
          JSON.stringify(
            {
              fault,
              events,
              originalErrorPreserved: error === failure,
              originalCausePreserved: failure.cause === cause,
              originalStackPreserved: failure.stack === originalStack,
              diagnostics: diagnostics.map((value) => value.runner),
              resources: resources.map(({ name, stops, server }) => ({
                name,
                stops,
                listening: server.listening,
              })),
              workerExits: workers.map(({ pid, exitCode, signalCode }) => ({
                pid,
                exitCode,
                signalCode,
              })),
              retry: retry.runner,
              removed: removedStatus.runner,
              observationErrors,
              slotRemoved: true,
            },
            null,
            2,
          ) + "\n",
        );
      } finally {
        unsubscribe?.();
        identityReadGate.current = undefined;
        resumeIdentityRead.resolve();
        await Promise.all(observations);
        service?.dispose();
        for (const child of workers)
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await Promise.all(exits);
        for (const value of resources) if (value.server.listening) await value.stop();
        await host?.close();
        await database.drop();
        if (artifactDirectory !== root) await rm(root, { recursive: true, force: true });
      }

      async function resource(name: string) {
        const server = createServer((_request, response) => {
          response.writeHead(503);
          response.end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing bridge address");
        const value = {
          name,
          server,
          stops: 0,
          url: new URL(`http://127.0.0.1:${address.port}`),
          stop: async () => {
            value.stops += 1;
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
            events.push(`${name}-stopped`);
          },
        };
        return value;
      }
    },
    60_000,
  );
});
