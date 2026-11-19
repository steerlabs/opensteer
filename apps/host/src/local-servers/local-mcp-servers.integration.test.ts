import { localNamespace } from "../plugins/provider-names.js";
import { beforeEach } from "vitest";
import { clearPersonalMachineFixture } from "../runtime/private-machine-host.test-support.js";
/** Host-owner consent, exact launch binding, Runner execution and teardown on real sockets. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IntegrationPlatformStore } from "@opensteer/database";
import type { ComputerAppSetupRequest } from "@opensteer/integration-core/computer-app-setup";
import type { LocalMcpLaunch } from "@opensteer/integration-core/local-mcp";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";

import { LocalMcpServers, prepareIntegrationsModule, type LocalMcpFrame } from "@opensteer/runner";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  startFakeDesktop,
} from "../computer-apps/computer-apps.test-support.js";
import { failureMessage, pluginCall } from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  configurePersonalRemoteAccess,
  createMachineAccessDatabase,
  dispatchCallerRun,
  startPrivateMachineHost,
  waitForCondition,
  type MachineAccessHost,
} from "../runtime/private-machine-host.test-support.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// These need a PostgreSQL test database, which `pnpm test:integration` provides.
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";

integration("MCP servers on a computer", () => {
  beforeEach(() => clearPersonalMachineFixture(databaseUrl!));
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  let closeCurrent: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeCurrent?.();
    closeCurrent = undefined;
  }, 60_000);

  it("runs a plugin's server on the Mac its owner approved it on, and nowhere else", async () => {
    const artifactDirectory =
      process.env.OPENSTEER_LOCAL_MCP_E2E_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-local-mcp-e2e-")));
    const steps: { readonly observed: unknown; readonly step: string }[] = [];
    const record = (step: string, observed: unknown) => steps.push({ observed, step });
    let failure: unknown = null;
    let serverState: (() => Promise<unknown>) | undefined;
    try {
      const work = await mkdtemp(join(tmpdir(), "opensteer-local-mcp-"));
      const fixture = await pluginFixture(work);
      const host = await startPrivateMachineHost(databaseUrl, { remoteAccess: true });
      // What the Host held for the server, written beside a failure.
      serverState = async () =>
        host.store.database
          .selectFrom("integrationServers")
          .select(["approvedLaunchDigest", "id", "status", "statusDetail"])
          .execute();
      const closers: (() => Promise<void>)[] = [() => host.close()];
      closeCurrent = async () => {
        for (const close of closers) await close().catch(() => undefined);
      };
      const caller = await connectCallerMachine(host, {
        name: "Caller",
        token: await host.hostingRunnerEnrollmentToken,
      });
      closers.unshift(() => caller.close());
      const desktop = await startFakeDesktop();
      closers.unshift(() => desktop.close());
      const prepare = async (dataDirectory: string) => {
        const prepared = await prepareIntegrationsModule({
          computerUseBridge: { token: desktop.token, url: desktop.url },
          dataDirectory,
          platform: "darwin",
        });
        const { computerUse, localMcp } = prepared ?? {};
        if (!prepared || !computerUse || !localMcp) {
          throw new Error("A Mac with its desktop runs MCP servers");
        }
        closers.push(async () => computerUse.close());
        return { computerUse, localMcp, providers: prepared.providers };
      };
      const runnerData = join(work, "runner");
      const mac = await prepare(runnerData);
      const computer = await connectComputerAppMachine(host, mac.providers, {
        desktop: { computerUse: mac.computerUse, localMcp: mac.localMcp },
      });
      closers.unshift(() => computer.close());

      // 1. Installed, pinned to the Mac, and nothing started anywhere yet.
      await host.runtime.localServers.installPackage({
        actorUserId: host.ownerId,
        directory: fixture.plugin,
        registration: fixture.registration,
        requestId: "local-mcp-install",
        runnerId: computer.runnerId,
      });
      const server = await serverRow(host);
      const namespace = localNamespace("notes-fixture", `app_server_${server.id}`);
      expect(server.transport).toMatchObject({ runnerId: computer.runnerId, type: "runner" });
      expect(server.status).toBe("needs-attention");
      const launch = (server.transport as { readonly launch: LocalMcpLaunch }).launch;
      expect(launch).toMatchObject({ command: "sh", type: "stdio" });
      expect(await readPid(fixture.pidFile)).toBeNull();
      record("installed and waiting", { launch, server: server.id });

      // Review is owner-only; summaries never carry launch secrets.
      const asked = await waitingRequest(host, server.id);
      expect(asked.server?.launch).toEqual(launch);
      expect(asked.definitionDigest).toBe(localMcpLaunchDigest(launch));
      const persistedTarget = await host.store.database
        .selectFrom("computerAppSetupRequests")
        .select("runnerId as deviceId")
        .where("id", "=", asked.id)
        .executeTakeFirstOrThrow();
      expect(persistedTarget.deviceId).toBe(
        await host.store.requireSelfDeviceId(computer.runnerId),
      );

      const summaries = await testRpcData(
        host.origin,
        "integration.computer.setup.list",
        {},
        { headers: host.ownerHeaders },
      );
      expect(summaries.requests.find(({ id }) => id === asked.id)?.server).not.toHaveProperty(
        "launch",
      );
      const reviewed = await testRpcData(
        host.origin,
        "integration.computer.setup.review",
        { setupRequestId: asked.id },
        { headers: host.ownerHeaders },
      );
      expect(reviewed.request.server?.launch).toEqual(launch);
      // It says what allowing covers: the command, and the files of its folder it runs.
      expect(reviewed.request.reason).toMatch(
        /^Allowing it covers this command and the 1 file in its folder \(\d+\.\d KB\); a program it starts from elsewhere on this computer is covered by its command only\.$/u,
      );

      // 3. Approved on the Mac: started there once, and its tools listed.
      const approved = await computer.answer(asked.id, {
        setupRequestId: asked.id,
        kind: "allow",
      });
      expect(approved.kind).toBe("allowed");
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      const tools = await host.store.database
        .selectFrom("integrationTools")
        .select("name")
        .where("serverId", "=", server.id)
        .where("status", "=", "active")
        .orderBy("name", "asc")
        .execute();
      expect(tools.map(({ name }) => name)).toEqual([
        "crash",
        "echo",
        "huge",
        "malformed",
        "note",
        "orphan",
        "pid",
        "unframed",
      ]);
      expect(await readPid(fixture.pidFile)).not.toBeNull();
      record("approved and discovered", tools);

      const fence = {
        auxiliaryStreamId: "rax_00000000-0000-4000-8000-000000000000",
        bootId: "rbt_00000000-0000-4000-8000-000000000000",
        connectionGeneration: 1,
        connectionId: "rcn_00000000-0000-4000-8000-000000000000",
        connectionLeaseId: "rls_00000000-0000-4000-8000-000000000000",
        module: "integrations",
        runnerId: computer.runnerId,
      } as const;
      // A spawn error can both reject start() and emit onerror. It still ends
      // one session exactly once, with no spurious opened frame.
      const failedLaunch: LocalMcpLaunch = {
        type: "stdio",
        command: join(work, "missing-program"),
        args: [],
        cwd: work,
        env: {},
      };
      const failedFrames: LocalMcpFrame[] = [];
      const failing = new LocalMcpServers();
      failing.attach(async (frame) => {
        failedFrames.push(frame);
      });
      await failing.open({
        ...fence,
        launch: failedLaunch,
        module: "integrations",
        runnerId: computer.runnerId,
        serverId: server.id,
        sessionId: randomUUID(),
        type: "host.integrations.mcp.open",
      } as Parameters<LocalMcpServers["open"]>[0]);
      await waitForCondition(async () => failedFrames.length > 0);
      expect(failedFrames).toEqual([
        expect.objectContaining({
          type: "runner.integrations.mcp.closed",
          error: expect.objectContaining({ code: "failed" }),
        }),
      ]);
      failing.detach();
      record("failed spawn closed exactly once", failedFrames);

      // 5. A Run's agent reaches the server on the Mac, and back.
      const run = await dispatchCallerRun(host, caller, {
        key: "local-mcp-run",
        title: "Take a note",
      });
      closers.unshift(() => run.complete());
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "local-mcp-grant",
          input: {
            access: "read-write",
            alias: "Notes on Studio Mac",
            connectionId: null,
            installationId: server.installationId,
            isDefault: true,
          },
          type: "integration.grant.create",
        },
        { headers: host.ownerHeaders },
      );
      const gateway = await integrationGateway(run.integrationTools);
      closers.unshift(() => gateway.close());
      const listed = async () =>
        JSON.stringify((await gateway.call("plugin_search", { query: "echo" })).items).includes(
          JSON.stringify(`tools[${JSON.stringify(namespace)}].echo`).slice(1, -1),
        );
      const call = async (name: string, args: Record<string, unknown>) =>
        pluginResult(
          await pluginCall(gateway, `tools[${JSON.stringify(namespace)}].${name}`, args),
        );
      await waitForCondition(listed, 30_000);
      expect(said(await call("echo", { text: "hello" }))).toBe("echo: hello");
      expect(said(await call("note", { text: "buy milk" }))).toBe("noted");
      expect(await readFile(fixture.notesFile, "utf8")).toBe("buy milk\n");
      record("called through the gateway", { notes: await readFile(fixture.notesFile, "utf8") });

      // 6. Too large for the stream: that call fails, and the next one works.
      const huge = await call("huge", {});
      expect(huge.isError).toBe(true);
      expect(said(huge)).toBe(
        "notes-fixture's answer was too large to carry from Studio Mac; ask for less.",
      );
      expect(said(await call("echo", { text: "still here" }))).toBe("echo: still here");

      for (const name of ["unframed", "malformed"]) {
        const pid = await readPid(fixture.pidFile);
        if (pid === null) throw new Error("The server is running");
        const started = Date.now();
        const result = await call(name, {});
        expect(result.isError).toBe(true);
        expect(Date.now() - started).toBeLessThan(15_000);
        await waitForCondition(async () => !alive(pid), 5_000);
        expect(said(await call("echo", { text: name }))).toBe(`echo: ${name}`);
        record(`${name} output ended its process and session`, {
          elapsedMs: Date.now() - started,
          pid,
          result: said(result),
        });
      }

      // 7. A write whose answer was lost is unconfirmed, not failed.
      const crashed = await call("crash", {});
      expect(crashed.isError).toBe(true);
      expect(said(crashed)).toBe(
        "Studio Mac did not confirm this. Check whether it happened before trying again.",
      );
      expect(said(await call("echo", { text: "again" }))).toBe("echo: again");
      // The program exits cleanly, but a process it started still holds its
      // output: the session ends with the program, well before the call's
      // deadline, and takes that process with it.
      const orphaned = Date.now();
      expect(said(await call("orphan", {}))).toBe(
        "Studio Mac did not confirm this. Check whether it happened before trying again.",
      );
      expect(Date.now() - orphaned).toBeLessThan(15_000);
      const orphan = await readPid(`${fixture.pidFile}.orphan`);
      if (orphan === null) throw new Error("The program started a process");
      await waitForCondition(async () => !alive(orphan), 15_000);
      expect(said(await call("echo", { text: "after" }))).toBe("echo: after");
      record("large and lost answers", {
        crashed: said(crashed),
        huge: said(huge),
        orphan,
      });

      // 8. Offline: the program ends, its tools stay listed, a call says the Mac is away, and
      // they work again with the Mac.
      const running = await readPid(fixture.pidFile);
      if (running === null) throw new Error("The server is running");
      await computer.disconnectModule();
      await waitForCondition(async () => !alive(running), 15_000);
      const offline = await gateway.call("plugin_search", { namespace });
      expect(offline).toMatchObject({ unavailableApps: [] });
      expect(JSON.stringify(offline)).not.toContain("blocked");
      expect(await listed()).toBe(true);
      const away = await call("echo", { text: "away" });
      expect(away.isError).toBe(true);
      expect(said(away)).toContain("Studio Mac");
      // The person's Plugins screen says when the Mac is back.
      const ownerSees = async () =>
        (
          await testRpcData(
            host.origin,
            "plugins.installed.list",
            {},
            { headers: host.ownerHeaders },
          )
        ).local.find(({ id }) => id === `app_server_${server.id}`)?.unavailable ?? null;
      expect(await ownerSees()).toContain("Studio Mac");
      await computer.reconnectModule();
      await waitForCondition(async () => (await ownerSees()) === null, 30_000);
      expect(said(await call("echo", { text: "back" }))).toBe("echo: back");
      record("offline and back", { offline, away: said(away) });

      // Host-held exact-launch consent survives a fresh Runner instance.
      await computer.disconnectModule();
      const restarted = await prepare(join(work, "restarted-runner"));
      await computer.reconnectModule({
        computerUse: restarted.computerUse,
        localMcp: restarted.localMcp,
      });
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      expect(
        await host.store.database
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("definitionId", "=", server.id)
          .execute(),
      ).toEqual([]);
      // 10. Installed again as it was, twice over, the second while the first
      // is still being listed: still approved, and listed again now.
      for (const key of ["local-mcp-reinstall", "local-mcp-reinstall-again"]) {
        await host.runtime.localServers.installPackage({
          actorUserId: host.ownerId,
          directory: fixture.plugin,
          registration: fixture.registration,
          requestId: key,
          runnerId: computer.runnerId,
        });
      }
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      expect(said(await call("echo", { text: "reinstalled" }))).toBe("echo: reinstalled");
      const reasked = await host.store.database
        .selectFrom("computerAppSetupRequests")
        .select("id")
        .where("kind", "=", "server")
        .execute();
      expect(reasked).toEqual([]);
      record("installed again", { reasked });

      // 11. Registered again with a changed launch: the previous version stops, nothing runs
      // until the Mac's owner allows the new one, and the Request says how it changed.
      const allowAgain = async (expected: RegExp) => {
        const asked = await waitingRequest(host, server.id);
        const changed = (await serverRow(host)).transport as { readonly launch: LocalMcpLaunch };
        expect(asked.definitionDigest).toBe(localMcpLaunchDigest(changed.launch));
        const review = await testRpcData(
          host.origin,
          "integration.computer.setup.review",
          { setupRequestId: asked.id },
          { headers: host.ownerHeaders },
        );
        expect(review.request.reason).toMatch(expected);
        // The tools its approved launch listed stay listed, and the path an agent holds is
        // refused with why it waits, not as unknown.
        const waiting = {
          code: "setup_required",
          message: "Waiting for approval on the computer that runs it.",
          next: "Wait for the person to review it on the computer that runs it.",
        };
        const echo = `tools[${JSON.stringify(namespace)}].echo`;
        expect(await gateway.call("plugin_search", { namespace })).toMatchObject({
          items: expect.arrayContaining([expect.objectContaining({ path: echo })]),
          namespaces: [expect.objectContaining({ blocked: waiting })],
        });
        const refused = await pluginCall(gateway, echo, { text: "unapproved" });
        expect(refused.raw).toMatchObject({ isError: true, structuredContent: { error: waiting } });
        expect(
          (await computer.answer(asked.id, { setupRequestId: asked.id, kind: "allow" })).kind,
        ).toBe("allowed");
        await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
        return { launch: changed.launch, review: review.request.reason, refused: refused.failure };
      };
      const previous = Number(said(await call("pid", {})));
      expect(alive(previous)).toBe(true);
      await fixture.changeLaunch();
      await host.runtime.localServers.installPackage({
        actorUserId: host.ownerId,
        directory: fixture.plugin,
        registration: fixture.registration,
        requestId: "local-mcp-changed",
        runnerId: computer.runnerId,
      });
      await waitForCondition(async () => !alive(previous), 15_000);
      const command = await allowAgain(/^How it runs changed since you allowed it\. /u);
      expect(command.launch).not.toEqual(launch);
      expect(said(await call("echo", { text: "changed" }))).toBe("echo: changed");
      record("installed with a changed launch", { previous, ...command });

      // 11b. Registered again with one file changed: asked again, naming that file.
      const edited = Number(said(await call("pid", {})));
      await writeFile(
        join(fixture.plugin, "server.cjs"),
        `${await readFile(join(fixture.plugin, "server.cjs"), "utf8")}// tuned\n`,
      );
      await host.runtime.localServers.installPackage({
        actorUserId: host.ownerId,
        directory: fixture.plugin,
        registration: fixture.registration,
        requestId: "local-mcp-file-changed",
        runnerId: computer.runnerId,
      });
      await waitForCondition(async () => !alive(edited), 15_000);
      const file = await allowAgain(
        /^Changed since you allowed it: changed server\.cjs \([\d.]+ KB → [\d.]+ KB\)\. Allowing it covers/u,
      );
      expect(said(await call("echo", { text: "edited" }))).toBe("echo: edited");
      record("installed with a changed file", { edited, ...file });

      // 12. Uninstalled: nothing waits on the Mac and nothing runs.
      const last = Number(said(await call("pid", {})));
      expect(alive(last)).toBe(true);
      await host.runtime.localServers.uninstall({
        actorUserId: host.ownerId,
        installationId: server.installationId,
        requestId: "local-mcp-uninstall",
      });
      await waitForCondition(async () => !alive(last), 15_000);
      const leftover = await host.store.database
        .selectFrom("computerAppSetupRequests")
        .select("id")
        .where("kind", "=", "server")
        .execute();
      expect(leftover).toEqual([]);
      record("uninstalled", { leftover });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, "result.json"),
        `${JSON.stringify(
          {
            failure: failure instanceof Error ? failure.message : failure,
            passed: failure === null,
            servers: failure === null ? undefined : await serverState?.().catch(String),
            steps,
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 240_000);

  it.each([true])(
    "starts and updates sealed-secret servers (Personal: %s)",
    async (personal) => {
      const work = await mkdtemp(join(tmpdir(), "opensteer-local-mcp-secrets-"));
      const fixture = await secretPluginFixture(work);
      const host = personal
        ? await startPrivateMachineHost(databaseUrl)
        : await startPrivateMachineHost(databaseUrl, { remoteAccess: true });
      const closers: (() => Promise<void>)[] = [() => host.close()];
      closeCurrent = async () => {
        for (const close of closers) await close().catch(() => undefined);
      };
      if (personal)
        await configurePersonalRemoteAccess(host, {
          schemaVersion: 1,
          mode: "private",
          routeOrigin: "https://personal.local-mcp.test",
        });
      const desktop = await startFakeDesktop();
      closers.unshift(() => desktop.close());
      const prepared = await prepareIntegrationsModule({
        computerUseBridge: { token: desktop.token, url: desktop.url },
        dataDirectory: join(work, "runner"),
        platform: "darwin",
      });
      if (!prepared?.computerUse || !prepared.localMcp) throw new Error("A Mac runs MCP servers");
      const { computerUse, localMcp } = prepared;
      closers.push(async () => computerUse.close());
      const computer = await connectComputerAppMachine(host, prepared.providers, {
        desktop: { computerUse, localMcp },
      });
      closers.unshift(() => computer.close());
      const dispatch = (key: string, command: Record<string, unknown>) =>
        testRpcData(
          host.origin,
          "commands.dispatch",
          { idempotencyKey: `${key}:${randomUUID()}`, ...command } as never,
          { headers: host.ownerHeaders },
        );
      const started = (value: string) =>
        waitForCondition(async () => (await readText(fixture.seenFile)) === value, 30_000);

      const install = (key: string, runnerId?: typeof computer.runnerId) =>
        host.runtime.localServers.installPackage({
          actorUserId: host.ownerId,
          directory: fixture.plugin,
          registration: fixture.registration,
          requestId: `${key}:${randomUUID()}`,
          runnerId,
        });
      await install("install", computer.runnerId);
      const server = await serverRow(host);
      const launch = (server.transport as { readonly launch: LocalMcpLaunch }).launch;
      expect(launch).toMatchObject({
        env: expect.not.objectContaining({ CAMERA_PASSWORD: expect.anything() }),
        secrets: [{ name: "CAMERA_PASSWORD", title: "Camera password" }],
      });
      const asked = await waitingRequest(host, server.id);
      const review = (id: string) =>
        testRpcData(
          host.origin,
          "integration.computer.setup.review",
          { setupRequestId: id },
          { headers: host.ownerHeaders },
        );
      expect((await review(asked.id)).savedSecrets).toEqual([]);
      const yours = () =>
        testRpcData(
          host.origin,
          "integration.server.secrets.list",
          {},
          { headers: host.ownerHeaders },
        ).then(({ servers }) => servers);
      // Listed for its computer's owner to change only once allowed there.
      expect(await yours()).toEqual([]);

      // Allowing needs every secret, and only the ones its launch declares.
      const answer = (id: string, secrets?: Record<string, string>) =>
        dispatch("answer", {
          decision: "allow",
          setupRequestId: id,
          ...(secrets ? { secrets } : {}),
          type: "integration.computer.setup.respond",
        });
      await expect(answer(asked.id)).rejects.toThrow("Enter Camera password.");
      await expect(answer(asked.id, { CAMERA_PASSWORD: "x", OTHER: "y" })).rejects.toThrow(
        "This server doesn't ask for OTHER.",
      );
      expect(await readText(fixture.seenFile)).toBeNull();
      expect((await waitingRequest(host, server.id)).id).toBe(asked.id);

      await answer(asked.id, { CAMERA_PASSWORD: "hunter2" });
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      await started("hunter2");
      const sealed = await host.store.database
        .selectFrom("integrationServerSecrets")
        .select("encryptedPayload")
        .where("serverId", "=", server.id)
        .executeTakeFirstOrThrow();
      expect(sealed.encryptedPayload.includes("hunter2")).toBe(false);
      const listed = JSON.stringify(
        await testRpcData(
          host.origin,
          "integration.platform.get",
          {},
          { headers: host.ownerHeaders },
        ),
      );
      expect(listed).not.toContain("hunter2");
      expect(listed).not.toContain("encryptedPayload");
      expect(await yours()).toEqual([
        expect.objectContaining({
          id: server.id,
          name: "camera-fixture",
          plugin: "camera-fixture",
          secrets: [expect.objectContaining({ name: "CAMERA_PASSWORD" })],
        }),
      ]);
      expect(JSON.stringify(await yours())).not.toContain("hunter2");

      // Changed: its running process ends, and the next starts with the new value.
      await dispatch("change", {
        secrets: { CAMERA_PASSWORD: "swordfish" },
        serverId: server.id,
        type: "integration.server.secrets.set",
      });
      await started("swordfish");
      // Values aren't part of the launch, so changing one asks nothing again.
      expect(
        await host.store.database
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("kind", "=", "server")
          .execute(),
      ).toEqual([]);

      // A server that prints its secret as it fails: the reason the Host keeps,
      // lists and tells agents quotes its output, never the secret.
      await dispatch("leak", {
        secrets: { CAMERA_PASSWORD: "leaky-hunter3" },
        serverId: server.id,
        type: "integration.server.secrets.set",
      });
      await waitForCondition(
        async () => (await serverRow(host)).statusDetail?.includes("could not sign in") ?? false,
        30_000,
      );
      expect((await serverRow(host)).statusDetail).not.toContain("leaky-hunter3");
      expect(
        JSON.stringify(
          await testRpcData(
            host.origin,
            "integration.platform.get",
            {},
            { headers: host.ownerHeaders },
          ),
        ),
      ).not.toContain("leaky-hunter3");
      await dispatch("unleak", {
        secrets: { CAMERA_PASSWORD: "swordfish" },
        serverId: server.id,
        type: "integration.server.secrets.set",
      });
      await started("swordfish");

      // A new launch is asked about again; leaving the field blank keeps the value.
      await fixture.changeLaunch();
      await install("update");
      const askedAgain = await waitingRequest(host, server.id);
      expect((await review(askedAgain.id)).savedSecrets).toEqual(["CAMERA_PASSWORD"]);
      await expect(
        dispatch("early", {
          secrets: { CAMERA_PASSWORD: "too-early" },
          serverId: server.id,
          type: "integration.server.secrets.set",
        }),
      ).rejects.toThrow("It's waiting for approval.");
      await writeFile(fixture.seenFile, "");
      await answer(askedAgain.id);
      await started("swordfish:2");
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      expect((await serverRow(host)).transport).toMatchObject({ runnerId: computer.runnerId });
      // Registered again exactly so: nothing changes and nothing is asked.
      const before = await serverRow(host);
      const versions = await host.store.database
        .selectFrom("pluginVersions")
        .select("id")
        .execute();
      await install("unchanged");
      expect(await serverRow(host)).toEqual(before);
      expect(await host.store.database.selectFrom("pluginVersions").select("id").execute()).toEqual(
        versions,
      );
      expect(
        await host.store.database
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("kind", "=", "server")
          .execute(),
      ).toEqual([]);

      if (personal) {
        const declare = async (names: string[]) => {
          fixture.registration.launch!.secrets = names.length
            ? names.map((name) => ({ name, title: name }))
            : undefined;
          await install("declare");
        };
        await declare(["CAMERA_PASSWORD", "EXTRA_PASSWORD"]);
        let next = await waitingRequest(host, server.id);
        expect((await review(next.id)).savedSecrets).toEqual(["CAMERA_PASSWORD"]);
        await answer(next.id, { EXTRA_PASSWORD: "extra" });
        await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
        await declare(["RENAMED_PASSWORD"]);
        next = await waitingRequest(host, server.id);
        expect((await review(next.id)).savedSecrets).toEqual([]);
        expect(
          await host.store.database
            .selectFrom("integrationServerSecrets")
            .select("serverId")
            .execute(),
        ).toEqual([]);
        await answer(next.id, { RENAMED_PASSWORD: "renamed" });
        await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
        await declare([]);
        next = await waitingRequest(host, server.id);
        await answer(next.id);
        await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
        expect(
          await host.store.database
            .selectFrom("integrationServerSecrets")
            .select("serverId")
            .execute(),
        ).toEqual([]);
        expect(
          await host.store.database
            .selectFrom("computerAppSetupRequests")
            .select("id")
            .where("kind", "=", "server")
            .execute(),
        ).toEqual([]);
        fixture.registration.name = "second";
        await install("new-server");
        const second = await host.store.database
          .selectFrom("integrationServers")
          .selectAll()
          .where("name", "=", "second")
          .executeTakeFirstOrThrow();
        const secondRequest = await waitingRequest(host, second.id);
        await dispatch("decline", {
          type: "integration.computer.setup.respond",
          decision: "deny",
          setupRequestId: secondRequest.id,
        });
        await install("reinstall-declined");
        expect((await waitingRequest(host, second.id)).id).not.toBe(secondRequest.id);
      }

      // Uninstalled: its secrets go with it.
      await host.runtime.localServers.uninstall({
        actorUserId: host.ownerId,
        installationId: server.installationId,
        requestId: "uninstall",
      });
      expect(
        await host.store.database
          .selectFrom("integrationServerSecrets")
          .select("serverId")
          .execute(),
      ).toEqual([]);
    },
    180_000,
  );
});

/** A plugin call as the old tests read a tool result: its text, and whether it failed. */
function pluginResult(result: Awaited<ReturnType<typeof pluginCall>>) {
  return result.failure === undefined
    ? {
        isError: false,
        text: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
      }
    : { isError: true, text: failureMessage(result.failure) };
}
function said(result: ReturnType<typeof pluginResult>): string {
  return result.text;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** A plugin whose one server asks for a camera password and records what it started with. */
async function secretPluginFixture(work: string) {
  const plugin = join(work, "plugin");
  await mkdir(plugin, { recursive: true });
  const require = createRequire(import.meta.url);
  const sdk = (path: string) =>
    JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
  const seenFile = join(work, "seen.txt");
  const registration = {
    name: "camera-fixture",
    launch: {
      command: "node",
      args: ["${PLUGIN_ROOT}/server.cjs"],
      env: { SEEN_FILE: seenFile } as Record<string, string>,
      secrets: [
        {
          name: "CAMERA_PASSWORD",
          title: "Camera password",
          description: "The camera account password from the Tapo app.",
        },
      ] as { name: string; title: string; description?: string }[] | undefined,
    },
  };
  const writeLaunch = async (env: Record<string, string>) => {
    registration.launch.env = { SEEN_FILE: seenFile, ...env };
  };

  await writeFile(
    join(plugin, "server.cjs"),
    `const { writeFileSync } = require("node:fs");
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { ListToolsRequestSchema } = require(${sdk("types.js")});
writeFileSync(process.env.SEEN_FILE, (process.env.CAMERA_PASSWORD ?? "") + (process.env.CAMERA_EDITION ? ":" + process.env.CAMERA_EDITION : ""));
if (process.env.CAMERA_PASSWORD?.startsWith("leaky")) {
  console.error("could not sign in with " + process.env.CAMERA_PASSWORD);
  process.exit(1);
}
const server = new Server({ name: "camera-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ annotations: { readOnlyHint: true }, description: "Snapshot", inputSchema: { type: "object" }, name: "snapshot" }],
}));
server.connect(new StdioServerTransport());
`,
  );
  return {
    registration,
    changeLaunch: () => writeLaunch({ CAMERA_EDITION: "2" }),
    plugin,
    seenFile,
  };
}

async function serverRow(host: MachineAccessHost) {
  return host.store.database
    .selectFrom("integrationServers")
    .select(["id", "installationId", "status", "statusDetail", "transport"])
    .where(({ ref }) => ref("transport", "->>").key("type"), "=", "runner")
    .executeTakeFirstOrThrow();
}

async function waitingRequest(
  host: MachineAccessHost,
  serverId: string,
): Promise<ComputerAppSetupRequest> {
  let found: ComputerAppSetupRequest | undefined;
  await waitForCondition(async () => {
    const requests = await new IntegrationPlatformStore(
      host.store.database,
    ).listComputerAppSetupRequests(host.ownerId);
    found = requests.find(
      (request) => request.kind === "server" && request.definitionId === serverId,
    );
    return found !== undefined;
  }, 15_000);
  if (!found) throw new Error("The Mac was not asked");
  return found;
}

async function readPid(file: string): Promise<number | null> {
  try {
    return Number((await readFile(file, "utf8")).trim());
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * An Agent Plugin with one stdio MCP server: a program written with the MCP
 * SDK that echoes, appends notes to a file, answers larger than a stream
 * frame, or exits mid-call, and records its process id when it starts.
 */
async function pluginFixture(work: string) {
  const plugin = join(work, "plugin");
  await mkdir(plugin, { recursive: true });
  const require = createRequire(import.meta.url);
  const sdk = (path: string) =>
    JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
  const pidFile = join(work, "server.pid");
  const notesFile = join(work, "notes.txt");
  const registration = {
    name: "notes-fixture",
    launch: {
      command: "sh",
      args: ["-c", 'node "$PLUGIN_ROOT/server.cjs"; exit $?'],
      env: { NOTES_FILE: notesFile, PID_FILE: pidFile } as Record<string, string>,
    },
  };
  const writeLaunch = async (env: Record<string, string>) => {
    registration.launch.env = { NOTES_FILE: notesFile, PID_FILE: pidFile, ...env };
  };

  await writeFile(
    join(plugin, "server.cjs"),
    `const { appendFileSync, writeFileSync } = require("node:fs");
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { CallToolRequestSchema, ListToolsRequestSchema } = require(${sdk("types.js")});
writeFileSync(process.env.PID_FILE, String(process.pid));
const text = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const server = new Server({ name: "notes-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { annotations: { readOnlyHint: true }, description: "Echo", inputSchema: text, name: "echo" },
    { description: "Append a note", inputSchema: text, name: "note" },
    { annotations: { readOnlyHint: true }, description: "Too big", inputSchema: { type: "object" }, name: "huge" },
    { annotations: { readOnlyHint: true }, description: "Never ends its frame", inputSchema: { type: "object" }, name: "unframed" },
    { annotations: { readOnlyHint: true }, description: "Invalid JSON", inputSchema: { type: "object" }, name: "malformed" },
    { description: "Stop mid-call", inputSchema: { type: "object" }, name: "crash" },
    { annotations: { readOnlyHint: true }, description: "Its process", inputSchema: { type: "object" }, name: "pid" },
    { description: "Exit, leaving a process holding stdout", inputSchema: { type: "object" }, name: "orphan" },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === "echo") return { content: [{ text: "echo: " + params.arguments.text, type: "text" }] };
  if (params.name === "note") {
    appendFileSync(process.env.NOTES_FILE, params.arguments.text + "\\n");
    return { content: [{ text: "noted", type: "text" }] };
  }
  if (params.name === "huge") return { content: [{ text: "x".repeat(1200000), type: "text" }] };
  if (params.name === "unframed" || params.name === "malformed") {
    process.stdout.write(params.name === "unframed" ? "x".repeat(17 * 1024 * 1024) : "not json\\n");
    await new Promise(() => {});
  }
  if (params.name === "crash") process.exit(3);
  if (params.name === "pid") return { content: [{ text: String(process.pid), type: "text" }] };
  if (params.name === "orphan") {
    const child = require("node:child_process").spawn("sleep", ["120"], { stdio: ["ignore", "inherit", "inherit"] });
    writeFileSync(process.env.PID_FILE + ".orphan", String(child.pid));
    process.exit(0);
  }
  throw new Error("Unknown tool");
});
server.connect(new StdioServerTransport());
`,
  );
  await mkdir(dirname(pidFile), { recursive: true });
  return {
    /** The same server, launched differently. */
    registration,
    changeLaunch: () => writeLaunch({ NOTES_EDITION: "2" }),
    notesFile,
    pidFile,
    plugin,
  };
}
