/** Real protocol-3/identity-v1 installation, old Host enrollment, then an actual Host/DB upgrade. */
import { Writable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerIdSchema } from "@opensteer/core";
import { agentPhoneAccessibilityService, androidPhoneDefinitionId } from "@opensteer/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { createHostRuntime, type HostRuntime } from "../runtime/runtime.js";
import { freePort, machineAccessHostConfig } from "../runtime/machine-access.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  acquireAndroidDevice,
  agentPhonePids,
  assertNoPhoneApprovalActivity,
  createTestCertificateAuthority,
  DeviceLog,
  eventually,
  readPhoneStatus,
  Redaction,
  startTlsFrontDoor,
  waitForPhoneOnline,
  writeDeviceTestManifest,
  type AgentPhoneOwner,
  type AndroidDevice,
  type TlsFrontDoor,
} from "./agent-phone-device.test-support.js";
import { startPhoneBaseline } from "./agent-phone-baseline.test-support.js";
import { buildPhoneUpdateFixtures, tapSystemUpdate } from "./agent-phone-update.test-support.js";
import type { AgentPhoneUpdateRelease } from "./update-release.js";
import { computerStatus } from "@opensteer/client/computers";

const enabled = process.env.OPENSTEER_AGENT_PHONE_SELF_UPDATE === "1";
const api = Number(process.env.OPENSTEER_AGENT_PHONE_API ?? 36);
const IdentityFactsSchema = z.object({
  version: z.number(),
  approvalSeedPresent: z.boolean(),
  runnerId: RunnerIdSchema,
  runnerKeySha256: z.string(),
  deploymentId: z.string(),
  deploymentName: z.string(),
  enrollmentId: z.string(),
  hostInstanceId: z.string(),
  hostUrl: z.url(),
  hostVerified: z.boolean(),
  lastConnectionGeneration: z.number(),
});
const BaselineSetupSchema = z.object({
  steps: z.array(z.unknown()),
  result: z
    .object({ outcome: z.string(), issue: z.object({ code: z.string() }).optional() })
    .loose(),
  status: z.object({ pairing: z.object({ runnerId: RunnerIdSchema }).loose() }).loose(),
  connection: z
    .object({ id: z.string(), computer: z.object({ access: z.enum(["read", "read-write"]) }) })
    .loose()
    .nullable(),
  runner: z.object({
    id: RunnerIdSchema,
    ownerUserId: z.string(),
    publicKeyFingerprint: z.string(),
    connectionGeneration: z.coerce.number(),
    moduleDescriptors: z
      .object({
        integrations: z
          .object({ platform: z.literal("android"), protocolVersion: z.literal(3) })
          .loose(),
      })
      .loose(),
  }),
});

describe.skipIf(!enabled)(`Agent Phone actual baseline cutover on API ${api}`, () => {
  const redaction = new Redaction();
  const cleanupResults: unknown[] = [];
  let directory = "";
  let scratch = "";
  let authority: Awaited<ReturnType<typeof createTestCertificateAuthority>>;
  let fixtures: Awaited<ReturnType<typeof buildPhoneUpdateFixtures>> | undefined;
  beforeAll(async () => {
    const base =
      process.env.OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-phone-cutover-")));
    directory = join(base, `cutover-api${api}`);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    scratch = await mkdtemp(join(tmpdir(), "opensteer-phone-cutover-scratch-"));
    authority = await createTestCertificateAuthority(scratch);
    fixtures = await buildPhoneUpdateFixtures(directory, authority.caPath);
  }, 1_800_000);
  afterAll(async () => {
    try {
      await fixtures?.close();
      cleanupResults.push({ resource: "baseline-worktree", stopped: true });
    } catch (error) {
      cleanupResults.push({
        resource: "baseline-worktree",
        stopped: false,
        error: redaction.error(error),
      });
      throw error;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
      if (directory) await writeDeviceTestManifest(directory, redaction, cleanupResults);
    }
  }, 300_000);

  it.each(["allow", "deny"] as const)(
    "%s: preserves the baseline identity and existing access across network update",
    async (decision) => {
      const built = fixtures!;
      const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
      const serial = process.env.ANDROID_SERIAL;
      if (!databaseUrl || !serial?.startsWith("emulator-"))
        throw new Error(
          "Cutover requires the integration launcher and an explicit emulator serial owned by this run",
        );
      const journey = join(directory, decision);
      await mkdir(journey, { recursive: true });
      const evidence: Record<string, unknown> = {
        api,
        serial,
        decision,
        baselineRevision: built.baselineRevision,
      };
      const phases: { name: string; status: string; error?: string }[] = [];
      const cleanup: { name: string; close: () => Promise<unknown> }[] = [];
      const teardown: unknown[] = [];
      const hostLog: string[] = [];
      const baselineLog: string[] = [];
      let runtime: HostRuntime | undefined;
      let release: AgentPhoneUpdateRelease | null = null;
      let phone: AndroidDevice | undefined;
      const json = (name: string, value: unknown) =>
        writeFile(join(journey, name), redaction.apply(JSON.stringify(value, null, 2)) + "\n");
      async function phase<T>(name: string, action: () => Promise<T>) {
        try {
          const value = await action();
          phases.push({ name, status: "passed" });
          return value;
        } catch (error) {
          phases.push({ name, status: "failed", error: redaction.error(error) });
          throw error;
        }
      }
      let door: TlsFrontDoor | undefined;
      try {
        phone = await acquireAndroidDevice({ api, emulatorLog: join(journey, "emulator.log") });
        const device = phone;
        cleanup.push({ name: "device", close: () => device.close() });
        // Android lets an installer silently update one package once per 30 s,
        // and allow and deny each update this package on one device back to
        // back. `pm` exits 1 even when it applies this policy; a refusal says "Failure".
        if (api >= 31) {
          const policy = await device.shell(
            "pm set-silent-updates-policy --allow-unlimited-silent-updates com.opensteer.agentphone; echo applied",
          );
          if (policy.includes("Failure"))
            throw new Error(`Silent-update policy refused: ${policy}`);
          cleanup.push({
            name: "silent-update-policy",
            close: () => device.shell("pm set-silent-updates-policy --reset; echo reset"),
          });
        }
        const deviceLog = new DeviceLog(device);
        await deviceLog.start();
        cleanup.push({
          name: "device-log",
          close: async () => {
            await deviceLog.stop();
            await writeFile(
              join(journey, "logcat-device.txt"),
              redaction.apply(deviceLog.allLines().join("\n")) + "\n",
            );
          },
        });
        // The old APK is installed once; every replacement thereafter is Android's network updater.
        await device.adb(["uninstall", "com.opensteer.agentphone"]).catch(() => undefined);
        const uninstallOwned = async (packageName: string) => {
          const installed = async () =>
            (await device.shell(`pm list packages ${packageName}`))
              .split(/\r?\n/u)
              .includes(`package:${packageName}`);
          if (await installed()) await device.adb(["uninstall", packageName]);
          expect(await installed(), "owned test installation is removed").toBe(false);
        };
        cleanup.push({
          name: "test-signed-phone-installation",
          close: () => uninstallOwned("com.opensteer.agentphone"),
        });
        const publicPort = await freePort();
        const baseline = await startPhoneBaseline({
          baseline: built.baseline,
          scratch,
          directory: journey,
          apkPath: join(directory, "0.1.145/opensteer-agent-phone.apk"),
          databaseUrl,
          publicPort,
          serial,
          decision,
          redaction,
          log: (line) => baselineLog.push(line),
        });
        cleanup.push({ name: "baseline-host-database", close: () => baseline.close() });
        door = await startTlsFrontDoor({
          authority,
          hostPort: baseline.host.hostPort,
          port: publicPort,
        });
        const frontDoor = door;
        cleanup.push({ name: "tls-front-door", close: () => frontDoor.close() });
        const owner: AgentPhoneOwner = {
          origin: baseline.host.origin,
          ownerHeaders: baseline.host.ownerHeaders,
        };
        const before = await phase(
          "real-baseline-usb-setup-with-historical-owner-answer",
          async () => {
            const result = BaselineSetupSchema.parse(await baseline.setup(built.old.manifest));
            if (decision === "allow") {
              expect(result.result.outcome).toBe("done");
              expect(result.connection?.computer.access).toBe("read-write");
            } else {
              expect(result.result).toMatchObject({
                outcome: "issue",
                issue: { code: "access-declined" },
              });
              expect(result.connection, "baseline Decline creates no connection").toBeNull();
            }
            return result;
          },
        );
        const runnerId = before.status.pairing.runnerId;
        evidence.baseline = before;
        await device.adb(["install", "-r", built.observer]);
        cleanup.push({
          name: "identity-observer-installation",
          close: () => uninstallOwned("com.opensteer.agentphone.identityprobe"),
        });
        const probe = async (name: string) => {
          const output = await device.shell(
            "am instrument -w com.opensteer.agentphone.identityprobe/com.opensteer.agentphone.identityprobe.IdentityProbe",
            { timeoutMs: 60_000 },
          );
          await writeFile(join(journey, `${name}-instrumentation.txt`), output);
          const raw = /^INSTRUMENTATION_RESULT: identityFacts=(.+)$/mu.exec(output)?.[1];
          if (!raw || !output.includes("INSTRUMENTATION_CODE: -1"))
            throw new Error("Read-only identity observer failed; see instrumentation artifact");
          return IdentityFactsSchema.parse(JSON.parse(raw));
        };
        const initialIdentity = await phase("read-actual-encrypted-v1-identity", async () => {
          const identity = await probe("baseline-identity");
          expect(identity).toMatchObject({ version: 1, approvalSeedPresent: true, runnerId });
          return identity;
        });
        evidence.initialIdentity = initialIdentity;
        await phase("stop-old-host-and-run-current-migrations-on-the-same-database", async () => {
          await baseline.stopHost();
          const info = baseline.host;
          const config = machineAccessHostConfig(
            info.hostPort,
            info.dataDirectory,
            new URL(info.managerUrl),
            info.databaseUrl,
            "invite-only",
            new URL(info.publicOrigin),
          );
          runtime = await createHostRuntime(config, {
            phoneUpdateRelease: () => release,
            logger: {
              level: "info",
              redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
              stream: new Writable({
                write(chunk: Buffer | string, _encoding, done) {
                  hostLog.push(chunk.toString());
                  done();
                },
              }),
            },
          });
          const current = runtime;
          cleanup.push({ name: "current-host", close: () => current.close() });
          await current.listen();
        });
        const integrations = async () =>
          (
            await testRpcData(owner.origin, "integrations.get", {}, { headers: owner.ownerHeaders })
          ).connections.filter(
            (row) =>
              row.definitionId === androidPhoneDefinitionId &&
              row.computer?.runnerId === runnerId &&
              row.status !== "revoked",
          );
        const accessPreserved = async () => {
          const connections = await integrations();
          if (decision === "deny")
            expect(connections, "declined baseline never gains a connection").toEqual([]);
          else {
            expect(connections).toHaveLength(1);
            expect(connections[0]).toMatchObject({
              id: before.connection!.id,
              computer: { access: before.connection!.computer.access },
            });
          }
          return connections;
        };
        await phase("migration-preserves-the-owner-access-decision", accessPreserved);
        // Android never rebinds an accessibility service whose process it saw
        // die while bound, so the runtime is restarted as setup enables it:
        // unbound, its old process ended, then bound again into a new one.
        // Android lists a bound accessibility service by its label, the same in both apps.
        const bound = async () =>
          /Bound services:\{[^\n]*label=Opensteer Agent Phone\b/u.test(
            await device.shell("dumpsys accessibility"),
          );
        const restartPhone = async (reason: string) => {
          evidence[`restart-${reason}`] = {
            reason,
            command: "unbind the accessibility service, end its process, bind it again",
          };
          const pids = await agentPhonePids(device);
          const enabled = (
            await device.shell("settings get secure enabled_accessibility_services")
          ).trim();
          const others = enabled
            .split(":")
            .filter(
              (service) =>
                service && service !== "null" && service !== agentPhoneAccessibilityService,
            );
          await device.shell(
            others.length === 0
              ? "settings delete secure enabled_accessibility_services"
              : `settings put secure enabled_accessibility_services ${others.join(":")}`,
          );
          await eventually(
            "the runtime's accessibility service to unbind",
            async () => ((await bound()) ? undefined : true),
            30_000,
          );
          for (const pid of pids) await device.shell(`su 0 kill -9 ${pid}`);
          await device.shell(
            `settings put secure enabled_accessibility_services ${[...others, agentPhoneAccessibilityService].join(":")}`,
          );
          await device.shell("settings put secure accessibility_enabled 1");
          await eventually(
            "the runtime's accessibility service to bind again",
            async () => ((await bound()) ? true : undefined),
            30_000,
          );
          return eventually(
            "a new Agent Phone runtime process",
            async () => (await agentPhonePids(device)).find((pid) => !pids.includes(pid)),
            30_000,
          );
        };
        await phase("protocol-3-authenticated-refusal-is-agent-phone-outdated", async () => {
          await restartPhone("observe-protocol-refusal");
          const refusal = await eventually(
            "authenticated agent-phone-outdated refusal",
            async () =>
              hostLog.find(
                (line) =>
                  line.includes('"reason":"agent-phone-outdated"') &&
                  line.includes('"authenticated":true'),
              ),
            90_000,
          );
          evidence.refusal = refusal;
          expect(
            (
              await runtime!.store.database
                .selectFrom("runners")
                .select("updateRequired")
                .where("id", "=", runnerId)
                .executeTakeFirstOrThrow()
            ).updateRequired,
          ).toBe("agent-phone-outdated");
        });
        await phase("unauthenticated-update-receives-no-apk-bytes", async () => {
          release = built.next;
          const unauthorized = await new Promise<{ closeCode: number; binaryBytes: number }>(
            (resolve, reject) => {
              const socket = new WebSocket(
                `${owner.origin.replace(/^http/u, "ws")}/internal/v1/runners/agent-phone-update`,
              );
              let binaryBytes = 0;
              const timer = setTimeout(() => {
                socket.terminate();
                reject(new Error("Unauthenticated update did not close"));
              }, 5_000);
              socket.on("error", (error) => {
                clearTimeout(timer);
                socket.terminate();
                reject(error);
              });
              socket.on("message", (bytes, binary) => {
                if (binary) binaryBytes += bytes.toString().length;
                else
                  socket.send(
                    JSON.stringify({
                      type: "phone.update.download",
                      apkSha256: built.next.manifest.apkSha256,
                    }),
                  );
              });
              socket.on("close", (closeCode) => {
                clearTimeout(timer);
                resolve({ closeCode, binaryBytes });
              });
            },
          );
          expect(unauthorized).toEqual({ closeCode: 1008, binaryBytes: 0 });
          evidence.unauthorized = unauthorized;
        });
        if (decision === "allow")
          for (const [name, bad] of built.rejected)
            await phase(`reject-${name}-without-reinstall`, async () => {
              release = bad;
              const pid = await restartPhone(name);
              const expectedReason =
                name === "signer-mismatch"
                  ? "The update signer is not the pinned release signer"
                  : name === "digest-mismatch"
                    ? "The update digest or size differs"
                    : "Downgrades are refused";
              const rejectionLog = await eventually(
                `${name} refusal from this runtime process`,
                async () => {
                  const log = await device.shell(`logcat -d --pid=${pid} -s AgentPhone:W`);
                  return log.includes(`Agent Phone self-update failed: ${expectedReason}`)
                    ? log
                    : undefined;
                },
                90_000,
              );
              const row = await eventually(
                `${name} update rejection`,
                async () =>
                  (
                    await testRpcData(
                      owner.origin,
                      "machines.list",
                      {},
                      { headers: owner.ownerHeaders },
                    )
                  ).machines.find(
                    (machine) =>
                      machine.id === runnerId && machine.detail?.includes("couldn’t update"),
                  ),
                90_000,
              );
              expect(computerStatus(row).label).toContain("couldn’t update");
              const installed = await device.shell("dumpsys package com.opensteer.agentphone");
              expect(installed).toContain(`versionCode=${built.old.manifest.versionCode}`);
              evidence[name] = {
                row,
                pid,
                expectedReason,
                releaseVersion: bad.manifest.versionCode,
                releaseDigest: bad.manifest.apkSha256,
                rejectionLog,
              };
            });
        await phase("authenticated-network-install-and-protocol-4-reconnect", async () => {
          release = built.next;
          await restartPhone("enable-current-release");
          if (api === 30) {
            const pending = await eventually(
              "Android install consent on API 30",
              async () =>
                (
                  await testRpcData(
                    owner.origin,
                    "machines.list",
                    {},
                    { headers: owner.ownerHeaders },
                  )
                ).machines.find(
                  (machine) => machine.id === runnerId && machine.status === "update-pending",
                ),
              90_000,
            );
            expect(computerStatus(pending).label).toBe(`Tap Update on ${pending.name}.`);
            await writeFile(join(journey, "system-update-consent.png"), await device.screencap());
            await tapSystemUpdate(device);
          }
          await waitForPhoneOnline(device, owner, runnerId, 120_000);
          const after = await readPhoneStatus(device);
          expect(after.app.versionCode).toBe(built.next.manifest.versionCode);
          expect(after.pairing, "complete pairing survives network APK replacement").toEqual(
            before.status.pairing,
          );
          const runner = await runtime!.store.database
            .selectFrom("runners")
            .select([
              "id",
              "ownerUserId",
              "publicKeyFingerprint",
              "connectionGeneration",
              "moduleDescriptors",
            ])
            .where("id", "=", runnerId)
            .executeTakeFirstOrThrow();
          expect(runner.publicKeyFingerprint).toBe(before.runner.publicKeyFingerprint);
          expect(runner.ownerUserId).toBe(before.runner.ownerUserId);
          expect(Number(runner.connectionGeneration)).toBeGreaterThan(
            before.runner.connectionGeneration,
          );
          expect(runner.moduleDescriptors.integrations).toMatchObject({
            platform: "android",
            protocolVersion: 4,
          });
          await assertNoPhoneApprovalActivity(device);
          evidence.after = { status: after, runner, connections: await accessPreserved() };
        });
        await phase("persisted-v2-identity-survives-a-process-restart", async () => {
          const migrated = await probe("migrated-identity");
          expect(migrated).toMatchObject({
            ...initialIdentity,
            version: 2,
            approvalSeedPresent: false,
            lastConnectionGeneration: expect.any(Number),
          });
          expect(migrated.lastConnectionGeneration).toBeGreaterThan(
            initialIdentity.lastConnectionGeneration,
          );
          await restartPhone("v2-persistence");
          await waitForPhoneOnline(device, owner, runnerId, 120_000);
          const persisted = await probe("restarted-identity");
          expect(persisted).toMatchObject({
            ...migrated,
            lastConnectionGeneration: expect.any(Number),
          });
          expect(persisted.lastConnectionGeneration).toBeGreaterThan(
            migrated.lastConnectionGeneration,
          );
          await restartPhone("after-read-only-observer");
          await waitForPhoneOnline(device, owner, runnerId, 120_000);
          await accessPreserved();
          await assertNoPhoneApprovalActivity(device);
          evidence.identity = { migrated, persisted };
        });
        await writeFile(join(journey, "updated-phone.png"), await device.screencap());
        evidence.passed = true;
      } catch (error) {
        evidence.failure = redaction.error(error);
        throw error;
      } finally {
        const phoneLog = phone
          ? redaction.apply(
              await phone
                .shell("logcat -d -s AgentPhone:I AndroidRuntime:E")
                .catch((error: unknown) => redaction.error(error)),
            )
          : "No device acquired";
        for (const resource of cleanup.reverse()) {
          try {
            await resource.close();
            teardown.push({ name: resource.name, stopped: true });
          } catch (error) {
            teardown.push({ name: resource.name, stopped: false, error: redaction.error(error) });
          }
        }
        await writeFile(join(journey, "phone.log"), phoneLog);
        await writeFile(
          join(journey, "baseline-host.log"),
          redaction.apply(baselineLog.join("\n")),
        );
        await writeFile(join(journey, "host.log"), redaction.apply(hostLog.join("\n")));
        await json("result.json", evidence);
        await json("steps.json", phases);
        cleanupResults.push({ decision, teardown });
        await writeDeviceTestManifest(journey, redaction, teardown);
        expect(
          teardown.filter(
            (entry) => z.object({ stopped: z.literal(false) }).safeParse(entry).success,
          ),
          "cutover teardown must stop every owned resource",
        ).toEqual([]);
      }
    },
  );
});
