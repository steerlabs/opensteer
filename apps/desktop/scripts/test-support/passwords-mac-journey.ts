import assert from "node:assert/strict";
import {
  runPasswordsGrantPolicyJourney,
  stopPasswordsPolicyBroker,
} from "./passwords-grant-policy-journey.js";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createId } from "@opensteer/core";
import {
  ComputerUseSessionIdSchema,
  ComputerUseBindResultSchema,
  ComputerUseObservationResultSchema,
  ComputerUseActResultSchema,
  ComputerUseResolveAppResultSchema,
  LoginReceiverKeySchema,
  PasswordSignInAuthorityResultSchema,
  type LoginField,
  type PasswordSignInAuthorityCommand,
  type PasswordSignInAuthorityEvent,
  ComputerUseDispatchActionsSchema,
} from "@opensteer/protocol";
import { z } from "zod";
import {
  ComputerUseBridgeServer,
  ComputerUseSessionOwnership,
} from "../../src/computer-use/computer-use-bridge-server.js";
import { ComputerUseService } from "../../src/computer-use/computer-use-service.js";
import {
  ComputerUseBridgeClient,
  ComputerUseBridgeError,
} from "../../../runner/src/computer-apps/computer-use-bridge-client.js";
import { PasswordsLoginAuthority } from "../../src/passwords/login-authority.js";
import { PasswordsSignInOperations } from "../../src/passwords/sign-in-operations.js";
import type { PasswordsBrokerSession } from "../../src/passwords/broker-session.js";
import { PasswordsJourneyEvidence } from "../../../host/src/browser/passwords-evidence.test-support.js";

const run = promisify(execFile);
const canary = "pw-canary-mac-a7d08941-3957-4420-8ee9-78dfb8dfab55";
const unicode = "\uFEFFhéllo 😀 e\u0301 مرحبا";
const fields = {
  username: "synthetic.person@passwords-fixture.test",
  password: canary,
  code: "028491",
};
const cases = [
  "workspace-consent-before-helper",
  "v4-reapproval-one-time-v5",
  "username-password-code",
  "concurrent-fields",
  "no-totp",
  "replay",
  "expiry",
  "stopped-session",
  "unicode",
  "empty",
  "cr",
  "lf",
  "tab",
  "secure-observation",
  "old-helper-preflight",
  "unsupported-batch-before-click",
  "disconnect-delayed",
  "receiver-restart",
];
const command = "pnpm test:vm -- pnpm test:electron-computer-use";
const State = z.object({
  usernameMatches: z.boolean(),
  passwordMatches: z.boolean(),
  codeMatches: z.boolean(),
  passwordEmpty: z.boolean(),
  authenticated: z.boolean(),
  submitAttempts: z.number(),
  changeEvents: z.number(),
  returnKeys: z.number(),
  tabKeys: z.number(),
  active: z.boolean(),
  pid: z.number(),
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** VM-only: real signed helper, real AppKit fields, actual background input. */
export async function runPasswordsMacJourney(): Promise<void> {
  const evidence = new PasswordsJourneyEvidence(
    "mac",
    command,
    cases,
    [canary, unicode],
    process.env.OPENSTEER_PERSONAL_E2E_ARTIFACT_DIR,
  );
  // The service starts the helper through LaunchServices, including after receiver-restart.
  await run("bash", ["scripts/test-support/grant-vm-helper-permissions.sh"]);
  const scratch = await mkdtemp(path.join(tmpdir(), "passwords-native-fixture-"));
  // The real resolver admits installed apps, including the user's Applications.
  const bundle = path.join(
    process.env.OPENSTEER_JOURNEY_APPS ?? path.join(homedir(), "Applications"),
    `Opensteer Passwords Receiver ${randomUUID()}.app`,
  );
  const nativeOutput = path.join(scratch, "predicates");
  await mkdir(nativeOutput);
  const helperBefore = await helperPids();
  nativeHelperBefore = helperBefore;
  let fixture: ChildProcess | undefined;
  let service: ComputerUseService | undefined;
  let client: ComputerUseBridgeClient | undefined;
  const events: PasswordSignInAuthorityEvent[] = [];
  const traffic: unknown[] = [];
  const brokerCalls: unknown[] = [];
  const lifetime = new AbortController();
  const cards = new PasswordsSignInOperations();
  const login = {
    id: randomUUID(),
    revision: 1,
    hasTOTP: true,
    account: "s•••@passwords-fixture.test",
  };
  const policy = { hasTOTP: true, approvalCount: 0 };
  const broker: PasswordsBrokerSession = {
    protocolVersion: 5,
    probe: async () => ({ passwords: "has-login" }),
    request: async (params) => {
      brokerCalls.push({ method: "request", params });
      return {
        decision: {
          decision: "approve",
          accounts: [
            {
              id: login.id,
              revision: login.revision,
              username: fields.username,
              host: "passwords-fixture.test",
              onPage: true,
              updatedAt: new Date().toISOString(),
              label: null,
            },
          ],
        },
        lifetime: lifetime.signal,
      };
    },
    approve: async (params) => {
      policy.approvalCount++;
      brokerCalls.push({ method: "approve", params });
      return { decision: "authorized", login };
    },
    release: async (params) => {
      brokerCalls.push({ method: "release", params });
      return params.field === "totp" && !policy.hasTOTP
        ? { released: false, reason: "no-totp" }
        : { released: true, value: params.field === "totp" ? fields.code : fields[params.field] };
    },
    cancel: async (transactionId) => {
      brokerCalls.push({ method: "cancel", transactionId });
    },
  };
  const authority = new PasswordsLoginAuthority({
    broker,
    operations: cards,
    ownOrigins: () => [],
  });
  const detachCards = cards.subscribe(({ operationId, state }) => {
    if (state.stage === "approval") {
      assert.equal(state.permissionVersion, 5);
      void cards
        .approve({ operationId, loginId: login.id, revision: login.revision, remember: false })
        .catch((error: unknown) => traffic.push({ approvalError: String(error) }));
    }
  });
  const operationId = randomUUID();
  const loginRef = `lgn_${randomUUID().replaceAll("-", "")}`;
  const runId = createId("run");
  let sessionId = ComputerUseSessionIdSchema.parse(`cus_${randomUUID()}`);
  const state = async () =>
    State.parse(JSON.parse(await readFile(path.join(nativeOutput, "fixture-state.json"), "utf8")));
  try {
    service = new ComputerUseService({
      appBundleId: "com.opensteer.passwords-acceptance",
      appVersion: "1",
      bundledHelperPath: () => path.resolve("native/computer-use/dist/Opensteer Computer Use.app"),
      teamId: null,
      log: (event, fields) => traffic.push({ event, fields }),
    });
    const deploymentId = createId("deployment");
    let bridge = await service.startForSlot(deploymentId, authority);
    assert(bridge);
    client = new ComputerUseBridgeClient({
      ...bridge,
      onEvent: (event) => {
        traffic.push(event);
        if (event.event === "passwords.event") events.push(event.params);
      },
    });
    const request = async (
      method: Parameters<ComputerUseBridgeClient["request"]>[0],
      params: unknown,
    ) => {
      traffic.push({ direction: "request", method, params });
      const result = await client!.request(method, params, { deadline: Date.now() + 30_000 });
      traffic.push({ direction: "result", method, result });
      evidence.scan(`raw:${method}`, JSON.stringify(result));
      return result;
    };
    const control = async (params: PasswordSignInAuthorityCommand) =>
      PasswordSignInAuthorityResultSchema.parse(await request("passwords.control", params));
    const authorize = async () => {
      const result = await control({
        type: "login.authorize",
        operationId,
        loginRef,
        site: "https://passwords-fixture.test",
        workspaceId: createId("workspace"),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        requester: {
          deploymentId: "personal",
          deploymentName: "Acceptance",
          workspaceName: "Synthetic workspace",
          threadTitle: "Sign in",
          reason: "Sign in to the fixture app",
        },
      });
      assert.equal(result.type, "login.authorize.started");
      await until(async () =>
        events.some(
          (e) =>
            e.type === "login.result" &&
            e.operationId === operationId &&
            e.outcome.kind === "authorized",
        ),
      );
    };
    await evidence.run("workspace-consent-before-helper", async () => {
      const capabilities = z
        .object({ authority: z.literal(1), receiver: z.null() })
        .parse(await request("passwords.capabilities", {}));
      assert.equal(capabilities.receiver, null);
      await authorize();
      assert.deepEqual(await helperPids(), helperBefore, "sign-in starts no native helper");
    });
    await evidence.run("v4-reapproval-one-time-v5", async () => {
      await runPasswordsGrantPolicyJourney(evidence, fields);
    });
    const executable = path.join(bundle, "Contents/MacOS/Receiver");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(
      path.join(bundle, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.opensteer.passwords-receiver</string><key>CFBundleExecutable</key><string>Receiver</string><key>CFBundleName</key><string>Passwords Receiver</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    await run("swiftc", [
      "scripts/test-support/passwords-receiver.swift",
      "-o",
      executable,
      "-framework",
      "AppKit",
      "-framework",
      "CryptoKit",
    ]);
    await run("codesign", ["--force", "--sign", "-", bundle]);
    fixture = spawn(
      executable,
      [nativeOutput, digest(fields.username), digest(fields.password), digest(fields.code)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    nativeFixturePid = fixture.pid;
    fixture.stdout?.on("data", (bytes: Buffer) => {
      evidence.scan("fixture-stdout", bytes);
      traffic.push({ fixtureStdout: bytes.toString() });
    });
    fixture.stderr?.on("data", (bytes: Buffer) => {
      evidence.scan("fixture-stderr", bytes);
      traffic.push({ fixtureStderr: bytes.toString() });
    });
    await until(async () =>
      state().then(
        () => true,
        () => false,
      ),
    );
    assert.equal((await state()).active, false, "fixture starts in the background");
    const resolved = ComputerUseResolveAppResultSchema.parse(
      await request("app.resolve", { app: bundle }),
    );
    assert.equal(resolved.app.allowed, true);
    const app = { access: "read-write", identity: resolved.app.identity };
    await request("session.open", { sessionId, runId, threadTitle: "Passwords acceptance" });
    // A window ref belongs to the session that bound it: a new session binds
    // again, and an ended session's ref answers "That window is closed."
    const bind = async () =>
      ComputerUseBindResultSchema.parse(
        await request("session.bind", { sessionId, app, window: null }),
      ).window;
    let window = await bind();
    const observe = async () =>
      ComputerUseObservationResultSchema.parse(
        await request("session.observe", {
          sessionId,
          app,
          window: window.ref,
          includeScreenshot: false,
        }),
      ).observation;
    let observation = await observe();
    const index = (label: RegExp) => {
      const line = observation.tree.split("\n").find((line) => label.test(line));
      const match = line && /\[(\d+)\]/u.exec(line);
      assert(match, `Missing native field ${label}`);
      return Number(match[1]);
    };
    // By role, as is Username, the fixture's one plain text field: a field
    // with a value shows the value, not its label, so "Username" is gone once
    // the username is typed.
    const usernameIndex = () => index(/^\s*\[\d+\] textfield\b/u);
    // By role: the window's title and the typed username both contain
    // "passwords", and matching those sent the saved password at the window.
    const secureIndex = (ordinal: number) => {
      const lines = observation.tree
        .split("\n")
        .filter((line) => /^\s*\[\d+\] securetextfield\b/u.test(line));
      const match = lines[ordinal] && /\[(\d+)\]/u.exec(lines[ordinal]!);
      assert(match, `Missing secure field ${ordinal}`);
      return Number(match[1]);
    };
    const seal = async (
      field: LoginField,
      actId: string,
      actionIndex: number,
      expiresAt = Date.now() + 20_000,
    ) => {
      const capabilities = z
        .object({ receiver: LoginReceiverKeySchema })
        .parse(await request("passwords.capabilities", {}));
      const receiver = capabilities.receiver;
      const result = await control({
        type: "login.seal",
        operationId,
        receiver,
        binding: {
          version: 1,
          connectionId: receiver.connectionId,
          connectionGeneration: receiver.connectionGeneration,
          runId,
          sessionId,
          actId,
          actionIndex,
          field,
          expiresAt,
        },
      });
      return result;
    };
    const act = async (
      actions: z.infer<typeof ComputerUseDispatchActionsSchema>,
      actId: string,
    ) => {
      const params = {
        sessionId,
        app,
        window: window.ref,
        snapshot: observation.snapshot,
        loginContext: { runId, actId },
        actions,
      };
      const result = ComputerUseActResultSchema.parse(await request("session.act", params));
      observation = await observe();
      return { result, params };
    };
    const refused = async (params: unknown, allowed: readonly string[]) => {
      try {
        const result = ComputerUseActResultSchema.parse(await request("session.act", params));
        assert(result.error);
        assert(allowed.includes(result.error.code));
        assert.deepEqual(result.performed, []);
        return result.error;
      } catch (error) {
        assert(error instanceof ComputerUseBridgeError, String(error));
        assert(allowed.includes(error.code), error.message);
        return { code: error.code, message: error.message };
      }
    };
    const typed = async (
      field: LoginField,
      target: number,
      actId = randomUUID(),
      expiresAt?: number,
    ) => {
      const sealed = await seal(field, actId, 0, expiresAt);
      assert(sealed.type === "login.seal.result" && sealed.status === "sealed");
      return act(
        [{ type: "type", target: { index: target }, text: { sealed: sealed.envelope } }],
        actId,
      );
    };
    let replay: Awaited<ReturnType<typeof typed>>;
    await evidence.run("username-password-code", async () => {
      assert.deepEqual((await typed("username", usernameIndex())).result.performed, [
        "Typed saved username",
      ]);
      replay = await typed("password", secureIndex(0));
      assert.deepEqual(replay.result.performed, ["Typed saved password"]);
      assert.deepEqual((await typed("code", secureIndex(1))).result.performed, [
        "Typed saved code",
      ]);
      await until(async () => {
        const s = await state();
        return s.usernameMatches && s.passwordMatches && s.codeMatches;
      });
      const clicked = await act(
        [{ type: "click", target: { index: index(/Sign in/u) }, button: "left", count: 1 }],
        randomUUID(),
      );
      assert.equal(clicked.result.error, null);
      await until(async () => (await state()).authenticated);
      assert.equal(
        (await state()).active,
        false,
        "background saved input must not activate the app",
      );
    });
    await evidence.run("concurrent-fields", async () => {
      const actId = randomUUID();
      const [first, second] = await Promise.all([
        seal("username", actId, 0),
        seal("password", actId, 1),
      ]);
      assert(first.type === "login.seal.result" && first.status === "sealed");
      assert(second.type === "login.seal.result" && second.status === "sealed");
      const result = await act(
        [
          { type: "type", target: { index: usernameIndex() }, text: { sealed: first.envelope } },
          { type: "type", target: { index: secureIndex(0) }, text: { sealed: second.envelope } },
        ],
        actId,
      );
      assert.deepEqual(result.result.performed, ["Typed saved username", "Typed saved password"]);
    });
    await evidence.run("no-totp", async () => {
      policy.hasTOTP = false;
      const result = await seal("code", randomUUID(), 0);
      assert(result.type === "login.seal.result" && result.status === "unavailable");
      policy.hasTOTP = true;
    });
    await evidence.run("replay", async () => {
      await refused({ ...replay!.params, window: window.ref, snapshot: observation.snapshot }, [
        "unsupported",
      ]);
    });
    await evidence.run("secure-observation", async () => {
      observation = await observe();
      assert.equal(observation.tree.includes(canary), false);
    });
    await evidence.run("old-helper-preflight", async () => {
      let calls = 0;
      const old = new ComputerUseBridgeServer({
        helper: {
          onDisconnect: () => () => undefined,
          onEvent: () => () => undefined,
          readinessPermissions: async () => ({
            accessibility: "granted",
            screenRecording: "granted",
          }),
          readinessDataGrants: async () => {
            throw new Error("No data request expected");
          },
          request: async () => {
            calls++;
            throw new Error("An unsupported batch must not reach the helper");
          },
        },
        ownership: new ComputerUseSessionOwnership(),
        approvals: {
          disconnected() {},
          list() {},
          outcome() {},
          proveKeyChallenge: async () => {
            throw new Error("No approval expected");
          },
        },
      });
      await old.start();
      const oldClient = new ComputerUseBridgeClient({ token: old.token, url: old.url });
      try {
        const actId = randomUUID();
        const sealed = await seal("password", actId, 1);
        assert(sealed.type === "login.seal.result" && sealed.status === "sealed");
        await assert.rejects(
          oldClient.request(
            "session.act",
            {
              ...replay!.params,
              window: window.ref,
              snapshot: observation.snapshot,
              loginContext: { runId, actId },
              actions: [
                { type: "click", target: { index: index(/Sign in/u) }, button: "left", count: 1 },
                {
                  type: "type",
                  target: { index: secureIndex(0) },
                  text: { sealed: sealed.envelope },
                },
              ],
            },
            { deadline: Date.now() + 10_000 },
          ),
          (error: unknown) =>
            error instanceof ComputerUseBridgeError &&
            error.code === "unsupported" &&
            /Update Opensteer/u.test(error.message),
        );
        assert.equal(calls, 0);
      } finally {
        oldClient.close();
        await old.close();
      }
    });
    for (const [name, value] of [
      ["unicode", unicode],
      ["empty", ""],
      ["cr", "a\rb"],
      ["lf", "a\nb"],
      ["tab", "a\tb"],
    ] as const) {
      await evidence.run(name, async () => {
        fields.password = value;
        await writeFile(path.join(nativeOutput, "expected-password.sha256"), digest(value));
        const target = secureIndex(0);
        await act([{ type: "setValue", index: target, value: "" }], randomUUID());
        const before = await state();
        if (["cr", "lf", "tab"].includes(name)) {
          // Refused before anything is typed: the receiver rejects the whole
          // request (`ComputerUseBridgeError`), or the act reports the error.
          await typed("password", secureIndex(0)).then(
            (result) => {
              assert(result.result.error);
              assert.deepEqual(result.result.performed, []);
            },
            (error: unknown) => {
              assert(error instanceof ComputerUseBridgeError, String(error));
              assert.equal(error.code, "unsupported", error.message);
            },
          );
          assert.equal((await state()).passwordEmpty, true);
        } else {
          const result = await typed("password", secureIndex(0));
          assert.equal(result.result.error, null);
          await until(async () => (await state()).passwordMatches);
        }
        const after = await state();
        assert.equal(after.returnKeys, before.returnKeys);
        assert.equal(after.tabKeys, before.tabKeys);
      });
    }
    await evidence.run("unsupported-batch-before-click", async () => {
      fields.password = "a\rb";
      const actId = randomUUID();
      const sealed = await seal("password", actId, 1);
      assert(sealed.type === "login.seal.result" && sealed.status === "sealed");
      const before = await state();
      await refused(
        {
          ...replay!.params,
          window: window.ref,
          snapshot: observation.snapshot,
          loginContext: { runId, actId },
          actions: [
            { type: "click", target: { index: index(/Sign in/u) }, button: "left", count: 1 },
            { type: "type", target: { index: secureIndex(0) }, text: { sealed: sealed.envelope } },
          ],
        },
        ["unsupported"],
      );
      const after = await state();
      assert.equal(after.submitAttempts, before.submitAttempts);
      assert.equal(after.returnKeys, before.returnKeys);
      assert.equal(after.tabKeys, before.tabKeys);
    });
    fields.password = canary;
    await evidence.run("expiry", async () => {
      const actId = randomUUID();
      const deadline = Date.now() + 200;
      const result = await seal("password", actId, 0, deadline);
      assert(result.type === "login.seal.result" && result.status === "sealed");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 1)));
      // Refused before the helper: the desktop service rejects an expired
      // envelope for the whole request (`ComputerUseBridgeError`).
      await act(
        [{ type: "type", target: { index: secureIndex(0) }, text: { sealed: result.envelope } }],
        actId,
      ).then(
        (expired) => {
          assert(expired.result.error);
          assert.deepEqual(expired.result.performed, []);
        },
        (error: unknown) => {
          assert(error instanceof ComputerUseBridgeError, String(error));
          assert.equal(error.code, "unsupported", error.message);
        },
      );
    });
    await evidence.run("stopped-session", async () => {
      await request("session.close", { sessionId });
      await refused({ ...replay!.params, window: window.ref, snapshot: observation.snapshot }, [
        "no-session",
      ]);
    });
    let delayed: typeof replay.params;
    await evidence.run("disconnect-delayed", async () => {
      sessionId = ComputerUseSessionIdSchema.parse(`cus_${randomUUID()}`);
      await request("session.open", { sessionId, runId, threadTitle: "Delayed input" });
      window = await bind();
      observation = await observe();
      const actId = randomUUID();
      const sealed = await seal("password", actId, 0);
      assert(sealed.type === "login.seal.result" && sealed.status === "sealed");
      delayed = {
        ...replay!.params,
        sessionId,
        window: window.ref,
        snapshot: observation.snapshot,
        loginContext: { runId, actId },
        actions: [
          { type: "type", target: { index: secureIndex(0) }, text: { sealed: sealed.envelope } },
        ],
      };
      client!.close();
      await service!.stopForSlot(deploymentId);
      bridge = await service!.startForSlot(deploymentId, authority);
      assert(bridge);
      client = new ComputerUseBridgeClient(bridge);
      await refused(delayed, ["no-session"]);
    });
    await evidence.run("receiver-restart", async () => {
      client!.close();
      await service!.stop();
      for (const pid of (await helperPids()).filter((pid) => !helperBefore.includes(pid)))
        process.kill(pid, "SIGTERM");
      await until(async () => (await helperPids()).every((pid) => helperBefore.includes(pid)));
      service = new ComputerUseService({
        appBundleId: "com.opensteer.passwords-acceptance",
        appVersion: "1",
        bundledHelperPath: () =>
          path.resolve("native/computer-use/dist/Opensteer Computer Use.app"),
        teamId: null,
        log: (event, fields) => traffic.push({ event, fields }),
      });
      bridge = await service.startForSlot(deploymentId, authority);
      assert(bridge);
      client = new ComputerUseBridgeClient(bridge);
      await request("session.open", { sessionId, runId, threadTitle: "Restarted receiver" });
      window = await bind();
      observation = await observe();
      const before = await state();
      const error = await refused(
        { ...delayed!, window: window.ref, snapshot: observation.snapshot },
        ["failed"],
      );
      assert.equal(
        error.message,
        "The saved login was sealed for an earlier connection, so nothing was typed. Act again.",
      );
      assert.deepEqual(
        await state(),
        before,
        "an earlier receiver's envelope changes no fixture state",
      );
    });
    await evidence.write("fixture-auth-assertions.json", await state());
  } finally {
    detachCards();
    client?.close();
    const cleanupErrors: string[] = [];
    for (const close of [
      async () => service?.stop(),
      async () => authority.close(),
      async () => {
        if (fixture && fixture.exitCode === null) {
          const exited = once(fixture, "exit");
          fixture.kill("SIGTERM");
          await exited;
        }
      },
      async () => {
        for (const pid of (await helperPids()).filter((pid) => !helperBefore.includes(pid))) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* Already stopped. */
          }
        }
        await until(async () => (await helperPids()).every((pid) => helperBefore.includes(pid)));
      },
      async () => rm(bundle, { recursive: true, force: true }),
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    if (cleanupErrors.length) stopPasswordsMacProcesses();
    await evidence.write("teardown.json", cleanupErrors);
    await evidence.write("platform-traffic.json", traffic);
    await evidence.write("broker-metadata.json", brokerCalls);
    await evidence.finish();
    await rm(scratch, { recursive: true, force: true });
    nativeFixturePid = undefined;
    assert.deepEqual(cleanupErrors, [], "all native journey resources stop");
  }
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for the native Passwords fixture");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function helperPids(): Promise<number[]> {
  const result = await run("pgrep", [
    "-f",
    "Opensteer Computer Use.app/Contents/MacOS/Opensteer Computer Use",
  ]).catch(() => ({ stdout: "" }));
  return result.stdout
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}

let nativeHelperBefore: number[] | undefined;
let nativeFixturePid: number | undefined;
/** Synchronous last resort for the smoke watchdog, which exits Electron immediately. */
export function stopPasswordsMacProcesses(): void {
  stopPasswordsPolicyBroker();
  const owned = new Set<number>();
  if (nativeFixturePid) owned.add(nativeFixturePid);
  if (nativeHelperBefore) {
    let stdout = "";
    try {
      stdout = execFileSync(
        "pgrep",
        ["-f", "Opensteer Computer Use.app/Contents/MacOS/Opensteer Computer Use"],
        { encoding: "utf8" },
      );
    } catch {
      /* No helper remains. */
    }
    for (const value of stdout.trim().split(/\s+/u).filter(Boolean).map(Number))
      if (!nativeHelperBefore.includes(value)) owned.add(value);
  }
  for (const pid of owned)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already stopped. */
    }
  nativeFixturePid = undefined;
}
