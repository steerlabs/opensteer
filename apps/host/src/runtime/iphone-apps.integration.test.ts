import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { channelProviderCatalog } from "@opensteer/channel-core";
import { computerAppIntegrations } from "@opensteer/integration-catalog";
import {
  isComputerAppDefinition,
  type ComputerAppSetupRequest,
  type IntegrationAccess,
} from "@opensteer/integration-core";
import {
  HostIntegrationsComputerAppApprovalKeyChallengeSchema,
  HostIntegrationsInvokeSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  hostApi,
  type RunnerDescriptor,
  type ComputerAppStatusEntry,
  type ComputerAppApprovalAnswer,
  type ComputerAppApprovalKeyChallenge,
  type ComputerAppApprovalOutcome,
} from "@opensteer/protocol";
import {
  computerAppApprovalKeyId,
  createComputerAppApproval,
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
  signComputerAppApprovalKeyChallenge,
} from "@opensteer/runner-auth";
import { z } from "zod";
import { createHostRuntime } from "./runtime.js";
import { sql } from "kysely";
import { iphoneDeviceProfileMigration, createDatabase } from "@opensteer/database";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  openAuxiliaryStream,
  operation,
  operations,
  requestComputerAppSetup,
  setComputerApp,
  toolReadiness,
  toolText,
  waitForClose,
  waitForMessage,
} from "./computer-apps.test-support.js";
import {
  closed,
  configurePersonalRemoteAccess,
  connectCallerMachine,
  connectPrimary,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  openRealtime,
  resetMachineAccessDatabase,
  revokeMachine,
  signUpUser,
  startMachineAccessHost,
  startPersonalMachineAccessHost,
  waitForCondition,
  type MachineAccessHost,
} from "./machine-access.test-support.js";

// H1–H16, written before implementation. The phone is scripted, not Swift/EventKit.
const baseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseUrl ? describe : describe.skip;
const methods = [
  "bootstrap.get",
  "machines.list",
  "integrations.get",
  "integration.platform.get",
  "integration.computer.setup.list",
] as const;
const envelope = z.object({ ok: z.literal(true), data: z.unknown() });
const apps = ["apple-calendar", "apple-contacts", "apple-reminders"];
const mismatch = "runner-device-profile-mismatch";
const offline = (name: string) =>
  `${name} is an iPhone, and agents can use its apps only while Opensteer is open on it. Ask the person to open Opensteer on ${name}, then try again; don't retry in a loop.`;

integration.sequential("iPhone integrations Host contract", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  let host: MachineAccessHost;
  let directory: string;
  const closers: (() => Promise<void>)[] = [];
  const results: { name: string; state: string; errors: string[] }[] = [];
  beforeAll(async () => {
    directory =
      process.env.OPENSTEER_IPHONE_APPS_EVIDENCE_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-iphone-apps-")));
    await mkdir(directory, { recursive: true });
    database = await createMachineAccessDatabase(baseUrl!);
    console.info(`iPhone Host evidence: ${directory}`);
  }, 120_000);
  beforeEach(async () => {
    await resetMachineAccessDatabase(database.url);
  });
  afterEach(async ({ task }) => {
    const failures: unknown[] = [];
    for (const close of closers.splice(0)) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    results.push({
      name: task.name,
      state: task.result?.state ?? "unknown",
      errors: task.result?.errors?.map(({ message }) => message) ?? [],
    });
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify(
        {
          boundary: "real PostgreSQL and Host; scripted phone, not Swift/EventKit",
          results,
          passed: results.every(({ state }) => state === "pass"),
        },
        null,
        2,
      ),
    );
    if (failures.length) throw new AggregateError(failures, "iPhone journey cleanup");
  }, 60_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);
  const start = async () => {
    host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    closers.unshift(() => host.close());
    return host;
  };
  const keep = <T extends { close(): Promise<void> }>(value: T): T => {
    closers.unshift(() => value.close());
    return value;
  };

  it("admits new iPhone providers only after their authenticated status, without orphan approvals", async () => {
    await start();
    const phone = keep(
      await connectPhone(
        host,
        (await mint(host, "new-providers")).token,
        iphoneDescriptor(),
        false,
      ),
    );
    const requests = async () =>
      (
        await testRpcData(
          host.origin,
          "integration.computer.setup.list",
          {},
          { headers: host.ownerHeaders },
        )
      ).requests;
    const ask = (definitionId = "iphone-location") =>
      command(host, {
        type: "integration.computer.setup.request",
        idempotencyKey: randomUUID(),
        input: { kind: "app", app: null, access: "read", definitionId, runnerId: phone.runnerId },
      });
    const refuse = async (message: string) => {
      const response = await ask();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "conflict", message: expect.stringContaining(message) },
      });
      expect(await requests()).toEqual([]);
    };
    await phone.heartbeat();
    await refuse("still connecting");
    await phone.report([]);
    await refuse("doesn't offer Location");
    await phone.disconnectStream();
    await waitForCondition(
      async () => (await machines(host)).find(({ id }) => id === phone.runnerId)?.apps === null,
    );
    await refuse("keep it open");
    await phone.reconnect();
    await phone.heartbeat();
    await refuse("still connecting");
    await phone.report(
      ["iphone-location", "iphone-photos"].map((definitionId) => ({
        ...status(definitionId),
        operations: status(definitionId).operations.map((operation) => ({
          ...operation,
          state: "permission-required",
          detail: "Not allowed in iPhone Settings.",
          remedy: null,
        })),
      })),
    );
    for (const definitionId of ["iphone-location", "iphone-photos"]) {
      const response = await ask(definitionId);
      expect(response.status).toBe(200);
    }
    expect((await requests()).map(({ definitionId }) => definitionId).sort()).toEqual([
      "iphone-location",
      "iphone-photos",
    ]);
  }, 60_000);

  it("H1 H5 H15 mints isolated immutable profiles and projects pending phones truthfully", async () => {
    await start();
    const minted = await mint(host, "iphone");
    expect(await mint(host, "iphone")).toEqual(minted);
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
    expect(minted.pairing).toEqual(
      await testRpcData(host.origin, "agentPhone.target.get", {}, { headers: host.ownerHeaders }),
    );
    expect(
      await host.store.database
        .selectFrom("runnerEnrollments")
        .select(["deviceProfile", "allowedModules", "ownerUserId", "runnerKind"])
        .where("id", "=", minted.enrollmentId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      deviceProfile: "iphone",
      allowedModules: ["integrations"],
      ownerUserId: host.ownerId,
      runnerKind: "local",
    });
    const pending = await machines(host);
    expect(pending.find(({ id }) => id === minted.enrollmentId)).toMatchObject({
      device: { form: "phone", platform: "ios" },
      computerUse: null,
      status: "pending",
    });
    const conflict = await command(host, {
      type: "runner.enrollment.createPhone",
      name: "Test iPhone",
      idempotencyKey: "iphone",
    });
    expect(conflict.status).toBe(409);
    await mint(host, "android-first", null);
    expect(
      (
        await command(host, {
          type: "runner.enrollment.createPhone",
          profile: "iphone",
          name: "Test iPhone",
          idempotencyKey: "android-first",
        })
      ).status,
    ).toBe(409);
    const discovery = (await (await fetch(`${host.origin}/.well-known/opensteer`)).json()) as {
      capabilities: string[];
      apiVersion: number;
    };
    expect(discovery.capabilities).toContain("iphone-apps-v1");
    const phone = keep(await connectPhone(host, minted.token));
    expect(await host.store.runnerForAuthentication(phone.runnerId)).toMatchObject({
      deviceProfile: "iphone",
      allowedModules: ["integrations"],
    });
    expect((await machines(host)).find(({ id }) => id === phone.runnerId)).toMatchObject({
      device: { form: "phone", platform: "ios" },
      computerUse: null,
      name: "Test iPhone",
      status: "online",
    });
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "machine.rename",
        machineId: phone.runnerId,
        idempotencyKey: "rename-iphone",
        name: "Renamed iPhone",
      },
      { headers: host.ownerHeaders },
    );
    const reconnect = await connectPrimary(
      host.hostPort,
      { ...phone.descriptor, name: "Untrusted reconnect name", bootId: iphoneDescriptor().bootId },
      { privateKey: phone.primary.privateKey },
    );
    closers.unshift(async () => {
      reconnect.socket.close();
      await closed(reconnect.socket);
    });
    expect((await machines(host)).find(({ id }) => id === phone.runnerId)).toMatchObject({
      name: "Renamed iPhone",
      device: { form: "phone", platform: "ios" },
      computerUse: null,
    });
  });

  it("H2 H3 H16 refuses profile mismatches before consumption and on every reconnect, preserving old profiles", async () => {
    await start();
    const minted = await mint(host, "profile-negative");
    const descriptor = iphoneDescriptor();
    const shell = { platform: "darwin", hostPublicKey: "" };
    const wrong = [
      { runnerKind: "managed" },
      { device: { form: "phone", platform: "android" } },
      { device: { form: "laptop", platform: "ios" } },
      { capabilities: ["browser-page-input-v1"] },
      { device: undefined },
      {
        modules: {
          integrations: { platform: "darwin", protocolVersion: 5, computerAppApprovals: true },
        },
      },
      { modules: { integrations: { platform: "android", protocolVersion: 4 } } },
      ...["ownerViewVersion", "macWindowVideoVersion", "loginText", "passwordSignIn"].map(
        (field) => ({
          modules: { integrations: { ...descriptor.modules.integrations, [field]: 1 } },
        }),
      ),
      { modules: { integrations: { platform: "ios", protocolVersion: 1 } } },
      {
        modules: {
          integrations: descriptor.modules.integrations,
          messaging: {
            capabilities: [
              {
                provider: channelProviderCatalog[0]!.provider,
                manifest: channelProviderCatalog[0]!,
                transportKinds: channelProviderCatalog[0]!.transportKinds,
              },
            ],
          },
        },
      },
      { modules: { integrations: descriptor.modules.integrations, shell } },
      {
        modules: {
          integrations: descriptor.modules.integrations,
          agents: {
            environmentIds: [createId("environment")],
            maxConcurrentRuns: 1,
            harnessDrivers: [],
            localStorage: null,
            workspaceMounts: [],
            providerStateModes: ["isolated"],
            workspaceBackings: ["portablefs"],
          },
        },
      },
      { modules: { integrations: { ...descriptor.modules.integrations, protocolVersion: 2 } } },
    ];
    // Schema-valid shell advertisement, so this tests profile admission too.
    const ssh = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .subarray(-32);
    const field = (v: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(v.length);
      return Buffer.concat([length, v]);
    };
    Object.assign(shell, {
      hostPublicKey: `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(ssh)]).toString("base64")}`,
    });
    for (const patch of wrong) {
      const attempted = { ...descriptor, ...patch };
      expect(RunnerDescriptorSchema.safeParse(attempted).success, JSON.stringify(patch)).toBe(true);
      const refused = await refusal(host, attempted, { token: minted.token });
      expect(refused.close.code).toBe(4003);
      expect(refused.frames.find(({ type }) => type === "host.error")).toMatchObject({
        error: {
          code: "forbidden",
          reason: patch === wrong.at(-1) ? "iphone-app-outdated" : mismatch,
        },
      });
      expect(
        (
          await host.store.database
            .selectFrom("runnerEnrollments")
            .select("consumedAt")
            .where("id", "=", minted.enrollmentId)
            .executeTakeFirstOrThrow()
        ).consumedAt,
      ).toBeNull();
    }
    const phone = keep(await connectPhone(host, minted.token, descriptor));
    for (const patch of wrong.slice(0, -1)) {
      expect(
        (
          await refusal(host, { ...descriptor, ...patch }, { privateKey: phone.primary.privateKey })
        ).frames.find(({ type }) => type === "host.error"),
      ).toMatchObject({ error: { reason: mismatch } });
    }
    for (const platform of ["android", "darwin"] as const) {
      const oldMint = await mint(host, `old-${platform}`, null);
      const oldDescriptor = RunnerDescriptorSchema.parse({
        ...iphoneDescriptor(),
        device: {
          form: platform === "android" ? "phone" : "laptop",
          platform: platform === "android" ? "android" : "macos",
        },
        modules: { integrations: { platform, protocolVersion: platform === "android" ? 4 : 5 } },
      });
      const old = await connectPrimary(host.hostPort, oldDescriptor, { token: oldMint.token });
      closers.unshift(async () => {
        old.socket.close();
        await closed(old.socket);
      });
      expect(await host.store.runnerForAuthentication(oldDescriptor.runnerId)).toMatchObject({
        deviceProfile: null,
      });
      for (const patch of [{ device: descriptor.device }, { modules: descriptor.modules }]) {
        const spoofed = { ...oldDescriptor, ...patch };
        const fresh = await mint(host, `old-spoof-${platform}-${Object.keys(patch)[0]}`, null);
        for (const credentials of [{ token: fresh.token }, { privateKey: old.privateKey }]) {
          expect(
            (await refusal(host, spoofed, credentials)).frames.find(
              ({ type }) => type === "host.error",
            ),
          ).toMatchObject({ error: { reason: mismatch } });
        }
      }
      const before = await host.store.runnerForAuthentication(oldDescriptor.runnerId);
      const reconnected = await connectPrimary(
        host.hostPort,
        { ...oldDescriptor, bootId: iphoneDescriptor().bootId },
        { privateKey: old.privateKey },
      );
      closers.unshift(async () => {
        reconnected.socket.close();
        await closed(reconnected.socket);
      });
      expect(
        (await host.store.runnerForAuthentication(oldDescriptor.runnerId))!.connectionGeneration,
      ).toBe(before!.connectionGeneration + 1);
    }
  }, 120_000);

  it("H16 upgrades existing profile-less Mac and Android rows and reauthenticates them", async () => {
    await start();
    const old = [];
    for (const platform of ["android", "darwin"] as const) {
      const minted = await mint(host, `historical-${platform}`, null);
      const descriptor = RunnerDescriptorSchema.parse({
        ...iphoneDescriptor(),
        device: {
          form: platform === "android" ? "phone" : "laptop",
          platform: platform === "android" ? "android" : "macos",
        },
        modules: { integrations: { platform, protocolVersion: platform === "android" ? 4 : 5 } },
      });
      const primary = await connectPrimary(host.hostPort, descriptor, { token: minted.token });
      primary.socket.close();
      await closed(primary.socket);
      old.push({ descriptor, privateKey: primary.privateKey });
    }
    const before = host;
    await before.runtime.close();
    const migrationDatabase = createDatabase({ connectionString: database.url });
    try {
      // The old schema has no profile columns. Every row here predates an iPhone.
      await sql`alter table runners drop column device_profile; alter table runner_enrollments drop column device_profile;`.execute(
        migrationDatabase,
      );
      await iphoneDeviceProfileMigration.up(migrationDatabase);
      expect(
        await migrationDatabase.selectFrom("runners").select("deviceProfile").execute(),
      ).toEqual([{ deviceProfile: null }, { deviceProfile: null }]);
    } finally {
      await migrationDatabase.destroy();
    }
    const restarted = await createHostRuntime(before.config);
    await restarted.listen();
    host = {
      ...before,
      runtime: restarted,
      store: restarted.store,
      close: async () => {
        await restarted.close();
        await before.close();
      },
    };
    for (const { descriptor, privateKey } of old) {
      const primary = await connectPrimary(
        host.hostPort,
        { ...descriptor, bootId: iphoneDescriptor().bootId },
        { privateKey },
      );
      closers.unshift(async () => {
        primary.socket.close();
        await closed(primary.socket);
      });
    }
    expect((await machines(host)).filter(({ status }) => status === "online")).toHaveLength(2);
  });

  it("H6 requires the current Personal remote route at mint and admission", async () => {
    host = await startPersonalMachineAccessHost(database.url);
    closers.unshift(() => host.close());
    expect(
      (
        await testRpcRequest(
          host.origin,
          "agentPhone.target.get",
          {},
          { headers: host.ownerHeaders },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await command(host, {
          type: "runner.enrollment.createPhone",
          profile: "iphone",
          name: "Test iPhone",
          idempotencyKey: "off",
        })
      ).status,
    ).toBe(403);
    await configurePersonalRemoteAccess(host, {
      mode: "private",
      routeOrigin: "https://personal-iphone.example.test",
    });
    const minted = await mint(host, "personal");
    expect(minted.pairing.hostUrl).toBe("https://personal-iphone.example.test");
    await configurePersonalRemoteAccess(host, { mode: "off", routeOrigin: null });
    expect(
      (await refusal(host, iphoneDescriptor(), { token: minted.token })).frames.find(
        ({ type }) => type === "host.error",
      ),
    ).toMatchObject({ error: { reason: "personal-remote-access-off" } });
    expect(
      (
        await host.store.database
          .selectFrom("runnerEnrollments")
          .select("consumedAt")
          .where("id", "=", minted.enrollmentId)
          .executeTakeFirstOrThrow()
      ).consumedAt,
    ).toBeNull();
    await configurePersonalRemoteAccess(host, {
      mode: "private",
      routeOrigin: "https://personal-iphone.example.test",
    });
    keep(await connectPhone(host, minted.token));
  });

  it("H4 H7 H8 H9 H13 isolates owners and enforces local signed approvals, key possession and revocation", async () => {
    await start();
    const admin = host.ownerHeaders;
    const owner = await signUpUser(host, {
      email: "iphone-owner@example.test",
      password: "iphone-owner-password",
    });
    host = { ...host, ownerHeaders: owner.headers, ownerId: owner.userId };
    const phone = keep(await connectPhone(host, (await mint(host, "consent")).token));
    await waitForCondition(async () =>
      (await machines(host)).some(
        ({ id, apps: status }) => id === phone.runnerId && status?.length === 3,
      ),
    );
    expect(
      (await machines(host))
        .find(({ id }) => id === phone.runnerId)
        ?.apps?.map(({ definitionId }) => definitionId)
        .sort(),
    ).toEqual([...apps].sort());
    expect(
      (await testRpcData(host.origin, "machines.list", {}, { headers: admin })).machines.find(
        ({ id }) => id === phone.runnerId,
      ),
    ).toMatchObject({ apps: null, computerUse: null });
    for (const headers of [admin, host.ownerHeaders]) {
      const response = await command(
        host,
        {
          type: "integration.computer.approval-key.set",
          idempotencyKey: randomUUID(),
          input: {
            runnerId: phone.runnerId,
            publicKey: createPublicKey(phone.primary.privateKey)
              .export({ format: "pem", type: "spki" })
              .toString(),
          },
        },
        headers,
      );
      expect(response.status).toBe(403);
      if (headers === host.ownerHeaders)
        expect(await response.json()).toMatchObject({
          error: { message: "Use the approval key this iPhone created." },
        });
    }
    // A different stream/key cannot answer the challenge. Phone scripts no proof for that key.
    const wrongKey = generateKeyPairSync("ed25519");
    expect(
      (
        await command(host, {
          type: "integration.computer.approval-key.set",
          idempotencyKey: randomUUID(),
          input: {
            runnerId: phone.runnerId,
            publicKey: wrongKey.publicKey.export({ format: "pem", type: "spki" }).toString(),
          },
        })
      ).status,
    ).toBe(403);
    const unregistered = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read",
      "unregistered-key",
      "apple-calendar",
    );
    expect(
      await phone.answer(unregistered, {
        kind: "deny",
        approval: createComputerAppApproval(
          phone.approvalKey.privateKey,
          unregistered,
          Date.now(),
          "deny",
        ),
      }),
    ).toMatchObject({
      kind: "refused",
      message:
        "This iPhone cannot approve apps yet. Open Opensteer on this iPhone to finish setup, then try again.",
    });
    const otherPhone = keep(
      await connectPhone(host, (await mint(host, "other-approval-stream")).token),
    );
    phone.challengeProxy = (challenge) => otherPhone.prove(challenge, phone.approvalKey.privateKey);
    await expect(phone.register()).rejects.toThrow("This iPhone did not confirm its approval key.");
    const expiredChallenge = phone.challenges.at(-1)!;
    expect(Date.parse(expiredChallenge.expiresAt)).toBeLessThanOrEqual(Date.now());
    phone.prove(expiredChallenge);
    expect(
      await host.store.database
        .selectFrom("computerUseApprovalKeys")
        .select("runnerId")
        .where("runnerId", "=", phone.runnerId)
        .executeTakeFirst(),
    ).toBeUndefined();
    phone.challengeProxy = null;
    await phone.register();
    expect(
      (
        await command(
          host,
          {
            type: "integration.computer.setup.request",
            idempotencyKey: randomUUID(),
            input: {
              kind: "app",
              app: null,
              access: "read",
              definitionId: "apple-calendar",
              runnerId: phone.runnerId,
            },
          },
          admin,
        )
      ).status,
    ).toBe(403);
    for (const definitionId of ["apple-messages", "android-phone"]) {
      const unsupported = await command(host, {
        type: "integration.computer.setup.request",
        idempotencyKey: randomUUID(),
        input: { kind: "app", app: null, runnerId: phone.runnerId, definitionId, access: "read" },
      });
      expect(unsupported.status).toBe(403);
      expect(await unsupported.json()).toMatchObject({
        error: { message: "This app is not supported on an iPhone." },
      });
    }
    const input = {
      kind: "app" as const,
      app: null,
      access: "read" as const,
      definitionId: "apple-calendar",
      runnerId: phone.runnerId,
    };
    expect(
      (
        await command(host, {
          type: "integration.computer.setup.set",
          idempotencyKey: randomUUID(),
          input,
        })
      ).status,
    ).toBe(403);
    // Administrator installs the real catalog; owner approval still required.
    const catalog = await testRpcData(
      host.origin,
      "integration.platform.get",
      {},
      { headers: admin },
    );
    const calendar = catalog.catalog.find(({ definition }) => definition.id === "apple-calendar")!;
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "integration.catalog.install",
        idempotencyKey: "install",
        input: { definitionId: "apple-calendar", digest: calendar.digest },
      },
      { headers: admin },
    );
    const request = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read",
      "signed",
      "apple-calendar",
    );
    for (const key of [wrongKey.privateKey, phone.primary.privateKey])
      expect(
        await phone.answer(request, {
          kind: "allow",
          approval: createComputerAppApproval(key, request),
        }),
      ).toMatchObject({ kind: "refused" });
    expect(
      await phone.answer(request, {
        kind: "allow",
        approval: createComputerAppApproval(
          phone.approvalKey.privateKey,
          request,
          Date.now() - 31_000,
        ),
      }),
    ).toMatchObject({ kind: "refused" });
    const allowed = createComputerAppApproval(phone.approvalKey.privateKey, request);
    expect(await phone.answer(request, { kind: "allow", approval: allowed })).toEqual({
      kind: "allowed",
    });
    expect(await phone.answer(request, { kind: "allow", approval: allowed })).toMatchObject({
      kind: "refused",
    });
    expect(
      (
        await command(host, {
          type: "integration.computer.setup.set",
          idempotencyKey: randomUUID(),
          input: { ...input, access: "read-write" },
        })
      ).status,
    ).toBe(403);
    const denied = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read-write",
      "deny",
      "apple-calendar",
    );
    expect(
      await phone.answer(denied, {
        kind: "deny",
        approval: createComputerAppApproval(
          phone.approvalKey.privateKey,
          denied,
          Date.now(),
          "deny",
        ),
      }),
    ).toEqual({ kind: "declined" });
    const automatic = await command(host, {
      type: "integration.computer.setup.request",
      idempotencyKey: randomUUID(),
      input: { kind: "policy", appApproval: "automatic", runnerId: phone.runnerId },
    });
    expect(automatic.status).toBe(400);
    expect(await automatic.json()).toMatchObject({
      error: {
        code: "bad_request",
        message: expect.stringContaining("Automatic approval is only for apps on a Mac."),
      },
    });
    const pluginDirectory = join(directory, "refused-plugin");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "iphone-refusal-fixture",
      }),
    );
    await writeFile(
      join(pluginDirectory, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { fixture: { type: "stdio", command: "node", args: [] } },
      }),
    );
    const mcp = await command(
      host,
      {
        type: "integration.agentPlugin.install",
        idempotencyKey: randomUUID(),
        input: { directory: pluginDirectory, runnerId: phone.runnerId },
      },
      admin,
    );
    expect(mcp.status, await mcp.clone().text()).toBe(403);
    expect(await mcp.json()).toMatchObject({
      error: { message: "Local servers can't run on an iPhone." },
    });
    const connection = await host.store.database
      .selectFrom("integrationConnections")
      .select("id")
      .where("runnerId", "=", phone.runnerId)
      .where("integrationDefinitionId", "=", "apple-calendar")
      .executeTakeFirstOrThrow();
    const adminIntegrations = await testRpcData(
      host.origin,
      "integrations.get",
      {},
      { headers: admin },
    );
    expect(adminIntegrations.connections.some(({ id }) => id === connection.id)).toBe(false);
    expect(
      (
        await testRpcData(host.origin, "integration.computer.setup.list", {}, { headers: admin })
      ).requests.some(({ runnerId }) => runnerId === phone.runnerId),
    ).toBe(false);
    const adminOff = await command(
      host,
      { type: "integration.disconnect", idempotencyKey: randomUUID(), connectionId: connection.id },
      admin,
    );
    expect(adminOff.status).toBe(404);
    expect(
      (
        await host.store.database
          .selectFrom("integrationConnections")
          .select("status")
          .where("id", "=", connection.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("connected");
    expect(
      (
        await command(host, {
          type: "integration.disconnect",
          idempotencyKey: randomUUID(),
          connectionId: connection.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await host.store.database
          .selectFrom("integrationConnections")
          .select("status")
          .where("id", "=", connection.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("revoked");
    const revoked = waitForClose(phone.primary.socket);
    await revokeMachine(host, { runnerId: phone.runnerId, key: "iphone-revoke" });
    expect((await revoked).code).toBe(4010);
    const removed = await refusal(host, phone.descriptor, { privateKey: phone.primary.privateKey });
    expect(removed.close.code).toBe(4010);
    expect(removed.frames).toEqual([]);
  }, 120_000);

  it("H10 H11 H12 H14 H15 enforces access and arguments; loses a write once without retransmission or Mac failover; exports raw mixed responses", async () => {
    await start();
    const realtime = keep(await openRealtime(host, host.ownerHeaders));
    const macCalls: unknown[] = [];
    const mac = keep(
      await connectComputerAppMachine(
        host,
        {
          definitionId: "apple-calendar",
          platforms: ["darwin"],
          inspect: async () => status("apple-calendar").operations,
          invoke: async (...args) => {
            macCalls.push(args);
            return { calendars: [] };
          },
        },
        { device: { form: "laptop", platform: "macos" } },
      ),
    );
    const phone = keep(await connectPhone(host, (await mint(host, "gateway")).token));
    await phone.register();
    const caller = keep(
      await connectCallerMachine(host, {
        name: "Caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "caller",
          name: "Caller",
        }),
      }),
    );
    const setup = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read-write",
      "calendar-write",
      "apple-calendar",
    );
    expect(
      await phone.answer(setup, {
        kind: "allow",
        approval: createComputerAppApproval(phone.approvalKey.privateKey, setup),
      }),
    ).toEqual({ kind: "allowed" });
    const connection = await host.store.database
      .selectFrom("integrationConnections")
      .select("id")
      .where("runnerId", "=", phone.runnerId)
      .where("integrationDefinitionId", "=", "apple-calendar")
      .executeTakeFirstOrThrow();
    const run = await dispatchCallerRun(host, caller, {
      key: "iphone-gateway",
      title: "Calendar on iPhone",
    });
    closers.unshift(() => run.complete());
    const gateway = keep(await integrationGateway(run.integrationTools));
    await grant(host, gateway, connection.id, "read-write");
    const search = await gateway.call("integration_search", { query: "Calendar" });
    const writeRef = operation(search, "create_event").toolRef;
    expect(
      await gateway.call("integration_call", {
        arguments: {},
        toolRef: operation(search, "list_calendars").toolRef,
      }),
    ).toEqual({ calendars: [] });
    const before = phone.invocations.length;
    for (const args of [
      { start: "nonsense", end: "2026-10-29" },
      { start: "2026-10-28" },
      { start: "2026-10-28", end: "2026-10-29", unknown: true },
    ])
      expect(
        (
          await gateway.callRaw("integration_call", {
            arguments: args,
            toolRef: operation(search, "list_events").toolRef,
          })
        ).isError,
      ).toBe(true);
    expect(phone.invocations).toHaveLength(before);
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "integration.computer.setup.set",
        idempotencyKey: "lower",
        input: {
          kind: "app",
          app: null,
          definitionId: "apple-calendar",
          runnerId: phone.runnerId,
          access: "read",
        },
      },
      { headers: host.ownerHeaders },
    );
    const read = await gateway.call("integration_search", { query: "Calendar" });
    expect(
      operations(read)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["list_calendars", "list_events"]);
    expect(
      (
        await gateway.callRaw("integration_call", {
          arguments: { title: "no write", start: "2026-10-28T12:00", end: "2026-10-28T13:00" },
          toolRef: writeRef,
        })
      ).isError,
    ).toBe(true);
    expect(phone.invocations).toHaveLength(before);
    const widen = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read-write",
      "widen",
      "apple-calendar",
    );
    expect(
      await phone.answer(widen, {
        kind: "allow",
        approval: createComputerAppApproval(phone.approvalKey.privateKey, widen),
      }),
    ).toEqual({ kind: "allowed" });
    // Leave a pending real Calendar request on the Mac for the older parser's manifest readers.
    const pending = await requestComputerAppSetup(
      host,
      mac.runnerId,
      "read",
      "corpus",
      "apple-calendar",
    );
    await waitForCondition(async () =>
      realtime.messages.some(({ type }) => type === "host.machines.changed"),
    );
    const rpc: { method: (typeof methods)[number]; data: unknown }[] = [];
    for (const method of methods) {
      const response = await testRpcRequest(
        host.origin,
        method,
        {},
        { headers: host.ownerHeaders },
      );
      expect(response.status).toBe(200);
      const data = envelope.parse(await response.json()).data;
      hostApi[method].success.parse(data);
      rpc.push({ method, data });
    }
    await writeFile(
      join(directory, "responses.json"),
      JSON.stringify(
        {
          failure: null,
          knownMachineId: mac.runnerId,
          iphoneMachineId: phone.runnerId,
          setupRequestId: pending.id,
          rpc,
          frames: realtime.messages.filter(({ type }) => type === "host.machines.changed"),
        },
        null,
        2,
      ),
    );
    const phoneTools = await gateway.call("integration_search", { query: "Calendar" });
    const phoneReadRef = operation(phoneTools, "list_calendars").toolRef;
    const phoneWriteRef = operation(phoneTools, "create_event").toolRef;
    await phone.disconnectStream();
    expect(
      toolReadiness(await gateway.call("integration_search", { query: "Calendar" }), "list_events")
        .detail,
    ).toBe(offline("Test iPhone"));
    await phone.reconnect();
    // Give the other Mac signed write approval and a live Workspace grant.
    // Losing the phone still cannot route to it.
    const macSetup = await requestComputerAppSetup(
      host,
      mac.runnerId,
      "read-write",
      "mac-write-alternative",
      "apple-calendar",
    );
    const macConnection = await setComputerApp(
      host,
      mac,
      macSetup,
      createComputerAppApproval(mac.approvalKey.privateKey, macSetup),
    );
    const installation = (
      await testRpcData(host.origin, "integration.platform.get", {}, { headers: host.ownerHeaders })
    ).installations.find(
      ({ installation }) => installation.name === "apple-calendar",
    )!.installation;
    const macGrant = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "integration.grant.create",
        idempotencyKey: "alternative-mac-grant",
        input: {
          access: "read-write",
          alias: "Calendar on observation Mac",
          connectionId: macConnection.connection.id,
          installationId: installation.id,
          workspaceId: run.workspaceId,
          isDefault: false,
        },
      },
      { headers: host.ownerHeaders },
    );
    if (macGrant.type !== "integration.grant.create") throw new Error("Wrong Mac grant response");
    const alternatives = operations(
      await gateway.call("integration_search", { query: "Calendar" }),
    );
    expect(
      alternatives.some(
        ({ connectionId, name }) =>
          connectionId === macConnection.connection.id && name === "create_event",
      ),
    ).toBe(true);
    await mac.heartbeat();
    phone.dropWriteAnswer = true;
    const lost = await gateway.callRaw("integration_call", {
      arguments: {
        title: "one uncertain event",
        start: "2026-10-28T12:00",
        end: "2026-10-28T13:00",
      },
      toolRef: phoneWriteRef,
    });
    expect(toolText(lost)).toBe(
      "Test iPhone did not confirm this. Check whether it happened before trying again.",
    );
    expect(phone.invocations.filter(({ operation }) => operation === "create_event")).toHaveLength(
      1,
    );
    await phone.reconnect();
    await phone.heartbeat();
    expect(phone.invocations.filter(({ operation }) => operation === "create_event")).toHaveLength(
      1,
    );
    expect(macCalls).toHaveLength(0);
    await phone.disconnectStream();
    expect(
      toolText(await gateway.callRaw("integration_call", { arguments: {}, toolRef: phoneReadRef })),
    ).toBe(offline("Test iPhone"));
    await phone.close();
    await waitForCondition(
      async () =>
        (await machines(host)).find(({ id }) => id === phone.runnerId)?.status === "offline",
    );
    expect(
      toolText(await gateway.callRaw("integration_call", { arguments: {}, toolRef: phoneReadRef })),
    ).toBe(offline("Test iPhone"));
    expect(macCalls).toHaveLength(0);
    await writeFile(
      join(directory, "invocations.json"),
      JSON.stringify(
        {
          phone: phone.invocations,
          mac: macCalls,
          alternativeMac: {
            runnerId: mac.runnerId,
            connectionId: macConnection.connection.id,
            grantId: macGrant.grant.id,
            callableWrite: true,
          },
        },
        null,
        2,
      ),
    );
  }, 120_000);
});

async function command(host: MachineAccessHost, input: unknown, headers = host.ownerHeaders) {
  return testRpcRequest(
    host.origin,
    "commands.dispatch",
    hostApi["commands.dispatch"].payload.parse(input),
    {
      headers,
    },
  );
}
async function mint(
  host: MachineAccessHost,
  idempotencyKey: string,
  profile: "iphone" | null = "iphone",
) {
  const minted = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      type: "runner.enrollment.createPhone",
      idempotencyKey,
      name: "Test iPhone",
      ...(profile ? { profile } : {}),
    },
    { headers: host.ownerHeaders },
  );
  if (minted.type !== "runner.enrollment.createPhone") throw new Error("Wrong command");
  return minted;
}
async function machines(host: MachineAccessHost) {
  return (await testRpcData(host.origin, "machines.list", {}, { headers: host.ownerHeaders }))
    .machines;
}
function iphoneDescriptor(): RunnerDescriptor {
  return RunnerDescriptorSchema.parse({
    bootId: `rbt_${randomUUID()}`,
    capabilities: [],
    device: { form: "phone", platform: "ios" },
    modules: { integrations: { computerAppApprovals: true, platform: "ios", protocolVersion: 1 } },
    name: "Test iPhone",
    runnerId: createId("runner"),
    runnerKind: "local",
    runtimeVersion: "scripted-iphone",
  });
}
function status(definitionId: string) {
  const definition = computerAppIntegrations.find(({ id }) => id === definitionId);
  if (!definition || !isComputerAppDefinition(definition)) throw new Error("Missing app");
  return {
    definitionId,
    operations: definition.config.operations.map(({ name }) => ({
      operation: name,
      state: "ready" as const,
      detail: null,
      remedy: null,
    })),
  };
}
async function connectPhone(
  host: MachineAccessHost,
  token: string,
  descriptor = iphoneDescriptor(),
  reportOnConnect = true,
) {
  const primary = await connectPrimary(host.hostPort, descriptor, { token });
  const approvalKey = generateKeyPairSync("ed25519");
  let stream: Awaited<ReturnType<typeof openAuxiliaryStream>>;
  const invocations: z.infer<typeof HostIntegrationsInvokeSchema>[] = [];
  const phone = {
    primary,
    approvalKey,
    descriptor,
    runnerId: descriptor.runnerId,
    invocations,
    dropWriteAnswer: false,
    challenges: [] as ComputerAppApprovalKeyChallenge[],
    challengeProxy: null as ((challenge: ComputerAppApprovalKeyChallenge) => void) | null,
    prove(challenge: ComputerAppApprovalKeyChallenge, key = approvalKey.privateKey) {
      stream.socket.send(
        JSON.stringify({
          ...stream.fence,
          challengeId: challenge.challengeId,
          signature: signComputerAppApprovalKeyChallenge(key, challenge),
          type: "runner.integrations.computer-app-approval-key-proof",
        }),
      );
    },
    async register() {
      return testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "integration.computer.approval-key.set",
          idempotencyKey: randomUUID(),
          input: {
            runnerId: descriptor.runnerId,
            publicKey: approvalKey.publicKey.export({ format: "pem", type: "spki" }).toString(),
          },
        },
        { headers: host.ownerHeaders },
      );
    },
    async answer(
      request: ComputerAppSetupRequest,
      answer: ComputerAppApprovalAnswer,
    ): Promise<ComputerAppApprovalOutcome> {
      const outcome = waitForMessage(
        stream.socket,
        (message) => message.type === "host.integrations.computer-app-approval-outcome",
      );
      stream.socket.send(
        JSON.stringify({
          ...stream.fence,
          setupRequestId: request.id,
          answer,
          type: "runner.integrations.computer-app-approval-answer",
        }),
      );
      return ((await outcome) as { outcome: ComputerAppApprovalOutcome }).outcome;
    },
    async disconnectStream() {
      if (stream.socket.readyState === WebSocket.CLOSED) return;
      stream.socket.close();
      await closed(stream.socket);
    },
    async close() {
      await phone.disconnectStream();
      if (primary.socket.readyState !== WebSocket.CLOSED) {
        primary.socket.close();
        await closed(primary.socket);
      }
    },
    async heartbeat() {
      const renewed = waitForMessage(
        stream.socket,
        (message) => message.type === "host.auxiliary.lease-renewed",
      );
      stream.socket.send(
        JSON.stringify({
          ...stream.fence,
          sentAt: new Date().toISOString(),
          type: "runner.auxiliary.heartbeat",
        }),
      );
      await renewed;
    },
    async report(entries: ComputerAppStatusEntry[]) {
      stream.socket.send(
        JSON.stringify({ ...stream.fence, apps: entries, type: "runner.integrations.status" }),
      );
      await phone.heartbeat();
    },
    async reconnect() {
      stream = await openAuxiliaryStream(host.hostPort, primary, "integrations");
      stream.socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; requestId?: string };
        if (frame.type === "host.integrations.computer-app-approval-key-challenge") {
          const challenge = HostIntegrationsComputerAppApprovalKeyChallengeSchema.parse(frame);
          const payload = {
            challengeId: challenge.challengeId,
            expiresAt: challenge.expiresAt,
            keyId: challenge.keyId,
            nonce: challenge.nonce,
            runnerId: challenge.runnerId,
          };
          phone.challenges.push(payload);
          if (phone.challengeProxy) {
            phone.challengeProxy(payload);
            return;
          }
          if (
            challenge.runnerId === descriptor.runnerId &&
            challenge.keyId === computerAppApprovalKeyId(approvalKey.publicKey)
          ) {
            stream.socket.send(
              JSON.stringify({
                ...stream.fence,
                challengeId: challenge.challengeId,
                signature: signComputerAppApprovalKeyChallenge(approvalKey.privateKey, {
                  challengeId: challenge.challengeId,
                  expiresAt: challenge.expiresAt,
                  keyId: challenge.keyId,
                  nonce: challenge.nonce,
                  runnerId: challenge.runnerId,
                }),
                type: "runner.integrations.computer-app-approval-key-proof",
              }),
            );
          }
        }
        if (frame.type === "host.integrations.invoke") {
          const invoke = HostIntegrationsInvokeSchema.parse(frame);
          invocations.push(invoke);
          if (phone.dropWriteAnswer && invoke.operation === "create_event") {
            stream.socket.close();
            return;
          }
          stream.socket.send(
            JSON.stringify({
              ...stream.fence,
              requestId: invoke.requestId,
              result: {
                kind: "ok",
                value:
                  invoke.operation === "list_calendars"
                    ? { calendars: [] }
                    : { events: [], nextCursor: null },
              },
              type: "runner.integrations.result",
            }),
          );
        }
      });
      if (reportOnConnect)
        stream.socket.send(
          JSON.stringify({
            ...stream.fence,
            apps: [...apps, "apple-messages", "macos-app", "android-phone"].map(status),
            ownerViewVersion: 1,
            displayAvailable: true,
            passwordSignIn: 1,
            type: "runner.integrations.status",
          }),
        );
    },
  };
  try {
    await phone.reconnect();
    return phone;
  } catch (error) {
    await phone.close();
    throw error;
  }
}
async function refusal(
  host: MachineAccessHost,
  descriptor: unknown,
  credentials: { token: string } | { privateKey: KeyObject },
) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
  const frames: { type: string; [key: string]: unknown }[] = [];
  const ended = waitForClose(socket);
  const receive = waitForMessage(socket, (frame) => frame.type === "host.challenge");
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const challenge = RunnerChallengeSchema.parse(await receive);
  socket.on("message", (raw) => {
    frames.push(JSON.parse(raw.toString()) as { type: string });
  });
  if ("token" in credentials) {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const credential = {
      enrollmentToken: credentials.token,
      kind: "host-enrollment-token" as const,
    };
    socket.send(
      JSON.stringify({
        type: "runner.enroll",
        proofFormatVersion: 2,
        descriptor,
        challengeId: challenge.challengeId,
        publicKeyPem,
        credential,
        signature: createRunnerEnrollmentSignature(keys.privateKey, {
          challenge,
          descriptor,
          credential,
          publicKeyPem,
        }),
      }),
    );
  } else
    socket.send(
      JSON.stringify({
        type: "runner.authenticate",
        proofFormatVersion: 2,
        descriptor,
        challengeId: challenge.challengeId,
        signature: createRunnerAuthenticationSignature(credentials.privateKey, {
          challenge,
          descriptor,
        }),
      }),
    );
  return { frames, close: await ended };
}
async function grant(
  host: MachineAccessHost,
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
  connectionId: string,
  access: IntegrationAccess,
) {
  await gateway.call("integration_request", {
    access,
    integration: "apple-calendar",
    reason: "Use phone Calendar",
  });
  const request = (await host.store.requests.listPendingIntegrationAccessRequests(host.ownerId)).at(
    -1,
  )!;
  await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      type: "request.respond",
      idempotencyKey: randomUUID(),
      requestId: request.request.id,
      response: {
        kind: "external",
        value: {
          access,
          alias: "Calendar on iPhone",
          connectionId,
          decision: "fulfilled",
          isDefault: true,
        },
      },
    },
    { headers: host.ownerHeaders },
  );
}
