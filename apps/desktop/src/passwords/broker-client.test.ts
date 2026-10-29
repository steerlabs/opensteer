import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { passwordsBrokerMaxFrameBytes } from "@opensteer/protocol/passwords-broker";
import { encodeLengthPrefixedJson } from "@opensteer/shared/lengthPrefixedJson";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withSignedHelperLifecycleLock,
  type SignedHelperProcess,
} from "../signed-helpers/signed-helper.js";
import { PasswordsBrokerClient } from "./broker-client.js";
import { PasswordsBrokerFailure } from "./broker-session.js";
import { fakePasswordsLogin } from "./test-support/fake-broker-session.js";
import { passwordsBrokerAppName } from "./paths.js";
import {
  currentUid,
  FakePasswordsBroker,
  verifySameUserPeer,
} from "./test-support/fake-broker-server.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const transactionId = "6f1c2a4b-5d6e-4f80-9a1b-2c3d4e5f6071";
const syntheticPassword = "synthetic-password-7c1a";

const requestParams = {
  deploymentId: "dep_personal",
  deploymentName: "Personal",
  workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  reason: "Check the invoice",
  threadTitle: "Invoices",
  workspaceName: "Home",
  runtimeId: "desktop-browser",
  sessionId: "bsn_00000000-0000-4000-8000-000000000007",
  site: "https://example.com",
  transactionId,
};

// Unix sockets and the kernel's peer credentials: this runs in the macOS job.
describe.runIf(process.platform === "darwin")("PasswordsBrokerClient", () => {
  it("sends only the site when probing", async () => {
    const harness = await clientHarness();
    await expect(
      harness.client.call("signin.probe", { site: requestParams.site } as Parameters<
        typeof harness.client.call<"signin.probe">
      >[1]),
    ).resolves.toEqual({ passwords: "has-login" });
    expect(harness.broker.received("signin.probe")[0]?.params).toEqual({
      site: requestParams.site,
    });
  });

  it.each([
    { decision: "unavailable", reason: "passwords-off" },
    { decision: "unavailable", reason: "not-set-up" },
    { decision: "approve", accounts: [], message: "That account changed. Choose it again." },
  ])("parses the v4 approval decision $decision/$reason", async (answer) => {
    const harness = await clientHarness();
    harness.broker.reply("signin.approve", () => answer);
    await expect(
      harness.client.call("signin.approve", {
        transactionId,
        loginId: transactionId,
        revision: 1,
        remember: false,
      }),
    ).resolves.toEqual(answer);
  });

  it("withdraws held calls using an invalid error, never a decision", async () => {
    const harness = await clientHarness();
    const controller = new AbortController();
    const pending = harness.client
      .call("signin.request", requestParams, { signal: controller.signal })
      .catch((error: unknown) => error);
    await harness.broker.waitFor("signin.request");
    controller.abort();
    await pending;
    await harness.broker.waitFor("signin.cancel");
    await harness.client.call("status", {});
    expect(
      harness.broker.transcript.some((entry) =>
        JSON.stringify(entry.frame).includes('"decision":"declined"'),
      ),
    ).toBe(false);
    expect(harness.broker.held()).toHaveLength(0);
  });

  it("verifies both peers, says hello, and answers by increasing id", async () => {
    const harness = await clientHarness();

    await expect(harness.client.call("status", {})).resolves.toEqual({
      agentSignIns: "on",
      vault: "ready",
    });
    await harness.client.call("status", {});

    const frames = harness.broker.transcript.filter((entry) => entry.direction === "in");
    expect(frames.map((entry) => entry.frame)).toEqual([
      { id: 1, method: "hello", params: { client: { version: "9.9.9" }, protocolVersion: 4 } },
      { id: 2, method: "status", params: {} },
      { id: 3, method: "status", params: {} },
    ]);
    // The broker's own same-user check passed, and this side checked the
    // broker with the copy sealed inside the app, never the installed one.
    expect(harness.broker.refusedPeers).toEqual([]);
    expect(harness.verifiedWith).toEqual([
      path.join(harness.verifierAppPath, "Contents", "MacOS", "Opensteer Passwords"),
    ]);
    expect(harness.commands()).not.toContain("/usr/bin/open");
  });

  it("refuses a broker that speaks another protocol version", async () => {
    const harness = await clientHarness({ protocolVersion: 99 });

    await expect(harness.client.call("status", {})).rejects.toMatchObject({
      code: "incompatible",
    });
    expect(harness.broker.received("status")).toEqual([]);
  });

  it("refuses a development broker from a release desktop", async () => {
    const harness = await clientHarness({ brokerDevelopment: true, development: false });

    await expect(harness.client.call("status", {})).rejects.toMatchObject({
      code: "wrong-build",
    });
    expect(harness.broker.received("status")).toEqual([]);
    await vi.waitFor(() => expect(harness.broker.openConnections).toBe(0));
  });

  it("refuses a release broker from a development desktop", async () => {
    const harness = await clientHarness({ brokerDevelopment: false, development: true });

    await expect(harness.client.call("status", {})).rejects.toMatchObject({
      code: "wrong-build",
    });
    expect(harness.broker.received("status")).toEqual([]);
  });

  it("never launches a broker whose signature names the other build", async () => {
    const harness = await clientHarness({
      development: false,
      signedIdentifier: "com.opensteer.passwords.dev",
      startListening: false,
    });

    await expect(harness.client.call("status", {})).rejects.toMatchObject({
      code: "not-running",
      message: expect.stringMatching(/not signed by Opensteer/u),
    });
    expect(harness.commands()).not.toContain("/usr/bin/open");
  });

  it("launches through LaunchServices, holding the lifecycle lock until the socket is ready", async () => {
    const harness = await clientHarness({ startListening: false });

    await expect(harness.client.connect()).resolves.toMatchObject({
      brokerVersion: "1.0.0",
      development: true,
    });
    expect(harness.commands()).toContain(`/usr/bin/open -g -a ${harness.brokerAppPath}`);
    expect(harness.commands().indexOf("/usr/bin/codesign")).toBeLessThan(
      harness.commands().indexOf("/usr/bin/open"),
    );
    expect(harness.lockHeldAtLaunch).toBe(true);
  });

  it("launches a fresh instance rather than trusting a socket an unverifiable broker holds", async () => {
    const harness = await clientHarness({ launchFreshInstance: true });

    await harness.client.connect();

    expect(harness.commands()).toContain(`/usr/bin/open -n -g -a ${harness.brokerAppPath}`);
  });

  it("gives up when the broker never binds its socket", async () => {
    const harness = await clientHarness({ neverListens: true, startListening: false });

    await expect(harness.client.connect()).rejects.toMatchObject({
      code: "not-running",
      message: expect.stringMatching(/did not start/u),
    });
  });

  it("sends nothing to a socket whose server the sealed verifier refuses", async () => {
    const harness = await clientHarness({
      verifyPeer: async (_executable, socket) => {
        // A same-user check that expects somebody else stands in for an
        // impostor process holding the socket.
        await verifySameUserPeer(socket, currentUid() + 1);
      },
    });

    await expect(harness.client.connect()).rejects.toMatchObject({
      code: "not-running",
      message: expect.stringMatching(/not owned by the Opensteer Passwords app/u),
    });
    expect(harness.broker.transcript).toEqual([]);
  });

  it("takes the socket back from a process that is not the broker, and starts the real one", async () => {
    const harness = await clientHarness({
      startListening: false,
      verifyPeer: async (_executable, socket) => {
        // The squatter answers first; the broker launched after it is genuine.
        if (squatterConnections > 0 && verifications++ === 0) {
          throw new Error("helper socket peer verification failed");
        }
        await verifySameUserPeer(socket);
      },
    });
    let squatterConnections = 0;
    let verifications = 0;
    const squatterReceived: Buffer[] = [];
    const squatter = createServer((connection) => {
      squatterConnections += 1;
      connection.on("data", (chunk: Buffer) => squatterReceived.push(chunk));
    });
    await new Promise<void>((resolvePromise) =>
      squatter.listen(harness.socketPath, resolvePromise),
    );
    cleanups.push(async () => await new Promise<void>((done) => squatter.close(() => done())));

    await expect(harness.client.call("status", {})).resolves.toMatchObject({ vault: "ready" });
    expect(harness.commands()).toContain(`/usr/bin/open -n -g -a ${harness.brokerAppPath}`);
    expect(squatterReceived).toEqual([]);
  });

  it("bounds a peer verifier that never returns", async () => {
    const harness = await clientHarness({
      peerVerificationTimeoutMs: 20,
      verifyPeer: async () => await new Promise<void>(() => undefined),
    });

    await expect(harness.client.connect()).rejects.toMatchObject({ code: "not-running" });
    expect(harness.broker.transcript).toEqual([]);
  });

  it("is refused unanswered by a development broker when it is not the same user", async () => {
    const harness = await clientHarness({ peerUid: currentUid() + 1 });

    await expect(harness.client.connect()).rejects.toMatchObject({ code: "connection-lost" });
    expect(harness.broker.refusedPeers).toEqual([1]);
    expect(harness.broker.transcript.filter((entry) => entry.direction === "out")).toEqual([]);
  });

  it("delivers status.changed to every listener", async () => {
    const harness = await clientHarness();
    const seen: unknown[] = [];
    harness.client.onStatusChanged((status) => seen.push(status));
    await harness.client.connect();

    harness.broker.setStatus({ agentSignIns: "off", vault: "ready" });

    await vi.waitFor(() => expect(seen).toEqual([{ agentSignIns: "off", vault: "ready" }]));
  });

  it("refuses a result its method's schema does not accept, without echoing it", async () => {
    const harness = await clientHarness();
    harness.broker.reply("signin.request", () => ({
      decision: "credential",
      item: {
        hasTOTP: false,
        id: "8d1c2a4b-5d6e-4f80-9a1b-2c3d4e5f6071",
        origins: ["http://example.com"],
        password: syntheticPassword,
        revision: 1,
        username: "person@example.com",
      },
    }));

    const failure = await harness.client
      .call("signin.request", requestParams, { signal: new AbortController().signal })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PasswordsBrokerFailure);
    expect(failure).toMatchObject({ code: "malformed" });
    expect(String((failure as Error).message)).not.toContain(syntheticPassword);
    expect(JSON.stringify(harness.log.mock.calls)).not.toContain(syntheticPassword);
  });

  it("returns the broker's own refusal code", async () => {
    const harness = await clientHarness();
    harness.broker.fail("window.open", { code: "unavailable", message: "The vault is locked." });

    await expect(harness.client.call("window.open", {})).rejects.toMatchObject({
      code: "unavailable",
      message: "The vault is locked.",
    });
  });

  it("refuses invalid parameters before anything is written", async () => {
    const harness = await clientHarness();

    await expect(
      harness.client.call("signin.release", {
        transactionId: "not-a-uuid",
        field: "password",
        origin: "https://example.com",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(harness.broker.transcript).toEqual([]);
  });

  it("waits for approval authentication and cancels when the caller aborts", async () => {
    const harness = await clientHarness({ requestTimeoutMs: 50 });
    const controller = new AbortController();
    harness.broker.reply("signin.approve", () => undefined);
    const decision = harness.client
      .call(
        "signin.approve",
        { transactionId, loginId: transactionId, revision: 1, remember: false },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    await harness.broker.waitFor("signin.approve");

    // Far longer than the bound on every other call: the person is reading.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(harness.client.pendingCalls).toBe(1);

    controller.abort();
    await expect(decision).resolves.toMatchObject({ code: "aborted" });
    await harness.broker.waitFor("signin.cancel");
    expect(harness.broker.received("signin.cancel")).toEqual([
      expect.objectContaining({ params: { transactionId } }),
    ]);
    // The broker's late answer to the withdrawn request goes nowhere, and the
    // connection serves the next call.
    await expect(harness.client.call("status", {})).resolves.toMatchObject({ vault: "ready" });
    expect(harness.broker.received("hello")).toHaveLength(1);
  });

  it("authorizes without releasing and revalidates each field release", async () => {
    const harness = await clientHarness();
    const requested = harness.client.request(requestParams);
    await harness.broker.waitFor("signin.request");
    const login = {
      id: "8d1c2a4b-5d6e-4f80-9a1b-2c3d4e5f6071",
      revision: 1,
      account: "p•••@example.com",
      hasTOTP: true,
    };
    harness.broker.answer("signin.request", { decision: "authorized", login });
    await expect(requested).resolves.toEqual({ decision: "authorized", login });
    await expect(
      harness.client.release({ transactionId, field: "password", origin: "https://example.org" }),
    ).resolves.toEqual({ released: false, reason: "wrong-site" });
    await expect(
      harness.client.release({ transactionId, field: "password", origin: "https://example.com" }),
    ).resolves.toEqual({ released: true, value: syntheticPassword });
    await expect(
      harness.client.release({ transactionId, field: "totp", origin: "https://example.com" }),
    ).resolves.toEqual({ released: true, value: "123456" });
    harness.broker.setLogin({ ...fakePasswordsLogin, revision: 2 });
    await expect(
      harness.client.release({ transactionId, field: "password", origin: "https://example.com" }),
    ).resolves.toEqual({ released: false, reason: "revoked" });
    harness.broker.setLogin(fakePasswordsLogin);
    harness.broker.revokeGrants();
    await expect(
      harness.client.release({ transactionId, field: "password", origin: "https://example.com" }),
    ).resolves.toEqual({ released: false, reason: "revoked" });
    await harness.client.cancel(transactionId);
    await expect(
      harness.client.release({ transactionId, field: "password", origin: "https://example.com" }),
    ).resolves.toEqual({ released: false, reason: "ended" });
    expect(JSON.stringify(harness.log.mock.calls)).not.toContain(syntheticPassword);
  });

  it("sends nothing for a signal that already fired", async () => {
    const harness = await clientHarness();
    await harness.client.connect();
    const controller = new AbortController();
    controller.abort();

    await expect(
      harness.client.call("signin.request", requestParams, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(harness.broker.received("signin.request")).toEqual([]);
    expect(harness.broker.received("signin.cancel")).toEqual([]);
  });

  it("bounds a call that is not waiting for the person, and keeps the connection", async () => {
    const harness = await clientHarness({ requestTimeoutMs: 50 });
    harness.broker.reply("signin.release", () => undefined);

    await expect(
      harness.client.call("signin.release", {
        transactionId,
        field: "password",
        origin: "https://example.com",
      }),
    ).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(harness.client.call("status", {})).resolves.toMatchObject({ vault: "ready" });
    expect(harness.broker.received("hello")).toHaveLength(1);
  });

  it("rejects everything in flight when the connection drops, then reconnects", async () => {
    const harness = await clientHarness();
    const disconnected = vi.fn();
    harness.client.onDisconnect(disconnected);
    const first = await harness.client.connect();
    const decision = harness.client
      .call("signin.request", requestParams, { signal: new AbortController().signal })
      .catch((error: unknown) => error);
    const problem = harness.client
      .call(
        "signin.approve",
        { loginId: transactionId, revision: 1, remember: false, transactionId },
        { signal: new AbortController().signal },
      )
      .catch((error: unknown) => error);
    await harness.broker.waitFor("signin.approve");

    harness.broker.dropConnections();

    await expect(decision).resolves.toMatchObject({ code: "connection-lost" });
    await expect(problem).resolves.toMatchObject({ code: "connection-lost" });
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledWith(first.generation));
    // A call pinned to the lost connection never reaches a new one.
    await expect(
      harness.client.call(
        "signin.release",
        { transactionId, field: "password", origin: "https://example.com" },
        { connection: first.generation },
      ),
    ).rejects.toMatchObject({ code: "connection-lost" });

    const second = await harness.client.connect();
    expect(second.generation).not.toBe(first.generation);
    await expect(harness.client.call("status", {})).resolves.toMatchObject({ vault: "ready" });
    expect(harness.broker.received("hello")).toHaveLength(2);
    expect(harness.broker.received("signin.release")).toEqual([]);
  });

  it("drops the connection on a frame that announces more than 256 KiB", async () => {
    const harness = await clientHarness();
    const decision = harness.client
      .call("signin.request", requestParams, { signal: new AbortController().signal })
      .catch((error: unknown) => error);
    await harness.broker.waitFor("signin.request");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(passwordsBrokerMaxFrameBytes + 1, 0);

    harness.broker.sendRaw(header);

    await expect(decision).resolves.toMatchObject({ code: "connection-lost" });
    expect(harness.log).toHaveBeenCalledWith("desktop.passwords.broker-frame-invalid", {
      reason: "too-large",
    });
  });

  it("drops the connection on a frame that is neither a reply nor an event", async () => {
    const harness = await clientHarness();
    const disconnected = vi.fn();
    harness.client.onDisconnect(disconnected);
    await harness.client.connect();

    harness.broker.sendRaw(
      encodeLengthPrefixedJson({ method: "status", params: {} }, passwordsBrokerMaxFrameBytes),
    );

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
    expect(harness.log).toHaveBeenCalledWith("desktop.passwords.broker-frame-invalid", {
      reason: "not-a-reply",
    });
  });

  it("shares one connection between concurrent first calls", async () => {
    const harness = await clientHarness({ startListening: false });

    await Promise.all([
      harness.client.call("status", {}),
      harness.client.call("status", {}),
      harness.client.call("window.open", {}),
    ]);

    expect(harness.broker.received("hello")).toHaveLength(1);
    expect(harness.commands().match(/\/usr\/bin\/open/gu)).toHaveLength(1);
  });

  it("refuses every call once closed", async () => {
    const harness = await clientHarness();
    await harness.client.connect();

    await harness.client.close();

    await expect(harness.client.call("status", {})).rejects.toMatchObject({ code: "stopped" });
  });
});

async function clientHarness(
  options: {
    readonly brokerDevelopment?: boolean;
    readonly development?: boolean;
    readonly launchFreshInstance?: boolean;
    readonly neverListens?: boolean;
    readonly peerUid?: number;
    readonly peerVerificationTimeoutMs?: number;
    readonly protocolVersion?: number;
    readonly requestTimeoutMs?: number;
    readonly signedIdentifier?: string;
    readonly startListening?: boolean;
    readonly verifyPeer?: (executable: string, socket: Socket) => Promise<void>;
  } = {},
) {
  const development = options.development ?? true;
  // Short enough for sun_path, whatever TMPDIR is.
  const directory = await mkdtemp("/tmp/osp-client-");
  const socketPath = path.join(directory, "ipc.sock");
  const lockPath = path.join(directory, "lifecycle.lock");
  const brokerAppPath = path.join(directory, passwordsBrokerAppName);
  const verifierAppPath = path.join(directory, "Opensteer.app", passwordsBrokerAppName);
  const broker = new FakePasswordsBroker({
    development: options.brokerDevelopment ?? development,
    ...(options.peerUid === undefined ? {} : { peerUid: options.peerUid }),
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
    socketPath,
  });
  if (options.startListening !== false) await broker.listen();
  const calls: string[][] = [];
  const verifiedWith: string[] = [];
  let lockHeldAtLaunch = false;
  const identifier =
    options.signedIdentifier ??
    (development ? "com.opensteer.passwords.dev" : "com.opensteer.passwords");
  const run: SignedHelperProcess = async (file, arguments_) => {
    calls.push([file, ...arguments_]);
    if (file === "/usr/bin/codesign") {
      const requirement = arguments_.find((argument) => argument.startsWith("-R="));
      if (requirement && !requirement.includes(`identifier "${identifier}"`)) {
        throw new Error("test-requirement: code failed to satisfy specified code requirement(s)");
      }
      return development
        ? `Identifier=${identifier}\nSignature=adhoc\nCDHash=abc123\n`
        : `Identifier=${identifier}\nAuthority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\nCDHash=abc123\n`;
    }
    if (file === "/usr/bin/open") {
      lockHeldAtLaunch = await withSignedHelperLifecycleLock(
        {
          deadline: { at: 0 },
          identity: { lockBusy: () => new Error("busy"), unsupportedPlatformMessage: "macOS" },
          lockPath,
        },
        async () => false,
      ).catch(() => true);
      if (!options.neverListens) await broker.listen();
      return "";
    }
    throw new Error(`unexpected command ${file}`);
  };
  const log = vi.fn();
  const client = new PasswordsBrokerClient({
    appVersion: "9.9.9",
    brokerAppPath,
    connectTimeoutMs: 3_000,
    development,
    ...(options.launchFreshInstance ? { launchFreshInstance: true } : {}),
    launchTimeoutMs: 300,
    lockPath,
    log,
    ...(options.peerVerificationTimeoutMs === undefined
      ? {}
      : { peerVerificationTimeoutMs: options.peerVerificationTimeoutMs }),
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
    run,
    socketPath,
    verifierAppPath,
    verifyPeer: async (executable, socket) => {
      verifiedWith.push(executable);
      await (options.verifyPeer ?? ((_: string, peer: Socket) => verifySameUserPeer(peer)))(
        executable,
        socket,
      );
    },
  });
  cleanups.push(async () => {
    await client.close();
    await broker.close();
    await rm(directory, { force: true, recursive: true });
  });
  return {
    broker,
    brokerAppPath,
    client,
    socketPath,
    commands: () => calls.map((call) => call.join(" ")).join("\n"),
    get lockHeldAtLaunch() {
      return lockHeldAtLaunch;
    },
    log,
    verifiedWith,
    verifierAppPath,
  };
}

// Exercise local ad-hoc broker journeys explicitly; packaged paths still pin the fixture team.
vi.mock("../signed-helpers/signing-build.js", () => ({
  signingTeamId: "ABCDE12345",
  developmentTrust: true,
}));
