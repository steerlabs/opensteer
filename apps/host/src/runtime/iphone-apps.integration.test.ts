import { localNamespace } from "../plugins/provider-names.js";
import type {
  ComputerAppApprovalAnswer,
  ComputerAppApprovalOutcome,
} from "./computer-apps.test-support.js";
import { channelProviderCatalog } from "@opensteer/channel-core";
import { createId } from "@opensteer/core";

import { computerAppIntegrations } from "@opensteer/integration-catalog/devices";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import { type ComputerAppSetupSummary } from "@opensteer/integration-core/computer-app-setup";
import { type IntegrationAccess } from "@opensteer/integration-core/access";
import {
  HostIntegrationsInvokeSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  hostApi,
  type RunnerDescriptor,
  type ComputerAppStatusEntry,
} from "@opensteer/protocol";
import {
  createDeviceLeaveSignature,
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";

import { sql } from "kysely";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  openAuxiliaryStream,
  pluginCall,
  requestComputerAppSetup,
  setComputerApp,
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
  openRealtime,
  resetMachineAccessDatabase,
  revokeMachine,
  startMachineAccessWireHost,
  waitForCondition,
  type MachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";

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
const iphoneAppAccess = {
  "apple-calendar": "read-write",
  "apple-contacts": "read",
  "apple-reminders": "read-write",
  "iphone-photos": "read",
  "iphone-location": "read",
} as const;
const mismatch = "runner-device-profile-mismatch";

integration.sequential("iPhone integrations Host contract", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  let host: MachineAccessWireHost;
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
  const start = async (manualRunner = false) => {
    host = await startMachineAccessWireHost(database.url, { remoteAccess: true, manualRunner });
    closers.unshift(() => host.close());
    return host;
  };
  const keep = <T extends { close(): Promise<void> }>(value: T): T => {
    closers.unshift(() => value.close());
    return value;
  };

  it("distinguishes same-named iPhone setups, explains availability and removes only the chosen setup", async () => {
    await start();
    const addCalendar = async (key: string) => {
      const phone = keep(await connectPhone(host, (await mint(host, key)).token));
      const setup = await requestComputerAppSetup(
        host,
        phone.runnerId,
        "read",
        key,
        "apple-calendar",
      );
      expect(await phone.answer(setup, { kind: "allow", setupRequestId: setup.id })).toEqual({
        kind: "allowed",
      });
      return phone;
    };
    const earlier = await addCalendar("earlier-calendar");
    const latest = await addCalendar("latest-calendar");
    await earlier.close();
    await waitForCondition(async () =>
      (await machines(host)).some(
        ({ id, status }) => id === earlier.runnerId && status === "offline",
      ),
    );
    const local = async () =>
      (await testRpcData(host.origin, "plugins.installed.list", {}, { headers: host.ownerHeaders }))
        .local;
    expect(await local()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Calendar on Test iPhone · Setup 1",
          computer: { id: earlier.runnerId, name: "Test iPhone" },
          unavailable: "Test iPhone is offline. Open Opensteer there, and update if prompted.",
        }),
        expect.objectContaining({
          title: "Calendar on Test iPhone · Setup 2",
          computer: { id: latest.runnerId, name: "Test iPhone" },
          unavailable: "Agents need access. Request it from a task.",
        }),
      ]),
    );
    const outdated = {
      ...earlier.descriptor,
      modules: { integrations: { ...earlier.descriptor.modules.integrations, protocolVersion: 3 } },
    };
    const viewer = keep(await openRealtime(host, host.ownerHeaders));
    const pluginNotices = () =>
      viewer.messages.filter(({ type }) => type === "host.plugins-changed").length;
    const beforeRefusal = pluginNotices();
    expect(
      (await refusal(host, outdated, { privateKey: earlier.primary.privateKey })).frames,
    ).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ reason: "iphone-app-outdated" }),
      }),
    );
    await waitForCondition(async () => pluginNotices() > beforeRefusal);
    const stale = (await local()).find(({ computer }) => computer?.id === earlier.runnerId)!;
    expect(stale.unavailable).toBe("Update Opensteer on Test iPhone to use its apps.");

    const earlierDevice = await host.store.requireSelfDeviceId(earlier.runnerId);
    const beforeRemoval = pluginNotices();
    await revokeMachine(host, { runnerId: earlier.runnerId, key: "remove-earlier" });
    await waitForCondition(async () => pluginNotices() > beforeRemoval);
    expect(
      (await local()).filter(({ title }) => title.startsWith("Calendar on Test iPhone")),
    ).toEqual([
      expect.objectContaining({
        title: "Calendar on Test iPhone",
        computer: { id: latest.runnerId, name: "Test iPhone" },
      }),
    ]);
    expect(
      await host.store.database
        .selectFrom("integrationConnections")
        .select("status")
        .where("deviceId", "=", earlierDevice)
        .where("integrationDefinitionId", "=", "apple-calendar")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "revoked" });
  }, 120_000);

  it.each(["fresh", "pre-overhaul installations"] as const)(
    "allows each iPhone data app with %s",
    async (scenario) => {
      await start();
      const enroll = async (key: string) => {
        const phone = keep(
          await connectPhone(host, (await mint(host, key)).token, iphoneDescriptor(), false),
        );
        await phone.report(Object.keys(iphoneAppAccess).map(status));
        return phone;
      };
      const allowApps = async (phone: Awaited<ReturnType<typeof enroll>>) => {
        for (const [definitionId, access] of Object.entries(iphoneAppAccess)) {
          const request = await requestComputerAppSetup(
            host,
            phone.runnerId,
            access,
            randomUUID(),
            definitionId,
          );
          const review = await testRpcData(
            host.origin,
            "integration.computer.setup.review",
            { setupRequestId: request.id },
            { headers: host.ownerHeaders },
          );
          expect(review.request).toMatchObject({ id: request.id, definitionId, access });
          const answer = await answerSetup(host, request.id, "allow");
          expect(answer.status, `${definitionId}: ${await answer.text()}`).toBe(200);
        }
      };
      const phone = await enroll("first-phone");
      await allowApps(phone);
      if (scenario === "fresh") return;

      // 0033 and 0034 preserved these built-in manifests and their catalog digests.
      const legacy = await sql`
        update integration_installations
        set manifest = jsonb_set(manifest, '{definition,apiKey}', 'null'::jsonb)
        where source_kind = 'built-in' and manifest->'definition'->>'adapter' = 'computer'
      `.execute(host.store.database);
      expect(legacy.numAffectedRows).toBe(5n);
      const deployment = await host.store.database
        .selectFrom("deployments")
        .select("id")
        .executeTakeFirstOrThrow();
      const proof = {
        deploymentId: deployment.id,
        issuedAt: new Date().toISOString(),
        runnerId: phone.runnerId,
      };
      const left = await host.runtime.app.inject({
        method: "POST",
        url: "/v1/runner/leave",
        payload: {
          ...proof,
          signature: createDeviceLeaveSignature(phone.primary.privateKey, proof),
        },
      });
      expect(left.statusCode, left.body).toBe(200);
      const replacement = await enroll("replacement-phone");
      expect(replacement.runnerId).not.toBe(phone.runnerId);
      await allowApps(replacement);
    },
    60_000,
  );

  it("explains why a reviewed approval can no longer be allowed", async () => {
    await start();
    const phone = keep(
      await connectPhone(
        host,
        (await mint(host, "approval-refusals")).token,
        iphoneDescriptor(),
        false,
      ),
    );
    const definitionId = "apple-calendar";
    await phone.report([status(definitionId)]);
    const request = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read",
      "refusal",
      definitionId,
    );
    const review = () =>
      testRpcRequest(
        host.origin,
        "integration.computer.setup.review",
        { setupRequestId: request.id },
        { headers: host.ownerHeaders },
      );
    expect((await review()).status).toBe(200);
    const expectRefusal = async (reason: string) => {
      const response = await answerSetup(host, request.id, "allow");
      expect(await response.json()).toMatchObject({ error: { code: "conflict", reason } });
      expect(response.status).toBe(409);
    };
    await phone.report([]);
    await expectRefusal("computer-app-not-offered");
    await phone.disconnectStream();
    await waitForCondition(
      async () => (await machines(host)).find(({ id }) => id === phone.runnerId)?.apps === null,
    );
    await expectRefusal("device-offline");
    await phone.reconnect();
    await expectRefusal("computer-app-connecting");
    await phone.report([status(definitionId)]);
    await host.store.database
      .updateTable("computerAppSetupRequests")
      .set({ definitionDigest: "older-catalog-digest" })
      .where("id", "=", request.id)
      .executeTakeFirstOrThrow();
    const stale = await answerSetup(host, request.id, "allow");
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      error: { code: "forbidden", reason: "computer-app-approval-changed" },
    });
    await sql`
      update integration_installations
      set manifest = manifest #- '{definition,authMethods}'
      where provenance->>'definitionId' = ${definitionId}
    `.execute(host.store.database);
    const invalid = await answerSetup(host, request.id, "allow");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "bad_request", reason: "computer-app-installation-invalid" },
    });
    expect((await answerSetup(host, request.id, "deny")).status).toBe(200);
    await expectRefusal("computer-app-approval-changed");
    expect(await (await review()).json()).toMatchObject({
      error: { code: "conflict", reason: "computer-app-approval-changed" },
    });

    await phone.report([status("apple-contacts")]);
    const contacts = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read",
      "contacts",
      "apple-contacts",
    );
    await host.store.database
      .updateTable("computerAppSetupRequests")
      .set({ access: "read-write" })
      .where("id", "=", contacts.id)
      .executeTakeFirstOrThrow();
    const unavailable = await answerSetup(host, contacts.id, "allow");
    expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "bad_request", reason: "computer-app-definition-changed" },
    });
  }, 60_000);

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
      allowedModules: ["browser", "integrations"],
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
    const discovery = (await (
      await fetch(`${host.origin.origin}/.well-known/opensteer`)
    ).json()) as {
      capabilities: string[];
      apiVersion: number;
    };
    expect(discovery.capabilities).toContain("iphone-apps-v1");
    const phone = keep(await connectPhone(host, minted.token));
    expect(await host.store.runnerForAuthentication(phone.runnerId)).toMatchObject({
      deviceProfile: "iphone",
      allowedModules: ["browser", "integrations"],
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
      ...Object.entries({
        ownerViewVersion: 1,
        macWindowVideoVersion: 1,
        loginText: 1,
        passwordSignIn: 2,
      }).map(([field, version]) => ({
        modules: { integrations: { ...descriptor.modules.integrations, [field]: version } },
      })),
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
            localStorage: {
              storageAuthorityId: `lsa_${randomUUID()}`,
              bindings: [],
              truncated: false,
            },
            providerStateModes: ["isolated"],
            workspaceBackings: ["local-directory"],
          },
        },
      },
      { modules: { integrations: { ...descriptor.modules.integrations, protocolVersion: 3 } } },
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

  it("H6 requires the current Personal remote route at mint and admission", async () => {
    host = await startMachineAccessWireHost(database.url);
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
      schemaVersion: 1,
      mode: "private",
      routeOrigin: "https://personal-iphone.example.test",
    });
    const minted = await mint(host, "personal");
    expect(minted.pairing.hostUrl).toBe("https://personal-iphone.example.test");
    await configurePersonalRemoteAccess(host, { schemaVersion: 1, mode: "off", routeOrigin: null });
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
      schemaVersion: 1,
      mode: "private",
      routeOrigin: "https://personal-iphone.example.test",
    });
    keep(await connectPhone(host, minted.token));
  });

  it("H4 H7 H8 H9 H13 enforces owner session approvals and revocation", async () => {
    await start();
    const admin = host.ownerHeaders;
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
    await host.runtime.devices.installDefinition({
      actorUserId: host.ownerId,
      definitionId: "apple-calendar",
      digest: calendar.digest!,
      requestId: "install",
    });
    const request = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read",
      "signed",
      "apple-calendar",
    );
    const allowed = request.id;
    expect(await phone.answer(request, { kind: "allow", setupRequestId: allowed })).toEqual({
      kind: "allowed",
    });
    expect(await phone.answer(request, { kind: "allow", setupRequestId: allowed })).toMatchObject({
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
        setupRequestId: denied.id,
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

    await expect(
      host.runtime.localServers.installPackage({
        actorUserId: host.ownerId,
        directory: pluginDirectory,
        registration: { name: "iphone-refusal-fixture", launch: { command: "node", args: [] } },
        requestId: "iphone-local-server-refused",
        runnerId: phone.runnerId,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Local servers can't run on an iPhone.",
    });
    const connection = await host.store.database
      .selectFrom("integrationConnections")
      .select("id")
      .where("deviceId", "=", await host.store.requireSelfDeviceId(phone.runnerId))
      .where("integrationDefinitionId", "=", "apple-calendar")
      .executeTakeFirstOrThrow();
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
    await start(true);
    const caller = keep(
      await connectCallerMachine(host, {
        name: "Caller",
        token: host.hostingRunnerEnrollmentToken,
      }),
    );
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
        setupRequestId: setup.id,
      }),
    ).toEqual({ kind: "allowed" });
    const connection = await host.store.database
      .selectFrom("integrationConnections")
      .select("id")
      .where("deviceId", "=", await host.store.requireSelfDeviceId(phone.runnerId))
      .where("integrationDefinitionId", "=", "apple-calendar")
      .executeTakeFirstOrThrow();
    const run = await dispatchCallerRun(host, caller, {
      key: "iphone-gateway",
      title: "Calendar on iPhone",
    });
    closers.unshift(() => run.complete());
    const gateway = keep(await integrationGateway(run.integrationTools));
    await grant(host, gateway, connection.id, "read-write");
    const phoneNamespace = localNamespace("calendar-test-iphone", `app_device_${connection.id}`);
    const phoneCalendar = `tools[${JSON.stringify(phoneNamespace)}]`;
    const createEvent = { title: "no write", start: "2026-10-28T12:00", end: "2026-10-28T13:00" };
    expect((await pluginCall(gateway, `${phoneCalendar}.list_calendars`, {})).value).toEqual({
      calendars: [],
    });
    const before = phone.invocations.length;
    for (const args of [
      { start: "nonsense", end: "2026-10-29" },
      { start: "2026-10-28" },
      { start: "2026-10-28", end: "2026-10-29", unknown: true },
    ])
      expect((await pluginCall(gateway, `${phoneCalendar}.list_events`, args)).raw.isError).toBe(
        true,
      );
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
    expect(
      (await pluginCall(gateway, `${phoneCalendar}.create_event`, createEvent)).raw,
    ).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "access_denied",
          message: "Calendar on Test iPhone allows reading only.",
          next: `To create_event, call app_access_request with dataApp "calendar", computerId "${phone.runnerId}" and access "read-write"; do not retry this call until it is fulfilled.`,
        },
      },
    });
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
        setupRequestId: widen.id,
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
    await phone.disconnectStream();
    expect(await gateway.call("plugin_search", { namespace: phoneNamespace })).toMatchObject({
      unavailableApps: [
        {
          blocked: {
            code: "unavailable",
            message:
              "apple-calendar is unavailable: Apps aren’t connected. Reopen Opensteer on Test iPhone.",
            next: "Continue without it and tell the person what the message says.",
          },
        },
      ],
    });
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
    const macConnection = await setComputerApp(host, mac, macSetup, macSetup.id);
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
          isDefault: false,
        },
      },
      { headers: host.ownerHeaders },
    );
    if (macGrant.type !== "integration.grant.create") throw new Error("Wrong Mac grant response");
    // The Mac's Calendar is its own provider; the phone's call below never moves to it.
    const macNamespace = localNamespace(
      "calendar-studio-mac",
      `app_device_${macConnection.connection.id}`,
    );
    await mac.heartbeat();
    expect(await gateway.call("plugin_search", { namespace: macNamespace })).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ path: `tools[${JSON.stringify(macNamespace)}].create_event` }),
      ]),
    });
    await phone.heartbeat();
    phone.dropWriteAnswer = true;
    const lost = await pluginCall(gateway, `${phoneCalendar}.create_event`, {
      title: "one uncertain event",
      start: "2026-10-28T12:00",
      end: "2026-10-28T13:00",
    });
    expect(lost.failure).toBe(
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
    expect((await pluginCall(gateway, `${phoneCalendar}.list_calendars`, {})).failure).toBe(
      "apple-calendar is unavailable: Apps aren’t connected. Reopen Opensteer on Test iPhone.",
    );
    await phone.close();
    await waitForCondition(
      async () =>
        (await machines(host)).find(({ id }) => id === phone.runnerId)?.status === "offline",
    );
    const offlineCall = await gateway.callRaw("plugin_call", {
      calls: { path: `${phoneCalendar}.list_calendars`, input: {} },
    });
    expect(offlineCall).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "computer_offline",
          message: "Device is offline. Do not request access.",
          next: `computerId=${phone.runnerId}, access=apps. Continue without it and tell the person what the message says.`,
        },
      },
    });
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

async function command(host: MachineAccessWireHost, input: unknown, headers = host.ownerHeaders) {
  return testRpcRequest(
    host.origin,
    "commands.dispatch",
    hostApi["commands.dispatch"].payload.parse(input),
    {
      headers,
    },
  );
}
function answerSetup(
  host: MachineAccessWireHost,
  setupRequestId: string,
  decision: "allow" | "deny",
) {
  return command(host, {
    type: "integration.computer.setup.respond",
    idempotencyKey: `iphone-answer:${setupRequestId}:${randomUUID()}`,
    setupRequestId,
    decision,
  });
}
async function mint(
  host: MachineAccessWireHost,
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
async function machines(host: MachineAccessWireHost) {
  return (await testRpcData(host.origin, "machines.list", {}, { headers: host.ownerHeaders }))
    .machines;
}
function iphoneDescriptor(): RunnerDescriptor {
  return RunnerDescriptorSchema.parse({
    bootId: `rbt_${randomUUID()}`,
    capabilities: [],
    device: { form: "phone", platform: "ios" },
    modules: { integrations: { platform: "ios", protocolVersion: 2 } },
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
  host: MachineAccessWireHost,
  token: string,
  descriptor = iphoneDescriptor(),
  reportOnConnect = true,
) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
  const welcomed = waitForMessage(socket, (frame) => frame.type === "host.welcome");
  const primary = await connectPrimary(host.hostPort, descriptor, { token }, socket);
  expect(await welcomed).toMatchObject({ allowedModules: ["integrations"] });
  let stream: Awaited<ReturnType<typeof openAuxiliaryStream>>;
  const invocations: z.infer<typeof HostIntegrationsInvokeSchema>[] = [];
  const phone = {
    primary,
    descriptor,
    runnerId: descriptor.runnerId,
    invocations,
    dropWriteAnswer: false,
    async answer(
      request: ComputerAppSetupSummary,
      answer: ComputerAppApprovalAnswer,
    ): Promise<ComputerAppApprovalOutcome> {
      if (request.id !== answer.setupRequestId)
        return { kind: "refused", message: "Approval changed" };
      const response = await command(host, {
        type: "integration.computer.setup.respond",
        idempotencyKey: randomUUID(),
        setupRequestId: request.id,
        decision: answer.kind === "allow" ? "allow" : "deny",
      });
      if (!response.ok) return { kind: "refused", message: "The Host refused this decision." };
      return { kind: answer.kind === "allow" ? "allowed" : "declined" };
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
            passwordSignIn: 2,
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
  host: MachineAccessWireHost,
  descriptor: unknown,
  credentials: { token: string } | { privateKey: KeyObject },
) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
  const frames: { type: string; [key: string]: unknown }[] = [];
  const ended = waitForClose(socket, "the Host to refuse the Runner's profile");
  void ended.catch(() => undefined);
  try {
    const challenge = RunnerChallengeSchema.parse(
      await waitForMessage(socket, (frame) => frame.type === "host.challenge"),
    );
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
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closing = waitForClose(socket, "the refused Runner socket to terminate");
      socket.terminate();
      await closing;
    }
  }
}
async function grant(
  host: MachineAccessWireHost,
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
  connectionId: string,
  access: IntegrationAccess,
) {
  const held = gateway.call("app_access_request", {
    access,
    dataApp: "calendar",
    reason: "Use phone Calendar",
  });
  const pending = () =>
    host.store.integrationRequests.listPendingIntegrationAccessRequests(host.ownerId);
  await waitForCondition(async () => (await pending()).length > 0);
  const request = (await pending()).at(-1)!;
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
  await held;
}
