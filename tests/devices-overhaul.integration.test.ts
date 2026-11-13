import { newTabTarget } from "../packages/client/src/host/link-places.js";
import { startBrowserRuntime } from "../apps/host/src/browser/browser-runtime.test-support.js";
import { callMcpTool } from "../apps/host/src/mcp/call-tool.test-support.js";
import {
  acceptCallerRun,
  connectCallerMachine,
  dispatchCallerRun,
  startMachineAccessWireHost,
  waitForExecute,
} from "../apps/host/src/runtime/machine-access-protocol.test-support.js";
import { fork, type Serializable } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac, createPrivateKey, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
} from "../packages/client/src/test-support/index.js";
import { readMemberships } from "../apps/desktop/src/supervisor/device-membership.js";
import { HostSession } from "../packages/client/src/auth/host-session.js";
import { establishedCookieSession } from "../packages/client/src/test-support/session-exchange.js";
import { resolveConnection } from "../packages/client/src/connections/connection-resolver.js";
import { ControlPlaneAccountIdSchema } from "../packages/control-plane-protocol/src/index.js";
import { DeploymentCatalogSchema } from "../packages/client/src/connections/index.js";
import { HostDescriptorSchema } from "../packages/deployment-authority/src/index.js";
import { createId, RequestIdSchema, shippedHarnessKindRecord } from "../packages/core/src/index.js";
import { createDeviceLeaveSignature } from "../packages/runner-auth/src/index.js";
import { desktopDeploymentPaths } from "../apps/desktop/src/app/application-paths.js";
import { readDesktopConfiguration } from "../apps/desktop/src/config.js";
import { DesktopLocalRunnerTargetResolver } from "../apps/desktop/src/supervisor/local-runner-authority.js";
import {
  LocalRunnerService,
  type UtilityProcessLike,
} from "../apps/desktop/src/supervisor/local-runner-service.js";
import {
  configurePersonalRemoteAccess,
  createMachineAccessDatabase,
  nativeFsHelperBinary,
  startPersonalMachineHost,
} from "../apps/host/src/runtime/personal-machine.test-support.js";
import { testRpcData, testRpcRequest } from "../apps/host/src/server/test-host-api-request.js";
import { integrationBundleEntrySync } from "@opensteer/shared/test-support/integrationRunnerBuild";
import { withTimeout } from "@opensteer/shared/withTimeout";

it("enrolls, binds, preserves access, removes and heals a real desktop Runner against Home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devices-overhaul-"));
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
  const workers: ReturnType<typeof fork>[] = [];
  const exits: Promise<unknown>[] = [];
  let service: LocalRunnerService | undefined;
  let host: Awaited<ReturnType<typeof startPersonalMachineHost>> | undefined;
  try {
    host = await startPersonalMachineHost({ databaseUrl: database.url, remoteAccess: true });
    const home = host;
    const deploymentId = home.runtime.deployment.id;
    const descriptor = HostDescriptorSchema.parse(
      await (await fetch(new URL("/.well-known/opensteer", home.origin))).json(),
    );
    expect(descriptor.capabilities).toContain("devices-v1");
    const now = new Date().toISOString();
    const fullCatalog = DeploymentCatalogSchema.parse({
      deployments: [
        {
          authority: descriptor.authority,
          bootstrapMethods: descriptor.bootstrapMethods,
          capabilities: descriptor.capabilities,
          createdAt: now,
          endpoints: [{ kind: "canonical", origin: home.origin.origin, verifiedAt: now }],
          kind: "personal",
          lastUsedAt: null,
          name: "Devices E2E",
          reachability: "canonical",
          source: { kind: "manual" },
          updatedAt: now,
        },
      ],
      revision: 2,
      schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
      selectedDeploymentId: deploymentId,
      updatedAt: now,
    });
    let catalog = fullCatalog;
    const targets = new DesktopLocalRunnerTargetResolver({
      catalog: { load: async () => catalog, subscribe: () => () => undefined },
      supervisedDeploymentId: async () => null,
    });
    const workerPath = integrationBundleEntrySync(path.resolve("."), "desktop");
    const { config } = readDesktopConfiguration({
      appDataDirectory: root,
      defaultMode: "development",
      packaged: false,
      environment: {
        OPENSTEER_DESKTOP_DATA_DIR: root,
        OPENSTEER_DESKTOP_NATIVE_FS_HELPER: nativeFsHelperBinary,
        OPENSTEER_DESKTOP_RUNNER_WORKER: workerPath,
      },
    });
    await mkdir(path.join(root, "skills"));
    const revoked = Promise.withResolvers<void>();
    let sessionHeaders = home.ownerHeaders;
    let lifecycleSession: HostSession | undefined;
    let membershipTime: number | null = null;
    let legacySessionCleared = false;
    const leaveFetch = vi.fn<typeof fetch>(fetch);
    const createService = () =>
      new LocalRunnerService(config, {
        computerName: async () => "Devices E2E Mac",
        leaveFetch,
        now: () => membershipTime ?? Date.now(),
        fenceDeployment: (id) => lifecycleSession?.blockDeployment(id),
        allowDeployment: async (id) => {
          await lifecycleSession?.allowDeployment(id);
        },
        clearDeploymentSession: async () => {
          legacySessionCleared = true;
        },
        revokeLegacyRunner: async (_id, _origin, machineId) => {
          expect(legacySessionCleared).toBe(false);
          await testRpcData(
            home.origin,
            "commands.dispatch",
            { type: "machine.revoke", machineId, idempotencyKey: `legacy-remove:${machineId}` },
            { headers: sessionHeaders },
          );
        },
        retireEnrollment: async (_id, _origin, enrollmentId) => {
          expect(legacySessionCleared).toBe(false);
          const result = await testRpcData(
            home.origin,
            "commands.dispatch",
            {
              type: "runner.enrollment.retire",
              enrollmentId,
              idempotencyKey: `legacy-retire:${enrollmentId}`,
            },
            { headers: sessionHeaders },
          );
          if (result.type !== "runner.enrollment.retire")
            throw new Error("Invalid retirement receipt");
          return result.state;
        },
        readSession: async () => {
          const current = (
            await testRpcData(home.origin, "sessions.list", {}, { headers: sessionHeaders })
          ).sessions.find((session) => session.current);
          if (!current) throw new Error("No current desktop session");
          return current;
        },
        homeDirectory: root,
        targets,
        runtimeRelease: async () => ({
          agentSkillsDirectory: path.join(root, "skills"),
          browserHarnessExecutable: process.execPath,
          harnessExecutables: shippedHarnessKindRecord(() => process.execPath),
          nodeExecutable: process.execPath,
        }),
        userEnvironment: { resolve: async () => ({ HOME: root, PATH: "/usr/bin:/bin" }) },
        fork: (_module, _args, options) => {
          const child = fork(
            path.resolve("tests/runner-utility-process.test-support.ts"),
            [pathToFileURL(workerPath).href],
            { cwd: options.cwd, env: options.env, execArgv: [], silent: true },
          );
          workers.push(child);
          exits.push(once(child, "exit"));
          child.on("message", (value) => {
            if (
              typeof value === "object" &&
              value !== null &&
              "type" in value &&
              value.type === "runner.worker.revoked"
            )
              revoked.resolve();
          });
          const utility: UtilityProcessLike = {
            stdout: child.stdout,
            stderr: child.stderr,
            kill: () => child.kill("SIGKILL"),
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
            },
          };
          return utility;
        },
      });
    async function waitForRemoval() {
      const forgotten = Promise.withResolvers<void>();
      const activeService = service!;
      const observeRemoval = async () => {
        const status = await activeService.status(deploymentId);
        if (status.membership?.state === "removed" && !status.runner.enrolled) forgotten.resolve();
      };
      const unsubscribe = activeService.subscribe(() => {
        void observeRemoval();
      });
      try {
        await observeRemoval();
        await withTimeout(forgotten.promise, 5000, {
          timeoutError: () => new Error("Revoked Runner identity was never forgotten"),
        });
      } finally {
        unsubscribe();
      }
    }
    service = createService();
    const command = (input: Parameters<typeof testRpcData<"commands.dispatch">>[2]) =>
      service!.withPreparedEnrollment(deploymentId, input, async () => {
        const result = await testRpcData(home.origin, "commands.dispatch", input, {
          headers: sessionHeaders,
        });
        await service!.observeHostCommand(deploymentId, input, result);
        return result;
      });
    const mint = async (key: string) => {
      await service!.setUpDevice({ deploymentId, runnerName: "Devices E2E Mac", runAgents: false });
      const preparedIdentity = await service!.prepareDeviceSetup({
        deploymentId,
        runnerName: "Devices E2E Mac",
        runAgents: false,
      });
      const result = await command({
        type: "runner.enrollment.createLocal",
        preparedIdentity,
        name: "Devices E2E Mac",
        allowedModules: ["browser", "integrations", "messaging", "shell"],
        access: { browser: true, apps: false, files: false },
        idempotencyKey: key,
      });
      if (result.type !== "runner.enrollment.createLocal")
        throw new Error("Wrong enrollment receipt");
      return result.token;
    };
    const start = await service.start({
      deploymentId,
      enrollmentToken: await mint("enroll"),
      runAgents: false,
      runnerName: "Devices E2E Mac",
    });
    expect(start.runner.state).toBe("running");
    const runnerId = start.runner.runnerId!;
    const row = () =>
      home.runtime.store.database
        .selectFrom("runners")
        .selectAll()
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow();
    expect((await row()).accessPolicy).toMatchObject({
      browser: true,
      apps: false,
      reach: "nobody",
    });
    console.info(
      "STEP 1: real Runner child enrolled; initial browser=true/apps=false/files=false applied",
    );
    await command({
      type: "machine.access.update",
      runnerId,
      expectedRevision: (await row()).accessPolicyRevision,
      policy: { ...(await row()).accessPolicy, browser: false },
      idempotencyKey: "off",
    });
    const beforeLegacy = await row();
    await command({
      type: "machine.access.update",
      runnerId,
      expectedRevision: beforeLegacy.accessPolicyRevision,
      policy: { reach: "owner", commands: true, forwarding: true, shares: [] },
      idempotencyKey: "legacy",
    });
    expect((await row()).accessPolicy.browser).toBe(false);
    console.info("STEP 4: old full policy shape preserves Browser=false");
    const identityPath = path.join(
      config.localExecution.dataDirectory,
      "deployments",
      deploymentId,
      "identity.json",
    );
    const identity = JSON.parse(await readFile(identityPath, "utf8")) as {
      privateKeyPem: string;
      runnerId: string;
    };
    let current = (
      await testRpcData(home.origin, "sessions.list", {}, { headers: home.ownerHeaders })
    ).sessions.find((s) => s.current)!;
    await command({
      type: "machine.session.bind",
      machineId: runnerId,
      idempotencyKey: "bind",
      proof: await service.signDeviceSessionBinding({ deploymentId, sessionId: current.id }),
    });
    expect(
      (
        await testRpcData(home.origin, "sessions.list", {}, { headers: home.ownerHeaders })
      ).sessions.find((s) => s.current)?.deviceId,
    ).toBe(runnerId);
    console.info("STEP 2: signed HTTP binding appears in sessions.list");
    const originalSession = await home.runtime.store.database
      .selectFrom("authSessions")
      .selectAll()
      .where("id", "=", current.id)
      .executeTakeFirstOrThrow();
    const cloneSession = async () => {
      const token = randomUUID();
      await home.runtime.store.database
        .insertInto("authSessions")
        .values({ ...originalSession, id: createId("authSession"), token, deviceId: null })
        .execute();
      const cookie = `opensteer.session=${encodeURIComponent(`${token}.${createHmac("sha256", home.config.authSecret).update(token).digest("base64")}`)}`;
      return { ...home.ownerHeaders, cookie };
    };
    const otherHeaders = await cloneSession();
    const shortHeaders = await cloneSession();
    sessionHeaders = shortHeaders;
    current = (
      await testRpcData(home.origin, "sessions.list", {}, { headers: shortHeaders })
    ).sessions.find((session) => session.current)!;
    const expiry = new Date(Date.now() + 30_000);
    await home.store.database
      .updateTable("authSessions")
      .set({ absoluteExpiresAt: expiry })
      .where("id", "=", current.id)
      .execute();
    await command({
      type: "machine.session.bind",
      machineId: runnerId,
      idempotencyKey: "bind-expiring",
      proof: await service.signDeviceSessionBinding({ deploymentId, sessionId: current.id }),
    });
    const attachment = {
      connection: fullCatalog.deployments[0]!,
      resolved: resolveConnection(fullCatalog.deployments[0]!, null, { authorization: null }),
    };
    const establish = vi.fn(async () => {
      sessionHeaders = await cloneSession();
      return establishedCookieSession();
    });
    lifecycleSession = new HostSession({
      attachment: { current: async () => attachment, currentKey: () => attachment.resolved.key },
      assertSessionAllowed: (id) => service!.assertSessionAllowed(id),
      onUnauthorized: async () => service!.sessionLost(deploymentId),
      onSessionEnded: async () => service!.sessionLost(deploymentId),
      clearDeploymentSession: async () => undefined,
      exchange: { supports: () => true, probe: async () => "unauthenticated", establish },
      localOwner: { ownsHostSession: () => false, recoverOwnerSession: async () => false },
      oauth: {
        abandonHostSignIn: () => undefined,
        beginHostSignIn: async () => {
          throw new Error("Unexpected OAuth sign-in");
        },
        hostCredentialState: () => {
          throw new Error("Unexpected OAuth read");
        },
        recoverHostAuthorization: async () => false,
        signOutHost: async () => {
          throw new Error("Unexpected OAuth sign-out");
        },
        subscribe: () => () => undefined,
        subscribeHostCredentials: () => () => undefined,
      },
    });
    await home.store.database
      .updateTable("authSessions")
      .set({ absoluteExpiresAt: new Date(0) })
      .where("id", "=", current.id)
      .execute();
    membershipTime = expiry.getTime() + 1_000;
    try {
      expect(
        (await testRpcRequest(home.origin, "sessions.list", {}, { headers: shortHeaders })).status,
      ).toBe(401);
      expect(await lifecycleSession.recoverUnauthorized(attachment)).toBe("blocked");
      const confirmedExpiry = Promise.withResolvers<void>();
      let lastExpiryStatus = await service.status(deploymentId);
      const observe = async () => {
        lastExpiryStatus = await service!.status(deploymentId);
        if (lastExpiryStatus.membership?.sessionState === "sign-in-again")
          confirmedExpiry.resolve();
      };
      const unsubscribe = service.subscribe(() => {
        void observe();
      });
      try {
        await observe();
        await withTimeout(confirmedExpiry.promise, 5_000, {
          timeoutError: () =>
            new Error(
              `Expired bound session never reached explicit Sign in again: ${JSON.stringify(lastExpiryStatus)}`,
            ),
        });
      } finally {
        unsubscribe();
      }
      await expect(lifecycleSession.establish(deploymentId)).rejects.toThrow("Sign in again");
      expect(establish).not.toHaveBeenCalled();
      expect((await row()).revokedAt).toBeNull();
      await service.setUpDevice({ deploymentId, runnerName: "Devices E2E Mac", runAgents: false });
      await lifecycleSession.establish(deploymentId);
      expect(establish).toHaveBeenCalledOnce();
      expect((await service.status(deploymentId)).membership?.runnerId).toBe(runnerId);
    } finally {
      membershipTime = null;
      lifecycleSession.dispose();
      lifecycleSession = undefined;
    }
    sessionHeaders = home.ownerHeaders;
    current = (
      await testRpcData(home.origin, "sessions.list", {}, { headers: sessionHeaders })
    ).sessions.find((session) => session.current)!;
    console.info(
      "STEP 2a: actual bound session expiry fences HostSession recovery until explicit Sign in again; runner identity stays",
    );
    const access = await home.runtime.store.database
      .selectFrom("personalRemoteAccess")
      .selectAll()
      .executeTakeFirstOrThrow();
    await home.runtime.store.database
      .insertInto("personalRemoteSessions")
      .values({
        authSessionId: current.id,
        delivery: "cookie",
        routeGeneration: access.generation,
        routeKind: "private",
        routeOrigin: access.routeOrigin!,
        createdAt: new Date(),
      })
      .execute();
    const profileRoot = desktopDeploymentPaths(root, deploymentId).browserProfilesDirectory;
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(profileRoot, "saved-profile"), "keep");
    await configurePersonalRemoteAccess(
      { runtime: home.runtime, ownerHeaders: otherHeaders },
      { schemaVersion: 1, mode: "private", routeOrigin: "https://rotated.machine-access.test" },
    );
    expect(
      (await testRpcRequest(home.origin, "sessions.list", {}, { headers: home.ownerHeaders }))
        .status,
    ).toBe(401);
    await service.sessionLost(deploymentId);
    const confirmed = Promise.withResolvers<void>();
    const observeConfirmation = async () => {
      const status = await service!.status(deploymentId);
      if (status.runner.state === "running" && status.membership?.sessionState === "ready")
        confirmed.resolve();
    };
    const detach = service.subscribe(() => {
      void observeConfirmation();
    });
    try {
      await observeConfirmation();
      await withTimeout(confirmed.promise, 5000, {
        timeoutError: () =>
          new Error("Runner never confirmed membership after Home rotated its route"),
      });
    } finally {
      detach();
    }
    await service.assertSessionAllowed(deploymentId);
    expect(JSON.parse(await readFile(identityPath, "utf8")).runnerId).toBe(runnerId);
    expect(JSON.parse(await readFile(identityPath, "utf8")).privateKeyPem).toBe(
      identity.privateKeyPem,
    );
    expect(await readFile(path.join(profileRoot, "saved-profile"), "utf8")).toBe("keep");
    expect((await row()).revokedAt).toBeNull();
    const recoveredHeaders = await cloneSession();
    sessionHeaders = recoveredHeaders;
    current = (
      await testRpcData(home.origin, "sessions.list", {}, { headers: recoveredHeaders })
    ).sessions.find((session) => session.current)!;
    await command({
      type: "machine.session.bind",
      machineId: runnerId,
      idempotencyKey: "bind-after-rotation",
      proof: await service.signDeviceSessionBinding({ deploymentId, sessionId: current.id }),
    });
    console.info(
      "STEP 2b: Home route rotation ends the bound session; Runner confirms membership, preserves the key and browser profiles, and sign-in rebinds",
    );
    await service.shutdown();
    service.dispose();
    service = createService();
    const membershipFile = path.join(config.localExecution.dataDirectory, "desktop-runner.json");
    await writeFile(membershipFile, '{"version":5,"runners":{}}', { mode: 0o600 });
    catalog = { ...fullCatalog, deployments: [], selectedDeploymentId: null, revision: 1 };
    await service.startIfEnabled();
    expect((await service.status(deploymentId)).membership?.state).toBe("waiting");
    expect(JSON.parse(await readFile(identityPath, "utf8")).runnerId).toBe(runnerId);
    catalog = fullCatalog;
    await service.reconcile();
    expect((await service.status(deploymentId)).runner.state).toBe("running");
    expect((await service.status(deploymentId)).runner.runnerId).toBe(runnerId);
    expect((await row()).accessPolicy).toMatchObject({
      browser: false,
      apps: false,
      reach: "owner",
    });
    console.info(
      "STEP 6a: empty membership + older empty catalog waits; restored catalog reconnects same key without resetting switches",
    );
    await testRpcData(
      home.origin,
      "commands.dispatch",
      { type: "machine.revoke", machineId: runnerId, idempotencyKey: "remove" },
      { headers: otherHeaders },
    );
    expect(
      (await testRpcRequest(home.origin, "sessions.list", {}, { headers: recoveredHeaders }))
        .status,
    ).toBe(401);
    await withTimeout(revoked.promise, 5000, {
      timeoutError: () => new Error("Real Runner did not report Host close 4010"),
    });
    await waitForRemoval();
    await service.shutdown();
    service.dispose();
    service = createService();
    await service.startIfEnabled();
    expect((await service.status(deploymentId)).membership?.state).toBe("removed");
    await expect(readFile(identityPath)).rejects.toThrow();
    expect((await row()).revokedAt).not.toBeNull();
    console.info(
      "STEP 5a/6b: removal from another session ends bound HTTP session (401), Runner reports 4010, heal forgets identity",
    );
    sessionHeaders = otherHeaders;
    const second = await service.setUpDevice({
      deploymentId,
      enrollmentToken: await mint("second"),
      runAgents: false,
      runnerName: "New identity",
    });
    expect(second.runner.runnerId).not.toBe(runnerId);
    const secondIdentity = JSON.parse(await readFile(identityPath, "utf8")) as {
      privateKeyPem: string;
      runnerId: string;
    };
    const leaveContext = {
      deploymentId,
      runnerId: second.runner.runnerId!,
      issuedAt: new Date().toISOString(),
    };
    const proof = {
      ...leaveContext,
      signature: createDeviceLeaveSignature(
        createPrivateKey(secondIdentity.privateKeyPem),
        leaveContext,
      ),
    };
    const leave = (body: typeof proof) =>
      fetch(new URL("/v1/runner/leave", home.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await leave(proof);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "removed" });
    }
    await waitForRemoval();
    await service.shutdown();
    service.dispose();
    service = createService();
    const third = await service.setUpDevice({
      deploymentId,
      enrollmentToken: await mint("third"),
      runAgents: false,
      runnerName: "Newer identity",
    });
    expect((await leave({ ...proof, runnerId: third.runner.runnerId! })).status).toBe(403);
    expect((await leave(proof)).status).toBe(200);
    expect((await service.status(deploymentId)).runner.state).toBe("running");
    console.info(
      "STEP 5b: signed HTTP self-leave is idempotent; replay cannot revoke newer enrolled identity",
    );
    expect(
      (
        await home.store.database
          .selectFrom("runners")
          .select("revokedAt")
          .where("id", "=", third.runner.runnerId!)
          .executeTakeFirstOrThrow()
      ).revokedAt,
    ).toBeNull();
    await service.shutdown();
    service.dispose();
    await writeFile(membershipFile, '{"version":5,"runners":{}}', { mode: 0o600 });
    await command({
      type: "machine.revoke",
      machineId: third.runner.runnerId!,
      idempotencyKey: "remove-offline",
    });
    service = createService();
    await service.startIfEnabled();
    await service.reconcile();
    expect((await service.status(deploymentId)).membership?.state).toBe("removed");
    await expect(readFile(identityPath)).rejects.toThrow();
    console.info(
      "STEP 6c: empty-membership heal against a Host tombstone receives 4010 and forgets the identity",
    );
    await service.shutdown();
    service.dispose();
    const source = {
      kind: "account" as const,
      issuer: "https://accounts.opensteer.test",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`),
    };
    catalog = {
      ...fullCatalog,
      deployments: fullCatalog.deployments.map((connection) => ({
        ...connection,
        capabilities: [],
        source,
      })),
    };
    service = createService();
    sessionHeaders = otherHeaders;
    await service.setUpDevice({ deploymentId, runnerName: "Legacy Mac", runAgents: false });
    const legacyReceipt = await command({
      type: "runner.enrollment.createLocal",
      name: "Legacy Mac",
      allowedModules: ["browser", "integrations", "messaging", "shell"],
      idempotencyKey: "legacy-mint",
    });
    if (legacyReceipt.type !== "runner.enrollment.createLocal")
      throw new Error("Missing legacy receipt");
    const legacy = await service.start({
      deploymentId,
      enrollmentToken: legacyReceipt.token,
      runnerName: "Legacy Mac",
      runAgents: false,
    });
    legacySessionCleared = false;
    leaveFetch.mockImplementation(async () => new Response(null, { status: 404 }));
    await service.leaveAccountMemberships();
    expect(leaveFetch).not.toHaveBeenCalled();
    expect((await service.status(deploymentId)).membership).toMatchObject({
      state: "removed",
      leaveUnconfirmed: false,
    });
    expect(
      (
        await home.store.database
          .selectFrom("runners")
          .select("revokedAt")
          .where("id", "=", legacy.runner.runnerId!)
          .executeTakeFirstOrThrow()
      ).revokedAt,
    ).not.toBeNull();
    await service.setUpDevice({ deploymentId, runnerName: "Legacy rejoin", runAgents: false });
    const again = await command({
      type: "runner.enrollment.createLocal",
      name: "Legacy rejoin",
      allowedModules: ["browser", "integrations", "messaging", "shell"],
      idempotencyKey: "legacy-again",
    });
    if (again.type !== "runner.enrollment.createLocal") throw new Error("Missing rejoin receipt");
    const rejoined = await service.start({
      deploymentId,
      enrollmentToken: again.token,
      runnerName: "Legacy rejoin",
      runAgents: false,
    });
    expect(rejoined.runner.runnerId).not.toBe(legacy.runner.runnerId);
    console.info(
      "STEP 7: legacy setup → Account sign-out uses authenticated removal before discarding session → rejoin succeeds with no signed-leave endpoint",
    );
  } finally {
    await service?.shutdown();
    service?.dispose();
    for (const child of workers)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await withTimeout(Promise.all(exits), 5000, {
      timeoutError: () => new Error("Runner child did not exit during cleanup"),
    });
    await host?.close();
    await database.drop();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it.each(["before", "after"] as const)(
  "reconciles prepared issuance whose reply fails %s Host commit using signed key retirement",
  async (boundary) => {
    const root = await mkdtemp(path.join(tmpdir(), "devices-issuance-"));
    const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    let host: Awaited<ReturnType<typeof startPersonalMachineHost>> | undefined;
    let service: LocalRunnerService | undefined;
    try {
      host = await startPersonalMachineHost({ databaseUrl: database.url, remoteAccess: true });
      const home = host;
      const deploymentId = home.runtime.deployment.id;
      const keys = testHostAuthorityKeys();
      const authority = signTestDiscoveryEnvelope(
        {
          deploymentId,
          hostInstanceId: createId("hostInstance"),
          canonicalOrigin: home.origin.origin,
          hostKey: { algorithm: "Ed25519" },
          deploymentShape: { kind: "personal" },
        },
        keys,
      );
      const origin = "https://issuance-fixture.opensteer.test";
      const accessRoute = signTestPersonalAccessRoute(
        {
          authority: { ...authority.document, deploymentShape: { kind: "personal" } },
          documentVersion: 2,
          purpose: "opensteer-personal-access-route",
          route: { generation: 1, kind: "private", origin },
        },
        keys,
      );
      const { config } = readDesktopConfiguration({
        appDataDirectory: root,
        defaultMode: "development",
        packaged: false,
        environment: { OPENSTEER_DESKTOP_DATA_DIR: root },
      });
      const signedLeaves = vi.fn<typeof fetch>(async (_url, init) => {
        const response = await fetch(new URL("/v1/runner/leave", home.origin), init);
        return new Response(await response.text(), {
          status: response.status,
          headers: response.headers,
        });
      });
      const createService = () =>
        new LocalRunnerService(config, {
          targets: {
            resolve: async () => ({
              authority,
              accessRoute,
              deploymentId,
              deploymentShape: { kind: "personal" },
              source: { kind: "manual" },
              devicesAvailable: true,
              hostUrl: origin,
              key: "fixture",
              mayRunAgents: false,
            }),
            isCurrent: async () => true,
            subscribe: () => () => undefined,
          },
          fork: () => {
            throw new Error("Cancellation must not start a worker");
          },
          leaveFetch: signedLeaves,
        });
      service = createService();
      const input = { deploymentId, runnerName: "Prepared Mac", runAgents: false };
      const neverIssued = await service.prepareDeviceSetup(input);
      await service.leaveDeployment({ deploymentId });
      expect(signedLeaves).not.toHaveBeenCalled();
      await service.setUpDevice(input);
      const prepared = await service.prepareDeviceSetup(input);
      expect(prepared.runnerId).not.toBe(neverIssued.runnerId);
      const command = {
        type: "runner.enrollment.createLocal" as const,
        name: "Prepared Mac",
        allowedModules: boundary === "before" ? ["agents" as const] : ["shell" as const],
        preparedIdentity: prepared,
        idempotencyKey: "ambiguous",
      };
      if (boundary === "before")
        await testRpcData(
          home.origin,
          "commands.dispatch",
          {
            type: "runner.enrollment.createLocal",
            name: "Another setup",
            allowedModules: ["shell"],
            idempotencyKey: "ambiguous",
          },
          { headers: home.ownerHeaders },
        );
      await expect(
        service.withPreparedEnrollment(deploymentId, command, async () => {
          expect(
            (
              await readMemberships(
                path.join(config.localExecution.dataDirectory, "desktop-runner.json"),
              )
            ).runners[deploymentId]?.issuanceStarted,
          ).toBe(true);
          const response = await testRpcRequest(home.origin, "commands.dispatch", command, {
            headers: home.ownerHeaders,
          });
          expect(response.status).toBe(boundary === "before" ? 409 : 200);
          throw new Error("Issuance reply was lost");
        }),
      ).rejects.toThrow("Issuance reply was lost");
      await service.shutdown();
      service.dispose();
      service = createService();
      await service.leaveDeployment({ deploymentId });
      expect((await service.status(deploymentId)).membership).toMatchObject({
        state: "removed",
        leaveUnconfirmed: false,
      });
      const retired = await home.store.database
        .selectFrom("deviceSetupRetirements")
        .select("runnerId")
        .where("runnerId", "=", prepared.runnerId)
        .executeTakeFirst();
      expect(retired?.runnerId).toBe(prepared.runnerId);
      const late = await testRpcRequest(
        home.origin,
        "commands.dispatch",
        { ...command, allowedModules: ["shell"], idempotencyKey: "late" },
        { headers: home.ownerHeaders },
      );
      expect(late.status).toBe(403);
      await service.setUpDevice(input);
      expect((await service.prepareDeviceSetup(input)).runnerId).not.toBe(prepared.runnerId);
    } finally {
      await service?.shutdown();
      service?.dispose();
      await host?.close();
      await database.drop();
      await rm(root, { force: true, recursive: true });
    }
  },
);

it("keeps person and Guest placement while Browser is off and continues a pending access Request", async () => {
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
  const closers: (() => Promise<unknown>)[] = [() => database.drop()];
  try {
    const home = await startMachineAccessWireHost(database.url, {
      remoteAccess: true,
      manualRunner: true,
    });
    closers.unshift(() => home.close());
    const caller = await connectCallerMachine(home, {
      name: "Home",
      token: home.hostingRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    const minted = await testRpcData(
      home.origin,
      "commands.dispatch",
      {
        type: "runner.enrollment.createLocal",
        name: "Browser Mac",
        allowedModules: ["browser"],
        idempotencyKey: "browser-enroll",
        access: { browser: true, apps: false, files: false },
      },
      { headers: home.ownerHeaders },
    );
    if (minted.type !== "runner.enrollment.createLocal")
      throw new Error("Wrong enrollment receipt");
    const browser = await startBrowserRuntime(home.hostPort, minted.token, {
      agentReady: true,
      navigation: true,
    });
    closers.unshift(() => browser.close());
    const run = await dispatchCallerRun(home, caller, {
      key: "request-browser",
      title: "Use browser",
    });
    const beforeOff = await home.store.database
      .selectFrom("runners")
      .select(["accessPolicy", "accessPolicyRevision"])
      .where("id", "=", browser.runnerId)
      .executeTakeFirstOrThrow();
    const { apps: _apps, browser: _browser, ...shellPolicy } = beforeOff.accessPolicy;
    const off = await testRpcData(
      home.origin,
      "commands.dispatch",
      {
        type: "machine.access.update",
        runnerId: browser.runnerId,
        expectedRevision: beforeOff.accessPolicyRevision,
        policy: { ...shellPolicy, browser: false },
        idempotencyKey: "browser-off",
      },
      { headers: home.ownerHeaders },
    );
    expect(off).toMatchObject({ outcome: "updated" });
    const machines = await testRpcData(
      home.origin,
      "machines.list",
      {},
      { headers: home.ownerHeaders },
    );
    const bootstrap = await testRpcData(
      home.origin,
      "bootstrap.get",
      {},
      { headers: home.ownerHeaders },
    );
    expect(
      newTabTarget(
        { machines: machines.machines, browserProfileHomes: bootstrap.browser.profileHomes },
        { kind: "guest" },
        browser.runnerId,
      ),
    ).toEqual({
      identity: { kind: "guest" },
      placement: { kind: "runner", runnerId: browser.runnerId },
    });
    const person = await testRpcData(
      home.origin,
      "commands.dispatch",
      {
        type: "browser.session.start",
        idempotencyKey: "guest-here",
        input: {
          fresh: true,
          placement: { kind: "runner", runnerId: browser.runnerId },
          reuseExisting: false,
        },
      },
      { headers: home.ownerHeaders },
    );
    if (person.type !== "browser.session.start") throw new Error("Wrong browser receipt");
    expect(person.session).toMatchObject({
      placement: { kind: "runner", runnerId: browser.runnerId },
      profileId: null,
      state: "ready",
    });
    expect(browser.lastClaims()?.identity).toEqual({ kind: "fresh" });
    const agentInput = { agentBindingId: `run:${run.runId}`, ownerId: home.ownerId };
    await expect(
      home.runtime.browser.openAgentSession({ ...agentInput, sessionId: person.session.id }),
    ).rejects.toMatchObject({
      reason: "device-access-off",
      machineId: browser.runnerId,
      capability: "browser",
    });
    await expect(
      home.runtime.browser.start({
        ...agentInput,
        origin: "agent",
        fresh: true,
        placement: { kind: "runner", runnerId: browser.runnerId },
      }),
    ).rejects.toMatchObject({ reason: "device-access-off" });
    expect(browser.streamOpen()).toBe(true);
    console.info(
      "STEP 3a: real signed browser stream stays up; agent open/attach refused device-access-off; person Guest opens on chosen here runner",
    );
    const opened = Promise.withResolvers<string>();
    const create = home.store.requests.createDeviceAccessRequest.bind(home.store.requests);
    vi.spyOn(home.store.requests, "createDeviceAccessRequest").mockImplementation(
      async (...args) => {
        const result = await create(...args);
        opened.resolve(result.request.id);
        return result;
      },
    );
    const stopped = Promise.withResolvers<void>();
    const stop = home.store.stopHeldRun.bind(home.store);
    vi.spyOn(home.store, "stopHeldRun").mockImplementation(async (...args) => {
      const result = await stop(...args);
      if (args[1] === "device-access") stopped.resolve();
      return result;
    });
    const held = callMcpTool(home.origin, run.toolsToken, "device_access_request", {
      machineId: browser.runnerId,
      access: "browser",
      reason: "Use browser",
    });
    void held.catch(() => undefined);
    const requestId = await withTimeout(opened.promise, 5000, {
      timeoutError: () => new Error("Browser access Request never created"),
    });
    const row = await home.store.database
      .selectFrom("runners")
      .select(["accessPolicy", "accessPolicyRevision"])
      .where("id", "=", browser.runnerId)
      .executeTakeFirstOrThrow();
    await testRpcData(
      home.origin,
      "commands.dispatch",
      {
        type: "machine.access.update",
        runnerId: browser.runnerId,
        expectedRevision: row.accessPolicyRevision,
        policy: { ...row.accessPolicy, browser: true },
        idempotencyKey: "enable-browser",
      },
      { headers: home.ownerHeaders },
    );
    await withTimeout(stopped.promise, 5000, {
      timeoutError: () => new Error("Browser access fulfillment never stopped stale Run"),
    });
    const next = waitForExecute(caller.primary.socket);
    await run.reportInterrupted();
    const continuation = await next;
    expect(continuation.command.context.runId).not.toBe(run.runId);
    const continued = await acceptCallerRun(home, caller, continuation);
    await continued.complete();
    await held.catch(() => undefined);
    expect((await home.store.requests.get(RequestIdSchema.parse(requestId)))?.status).toBe(
      "fulfilled",
    );
    console.info(
      "STEP 3b: HTTP Browser=true CAS fulfills durable device.access Request and dispatches continuation Run",
    );
  } finally {
    await cleanup();
  }
  async function cleanup() {
    vi.restoreAllMocks();
    const errors: unknown[] = [];
    for (const close of closers) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Browser E2E cleanup failed");
  }
}, 60000);
