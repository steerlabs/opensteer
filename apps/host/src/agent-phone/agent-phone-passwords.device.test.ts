import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentPhoneAccessibilityService,
  RunnerAuxiliaryWelcomeSchema,
  RunnerIntegrationsStatusSchema,
  type AndroidPhoneAction,
} from "@opensteer/protocol";
import { RequestIdSchema, type RunnerId, type WorkspaceId } from "@opensteer/core";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { PasswordsJourneyEvidence } from "../browser/passwords-evidence.test-support.js";
import {
  passwordFixture,
  startPasswordsAuthority,
} from "../browser/passwords-authority.test-support.js";
import {
  acceptCallerRun,
  waitForExecute,
  connectCallerMachine,
  configurePersonalRemoteAccess,
  createMachineAccessDatabase,
  dispatchCallerRun,
  freePort,
  startPersonalMachineAccessHost,
  stopRun,
} from "../runtime/machine-access.test-support.js";
import {
  acquireAndroidDevice,
  buildE2eAgentPhone,
  clearReceipts,
  connectAgentGateway,
  createTestCertificateAuthority,
  elementIndex,
  eventually,
  installFixture,
  phoneRowOf,
  readObservation,
  readReceipts,
  Redaction,
  DeviceLog,
  agentPhonePids,
  resetPhone,
  resultText,
  runAgentPhoneSetup,
  startTlsFrontDoor,
  waitForPhoneOnline,
  type AndroidDevice,
  type AgentGateway,
  type TlsFrontDoor,
  type PhoneToolRefs,
  type ToolResult,
} from "./agent-phone-device.test-support.js";

const cases = [
  "saved-fields-and-totp",
  "no-totp",
  "expired",
  "declined",
  "revoked",
  "revision-changed",
  "cross-workspace",
  "old-capability-batch",
  "malformed",
  "tampered",
  "wrong-context",
  "stop-delayed",
  "expiry-delayed",
  "disconnect-delayed",
  "restart-delayed",
  "replay",
  "concurrent-fields",
  "secure-fallback",
  "unicode",
  "empty",
  "controls",
] as const;
type Case = (typeof cases)[number];
const command =
  "OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR=/tmp/opensteer-passwords-anywhere/evidence/phone-negative pnpm test:agent-phone apps/host/src/agent-phone/agent-phone-passwords.device.test.ts";
const unicode = "\uFEFFhéllo 😀 e\u0301 مرحبا";

describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "Saved login references on the real Agent Phone executor",
  () => {
    const cleanups: (() => Promise<unknown>)[] = [];
    const wire: {
      host: Record<string, unknown>[];
      phone: Record<string, unknown>[];
      mapHost?: (frame: Record<string, unknown>) => Record<string, unknown> | null;
      mapPhone?: (frame: Record<string, unknown>) => Record<string, unknown> | null;
    } = { host: [], phone: [] };
    let device: AndroidDevice;
    let host: Awaited<ReturnType<typeof startPersonalMachineAccessHost>>;
    let caller: Awaited<ReturnType<typeof connectCallerMachine>>;
    let authority: Awaited<ReturnType<typeof startPasswordsAuthority>>;
    let door: TlsFrontDoor;
    let phoneId: RunnerId;
    let mainWorkspaceId: WorkspaceId;
    let deviceLog: DeviceLog | undefined;
    const phonePids = new Set<number>();
    const callerDiagnostics: unknown[] = [];
    const suiteEvidence = new PasswordsJourneyEvidence(
      "phone-negative/setup",
      command,
      ["setup", ...cases],
      [passwordFixture.password, unicode],
    );
    const redaction = new Redaction();
    beforeAll(async () => {
      await suiteEvidence.run("setup", async () => {
        const scratch = await mkdtemp(join(tmpdir(), "passwords-phone-"));
        cleanups.push(() => rm(scratch, { force: true, recursive: true }));
        const ca = await createTestCertificateAuthority(scratch);
        const build = await buildE2eAgentPhone({ authority: ca, log: join(scratch, "build.log") });
        device = await acquireAndroidDevice({
          api: 36,
          emulatorLog: join(scratch, "emulator.log"),
        });
        cleanups.push(() => device.close());
        deviceLog = new DeviceLog(device);
        await deviceLog.start();
        cleanups.push(async () => deviceLog?.stop());
        await resetPhone(device);
        await installFixture(device);
        const database = await createMachineAccessDatabase(
          process.env.OPENSTEER_TEST_DATABASE_URL!,
        );
        cleanups.push(() => database.drop());
        const port = await freePort();
        const publicOrigin = new URL(`https://10.0.2.2:${port}`);
        host = await startPersonalMachineAccessHost(database.url);
        cleanups.push(() => host.close());
        door = await startTlsFrontDoor({
          authority: ca,
          hostPort: host.hostPort,
          port,
          passwordsWire: wire,
        });
        cleanups.push(() => door.close());
        caller = await connectCallerMachine(host, {
          name: "Personal vault Mac",
          environmentId: host.ownerEnvironmentId,
          localDirectory: true,
          runnerKind: "main",
          token: host.mainRunnerEnrollmentToken,
          integrations: { platform: "darwin", protocolVersion: 5, passwordSignIn: 1 },
        });
        caller.primary.socket.on("close", (code: number, reason: Buffer) =>
          callerDiagnostics.push({ type: "socket.closed", code, reason: reason.toString("utf8") }),
        );
        caller.primary.socket.on("message", (raw: Buffer) => {
          const parsed = z
            .object({
              type: z.string(),
              command: z
                .object({
                  type: z.string(),
                  commandId: z.string().optional(),
                  context: z.object({ runId: z.string(), threadId: z.string() }).optional(),
                })
                .optional(),
            })
            .safeParse(JSON.parse(raw.toString()));
          if (
            parsed.success &&
            (parsed.data.type === "host.command" || parsed.data.type === "host.runs.revoked")
          )
            callerDiagnostics.push(parsed.data);
        });
        cleanups.push(() => caller.close());
        authority = await startPasswordsAuthority(host.hostPort, caller.primary);
        cleanups.push(() => authority.close());
        await configurePersonalRemoteAccess(host, {
          mode: "private",
          routeOrigin: publicOrigin.origin,
        });
        const setup = await runAgentPhoneSetup({
          artifact: build.artifact,
          device,
          host,
          redaction,
          runnerName: "Saved login Pixel",
          timeoutMs: 600_000,
        });
        if (setup.outcome !== "done")
          throw new Error(`Phone setup stopped: ${JSON.stringify(setup)}`);
        phoneId = setup.runnerId;
        await waitForPhoneOnline(device, host, phoneId, 60_000);
        const main = await host.store.findMainWorkspaceForOwner(host.ownerId);
        if (!main) throw new Error("Missing Main Workspace");
        mainWorkspaceId = main.id;
        for (const pid of await agentPhonePids(device)) phonePids.add(pid);
        await suiteEvidence.write("apk.json", build.manifest);
      });
    }, 900_000);
    afterAll(async () => {
      if (host)
        await suiteEvidence.write(
          "caller-command-state.json",
          await host.store.database
            .selectFrom("commands")
            .select(["id", "type", "runId", "status", "lastError"])
            .execute(),
        );
      const failures: unknown[] = [];
      for (const close of cleanups.splice(0).reverse())
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      const rawLogcat = deviceLog?.linesFrom(phonePids).join("\n") ?? "";
      suiteEvidence.scan("raw-device-logcat-all-processes", deviceLog?.allLines().join("\n") ?? "");
      suiteEvidence.scan("raw-logcat-before-redaction", rawLogcat);
      await suiteEvidence.write("caller-diagnostics.json", callerDiagnostics);
      await suiteEvidence.write("teardown.json", failures.map(String));
      await suiteEvidence.finish({ "logcat.txt": redaction.apply(rawLogcat) });
      expect(failures, "all owned emulator, adb, Host and database resources stop").toEqual([]);
    }, 300_000);

    it.each(cases)("%s", async (name: Case) => {
      // The phone's grant belongs to Main. Distinct saved sites isolate fresh
      // authorization starts without extending that grant to other Workspaces.
      const site = `https://passwords-${name}.test`;
      const evidence = new PasswordsJourneyEvidence(
        `phone-negative/${name}`,
        command,
        [name],
        [passwordFixture.password, unicode],
      );
      const gateways: AgentGateway[] = [];
      const runs: Awaited<ReturnType<typeof dispatchCallerRun>>[] = [];
      const finishedRuns = new Set<string>();
      const results: ToolResult[] = [];
      let held: Record<string, unknown> | undefined;
      const authorityCommandsBefore = authority.commands.length;
      const connectionFences: unknown[] = [];
      const currentConnection = () => {
        const frame = wire.host.findLast(
          (frame) => frame.type === "host.welcome" && frame.runnerId === phoneId,
        );
        return phoneConnection.parse(frame);
      };
      const reconnected = async (previous: z.infer<typeof phoneConnection>) => {
        const next = await eventually(
          "a newer authenticated phone connection and ready integrations stream",
          async () => {
            const welcome = currentConnection();
            if (
              welcome.connectionGeneration <= previous.connectionGeneration ||
              welcome.connectionId === previous.connectionId
            )
              return undefined;
            const auxiliary = wire.host.some((frame) => {
              const parsed = RunnerAuxiliaryWelcomeSchema.safeParse(frame);
              return (
                parsed.success &&
                parsed.data.module === "integrations" &&
                parsed.data.runnerId === phoneId &&
                parsed.data.connectionGeneration === welcome.connectionGeneration &&
                parsed.data.connectionId === welcome.connectionId
              );
            });
            const ready = wire.phone.some((frame) => {
              const parsed = RunnerIntegrationsStatusSchema.safeParse(frame);
              return (
                parsed.success &&
                parsed.data.runnerId === phoneId &&
                parsed.data.connectionGeneration === welcome.connectionGeneration &&
                parsed.data.connectionId === welcome.connectionId
              );
            });
            return auxiliary && ready ? welcome : undefined;
          },
          60_000,
        );
        await waitForPhoneOnline(device, host, phoneId, 60_000);
        connectionFences.push({ previous, next, integrationsReady: true });
        await evidence.write("connection-fences.json", connectionFences);
      };
      try {
        await evidence.run(name, async () => {
          Object.assign(authority.policy, {
            approval: name === "declined",
            declined: name === "declined",
            hasTOTP: name !== "no-totp",
            revoked: false,
            revisionChanged: false,
            expired: false,
            holdSeal: false,
          });
          const mode = ["unicode", "empty", "controls"].includes(name)
            ? name
            : name === "secure-fallback"
              ? name
              : "login";
          authority.values.password =
            name === "unicode"
              ? unicode
              : name === "empty"
                ? ""
                : name === "controls"
                  ? "a\r\nb\tc"
                  : passwordFixture.password;
          await device.shell(`am force-stop com.opensteer.agentphone.fixture`);
          await device.shell(
            `am start -n com.opensteer.agentphone.fixture/.PasswordsActivity --es mode ${mode}`,
          );
          await clearReceipts(device);
          const run = await dispatchCallerRun(host, caller, {
            key: `passwords-${name}`,
            title: name,
            workspaceId: mainWorkspaceId,
          });
          runs.push(run);
          await evidence.write("authorization-scope.json", {
            workspaceId: run.workspaceId,
            site,
          });
          const gateway = await connectAgentGateway(host, run.integrationTools);
          const signInGateway = await connectAgentGateway(host, {
            url: new URL(hostInternalRoutePaths.mcp, host.config.runtimeOrigin).href,
            token: run.agentControlToken,
          });
          gateways.push(gateway, signInGateway);
          const call = async (name: string, args: Record<string, unknown>) => {
            const result = await gateway.call(name, args);
            results.push(result);
            evidence.scan(`raw:${name}`, JSON.stringify(result));
            return result;
          };
          const row = phoneRowOf(
            await call("integration_search", { query: "Android phone" }),
            phoneId,
          );
          if (!row.toolRefs?.act) throw new Error("Phone has no act tool");
          const refs: PhoneToolRefs = row.toolRefs;
          const observe = async () => {
            const result = await call("integration_call", { toolRef: refs.observe });
            expect(result.isError).not.toBe(true);
            return readObservation(resultText(result));
          };
          let observation = await observe();
          if (name === "secure-fallback") {
            expect(observation.treeText).not.toContain(passwordFixture.password);
            expect(observation.treeText).toMatch(/password/iu);
            return;
          }
          const ready = await signInGateway.call("sign_in", {
            site,
            reason: "Sign in to the synthetic phone app",
          });
          results.push(ready);
          if (name === "declined") {
            const pending = z
              .object({ status: z.literal("pending"), requestId: RequestIdSchema })
              .parse(ready.structuredContent);
            const operation = authority.commands.findLast((c) => c.type === "login.authorize");
            if (operation?.type !== "login.authorize") throw new Error("Missing authorization");
            const continued = waitForExecute(caller.primary.socket);
            authority.authorize(operation.operationId);
            await eventually(
              "workspace approval is declined",
              async () => {
                const request = await host.store.requests.get(pending.requestId);
                return request?.status === "declined" ? request : undefined;
              },
              10_000,
            );
            await run.complete();
            finishedRuns.add(run.runId);
            const continuation = await acceptCallerRun(host, caller, await continued);
            runs.push(continuation);
            expect(continuation.threadId).toBe(run.threadId);
            expect(continuation.workspaceId).toBe(run.workspaceId);
            expect(continuation.runId).not.toBe(run.runId);
            await evidence.write("decline-continuation.json", {
              runId: continuation.runId,
              threadId: continuation.threadId,
              workspaceId: continuation.workspaceId,
            });
            await continuation.complete();
            finishedRuns.add(continuation.runId);
            expect(await readReceipts(device)).toEqual([]);
            return;
          }
          const { loginRef } = z
            .object({ status: z.literal("ready"), loginRef: z.string() })
            .parse(ready.structuredContent);
          const authorize = authority.commands.findLast((c) => c.type === "login.authorize");
          if (authorize?.type !== "login.authorize") throw new Error("Missing authorization");
          const act = async (actions: readonly AndroidPhoneAction[], active = gateway) => {
            const result = await active.call("integration_call", {
              toolRef: refs.act!,
              arguments: { observationId: observation.observationId, actions },
            });
            results.push(result);
            evidence.scan("raw:act", JSON.stringify(result));
            if (!result.isError) observation = readObservation(resultText(result));
            return result;
          };
          const saved = (
            field: "username" | "password" | "code",
          ): Extract<AndroidPhoneAction, { type: "type" }> => ({
            type: "type",
            text: { loginRef, field },
            target: {
              index: elementIndex(
                observation,
                "edittext",
                field === "username" ? "Username" : field === "code" ? "Code" : "Password",
              ),
            },
            submit: false,
          });
          if (name === "revoked") authority.policy.revoked = true;
          if (name === "revision-changed") authority.policy.revisionChanged = true;
          if (name === "expired") authority.policy.expired = true;
          if (name === "old-capability-batch") {
            wire.mapPhone = (frame) => {
              const next = { ...frame };
              if (frame.type === "runner.integrations.status") delete next.loginText;
              return next;
            };
            const previous = currentConnection();
            await door.cut();
            await door.restore();
            await reconnected(previous);
            observation = await observe();
          }
          if (["malformed", "tampered", "wrong-context"].includes(name)) {
            wire.mapHost = (frame) => {
              const parsed = sealedActFrame.safeParse(frame);
              if (!parsed.success || parsed.data.operation !== "act") return frame;
              const copy = structuredClone(frame);
              const action = (
                copy.params as { actions: { text?: { sealed?: Record<string, unknown> } }[] }
              ).actions.find((a) => a.text?.sealed);
              if (!action?.text?.sealed) return frame;
              const envelope = action.text.sealed;
              if (name === "malformed") envelope.tag = "short";
              if (name === "tampered")
                envelope.tag =
                  (String(envelope.tag).startsWith("A") ? "B" : "A") +
                  String(envelope.tag).slice(1);
              if (name === "wrong-context")
                (envelope.binding as Record<string, unknown>).actId = "another-act";
              return copy;
            };
          }
          const refusal = [
            "expired",
            "revoked",
            "revision-changed",
            "old-capability-batch",
            "malformed",
            "tampered",
            "wrong-context",
            "no-totp",
            "cross-workspace",
          ].includes(name);
          if (name === "cross-workspace") {
            const foreign = await dispatchCallerRun(host, caller, {
              key: `${name}-foreign`,
              title: "Other Workspace",
            });
            runs.push(foreign);
            const foreignSignIn = await connectAgentGateway(host, {
              url: new URL(hostInternalRoutePaths.mcp, host.config.runtimeOrigin).href,
              token: foreign.agentControlToken,
            });
            gateways.push(foreignSignIn);
            const foreignReady = await foreignSignIn.call("sign_in", {
              site,
              reason: "Authorize this saved login in the other Workspace",
            });
            results.push(foreignReady);
            const foreignLogin = z
              .object({ status: z.literal("ready"), loginRef: z.string() })
              .parse(foreignReady.structuredContent);
            expect(foreign.workspaceId).not.toBe(run.workspaceId);
            // Main has the real phone grant, but cannot spend another Workspace's lease.
            const result = await act([
              {
                ...saved("password"),
                text: { loginRef: foreignLogin.loginRef, field: "password" },
              },
            ]);
            expect(result.isError).toBe(true);
            expect(resultText(result)).toMatch(/expired|denied|workspace/iu);
          } else if (name.endsWith("-delayed")) {
            wire.mapHost = (frame) => {
              if (sealedActFrame.safeParse(frame).success && frame.operation === "act") {
                held = structuredClone(frame);
                return null;
              }
              return frame;
            };
            const acting = act([saved("password")]);
            void acting.catch(() => undefined);
            await eventually(
              "sealed act held before receiver",
              async () => (held ? true : undefined),
              10_000,
            );
            if (name === "stop-delayed") {
              await stopRun(host, run, "passwords-stop-delayed");
              finishedRuns.add(run.runId);
            }
            if (name === "expiry-delayed") {
              const expiresAt = z
                .object({
                  params: z.object({
                    actions: z.array(
                      z.object({
                        text: z.object({
                          sealed: z.object({ binding: z.object({ expiresAt: z.number() }) }),
                        }),
                      }),
                    ),
                  }),
                })
                .parse(held).params.actions[0]!.text.sealed.binding.expiresAt;
              await new Promise((resolve) =>
                setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 10)),
              );
            }
            if (name === "disconnect-delayed" || name === "restart-delayed") {
              const previous = currentConnection();
              await door.cut();
              if (name === "restart-delayed") {
                // As in the update journey, Android must see the service unbind
                // before its process dies, or it refuses to bind it again.
                const before = await agentPhonePids(device);
                expect(before, "restart ends a running phone process").not.toHaveLength(0);
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
                  "the accessibility runtime to unbind",
                  async () =>
                    /Bound services:\{[^\n]*label=Opensteer Agent Phone\b/u.test(
                      await device.shell("dumpsys accessibility"),
                    )
                      ? undefined
                      : true,
                  30_000,
                );
                for (const pid of before) await device.shell(`su 0 kill -9 ${pid}`);
                await door.restore();
                await device.shell(
                  `settings put secure enabled_accessibility_services ${[...others, agentPhoneAccessibilityService].join(":")}`,
                );
                await device.shell("settings put secure accessibility_enabled 1");
                const after = await eventually(
                  "a new phone runtime process",
                  async () => {
                    const pids = await agentPhonePids(device);
                    return pids.length > 0 && pids.every((pid) => !before.includes(pid))
                      ? pids
                      : undefined;
                  },
                  30_000,
                );
                await evidence.write("runtime-restart.json", { before, after });
              } else await door.restore();
              await reconnected(previous);
            }
            delete wire.mapHost;
            const delivered = door.replayPasswordsFrame(held!);
            expect(delivered.params).toEqual(held!.params);
            expect(delivered.requestId).toEqual(held!.requestId);
            expect(delivered.sessionId).toEqual(held!.sessionId);
            await evidence.write("delayed-delivery.json", { original: held, delivered });
            await Promise.allSettled([acting]);
            if (name === "stop-delayed") {
              const observerRun = await dispatchCallerRun(host, caller, {
                key: `${name}-observer`,
                title: "Observe after Stop",
                workspaceId: run.workspaceId,
              });
              runs.push(observerRun);
              const observer = await connectAgentGateway(host, observerRun.integrationTools);
              gateways.push(observer);
              const observerRow = phoneRowOf(
                await observer.call("integration_search", {
                  query: "Android phone",
                }),
                phoneId,
              );
              const barrier = await observer.call("integration_call", {
                toolRef: observerRow.toolRefs!.observe,
              });
              results.push(barrier);
              expect(barrier.isError).not.toBe(true);
            } else await observe();
          } else if (refusal) {
            const actions: AndroidPhoneAction[] =
              name === "old-capability-batch"
                ? [
                    {
                      type: "tap",
                      count: 1,
                      target: { index: elementIndex(observation, "button", "Record login tap") },
                    },
                    saved("password"),
                  ]
                : [saved(name === "no-totp" ? "code" : "password")];
            const result = await act(actions);
            expect(result.isError, "refused saved login must not report success").toBe(true);
            expect(resultText(result)).not.toContain("Typed saved");
            if (name === "old-capability-batch")
              expect(resultText(result)).toMatch(/update|out.of.date|unsupported/iu);
          } else {
            if (name === "concurrent-fields") {
              const result = await act([saved("username"), saved("password")]);
              expect(result.isError).not.toBe(true);
            } else {
              expect((await act([saved("username")])).isError).not.toBe(true);
              const beforeReplay = wire.host.length;
              expect((await act([saved("password")])).isError).not.toBe(true);
              if (name === "replay") {
                const frame = wire.host
                  .slice(beforeReplay)
                  .find(
                    (frame) =>
                      frame.type === "host.integrations.computer-use" && frame.operation === "act",
                  );
                if (!frame) throw new Error("Missing real ciphertext dispatch");
                const before = await readReceipts(device);
                door.replayPasswordsFrame(frame);
                await observe();
                const after = await readReceipts(device);
                await evidence.write("replay-receipts.json", { before, after });
                expect(after, "replay adds no input attempt or other fixture receipt").toEqual(
                  before,
                );
              }
              if (name === "saved-fields-and-totp")
                expect((await act([saved("code")])).isError).not.toBe(true);
            }
            const receipts = await readReceipts(device);
            for (const field of [
              "Username",
              "Password",
              ...(name === "saved-fields-and-totp" ? ["Code"] : []),
            ]) {
              expect(
                receipts.filter((r) => r.kind === "login_attempt").map((r) => JSON.parse(r.detail)),
              ).toContainEqual({ field, attempts: 1 });
              expect(
                receipts
                  .filter((r) => r.kind === "login_predicate")
                  .map((r) => JSON.parse(r.detail)),
              ).toContainEqual({ field, matches: true, attempts: 1 });
            }
            if (name === "concurrent-fields")
              expect(JSON.stringify(results)).toContain(
                "Typed saved username, then typed saved password",
              );
            else {
              expect(JSON.stringify(results)).toContain("Typed saved username");
              expect(JSON.stringify(results)).toContain("Typed saved password");
            }
            if (name === "saved-fields-and-totp")
              expect(JSON.stringify(results)).toContain("Typed saved code");
          }
          if (refusal || name.endsWith("-delayed"))
            expect(
              await readReceipts(device),
              "refused or stale delivery has no fixture side effects",
            ).toEqual([]);
          expect(await host.store.listBrowserSessions(host.ownerId)).toEqual([]);
        });
      } finally {
        const restoreCapability = name === "old-capability-batch" && wire.mapPhone !== undefined;
        delete wire.mapHost;
        delete wire.mapPhone;
        const cleanupErrors: string[] = [];
        if (restoreCapability) {
          try {
            const previous = currentConnection();
            await door.cut();
            await door.restore();
            await reconnected(previous);
          } catch (error) {
            cleanupErrors.push(String(error));
          }
        }
        for (const gateway of gateways.reverse())
          try {
            await gateway.close();
          } catch (error) {
            cleanupErrors.push(String(error));
          }
        for (const run of runs.reverse())
          if (!finishedRuns.has(run.runId))
            try {
              await run.complete();
            } catch (error) {
              cleanupErrors.push(String(error));
            }
        for (const command of authority.commands.slice(authorityCommandsBefore))
          if (command.type === "login.authorize") authority.end(command.operationId);
        await evidence.write("tool-results.json", results);
        await evidence.write("fixture-auth-assertions.json", await readReceipts(device));
        await evidence.write("platform-traffic.json", wire);
        const rawLogcat = deviceLog?.linesFrom(phonePids).join("\n") ?? "";
        evidence.scan("raw-device-logcat-all-processes", deviceLog?.allLines().join("\n") ?? "");
        evidence.scan("raw-logcat-before-redaction", rawLogcat);
        await evidence.write("logcat.txt", redaction.apply(rawLogcat));
        await evidence.write("teardown.json", cleanupErrors);
        suiteEvidence.cases.set(name, evidence.cases.get(name)!);
        await evidence.finish();
        expect(cleanupErrors, "every gateway and Run stopped").toEqual([]);
      }
    });
  },
);

const sealedActFrame = z.object({
  type: z.literal("host.integrations.computer-use"),
  operation: z.literal("act"),
  params: z.object({
    actions: z.array(
      z.object({
        text: z
          .union([z.string(), z.object({ sealed: z.record(z.string(), z.unknown()) })])
          .optional(),
      }),
    ),
  }),
});

/** Nonsecret fence from the Host's successful primary authentication response. */
const phoneConnection = z.object({
  type: z.literal("host.welcome"),
  runnerId: z.string(),
  connectionId: z.string(),
  connectionGeneration: z.number().int().positive(),
});
