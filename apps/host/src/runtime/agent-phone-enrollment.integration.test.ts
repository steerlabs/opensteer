import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createId } from "@opensteer/core";
import { delay } from "@opensteer/shared/delay";
import {
  RunnerChallengeSchema,
  agentPhoneOutdatedReason,
  agentPhoneReleaseSignerSha256,
  RunnerDescriptorSchema,
  RunnerEnrollmentCredentialSchema,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import {
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { phoneUpdateRelease } from "../agent-phone/update-release.js";
import { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import { createHostRuntime } from "./runtime.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import {
  configurePersonalRemoteAccess,
  createMachineAccessDatabase,
  resetMachineAccessDatabase,
  startMachineAccessWireHost,
  waitForCondition,
  type MachineAccessHost,
} from "./machine-access-protocol.test-support.js";

/*
 * An Android phone joins a Deployment with a one-use enrollment its owner
 * mints while the phone is plugged in. What goes wrong otherwise, written
 * before the code:
 * - the grant gets the default modules every other computer carries, so a
 *   phone could later open a shell nobody was asked about;
 * - a phone advertising more than its screen is admitted;
 * - the pairing names an address the phone cannot use — a Personal
 *   Deployment's loopback origin — or one minted with remote access off,
 *   which no phone could ever redeem;
 * - the pairing leaves the phone to call its Deployment by an address when
 *   it has a name: a server by the name its administrator gave it, a
 *   Personal Deployment by the Mac it runs on;
 * - a Personal Deployment refuses the phone's grant at issuance or arrival;
 * - an expired token, or remote access going off, reaches the phone as a bare
 *   close it cannot tell from any other failure, so it cannot say "mint a new
 *   enrollment" or "turn remote access on".
 *
 * Setup replaces an enrollment only once its owner has retired it, so:
 * - a retired enrollment can still be redeemed, or still shows as pending;
 * - retiring one a Runner already redeemed answers as if it stopped it,
 *   hiding a computer that exists, and retiring one that ran out claims credit;
 * - someone other than its owner can retire it, or learn that it exists;
 * - retiring and redeeming at once both succeed, leaving a Runner behind a
 *   "retired" answer;
 * - retiring it again answers as though it might still be usable.
 */
const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;

integration.sequential("An Android phone joining a Deployment", () => {
  let isolated: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
  let host: MachineAccessHost | undefined;

  beforeAll(async () => {
    isolated = await createMachineAccessDatabase(baseDatabaseUrl!);
  }, 120_000);
  beforeEach(async () => {
    await resetMachineAccessDatabase(isolated!.url);
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
  });
  afterAll(async () => {
    await isolated?.drop();
  }, 120_000);

  it("retains an Opensteer phone's signed identity through enrollment, reconnect and update refusal", async () => {
    host = await startMachineAccessWireHost(isolated!.url, { remoteAccess: true });
    const active = host;
    const runnerId = createId("runner");
    const device = { app: "opensteer", form: "phone", platform: "android" } as const;
    const descriptor = RunnerDescriptorSchema.parse({
      ...phoneDescriptor(runnerId),
      device,
      modules: { browser: { runtimeId: runnerId, wireVersion: 1 } },
    });
    const machine = async () => {
      const result = await testRpcData(
        active.origin,
        "machines.list",
        {},
        {
          headers: active.ownerHeaders,
        },
      );
      return result.machines.find(({ id }) => id === runnerId);
    };
    const minted = await mintPhone(active, "opensteer-android");
    const enrolled = await presentPhone(
      active,
      descriptor,
      { token: minted.token },
      undefined,
      async () => {
        expect(await machine()).toMatchObject({ device, status: "online", computerUse: null });
      },
    );
    expect(enrolled.welcome).not.toBeNull();
    await vi.waitFor(
      async () => expect(await machine()).toMatchObject({ device, status: "offline" }),
      {
        timeout: 5_000,
      },
    );
    expect(
      await active.store.database
        .selectFrom("runners")
        .select("device")
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ device });
    const olderDescriptor = { ...descriptor, device: { form: "phone", platform: "android" } };
    const reconnected = await presentPhone(active, olderDescriptor, {
      privateKey: enrolled.privateKey,
    });
    expect(reconnected.welcome).not.toBeNull();
    await vi.waitFor(
      async () => expect(await machine()).toMatchObject({ device, status: "offline" }),
      {
        timeout: 5_000,
      },
    );
    const identity = await active.store.runnerForAuthentication(runnerId);
    expect(
      await active.store.recordRunnerUpdateRequired({
        runnerId,
        connectionGeneration: identity!.connectionGeneration,
        reason: "runner-outdated",
      }),
    ).toBe(true);
    expect(await machine()).toMatchObject({
      device,
      status: "needs-update",
      detail: "Update Opensteer on Pixel 8.",
      computerUse: null,
    });
  }, 120_000);

  it("admits whole signed v2 advertisements and refuses mixed formats without consuming enrollment", async () => {
    host = await startMachineAccessWireHost(isolated!.url, { remoteAccess: true });
    const runnerId = createId("runner");
    const baseline = phoneDescriptor(runnerId);
    const descriptor = {
      ...baseline,
      name: "  Wire phone  ",
      future: { nested: [null, true, "é😀"] },
      modules: {
        ...baseline.modules,
        futureModule: { kind: "future", nested: { value: 7 } },
        integrations: { ...baseline.modules.integrations!, future: { version: 7 } },
      },
    };
    const mixed: unknown[] = [];
    for (const proofFormatVersion of [undefined, 1, 3]) {
      const minted = await mintPhone(host, `format-${proofFormatVersion}`);
      const refused = await presentPhone(
        host,
        descriptor,
        { token: minted.token },
        undefined,
        undefined,
        proofFormatVersion ?? 0,
      );
      expect(refused.welcome).toBeNull();
      expect(refused.refusal).toMatchObject({
        reason: "runner-proof-format-mismatch",
        message: expect.stringMatching(/update/i),
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
      mixed.push({ proofFormatVersion: proofFormatVersion ?? "missing", refusal: refused.refusal });
    }
    const minted = await mintPhone(host, "signed-v2-advertisement");
    const enrolled = await presentPhone(host, descriptor, { token: minted.token });
    expect(enrolled.welcome).not.toBeNull();
    const reconnect = await presentPhone(host, descriptor, { privateKey: enrolled.privateKey });
    expect(reconnect.welcome).not.toBeNull();
    const unknownInventory = {
      ...descriptor,
      modules: {
        ...descriptor.modules,
        agents: {
          environmentIds: [createId("environment")],
          harnessDrivers: [],
          maxConcurrentRuns: 1,
          providerStateModes: ["isolated"],
          workspaceBackings: ["local-directory"],
          localStorage: {
            storageAuthorityId: `lsa_${randomUUID()}`,
            truncated: false,
            bindings: [
              {
                bindingId: `wbd_${randomUUID()}`,
                generation: 1,
                workspaceId: `wsp_${randomUUID()}`,
                state: "future-state",
              },
            ],
          },
        },
      },
    };
    const inventoryReconnect = await presentPhone(host, unknownInventory, {
      privateKey: enrolled.privateKey,
    });
    expect(inventoryReconnect.welcome).toBeNull();

    const machines = await testRpcData(
      host.origin,
      "machines.list",
      {},
      { headers: host.ownerHeaders },
    );
    const machine = machines.machines.find((row) => row.id === runnerId);
    expect(machine?.name).toBe("Wire phone");
    expect(JSON.stringify(machine)).not.toContain("future");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-runner-proof-v2-"));
    await writeFile(
      join(directory, "proof-contract.json"),
      JSON.stringify(
        {
          proofFormatVersion: 2,
          enrollment: !!enrolled.welcome,
          reconnect: !!reconnect.welcome,
          mixed,
          unsupportedInventoryRefused: inventoryReconnect.welcome === null,
          machine,
        },
        null,
        2,
      ),
    );
    console.info(`Runner proof v2 evidence: ${directory}/proof-contract.json`);
  });

  it("admits an older compatible release and clears only proven incompatibility across restart", async () => {
    const lines: string[] = [];
    const logger = {
      level: "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
      stream: new Writable({
        write(chunk: Buffer | string, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    };
    const apk = Buffer.from("newer bundled phone release");
    const manifest = {
      apkSha256: createHash("sha256").update(apk).digest("hex"),
      apkSize: apk.length,
      buildType: "release",
      minSdk: 30,
      packageName: "com.opensteer.agentphone",
      signingCertSha256: agentPhoneReleaseSignerSha256,
      versionCode: 1_999,
      versionName: "0.1.999",
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const release = phoneUpdateRelease(
      new Map([
        ["agent-phone/opensteer-agent-phone.apk", apk],
        ["agent-phone/agent-phone.json", manifestBytes],
        [
          "agent-phone/agent-phone-release.json",
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              sourceRevision: "a".repeat(40),
              version: manifest.versionName,
              apkSha256: manifest.apkSha256,
              apkSize: apk.length,
              signingCertSha256: manifest.signingCertSha256,
              manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
            }),
          ),
        ],
      ]),
      manifest.versionName,
    );
    expect(release).not.toBeNull();
    const newerRelease = () => release;
    host = await startMachineAccessWireHost(isolated!.url, {
      logger,
      remoteAccess: true,
      phoneUpdateRelease: newerRelease,
    });
    const minted = await mintPhone(host, "honest-old-phone");
    const runnerId = createId("runner");
    const current = { ...phoneDescriptor(runnerId), name: "Kitchen phone" };
    const arrived = await presentPhone(host, current, { token: minted.token });
    expect(arrived.welcome).not.toBeNull();
    expect(
      (
        await host.store.database
          .selectFrom("runnerEnrollments")
          .select("consumedAt")
          .where("id", "=", minted.enrollmentId)
          .executeTakeFirstOrThrow()
      ).consumedAt,
    ).not.toBeNull();
    const reconnected = await presentPhone(host, current, { privateKey: arrived.privateKey });
    expect(reconnected.welcome).not.toBeNull();
    const machine = async () =>
      (
        await testRpcData(host!.origin, "machines.list", {}, { headers: host!.ownerHeaders })
      ).machines.find((row) => row.id === runnerId)!;
    await waitForCondition(async () => (await machine()).status === "offline");
    const original = await host.store.runnerForAuthentication(runnerId);
    const old = {
      ...current,
      modules: {
        integrations: {
          platform: "android" as const,
          protocolVersion: 3,
          computerAppApprovals: true as const,
          displayStream: true as const,
        },
      },
    };
    // The old branch signs the retired displayStream field. A stranger cannot
    // mark this machine by copying its id or presenting a fresh enrollment.
    const impostor = await presentPhone(host, old, {
      privateKey: generateKeyPairSync("ed25519").privateKey,
    });
    expect(impostor.refusal).toMatchObject({
      code: "forbidden",
      message: "Runner authentication failed",
    });
    expect((await machine()).status).toBe("offline");
    const pending = await mintPhone(host, "cannot-mark-enrolled-phone");
    const enrollmentImpostor = await presentPhone(host, old, { token: pending.token });
    expect(enrollmentImpostor.welcome).toBeNull();
    expect(enrollmentImpostor.refusal).toMatchObject({ reason: "agent-phone-outdated" });
    expect((await machine()).status).toBe("offline");
    expect(
      await host.store.database
        .selectFrom("runnerEnrollments")
        .select("consumedAt")
        .where("id", "=", pending.enrollmentId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ consumedAt: null });
    const refused = await presentPhone(host, old, { privateKey: arrived.privateKey });
    expect(refused.refusal).toMatchObject({ reason: "agent-phone-outdated", retryable: false });
    const needsUpdate = await machine();
    expect(needsUpdate).toMatchObject({
      status: "needs-update",
      name: "Kitchen phone",
      detail: "Update Agent Phone on Kitchen phone.",
    });
    expect(await host.store.runnerForAuthentication(runnerId)).toEqual(original);
    expect(
      lines.some((line) => {
        const entry = JSON.parse(line) as {
          level: number;
          reason?: string;
          authenticated?: boolean;
        };
        return (
          entry.level === 40 &&
          entry.reason === "agent-phone-outdated" &&
          entry.authenticated === true
        );
      }),
    ).toBe(true);
    const before = host;
    await before.runtime.close();
    const restarted = await createHostRuntime(before.config, {
      logger,
      phoneUpdateRelease: newerRelease,
    });
    if (restarted.kind !== "personal") throw new Error("Expected a Personal Host");
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
    expect((await machine()).status).toBe("needs-update");
    let online: unknown;
    const recovered = await presentPhone(
      host,
      { ...current, name: "Hallway phone" },
      { privateKey: arrived.privateKey },
      async () => undefined,
      async () => {
        online = await machine();
        expect(online).toMatchObject({ status: "online", name: "Hallway phone", detail: null });
      },
    );
    expect(recovered.welcome).not.toBeNull();
    await waitForCondition(async () => (await machine()).status === "offline");
    expect((await machine()).detail).toBeNull();
    // A delayed write authenticated against the previous generation loses.
    expect(
      await host.store.recordRunnerUpdateRequired({
        runnerId,
        connectionGeneration: original!.connectionGeneration,
        reason: "agent-phone-outdated",
      }),
    ).toBe(false);
    for (const malformed of [false, true]) {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${host!.hostPort}/internal/v1/runners/auxiliary/integrations`,
        );
        const timeout = setTimeout(() => {
          socket.terminate();
          reject(new Error("Auxiliary refusal did not close"));
        }, 10_000);
        socket.once("message", () => {
          if (malformed) socket.send("{}");
          else socket.close();
        });
        socket.once("error", reject);
        socket.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    const outcomes = lines
      .map(
        (line) =>
          JSON.parse(line) as { msg?: string; level?: number; outcome?: string; reason?: string },
      )
      .filter((entry) => entry.msg === "Runner auxiliary upgrade outcome");
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 40,
          outcome: "refused",
          reason: "disconnected-before-authentication",
        }),
        expect.objectContaining({
          level: 40,
          outcome: "refused",
          reason: "invalid-proof-or-frame",
        }),
      ]),
    );
    const directory =
      process.env.OPENSTEER_PHONE_HONEST_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-phone-honest-")));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "host-refusal-journey.json"),
      JSON.stringify(
        {
          scenario: "old-phone-refusal-authentication-restart-update-rename",
          needsUpdate,
          online,
          refusal: refused.refusal,
          impostorChangedMachine: false,
          enrollmentProofChangedMachine: false,
          enrollmentProofConsumedToken: false,
          staleGenerationChangedMachine: false,
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(join(directory, "host-refusal-journey.log"), lines.join(""));
  }, 60_000);

  it("reports an inconsistent enrolled key equally for admission and update refusal", async () => {
    host = await startMachineAccessWireHost(isolated!.url, { remoteAccess: true });
    const minted = await mintPhone(host, "inconsistent-enrolled-key");
    const descriptor = phoneDescriptor(createId("runner"));
    const arrived = await presentPhone(host, descriptor, { token: minted.token });
    expect(arrived.welcome).not.toBeNull();
    await waitForCondition(async () => {
      const rows = await testRpcData(
        host!.origin,
        "machines.list",
        {},
        {
          headers: host!.ownerHeaders,
        },
      );
      return rows.machines.some(
        (row) => row.id === descriptor.runnerId && row.status === "offline",
      );
    });
    await host.store.database
      .updateTable("runners")
      .set({ publicKeyFingerprint: "sha256:inconsistent" })
      .where("id", "=", descriptor.runnerId)
      .executeTakeFirstOrThrow();
    const before = await host.store.runnerForAuthentication(descriptor.runnerId);
    const authenticator = new RunnerAuthenticator({
      issuancePrivateKey: generateKeyPairSync("ed25519").privateKey,
      store: host.store,
    });
    const challenge = authenticator.issueChallenge();
    const proof = {
      challengeId: challenge.challengeId,
      descriptor,
      signature: createRunnerAuthenticationSignature(arrived.privateKey, { challenge, descriptor }),
      proofFormatVersion: 2,
      type: "runner.authenticate" as const,
    };
    for (const attempt of [
      () => authenticator.authenticate(challenge, proof),
      () => authenticator.authenticateUpdateRefusal(challenge, proof),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: "internal",
        message: "Enrolled Runner key is inconsistent",
      });
      expect(await host.store.runnerForAuthentication(descriptor.runnerId)).toEqual(before);
    }
  });

  it("preserves reachable and supervised grants and old signed phone enrollment-key replay", async () => {
    host = await startMachineAccessWireHost(isolated!.url, { remoteAccess: true });
    const keys = generateKeyPairSync("ed25519");
    const issuer = new RunnerAuthenticator({
      issuancePrivateKey: keys.privateKey,
      store: host.store,
    });
    const reachable = ["browser", "integrations", "messaging", "shell"] as const;
    const request = {
      allowedModules: reachable,
      createdBy: host.ownerId,
      idempotencyKey: "reachable",
      lifetimeSeconds: 600,
      name: "Other Mac",
      runnerKind: "local" as const,
    };
    const stored = await issuer.createEnrollment(request);
    expect(await issuer.createEnrollment(request)).toEqual(stored);
    for (const profile of [undefined, "iphone"] as const) {
      const purpose = profile === "iphone" ? "iphone" : "phone";
      const phoneRequest = {
        createdBy: host.ownerId,
        idempotencyKey: `old-${purpose}`,
        lifetimeSeconds: 600,
        name: "Phone",
        ...(profile ? { profile } : {}),
      };
      const historicalTranscript = Buffer.from(
        JSON.stringify([
          "opensteer-runner-enrollment-issuance-v2",
          "allowedModules",
          ["integrations"],
          "createdBy",
          host.ownerId,
          "idempotencyKey",
          phoneRequest.idempotencyKey,
          "purpose",
          purpose,
          "runnerKind",
          "local",
          "lifetimeSeconds",
          600,
          "name",
          "Phone",
        ]),
      );
      const historicalToken = sign(null, historicalTranscript, keys.privateKey).toString(
        "base64url",
      );
      const previous = await host.store.createRunnerEnrollment({
        allowedModules: ["browser", "integrations"],
        issuanceModules: ["integrations"],
        createdBy: host.ownerId,
        ...(profile ? { deviceProfile: profile } : {}),
        expiresAt: new Date(Date.now() + 600_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: phoneRequest.idempotencyKey,
        name: "Phone",
        runnerKind: "local",
        requestFingerprint: `sha256:${createHash("sha256").update(historicalTranscript).digest("base64url")}`,
        tokenHash: `sha256:${createHash("sha256").update(historicalToken).digest("base64url")}`,
      });
      expect(await issuer.createPhoneEnrollment(phoneRequest)).toMatchObject({
        enrollmentId: previous.id,
        token: historicalToken,
      });
    }
    await issuer.ensureConfiguredDeploymentEnrollment({
      allowedModules: ["integrations", "messaging"],
      idempotencyKey: "messaging",
      lifetimeSeconds: 600,
      name: "Messaging",
      token: "configured-messaging-token-0123456789",
    });
    await expect(
      issuer.createInitialMainEnrollment({
        allowedModules: ["agents", "browser"],
        createdBy: null,
        idempotencyKey: "local-main",
        lifetimeSeconds: 600,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Initial Main enrollment is unavailable after a Main has enrolled",
    });
    const rows = await host.store.database
      .selectFrom("runnerEnrollments")
      .select(["idempotencyKey", "allowedModules"])
      .execute();
    const grants = Object.fromEntries(rows.map((row) => [row.idempotencyKey, row.allowedModules]));
    expect(grants).toMatchObject({
      reachable: ["browser", "integrations", "messaging", "shell"],
      messaging: ["integrations", "messaging"],
    });
  }, 120_000);

  it("mints the phone grant with the Host's own address and refuses shell and execution", async () => {
    host = await startMachineAccessWireHost(isolated!.url, {
      remoteAccess: true,
      deploymentName: "Acme Research",
    });
    const minted = await mintPhone(host, "pixel-1");
    const authority = await hostAuthority(host);
    expect(minted).toEqual({
      enrollmentId: expect.stringMatching(/^ren_/u),
      expiresAt: expect.any(String),
      pairing: {
        deploymentId: authority.deploymentId,
        deploymentName: "Acme Research",
        hostInstanceId: authority.hostInstanceId,
        hostUrl: "https://personal.machine-access.test",
      },
      token: expect.any(String),
      type: "runner.enrollment.createPhone",
    });
    // The phone calls the Deployment what every client calls it.
    const config = await testRpcData(
      host.origin,
      "auth.config",
      {},
      { headers: host.ownerHeaders },
    );
    expect(config.deployment.name).toBe(minted.pairing.deploymentName);
    const lifetime = Date.parse(minted.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(590_000);
    expect(lifetime).toBeLessThanOrEqual(600_000);
    // The same ask is the same enrollment.
    expect(await mintPhone(host, "pixel-1")).toMatchObject({
      enrollmentId: minted.enrollmentId,
      token: minted.token,
    });
    expect(
      await host.store.database
        .selectFrom("runnerEnrollments")
        .select(["allowedModules", "ownerKind", "ownerUserId", "runnerKind"])
        .where("id", "=", minted.enrollmentId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      allowedModules: ["browser", "integrations"],
      ownerKind: "user",
      ownerUserId: host.ownerId,
      runnerKind: "local",
    });

    // A phone that says it can also run a shell is refused, and told why,
    // before the token is spent.
    const runnerId = createId("runner");
    const current = phoneDescriptor(runnerId);
    for (const integrations of [{ ...current.modules.integrations!, protocolVersion: 3 }]) {
      const outdated = await presentPhone(
        host,
        { ...current, modules: { integrations } },
        { token: minted.token },
      );
      expect(outdated.welcome).toBeNull();
      expect(outdated.refusal).toEqual({
        code: "forbidden",
        message: agentPhoneOutdatedReason,
        reason: "agent-phone-outdated",
        retryable: false,
      });
    }
    const widened = await presentPhone(
      host,
      phoneDescriptor(runnerId, {
        shell: { hostPublicKey: sshHostKey(), platform: "linux" },
      }),
      { token: minted.token },
    );
    expect(widened.refusal).toEqual({
      code: "forbidden",
      message: "Runner enrollment does not allow the shell module",
      retryable: false,
    });
    expect(widened.close?.code).toBe(4003);

    const enrolled = await presentPhone(host, phoneDescriptor(runnerId), { token: minted.token });
    expect(enrolled.welcome).toMatchObject({
      allowedModules: ["browser", "integrations"],
      runnerId,
    });
    expect(
      await host.store.database
        .selectFrom("runners")
        .select(["allowedModules", "device", "kind", "ownerUserId"])
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      allowedModules: ["browser", "integrations"],
      device: { form: "phone", platform: "android" },
      kind: "local",
      ownerUserId: host.ownerId,
    });
  }, 120_000);

  it("tells a phone by reason that its enrollment expired, then closes", async () => {
    host = await startMachineAccessWireHost(isolated!.url, { remoteAccess: true });
    const minted = await mintPhone(host, "pixel-expired");
    await host.store.database
      .updateTable("runnerEnrollments")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", minted.enrollmentId)
      .execute();

    const refused = await presentPhone(host, phoneDescriptor(createId("runner")), {
      token: minted.token,
    });
    expect(refused.frames.map(({ type }) => type)).toEqual(["host.challenge", "host.error"]);
    expect(refused.refusal).toEqual({
      code: "forbidden",
      message: "Runner enrollment expired",
      reason: "runner-enrollment-expired",
      retryable: false,
    });
    expect(refused.close?.code).toBe(4003);
  }, 120_000);

  it("pairs a Personal phone only over the live remote-access route, and sends it away by reason when that route goes", async () => {
    const personal = await startMachineAccessWireHost(isolated!.url);
    host = personal;

    // With remote access off there is no address a phone could use, so
    // nothing is minted.
    const refused = await testRpcRequest(
      personal.origin,
      "commands.dispatch",
      {
        idempotencyKey: "phone-before-route",
        name: "Pixel 8",
        type: "runner.enrollment.createPhone",
      },
      { headers: personal.ownerHeaders },
    );
    expect(await refused.json()).toMatchObject({
      error: {
        code: "forbidden",
        message: "Turn on remote access on this computer to connect other computers.",
        reason: "personal-remote-access-off",
      },
      ok: false,
    });
    expect(
      await personal.store.database.selectFrom("runnerEnrollments").select("id").execute(),
    ).toHaveLength(1);

    const routeOrigin = "https://personal.agent-phone.test";
    await configurePersonalRemoteAccess(personal, {
      schemaVersion: 1,
      mode: "private",
      routeOrigin,
    });
    const minted = await mintPhone(personal, "pixel-personal");
    expect(minted.pairing).toMatchObject({ deploymentName: "Fixture Mac", hostUrl: routeOrigin });

    // The phone's exact grant is a reachable one: Personal admits it.
    const runnerId = createId("runner");
    const enrolled = await presentPhone(personal, phoneDescriptor(runnerId), {
      token: minted.token,
    });
    expect(enrolled.welcome).toMatchObject({
      allowedModules: ["browser", "integrations"],
      runnerId,
    });

    await configurePersonalRemoteAccess(personal, {
      schemaVersion: 1,
      mode: "off",
      routeOrigin: null,
    });
    await waitForCondition(async () => {
      const state = await personal.store.database
        .selectFrom("personalRemoteAccess")
        .select("mode")
        .executeTakeFirstOrThrow();
      return state.mode === "off";
    });
    const away = await presentPhone(personal, phoneDescriptor(runnerId), {
      privateKey: enrolled.privateKey,
    });
    expect(away.refusal).toEqual({
      code: "forbidden",
      message: "Turn on remote access on this computer to connect other computers.",
      reason: "personal-remote-access-off",
      retryable: true,
    });
    expect(away.close?.code).toBe(1001);
  }, 180_000);
});

integration.sequential("Retiring a phone enrollment", () => {
  let isolated: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
  let host: MachineAccessHost | undefined;

  beforeAll(async () => {
    isolated = await createMachineAccessDatabase(baseDatabaseUrl!);
  }, 120_000);
  beforeEach(async () => {
    await resetMachineAccessDatabase(isolated!.url);
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
  });
  afterAll(async () => {
    await isolated?.drop();
  }, 120_000);

  it("makes a pending enrollment unusable at once, and says so again only as expired", async () => {
    host = await startMachineAccessWireHost(isolated!.url, { remoteAccess: true });
    const minted = await mintPhone(host, "pixel-retired");
    expect(await pendingEnrollments(host)).toContain(minted.enrollmentId);

    expect(await retirePhone(host, minted.enrollmentId)).toEqual({
      state: "retired",
      type: "runner.enrollment.retire",
    });
    expect(await pendingEnrollments(host)).not.toContain(minted.enrollmentId);
    const refused = await presentPhone(host, phoneDescriptor(createId("runner")), {
      token: minted.token,
    });
    expect(refused.welcome).toBeNull();
    expect(refused.refusal).toMatchObject({ reason: "runner-enrollment-expired" });
    expect(await retirePhone(host, minted.enrollmentId)).toMatchObject({ state: "expired" });
  }, 120_000);

  it("answers consumed for a redeemed enrollment and expired for one that ran out", async () => {
    host = await startMachineAccessWireHost(isolated!.url, { remoteAccess: true });
    const redeemed = await mintPhone(host, "pixel-redeemed");
    const runnerId = createId("runner");
    expect(
      (await presentPhone(host, phoneDescriptor(runnerId), { token: redeemed.token })).welcome,
    ).toMatchObject({ runnerId });
    expect(await retirePhone(host, redeemed.enrollmentId)).toMatchObject({ state: "consumed" });
    // The phone it made is untouched.
    expect(
      await host.store.database
        .selectFrom("runners")
        .select(["id", "revokedAt"])
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: runnerId, revokedAt: null });

    const lapsed = await mintPhone(host, "pixel-lapsed");
    await host.store.database
      .updateTable("runnerEnrollments")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", lapsed.enrollmentId)
      .execute();
    expect(await retirePhone(host, lapsed.enrollmentId)).toMatchObject({ state: "expired" });
  }, 120_000);

  it("never answers retired for an enrollment a phone redeems at the same moment", async () => {
    host = await startMachineAccessWireHost(isolated!.url, { remoteAccess: true });
    for (let round = 0; round < 12; round += 1) {
      const minted = await mintPhone(host, `pixel-race-${round}`);
      const runnerId = createId("runner");
      // The retirement starts as the phone answers its challenge, and the
      // phone presents its token a few milliseconds later, so each side wins
      // some rounds and the rest overlap.
      const retirement = Promise.withResolvers<Awaited<ReturnType<typeof retirePhone>>>();
      const arrival = await presentPhone(
        host,
        phoneDescriptor(runnerId),
        { token: minted.token },
        () => {
          void retirePhone(host!, minted.enrollmentId).then(retirement.resolve, retirement.reject);
          return delay((round % 4) * 2);
        },
      );
      const retired = await retirement.promise;
      const runner = await host.store.database
        .selectFrom("runners")
        .select("id")
        .where("id", "=", runnerId)
        .executeTakeFirst();
      if (retired.state === "retired") {
        expect(arrival.welcome).toBeNull();
        expect(runner).toBeUndefined();
      } else {
        expect(retired.state).toBe("consumed");
        expect(arrival.welcome).toMatchObject({ runnerId });
        expect(runner).toEqual({ id: runnerId });
      }
    }
  }, 300_000);
});

async function retirePhone(host: MachineAccessHost, enrollmentId: string) {
  const retired = await testRpcData(
    host.origin,
    "commands.dispatch",
    { enrollmentId, idempotencyKey: `retire-${randomUUID()}`, type: "runner.enrollment.retire" },
    { headers: host.ownerHeaders },
  );
  if (retired.type !== "runner.enrollment.retire") throw new Error("Not a retirement.");
  return retired;
}

async function pendingEnrollments(host: MachineAccessHost): Promise<string[]> {
  const { machines } = await testRpcData(
    host.origin,
    "machines.list",
    {},
    { headers: host.ownerHeaders },
  );
  return machines.flatMap((machine) =>
    machine.status === "pending" && machine.enrollmentId ? [machine.enrollmentId] : [],
  );
}

async function mintPhone(host: MachineAccessHost, key: string) {
  const minted = await testRpcData(
    host.origin,
    "commands.dispatch",
    { idempotencyKey: key, name: "Pixel 8", type: "runner.enrollment.createPhone" },
    { headers: host.ownerHeaders },
  );
  if (minted.type !== "runner.enrollment.createPhone") throw new Error("Not a phone enrollment.");
  return minted;
}

async function hostAuthority(host: MachineAccessHost) {
  const descriptor = (await (
    await fetch(`${host.origin.origin}/.well-known/opensteer`)
  ).json()) as {
    readonly authority: {
      readonly document: { readonly deploymentId: string; readonly hostInstanceId: string };
    };
  };
  return descriptor.authority.document;
}

/** A canonical OpenSSH ed25519 public key, which a shell module advertises. */
function sshHostKey(): string {
  const raw = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const field = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]).toString("base64")}`;
}

/** What the Agent Phone app says about itself when it connects. */
function phoneDescriptor(
  runnerId: ReturnType<typeof createId<"runner">>,
  extraModules: Partial<RunnerDescriptor["modules"]> = {},
): RunnerDescriptor {
  return RunnerDescriptorSchema.parse({
    bootId: `rbt_${randomUUID()}`,
    capabilities: [],
    device: { form: "phone", platform: "android" },
    modules: {
      integrations: { platform: "android", protocolVersion: 4 },
      ...extraModules,
    },
    name: "Pixel 8",
    runnerId,
    runnerKind: "local",
    runtimeVersion: "0.1.117",
  });
}

interface PhoneArrival {
  readonly close: { readonly code: number; readonly reason: string } | null;
  readonly frames: readonly { readonly type: string; readonly [key: string]: unknown }[];
  readonly privateKey: KeyObject;
  /** The `error` of the `host.error` frame, when the Host refused. */
  readonly refusal: unknown;
  readonly welcome: Record<string, unknown> | null;
}

/**
 * Connects as the phone does — redeeming a token, or proving the key it kept
 * — and reads until the Host welcomes or closes it, recording every frame.
 */
async function presentPhone(
  host: MachineAccessHost,
  descriptor: unknown,
  credentials: { readonly privateKey: KeyObject } | { readonly token: string },
  /** Runs once the Host has challenged the phone; it presents its token when this settles. */
  beforeEnroll: () => Promise<void> = async () => undefined,
  onWelcome: () => Promise<void> = async () => undefined,
  proofFormatVersion: number = 2,
): Promise<PhoneArrival> {
  const keys = "token" in credentials ? generateKeyPairSync("ed25519") : null;
  const privateKey =
    keys?.privateKey ?? ("privateKey" in credentials ? credentials.privateKey : null);
  if (!privateKey) throw new Error("No key to prove the phone's identity with.");
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
  const frames: { type: string; [key: string]: unknown }[] = [];
  let welcome: Record<string, unknown> | null = null;
  const close = await new Promise<{ code: number; reason: string } | null>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("The Host never answered the phone.")),
      15_000,
    );
    socket.on("message", (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { type: string; [key: string]: unknown };
      frames.push(message);
      if (message.type === "host.challenge") {
        const challenge = RunnerChallengeSchema.parse(message);
        if ("token" in credentials && keys) {
          const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
          const credential = RunnerEnrollmentCredentialSchema.parse({
            enrollmentToken: credentials.token,
            kind: "host-enrollment-token",
          });
          const enroll = JSON.stringify({
            challengeId: challenge.challengeId,
            credential,
            descriptor,
            publicKeyPem,
            signature: createRunnerEnrollmentSignature(keys.privateKey, {
              challenge,
              credential,
              descriptor,
              publicKeyPem,
            }),
            proofFormatVersion: proofFormatVersion === 0 ? undefined : proofFormatVersion,
            type: "runner.enroll",
          });
          void beforeEnroll().then(() => socket.send(enroll), reject);
        } else {
          socket.send(
            JSON.stringify({
              challengeId: challenge.challengeId,
              descriptor,
              signature: createRunnerAuthenticationSignature(privateKey, {
                challenge,
                descriptor,
              }),
              proofFormatVersion: proofFormatVersion === 0 ? undefined : proofFormatVersion,
              type: "runner.authenticate",
            }),
          );
        }
      }
      if (message.type === "host.welcome") {
        welcome = message;
        clearTimeout(timeout);
        void onWelcome().then(() => {
          socket.close(1000, "Phone test done");
          resolve(null);
        }, reject);
      }
    });
    socket.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", reject);
  });
  const refusal = frames.find(({ type }) => type === "host.error")?.error ?? null;
  return { close, frames, privateKey, refusal, welcome };
}
