import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
/**
 * Acceptance journeys for agent-driven password fill. VM ONLY:
 * pnpm test:vm -- bash -c 'OPENSTEER_PASSWORDS_E2E_ARTIFACT_DIR="$HOME/opensteer-job/artifacts/passwords" pnpm test:electron-passwords'
 * Uses production Electron launch, router, controller, authority, service and
 * broker client. The fake broker and HTTPS websites contain synthetic data.
 */
import { SessionCdpRouter, type CdpParameters } from "@opensteer/browser-core";
import {
  BrowserController,
  HostSignIns,
  SessionFiles,
  SurfaceLedger,
  type LaunchedBrowser,
} from "@opensteer/browser-runtime-core";
import { WorkspaceIdSchema } from "@opensteer/core";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserClientMessageSchema,
  createBrowserSessionId,
  LoginEnvelopeBindingSchema,
  LoginFillStatusSchema,
  LoginReceiverKeySchema,
  LoginRefSchema,
  passwordLoginLifetimeMs,
  PasswordSignInAuthorityResultSchema,
  type BrowserServerMessage,
  type LoginField,
  type PasswordSignInAuthorityCommand,
  type PasswordSignInAuthorityEvent,
} from "@opensteer/protocol";
import { app, BrowserWindow, session as electronSession, webContents } from "electron";
import { execFileSync } from "node:child_process";
import { createECDH, createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ComputerUseBridgeClient } from "../../runner/src/computer-apps/computer-use-bridge-client.js";
import {
  ElectronBrowserLauncher,
  electronBrowserPartition,
} from "../src/browser/electron-browser-launcher.js";
import {
  ComputerUseBridgeServer,
  ComputerUseSessionOwnership,
} from "../src/computer-use/computer-use-bridge-server.js";
import { PasswordsLoginAuthority } from "../src/passwords/login-authority.js";
import { openLoginEnvelope } from "../src/passwords/login-envelope.js";
import { PasswordsService } from "../src/passwords/passwords-service.js";
import { passwordsBrokerSocketPath } from "../src/passwords/paths.js";
import { PasswordsSignInOperations } from "../src/passwords/sign-in-operations.js";
import {
  FakePasswordsBroker,
  verifySameUserPeer,
} from "../src/passwords/test-support/fake-broker-server.js";
import { PasswordLoginFixture } from "./electron-passwords-fixture.js";

const smokeDownloads = smokeDesktopDownloads();

const work = mkdtempSync(path.join(tmpdir(), "pw-"));
const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const artifactDirectory =
  process.env.OPENSTEER_PASSWORDS_E2E_ARTIFACT_DIR ??
  path.join(homedir(), ".local/state/opensteer/agent-password-fill/artifacts", runId);
const replay = `pnpm test:vm -- bash -c 'OPENSTEER_PASSWORDS_E2E_ARTIFACT_DIR="$HOME/opensteer-job/artifacts/passwords" pnpm test:electron-passwords'`;
app.setPath("userData", path.join(work, "user-data"));
app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch("site-per-process");
app.commandLine.appendSwitch("disable-features", "MacWebContentsOcclusion");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP bank.test 127.0.0.1, MAP other.test 127.0.0.1",
);
const fixture = new PasswordLoginFixture();
const traffic: string[] = [];
const output: string[] = [];
const chronology: { at: string; caseId: string; event: string; detail?: unknown }[] = [];
const cleanups = new Set<() => Promise<void>>();
let currentCase = "setup";
let finished = false;
const liveness = setInterval(() => undefined, 1_000);
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});

// Observe original bytes before redaction. A leak still fails the run, without
// copying the leaked credential into the user-visible log or evidence bundle.
for (const stream of [process.stdout, process.stderr]) {
  stream.write = new Proxy(stream.write, {
    apply(target, receiver, args: unknown[]) {
      const chunk = args[0];
      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        output.push(text);
        args[0] = scrub(text);
      }
      return Reflect.apply(target, receiver, args);
    },
  });
}
function scrub(value: string): string {
  for (const secret of secrets()) value = value.replaceAll(secret, "<synthetic-secret>");
  return value;
}
function secrets(): string[] {
  return [
    fixture.password,
    fixture.totpSeed.toString("hex"),
    fixture.totpSeed.toString("base64"),
    ...fixture.codes,
  ];
}
function record(event: string, detail?: unknown): void {
  chronology.push({
    at: new Date().toISOString(),
    caseId: currentCase,
    event,
    ...(detail === undefined ? {} : { detail }),
  });
}
interface Assertion {
  name: string;
  passed: boolean;
  detail?: unknown;
}
interface Journey {
  id: string;
  title: string;
  status: "pending" | "passed" | "failed" | "blocked";
  assertions: Assertion[];
  error?: string;
}
const journeys: Journey[] = [
  ["0", "Workspace authorization before any browser; phone, Mac and browser reuse"],
  ["1", "SPA bank and server-verified identity"],
  ["2", "Identifier first"],
  ["3", "Wrong site"],
  ["4", "Cross-site OOPIF"],
  ["5", "No field and page-bound admission"],
  ["6", "Lease checks"],
  ["7", "Platform leak scan"],
  ["8", "Profile reopen"],
  ["9-oopif", "Focus leaves OOPIF"],
  ["9-navigation", "Navigation during release"],
  ["9-cancel", "Cancel during release"],
  ["9-revoke", "Revoke during release"],
  ["9a-reload", "Same-origin reload"],
  ["9b-focus", "Same-document input swap"],
  ["9c-hooks", "Accessor and stack capture"],
  ["9d-background", "Background page"],
].map(([id, title]) => ({ id: id!, title: title!, status: "pending", assertions: [] }));
let setupHealthy = false;
let active: Journey;
function check(name: string, passed: boolean, detail?: unknown): void {
  active.assertions.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  record("assertion", { name, passed, ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new Error(`Acceptance assertion failed: ${name}`);
}
async function journey(id: string, title: string, run: () => Promise<void>): Promise<void> {
  currentCase = id;
  active = journeys.find((entry) => entry.id === id)!;
  active.title = title;
  setupHealthy = true;
  record("start");
  // A stuck CDP predicate cannot check waitFor's deadline. Preserve the last
  // fixture milestones and fail instead of holding the entire VM journey.
  const watchdog = setTimeout(() => {
    writeFileSync(
      path.join(artifactDirectory, "stalled.json"),
      scrub(JSON.stringify({ caseId: id, chronology, journeys }, null, 2)),
    );
    process.stderr.write(`Passwords journey ${id} exceeded 30 seconds; see stalled.json\n`);
    app.exit(1);
  }, 30_000);
  try {
    await run();
    active.status = "passed";
  } catch (error) {
    active.status = "failed";
    active.error = scrub(error instanceof Error ? error.message : "Unknown journey failure");
  } finally {
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup();
      } catch {
        active.status = "failed";
        active.error = "Journey cleanup failed.";
      }
      cleanups.delete(cleanup);
    }
    clearTimeout(watchdog);
    record("finish", { status: active.status });
    process.stdout.write(
      `${JSON.stringify({ caseId: id, status: active.status, error: active.error })}\n`,
    );
  }
  if (active.status === "failed" && !setupHealthy)
    throw new Error("Shared Electron/broker setup failed; remaining journeys were not run.");
}
async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeout = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      /* A navigation can destroy the observed context. */
    }
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}
const object = z.record(z.string(), z.unknown());
const coordinate = z.object({ x: z.number(), y: z.number() });
const leaseSchema = z.object({
  kind: z.literal("authorized"),
  loginRef: LoginRefSchema,
  account: z.string(),
});

interface Lease {
  operationId: string;
  loginRef: string;
}
async function harness(options: { profile?: string; workspaceLease?: boolean } = {}) {
  setupHealthy = false;
  // Leave room for the production broker path in macOS's 104-byte sun_path.
  const home = mkdtempSync(`${tmpdir()}/`);
  const bundle = path.join(home, "bundled/Opensteer Passwords.app");
  await mkdir(path.join(bundle, "Contents"), { recursive: true });
  await writeFile(
    path.join(bundle, "Contents/Info.plist"),
    JSON.stringify({ CFBundleVersion: "1" }),
  );
  const socketPath = passwordsBrokerSocketPath(true, home);
  await mkdir(path.dirname(socketPath), { recursive: true });
  const broker = new FakePasswordsBroker({ development: true, socketPath });
  let browser: LaunchedBrowser | undefined;
  let controller: BrowserController | undefined;
  let signIns: HostSignIns | undefined;
  let service: PasswordsService | undefined;
  let launcher: ElectronBrowserLauncher | undefined;
  let router: SessionCdpRouter | undefined;
  let ledger: SurfaceLedger | undefined;
  let files: SessionFiles | undefined;
  let authority: PasswordsLoginAuthority | undefined;
  let controlServer: ComputerUseBridgeServer | undefined;
  let controlClient: ComputerUseBridgeClient | undefined;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    signIns?.close();
    const failures: unknown[] = [];
    for (const release of [
      () => controller?.close(),
      () => router?.close(),
      () => files?.dispose(),
      () => ledger?.close(),
      () => browser?.close(),
      () => launcher?.close(),
      () => controlClient?.close(),
      () => controlServer?.close(),
      () => authority?.close(),
      () => service?.stop(),
      () => broker.close(),
    ]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
    rmSync(home, { force: true, recursive: true });
    cleanups.delete(cleanup);
    if (failures.length) throw new Error("Resource cleanup failed.");
  };
  cleanups.add(cleanup);
  await broker.listen();
  const login = { id: randomUUID(), revision: 1, account: "s•••@bank.test", hasTOTP: true };
  const policy = { hasTOTP: true, revoked: false, holdRelease: false };
  const updateLogin = () =>
    broker.setLogin({
      id: login.id,
      revision: login.revision,
      account: login.account,
      origins: [fixture.origin(), fixture.origin("other.test")],
      username: fixture.username,
      password: fixture.password,
      totp: policy.hasTOTP ? fixture.code() : null,
    });
  updateLogin();
  service = new PasswordsService({
    appVersion: "1.0.0",
    bundledBrokerPath: () => bundle,
    development: true,
    homeDirectory: home,
    log: (event, fields) => {
      const line = JSON.stringify({ event, fields });
      output.push(line);
      record(event, fields);
    },
    client: {
      verifyPeer: async (_file, socket) => verifySameUserPeer(socket),
      requestTimeoutMs: 10_000,
    },
    run: async (file, args) => {
      if (file === "/usr/bin/plutil") return readFile(args.at(-1) ?? "", "utf8");
      if (file === "/usr/bin/ditto") {
        await cp(args[1]!, args[2]!, { recursive: true });
        return "";
      }
      if (file === "/usr/bin/codesign")
        return "Identifier=com.opensteer.passwords.dev\nSignature=adhoc\nCDHash=synthetic\n";
      if (file === "/usr/bin/open") return "";
      if (args[0] === "--prepare-replacement") return "";
      throw new Error("Unexpected helper command.");
    },
  });
  const cards = new PasswordsSignInOperations();
  authority = new PasswordsLoginAuthority({
    broker: service.broker(5),
    legacyBroker: service.broker(4),
    operations: cards,
    ownOrigins: () => ["https://opensteer.test"],
  });
  const controlEvents: PasswordSignInAuthorityEvent[] = [];
  let helperCalls = 0;
  controlServer = new ComputerUseBridgeServer({
    passwords: authority,
    helper: {
      onDisconnect: () => () => undefined,
      onEvent: () => () => undefined,
      readinessPermissions: async () => {
        helperCalls++;
        throw new Error("Workspace authorization must not start a helper");
      },
      readinessDataGrants: async () => {
        helperCalls++;
        throw new Error("Workspace authorization must not start a helper");
      },
      request: async () => {
        helperCalls++;
        throw new Error("Workspace authorization must not start a helper");
      },
    },
    ownership: new ComputerUseSessionOwnership(),
    approvals: {
      disconnected() {},
      list() {},
      outcome() {},
      proveKeyChallenge: async () => {
        throw new Error("No app approval in this journey");
      },
    },
  });
  await controlServer.start();
  controlClient = new ComputerUseBridgeClient({
    token: controlServer.token,
    url: controlServer.url,
    onEvent: (event) => {
      if (event.event === "passwords.event") {
        controlEvents.push(event.params);
        traffic.push(JSON.stringify({ direction: "personal-bridge-event", event }));
      }
    },
  });
  const control = async (command: PasswordSignInAuthorityCommand) => {
    traffic.push(JSON.stringify({ direction: "personal-bridge-command", command }));
    const result = PasswordSignInAuthorityResultSchema.parse(
      await controlClient!.request("passwords.control", command, { deadline: Date.now() + 10_000 }),
    );
    traffic.push(JSON.stringify({ direction: "personal-bridge-result", result }));
    return result;
  };
  const authorizeWorkspace = async (): Promise<Lease> => {
    const operationId = randomUUID();
    const loginRef = `lgn_${randomBytes(16).toString("hex")}`;
    const result = await control({
      type: "login.authorize",
      operationId,
      loginRef,
      site: "https://bank.test",
      workspaceId: WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000001"),
      expiresAt: new Date(Date.now() + passwordLoginLifetimeMs).toISOString(),
      requester: {
        deploymentId: "dep_personal",
        deploymentName: "E2E",
        workspaceName: "Synthetic workspace",
        threadTitle: "Password journey",
        reason: "Verify synthetic account",
      },
    });
    check("sessionless control starts", result.type === "login.authorize.started");
    await waitFor("v5 broker authorization", () =>
      broker.held("signin.request").some((call) => call.params.transactionId === operationId),
    );
    const request = broker
      .held("signin.request")
      .find((call) => call.params.transactionId === operationId)!;
    check(
      "Workspace consent carries no browser identity",
      !Object.hasOwn(request.params, "sessionId") &&
        !Object.hasOwn(request.params, "runtimeId") &&
        request.params.permissionVersion === 5,
    );
    broker.answer("signin.request", {
      decision: "authorized",
      login: { ...login, hasTOTP: policy.hasTOTP },
    });
    await waitFor("Workspace lease", () =>
      controlEvents.some(
        (event) => event.type === "login.result" && event.operationId === operationId,
      ),
    );
    const event = controlEvents.find(
      (event) => event.type === "login.result" && event.operationId === operationId,
    );
    check(
      "authority echoes the Host reference",
      event?.type === "login.result" &&
        event.outcome.kind === "authorized" &&
        event.outcome.loginRef === loginRef,
    );
    return { operationId, loginRef };
  };
  const initialWorkspaceLease = options.workspaceLease ? await authorizeWorkspace() : undefined;
  if (options.workspaceLease)
    check(
      "authorization opens neither browser nor helper",
      browser === undefined && helperCalls === 0,
    );
  const peer = (surface: "phone" | "mac") => {
    const key = createECDH("prime256v1");
    key.generateKeys();
    const receiver = LoginReceiverKeySchema.parse({
      version: 1,
      connectionId: `scripted-${surface}-${randomUUID()}`,
      connectionGeneration: 1,
      publicKey: key.getPublicKey(undefined, "uncompressed").toString("base64url"),
    });
    const consumed = new Map<string, number>();
    let attempts = 0;
    return async (lease: Lease, field: LoginField) => {
      const binding = LoginEnvelopeBindingSchema.parse({
        version: 1,
        connectionId: receiver.connectionId,
        connectionGeneration: receiver.connectionGeneration,
        runId: "run_00000000-0000-4000-8000-000000000001",
        sessionId: `cus_${randomUUID()}`,
        actId: `scripted-${randomUUID()}`,
        actionIndex: 0,
        field,
        expiresAt: Date.now() + 30_000,
      });
      const result = await control({
        type: "login.seal",
        operationId: lease.operationId,
        receiver,
        binding,
      });
      check(
        `${surface} gets ciphertext only`,
        result.type === "login.seal.result" && result.status === "sealed",
      );
      if (result.type !== "login.seal.result" || result.status !== "sealed")
        throw new Error("Expected sealed field");
      let value = openLoginEnvelope({
        envelope: result.envelope,
        receiver,
        privateKey: key.getPrivateKey(),
        expectedBinding: binding,
        now: Date.now(),
        consumed,
      });
      const matches =
        field === "password"
          ? value === fixture.password
          : field === "username"
            ? value === fixture.username
            : fixture.codes.has(value);
      value = "";
      fixture.appAssertions.push({ surface, field, matches, attempts: ++attempts });
      check(`${surface} fixture received the exact saved ${field}`, matches);
    };
  };
  signIns = new HostSignIns({ authority, runtimeId: "passwords-e2e" });
  const sessionId = createBrowserSessionId();
  launcher = new ElectronBrowserLauncher({
    downloads: smokeDownloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  const partitionKey = options.profile
    ? (`profile:${options.profile}` as const)
    : (`session:${sessionId}` as const);
  const partition = electronSession.fromPartition(electronBrowserPartition(partitionKey), {
    cache: true,
  });
  partition.setCertificateVerifyProc((request, callback) => {
    let trusted = false;
    try {
      trusted =
        ["bank.test", "other.test"].includes(request.hostname) &&
        new X509Certificate(request.certificate.data).fingerprint256 ===
          new X509Certificate(fixture.certificate).fingerprint256;
    } catch {}
    callback(trusted ? 0 : -3);
  });
  await partition.setProxy({ mode: "direct" });
  browser = await launcher.launch({
    initialViewport: { width: 900, height: 720, devicePixelRatio: 1 },
    sessionId,
    partitionKey,
    storage: { kind: "guest" },
  });
  const page = browser.context.pages()[0]!;
  const targetId = await page.targetId();
  const contents = webContents.fromDevToolsTargetId(targetId);
  if (!contents) throw new Error("Missing launched Electron page.");
  files = new SessionFiles(path.join(work, sessionId));
  router = new SessionCdpRouter(browser.cdp);
  ledger = new SurfaceLedger(browser.context, {
    claimTarget: (id) => router!.claimTarget(sessionId, id),
    initialViewport: { width: 900, height: 720, devicePixelRatio: 1 },
  });
  router.registerSession(sessionId, targetId, (id) => ledger!.resolveTarget(id), files.root);
  await ledger.start();
  const messages: BrowserServerMessage[] = [];
  const hostSend = async (message: unknown) => {
    const parsed = BrowserClientMessageSchema.parse(message);
    traffic.push(JSON.stringify({ direction: "host-to-runtime", message: parsed }));
    await controller!.handle(parsed);
  };
  controller = new BrowserController({
    cdpRouter: router,
    claims: BrowserAttachTicketClaimsSchema.parse({
      operationExpiresAt: new Date(Date.now() + 18_000).toISOString(),
      remainingBudgetMs: 18_000,
      wireVersion: 1,
      access: "full-control",
      audience: "opensteer-browser-runtime",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + passwordLoginLifetimeMs).toISOString(),
      identity: options.profile
        ? {
            kind: "profile",
            profileId: options.profile,
            profileLeaseToken: randomBytes(32).toString("base64url"),
            profileStateUrl: "https://host.invalid/profile-state",
          }
        : { kind: "fresh" },
      nonce: randomUUID(),
      runtimeId: "passwords-e2e",
      sessionId,
      subject: "passwords-e2e",
    }),
    files,
    ledger,
    signIns,
    replaceSiteCookies: (site, cookies, deadline) =>
      browser!.replaceSiteCookies(site, cookies, deadline),
    sink: {
      sendFrame: async () => undefined,
      sendServer: async (message) => {
        messages.push(message);
        traffic.push(JSON.stringify({ direction: "runtime-to-host", message }));
      },
    },
  });
  await controller.start();
  const send = async (
    method: string,
    parameters: CdpParameters = {},
    pageSession?: string,
  ): Promise<unknown> => {
    const requestId = randomUUID();
    await hostSend({
      type: "cdp.command",
      requestId,
      command: { method, parameters, ...(pageSession ? { sessionId: pageSession } : {}) },
    });
    const reply = messages.find(
      (m) => (m.type === "cdp.result" || m.type === "cdp.error") && m.requestId === requestId,
    );
    if (reply?.type === "cdp.error") throw new Error(`CDP ${method}: ${reply.error.code}`);
    if (reply?.type !== "cdp.result") throw new Error(`No CDP reply: ${method}`);
    return reply.result;
  };
  const pageSession = z
    .object({ sessionId: z.string() })
    .parse(await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  const cdp = (method: string, params: CdpParameters = {}) => send(method, params, pageSession);
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = z
      .object({
        result: z.object({ value: z.unknown().optional() }),
        exceptionDetails: z.unknown().optional(),
      })
      .parse(
        await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
      );
    if (result.exceptionDetails) throw new Error("Fixture evaluation failed.");
    return result.result.value;
  };
  const clickAt = async (x: number, y: number) => {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  };
  const click = async (selector: string) => {
    const point = coordinate.parse(
      await evaluate(
        `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('missing fixture control');const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
      ),
    );
    await clickAt(point.x, point.y);
    record("agent-click", { selector });
  };
  const navigate = async (route: string, host = "bank.test") => {
    const url = new URL(route, fixture.origin(host));
    url.searchParams.set("case", currentCase);
    await cdp("Page.navigate", { url: url.href });
    await waitFor("fixture navigation", async () => {
      try {
        return (
          (await evaluate(
            `location.href===${JSON.stringify(url.href)}&&document.readyState==='complete'`,
          )) === true
        );
      } catch {
        return false;
      }
    });
    record("agent-navigate", { path: url.pathname, host });
  };
  const authorize = async (site = "https://bank.test"): Promise<Lease> => {
    const operationId = randomUUID();
    await hostSend({
      type: "login.authorize",
      operationId,
      site,
      workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
      requester: {
        deploymentId: "dep_personal",
        deploymentName: "E2E",
        workspaceName: "Synthetic workspace",
        threadTitle: "Password journey",
        reason: "Verify synthetic account",
      },
      expiresAt: new Date(Date.now() + passwordLoginLifetimeMs).toISOString(),
    });
    await waitFor("broker authorization request", () =>
      broker.held("signin.request").some((call) => call.params.transactionId === operationId),
    );
    broker.answer("signin.request", {
      decision: "authorized",
      login: { ...login, hasTOTP: policy.hasTOTP },
    });
    await waitFor("login authorization", () =>
      messages.some((m) => m.type === "login.result" && m.operationId === operationId),
    );
    const message = messages.find(
      (m) => m.type === "login.result" && m.operationId === operationId,
    );
    if (message?.type !== "login.result") throw new Error("Missing authorization result.");
    const authorized = leaseSchema.parse(message.outcome);
    record("authorized", { operationId, site, account: authorized.account });
    return { operationId, loginRef: authorized.loginRef };
  };
  const fill = async (lease: Lease, field: LoginField) => {
    updateLogin();
    if (policy.revoked) broker.revokeGrants();
    if (policy.holdRelease) broker.reply("signin.release", () => undefined);
    const status = LoginFillStatusSchema.parse(
      object.parse(await cdp("Opensteer.fillLogin", { loginRef: lease.loginRef, field })).status,
    );
    record("fill-result", { field, status });
    return status;
  };
  setupHealthy = true;
  const screenshot = async (name: string) => {
    let png: Buffer = Buffer.alloc(0);
    // Authentication can finish before Viz has a capturable surface. Keep the
    // evidence requirement, waiting for an actual picture rather than a sleep.
    await waitFor(`nonempty ${name} screenshot`, async () => {
      const image = await contents.capturePage();
      if (image.isEmpty()) return false;
      png = image.toPNG();
      return png.length > 0;
    });
    await writeFile(path.join(artifactDirectory, `${currentCase}-${name}.png`), png);
  };
  const observe = async () => {
    const before = fixture.assertions.filter(
      (a) => a.caseId === currentCase && a.path === "/observe",
    ).length;
    await click("#report");
    await waitFor(
      "server observation",
      () =>
        fixture.assertions.filter((a) => a.caseId === currentCase && a.path === "/observe").length >
        before,
    );
  };
  return {
    browser,
    contents,
    signIns,
    sessionId,
    broker,
    policy,
    cleanup,
    hostSend,
    cdp,
    send,
    evaluate,
    click,
    clickAt,
    navigate,
    authorize,
    fill,
    screenshot,
    observe,
    initialWorkspaceLease,
    control,
    peer,
  };
}

async function identity(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  await waitFor("server-authenticated account", async () => {
    try {
      return (
        (await h.evaluate(
          `document.querySelector('#identity')?.textContent===${JSON.stringify(fixture.username)}`,
        )) === true
      );
    } catch {
      return false;
    }
  });
  check(
    "account response had a valid server session",
    fixture.assertions.some(
      (a) => a.caseId === currentCase && a.path === "/account" && a.authenticated,
    ),
  );
  await h.screenshot("account");
}

async function signIn(h: Awaited<ReturnType<typeof harness>>, identifier = false): Promise<void> {
  await h.navigate("/account");
  check(
    "fresh account request is unauthenticated",
    (await h.evaluate("!!document.querySelector('#unauthenticated')")) === true,
  );
  await h.navigate(identifier ? "/identifier" : "/login");
  const lease = await h.authorize();
  await h.click("#username");
  check("username fill", (await h.fill(lease, "username")) === "filled");
  if (identifier) {
    await h.click("#submit");
    await waitFor(
      "password step",
      async () => (await h.evaluate("!!document.querySelector('#password')")) === true,
    );
  }
  await h.click("#password");
  check("password fill", (await h.fill(lease, "password")) === "filled");
  await h.click("#submit");
  if (!identifier) {
    await waitFor(
      "full-page spinner",
      async () => (await h.evaluate("!document.querySelector('#spinner').hidden")) === true,
    );
    check(
      "analytics cookie changed before verification",
      (await h.evaluate("document.cookie.includes('analytics=')")) === true,
    );
    check(
      "password and cookie churn did not authenticate",
      (await h.evaluate(
        `fetch('/account?case=${currentCase}').then(response=>response.status)`,
      )) === 401,
    );
    await h.screenshot("spinner");
    await waitFor(
      "verification chooser after delayed XHR",
      async () => (await h.evaluate("!!document.querySelector('#chooser')")) === true,
    );
    await h.screenshot("chooser");
    await h.click("#totp-method");
    await h.click("#continue");
    await waitFor("TOTP page", async () => {
      try {
        return (await h.evaluate("!!document.querySelector('#code')")) === true;
      } catch {
        return false;
      }
    });
    await h.click("#code");
    check("TOTP fill", (await h.fill(lease, "code")) === "filled");
    await h.click("#submit");
  }
  await identity(h);
  if (!identifier) {
    await h.cdp("Page.reload");
    await identity(h);
    check(
      "site local and session storage survived real-tab navigation and reload",
      (await h.evaluate(
        "localStorage.getItem('continuity-local')==='kept'&&sessionStorage.getItem('continuity-session')==='kept'",
      )) === true,
    );
  }
}

async function releaseRace(
  kind: "navigate" | "reload" | "focus" | "cancel" | "revoke",
  hooks = false,
): Promise<void> {
  const h = await harness();
  const id = randomUUID();
  const action = kind === "navigate" || kind === "reload" || kind === "focus" ? kind : null;
  await h.navigate(`/field?${action ? `race=${action}&id=${id}&` : ""}${hooks ? "hooks=1" : ""}`);
  if (action) await waitFor("fixture race barrier", () => fixture.waiting(id));
  const originalDocument = await h.evaluate("window.__documentId");
  const lease = await h.authorize();
  await h.click("#password");
  h.policy.holdRelease = true;
  const before = h.broker.received("signin.release").length;
  const pending = h.fill(lease, "password");
  void pending.catch(() => undefined);
  await waitFor("release in flight", () => h.broker.received("signin.release").length > before);
  const held = z.object({ id: z.number() }).parse(h.broker.received("signin.release").at(-1));
  if (action) {
    fixture.signal(id);
    await waitFor("race happened before release answer", async () => {
      try {
        return (
          (await h.contents.mainFrame.executeJavaScript(
            action === "focus"
              ? "window.__raceDone===true&&document.activeElement.id==='second'"
              : action === "reload"
                ? `document.readyState==='complete'&&window.__documentId!==${JSON.stringify(originalDocument)}&&document.querySelector('#password').value.length===0`
                : "location.pathname==='/replacement'&&document.readyState==='complete'",
          )) === true &&
          (action !== "reload" || h.contents.mainFrame.url.includes("race=reload"))
        );
      } catch {
        return false;
      }
    });
  } else if (kind === "cancel") {
    await h.hostSend({
      type: "login.cancel",
      operationId: lease.operationId,
      reason: "withdrawn",
    });
    await waitFor("lease ended notification", () => h.broker.received("signin.cancel").length > 0);
  } else {
    h.policy.revoked = true;
    h.broker.revokeGrants();
  }
  // The delayed fake broker may answer after cancellation. Production must
  // discard those bytes, never retry or write them into a later document.
  h.broker.broadcast({
    id: held.id,
    result:
      kind === "revoke"
        ? { released: false, reason: "revoked" }
        : { released: true, value: fixture.password },
  });
  const status = await pending;
  check(
    "release race refuses write",
    status === (kind === "cancel" ? "expired" : kind === "revoke" ? "denied" : "stale"),
    { status },
  );
  check(
    "both fields remain empty",
    (await h.evaluate(
      "document.querySelector('#password').value.length===0&&document.querySelector('#second').value.length===0",
    )) === true,
  );
  await h.observe();
  const observed = fixture.assertions.filter(
    (a) => a.caseId === currentCase && a.path === "/observe",
  );
  check(
    "fixture received neither password nor captured source containing it",
    observed.length > 0 && observed.every((a) => !a.passwordReceived && !a.capturedPassword),
  );
  if (hooks)
    check(
      "malicious accessors/stack hooks actually ran",
      observed.some((a) => a.hooksRan),
    );
  await h.screenshot("refused");
}

async function run(): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  await fixture.start(path.join(work, "tls"));
  const fingerprint = new X509Certificate(fixture.certificate).fingerprint256.replaceAll(":", "");
  record("fixture-certificate", { fingerprint });
  await journey(
    "0",
    "Workspace authorization before any browser; cross-surface reuse survives browser close",
    async () => {
      const h = await harness({ workspaceLease: true });
      const lease = h.initialWorkspaceLease;
      check("reference authorized before browser launch", lease !== undefined);
      if (!lease) throw new Error("Missing Workspace lease");
      const phone = h.peer("phone");
      const mac = h.peer("mac");
      await Promise.all([phone(lease, "username"), mac(lease, "password")]);
      await h.navigate("/identifier");
      await h.click("#username");
      check("same ref fills browser username", (await h.fill(lease, "username")) === "filled");
      await h.click("#submit");
      await waitFor(
        "identifier password step",
        async () => (await h.evaluate("!!document.querySelector('#password')")) === true,
      );
      await h.click("#password");
      check("same ref fills browser password", (await h.fill(lease, "password")) === "filled");
      await h.click("#submit");
      await identity(h);
      await h.browser.close();
      await phone(lease, "password");
      await mac(lease, "code");
      check(
        "all app predicates are true",
        fixture.appAssertions.length === 4 && fixture.appAssertions.every(({ matches }) => matches),
      );
      await h.control({
        type: "login.cancel",
        operationId: lease.operationId,
        reason: "withdrawn",
      });
    },
  );
  await app.whenReady();
  await journey(
    "1",
    "SPA bank: spinner, cookie churn, chooser, TOTP, server account, real-tab continuity",
    async () => signIn(await harness()),
  );
  await journey("2", "Identifier-first login", async () => signIn(await harness(), true));
  await journey("3", "Wrong registrable site refuses before release", async () => {
    const h = await harness();
    await h.navigate("/field", "other.test");
    const lease = await h.authorize();
    await h.click("#password");
    check("wrong-site", (await h.fill(lease, "password")) === "wrong-site");
    check("broker released nothing", h.broker.received("signin.release").length === 0);
    check(
      "wrong-site page field empty",
      (await h.evaluate("document.querySelector('#password').value.length===0")) === true,
    );
    await h.observe();
    check(
      "wrong-site server received no password",
      fixture.assertions.filter((a) => a.caseId === currentCase).every((a) => !a.passwordReceived),
    );
    await h.screenshot("wrong-site");
  });
  await journey("4", "Cross-site OOPIF uses focused frame origin", async () => {
    const h = await harness();
    await h.navigate("/parent");
    await waitFor("cross-site frame", () =>
      h.contents.mainFrame.frames.some((f) => f.url.startsWith(fixture.origin("other.test"))),
    );
    check(
      "fixture really is out of process",
      h.contents.mainFrame.frames.some((f) => f.processId !== h.contents.mainFrame.processId),
    );
    const point = coordinate.parse(
      await h.evaluate(
        "(()=>{const r=document.querySelector('#child').getBoundingClientRect();return{x:r.left+100,y:r.top+35}})()",
      ),
    );
    await h.clickAt(point.x, point.y);
    check(
      "browser focused site B frame",
      h.contents.focusedFrame?.origin === fixture.origin("other.test"),
    );
    const parent = await h.authorize();
    check("lease for A refuses focused B", (await h.fill(parent, "password")) === "wrong-site");
    check("refused OOPIF released nothing", h.broker.received("signin.release").length === 0);
    // Ask the iframe itself to report before any permitted fill.
    await h.clickAt(point.x, point.y + 70);
    await waitFor("OOPIF refusal server observation", () =>
      fixture.assertions.some((a) => a.caseId === currentCase && a.path === "/observe"),
    );
    check(
      "refused OOPIF server never received password",
      fixture.assertions
        .filter((a) => a.caseId === currentCase && a.path === "/observe")
        .every((a) => !a.passwordReceived),
    );
    await h.clickAt(point.x, point.y);
    const child = await h.authorize("https://other.test");
    check("lease for B fills focused B", (await h.fill(child, "password")) === "filled");
    await h.screenshot("oopif");
  });
  await journey("5", "Non-input focus refuses without release", async () => {
    const h = await harness();
    await h.navigate("/field");
    const lease = await h.authorize();
    await h.click("#outside");
    check("no-field", (await h.fill(lease, "password")) === "no-field");
    check("no broker release for non-input", h.broker.received("signin.release").length === 0);
    try {
      await h.send("Opensteer.fillLogin", { loginRef: lease.loginRef, field: "password" });
      check("browser-level fill rejected", false);
    } catch (error) {
      check(
        "browser-level fill is bad_message",
        error instanceof Error && error.message.endsWith("bad_message"),
      );
    }
    await h.screenshot("no-field");
  });
  await journey(
    "6",
    "Lease checks: revoked, unavailable TOTP, mismatched/closed session",
    async () => {
      const h = await harness();
      await h.navigate("/field");
      const lease = await h.authorize();
      await h.click("#code");
      h.policy.hasTOTP = false;
      check("missing TOTP is unavailable", (await h.fill(lease, "code")) === "unavailable");
      await h.click("#password");
      h.policy.revoked = true;
      check("revoked grant is denied", (await h.fill(lease, "password")) === "denied");
      const other = await harness();
      await other.navigate("/field");
      await other.click("#password");
      check("different session refuses lease", (await other.fill(lease, "password")) === "expired");
      const second = await h.authorize();
      h.signIns.sessionDetached(h.sessionId);
      check(
        "runtime session-detach cleanup invalidates lease",
        (await h.fill(second, "password")) === "expired",
      );
      await h.screenshot("lease-refusals");
    },
  );
  await journey(
    "9-oopif",
    "Focus leaves OOPIF while iframe input stays locally active",
    async () => {
      const h = await harness();
      await h.navigate("/parent");
      await waitFor("iframe ready", () => h.contents.mainFrame.frames.length > 0);
      const point = coordinate.parse(
        await h.evaluate(
          "(()=>{const r=document.querySelector('#child').getBoundingClientRect();return{x:r.left+100,y:r.top+35}})()",
        ),
      );
      await h.clickAt(point.x, point.y);
      const childFrame = h.contents.focusedFrame;
      check("child initially focused", childFrame?.origin === fixture.origin("other.test"));
      await h.click("#outside");
      check("focus left the child frame", h.contents.focusedFrame !== childFrame);
      // Whether Chromium keeps the departed frame's input locally active is
      // recorded, not assumed: the fill must refuse either way.
      record("departed-frame-active-element", {
        password:
          (await childFrame?.executeJavaScript("document.activeElement?.id==='password'")) === true,
      });
      const lease = await h.authorize("https://other.test");
      const status = await h.fill(lease, "password");
      check("departed OOPIF refuses", ["no-field", "stale", "wrong-site"].includes(status), {
        status,
      });
      check("departed OOPIF caused no release", h.broker.received("signin.release").length === 0);
      await h.screenshot("focus-left");
    },
  );
  await journey("9-navigation", "Navigation between precheck and write", () =>
    releaseRace("navigate"),
  );
  await journey("9-cancel", "Delayed release after cancellation", () => releaseRace("cancel"));
  await journey("9-revoke", "Delayed release after grant revocation", () => releaseRace("revoke"));
  await journey("9a-reload", "Same-origin reload invalidates document identity", () =>
    releaseRace("reload"),
  );
  await journey("9b-focus", "Same-document input A to B invalidates element identity", () =>
    releaseRace("focus"),
  );
  await journey(
    "9c-hooks",
    "Accessor and prepareStackTrace hooks cannot steal a refused value",
    () => releaseRace("focus", true),
  );
  await journey("9d-background", "Fill works without OS focus", async () => {
    const h = await harness();
    await h.navigate("/field");
    const lease = await h.authorize();
    await h.click("#password");
    const foreground = new BrowserWindow({ width: 300, height: 200, show: true });
    const close = async () => {
      if (!foreground.isDestroyed()) foreground.destroy();
    };
    cleanups.add(close);
    await foreground.loadURL("data:text/html,<h1>Foreground fixture</h1>");
    foreground.focus();
    await waitFor("foreground window holds OS focus", () => foreground.isFocused());
    check("agent page is background", !h.contents.isFocused());
    record("background-page-has-focus", { hasFocus: await h.evaluate("document.hasFocus()") });
    check("background fill succeeds", (await h.fill(lease, "password")) === "filled");
    check(
      "native setter dispatched composed input and change",
      (await h.evaluate("window.__events.input===1&&window.__events.change===1")) === true,
    );
    await h.screenshot("background");
  });
  await journey("7", "Platform traffic and stdout/stderr canary scan", async () => {
    const scanned = [...traffic, ...output];
    const desktopFiles = await findLogs(app.getPath("userData"));
    for (const filename of desktopFiles) scanned.push(await readFile(filename, "utf8"));
    const leaks = secrets().filter((secret) => scanned.some((line) => line.includes(secret)));
    const scan = {
      executed: true,
      passed: leaks.length === 0,
      leakedCanaries: leaks.length,
      platformMessages: traffic.length,
      harnessOutputChunks: output.length,
      desktopLogFiles: desktopFiles.length,
      absentProcesses: ["Host", "Runner"],
      scope:
        "Every message at the real runtime Host boundary; desktop service logs; harness stdout/stderr. The smoke has no Host/Runner processes.",
    };
    await writeFile(path.join(artifactDirectory, "leak-scan.json"), JSON.stringify(scan, null, 2));
    check(
      "all platform transport, desktop logs and harness output is secret-free",
      scan.passed,
      scan,
    );
  });
}

async function findLogs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await findLogs(filename)));
    else if (entry.isFile() && entry.name.endsWith(".log")) result.push(filename);
  }
  return result;
}

async function finish(error?: unknown): Promise<void> {
  finished = true;
  clearInterval(liveness);
  let cleanupFailed = false;
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch {
      cleanupFailed = true;
    }
  }
  await fixture.close().catch(() => {
    cleanupFailed = true;
  });
  const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const sourceDiff = execFileSync("git", ["diff", "HEAD"], {
    cwd: repositoryRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  const sourceFiles: Record<string, string> = {};
  for (const filename of [
    "apps/desktop/scripts/electron-passwords-smoke.ts",
    "apps/desktop/scripts/electron-passwords-fixture.ts",
    "apps/desktop/scripts/tsup.electron-passwords-smoke.config.ts",
    "apps/desktop/package.json",
  ]) {
    sourceFiles[filename] = createHash("sha256")
      .update(await readFile(path.join(repositoryRoot, filename)))
      .digest("hex");
  }
  for (const entry of journeys) {
    if (entry.status === "pending") {
      entry.status = "blocked";
      entry.error = "Not executed after setup failure.";
    }
  }
  // Failure paths must be scanned too, even when an earlier journey prevented
  // the final scan case from running. Only counts leave the raw buffers.
  const rawBuffers = [
    { path: "platform-traffic.jsonl", text: traffic.join("\n") },
    { path: "harness-output.log", text: output.join("") },
    { path: "chronology.json", text: JSON.stringify(chronology) },
    {
      path: "failure",
      text: error instanceof Error ? (error.stack ?? error.message) : String(error ?? ""),
    },
  ];
  const rawScan = rawBuffers.map(({ path, text }) => ({
    path,
    matches: secrets().reduce((count, secret) => count + Number(text.includes(secret)), 0),
  }));
  let leakMatches = rawScan.reduce((count, entry) => count + entry.matches, 0);
  let passed =
    !error &&
    !cleanupFailed &&
    leakMatches === 0 &&
    journeys.length > 0 &&
    journeys.every((j) => j.status === "passed");
  await mkdir(artifactDirectory, { recursive: true });
  if (journeys.find((entry) => entry.id === "7")?.status === "blocked") {
    await writeFile(
      path.join(artifactDirectory, "leak-scan.json"),
      JSON.stringify(
        { executed: false, passed: false, reason: "Suite did not reach leak scan." },
        null,
        2,
      ),
    );
  }
  const manifest = {
    runId,
    sourceSha: sha,
    sourceFiles,
    trackedDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
    replay,
    selectedCases: journeys.map(({ id }) => id),
    executedCases: journeys.filter(({ status }) => status !== "blocked").map(({ id }) => id),
    passed,
    cleanupFailed,
    startupError: error ? scrub(error instanceof Error ? error.message : "Unknown failure") : null,
    journeys,
    coverageGaps: [
      "Host Workspace admission requires the Host-owned integration journey. No Host or Runner is started by this runtime smoke.",
    ],
    electron: process.versions.electron,
  };
  await writeFile(
    path.join(artifactDirectory, "manifest.json"),
    scrub(JSON.stringify(manifest, null, 2)),
  );
  await writeFile(
    path.join(artifactDirectory, "chronology.json"),
    scrub(JSON.stringify(chronology, null, 2)),
  );
  await writeFile(
    path.join(artifactDirectory, "fixture-auth-assertions.json"),
    JSON.stringify(fixture.assertions, null, 2),
  );
  await writeFile(
    path.join(artifactDirectory, "app-fixture-assertions.json"),
    JSON.stringify(fixture.appAssertions, null, 2),
  );
  await writeFile(
    path.join(artifactDirectory, "platform-traffic.jsonl"),
    scrub(traffic.join("\n")),
  );
  await writeFile(path.join(artifactDirectory, "harness-output.log"), scrub(output.join("")));
  await writeFile(path.join(artifactDirectory, "replay.txt"), `${sha}\n${replay}\n`);
  const exportedScan: { path: string; matches: number }[] = [];
  for (const filename of (await readdir(artifactDirectory)).sort()) {
    if (filename === "SHA256SUMS" || filename === "leak-scan.json") continue;
    const bytes = await readFile(path.join(artifactDirectory, filename));
    exportedScan.push({
      path: filename,
      matches: secrets().reduce(
        (count, secret) =>
          count +
          Number(bytes.includes(Buffer.from(secret))) +
          Number(bytes.includes(Buffer.from(secret, "utf16le"))),
        0,
      ),
    });
  }
  leakMatches += exportedScan.reduce((count, entry) => count + entry.matches, 0);
  passed &&= leakMatches === 0;
  manifest.passed = passed;
  await writeFile(
    path.join(artifactDirectory, "manifest.json"),
    scrub(JSON.stringify(manifest, null, 2)),
  );
  await writeFile(
    path.join(artifactDirectory, "leak-scan.json"),
    JSON.stringify(
      {
        executed: true,
        passed: leakMatches === 0,
        matches: leakMatches,
        raw: rawScan,
        exported: exportedScan,
      },
      null,
      2,
    ),
  );
  const sums: string[] = [];
  for (const filename of (await readdir(artifactDirectory)).sort()) {
    if (filename !== "SHA256SUMS")
      sums.push(
        `${createHash("sha256")
          .update(await readFile(path.join(artifactDirectory, filename)))
          .digest("hex")}  ${filename}`,
      );
  }
  await writeFile(path.join(artifactDirectory, "SHA256SUMS"), sums.join("\n") + "\n");
  rmSync(work, { force: true, recursive: true });
  process.stdout.write(
    `${JSON.stringify({ event: "passwords-e2e-finished", passed, artifactDirectory })}\n`,
  );
  app.exit(passed ? 0 : 1);
}
void run()
  .then(
    () => finish(),
    (error) => finish(error),
  )
  .catch(() => {
    rmSync(work, { force: true, recursive: true });
    app.exit(1);
  });
