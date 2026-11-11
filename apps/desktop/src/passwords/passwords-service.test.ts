import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createECDH, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { webContents } from "electron";
import { createId } from "@opensteer/core";
import { ComputerUseSessionIdSchema, type PasswordSignInAuthorityEvent } from "@opensteer/protocol";
import type { DesktopPasswordsStatus } from "@opensteer/protocol/desktop";
import { PasswordsBrokerSignInRequestParamsSchema } from "@opensteer/protocol/passwords-broker";
import type {
  PasswordsBrokerProtocolVersion,
  PasswordsBrokerStatus,
} from "@opensteer/protocol/passwords-broker";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { SignedHelperProcess } from "../signed-helpers/signed-helper.js";
import { passwordsBrokerAppName, passwordsBrokerSocketPath } from "./paths.js";
import { PasswordsService } from "./passwords-service.js";
import { HostSignIns } from "../../../../packages/browser-runtime-core/src/browser/host-sign-ins.js";
import { PasswordsLoginAuthority } from "./login-authority.js";
import { openLoginEnvelope } from "./login-envelope.js";
import { fakePasswordsLogin } from "./test-support/fake-broker-session.js";
import {
  FakePasswordsBroker,
  verifySameUserPeer,
  type FakeBrokerTranscriptEntry,
} from "./test-support/fake-broker-server.js";

vi.mock("electron", () => ({ webContents: { fromDevToolsTargetId: vi.fn() } }));

/**
 * End to end: the real install, launch, peer checks, framing and session
 * against a fake broker on a real Unix socket. Every scenario's frames are
 * written to one JSON artifact, so a run can be compared with the last.
 */
const artifactPath =
  process.env.OPENSTEER_PASSWORDS_E2E_ARTIFACT ??
  path.join(tmpdir(), "opensteer-passwords-broker-e2e.json");
const scenarios: { name: string; statuses: unknown[]; frames: unknown[] }[] = [];
const cleanups: (() => Promise<void>)[] = [];
const syntheticPassword = "synthetic-password-7c1a";
const transactionId = "6f1c2a4b-5d6e-4f80-9a1b-2c3d4e5f6071";
const requestParams = PasswordsBrokerSignInRequestParamsSchema.parse({
  deploymentId: "dep_personal",
  deploymentName: "Personal",
  workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
  expiresAt: "2026-10-11T17:00:00.000Z",
  reason: "Check the invoice",
  threadTitle: "Invoices",
  workspaceName: "Home",
  runtimeId: "desktop-browser",
  sessionId: "bsn_00000000-0000-4000-8000-000000000007",
  site: "https://example.com",
  transactionId,
});
const credential = {
  decision: "authorized",
  login: {
    hasTOTP: true,
    id: "8d1c2a4b-5d6e-4f80-9a1b-2c3d4e5f6071",
    revision: 3,
    account: "p•••@example.com",
  },
} as const;
const releaseParams = { transactionId, field: "password", origin: "https://example.com" } as const;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  if (scenarios.length === 0) return;
  await writeFile(
    artifactPath,
    `${JSON.stringify({ artifact: "opensteer-passwords-broker-e2e", scenarios }, null, 2)}\n`,
  );
});

describe("PasswordsService off the platforms the broker runs on", () => {
  it("reports unsupported off macOS and installs nothing", async () => {
    const run = vi.fn<SignedHelperProcess>(async () => "");
    const service = new PasswordsService({
      appVersion: "9.9.9",
      bundledBrokerPath: () => "/nowhere",
      development: true,
      platform: "linux",
      run,
    });

    await expect(service.status()).resolves.toEqual({
      availability: "unsupported",
      reason: "platform",
    });
    await expect(
      service.broker().probe({
        site: requestParams.site,
      }),
    ).resolves.toEqual({ passwords: "unavailable" });
    await expect(service.open()).rejects.toThrow("runs only on macOS");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports unsupported on a macOS older than the broker supports", async () => {
    const run = vi.fn<SignedHelperProcess>(async () => "");
    const service = new PasswordsService({
      appVersion: "9.9.9",
      bundledBrokerPath: () => "/nowhere",
      development: false,
      osRelease: () => "22.6.0",
      platform: "darwin",
      run,
    });

    await expect(service.status()).resolves.toEqual({ availability: "unsupported", reason: "os" });
    expect(run).not.toHaveBeenCalled();
  });
});

// Unix sockets, the lifecycle lock and peer credentials: the macOS job.
describe.runIf(process.platform === "darwin")("PasswordsService end to end", () => {
  it("keeps each legacy protocol on its own connection beneath a v8 service", async () => {
    const harness = await serviceHarness("multiple compatibility protocols", {
      clientProtocolVersion: 8,
    });
    harness.broker.reply("card.probe", () => ({ cards: "has-card" }));
    const login = harness.service.broker(6);
    const card = harness.service.broker(7);
    const legacy = harness.service.broker(4);
    await expect(login.probe({ site: "https://example.com" })).resolves.toEqual({
      passwords: "has-login",
    });
    await expect(card.cardProbe()).resolves.toEqual({ cards: "has-card" });
    await expect(legacy.probe({ site: "https://example.com" })).resolves.toEqual({
      passwords: "has-login",
    });
    expect([login.protocolVersion, card.protocolVersion, legacy.protocolVersion]).toEqual([
      6, 7, 4,
    ]);
    expect(harness.broker.received("hello").map((frame) => frame.params)).toEqual(
      [6, 7, 4].map((protocolVersion) => ({ client: { version: "9.9.9" }, protocolVersion })),
    );
    await harness.service.stop();
    await expect(card.probe({ site: "https://example.com" })).resolves.toEqual({
      passwords: "unavailable",
    });
    await expect(
      harness.service.broker(5).request(requestParams, new AbortController().signal),
    ).rejects.toMatchObject({ code: "stopped" });
    expect(harness.broker.received("hello")).toHaveLength(3);
  });

  it("exposes person calls at v8 and keeps person and agent lifetimes separate", async () => {
    const harness = await serviceHarness("person lifetime separation", {
      clientProtocolVersion: 8,
      status: { agentSignIns: "on", personFill: "on", vault: "ready" },
    });
    const session = harness.service.broker();
    const signal = new AbortController().signal;
    const account = {
      id: credential.login.id,
      revision: 3,
      username: "person@example.com",
      label: null,
      hasCode: true,
    };
    harness.broker.reply("fill.accounts", () => ({ fill: "on", accounts: [account] }));
    harness.broker.reply("fill.begin", () => ({
      decision: "authorized",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }));
    harness.broker.reply("signin.request", () => credential);
    harness.broker.reply("signin.release", () => ({ released: true, value: syntheticPassword }));
    await expect(session.fillAccounts?.({ origin: "https://example.com" })).resolves.toEqual({
      fill: "on",
      accounts: [account],
    });
    expect(session.protocolVersion).toBe(8);
    const person = await session.fillBegin!(
      {
        transactionId,
        loginId: account.id,
        revision: 3,
        origin: "https://example.com",
        presence: "elsewhere",
      },
      signal,
    );
    const { runtimeId: _runtime, sessionId: _session, ...request } = requestParams;
    const agent = await session.request(
      { ...request, protocolVersion: 6, permissionVersion: 5, transactionId: randomUUID() },
      signal,
    );
    harness.broker.setStatus({ agentSignIns: "off", personFill: "on", vault: "ready" });
    await vi.waitFor(() => expect(agent.lifetime.aborted).toBe(true));
    expect(person.lifetime.aborted).toBe(false);
    expect(harness.statuses.at(-1)).toMatchObject({ broker: { personFill: "on" } });
    await expect(
      session.release({
        transactionId,
        field: "password",
        kind: "browser",
        origin: "https://example.com",
      }),
    ).resolves.toEqual({ released: true, value: syntheticPassword });
    await expect(
      session.release({ transactionId, field: "password", kind: "app" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      session.approve(
        { transactionId, loginId: account.id, revision: 3, permissionVersion: 5, remember: true },
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(session.commit(transactionId, signal)).rejects.toMatchObject({ code: "invalid" });
    await expect(
      session.cardRelease({
        transactionId,
        field: "number",
        topOrigin: "https://example.com",
        frameOrigin: "https://example.com",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(harness.broker.received("signin.approve")).toEqual([]);
    expect(harness.broker.received("signin.commit")).toEqual([]);
    harness.broker.setStatus({ agentSignIns: "on", personFill: "on", vault: "ready" });
    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)).toMatchObject({ broker: { agentSignIns: "on" } }),
    );
    const nextAgent = await session.request(
      { ...request, protocolVersion: 6, permissionVersion: 5, transactionId: randomUUID() },
      signal,
    );
    harness.broker.setStatus({ agentSignIns: "on", personFill: "off", vault: "ready" });
    await vi.waitFor(() => expect(person.lifetime.aborted).toBe(true));
    expect(nextAgent.lifetime.aborted).toBe(false);
    harness.broker.setStatus({ agentSignIns: "off", personFill: "off", vault: "needs-reset" });
    await vi.waitFor(() => expect(nextAgent.lifetime.aborted).toBe(true));
    await session.cancel(transactionId);
    expect(harness.broker.received("signin.cancel")[0]?.params).toEqual({ transactionId });
    expect(harness.broker.received("hello")).toHaveLength(1);
  });

  it("ends person lifetimes when the vault becomes unsupported or its connection closes", async () => {
    const harness = await serviceHarness("person vault and connection", {
      clientProtocolVersion: 8,
      status: { agentSignIns: "on", personFill: "on", vault: "ready" },
    });
    const session = harness.service.broker();
    harness.broker.reply("fill.begin", () => ({
      decision: "authorized",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }));
    const start = async () =>
      await session.fillBegin!(
        {
          transactionId: randomUUID(),
          loginId: credential.login.id,
          revision: 3,
          origin: "https://example.com",
          presence: "elsewhere",
        },
        new AbortController().signal,
      );
    const first = await start();
    harness.broker.setStatus({ agentSignIns: "off", personFill: "off", vault: "unsupported" });
    await vi.waitFor(() => expect(first.lifetime.aborted).toBe(true));
    harness.broker.setStatus({ agentSignIns: "on", personFill: "on", vault: "ready" });
    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)).toMatchObject({ availability: "available" }),
    );
    const second = await start();
    harness.broker.dropConnections();
    await vi.waitFor(() => expect(second.lifetime.aborted).toBe(true));
    expect(harness.broker.received("signin.release")).toEqual([]);
  });

  it("omits person calls after v8 falls back to a fresh v7 connection", async () => {
    const harness = await serviceHarness("person compatibility", {
      clientProtocolVersion: 8,
      protocolVersion: 7,
    });
    const session = harness.service.broker();
    await harness.service.status();
    expect(session.protocolVersion).toBe(7);
    expect(session.fillAccounts).toBeUndefined();
    expect(session.fillBegin).toBeUndefined();
    expect(harness.broker.received("hello").map((frame) => frame.params)).toEqual([
      { client: { version: "9.9.9" }, protocolVersion: 8 },
      { client: { version: "9.9.9" }, protocolVersion: 7 },
    ]);
    expect(harness.broker.received("status")).toHaveLength(1);
  });

  it("withdraws an in-flight person begin when its own setting turns off", async () => {
    const harness = await serviceHarness("person pending toggle", {
      clientProtocolVersion: 8,
      status: { agentSignIns: "off", personFill: "on", vault: "ready" },
    });
    const session = harness.service.broker();
    await harness.service.status();
    const waiting = session.fillBegin!(
      {
        transactionId,
        loginId: credential.login.id,
        revision: 3,
        origin: "https://example.com",
        presence: "here",
      },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    await harness.broker.waitFor("fill.begin");
    harness.broker.setStatus({ agentSignIns: "off", personFill: "off", vault: "ready" });
    await expect(waiting).resolves.toMatchObject({ code: "aborted" });
    await harness.broker.waitFor("signin.cancel");
    expect(harness.broker.received("signin.cancel")[0]?.params).toEqual({ transactionId });
    expect(harness.broker.received("signin.release")).toEqual([]);
  });

  it("ends a held save with its own setting, never the agents' one", async () => {
    const ready = {
      agentSignIns: "on",
      personFill: "on",
      personSave: "on",
      vault: "ready",
    } as const;
    const harness = await serviceHarness("save lifetime", {
      clientProtocolVersion: 9,
      status: ready,
    });
    const session = harness.service.broker();
    await harness.service.status();
    harness.broker.reply("save.begin", () => ({
      decision: "offer",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }));
    const { lifetime } = await session.saveBegin!(
      {
        transactionId,
        origin: "https://example.com",
        username: "synthetic@example.com",
        password: "synthetic-password",
      },
      new AbortController().signal,
    );
    harness.broker.setStatus({ ...ready, agentSignIns: "off" });
    await harness.service.status();
    expect(lifetime.aborted, "agent sign-ins turning off keeps a save").toBe(false);
    harness.broker.setStatus({ ...ready, personSave: "off" });
    await harness.service.status();
    expect(lifetime.aborted, "saving turning off ends it").toBe(true);
  });

  it("binds card transactions to their kind and original v7 connection", async () => {
    const harness = await serviceHarness("card connection", { clientProtocolVersion: 7 });
    const broker = harness.service.broker();
    const signal = new AbortController().signal;
    harness.broker.reply("card.request", () => ({ decision: "approve", cards: [] }));
    const { runtimeId: _runtimeId, sessionId: _sessionId, ...request } = requestParams;
    const grant = await broker.cardRequest(
      { ...request, protocolVersion: 7, permissionVersion: 7 },
      signal,
    );
    expect(grant.decision).toEqual({ decision: "approve", cards: [] });
    await expect(
      broker.release({ transactionId, field: "password", kind: "app" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      broker.approve(
        {
          transactionId,
          loginId: transactionId,
          revision: 1,
          permissionVersion: 5,
          remember: false,
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(harness.broker.received("signin.release")).toEqual([]);
    expect(harness.broker.received("signin.approve")).toEqual([]);
    await harness.service.stop();
    expect(grant.lifetime.aborted).toBe(true);
    await expect(
      broker.cardRelease({
        transactionId,
        topOrigin: "https://example.com",
        frameOrigin: "https://payments.example.net",
        field: "number",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(harness.broker.received("card.release")).toEqual([]);
  });

  it("reports a broker this build does not ship as unavailable, with the build sentence", async () => {
    const harness = await serviceHarness("not built", { bundled: false });

    await expect(harness.service.status()).resolves.toEqual({
      availability: "unavailable",
      message:
        "Opensteer Passwords is not built; run pnpm --filter desktop build:passwords-broker.",
    });
    await expect(
      harness.service.broker().probe({
        site: requestParams.site,
      }),
    ).resolves.toEqual({ passwords: "unavailable" });
    expect(harness.commands()).not.toContain("/usr/bin/open");
  });

  it("installs, launches and verifies the broker, then reports its status", async () => {
    const harness = await serviceHarness("install and status");

    await expect(harness.service.status()).resolves.toEqual({
      availability: "available",
      broker: { agentSignIns: "on", vault: "ready" },
      development: true,
    });
    expect(harness.commands()).toContain("/usr/bin/ditto --noqtn");
    expect(harness.commands()).toContain("/usr/bin/open -g -a");
    expect(harness.broker.refusedPeers).toEqual([]);
    await expect(
      harness.service.broker().probe({
        site: requestParams.site,
      }),
    ).resolves.toEqual({ passwords: "has-login" });
    expect(harness.statuses).toHaveLength(1);
    harness.record();
  });

  it("preserves before-first-unlock unavailability without resetting the vault", async () => {
    const harness = await serviceHarness("before first unlock");
    const message = "Unlock this Mac to use Opensteer Passwords.";
    harness.broker.fail("status", { code: "unavailable", message });
    await expect(harness.service.status()).resolves.toEqual({
      availability: "unavailable",
      message,
    });
    harness.broker.fail("signin.request", { code: "unavailable", message });
    await expect(
      harness.service.broker().request(requestParams, new AbortController().signal),
    ).rejects.toMatchObject({ code: "unavailable", message });
    expect(harness.statuses).toEqual([{ availability: "unavailable", message }]);
    harness.record();
  });

  it("maps a Mac that cannot hold a vault to unsupported hardware", async () => {
    const harness = await serviceHarness("unsupported hardware", {
      status: { agentSignIns: "off", vault: "unsupported" },
    });

    await expect(harness.service.status()).resolves.toEqual({
      availability: "unsupported",
      reason: "hardware",
    });
    await expect(
      harness.service.broker().probe({
        site: requestParams.site,
      }),
    ).resolves.toEqual({ passwords: "unavailable" });
    harness.record();
  });

  it("pushes status changes, a dropped broker, and its return", async () => {
    const harness = await serviceHarness("status events");
    await harness.service.status();

    harness.broker.setStatus({ agentSignIns: "off", vault: "ready" });
    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)).toMatchObject({
        availability: "available",
        broker: { agentSignIns: "off" },
      }),
    );
    await expect(
      harness.service.broker().probe({
        site: requestParams.site,
      }),
    ).resolves.toEqual({ passwords: "off" });

    harness.broker.dropConnections();
    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)).toMatchObject({ availability: "unavailable" }),
    );

    await expect(harness.service.status()).resolves.toMatchObject({ availability: "available" });
    expect(harness.broker.received("hello")).toHaveLength(2);
    harness.record();
  });

  it("authorizes, releases a field and cancels on one connection", async () => {
    const harness = await serviceHarness("credential sign-in");
    const session = harness.service.broker();
    const controller = new AbortController();

    const decision = session.request(requestParams, controller.signal);
    await harness.broker.waitFor("signin.request");
    harness.broker.answer("signin.request", credential);
    const grant = await decision;
    expect(grant.decision).toEqual(credential);
    expect(grant.lifetime.aborted).toBe(false);

    harness.broker.reply("signin.release", () => ({ released: true, value: syntheticPassword }));
    const released = session.release(releaseParams);
    await harness.broker.waitFor("signin.release");
    await expect(released).resolves.toEqual({ released: true, value: syntheticPassword });
    expect(harness.broker.received("signin.release")).toEqual([
      expect.objectContaining({ params: releaseParams }),
    ]);
    await session.cancel(transactionId);
    expect(harness.broker.received("signin.cancel")).toEqual([
      expect.objectContaining({ params: { transactionId } }),
    ]);
    await expect(session.release(releaseParams)).rejects.toMatchObject({ code: "invalid" });
    await expect(session.cancel(transactionId)).resolves.toBeUndefined();
    expect(harness.broker.received("hello")).toHaveLength(1);
    expect(JSON.stringify(harness.log.mock.calls)).not.toContain(syntheticPassword);
    harness.record();
  });

  it("approves a listed revision and preserves the transaction after cancelled authentication", async () => {
    const harness = await serviceHarness("approval cancelled then allowed");
    const session = harness.service.broker();
    const signal = new AbortController().signal;
    const decision = session.request(requestParams, signal);
    await harness.broker.waitFor("signin.request");
    harness.broker.answer("signin.request", {
      decision: "approve",
      accounts: [
        {
          id: credential.login.id,
          revision: 3,
          username: "person@example.com",
          label: null,
          host: "example.com",
          onPage: false,
          updatedAt: "2026-10-13T00:00:00.000Z",
        },
      ],
    });
    await decision;
    const params = {
      transactionId,
      loginId: credential.login.id,
      revision: 3,
      remember: true,
      permissionVersion: 5 as const,
    };
    harness.broker.fail("signin.approve", {
      code: "invalid",
      message: "Authentication was cancelled.",
    });
    const cancelled = session.approve(params, signal).catch((error: unknown) => error);
    await harness.broker.waitFor("signin.approve");
    await expect(cancelled).resolves.toMatchObject({ code: "invalid" });
    harness.broker.clearFailure("signin.approve");
    const approved = session.approve(params, signal);
    await vi.waitFor(() => expect(harness.broker.received("signin.approve")).toHaveLength(2));
    harness.broker.answer("signin.approve", credential);
    await expect(approved).resolves.toEqual(credential);
    await session.cancel(transactionId);
    expect(harness.broker.received("signin.cancel")[0]).toMatchObject({
      params: { transactionId },
    });
    harness.record();
  });

  it("withdraws a sign-in the caller aborts while the person is deciding", async () => {
    const harness = await serviceHarness("aborted sign-in");
    const session = harness.service.broker();
    const controller = new AbortController();

    const decision = session.request(requestParams, controller.signal).catch((error) => error);
    await harness.broker.waitFor("signin.request");
    controller.abort();

    await expect(decision).resolves.toMatchObject({ code: "aborted" });
    await harness.broker.waitFor("signin.cancel");
    expect(harness.broker.received("signin.cancel")).toEqual([
      expect.objectContaining({ params: { transactionId } }),
    ]);
    // The abort already ended it, so cancel does not send again.
    await expect(session.cancel(transactionId)).resolves.toBeUndefined();
    expect(harness.broker.received("signin.cancel")).toHaveLength(1);
    harness.record();
  });

  it("ends a sign-in whose connection drops, and reconnects for the next one", async () => {
    const harness = await serviceHarness("connection drop");
    const session = harness.service.broker();

    const decision = session
      .request(requestParams, new AbortController().signal)
      .catch((error) => error);
    await harness.broker.waitFor("signin.request");
    harness.broker.dropConnections();

    await expect(decision).resolves.toMatchObject({ code: "connection-lost" });
    await expect(session.release(releaseParams)).rejects.toMatchObject({ code: "connection-lost" });
    await expect(session.cancel(transactionId)).resolves.toBeUndefined();
    const installsBefore = harness
      .commands()
      .split("\n")
      .filter((line) => line.includes("plutil"));
    await expect(
      session.probe({
        site: requestParams.site,
      }),
    ).resolves.toEqual({ passwords: "has-login" });
    expect(harness.broker.received("hello")).toHaveLength(2);
    expect(harness.broker.received("signin.release")).toEqual([]);
    // The reconnect installed again first, so the installed copy's version was
    // read as well as its signature: an older genuine broker is not kept.
    expect(
      harness
        .commands()
        .split("\n")
        .filter((line) => line.includes("plutil")).length,
    ).toBeGreaterThan(installsBefore.length);
    harness.record();
  });

  // Failure this pins: the broker connection drops after the person approved,
  // while no further broker call is made, and the authority never hears
  // that the approval stopped holding.
  it("ends an approved sign-in's lifetime when its connection drops", async () => {
    const harness = await serviceHarness("connection drop after approval");
    const session = harness.service.broker();

    const decision = session.request(requestParams, new AbortController().signal);
    await harness.broker.waitFor("signin.request");
    harness.broker.answer("signin.request", credential);
    const grant = await decision;
    expect(grant.lifetime.aborted).toBe(false);
    harness.broker.dropConnections();

    await vi.waitFor(() => expect(grant.lifetime.aborted).toBe(true));
    await expect(session.release(releaseParams)).rejects.toMatchObject({ code: "connection-lost" });
    await expect(session.cancel(transactionId)).resolves.toBeUndefined();
    expect(harness.broker.received("signin.release")).toEqual([]);
    harness.record();
  });

  it("opens the broker's window", async () => {
    const harness = await serviceHarness("window and cancel all");

    await harness.service.open();
    expect(harness.broker.received("window.open")).toEqual([
      expect.objectContaining({ params: {} }),
    ]);
    expect(harness.broker.received("signin.cancelAll")).toHaveLength(0);
    harness.record();
  });

  it("refuses a development broker on a release desktop, and checks the install again next time", async () => {
    const harness = await serviceHarness("wrong build", {
      brokerDevelopment: true,
      development: false,
    });

    await expect(harness.service.status()).resolves.toMatchObject({
      availability: "unavailable",
      message: expect.stringMatching(/development Opensteer Passwords/u),
    });
    expect(harness.broker.received("status")).toEqual([]);
    const checks = harness.commands().match(/\/usr\/bin\/plutil/gu)?.length ?? 0;

    await expect(harness.service.status()).resolves.toMatchObject({
      availability: "unavailable",
      message: expect.stringMatching(/development Opensteer Passwords/u),
    });
    // The refused client was forgotten: the install was checked again, the
    // valid copy kept, and a new connection refused for the same reason.
    expect(harness.commands().match(/\/usr\/bin\/plutil/gu)?.length ?? 0).toBeGreaterThan(checks);
    expect(harness.commands().match(/\/usr\/bin\/ditto/gu)).toHaveLength(1);
    expect(harness.broker.received("hello")).toHaveLength(2);
    expect(harness.broker.received("status")).toEqual([]);
    harness.record();
  });

  it("refuses a broker of another protocol version", async () => {
    const harness = await serviceHarness("protocol mismatch", { protocolVersion: 99 });

    await expect(harness.service.status()).resolves.toMatchObject({
      availability: "unavailable",
      message: expect.stringMatching(/another version/u),
    });
    harness.record();
  });

  it("launches nothing once stopped", async () => {
    const harness = await serviceHarness("stopped");
    await harness.service.stop();

    await expect(harness.service.status()).resolves.toMatchObject({
      availability: "unavailable",
    });
    await expect(
      harness.service.broker().request(requestParams, new AbortController().signal),
    ).rejects.toMatchObject({ code: "stopped" });
    expect(harness.commands()).toBe("");
  });
});

describe.runIf(process.platform === "darwin")("Workspace login release across surfaces", () => {
  it.each(["detach", "close"] as const)(
    "%s during a browser release discards only that fill and keeps app and browser reuse alive",
    async (ending) => {
      const harness = await serviceHarness(`Workspace release after browser ${ending}`, {
        clientProtocolVersion: 5,
      });
      const authority = new PasswordsLoginAuthority({
        broker: harness.service.broker(),
        ownOrigins: () => [],
      });
      cleanups.push(async () => {
        await authority.close();
        // Drain the broker cancellation triggered by login.ended before stopping its connection.
        await harness.service.status();
      });
      const operationId = randomUUID();
      const loginRef = `lgn_${"b".repeat(32)}`;
      const events: PasswordSignInAuthorityEvent[] = [];
      const emit = (event: PasswordSignInAuthorityEvent) => {
        events.push(event);
      };
      // The Host probes with its own command before it authorizes.
      expect(
        await authority.control({ type: "signin.probe", site: "https://example.com" }, emit),
      ).toEqual({ type: "signin.probe.result", passwords: "has-login" });
      await authority.control(
        {
          type: "login.authorize",
          operationId,
          loginRef,
          workspaceId: createId("workspace"),
          site: "https://example.com",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          requester: {
            deploymentId: "personal",
            deploymentName: "Personal",
            workspaceName: "Main",
            threadTitle: "Login",
            reason: "Sign in",
          },
        },
        emit,
      );
      await harness.broker.waitFor("signin.request");
      harness.broker.answer("signin.request", {
        decision: "authorized",
        login: {
          id: fakePasswordsLogin.id,
          revision: fakePasswordsLogin.revision,
          account: fakePasswordsLogin.account,
          hasTOTP: true,
        },
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "login.result",
            outcome: expect.objectContaining({ kind: "authorized", loginRef }),
          }),
        ),
      );
      let writes = 0;
      const frame = {
        origin: "https://example.com",
        detached: false,
        executeJavaScript: vi.fn(async (source: string) => {
          if (source.includes('return "filled";')) {
            writes += 1;
            return "filled";
          }
          return "ready";
        }),
      };
      vi.mocked(webContents.fromDevToolsTargetId).mockReturnValue({
        isDestroyed: () => false,
        focusedFrame: frame,
      } as unknown as Electron.WebContents);
      const browser = new HostSignIns({ authority, runtimeId: "first-runtime" });
      const resume = harness.broker.holdNextRelease();
      try {
        const fill = browser.fill({
          loginRef,
          sessionId: "first-session",
          targetId: "page",
          field: "password",
        });
        await harness.broker.waitFor("signin.release");
        if (ending === "detach") browser.sessionDetached("first-session");
        else browser.close();
        resume();
        expect(await fill).toBe("expired");
        expect(writes).toBe(0);
        const key = createECDH("prime256v1");
        key.generateKeys();
        const receiver = {
          version: 1,
          connectionId: randomUUID(),
          connectionGeneration: 1,
          publicKey: key.getPublicKey().toString("base64url"),
        } as const;
        const binding = {
          version: 1,
          connectionId: receiver.connectionId,
          connectionGeneration: 1,
          runId: createId("run"),
          sessionId: ComputerUseSessionIdSchema.parse(`cus_${randomUUID()}`),
          actId: randomUUID(),
          actionIndex: 0,
          field: "password",
          expiresAt: Date.now() + 30_000,
        } as const;
        const sealed = await authority.control(
          { type: "login.seal", operationId, receiver, binding },
          emit,
        );
        expect(sealed).toMatchObject({ type: "login.seal.result", status: "sealed" });
        if (sealed.type !== "login.seal.result" || sealed.status !== "sealed")
          throw new Error("Expected sealed app release");
        expect(
          openLoginEnvelope({
            envelope: sealed.envelope,
            receiver,
            privateKey: Buffer.from(key.getPrivateKey().toString("hex").padStart(64, "0"), "hex"),
            expectedBinding: binding,
            now: Date.now(),
            consumed: new Map(),
          }) === fakePasswordsLogin.password,
        ).toBe(true);
        const next = new HostSignIns({ authority, runtimeId: "next-runtime" });
        try {
          expect(
            await next.fill({
              loginRef,
              sessionId: "next-session",
              targetId: "next-page",
              field: "username",
            }),
          ).toBe("filled");
          expect(writes).toBe(1);
        } finally {
          next.close();
        }
        expect(harness.broker.received("signin.cancel")).toEqual([]);
        expect(events.filter((event) => event.type === "login.ended")).toEqual([]);
      } finally {
        resume();
        browser.close();
        harness.record();
      }
    },
  );
});

async function serviceHarness(
  name: string,
  options: {
    readonly brokerDevelopment?: boolean;
    readonly bundled?: boolean;
    readonly development?: boolean;
    readonly protocolVersion?: number;
    readonly clientProtocolVersion?: PasswordsBrokerProtocolVersion;
    readonly status?: PasswordsBrokerStatus;
  } = {},
) {
  const development = options.development ?? true;
  // A short home keeps the socket path inside sun_path.
  const home = await mkdtemp("/tmp/osp-svc-");
  const bundledAppPath = path.join(home, "bundled", passwordsBrokerAppName);
  if (options.bundled !== false) {
    const plist = path.join(bundledAppPath, "Contents", "Info.plist");
    await mkdir(path.dirname(plist), { recursive: true });
    await writeFile(plist, JSON.stringify({ CFBundleVersion: "1" }));
  }
  const broker = new FakePasswordsBroker({
    development: options.brokerDevelopment ?? development,
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
    socketPath: passwordsBrokerSocketPath(development, home),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
  const identifier = development ? "com.opensteer.passwords.dev" : "com.opensteer.passwords";
  const calls: string[][] = [];
  const run: SignedHelperProcess = async (file, arguments_) => {
    calls.push([file, ...arguments_]);
    if (file === "/usr/bin/plutil") {
      // The fixture's plist is already JSON, and moves wherever ditto and rename put it.
      return await readFile(arguments_.at(-1) ?? "", "utf8");
    }
    if (file === "/usr/bin/ditto") {
      const [, from, to] = arguments_;
      if (!from || !to) throw new Error("ditto needs a source and a target");
      await cp(from, to, { recursive: true });
      return "";
    }
    if (arguments_.length === 1 && arguments_[0] === "--prepare-replacement") return "";
    if (file === "/usr/bin/codesign") {
      if (arguments_[0] !== "-dv") return "";
      return development
        ? `Identifier=${identifier}\nSignature=adhoc\nCDHash=abc123\n`
        : `Identifier=${identifier}\nAuthority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\nCDHash=abc123\n`;
    }
    if (file === "/usr/bin/open") {
      // A new instance binds the socket path again, as the broker does on start.
      if (arguments_.includes("-n") || !broker.listening) await broker.listen();
      return "";
    }
    throw new Error(`unexpected command ${file}`);
  };
  const log = vi.fn();
  const service = new PasswordsService({
    appVersion: "9.9.9",
    protocolVersion: options.clientProtocolVersion ?? 4,
    bundledBrokerPath: () => bundledAppPath,
    client: {
      connectTimeoutMs: 3_000,
      launchTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      // The development `--verify-peer`: the kernel says the server is this user.
      verifyPeer: async (_executable, socket) => await verifySameUserPeer(socket),
    },
    development,
    homeDirectory: home,
    log,
    osRelease: () => "25.0.0",
    platform: "darwin",
    run,
  });
  const statuses: DesktopPasswordsStatus[] = [];
  service.onStatusChanged((status) => statuses.push(status));
  cleanups.push(async () => {
    await service.stop();
    await broker.close();
    await rm(home, { force: true, recursive: true });
  });
  return {
    broker,
    commands: () => calls.map((call) => call.join(" ")).join("\n"),
    log,
    /** Adds this scenario's frames to the run's artifact. */
    record: () => {
      scenarios.push({
        // Synthetic as it is, a password is not written to disk.
        frames: broker.transcript.map((entry: FakeBrokerTranscriptEntry) => ({
          connection: entry.connection,
          direction: entry.direction,
          frame: JSON.parse(
            JSON.stringify(entry.frame).replaceAll(syntheticPassword, "<redacted>"),
          ) as unknown,
        })),
        name,
        statuses: [...statuses],
      });
    },
    service,
    statuses,
  };
}

// Exercise local ad-hoc broker journeys explicitly; packaged paths still pin the fixture team.
vi.mock("../signed-helpers/signing-build.js", () => ({
  signingTeamId: "ABCDE12345",
  developmentTrust: true,
}));
