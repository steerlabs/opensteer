import { DesktopBrowserProfileErasure } from "./browser-profile-erasure.js";
import { desktopDeploymentPaths } from "../app/application-paths.js";
import {
  verifyDeviceLeaveSignature,
  verifyDeviceSessionBindingSignature,
} from "@opensteer/runner-auth";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { readMemberships, writeMemberships } from "./device-membership.js";
import type { DeploymentConnectionSource } from "@opensteer/client/connections";
import { generateKeyPairSync } from "node:crypto";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
} from "@opensteer/client/test-support";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createId,
  RunnerIdSchema,
  DeploymentIdSchema,
  harnessCatalog,
  harnessExecutableEnvironmentVariable,
  shipsHarnessRuntimeBytes,
  shippedHarnessKindRecord,
  shippedHarnessKinds,
  type AuthSessionId,
  type DeploymentId,
  type EnvironmentId,
  type RunnerId,
} from "@opensteer/core";
import type { HostApiClient, HostApiCommandInput } from "@opensteer/protocol";
import type { DesktopConfiguration } from "../config.js";
import {
  LocalRunnerDeploymentUnavailableError,
  type DesktopLocalRunnerTarget,
  type DesktopLocalRunnerTargetAuthority,
} from "./local-runner-authority.js";
import {
  LocalRunnerService,
  type LocalRunnerServiceDependencies,
  type UtilityProcessLike,
} from "./local-runner-service.js";
import { RunnerWorkerSecretsMessageSchema } from "./runner-worker-secrets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalRunnerService", () => {
  it("cleans up a prepared Account setup locally when issuance never began, including after restart", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://never-issued.opensteer.test");
    targets.source(target.deploymentId, {
      kind: "account",
      issuer: "https://accounts.opensteer.test",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    });
    const refusal = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "Device leave refused" }, { status: 403 }),
    );
    const first = fixture(config, targets, undefined, undefined, { leaveFetch: refusal });
    const input = {
      deploymentId: target.deploymentId,
      runnerName: "Prepared Mac",
      runAgents: false,
    };
    const original = await first.service.prepareDeviceSetup(input);
    await first.service.shutdown();
    first.service.dispose();
    const restarted = fixture(config, targets, undefined, undefined, { leaveFetch: refusal });
    try {
      await restarted.service.leaveAccountMemberships();
      expect(refusal).not.toHaveBeenCalled();
      expect((await restarted.service.status(target.deploymentId)).membership).toMatchObject({
        state: "removed",
        leaveUnconfirmed: false,
      });
      await restarted.service.setUpDevice(input);
      const next = await restarted.service.prepareDeviceSetup(input);
      expect(next.runnerId).not.toBe(original.runnerId);
    } finally {
      await restarted.service.shutdown();
      restarted.service.dispose();
    }
  });

  it("keeps confirmation retryable and leaveable after runner retries are exhausted and after restart", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://offline-home.opensteer.test");
    const delivered = vi.fn<typeof fetch>(async () => Response.json({ outcome: "removed" }));
    const running = fixture(config, targets, () => 0, undefined, { leaveFetch: delivered });
    const starting = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const first = childAt(running.children, 0);
    connect(first);
    const original = (await starting).runner.runnerId;
    const ending = running.service.sessionLost(target.deploymentId);
    await eventually(() => hasStopMessage(first));
    first.emit("exit", 0);
    await ending;
    for (let attempt = 0; attempt < 6; attempt++) {
      await eventually(() => running.children.length === attempt + 2);
      childAt(running.children, attempt + 1).emit("message", {
        type: "runner.worker.failed",
        message: "Home is offline: runner route is unavailable.",
      });
    }
    await eventually(async () =>
      (await running.service.status(target.deploymentId)).runner.detail.includes(
        "restarted 5 times",
      ),
    );
    expect((await running.service.status(target.deploymentId)).membership).toMatchObject({
      state: "active",
      runnerId: original,
      sessionState: "confirming",
    });
    await expect(running.service.assertSessionAllowed(target.deploymentId)).rejects.toThrow(
      "confirm",
    );
    await running.service.retryDeviceConnection({ deploymentId: target.deploymentId });
    await eventually(() => running.children.length === 8);
    childAt(running.children, 7).emit("message", {
      type: "runner.worker.failed",
      message: "Runner route is still unavailable.",
    });
    await running.service.shutdown();
    running.service.dispose();
    const restarted = fixture(config, targets, () => 60_000, undefined, { leaveFetch: delivered });
    const resuming = restarted.service.startIfEnabled();
    await eventually(() => restarted.children.length === 1);
    childAt(restarted.children, 0).emit("message", {
      type: "runner.worker.failed",
      message: "Home is still offline.",
    });
    await resuming;
    expect((await restarted.service.status(target.deploymentId)).runner.detail).toContain(
      "Home is still offline",
    );
    await expect(restarted.service.assertSessionAllowed(target.deploymentId)).rejects.toThrow(
      "confirm",
    );
    await restarted.service.leaveDeployment({ deploymentId: target.deploymentId });
    expect(delivered).toHaveBeenCalledOnce();
    expect((await restarted.service.status(target.deploymentId)).membership).toMatchObject({
      state: "removed",
      leaveUnconfirmed: false,
    });
    await restarted.service.shutdown();
    restarted.service.dispose();
  });

  it("confirms membership independently of a browser helper that cannot start", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://helper-failure.opensteer.test");
    const identityDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
    await mkdir(identityDirectory, { recursive: true });
    writeTestIdentity(identityDirectory, true);
    const browser = vi.fn<NonNullable<LocalRunnerServiceDependencies["browser"]>>(async () => {
      throw new Error("Browser helper startup failed");
    });
    const running = fixture(config, targets, () => 60_000, browser);
    await running.service.startIfEnabled();
    expect((await running.service.status(target.deploymentId)).runner.detail).toBe(
      "Browser helper startup failed",
    );
    await running.service.sessionLost(target.deploymentId);
    await eventually(() => running.children.length === 1);
    connect(childAt(running.children, 0));
    await eventually(
      async () =>
        (await running.service.status(target.deploymentId)).membership?.sessionState ===
        "sign-in-again",
    );
    expect(browser).toHaveBeenCalledOnce();
    await expect(running.service.assertSessionAllowed(target.deploymentId)).rejects.toThrow(
      "Sign in again",
    );
    const stopping = running.service.shutdown();
    running.children.forEach((child) => child.kill());
    await stopping;
    running.service.dispose();
  });

  it("uses authenticated legacy removal before discarding the session and can rejoin after Account sign-out", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://legacy.opensteer.test");
    targets.restore({
      ...target,
      devicesAvailable: false,
      source: {
        kind: "account",
        issuer: "https://accounts.opensteer.test",
        subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
      },
    });
    let sessionExists = true;
    const revoke = vi.fn(async () => {
      if (!sessionExists) throw new Error("Host requires authentication");
    });
    const leaveFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const running = fixture(config, targets, undefined, undefined, {
      leaveFetch,
      revokeLegacyRunner: revoke,
      clearDeploymentSession: async () => {
        sessionExists = false;
      },
    });
    const joining = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    const original = (await joining).runner.runnerId;
    const leaving = running.service.leaveAccountMemberships();
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await leaving;
    expect(revoke).toHaveBeenCalledWith(target.deploymentId, target.hostUrl, original);
    expect(leaveFetch).not.toHaveBeenCalled();
    expect((await running.service.status(target.deploymentId)).membership).toMatchObject({
      state: "removed",
      leaveUnconfirmed: false,
    });
    sessionExists = true;
    await running.service.setUpDevice({
      deploymentId: target.deploymentId,
      runnerName: "Mac",
      runAgents: false,
    });
    const joiningAgain = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 2);
    connect(childAt(running.children, 1));
    expect((await joiningAgain).runner.runnerId).not.toBe(original);
    const stopped = running.service.shutdown();
    running.children.forEach((child) => child.kill());
    await stopped;
    running.service.dispose();
  });

  it("retains unresolved legacy removal across restart, then finishes it after sign-in without blocking rejoin", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const initial = targets.add("https://legacy-offline.opensteer.test");
    const target = { ...initial, devicesAvailable: false };
    targets.restore(target);
    let signedIn = false;
    const removed: string[] = [];
    const revokeLegacyRunner = vi.fn(async (_id: string, _origin: string, runnerId: string) => {
      if (!signedIn) throw new Error("No authenticated session");
      removed.push(runnerId);
    });
    const first = fixture(config, targets, undefined, undefined, { revokeLegacyRunner });
    const starting = first.service.start(startInput(target.deploymentId));
    await eventually(() => first.children.length === 1);
    const child = childAt(first.children, 0);
    connect(child);
    const oldId = (await starting).runner.runnerId!;
    const leaving = first.service.leaveDeployment({ deploymentId: target.deploymentId });
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await leaving;
    expect((await first.service.status(target.deploymentId)).membership).toMatchObject({
      state: "removed",
      leaveUnconfirmed: true,
    });
    await first.service.shutdown();
    first.service.dispose();
    const restarted = fixture(config, targets, undefined, undefined, { revokeLegacyRunner });
    await restarted.service.startIfEnabled();
    expect((await restarted.service.status(target.deploymentId)).membership?.leaveUnconfirmed).toBe(
      true,
    );
    expect((await restarted.service.status(target.deploymentId)).runner.detail).toContain(
      "older Host",
    );
    await restarted.service.setUpDevice({
      deploymentId: target.deploymentId,
      runnerName: "Mac",
      runAgents: false,
    });
    expect((await restarted.service.status(target.deploymentId)).membership?.leaveUnconfirmed).toBe(
      true,
    );
    signedIn = true;
    const rejoining = restarted.service.start(startInput(target.deploymentId));
    await eventually(() => restarted.children.length === 1);
    connect(childAt(restarted.children, 0));
    expect((await rejoining).membership).toMatchObject({
      state: "active",
      leaveUnconfirmed: false,
    });
    expect(removed).toEqual([oldId]);
    const stopping = restarted.service.shutdown();
    restarted.children.forEach((child) => child.kill());
    await stopping;
    restarted.service.dispose();
  });

  it.each(["retired", "consumed"] as const)(
    "reconciles legacy pending setup before discarding the session when retirement reports %s",
    async (state) => {
      const directory = await temporaryDirectory();
      const config = await configuration(directory);
      const targets = mutableTargetAuthority();
      const target = targets.add("https://legacy-pending.opensteer.test");
      targets.restore({ ...target, devicesAvailable: false });
      let sessionExists = true;
      const retireEnrollment = vi.fn(async () => {
        expect(sessionExists).toBe(true);
        return state;
      });
      const revokeLegacyRunner = vi.fn(async () => {
        expect(sessionExists).toBe(true);
      });
      const running = fixture(config, targets, undefined, undefined, {
        retireEnrollment,
        revokeLegacyRunner,
        clearDeploymentSession: async () => {
          sessionExists = false;
        },
      });
      const receipt = {
        type: "runner.enrollment.createLocal" as const,
        enrollmentId: "legacy-pending",
        token: "l".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      await running.service.observeHostCommand(
        target.deploymentId,
        { type: receipt.type, name: "Mac", allowedModules: ["shell"], idempotencyKey: "pending" },
        receipt,
      );
      const starting = running.service
        .start({ ...startInput(target.deploymentId), enrollmentToken: receipt.token })
        .catch((error: unknown) => error);
      await eventually(() => running.children.length === 1);
      const child = childAt(running.children, 0);
      const id = readTestIdentity(child.dataDirectory)!.runnerId;
      const leaving = running.service.leaveDeployment({ deploymentId: target.deploymentId });
      await eventually(() => hasStopMessage(child));
      child.emit("exit", 0);
      expect(await starting).toBeInstanceOf(Error);
      await leaving;
      expect(retireEnrollment).toHaveBeenCalledWith(
        target.deploymentId,
        target.hostUrl,
        receipt.enrollmentId,
      );
      expect(revokeLegacyRunner).toHaveBeenCalledTimes(state === "consumed" ? 1 : 0);
      if (state === "consumed")
        expect(revokeLegacyRunner).toHaveBeenCalledWith(target.deploymentId, target.hostUrl, id);
      expect((await running.service.status(target.deploymentId)).membership).toMatchObject({
        state: "removed",
        leaveUnconfirmed: false,
      });
      await running.service.shutdown();
      running.service.dispose();
    },
  );

  it("migrates a v4 membership beside an empty catalog, waits, and resumes the same key", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://waiting.opensteer.test");
    const config = await configuration(directory);
    const identityDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
    await mkdir(identityDirectory, { recursive: true });
    writeTestIdentity(identityDirectory, true);
    const identity = readTestIdentity(identityDirectory)!;
    await writeFile(
      path.join(directory, "runner", "desktop-runner.json"),
      JSON.stringify({
        version: 4,
        runners: {
          [target.deploymentId]: { enrolled: true, runAgents: false, runnerName: "Saved Mac" },
        },
      }),
      { mode: 0o600 },
    );
    targets.remove(target.deploymentId);
    const running = fixture(config, targets);
    await running.service.startIfEnabled();
    expect(running.fork).not.toHaveBeenCalled();
    expect(
      (await readMemberships(path.join(directory, "runner", "desktop-runner.json"))).runners[
        target.deploymentId
      ]?.state,
    ).toBe("active");
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      membership: { state: "waiting" },
      runner: { enrolled: true, runnerId: identity.runnerId },
    });
    targets.restore(target);
    await eventually(() => running.children.length === 1);
    connect(childAt(running.children, 0));
    await eventually(
      async () => (await running.service.status(target.deploymentId)).runner.state === "running",
    );
    expect(readTestIdentity(identityDirectory)?.runnerId).toBe(identity.runnerId);
  });

  it.each(["unknown", "corrupt"])(
    "fails closed on %s membership storage instead of healing its identity",
    async (kind) => {
      const directory = await temporaryDirectory();
      const targets = mutableTargetAuthority();
      const target = targets.add("https://corrupt.opensteer.test");
      const config = await configuration(directory);
      const identityDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
      await mkdir(identityDirectory, { recursive: true });
      writeTestIdentity(identityDirectory, true);
      const contents = kind === "unknown" ? '{"version":99,"runners":{}}' : "{broken";
      const file = path.join(directory, "runner", "desktop-runner.json");
      await writeFile(file, contents, { mode: 0o600 });
      const running = fixture(config, targets);
      await expect(running.service.startIfEnabled()).rejects.toThrow("incompatible or corrupt");
      expect(running.fork).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(contents);
    },
  );

  it.each(["connected", "revoked"])(
    "heals an enrolled identity with an empty preference: %s",
    async (outcome) => {
      const directory = await temporaryDirectory();
      const targets = mutableTargetAuthority();
      const target = targets.add("https://heal.opensteer.test");
      const config = await configuration(directory);
      const identityDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
      await mkdir(identityDirectory, { recursive: true });
      writeTestIdentity(identityDirectory, true);
      const identity = readTestIdentity(identityDirectory)!;
      await writeFile(
        path.join(directory, "runner", "desktop-runner.json"),
        '{"version":4,"runners":{}}',
        { mode: 0o600 },
      );
      const running = fixture(config, targets);
      const restoring = running.service.startIfEnabled();
      await eventually(() => running.children.length === 1);
      const child = childAt(running.children, 0);
      expect(postedSecrets(child).OPENSTEER_RUNNER_ENROLLMENT_TOKEN).toBeUndefined();
      if (outcome === "connected") connect(child);
      else {
        child.emit("message", { type: "runner.worker.revoked" });
        await eventually(() => hasStopMessage(child));
        child.emit("exit", 0);
      }
      await restoring;
      await eventually(
        async () =>
          (await running.service.status(target.deploymentId)).membership?.state ===
          (outcome === "connected" ? "active" : "removed"),
      );
      if (outcome === "connected")
        expect(readTestIdentity(identityDirectory)?.runnerId).toBe(identity.runnerId);
      else {
        await eventually(() => !existsSync(identityPath(identityDirectory)));
        await running.service.reconcile();
        expect(running.fork).toHaveBeenCalledOnce();
        await expect(running.service.start(startInput(target.deploymentId))).rejects.toThrow(
          "Set up again",
        );
      }
    },
  );

  it("persists signed leave before erasure, resumes both obligations after a crash, and confirms once without runtimes", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://leave.opensteer.test");
    const config = await configuration(directory);
    const erasure = new DesktopBrowserProfileErasure(directory);
    const failedErase = vi
      .spyOn(erasure, "erase")
      .mockRejectedValueOnce(new Error("Simulated crash before erasure"));
    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    const running = fixture(config, targets, undefined, undefined, {
      profileErasure: erasure,
      leaveFetch: offline,
    });
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;
    const publicKey = JSON.parse(await readFile(identityPath(child.dataDirectory), "utf8"))
      .publicKeyPem as string;
    const leaving = running.service.leaveDeployment({ deploymentId: target.deploymentId });
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await expect(leaving).rejects.toThrow("Simulated crash");
    const file = path.join(directory, "runner", "desktop-runner.json");
    const record = (await readMemberships(file)).runners[target.deploymentId]!;
    expect(record).toMatchObject({ state: "leaving", erasePending: true });
    expect(verifyDeviceLeaveSignature(publicKey, record.leaveProof!)).toBe(true);
    expect(failedErase).toHaveBeenCalledOnce();
    expect(existsSync(identityPath(child.dataDirectory))).toBe(true);
    await running.service.shutdown();
    running.service.dispose();
    targets.remove(target.deploymentId);
    const delivered = vi.fn<typeof fetch>(async () => Response.json({ outcome: "removed" }));
    const browser = vi.fn<NonNullable<LocalRunnerServiceDependencies["browser"]>>();
    const computerUse = fakeComputerUse();
    const restarted = fixture(config, targets, undefined, browser, {
      leaveFetch: delivered,
      computerUse,
    });
    await restarted.service.startIfEnabled();
    expect(restarted.fork).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
    expect(computerUse.startForSlot).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledOnce();
    expect(JSON.parse(String(delivered.mock.calls[0]?.[1]?.body))).toEqual(record.leaveProof);
    expect(existsSync(identityPath(child.dataDirectory))).toBe(false);
    await expect(restarted.service.status(target.deploymentId)).resolves.toMatchObject({
      membership: { state: "removed", leaveUnconfirmed: false },
    });
    await restarted.service.reconcile();
    expect(delivered).toHaveBeenCalledOnce();
    await restarted.service.shutdown();
    restarted.service.dispose();
  });

  it("keeps pending leave unconfirmed across restarts and rejects malformed confirmation", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://unconfirmed.opensteer.test");
    const config = await configuration(directory);
    const delivered = vi.fn<typeof fetch>(async () => Response.json({ wrong: true }));
    const running = fixture(config, targets, undefined, undefined, { leaveFetch: delivered });
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;
    const leaving = running.service.leaveDeployment({ deploymentId: target.deploymentId });
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await leaving;
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      membership: { state: "leaving", leaveUnconfirmed: true },
    });
    await running.service.shutdown();
    running.service.dispose();
    delivered.mockResolvedValue(Response.json({ outcome: "removed" }));
    const restarted = fixture(config, targets, undefined, undefined, { leaveFetch: delivered });
    await restarted.service.startIfEnabled();
    expect(restarted.fork).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledTimes(2);
    await expect(restarted.service.status(target.deploymentId)).resolves.toMatchObject({
      membership: { state: "removed", leaveUnconfirmed: false },
    });
    await restarted.service.shutdown();
    restarted.service.dispose();
  });

  it("leaves only outgoing Account memberships even after their catalog entries disappear", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const oldAccount = {
      kind: "account" as const,
      issuer: "https://accounts.opensteer.test",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    };
    const nextAccount = {
      ...oldAccount,
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    };
    const outgoing = targets.add("https://outgoing.opensteer.test");
    const incoming = targets.add("https://incoming.opensteer.test");
    const manual = targets.add("https://manual.opensteer.test");
    targets.source(outgoing.deploymentId, oldAccount);
    targets.source(incoming.deploymentId, nextAccount);
    const config = await configuration(directory);
    const delivered = vi.fn<typeof fetch>(async () => Response.json({ outcome: "removed" }));
    const running = fixture(config, targets, undefined, undefined, { leaveFetch: delivered });
    const starts = [outgoing, incoming, manual].map((target) =>
      running.service.start(startInput(target.deploymentId)),
    );
    await eventually(() => running.children.length === 3);
    running.children.forEach((child) => connect(child));
    await Promise.all(starts);
    targets.remove(outgoing.deploymentId);
    expect(
      (await running.service.accountSignOutPreview()).map(({ deploymentId }) => deploymentId),
    ).toContain(outgoing.deploymentId);
    await eventually(() => hasStopMessage(childFor(running.children, outgoing.hostUrl)));
    childFor(running.children, outgoing.hostUrl).emit("exit", 0);
    await running.service.leaveAccountMemberships(nextAccount);
    expect(delivered).toHaveBeenCalledOnce();
    await expect(running.service.status(outgoing.deploymentId)).resolves.toMatchObject({
      membership: { state: "removed" },
    });
    for (const target of [incoming, manual])
      await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
        membership: { state: "active" },
        runner: { state: "running" },
      });
    const signingOut = running.service.leaveAccountMemberships();
    await eventually(() => hasStopMessage(childFor(running.children, incoming.hostUrl)));
    childFor(running.children, incoming.hostUrl).emit("exit", 0);
    await signingOut;
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(hasStopMessage(childFor(running.children, manual.hostUrl))).toBe(false);
  });

  it("binds its own session with only this Deployment's key and keeps removed attempts fenced until explicit setup", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const first = targets.add("https://binding.opensteer.test");
    const second = targets.add("https://other-binding.opensteer.test");
    const config = await configuration(directory);
    const fence = vi.fn();
    const clear = vi.fn(async () => undefined);
    const running = fixture(config, targets, undefined, undefined, {
      fenceDeployment: fence,
      clearDeploymentSession: clear,
    });
    const starts = [first, second].map((target) =>
      running.service.start(startInput(target.deploymentId)),
    );
    await eventually(() => running.children.length === 2);
    running.children.forEach((child) => connect(child));
    await Promise.all(starts);
    const firstChild = childFor(running.children, first.hostUrl);
    const identity = JSON.parse(await readFile(identityPath(firstChild.dataDirectory), "utf8")) as {
      runnerId: string;
      publicKeyPem: string;
    };
    await expect(running.service.bindDeviceSession(first.deploymentId)).resolves.toBe("bound");
    expect(running.host.binds).toHaveLength(1);
    const [bind] = running.host.binds;
    expect(bind).toMatchObject({
      deploymentId: first.deploymentId,
      origin: first.hostUrl,
      machineId: identity.runnerId,
    });
    expect(
      verifyDeviceSessionBindingSignature(identity.publicKeyPem, {
        ...bind!.proof,
        deploymentId: first.deploymentId,
        runnerId: identity.runnerId,
        sessionId: bind!.sessionId,
      }),
    ).toBe(true);
    expect(
      (await readMemberships(path.join(directory, "runner", "desktop-runner.json"))).runners[
        first.deploymentId
      ]?.boundSession?.id,
    ).toBe(bind!.sessionId);
    await expect(running.service.bindDeviceSession(first.deploymentId)).resolves.toBe(
      "already-bound",
    );
    expect(running.host.binds).toHaveLength(1);
    const removing = running.service.markRemoved(first.deploymentId);
    expect(fence).toHaveBeenCalledWith(first.deploymentId);
    await eventually(() => hasStopMessage(firstChild));
    firstChild.emit("exit", 0);
    await removing;
    expect(clear).toHaveBeenCalledWith(first.deploymentId);
    await expect(running.service.assertSessionAllowed(first.deploymentId)).rejects.toThrow(
      "Set up again",
    );
    await expect(running.service.bindDeviceSession(first.deploymentId)).rejects.toThrow(
      "not an active device",
    );
    expect(running.host.binds).toHaveLength(1);
    await expect(
      running.service.assertSessionAllowed(second.deploymentId),
    ).resolves.toBeUndefined();
    const removed = await running.service.status(first.deploymentId);
    await running.service.setUpDevice({
      deploymentId: first.deploymentId,
      runnerName: "Rejoined",
      runAgents: false,
    });
    await expect(running.service.assertSessionAllowed(first.deploymentId)).resolves.toBeUndefined();
    expect(
      (await running.service.status(first.deploymentId)).membership?.generation,
    ).toBeGreaterThan(removed.membership!.generation);
  });

  it("retires only the setup token handed to main before clearing its session, even while the worker connects", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://pending-setup.opensteer.test");
    const order: string[] = [];
    const retiring = vi.fn(async () => {
      order.push("retire");
      return "retired" as const;
    });
    const clearing = vi.fn(async () => {
      order.push("clear");
    });
    const delivered = vi.fn<typeof fetch>(async () => Response.json({ outcome: "removed" }));
    const running = fixture(config, targets, undefined, undefined, {
      retireEnrollment: retiring,
      clearDeploymentSession: clearing,
      leaveFetch: delivered,
    });
    const issuance = {
      type: "runner.enrollment.createLocal" as const,
      token: "e".repeat(64),
      enrollmentId: "own-setup",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const mint = {
      type: "runner.enrollment.createLocal" as const,
      name: "Mac",
      allowedModules: ["shell" as const],
      idempotencyKey: "self-setup",
    };
    await running.service.observeHostCommand(target.deploymentId, mint, issuance);
    await running.service.observeHostCommand(target.deploymentId, mint, {
      ...issuance,
      enrollmentId: "for-another-computer",
      token: "x".repeat(64),
    });
    const start = running.service
      .start(startInput(target.deploymentId))
      .catch((error: unknown) => error);
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    const leaving = running.service.leaveDeployment({ deploymentId: target.deploymentId });
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await leaving;
    await start;
    expect(retiring).toHaveBeenCalledExactlyOnceWith(
      target.deploymentId,
      target.hostUrl,
      "own-setup",
    );
    expect(order[0]).toBe("retire");
    expect(order).toContain("clear");
    expect(delivered).toHaveBeenCalledOnce();
    expect((await running.service.status(target.deploymentId)).membership?.state).toBe("removed");
    await running.service.shutdown();
    running.service.dispose();
  });

  it("keeps leave unconfirmed until a pending enrollment expires when retirement cannot reach the Host", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://pending-expiry.opensteer.test");
    const delivered = vi.fn<typeof fetch>(async () => Response.json({ outcome: "removed" }));
    const retiring = vi.fn(async () => {
      throw new Error("offline");
    });
    const running = fixture(config, targets, undefined, undefined, {
      retireEnrollment: retiring,
      leaveFetch: delivered,
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await running.service.observeHostCommand(
      target.deploymentId,
      {
        type: "runner.enrollment.createLocal",
        name: "Mac",
        allowedModules: ["shell"],
        idempotencyKey: "self-setup",
      },
      {
        type: "runner.enrollment.createLocal",
        token: "e".repeat(64),
        enrollmentId: "own-setup",
        expiresAt,
      },
    );
    const start = running.service
      .start(startInput(target.deploymentId))
      .catch((error: unknown) => error);
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    const leaving = running.service.leaveDeployment({ deploymentId: target.deploymentId });
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await leaving;
    await start;
    expect(delivered).not.toHaveBeenCalled();
    expect((await running.service.status(target.deploymentId)).membership).toMatchObject({
      state: "leaving",
      leaveUnconfirmed: true,
    });
    await running.service.shutdown();
    running.service.dispose();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse(expiresAt) + 1);
      const restarted = fixture(config, targets, undefined, undefined, {
        leaveFetch: delivered,
        retireEnrollment: retiring,
      });
      await restarted.service.startIfEnabled();
      expect(restarted.fork).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledOnce();
      expect((await restarted.service.status(target.deploymentId)).membership?.state).toBe(
        "removed",
      );
      await restarted.service.shutdown();
      restarted.service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "confirms session loss with the Runner, never a cached deadline: expired %s",
    async (expired) => {
      const directory = await temporaryDirectory();
      const config = await configuration(directory);
      const targets = mutableTargetAuthority();
      const target = targets.add("https://session-ended.opensteer.test");
      const running = fixture(config, targets);
      const start = running.service.start(startInput(target.deploymentId));
      await eventually(() => running.children.length === 1);
      const child = childAt(running.children, 0);
      connect(child);
      await start;
      const before = await readFile(identityPath(child.dataDirectory), "utf8");
      const profiles = desktopDeploymentPaths(
        directory,
        target.deploymentId,
      ).browserProfilesDirectory;
      await mkdir(profiles, { recursive: true });
      await writeFile(path.join(profiles, "saved-profile"), "keep");
      const runnerId = readTestIdentity(child.dataDirectory)!.runnerId;
      await running.service.bindDeviceSession(target.deploymentId);
      if (expired) vi.useFakeTimers({ toFake: ["Date"] });
      try {
        if (expired) vi.setSystemTime(new Date("2099-01-02T00:00:00.000Z"));
        const ending = running.service.sessionLost(target.deploymentId);
        await eventually(() => hasStopMessage(child));
        child.emit("exit", 0);
        await ending;
        expect((await running.service.status(target.deploymentId)).membership).toMatchObject({
          state: "active",
          sessionState: "confirming",
        });
        await expect(running.service.assertSessionAllowed(target.deploymentId)).rejects.toThrow(
          "confirm",
        );
        expect(await readFile(identityPath(child.dataDirectory), "utf8")).toBe(before);
        expect(await readFile(path.join(profiles, "saved-profile"), "utf8")).toBe("keep");
        await eventually(() => running.children.length === 2);
        connect(childAt(running.children, 1));
        await eventually(
          async () =>
            (await running.service.status(target.deploymentId)).runner.state === "running",
        );
        if (expired) {
          expect((await running.service.status(target.deploymentId)).membership?.sessionState).toBe(
            "sign-in-again",
          );
          await expect(running.service.assertSessionAllowed(target.deploymentId)).rejects.toThrow();
        } else {
          await expect(
            running.service.assertSessionAllowed(target.deploymentId),
          ).resolves.toBeUndefined();
        }
        expect(await readFile(path.join(profiles, "saved-profile"), "utf8")).toBe("keep");
        const resumed = await running.service.setUpDevice({
          deploymentId: target.deploymentId,
          runnerName: "Same Mac",
          runAgents: false,
        });
        expect(resumed.membership?.runnerId).toBe(runnerId);
      } finally {
        vi.useRealTimers();
        const stopped = running.service.shutdown();
        running.children.forEach((child) => child.kill());
        await stopped;
        running.service.dispose();
      }
    },
  );

  it("records at startup a session the Host already bound, without a window and without binding again", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://restart-bound.opensteer.test");
    const identityDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
    await mkdir(identityDirectory, { recursive: true });
    writeTestIdentity(identityDirectory, true);
    const sessionId = createId("authSession");
    const runnerId = readTestIdentity(identityDirectory)!.runnerId;
    const running = fixture(config, targets, undefined, undefined, {
      currentSession: async () => ({
        id: sessionId,
        deviceId: runnerId,
        expiresAt: "2099-01-01T00:00:00.000Z",
        absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    });
    const restoring = running.service.startIfEnabled();
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await restoring;
    expect(running.host.binds).toEqual([]);
    expect(
      (await readMemberships(path.join(directory, "runner", "desktop-runner.json"))).runners[
        target.deploymentId
      ]?.boundSession?.id,
    ).toBe(sessionId);
    const ending = running.service.sessionLost(target.deploymentId);
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await ending;
    await expect(running.service.assertSessionAllowed(target.deploymentId)).rejects.toThrow(
      "confirm",
    );
    await eventually(() => running.children.length === 2);
    const reconnecting = childAt(running.children, 1);
    reconnecting.emit("message", { type: "runner.worker.revoked" });
    await eventually(() => hasStopMessage(reconnecting));
    reconnecting.emit("exit", 0);
    await eventually(
      async () =>
        (await running.service.status(target.deploymentId)).membership?.state === "removed",
    );
    await expect(running.service.assertSessionAllowed(target.deploymentId)).rejects.toThrow(
      "Set up again",
    );
    await running.service.shutdown();
    running.service.dispose();
  });

  it.each(["removed", "expired"] as const)(
    "resumes renderer authorization using main's real predicate: %s",
    async (state) => {
      const { resumeDeviceSignIn } =
        await import("../../../web/src/components/devices/device-setup.js");
      const directory = await temporaryDirectory();
      const config = await configuration(directory);
      const targets = mutableTargetAuthority();
      const target = targets.add("https://resume-auth.opensteer.test");
      const running = fixture(config, targets);
      const input = {
        deploymentId: target.deploymentId,
        runnerName: "Prepared Mac",
        runAgents: false,
      };
      const original = await running.service.prepareDeviceSetup(input);
      if (state === "removed") await running.service.markRemoved(target.deploymentId);
      else {
        const file = path.join(directory, "runner", "desktop-runner.json");
        const preference = await readMemberships(file);
        await writeMemberships(file, {
          ...preference,
          runners: {
            ...preference.runners,
            [target.deploymentId]: {
              ...preference.runners[target.deploymentId]!,
              needsSignIn: true,
            },
          },
        });
      }
      await expect(running.service.assertSessionAllowed(target.deploymentId)).rejects.toThrow();
      let selected = false;
      await resumeDeviceSignIn(
        {
          setUpDevice: (request) => running.service.setUpDevice(request),
          select: async ({ deploymentId }) => {
            await running.service.assertSessionAllowed(deploymentId);
            selected = true;
          },
        },
        target.deploymentId,
      );
      expect(selected).toBe(true);
      const next = await running.service.prepareDeviceSetup(input);
      expect(next.runnerId === original.runnerId).toBe(state === "expired");
      expect(next.publicKeyPem === original.publicKeyPem).toBe(state === "expired");
      await running.service.shutdown();
      running.service.dispose();
    },
  );

  it.each(["hand-off", "active-write"] as const)(
    "owns prepared Account setup when sign-out wins before %s",
    async (boundary) => {
      const directory = await temporaryDirectory();
      const config = await configuration(directory);
      const targets = mutableTargetAuthority();
      const target = targets.add("https://prepared.opensteer.test");
      const source = {
        kind: "account" as const,
        issuer: "https://accounts.opensteer.test",
        subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
      };
      targets.source(target.deploymentId, source);
      const gate = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      let hold = false;
      const authority = {
        ...targets,
        resolve: async (id: DeploymentId) => {
          if (hold) {
            reached.resolve();
            await withTimeout(gate.promise, 1500, {
              timeoutError: () => new Error("active write barrier was not released"),
            });
          }
          return targets.resolve(id);
        },
      };
      const delivered = vi.fn<typeof fetch>(async () => Response.json({ outcome: "removed" }));
      const running = fixture(config, authority, undefined, undefined, { leaveFetch: delivered });
      const prepared = await running.service.prepareDeviceSetup({
        deploymentId: target.deploymentId,
        runnerName: "Prepared Mac",
        runAgents: false,
      });
      expect(Object.keys(prepared).sort()).toEqual(["publicKeyPem", "runnerId"]);
      const file = path.join(directory, "runner", "desktop-runner.json");
      expect((await readMemberships(file)).runners[target.deploymentId]).toMatchObject({
        state: "active",
        runnerId: prepared.runnerId,
        provenance: source,
        prepared: true,
      });
      const mint = {
        type: "runner.enrollment.createLocal" as const,
        allowedModules: ["shell" as const],
        name: "Prepared Mac",
        idempotencyKey: "self",
        preparedIdentity: prepared,
      };
      const receipt = {
        type: mint.type,
        token: "p".repeat(64),
        enrollmentId: "own-attempt",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      await running.service.observeHostCommand(target.deploymentId, mint, receipt);
      expect(
        (await readMemberships(file)).runners[target.deploymentId]?.pendingEnrollment?.id,
      ).toBe("own-attempt");
      const preview = await running.service.accountSignOutPreview();
      expect(preview).toEqual([{ deploymentId: target.deploymentId, name: "an Opensteer" }]);
      let starting: Promise<unknown> | undefined;
      if (boundary === "active-write") {
        hold = true;
        starting = running.service
          .start({ ...startInput(target.deploymentId), enrollmentToken: receipt.token })
          .catch((error: unknown) => error);
        await withTimeout(reached.promise, 1500, {
          timeoutError: () => new Error("setup never reached active write barrier"),
        });
        hold = false;
      }
      await running.service.leaveAccountMemberships();
      gate.resolve();
      if (starting) expect(await starting).toBeInstanceOf(Error);
      else
        await expect(
          running.service.setUpDevice({
            ...startInput(target.deploymentId),
            enrollmentToken: receipt.token,
          }),
        ).rejects.toThrow();
      expect(running.fork).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledOnce();
      expect(JSON.parse(String(delivered.mock.calls[0]?.[1]?.body)).runnerId).toBe(
        prepared.runnerId,
      );
      expect((await readMemberships(file)).runners[target.deploymentId]?.state).toBe("removed");
      await running.service.shutdown();
      running.service.dispose();
    },
  );

  it("waits for in-flight prepared issuance before Account sign-out owns its signed leave", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://issuance-race.opensteer.test");
    const source = {
      kind: "account" as const,
      issuer: "https://accounts.opensteer.test",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    };
    targets.source(target.deploymentId, source);
    let accountActive = true;
    const delivered = vi.fn<typeof fetch>(async () => Response.json({ outcome: "removed" }));
    const running = fixture(config, targets, undefined, undefined, {
      leaveFetch: delivered,
      assertAccountSource: () => {
        if (!accountActive) throw new Error("Account signed out");
      },
    });
    const input = {
      deploymentId: target.deploymentId,
      runnerName: "Prepared Mac",
      runAgents: false,
    };
    const prepared = await running.service.prepareDeviceSetup(input);
    const command = {
      type: "runner.enrollment.createLocal" as const,
      name: input.runnerName,
      allowedModules: ["shell" as const],
      idempotencyKey: "in-flight",
      preparedIdentity: prepared,
    };
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const issuance = running.service.withPreparedEnrollment(
      target.deploymentId,
      command,
      async () => {
        reached.resolve();
        await withTimeout(gate.promise, 1500, {
          timeoutError: () => new Error("issuance hand-off barrier was not released"),
        });
        await running.service.observeHostCommand(target.deploymentId, command, {
          type: command.type,
          token: "i".repeat(64),
          enrollmentId: "in-flight",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      },
    );
    await withTimeout(reached.promise, 1500, {
      timeoutError: () => new Error("prepared enrollment issuance never began"),
    });
    accountActive = false;
    const signOut = running.service.leaveAccountMemberships();
    expect(delivered).not.toHaveBeenCalled();
    await expect(running.service.prepareDeviceSetup(input)).rejects.toThrow("Account signed out");
    gate.resolve();
    await issuance;
    await signOut;
    expect(delivered).toHaveBeenCalledOnce();
    expect((await running.service.status(target.deploymentId)).membership?.state).toBe("removed");
    await expect(
      running.service.withPreparedEnrollment(target.deploymentId, command, async () => undefined),
    ).rejects.toThrow("cancelled");
    expect(running.fork).not.toHaveBeenCalled();
    await running.service.shutdown();
    running.service.dispose();
  });

  it.each([false, true])(
    "recovers a prepared attempt after restart before redemption, expired %s",
    async (expired) => {
      const directory = await temporaryDirectory();
      const config = await configuration(directory);
      const targets = mutableTargetAuthority();
      const target = targets.add("https://resume-setup.opensteer.test");
      const first = fixture(config, targets);
      const input = {
        deploymentId: target.deploymentId,
        runnerName: "Prepared Mac",
        runAgents: false,
      };
      const prepared = await first.service.prepareDeviceSetup(input);
      await first.service.observeHostCommand(
        target.deploymentId,
        {
          type: "runner.enrollment.createLocal",
          name: input.runnerName,
          allowedModules: ["shell"],
          idempotencyKey: "pre-crash",
          preparedIdentity: prepared,
        },
        {
          type: "runner.enrollment.createLocal",
          token: "p".repeat(64),
          enrollmentId: "pre-crash",
          expiresAt: expired ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
        },
      );
      await first.service.shutdown();
      first.service.dispose();
      const restarted = fixture(config, targets);
      await restarted.service.startIfEnabled();
      expect(restarted.fork).not.toHaveBeenCalled();
      expect((await restarted.service.status(target.deploymentId)).membership).toMatchObject({
        state: "active",
        enrolled: false,
      });
      expect(await restarted.service.prepareDeviceSetup(input)).toEqual(prepared);
      const receipt = {
        type: "runner.enrollment.createLocal" as const,
        token: "n".repeat(64),
        enrollmentId: "replacement",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      await restarted.service.observeHostCommand(
        target.deploymentId,
        {
          type: receipt.type,
          name: input.runnerName,
          allowedModules: ["shell"],
          idempotencyKey: "replacement",
          preparedIdentity: prepared,
        },
        receipt,
      );
      const joining = restarted.service.start({ ...input, enrollmentToken: receipt.token });
      await eventually(() => restarted.children.length === 1);
      connect(childAt(restarted.children, 0));
      expect((await joining).membership).toMatchObject({
        runnerId: prepared.runnerId,
        enrolled: true,
      });
      const stopped = restarted.service.shutdown();
      restarted.children.forEach((child) => child.kill());
      await stopped;
      restarted.service.dispose();
    },
  );

  it("honors a legacy profile-erasure marker instead of healing its orphaned key", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://old-removal.opensteer.test");
    const identityDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
    await mkdir(identityDirectory, { recursive: true });
    writeTestIdentity(identityDirectory, true);
    const markers = path.join(directory, "session", "browser-profile-removals");
    await mkdir(markers, { recursive: true });
    await writeFile(path.join(markers, `${target.deploymentId}.json`), '{"version":1}\n', {
      mode: 0o600,
    });
    const running = fixture(config, targets);
    await running.service.startIfEnabled();
    expect(running.fork).not.toHaveBeenCalled();
    expect((await running.service.status(target.deploymentId)).membership?.state).toBe("removed");
    expect(existsSync(identityPath(identityDirectory))).toBe(false);
  });

  it("abandons a binding whose session read finishes after removal, before signing", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://late-bind.opensteer.test");
    const gate = Promise.withResolvers<void>();
    const begun = Promise.withResolvers<void>();
    const running = fixture(config, targets, undefined, undefined, {
      currentSession: async () => {
        begun.resolve();
        await gate.promise;
        return {
          id: createId("authSession"),
          deviceId: null,
          expiresAt: "2099-01-01T00:00:00.000Z",
          absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    });
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;
    const binding = running.service.bindDeviceSession(target.deploymentId);
    const deadline = setTimeout(
      () => begun.reject(new Error("Session verification did not start")),
      1000,
    );
    try {
      await begun.promise;
    } finally {
      clearTimeout(deadline);
    }
    const removing = running.service.markRemoved(target.deploymentId);
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await removing;
    gate.resolve();
    await expect(binding).rejects.toThrow("left before session binding");
    expect(running.host.binds).toEqual([]);
  });

  it("never binds a sign-in another device holds, and shares one attempt between overlapping callers", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://bind-once.opensteer.test");
    let elsewhere: string | null = createId("runner");
    const session = {
      id: createId("authSession"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
    };
    const running = fixture(config, targets, undefined, undefined, {
      currentSession: async () => ({ ...session, deviceId: elsewhere }),
    });
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    connect(childAt(running.children, 0));
    await start;
    await expect(running.service.bindDeviceSession(target.deploymentId)).rejects.toThrow(
      "another device",
    );
    expect(running.host.binds).toEqual([]);
    elsewhere = null;
    const readsBefore = running.host.reads.sessions;
    const outcomes = await Promise.all([
      running.service.bindDeviceSession(target.deploymentId),
      running.service.bindDeviceSession(target.deploymentId),
    ]);
    expect(outcomes).toEqual(["bound", "bound"]);
    expect(running.host.reads.sessions - readsBefore).toBe(1);
    expect(running.host.binds).toHaveLength(1);
    const stopped = running.service.shutdown();
    running.children.forEach((child) => child.kill());
    await stopped;
    running.service.dispose();
  });

  it("never reports a bind whose reply outlived this membership, nor lets a new setup join it", async () => {
    const directory = await temporaryDirectory();
    const config = await configuration(directory);
    const targets = mutableTargetAuthority();
    const target = targets.add("https://slow-bind.opensteer.test");
    const reply = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    const running = fixture(config, targets, undefined, undefined, {
      bindReply: async () => {
        committed.resolve();
        await reply.promise;
      },
    });
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;
    const stale = running.service.bindDeviceSession(target.deploymentId);
    const settled = stale.then(
      () => "bound",
      (error: unknown) => error,
    );
    await withTimeout(committed.promise, 1000, {
      timeoutError: () => new Error("The bind never reached the Host"),
    });
    const removing = running.service.markRemoved(target.deploymentId);
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await removing;
    await running.service.setUpDevice({
      deploymentId: target.deploymentId,
      runnerName: "Again",
      runAgents: false,
    });
    const fresh = running.service.bindDeviceSession(target.deploymentId);
    expect(fresh).not.toBe(stale);
    await expect(fresh).rejects.toThrow("not an active device");
    reply.resolve();
    expect(await settled).toBeInstanceOf(Error);
    expect(
      (await readMemberships(path.join(directory, "runner", "desktop-runner.json"))).runners[
        target.deploymentId
      ]?.boundSession,
    ).toBeNull();
    await running.service.shutdown();
    running.service.dispose();
  });

  it("runs two enabled Deployments at once and restores both after relaunch", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const first = targets.add("https://first.opensteer.test");
    const second = targets.add("https://second.opensteer.test");
    const firstRun = fixture(await configuration(directory), targets);

    const firstStart = firstRun.service.start(startInput(first.deploymentId, "Office Mac"));
    const secondStart = firstRun.service.start(startInput(second.deploymentId, "Office Mac"));
    await eventually(() => firstRun.children.length === 2);
    connect(childAt(firstRun.children, 0));
    connect(childAt(firstRun.children, 1));
    await Promise.all([firstStart, secondStart]);

    expect(firstRun.fork).toHaveBeenCalledTimes(2);
    await expect(firstRun.service.status(first.deploymentId)).resolves.toMatchObject({
      runner: { state: "running" },
    });
    await expect(firstRun.service.status(second.deploymentId)).resolves.toMatchObject({
      runner: { state: "running" },
    });
    const preference = JSON.parse(
      await readFile(path.join(directory, "runner", "desktop-runner.json"), "utf8"),
    ) as unknown;
    expect(preference).toMatchObject({
      runners: {
        [first.deploymentId]: { state: "active", runAgents: true, runnerName: "Office Mac" },
        [second.deploymentId]: { state: "active", runAgents: true, runnerName: "Office Mac" },
      },
      version: 5,
    });

    const stopping = firstRun.service.shutdown();
    await eventually(() => firstRun.children.every((child) => hasStopMessage(child)));
    firstRun.children.forEach((child) => child.emit("exit", 0));
    await stopping;
    firstRun.service.dispose();

    const relaunched = fixture(await configuration(directory), targets);
    const restoring = relaunched.service.startIfEnabled();
    await eventually(() => relaunched.children.length === 2);
    expect(relaunched.children.map(hostUrl).sort()).toEqual([
      "https://first.opensteer.test/",
      "https://second.opensteer.test/",
    ]);
    expect(
      relaunched.children.every(
        (child) => postedSecrets(child).OPENSTEER_RUNNER_ENROLLMENT_TOKEN === undefined,
      ),
    ).toBe(true);
    relaunched.children.forEach((child) => connect(child));
    await restoring;
  });

  it("does not disturb either Runner when only the viewed Deployment changes", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const first = targets.add("https://first.opensteer.test");
    const second = targets.add("https://second.opensteer.test");
    const running = fixture(await configuration(directory), targets);
    const starts = [
      running.service.start(startInput(first.deploymentId)),
      running.service.start(startInput(second.deploymentId)),
    ];
    await eventually(() => running.children.length === 2);
    running.children.forEach((child) => connect(child));
    await Promise.all(starts);

    targets.notify();
    await expect(
      readFile(path.join(directory, "runner", "desktop-runner.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      runners: {
        [first.deploymentId]: { state: "active" },
        [second.deploymentId]: { state: "active" },
      },
    });

    expect(running.children.every((child) => !hasStopMessage(child))).toBe(true);
    await expect(running.service.status(first.deploymentId)).resolves.toMatchObject({
      deploymentId: first.deploymentId,
      runner: { state: "running" },
      schemaVersion: 4,
    });
    await expect(running.service.status(second.deploymentId)).resolves.toMatchObject({
      deploymentId: second.deploymentId,
      runner: { state: "running" },
    });
  });

  it("restarts only the Runner whose resolved route key changes", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const first = targets.add("https://first.opensteer.test");
    const second = targets.add("https://second.opensteer.test");
    const running = fixture(await configuration(directory), targets);
    const starts = [
      running.service.start(startInput(first.deploymentId)),
      running.service.start(startInput(second.deploymentId)),
    ];
    await eventually(() => running.children.length === 2);
    running.children.forEach((child) => connect(child));
    await Promise.all(starts);

    const firstChild = childFor(running.children, first.hostUrl);
    const secondChild = childFor(running.children, second.hostUrl);
    targets.changeRoute(first.deploymentId, "https://first-new.opensteer.test");
    await eventually(() => hasStopMessage(firstChild));
    expect(hasStopMessage(secondChild)).toBe(false);
    firstChild.emit("exit", 0);
    await eventually(() => running.children.length === 3);
    const restarted = childFor(running.children, "https://first-new.opensteer.test");
    connect(restarted);
    await eventually(
      async () => (await running.service.status(first.deploymentId)).runner.state === "running",
    );

    expect(running.fork).toHaveBeenCalledTimes(3);
    expect(hasStopMessage(secondChild)).toBe(false);
    await expect(running.service.status(second.deploymentId)).resolves.toMatchObject({
      runner: { state: "running" },
    });
  });

  it("removing one Deployment stops only its Runner", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const first = targets.add("https://first.opensteer.test");
    const second = targets.add("https://second.opensteer.test");
    const running = fixture(await configuration(directory), targets);
    const starts = [
      running.service.start(startInput(first.deploymentId)),
      running.service.start(startInput(second.deploymentId)),
    ];
    await eventually(() => running.children.length === 2);
    running.children.forEach((child) => connect(child));
    await Promise.all(starts);

    const firstChild = childFor(running.children, first.hostUrl);
    const secondChild = childFor(running.children, second.hostUrl);
    const removing = removeDevice(running.service, first.deploymentId);
    await eventually(() => hasStopMessage(firstChild));
    expect(hasStopMessage(secondChild)).toBe(false);
    firstChild.emit("exit", 0);
    await expect(removing).resolves.toMatchObject({ runner: { state: "disabled" } });

    await expect(
      readFile(path.join(directory, "runner", "desktop-runner.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      runners: {
        [first.deploymentId]: { state: "removed", erasePending: false },
        [second.deploymentId]: { state: "active", runAgents: true, runnerName: "Studio Mac" },
      },
      version: 5,
    });
    await expect(running.service.status(second.deploymentId)).resolves.toMatchObject({
      runner: { state: "running" },
    });
  });

  it("parks membership when its Deployment leaves the catalog", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://removed.opensteer.test");
    const running = fixture(await configuration(directory), targets);
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    connect(childAt(running.children, 0));
    await start;

    targets.remove(target.deploymentId);
    await eventually(() => hasStopMessage(childAt(running.children, 0)));
    childAt(running.children, 0).emit("exit", 0);
    // Durable intent is dropped before the slot records why, so waiting on the
    // preference alone would read the status mid-reconcile.
    await eventually(async () => {
      const status = await running.service.status(target.deploymentId);
      return status.runner.detail === "Waiting for this Deployment's verified route.";
    });

    await expect(running.service.hasEnrolledRunners()).resolves.toBe(true);
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { detail: "Waiting for this Deployment's verified route.", state: "disabled" },
    });
  });

  it("stops every Runner on app shutdown without clearing durable intent", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const first = targets.add("https://first.opensteer.test");
    const second = targets.add("https://second.opensteer.test");
    const running = fixture(await configuration(directory), targets);
    const starts = [
      running.service.start(startInput(first.deploymentId)),
      running.service.start(startInput(second.deploymentId)),
    ];
    await eventually(() => running.children.length === 2);
    running.children.forEach((child) => connect(child));
    await Promise.all(starts);

    const shutdown = running.service.shutdown();
    await eventually(() => running.children.every((child) => hasStopMessage(child)));
    running.children.forEach((child) => child.emit("exit", 0));
    await shutdown;

    await expect(running.service.hasEnrolledRunners()).resolves.toBe(true);
  });

  it("keeps a computer added by an earlier release running agents", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://upgraded.opensteer.test");
    await mkdir(path.join(directory, "runner", "deployments", target.deploymentId), {
      recursive: true,
    });
    // The Runner this release inherits is already enrolled; only the file that
    // records the membership is the older shape.
    writeTestIdentity(path.join(directory, "runner", "deployments", target.deploymentId), true);
    await writeFile(
      path.join(directory, "runner", "desktop-runner.json"),
      `${JSON.stringify({
        runners: { [target.deploymentId]: { enabled: true, runnerName: "Office Mac" } },
        version: 3,
      })}\n`,
      { mode: 0o600 },
    );
    const running = fixture(await configuration(directory), targets);

    const restoring = running.service.startIfEnabled();
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await restoring;

    expect(child.environment.OPENSTEER_RUNNER_MODULES).toBe("agents,integrations,shell");
    // The bundle that ships the harness bytes is what names them; an engine
    // the person installs themselves is named by nothing here.
    for (const entry of harnessCatalog) {
      expect(child.environment[harnessExecutableEnvironmentVariable(entry.kind)]).toBe(
        shipsHarnessRuntimeBytes(entry) ? path.join(directory, entry.kind) : undefined,
      );
    }
    expect(child.environment.OPENSTEER_RUNNER_NAME).toBe("Office Mac");
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runAgents: true,
      runner: { state: "running" },
    });
  });

  it("carries this computer's browser as a module of the same machine", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://browser.opensteer.test");
    const stop = vi.fn(async () => undefined);
    const running = fixture(await configuration(directory), targets, undefined, async (input) => ({
      bridgeToken: "t".repeat(43),
      signIn: false,
      personFill: false,
      runtimeId: input.runtimeId,
      stop,
      url: new URL("http://127.0.0.1:7777/"),
    }));

    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;

    expect(child.environment.OPENSTEER_RUNNER_MODULES).toBe("agents,browser,integrations,shell");
    expect(child.environment.OPENSTEER_BROWSER_BRIDGE_URL).toBe("http://127.0.0.1:7777/");
  });

  it("gives each lent browser its own log inside the slot it belongs to", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const first = targets.add("https://first-log.opensteer.test");
    const second = targets.add("https://second-log.opensteer.test");
    const inputs: Parameters<NonNullable<LocalRunnerServiceDependencies["browser"]>>[0][] = [];
    const running = fixture(await configuration(directory), targets, undefined, async (input) => {
      inputs.push(input);
      return {
        bridgeToken: "t".repeat(43),
        signIn: false,
        personFill: false,
        runtimeId: input.runtimeId,
        stop: async () => undefined,
        url: new URL("http://127.0.0.1:7777/"),
      };
    });

    const starts = [first, second].map(({ deploymentId }) =>
      running.service.start(startInput(deploymentId)),
    );
    await eventually(() => running.children.length === 2);
    running.children.forEach((child) => connect(child));
    await Promise.all(starts);

    expect(inputs.map(({ profileRoot }) => profileRoot).sort()).toEqual(
      [first, second]
        .map(({ deploymentId }) =>
          path.join(directory, "session", "browser-profiles", deploymentId),
        )
        .sort(),
    );
    // Failure mode: every lent browser appends to and rotates the Personal
    // browser's log, so their lines interleave and one rotation moves the
    // file another still writes to. The log belongs to its slot and is
    // removed with it.
    expect(inputs.map(({ logPath }) => logPath).sort()).toEqual(
      [first, second]
        .map(({ deploymentId }) =>
          path.join(directory, "runner", "deployments", deploymentId, "browser.log"),
        )
        .sort(),
    );
  });

  it("starts a browser with agents off and without any execution assets", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const personal = targets.add("https://studio.connect.opensteer.test", "personal", false);
    // A Mac that is only reachable never looks for the agent runtime.
    await rm(path.join(directory, "agent-skills"), { force: true, recursive: true });
    await rm(path.join(directory, "browser-harness"), { force: true });
    const browser = vi.fn(async (input: { runtimeId: string }) => ({
      bridgeToken: "t".repeat(43),
      signIn: false,
      personFill: false,
      runtimeId: input.runtimeId,
      stop: async () => {},
      url: new URL("http://127.0.0.1:7788/"),
    }));
    const running = fixture(await configuration(directory), targets, undefined, browser);

    const start = running.service.start(startInput(personal.deploymentId, "Studio Mac", false));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child, null);
    await expect(start).resolves.toMatchObject({
      mayRunAgents: false,
      runAgents: false,
      runner: { detail: "This Mac is connected.", state: "running" },
    });

    expect(child.environment.OPENSTEER_RUNNER_MODULES).toBe("browser,integrations,shell");
    expect(child.environment.OPENSTEER_HOST_URL).toBe("https://studio.connect.opensteer.test/");
    expect(child.environment.OPENSTEER_NATIVE_FS_HELPER).toBe(
      path.join(directory, "opensteer-native-fs"),
    );
    expect(child.environment.OPENSTEER_NODE_EXECUTABLE).toBe(path.join(directory, "node"));
    expect(child.environment.OPENSTEER_RUNNER_KIND).toBe("local");
    for (const name of [
      "OPENSTEER_AGENT_SKILLS_DIRECTORY",
      "OPENSTEER_BROWSER_HARNESS",
      ...harnessCatalog.map((entry) => harnessExecutableEnvironmentVariable(entry.kind)),
      "OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH",
      "OPENSTEER_LOCAL_WORKSPACE_ROOT",
      "OPENSTEER_MAX_CONCURRENT_RUNS",
      "OPENSTEER_RUNNER_WORKSPACE_BACKINGS",
    ]) {
      expect(child.environment[name]).toBeUndefined();
    }

    // The slot is durable, so the app brings the same reach-only Runner back.
    const preference = JSON.parse(
      await readFile(path.join(directory, "runner", "desktop-runner.json"), "utf8"),
    ) as unknown;
    expect(preference).toMatchObject({
      runners: {
        [personal.deploymentId]: { state: "active", runAgents: false, runnerName: "Studio Mac" },
      },
      version: 5,
    });
    const stopping = running.service.shutdown();
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await stopping;
    running.service.dispose();

    const relaunched = fixture(await configuration(directory), targets, undefined, browser);
    await expect(relaunched.service.status(personal.deploymentId)).resolves.toMatchObject({
      mayRunAgents: false,
      runAgents: false,
    });
    const restoring = relaunched.service.startIfEnabled();
    await eventually(() => relaunched.children.length === 1);
    connect(childAt(relaunched.children, 0));
    await restoring;

    expect(childAt(relaunched.children, 0).environment.OPENSTEER_RUNNER_MODULES).toBe(
      "browser,integrations,shell",
    );
  });

  it("refuses to run agents on a computer whose Deployment never granted them", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const personal = targets.add("https://studio.connect.opensteer.test", "personal", false);
    const running = fixture(await configuration(directory), targets);

    await expect(
      running.service.start(startInput(personal.deploymentId, "Studio Mac", true)),
    ).rejects.toThrow("A Personal Deployment runs agents only on the Mac that hosts it.");
    expect(running.fork).not.toHaveBeenCalled();
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
  });

  it("restarts the Runner with the other module set when Runs agents changes", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://modules.opensteer.test");
    const browser = vi.fn(async (input: { runtimeId: string; profileRoot: string }) => {
      await mkdir(input.profileRoot, { recursive: true });
      return {
        bridgeToken: "t".repeat(43),
        signIn: false,
        personFill: false,
        runtimeId: input.runtimeId,
        stop: async () => {},
        url: new URL("http://127.0.0.1:7788/"),
      };
    });
    const running = fixture(await configuration(directory), targets, undefined, browser);

    const start = running.service.start(startInput(target.deploymentId, "Studio Mac", true));
    await eventually(() => running.children.length === 1);
    const withAgents = childAt(running.children, 0);
    connect(withAgents);
    await start;
    expect(withAgents.environment.OPENSTEER_RUNNER_MODULES).toBe(
      "agents,browser,integrations,shell",
    );
    const identity = await readFile(
      path.join(directory, "runner", "deployments", target.deploymentId, "identity.json"),
      "utf8",
    );

    const profileRoot = desktopDeploymentPaths(
      directory,
      target.deploymentId,
    ).browserProfilesDirectory;
    await writeFile(path.join(profileRoot, "sign-ins"), "unchanged");
    const switching = running.service.start({
      deploymentId: target.deploymentId,
      runnerName: "Studio Mac",
      runAgents: false,
    });
    await eventually(() => hasStopMessage(withAgents));
    withAgents.emit("exit", 0);
    await eventually(() => running.children.length === 2);
    const reachOnly = childAt(running.children, 1);
    connect(reachOnly);
    await expect(switching).resolves.toMatchObject({ runAgents: false });

    expect(reachOnly.environment.OPENSTEER_RUNNER_MODULES).toBe("browser,integrations,shell");
    expect(browser).toHaveBeenCalledTimes(2);
    expect(browser.mock.calls[1]?.[0].profileRoot).toBe(profileRoot);
    await expect(readFile(path.join(profileRoot, "sign-ins"), "utf8")).resolves.toBe("unchanged");
    expect(postedSecrets(reachOnly).OPENSTEER_RUNNER_ENROLLMENT_TOKEN).toBeUndefined();
    // The identity, its data directory and its host key are untouched.
    expect(reachOnly.environment.OPENSTEER_RUNNER_DATA_DIR).toBe(
      withAgents.environment.OPENSTEER_RUNNER_DATA_DIR,
    );
    await expect(
      readFile(
        path.join(directory, "runner", "deployments", target.deploymentId, "identity.json"),
        "utf8",
      ),
    ).resolves.toBe(identity);
    // Starting again with the same value leaves the running worker alone.
    await running.service.start(startInput(target.deploymentId, "Studio Mac", false));
    expect(running.fork).toHaveBeenCalledTimes(2);
  });

  it("records membership before the worker exists, so a crash cannot lose it", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://durable.opensteer.test");
    const firstRun = fixture(await configuration(directory), targets);
    const preferencePath = path.join(directory, "runner", "desktop-runner.json");

    const start = firstRun.service.start(startInput(target.deploymentId, "Office Mac"));
    const startOutcome = start.then(
      () => null,
      (error: unknown) => error,
    );
    await eventually(() => firstRun.children.length === 1);
    const child = childAt(firstRun.children, 0);

    // The row is on disk while the worker is still connecting.
    await expect(readFile(preferencePath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      runners: {
        [target.deploymentId]: {
          state: "active",
          runnerId: readTestIdentity(child.dataDirectory)?.runnerId,
          runAgents: true,
          runnerName: "Office Mac",
        },
      },
      version: 5,
    });

    // The Runner finished enrolling; the app died before it heard about it.
    writeTestIdentity(child.dataDirectory, true);
    const stopping = firstRun.service.shutdown();
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await stopping;
    await startOutcome;
    firstRun.service.dispose();

    const relaunched = fixture(await configuration(directory), targets);
    const restoring = relaunched.service.startIfEnabled();
    await eventually(() => relaunched.children.length === 1);
    connect(childAt(relaunched.children, 0));
    await restoring;

    await expect(relaunched.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { enrolled: true, state: "running" },
    });
  });

  it("fails fast when a slot never finished joining, and Remove clears it", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://half-joined.opensteer.test");
    const firstRun = fixture(await configuration(directory), targets, () => 0);

    const start = firstRun.service.start(startInput(target.deploymentId));
    const startOutcome = start.then(
      () => null,
      (error: unknown) => error,
    );
    await eventually(() => firstRun.children.length === 1);
    const child = childAt(firstRun.children, 0);
    // The token was refused: the Runner made an identity and never enrolled.
    child.emit("message", {
      message: "The Host refused this computer.",
      type: "runner.worker.failed",
    });
    await startOutcome;
    firstRun.service.dispose();

    const relaunched = fixture(await configuration(directory), targets, () => 0);
    await relaunched.service.startIfEnabled();

    // The token is never written down, so retrying it is a loop with a dead
    // credential: the slot says so and stops.
    expect(relaunched.fork).not.toHaveBeenCalled();
    await expect(relaunched.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: {
        detail: "Finish setting up this Mac to join this Opensteer.",
        state: "failed",
      },
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(relaunched.fork).not.toHaveBeenCalled();

    await expect(removeDevice(relaunched.service, target.deploymentId)).resolves.toMatchObject({
      membership: { state: "removed" },
      runner: { detail: "This Mac was removed from this Deployment.", state: "disabled" },
    });
    await expect(relaunched.service.hasEnrolledRunners()).resolves.toBe(false);
    await expect(
      lstat(path.join(directory, "runner", "deployments", target.deploymentId)),
    ).rejects.toThrow();
  });

  it("deletes a removed slot's files only once its worker and browser are gone", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://ordered-removal.opensteer.test");
    const dataDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
    const profileRoot = desktopDeploymentPaths(
      directory,
      target.deploymentId,
    ).browserProfilesDirectory;
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(profileRoot, "sign-ins"), "removed");
    const stopped = Promise.withResolvers<void>();
    // Proves the order rather than the pair of facts: the profiles are still
    // on disk while the browser is being told to stop.
    let filesPresentAtBrowserStop: boolean | undefined;
    const stop = vi.fn(async () => {
      filesPresentAtBrowserStop = existsSync(profileRoot);
      await stopped.promise;
    });
    const running = fixture(await configuration(directory), targets, undefined, async (input) => ({
      bridgeToken: "t".repeat(43),
      signIn: false,
      personFill: false,
      runtimeId: input.runtimeId,
      stop,
      url: new URL("http://127.0.0.1:7788/"),
    }));
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;

    const removing = removeDevice(running.service, target.deploymentId);
    await eventually(() => stop.mock.calls.length === 1);
    expect(existsSync(profileRoot)).toBe(true);
    stopped.resolve();
    await eventually(() => hasStopMessage(child));
    // The worker has been asked to stop but has not exited: its identity and
    // host key are still its own.
    await expect(lstat(dataDirectory)).resolves.toBeDefined();
    expect(stop).toHaveBeenCalledOnce();

    child.emit("exit", 0);
    await removing;

    expect(stop).toHaveBeenCalledOnce();
    expect(filesPresentAtBrowserStop).toBe(true);
    await expect(lstat(dataDirectory)).rejects.toThrow();
    expect(existsSync(profileRoot)).toBe(false);
  });

  it("ends a launch in flight when this Mac is removed mid-start", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://mid-start.opensteer.test");
    const dataDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
    // A cancelled launch stops its browser without waiting for it, so the
    // slot's record of that shutdown is the only thing keeping the profiles
    // in place until the browser has really let go of them.
    let filesPresentAtBrowserStop: boolean | undefined;
    const running = fixture(await configuration(directory), targets, undefined, async (input) => ({
      bridgeToken: "t".repeat(43),
      signIn: false,
      personFill: false,
      runtimeId: input.runtimeId,
      stop: async () => {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
        filesPresentAtBrowserStop = existsSync(dataDirectory);
      },
      url: new URL("http://127.0.0.1:7799/"),
    }));
    const start = running.service.start(startInput(target.deploymentId));
    const startOutcome = start.then(
      () => null,
      (error: unknown) => error,
    );
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);

    const removing = removeDevice(running.service, target.deploymentId);
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);

    await expect(removing).resolves.toMatchObject({ runner: { state: "disabled" } });
    expect(await startOutcome).toBeInstanceOf(Error);
    expect(filesPresentAtBrowserStop).toBe(true);
    await expect(lstat(dataDirectory)).rejects.toThrow();
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
  });

  it("deletes nothing until a worker that ignores the stop has actually exited", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://stubborn.opensteer.test");
    const running = fixture(await configuration(directory), targets, undefined, undefined, {
      stopTimeouts: { forcedMs: 20, gracefulMs: 20, removalMs: 10_000 },
      stubborn: true,
    });
    const start = running.service.start(startInput(target.deploymentId));
    const startOutcome = start.then(
      () => null,
      (error: unknown) => error,
    );
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    const dataDirectory = path.join(directory, "runner", "deployments", target.deploymentId);

    const removing = removeDevice(running.service, target.deploymentId);
    const removalOutcome = removing.then(
      () => "removed",
      (error: unknown) => error,
    );
    // The graceful stop goes unanswered, so the slot kills — and keeps waiting.
    await eventually(() => child.kills > 0);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    await expect(lstat(dataDirectory)).resolves.toBeDefined();
    expect(await Promise.race([removalOutcome, Promise.resolve("pending")])).toBe("pending");

    child.emit("exit", 137);
    await expect(removing).resolves.toMatchObject({ runner: { state: "disabled" } });

    await expect(lstat(dataDirectory)).rejects.toThrow();
    expect(await startOutcome).toBeInstanceOf(Error);
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
  });

  it("waits for a connected worker's exit before deleting its identity", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://slow-exit.opensteer.test");
    const running = fixture(await configuration(directory), targets, undefined, undefined, {
      stopTimeouts: { forcedMs: 20, gracefulMs: 20, removalMs: 10_000 },
      stubborn: true,
    });
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;
    const dataDirectory = path.join(directory, "runner", "deployments", target.deploymentId);

    // Nothing is in flight but the worker itself: the graceful stop and the
    // kill both go unanswered, and the slot's record of the process is all
    // that stands between its files and a delete.
    const removing = removeDevice(running.service, target.deploymentId);
    const removalOutcome = removing.then(
      () => "removed",
      (error: unknown) => error,
    );
    await eventually(() => child.kills > 0);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    await expect(lstat(dataDirectory)).resolves.toBeDefined();
    expect(await Promise.race([removalOutcome, Promise.resolve("pending")])).toBe("pending");

    child.emit("exit", 137);
    await expect(removing).resolves.toMatchObject({ runner: { state: "disabled" } });
    await expect(lstat(dataDirectory)).rejects.toThrow();
  });

  it("refuses to remove a computer whose worker never exits", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://never-exits.opensteer.test");
    const running = fixture(await configuration(directory), targets, undefined, undefined, {
      stopTimeouts: { forcedMs: 20, gracefulMs: 20, removalMs: 40 },
      stubborn: true,
    });
    const start = running.service.start(startInput(target.deploymentId));
    void start.catch(() => undefined);
    await eventually(() => running.children.length === 1);
    const dataDirectory = path.join(directory, "runner", "deployments", target.deploymentId);

    await expect(removeDevice(running.service, target.deploymentId)).rejects.toThrow(
      "The Runner on this Mac is still running, so nothing was deleted.",
    );

    // Nothing was deleted, and the computer is still a member until it is.
    await expect(lstat(dataDirectory)).resolves.toBeDefined();
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
  });

  it.each([false, true])(
    "erases a revoked slot after its browser stops (retained: %s)",
    async (retained) => {
      const directory = await temporaryDirectory();
      const targets = mutableTargetAuthority();
      const target = targets.add("https://revoked.opensteer.test");
      const other = targets.add("https://other.opensteer.test");
      const root = desktopDeploymentPaths(directory, target.deploymentId).browserProfilesDirectory;
      const otherRoot = desktopDeploymentPaths(
        directory,
        other.deploymentId,
      ).browserProfilesDirectory;
      await mkdir(root, { recursive: true });
      await mkdir(otherRoot, { recursive: true });
      await writeFile(path.join(root, "sign-ins"), "removed");
      await writeFile(path.join(otherRoot, "sign-ins"), "preserved");
      const canonicalRoot = await realpath(root);
      let stopped = false;
      const erasure = new DesktopBrowserProfileErasure(directory, (releasedRoot) => {
        expect(releasedRoot).toBe(canonicalRoot);
        expect(stopped).toBe(true);
        return retained ? "retained-until-exit" : "released";
      });
      const running = fixture(
        await configuration(directory),
        targets,
        () => 0,
        async (input) => ({
          bridgeToken: "t".repeat(43),
          runtimeId: input.runtimeId,
          signIn: false,
          personFill: false,
          url: new URL("http://127.0.0.1:7788/"),
          stop: async () => {
            await expect(readFile(path.join(root, "sign-ins"), "utf8")).resolves.toBe("removed");
            stopped = true;
          },
        }),
        { profileErasure: erasure },
      );
      const start = running.service.start(startInput(target.deploymentId));
      await eventually(() => running.children.length === 1);
      const child = childAt(running.children, 0);
      connect(child);
      await start;
      const dataDirectory = path.join(directory, "runner", "deployments", target.deploymentId);

      child.emit("message", { type: "runner.worker.revoked" });
      await eventually(() => hasStopMessage(child));
      expect(existsSync(root)).toBe(true);
      child.emit("exit", 0);
      await eventually(
        async () =>
          (await running.service.status(target.deploymentId)).runner.detail ===
          "This Mac was removed from this Deployment.",
      );
      await expect(lstat(dataDirectory)).rejects.toThrow();
      await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
      expect(existsSync(root)).toBe(retained);
      if (retained) {
        await erasure.finishPending();
        expect(existsSync(root)).toBe(true);
        await expect(erasure.prepare(target.deploymentId)).rejects.toThrow("Restart Opensteer");
        // A fresh process has no retained Electron Sessions, even after membership was forgotten.
        await new DesktopBrowserProfileErasure(directory).finishPending();
        expect(existsSync(root)).toBe(false);
      }
      await expect(readFile(path.join(otherRoot, "sign-ins"), "utf8")).resolves.toBe("preserved");
      await running.service.reconcile();
      expect(running.fork).toHaveBeenCalledTimes(1);
    },
  );

  it("waits for an in-flight profile erasure before shutdown resolves", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://shutdown-erasure.opensteer.test");
    const erasure = new DesktopBrowserProfileErasure(directory);
    const released = Promise.withResolvers<void>();
    const order: string[] = [];
    const erase = erasure.erase.bind(erasure);
    const erasing = vi.spyOn(erasure, "erase").mockImplementation(async (...input) => {
      await released.promise;
      await erase(...input);
      order.push("erased");
    });
    const running = fixture(await configuration(directory), targets, undefined, undefined, {
      profileErasure: erasure,
    });
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;
    child.emit("message", { type: "runner.worker.revoked" });
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await vi.waitFor(() => expect(erasing, "erasure never started").toHaveBeenCalled(), {
      timeout: 1_000,
    });
    const shutting = running.service.shutdown().then(() => order.push("shut down"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    released.resolve();
    await shutting;
    expect(order).toEqual(["erased", "shut down"]);
    running.service.dispose();
  });

  it("removes this Mac when its browser engine cannot stop, and erases its profiles at the next start", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://failed-stop.opensteer.test");
    const root = desktopDeploymentPaths(directory, target.deploymentId).browserProfilesDirectory;
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "sign-ins"), "held");
    const erasure = new DesktopBrowserProfileErasure(directory);
    const running = fixture(
      await configuration(directory),
      targets,
      undefined,
      async (input) => ({
        bridgeToken: "t".repeat(43),
        runtimeId: input.runtimeId,
        signIn: false,
        personFill: false,
        url: new URL("http://127.0.0.1:7788/"),
        stop: async () => {
          throw new Error("engine did not stop");
        },
      }),
      { profileErasure: erasure },
    );
    const starting = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await starting;
    const removing = removeDevice(running.service, target.deploymentId);
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await removing;
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
    // The engine may still hold these files, so this process never deletes them.
    await expect(readFile(path.join(root, "sign-ins"), "utf8")).resolves.toBe("held");
    await expect(erasure.prepare(target.deploymentId)).rejects.toThrow("Restart Opensteer");
    await new DesktopBrowserProfileErasure(directory).finishPending();
    expect(existsSync(root)).toBe(false);
  });

  it("refuses erasure through a replaced profile root", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const deploymentId = createId("deployment");
    const root = desktopDeploymentPaths(directory, deploymentId).browserProfilesDirectory;
    await mkdir(path.dirname(root), { recursive: true });
    await writeFile(path.join(outside, "sign-ins"), "preserved");
    await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
    await expect(new DesktopBrowserProfileErasure(directory).erase(deploymentId)).rejects.toThrow(
      "real app-owned storage",
    );
    await expect(readFile(path.join(outside, "sign-ins"), "utf8")).resolves.toBe("preserved");
  });

  it("keeps a disconnected Deployment's browser storage", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://disconnected.opensteer.test");
    const root = desktopDeploymentPaths(directory, target.deploymentId).browserProfilesDirectory;
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "sign-ins"), "preserved");
    const running = fixture(await configuration(directory), targets);
    const starting = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await starting;
    targets.remove(target.deploymentId);
    const reconciling = running.service.reconcile();
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await reconciling;
    await new DesktopBrowserProfileErasure(directory).finishPending();
    await expect(readFile(path.join(root, "sign-ins"), "utf8")).resolves.toBe("preserved");
  });

  it("forgets the slot and its identity when this Mac is removed", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://removal.opensteer.test");
    const running = fixture(await configuration(directory), targets);
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;
    const dataDirectory = path.join(directory, "runner", "deployments", target.deploymentId);
    await expect(lstat(path.join(dataDirectory, "identity.json"))).resolves.toBeDefined();

    const removing = removeDevice(running.service, target.deploymentId);
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);

    await expect(removing).resolves.toMatchObject({
      runAgents: false,
      runner: {
        detail: "This Mac was removed from this Deployment.",
        enrolled: false,
        environmentId: null,
        runnerId: null,
        state: "disabled",
      },
    });
    await expect(lstat(dataDirectory)).rejects.toThrow();
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
    // Nothing restarts it: removal is not a stop.
    await running.service.reconcile();
    expect(running.fork).toHaveBeenCalledTimes(1);
  });

  it("does not restore enrolled intent when a removed start connects late", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://race.opensteer.test");
    const running = fixture(await configuration(directory), targets);

    const start = running.service.start(startInput(target.deploymentId));
    const startOutcome = start.then(
      () => null,
      (error: unknown) => error,
    );
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    const removing = removeDevice(running.service, target.deploymentId);
    await eventually(() => hasStopMessage(child));
    connect(child);

    await expect(removing).resolves.toMatchObject({ runner: { state: "disabled" } });
    await expect(startOutcome).resolves.toMatchObject({
      message: "This Mac left the Deployment before its Runner connected.",
    });
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
  });

  it("follows a running computer through a disconnect and back to running", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://reconnect.opensteer.test");
    const running = fixture(await configuration(directory), targets);
    let notifications = 0;
    running.service.subscribe(() => {
      notifications += 1;
    });

    const start = running.service.start(startInput(target.deploymentId, "Office Mac"));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;

    child.emit("message", { type: "runner.worker.reconnecting" });
    await eventually(
      async () => (await running.service.status(target.deploymentId)).runner.state === "starting",
    );
    const whileReconnecting = notifications;
    child.emit("message", {
      type: "runner.worker.connected",
      environmentId: "not-an-environment",
      runnerId: "not-a-runner",
    });
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { state: "starting" },
    });

    connect(child);
    await eventually(
      async () => (await running.service.status(target.deploymentId)).runner.state === "running",
    );

    expect(notifications).toBeGreaterThan(whileReconnecting);
    expect(running.fork).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer disconnect ahead of an unfinished connected status check", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://status-race.opensteer.test");
    const running = fixture(await configuration(directory), targets);
    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;
    let release: ((current: boolean) => void) | undefined;
    const checking = new Promise<boolean>((resolvePromise) => {
      release = resolvePromise;
    });
    vi.spyOn(targets, "isCurrent").mockImplementationOnce(() => checking);
    connect(child);
    child.emit("message", { type: "runner.worker.reconnecting" });
    release?.(true);
    await checking;
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { state: "starting" },
    });
    connect(child);
    await eventually(
      async () => (await running.service.status(target.deploymentId)).runner.state === "running",
    );
  });

  it("marks a computer failed when its worker reports a failure after startup", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://late-failure.opensteer.test");
    const running = fixture(await configuration(directory), targets);

    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;

    child.emit("message", {
      message: "The Host refused this computer.",
      type: "runner.worker.failed",
    });
    await eventually(
      async () => (await running.service.status(target.deploymentId)).runner.state === "failed",
    );

    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { detail: "The Host refused this computer.", state: "failed" },
    });
  });

  it("brings a crashed worker back while this Mac stays enrolled, and gives up after a bound", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://crash.opensteer.test");
    const running = fixture(await configuration(directory), targets, () => 0);

    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    connect(childAt(running.children, 0));
    await start;

    childAt(running.children, 0).emit("exit", 1);
    await eventually(() => running.children.length === 2);
    connect(childAt(running.children, 1));
    await eventually(
      async () => (await running.service.status(target.deploymentId)).runner.state === "running",
    );

    childAt(running.children, 0).emit("message", {
      type: "runner.worker.failed",
      message: "Old worker",
    });
    childAt(running.children, 0).emit("exit", 1);
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { state: "running" },
    });

    // Brief connections do not replenish the budget of a crashing worker.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const launched = running.children.length;
      childAt(running.children, launched - 1).emit("exit", 1);
      await eventually(() => running.children.length === launched + 1);
    }
    const exhausted = running.children.length;
    childAt(running.children, exhausted - 1).emit("exit", 1);
    await eventually(async () =>
      (await running.service.status(target.deploymentId)).runner.detail.includes(
        "until Opensteer is restarted",
      ),
    );

    expect(running.children).toHaveLength(exhausted);
    expect(running.fork).toHaveBeenCalledTimes(6);
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { state: "failed" },
    });
    // Durable intent survives: the person never removed this Mac.
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(true);
  });

  it("reports the worker's last output when it stops unexpectedly", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://diagnostics.opensteer.test");
    const running = fixture(await configuration(directory), targets, () => 10_000);

    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await start;

    await new Promise<void>((resolvePromise) => {
      child.stderr.write("runner: authorization failed for Bearer abcdefghijklmnop\n", () =>
        resolvePromise(),
      );
    });
    child.emit("exit", 1);
    await eventually(
      async () => (await running.service.status(target.deploymentId)).runner.state === "failed",
    );

    const status = await running.service.status(target.deploymentId);
    expect(status.runner.detail).toContain("Last output: runner: authorization failed for");
    expect(status.runner.detail).toContain("Bearer [redacted]");
    expect(status.runner.detail).not.toContain("abcdefghijklmnop");
  });

  it("does not restart a crashed worker once this Mac is removed", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add("https://crash-disabled.opensteer.test");
    const running = fixture(await configuration(directory), targets, () => 50);

    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    connect(childAt(running.children, 0));
    await start;

    childAt(running.children, 0).emit("exit", 1);
    await eventually(
      async () => (await running.service.status(target.deploymentId)).runner.state === "failed",
    );
    await removeDevice(running.service, target.deploymentId);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));

    expect(running.fork).toHaveBeenCalledTimes(1);
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { state: "disabled" },
    });
  });

  it("gives every enrolled slot a computer-use bridge, agents or not", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const personal = targets.add("https://studio.connect.opensteer.test", "personal");
    await rm(path.join(directory, "agent-skills"), { force: true, recursive: true });
    await rm(path.join(directory, "browser-harness"), { force: true });
    const computerUse = fakeComputerUse();
    const running = fixture(await configuration(directory), targets, undefined, undefined, {
      computerUse,
    });

    // `runAgents: false`. Computer use rides the `integrations` module a
    // reach-only Runner already has, so it must not be gated on agents.
    const start = running.service.start(startInput(personal.deploymentId, "Studio Mac", false));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    connect(child);
    await expect(start).resolves.toMatchObject({ runAgents: false });

    // Its own transports, iMessage through the same helper, come beside it.
    expect(child.environment.OPENSTEER_RUNNER_MODULES).toBe("integrations,messaging,shell");
    expect(child.environment.OPENSTEER_COMPUTER_USE_BRIDGE_URL).toBe(
      "ws://127.0.0.1:7788/v1/computer-use",
    );
    // The token and the enrollment token are posted to the worker before
    // anything else, never placed in its environment, which any process of
    // this user could read for as long as the Runner runs.
    expect(child.messages[0]).toEqual({
      secrets: {
        OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: "c".repeat(43),
        OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "e".repeat(64),
      },
      type: "runner.worker.secrets",
    });
    expect(Object.keys(child.environment).filter((name) => /TOKEN|SECRET/u.test(name))).toEqual([]);
    expect(Object.values(child.environment)).not.toContain("c".repeat(43));
    expect(Object.values(child.environment)).not.toContain("e".repeat(64));
    expect(computerUse.startForSlot).toHaveBeenCalledWith(personal.deploymentId);

    // Removing this Mac gives the listener back: nothing keeps a loopback
    // listener for a slot that no longer exists.
    const removing = removeDevice(running.service, personal.deploymentId);
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);
    await removing;
    expect(computerUse.stopForSlot).toHaveBeenCalledWith(personal.deploymentId);
  });
});

function fakeComputerUse(
  handle: { readonly token: string; readonly url: URL } | null = {
    token: "c".repeat(43),
    url: new URL("ws://127.0.0.1:7788/v1/computer-use"),
  },
) {
  return {
    startForSlot: vi.fn(async () => handle),
    stopForSlot: vi.fn(async () => undefined),
  };
}

interface FakeSession {
  readonly id: AuthSessionId;
  deviceId: string | null;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
}

interface FakeHostHandlers {
  readonly revokeLegacyRunner?: (
    deploymentId: DeploymentId,
    origin: string,
    runnerId: string,
  ) => Promise<void>;
  readonly retireEnrollment?: (
    deploymentId: DeploymentId,
    origin: string,
    enrollmentId: string,
  ) => Promise<"consumed" | "expired" | "retired">;
  /** The session this Mac's partition is signed in with; one live session per Deployment by default. */
  readonly currentSession?: (deploymentId: DeploymentId) => Promise<FakeSession | null>;
  /** Holds a bind's reply after the Host committed it. */
  readonly bindReply?: () => Promise<void>;
}

/**
 * The few Host answers the service asks for, keyed by Deployment like the
 * real partitioned client. Binding records the device on the session, as the
 * Host does, so a second bind sees it already bound.
 */
function fakeHost(handlers: FakeHostHandlers) {
  const sessions = new Map<DeploymentId, FakeSession>();
  const binds: {
    deploymentId: DeploymentId;
    origin: string;
    sessionId: AuthSessionId;
    machineId: string;
    proof: { issuedAt: string; signature: string };
  }[] = [];
  const reads = { sessions: 0 };
  const session = async (deploymentId: DeploymentId) => {
    if (handlers.currentSession) return handlers.currentSession(deploymentId);
    let current = sessions.get(deploymentId);
    if (!current) {
      current = {
        id: createId("authSession"),
        deviceId: null,
        expiresAt: "2099-01-01T00:00:00.000Z",
        absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
      };
      sessions.set(deploymentId, current);
    }
    return current;
  };
  const api = vi.fn<NonNullable<LocalRunnerServiceDependencies["hostApi"]>>(
    (deploymentId, origin) =>
      ({
        "sessions.list": async () => {
          reads.sessions += 1;
          const current = await session(deploymentId);
          return {
            ok: true,
            data: {
              sessions: current
                ? [
                    {
                      ...current,
                      createdAt: "2026-01-01T00:00:00.000Z",
                      current: true,
                      deviceLabel: "Opensteer on Mac",
                      form: "computer",
                      lastSeenAt: "2026-01-01T00:00:00.000Z",
                    },
                  ]
                : [],
            },
          };
        },
        "commands.dispatch": async (command: HostApiCommandInput) => {
          if (command.type === "machine.session.bind") {
            const current = await session(deploymentId);
            if (!current) throw new Error("No session to bind");
            const machineId = RunnerIdSchema.parse(command.machineId);
            binds.push({
              deploymentId,
              origin,
              sessionId: current.id,
              machineId,
              proof: command.proof,
            });
            current.deviceId = machineId;
            await handlers.bindReply?.();
            return { ok: true, data: { type: command.type } };
          }
          if (command.type === "runner.enrollment.retire") {
            if (!handlers.retireEnrollment) throw new Error("Unexpected enrollment retirement");
            const state = await handlers.retireEnrollment(
              deploymentId,
              origin,
              command.enrollmentId,
            );
            return { ok: true, data: { type: command.type, state } };
          }
          if (command.type === "machine.revoke") {
            if (!handlers.revokeLegacyRunner) throw new Error("Unexpected legacy removal");
            await handlers.revokeLegacyRunner(deploymentId, origin, command.machineId);
            return { ok: true, data: { type: command.type } };
          }
          throw new Error(`Unexpected Host command ${command.type}`);
        },
      }) as unknown as HostApiClient,
  );
  return { api, binds, reads };
}

function fixture(
  config: DesktopConfiguration,
  targets: DesktopLocalRunnerTargetAuthority,
  restartDelayMs?: (attempt: number) => number,
  browser?: LocalRunnerServiceDependencies["browser"],
  options: {
    readonly assertAccountSource?: LocalRunnerServiceDependencies["assertAccountSource"];
    readonly revokeLegacyRunner?: FakeHostHandlers["revokeLegacyRunner"];
    readonly retireEnrollment?: FakeHostHandlers["retireEnrollment"];
    readonly currentSession?: FakeHostHandlers["currentSession"];
    readonly bindReply?: FakeHostHandlers["bindReply"];
    readonly leaveFetch?: typeof fetch;
    readonly fenceDeployment?: LocalRunnerServiceDependencies["fenceDeployment"];
    readonly clearDeploymentSession?: LocalRunnerServiceDependencies["clearDeploymentSession"];
    readonly computerUse?: LocalRunnerServiceDependencies["computerUse"];
    readonly profileErasure?: DesktopBrowserProfileErasure;
    /** A worker that answers neither the stop message nor the kill. */
    readonly stubborn?: boolean;
    readonly stopTimeouts?: LocalRunnerServiceDependencies["stopTimeouts"];
  } = {},
) {
  const children: FakeUtilityProcess[] = [];
  const fork = vi.fn<LocalRunnerServiceDependencies["fork"]>((_module, _args, forkOptions) => {
    // The real worker mints its identity and SSH host key in this directory
    // on first start and keeps them afterwards, which is what a restart must
    // leave alone and a removal must delete.
    if (
      !existsSync(identityPath(forkOptions.cwd)) ||
      !readTestIdentity(forkOptions.cwd)?.environmentId
    )
      writeTestIdentity(forkOptions.cwd, false);
    const child = new FakeUtilityProcess(
      forkOptions.env,
      forkOptions.cwd,
      options.stubborn ?? false,
    );
    children.push(child);
    return child;
  });
  const host = fakeHost({
    ...(options.retireEnrollment ? { retireEnrollment: options.retireEnrollment } : {}),
    ...(options.revokeLegacyRunner ? { revokeLegacyRunner: options.revokeLegacyRunner } : {}),
    ...(options.currentSession ? { currentSession: options.currentSession } : {}),
    ...(options.bindReply ? { bindReply: options.bindReply } : {}),
  });
  return {
    children,
    fork,
    host,
    service: new LocalRunnerService(config, {
      ...(options.assertAccountSource ? { assertAccountSource: options.assertAccountSource } : {}),
      hostApi: host.api,
      ...(options.leaveFetch ? { leaveFetch: options.leaveFetch } : {}),
      ...(options.fenceDeployment ? { fenceDeployment: options.fenceDeployment } : {}),
      ...(options.clearDeploymentSession
        ? { clearDeploymentSession: options.clearDeploymentSession }
        : {}),
      ...(browser ? { browser } : {}),
      computerName: async () => "Studio Mac",
      ...(options.profileErasure ? { profileErasure: options.profileErasure } : {}),
      ...(options.computerUse ? { computerUse: options.computerUse } : {}),
      fork,
      inspectIdentity: async (dataDirectory: string) => readTestIdentity(dataDirectory),
      homeDirectory: config.dataDirectory,
      ...(restartDelayMs ? { restartDelayMs } : {}),
      runtimeRelease: testRuntimeRelease(config.dataDirectory),
      ...(options.stopTimeouts ? { stopTimeouts: options.stopTimeouts } : {}),
      targets,
      userEnvironment: testUserEnvironment(config.dataDirectory),
    }),
  };
}

function mutableTargetAuthority(): DesktopLocalRunnerTargetAuthority & {
  add(
    hostUrl: string,
    kind?: "personal" | "team",
    mayRunAgents?: boolean,
  ): DesktopLocalRunnerTarget;
  changeRoute(deploymentId: DeploymentId, hostUrl: string): void;
  notify(): void;
  restore(target: DesktopLocalRunnerTarget): void;
  source(deploymentId: DeploymentId, source: DeploymentConnectionSource): void;
  remove(deploymentId: DeploymentId): void;
} {
  const targets = new Map<DeploymentId, DesktopLocalRunnerTarget>();
  const listeners = new Set<() => void>();
  return {
    add: (hostUrl, kind = "personal", mayRunAgents = true) => {
      const deploymentId = createId("deployment");
      const keys = testHostAuthorityKeys();
      const authority = signTestDiscoveryEnvelope(
        {
          deploymentId,
          hostInstanceId: createId("hostInstance"),
          canonicalOrigin: "http://127.0.0.1:4310",
          hostKey: { algorithm: "Ed25519" },
          deploymentShape: { kind },
        },
        keys,
      );
      const accessRoute =
        kind === "personal"
          ? signTestPersonalAccessRoute(
              {
                authority: { ...authority.document, deploymentShape: { kind: "personal" } },
                documentVersion: 2,
                purpose: "opensteer-personal-access-route",
                route: { generation: 1, kind: "private", origin: hostUrl },
              },
              keys,
            )
          : null;
      const target: DesktopLocalRunnerTarget = {
        devicesAvailable: true,
        authority,
        accessRoute,
        source: { kind: "manual" },
        deploymentId,
        deploymentShape: { kind },
        hostUrl,
        key: `${deploymentId}:1`,
        mayRunAgents,
      };
      targets.set(deploymentId, target);
      return target;
    },
    changeRoute: (deploymentId, hostUrl) => {
      const target = targets.get(deploymentId);
      if (!target) throw new Error("Missing test Deployment.");
      targets.set(deploymentId, { ...target, hostUrl, key: `${deploymentId}:2` });
      for (const listener of listeners) listener();
    },
    isCurrent: async (candidate) => targets.get(candidate.deploymentId)?.key === candidate.key,
    notify: () => {
      for (const listener of listeners) listener();
    },
    restore: (target) => {
      targets.set(target.deploymentId, target);
      for (const listener of listeners) listener();
    },
    source: (deploymentId, source) => {
      const target = targets.get(deploymentId);
      if (!target) throw new Error("Missing target");
      targets.set(deploymentId, { ...target, source });
    },
    remove: (deploymentId) => {
      targets.delete(deploymentId);
      for (const listener of listeners) listener();
    },
    resolve: async (deploymentIdInput) => {
      const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
      const target = targets.get(deploymentId);
      if (!target) throw new LocalRunnerDeploymentUnavailableError("Deployment is unavailable.");
      return target;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function startInput(deploymentId: DeploymentId, runnerName = "Studio Mac", runAgents = true) {
  return { deploymentId, enrollmentToken: "e".repeat(64), runAgents, runnerName };
}

/** The Host's welcome is what marks a persisted identity enrolled. */
function connect(child: FakeUtilityProcess, environmentId?: null): void {
  const identity = readTestIdentity(child.dataDirectory);
  if (!identity) throw new Error("The test Runner has no persisted identity.");
  writeTestIdentity(child.dataDirectory, true, identity);
  child.emit("message", {
    environmentId: environmentId === null ? null : identity.environmentId,
    runnerId: identity.runnerId,
    type: "runner.worker.connected",
  });
}

function identityPath(dataDirectory: string): string {
  return path.join(dataDirectory, "identity.json");
}

function writeTestIdentity(
  dataDirectory: string,
  enrolled: boolean,
  identity?: { readonly environmentId: string; readonly runnerId: string },
): void {
  const existing = existsSync(identityPath(dataDirectory))
    ? JSON.parse(readFileSync(identityPath(dataDirectory), "utf8"))
    : null;
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(
    identityPath(dataDirectory),
    JSON.stringify({
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      version: 3,
      lastConnectionGeneration: enrolled ? Math.max(1, existing?.lastConnectionGeneration ?? 0) : 0,
      privateKeyPem:
        existing?.privateKeyPem ??
        pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicKeyPem:
        existing?.publicKeyPem ?? pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      environmentId: identity?.environmentId ?? existing?.environmentId ?? createId("environment"),
      runnerId: identity?.runnerId ?? existing?.runnerId ?? createId("runner"),
    }),
    { mode: 0o600 },
  );
}

function readTestIdentity(dataDirectory: string) {
  if (!existsSync(identityPath(dataDirectory))) return null;
  const stored = JSON.parse(readFileSync(identityPath(dataDirectory), "utf8")) as {
    lastConnectionGeneration: number;
    environmentId: EnvironmentId;
    runnerId: RunnerId;
  };
  return {
    enrolled: stored.lastConnectionGeneration > 0,
    environmentId: stored.environmentId,
    runnerId: stored.runnerId,
  };
}

/** The credentials the service posted to the worker, which it posts first. */
function postedSecrets(child: FakeUtilityProcess): Readonly<Record<string, string>> {
  const posted = RunnerWorkerSecretsMessageSchema.safeParse(child.messages[0]);
  if (!posted.success) throw new Error("The worker was not sent its secrets first.");
  return posted.data.secrets;
}

async function removeDevice(service: LocalRunnerService, deploymentId: string) {
  await service.markRemoved(deploymentId);
  return service.status(deploymentId);
}

function hasStopMessage(child: FakeUtilityProcess): boolean {
  return child.messages.some(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "runner.worker.stop",
  );
}

function childFor(children: readonly FakeUtilityProcess[], host: string): FakeUtilityProcess {
  const expected = new URL(host).toString();
  const child = children.find(({ environment }) => environment.OPENSTEER_HOST_URL === expected);
  if (!child) throw new Error(`No test Runner was launched for ${expected}.`);
  return child;
}

function hostUrl(child: FakeUtilityProcess): string | undefined {
  return child.environment.OPENSTEER_HOST_URL;
}

class FakeUtilityProcess extends EventEmitter implements UtilityProcessLike {
  readonly dataDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly messages: unknown[] = [];
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  /** A worker that does not die when asked, so a test can time its exit. */
  readonly stubborn: boolean;
  kills = 0;

  constructor(
    environment: Readonly<Record<string, string>>,
    dataDirectory: string,
    stubborn = false,
  ) {
    super();
    this.dataDirectory = dataDirectory;
    this.environment = environment;
    this.stubborn = stubborn;
  }

  kill(): boolean {
    this.kills += 1;
    if (!this.stubborn) this.emit("exit", 143);
    return true;
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

function childAt(children: readonly FakeUtilityProcess[], index: number): FakeUtilityProcess {
  const child = children[index];
  if (!child) throw new Error(`Missing test Runner ${index}.`);
  return child;
}

async function configuration(directory: string): Promise<DesktopConfiguration> {
  const helper = path.join(directory, "opensteer-native-fs");
  const browserHarness = path.join(directory, "browser-harness");
  const node = path.join(directory, "node");
  const skills = path.join(directory, "agent-skills");
  const worker = path.join(directory, "runner-worker.js");
  // One file per engine whose bytes a release ships, named the way
  // {@link testRuntimeRelease} names them.
  const harnesses = shippedHarnessKinds.map((kind) => path.join(directory, kind));
  await Promise.all([
    mkdir(skills, { recursive: true }),
    writeFile(browserHarness, "browser-harness", { mode: 0o700 }),
    ...harnesses.map((harness) => writeFile(harness, path.basename(harness), { mode: 0o700 })),
    writeFile(helper, "helper", { mode: 0o700 }),
    writeFile(node, "node", { mode: 0o700 }),
    writeFile(worker, "worker", { mode: 0o600 }),
  ]);
  await Promise.all([
    chmod(browserHarness, 0o700),
    ...harnesses.map((harness) => chmod(harness, 0o700)),
    chmod(helper, 0o700),
    chmod(node, 0o700),
  ]);
  return {
    accountUrl: null,
    browser: null,
    dataDirectory: directory,
    hostUrl: null,
    localExecution: {
      dataDirectory: path.join(directory, "runner"),
      nativeFsHelperBinary: helper,
      runnerWorkerPath: worker,
    },
    mode: "test",
    personal: {
      releaseDirectory: path.join(directory, "personal-runtime"),
    },
    portalUrl: null,
    release: {
      id: "com.opensteer.opensteer",
      name: "Opensteer",
      oauth: {
        accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
        application: "desktop",
        clientId: "opensteer-desktop",
        hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
      },
    },
  };
}

function testRuntimeRelease(
  directory: string,
): NonNullable<LocalRunnerServiceDependencies["runtimeRelease"]> {
  return async () => ({
    agentSkillsDirectory: path.join(directory, "agent-skills"),
    browserHarnessExecutable: path.join(directory, "browser-harness"),
    harnessExecutables: shippedHarnessKindRecord((kind) => path.join(directory, kind)),
    nodeExecutable: path.join(directory, "node"),
  });
}

function testUserEnvironment(directory: string) {
  return {
    async resolve(): Promise<Readonly<Record<string, string>>> {
      return {
        CLAUDE_CONFIG_DIR: path.join(directory, ".claude-custom"),
        CODEX_HOME: path.join(directory, ".codex-custom"),
        HOME: directory,
        PATH: `${path.join(directory, "bin")}:/usr/bin:/bin`,
      };
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-local-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await predicate(), "The expected Runner state was not reached").toBe(true);
    },
    { timeout: 2_000, interval: 5 },
  );
}
