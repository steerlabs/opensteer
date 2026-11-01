import type { DeploymentConnection } from "@opensteer/client/connections";
import { testDiscoveryEnvelope } from "@opensteer/client/test-support";
import { createId, type RunnerId } from "@opensteer/core";
import type { DesktopPersonalDeploymentStatus } from "@opensteer/protocol/desktop";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  PersonalRuntimeReleaseError,
  type VerifiedPersonalRuntimeRelease,
} from "../releases/personal-runtime-release.js";
import type { PersonalDeploymentSecrets } from "../secrets/personal-deployment-credentials.js";
import type {
  PersonalDeploymentFilesystemPort,
  PersonalDeploymentManifest,
  PersonalDeploymentPreparedPaths,
} from "../secrets/personal-deployment-store.js";
import {
  defaultPersonalDeploymentName,
  PersonalRuntimeTransitionError,
} from "../secrets/personal-deployment-store.js";
import {
  ProtectedStateUnreadableError,
  ProtectedStorageUnavailableError,
} from "../secrets/protected-json-file.js";
import {
  NativePersonalLoopbackPorts,
  PersonalDeploymentSupervisor,
  PersonalPrivatePortUnavailableError,
  type PersonalLoopbackPortPort,
} from "./personal-deployment-supervisor.js";
import type { PersonalHostControlPort } from "./personal-host-control.js";
import type {
  PersonalLocalBrowserHandle,
  PersonalLocalRuntimePort,
} from "./personal-local-runtime.js";
import type {
  PersonalChildProcess,
  PersonalProcessPort,
  PersonalProcessSpec,
} from "./personal-process-port.js";

describe("PersonalDeploymentSupervisor", () => {
  it("does nothing on launch until This Computer was chosen", async () => {
    const fixture = supervisorFixture(null);
    expect(fixture.supervisor.status).toMatchObject({
      canStart: false,
      deploymentId: null,
      state: "checking",
      step: "checking-computer",
    });
    await expect(fixture.supervisor.resumeIfConfigured()).resolves.toMatchObject({
      canStart: true,
      state: "stopped",
    });
    expect(fixture.release).not.toHaveBeenCalled();
    expect(fixture.processes.specs).toHaveLength(0);
  });

  it("keeps a returning Personal deployment behind startup progress until its full stack is ready", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const fixture = supervisorFixture(configured);
    const states: string[] = [];
    fixture.supervisor.subscribe((status) => states.push(status.state));

    expect(fixture.supervisor.status.state).toBe("checking");
    const resume = fixture.supervisor.resumeIfConfigured();
    expect(fixture.catalog.upsertAndSelect).not.toHaveBeenCalled();
    await expect(resume).resolves.toMatchObject({
      deploymentId: configured.deploymentId,
      state: "ready",
    });
    expect(states[0]).toBe("checking");
    expect(states).toContain("starting");
    expect(states.at(-1)).toBe("ready");
    expect(fixture.catalog.upsertAndSelect).toHaveBeenCalledOnce();
    await fixture.supervisor.stop();
  });

  it("starts native dependencies in order, keeps one owner Environment, and selects only when ready", async () => {
    const fixture = supervisorFixture(null);
    await expect(fixture.supervisor.start()).resolves.toMatchObject({
      deploymentId: expect.any(String),
      environmentId: expect.any(String),
      state: "ready",
      step: "ready",
    });
    expect(fixture.processes.specs.map(({ component }) => component)).toEqual([
      "postgresql",
      "postgresql",
      "postgresql",
      "host",
      "runner",
      "messaging",
    ]);
    const host = fixture.processes.specs[3]!;
    const runner = fixture.processes.specs[4]!;
    expect(host.environment).toMatchObject({
      OPENSTEER_DEPLOYMENT_NAME: defaultPersonalDeploymentName(),
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
    });
    // The Host names the machine, the Runner owns the disk.
    expect(host.environment).not.toHaveProperty("OPENSTEER_HOST_NATIVE_FS_HELPER");
    expect(host.environment).not.toHaveProperty("OPENSTEER_LOCAL_WORKSPACE_ROOT");
    expect(host.environment).not.toHaveProperty("OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH");
    expect(runner.environment.OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH).toContain("runner");
    expect(host.secretEnvironment?.OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    expect(runner.environment.OPENSTEER_ENVIRONMENT_ID).toBe(
      host.environment.OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID,
    );
    expect(runner.environment).toMatchObject({
      OPENSTEER_BROWSER_HARNESS: fixture.releaseValue.entrypoints.browserHarness,
      OPENSTEER_CODEX_EXECUTABLE: fixture.releaseValue.harnesses.codex,
      OPENSTEER_NATIVE_FS_HELPER: fixture.releaseValue.entrypoints.nativeFsHelper,
      OPENSTEER_NODE_EXECUTABLE: fixture.releaseValue.entrypoints.node,
      OPENSTEER_RUNNER_NAME: defaultPersonalDeploymentName(),
      OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "local-directory",
    });
    expect(host.environment).not.toHaveProperty("OPENSTEER_PORTABLEFS_MANAGER_URL");
    expect(runner.environment).not.toHaveProperty("OPENSTEER_PORTABLEFS_MOUNT_BINARY");
    expect(
      fixture.processes.specs.some(({ executable }) => /(?:docker|portablefs)/iu.test(executable)),
    ).toBe(false);
    expect(JSON.stringify(fixture.files.manifest)).not.toContain(
      host.secretEnvironment?.OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN,
    );
    expect(fixture.host.bootstrap).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      host.secretEnvironment?.OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN,
      expect.any(AbortSignal),
    );
    expect(fixture.lifecycle).toEqual(
      expect.arrayContaining([
        "host.bootstrap",
        "browser.start",
        "runner.spawn",
        "host.waitForRunner",
        "host.ensureMain",
      ]),
    );
    expect(fixture.lifecycle.indexOf("host.bootstrap")).toBeLessThan(
      fixture.lifecycle.indexOf("runner.spawn"),
    );
    expect(fixture.lifecycle.indexOf("host.waitForRunner")).toBeLessThan(
      fixture.lifecycle.indexOf("host.ensureMain"),
    );
    expect(fixture.catalog.upsertAndSelect).toHaveBeenCalledOnce();
    expect(fixture.supervisor.status.components).toMatchObject({
      browser: { state: "ready", version: null },
      runner: { state: "ready", version: fixture.releaseValue.identity.runnerVersion },
    });
    // The Electron browser has no identity of its own: the Runner reaches it
    // over a loopback bridge, and only the Runner holds an enrollment.
    expect(fixture.localRuntimes.startBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "desktop-browser",
        paths: expect.objectContaining({
          browserProfileRoot: fixture.files.paths.browserProfileRoot,
        }),
      }),
    );
    expect(runner.environment.OPENSTEER_BROWSER_BRIDGE_URL).toBe("http://127.0.0.1:4399/");
    expect(runner.environment.OPENSTEER_BROWSER_RUNTIME_ID).toBe("desktop-browser");
    expect(runner.environment.OPENSTEER_BROWSER_SIGN_IN).toBe("1");
    expect(runner.secretInput?.OPENSTEER_BROWSER_BRIDGE_TOKEN).toBe("bridge-token");
    expect(runner.environment).not.toHaveProperty("OPENSTEER_BROWSER_BRIDGE_TOKEN");
    // Computer use reaches the Main Runner too: it is this Mac's own Runner.
    // Its token, like every Runner credential, travels on stdin, never in the
    // environment any process of this user could read.
    expect(fixture.computerUse.startForSlot).toHaveBeenCalledWith(
      fixture.files.manifest?.deploymentId,
    );
    expect(runner.environment.OPENSTEER_COMPUTER_USE_BRIDGE_URL).toBe(
      "ws://127.0.0.1:7788/v1/computer-use",
    );
    expect(runner.secretInput?.OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN).toBe("c".repeat(43));
    expect(runner.environment).not.toHaveProperty("OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN");
    expect(runner.secretEnvironment).toBeUndefined();
    expect(Object.keys(runner.environment).filter((name) => /TOKEN/u.test(name))).toEqual([]);

    await fixture.supervisor.stop();
    expect(fixture.computerUse.stopForSlot).toHaveBeenCalledOnce();
    expect(fixture.processes.kills).toEqual([
      "messaging:SIGTERM",
      "runner:SIGTERM",
      "host:SIGTERM",
      "postgresql:SIGTERM",
    ]);
    expect(fixture.lifecycle.slice(-5)).toEqual([
      "messaging.stop",
      "browser.stop",
      "runner.stop",
      "host.stop",
      "postgresql.stop",
    ]);
  });

  it("waits for the returning Runner before inspecting an existing Main Workspace", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const fixture = supervisorFixture(configured);

    await fixture.supervisor.resumeIfConfigured();

    expect(fixture.lifecycle.indexOf("host.waitForRunner")).toBeLessThan(
      fixture.lifecycle.indexOf("host.ensureMain"),
    );
    expect(fixture.host.ensureMain).toHaveBeenCalledWith(
      expect.any(String),
      configured.deploymentId,
      expect.any(AbortSignal),
    );
    await fixture.supervisor.stop();
  });

  it("waits for the Browser placement before publishing ready", async () => {
    const fixture = supervisorFixture(null);
    const placement = deferred<void>();
    fixture.host.waitForBrowserPlacement.mockReturnValueOnce(placement.promise);
    const starting = fixture.supervisor.start();
    await vi.waitFor(() => {
      expect(fixture.supervisor.status).toMatchObject({
        components: { browser: { state: "starting" } },
        state: "starting",
      });
    });
    expect(fixture.catalog.upsertAndSelect).toHaveBeenCalledOnce();
    placement.resolve();
    await expect(starting).resolves.toMatchObject({
      components: { browser: { state: "ready", version: null } },
      state: "ready",
    });
    await fixture.supervisor.stop();
  });

  /**
   * Identity is the resolver's half of ownership, so what is asserted here is
   * the liveness half: a ready stack owns the session an owner attachment
   * names, and a stopped one owns nothing.
   */
  it("retains the owner claim only while its exact Host is running", async () => {
    const fixture = supervisorFixture(null);
    await fixture.supervisor.start();
    const connection = fixture.catalog.upsertAndSelect.mock.calls[0]![0];

    expect(fixture.supervisor.ownsHostSession({ access: "owner" })).toBe(true);
    await expect(fixture.supervisor.recoverOwnerSession({ access: "owner" })).resolves.toBe(true);
    expect(fixture.host.claimOwner).toHaveBeenCalledWith(
      connection.authority.document.canonicalOrigin,
      expect.objectContaining({ deploymentId: connection.authority.document.deploymentId }),
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expect.any(AbortSignal),
    );

    // A remote attachment to the very same Deployment is not an owner session.
    expect(fixture.supervisor.ownsHostSession({ access: "connect" })).toBe(false);
    await expect(fixture.supervisor.recoverOwnerSession({ access: "connect" })).resolves.toBe(
      false,
    );

    await fixture.supervisor.stop();
    expect(fixture.supervisor.ownsHostSession({ access: "owner" })).toBe(false);
    await expect(fixture.supervisor.recoverOwnerSession({ access: "owner" })).resolves.toBe(false);
    expect(fixture.host.claimOwner).toHaveBeenCalledOnce();
  });

  it("classifies Browser placement timeout as a Browser repair", async () => {
    const fixture = supervisorFixture(null);
    fixture.host.waitForBrowserPlacement.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(fixture.supervisor.start()).rejects.toThrow(/Browser Runtime/u);
    expect(fixture.supervisor.status).toMatchObject({
      issue: { code: "browser-unavailable", component: "browser" },
      state: "repair-required",
    });
    expect(fixture.browsers[0]?.stop).toHaveBeenCalledOnce();
    expect(fixture.processes.kills).toEqual([
      "runner:SIGTERM",
      "host:SIGTERM",
      "postgresql:SIGTERM",
    ]);
  });

  it("cancels the placement poll and binds it to this deployment's Environment", async () => {
    const fixture = supervisorFixture(null);
    let pollSignal: AbortSignal | undefined;
    fixture.host.waitForBrowserPlacement.mockImplementationOnce((...arguments_: unknown[]) => {
      pollSignal = arguments_[4] as AbortSignal;
      return new Promise(() => undefined);
    });
    await expect(fixture.supervisor.start()).rejects.toThrow(/Browser Runtime/u);
    expect(pollSignal?.aborted).toBe(true);
    const call = fixture.host.waitForBrowserPlacement.mock.calls[0] as unknown[];
    expect(call[1]).toBe(fixture.supervisor.status.deploymentId);
    expect(call[2]).toBe(fixture.supervisor.status.environmentId);
    expect(call[3]).toBe("desktop-browser");
  });

  it("tears down every child when this computer's browser cannot start", async () => {
    const fixture = supervisorFixture(null);
    fixture.localRuntimes.startBrowser.mockRejectedValueOnce(new Error("browser bridge failed"));
    await expect(fixture.supervisor.start()).rejects.toThrow("browser bridge failed");
    expect(fixture.supervisor.status).toMatchObject({
      issue: { code: "browser-unavailable", component: "browser" },
      state: "repair-required",
    });
    // The browser comes up before the Runner that relays it, so a failed
    // bridge leaves only the Host and its database to tear down.
    expect(fixture.processes.kills).toEqual(["host:SIGTERM", "postgresql:SIGTERM"]);
  });

  it("initializes PostgreSQL from a staged password file that is removed afterwards", async () => {
    const fixture = supervisorFixture(null);
    await expect(fixture.supervisor.start()).resolves.toMatchObject({ state: "ready" });
    const initdb = fixture.processes.specs.find(({ executable }) => executable.endsWith("initdb"));
    expect(initdb?.arguments).toContain("--pwfile=/data/tmp/initdb-password");
    expect(initdb?.arguments).not.toContain("--pwfile=-");
    expect(initdb?.stdin).toBeUndefined();
    expect(fixture.files.stageDatabaseInitPassword).toHaveBeenCalledOnce();
    expect(fixture.files.discardDatabaseInitPassword).toHaveBeenCalledOnce();
    expect(fixture.files.stagedDatabasePassword).toBeNull();
    await fixture.supervisor.stop();
  });

  it("resumes a durable deployment without replacing its stable IDs", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const fixture = supervisorFixture(configured);
    await expect(fixture.supervisor.resumeIfConfigured()).resolves.toMatchObject({
      state: "ready",
    });
    expect(fixture.files.create).not.toHaveBeenCalled();
    const runner = fixture.processes.specs.findLast(({ component }) => component === "runner")!;
    expect(runner.environment.OPENSTEER_ENVIRONMENT_ID).toBe(configured.environmentId);
    expect(runner.environment.OPENSTEER_RUNNER_ID).toBe(configured.runnerId);
    await fixture.supervisor.stop();
  });

  it("atomically adopts a verified same-platform, same-PostgreSQL-major runtime update", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const nextRelease = verifiedRelease({ hostVersion: "1.2.4", runnerVersion: "2.3.5" });
    const fixture = supervisorFixture(configured, undefined, nextRelease);

    await expect(fixture.supervisor.resumeIfConfigured()).resolves.toMatchObject({
      state: "ready",
    });
    expect(fixture.files.manifest).toMatchObject({
      deploymentId: configured.deploymentId,
      environmentId: configured.environmentId,
      release: nextRelease.identity,
      revision: configured.revision + 1,
    });
    expect(fixture.processes.specs.find(({ component }) => component === "host")?.executable).toBe(
      nextRelease.entrypoints.host,
    );
    await fixture.supervisor.stop();
  });

  it("snapshots the stopped database before an app update commits, and never blocks the update", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const nextRelease = verifiedRelease({ hostVersion: "1.2.4", runnerVersion: "2.3.5" });
    const fixture = supervisorFixture(configured, undefined, nextRelease);
    const atSnapshot: unknown[] = [];
    fixture.files.snapshotDatabase.mockImplementation(async () => {
      atSnapshot.push({
        revision: fixture.files.manifest?.revision,
        processes: fixture.processes.specs.length,
      });
      return "20261028T120000Z-1.2.3";
    });

    await expect(fixture.supervisor.resumeIfConfigured()).resolves.toMatchObject({
      state: "ready",
    });
    expect(fixture.files.snapshotDatabase).toHaveBeenCalledWith(
      configured,
      nextRelease.identity,
      expect.any(Date),
    );
    // Before the cutover and before PostgreSQL or the Host ran.
    expect(atSnapshot).toEqual([{ revision: configured.revision, processes: 0 }]);
    expect(fixture.logs).toContainEqual(
      expect.objectContaining({
        event: "personal-database-snapshot",
        snapshot: "20261028T120000Z-1.2.3",
      }),
    );
    await fixture.supervisor.stop();

    const unchanged = supervisorFixture(fixture.files.manifest, undefined, nextRelease);
    await expect(unchanged.supervisor.resumeIfConfigured()).resolves.toMatchObject({
      state: "ready",
    });
    expect(unchanged.files.snapshotDatabase).not.toHaveBeenCalled();
    await unchanged.supervisor.stop();

    const fresh = supervisorFixture(
      deploymentManifest({ databaseInitialized: false }),
      undefined,
      nextRelease,
    );
    await expect(fresh.supervisor.resumeIfConfigured()).resolves.toMatchObject({ state: "ready" });
    expect(fresh.files.snapshotDatabase).not.toHaveBeenCalled();
    await fresh.supervisor.stop();

    const failing = supervisorFixture(configured, undefined, nextRelease);
    failing.files.snapshotDatabase.mockRejectedValue(new Error("ENOTSUP: clone unsupported"));
    await expect(failing.supervisor.resumeIfConfigured()).resolves.toMatchObject({
      state: "ready",
    });
    expect(failing.files.manifest?.release).toEqual(nextRelease.identity);
    expect(failing.logs).toContainEqual(
      expect.objectContaining({
        event: "personal-database-snapshot-skipped",
        error: "ENOTSUP: clone unsupported",
      }),
    );
    await failing.supervisor.stop();
  });

  it("retries before the release cutover and resumes only the committed release after it", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const nextRelease = verifiedRelease({ hostVersion: "1.2.4", runnerVersion: "2.3.5" });
    const beforeCommit = supervisorFixture(configured, undefined, nextRelease);
    beforeCommit.files.failNextSave = true;
    await expect(beforeCommit.supervisor.resumeIfConfigured()).rejects.toThrow(
      "simulated manifest interruption",
    );
    expect(beforeCommit.files.manifest?.release).toEqual(configured.release);
    expect(beforeCommit.processes.specs).toHaveLength(0);

    const retry = supervisorFixture(beforeCommit.files.manifest, undefined, nextRelease);
    await expect(retry.supervisor.resumeIfConfigured()).resolves.toMatchObject({ state: "ready" });
    expect(retry.files.manifest?.release).toEqual(nextRelease.identity);
    await retry.supervisor.stop();

    const afterCommit = supervisorFixture(retry.files.manifest, undefined, nextRelease);
    await expect(afterCommit.supervisor.resumeIfConfigured()).resolves.toMatchObject({
      state: "ready",
    });
    expect(afterCommit.files.manifest?.revision).toBe(retry.files.manifest?.revision);
    await afterCommit.supervisor.stop();
  });

  it("starts Try again from the saved manifest after a failed start already advanced it", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const nextRelease = verifiedRelease({ hostVersion: "1.2.4", runnerVersion: "2.3.5" });
    const fixture = supervisorFixture(configured, undefined, nextRelease);
    fixture.host.waitForHost.mockRejectedValueOnce(new Error("host refused readiness"));

    await expect(fixture.supervisor.resumeIfConfigured()).rejects.toThrow("host refused readiness");
    // The failed attempt had already committed the update.
    expect(fixture.files.manifest).toMatchObject({
      release: nextRelease.identity,
      revision: configured.revision + 1,
    });

    // Failure mode: Try again reuses the manifest read at launch, so every
    // attempt reports a concurrent change until the app is relaunched.
    await expect(fixture.supervisor.start()).resolves.toMatchObject({ state: "ready" });
    await expect(fixture.supervisor.start()).resolves.toMatchObject({ state: "ready" });
    expect(fixture.files.manifest?.revision).toBe(configured.revision + 1);
    await fixture.supervisor.stop();
  });

  it("reads the manifest again after a failed lookup instead of failing every later start", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const fixture = supervisorFixture(configured);
    vi.spyOn(fixture.files, "load").mockRejectedValueOnce(
      new Error("EACCES: permission denied, open '/data/deployment.json'"),
    );

    await expect(fixture.supervisor.resumeIfConfigured()).rejects.toThrow(/permission denied/u);
    expect(fixture.supervisor.status).toMatchObject({
      canStart: true,
      issue: { code: "directory-invalid" },
      state: "repair-required",
    });
    // Failure mode: the rejected lookup is cached, so Try again can never succeed.
    await expect(fixture.supervisor.start()).resolves.toMatchObject({
      deploymentId: configured.deploymentId,
      state: "ready",
    });
    await fixture.supervisor.stop();
  });

  it("names a plain disk error on a start for what it is, and Try again starts", async () => {
    // Failure mode: too many open files reading the release reads as a
    // tampered release, and a full disk writing the secrets as an unavailable
    // keychain, each sending the person to repair the wrong thing.
    const files = supervisorFixture(null);
    files.release.mockRejectedValueOnce(diskError("EMFILE"));
    await expect(files.supervisor.start()).rejects.toThrow(/EMFILE/u);
    expect(files.supervisor.status).toMatchObject({
      canStart: true,
      issue: { code: "unexpected", component: "desktop", repairAction: "open-diagnostics" },
      state: "repair-required",
    });
    await expect(files.supervisor.start()).resolves.toMatchObject({ state: "ready" });
    await files.supervisor.stop();

    const full = supervisorFixture(null);
    full.credentials.ensure.mockRejectedValueOnce(diskError("ENOSPC"));
    await expect(full.supervisor.start()).rejects.toThrow(/ENOSPC/u);
    expect(full.supervisor.status).toMatchObject({
      canStart: true,
      issue: {
        code: "disk-space-insufficient",
        component: "desktop",
        repairAction: "free-disk-space",
      },
      state: "repair-required",
    });
    await expect(full.supervisor.start()).resolves.toMatchObject({ state: "ready" });
    await full.supervisor.stop();
  });

  it("blocks PostgreSQL-major changes until an explicit data migration exists", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const incompatible = verifiedRelease({ postgresMajor: 18, postgresVersion: "18.1.0" });
    const fixture = supervisorFixture(configured, undefined, incompatible);

    await expect(fixture.supervisor.resumeIfConfigured()).rejects.toThrow(/major migration/u);
    expect(fixture.supervisor.status).toMatchObject({ state: "update-required" });
    expect(fixture.processes.specs).toHaveLength(0);
    expect(fixture.files.manifest?.release).toEqual(configured.release);
  });

  it("refuses to roll a committed Personal runtime backward", async () => {
    const current = deploymentManifest({
      databaseInitialized: true,
      ownerInitialized: true,
      release: verifiedRelease({ hostVersion: "1.3.0", runnerVersion: "2.4.0" }).identity,
    });
    const oldBundle = verifiedRelease();
    const fixture = supervisorFixture(current, undefined, oldBundle);

    await expect(fixture.supervisor.resumeIfConfigured()).rejects.toThrow(/move backward/u);
    expect(fixture.supervisor.status).toMatchObject({ state: "update-required" });
    expect(fixture.files.manifest?.release).toEqual(current.release);
    expect(fixture.processes.specs).toHaveLength(0);
  });

  it("stops the partial stack and reports a bounded repair state when Host readiness fails", async () => {
    const fixture = supervisorFixture(null);
    fixture.host.waitForHost.mockRejectedValueOnce(new Error("host refused readiness"));
    await expect(fixture.supervisor.start()).rejects.toThrow("host refused readiness");
    expect(fixture.supervisor.status).toMatchObject({
      canStart: true,
      issue: { code: "host-unavailable", component: "host" },
      state: "repair-required",
    });
    expect(fixture.processes.kills).toEqual(["host:SIGTERM", "postgresql:SIGTERM"]);
    expect(JSON.stringify(fixture.supervisor.status)).not.toContain("claim");
  });

  it("includes the redacted child diagnostic when a service exits during startup", async () => {
    const fixture = supervisorFixture(null);
    fixture.host.waitForHost.mockImplementationOnce(() => new Promise(() => undefined));
    const starting = fixture.supervisor.start();
    await vi.waitFor(() => {
      expect(
        fixture.processes.children.find(({ component }) => component === "host"),
      ).toBeDefined();
    });
    const host = fixture.processes.children.find(({ component }) => component === "host");
    if (!host) throw new Error("Host test process was not created");
    host.stderr.write("token=private-value invalid Host configuration\n");
    host.stderr.end();
    host.emit("exit", 1, null);

    await expect(starting).rejects.toThrow(/invalid Host configuration/u);
    expect(fixture.supervisor.status.issue?.detail).toContain("credential=[redacted]");
    expect(fixture.supervisor.status.issue?.detail).not.toContain("private-value");
  });

  it("includes redacted service diagnostics when readiness times out", async () => {
    const fixture = supervisorFixture(null);
    fixture.host.waitForRunner.mockImplementationOnce(() => new Promise(() => undefined));
    const starting = fixture.supervisor.start();
    await vi.waitFor(() => {
      expect(
        fixture.processes.children.find(({ component }) => component === "runner"),
      ).toBeDefined();
    });
    const runner = fixture.processes.children.find(({ component }) => component === "runner");
    if (!runner) throw new Error("Runner test process was not created");
    runner.stderr.write(`${"preceding runner output ".repeat(120)}\n`);
    runner.stderr.write("token=private-value runner could not enroll\n");

    await expect(starting).rejects.toThrow(/runner could not enroll/u);
    expect(fixture.supervisor.status.issue?.detail).toContain("credential=[redacted]");
    expect(fixture.supervisor.status.issue?.detail).not.toContain("private-value");
  });

  it("names the service that failed, not the release, when its output mentions release words", async () => {
    const fixture = supervisorFixture(null);
    fixture.host.waitForRunner.mockImplementationOnce(() => new Promise(() => undefined));
    const starting = fixture.supervisor.start();
    await vi.waitFor(() => expect(childrenOf(fixture, "runner")).toHaveLength(1));
    childrenOf(fixture, "runner")[0]!.stderr.write(
      "ENOENT: image digest is incompatible with a corrupt cache\n",
    );

    await expect(starting).rejects.toThrow(/did not become ready/u);
    // Failure mode: the words are read as a tampered or incompatible release,
    // which hides the Runner and, as update-required, removes Try again.
    expect(fixture.supervisor.status).toMatchObject({
      canStart: true,
      issue: { code: "runner-unavailable", component: "runner" },
      state: "repair-required",
    });
  });

  it("fails safely when a persisted private port is occupied without changing authority", async () => {
    const configured = deploymentManifest({ databaseInitialized: true, ownerInitialized: true });
    const fixture = supervisorFixture(configured, undefined, undefined, {
      assertAvailable: vi.fn(async (_port, component) => {
        if (component === "host") {
          throw new PersonalPrivatePortUnavailableError("host");
        }
      }),
    });

    await expect(fixture.supervisor.resumeIfConfigured()).rejects.toThrow(/already in use/u);
    expect(fixture.supervisor.status).toMatchObject({
      issue: { code: "private-port-unavailable", component: "host" },
      state: "repair-required",
    });
    expect(fixture.processes.specs).toHaveLength(0);
    expect(fixture.files.manifest).toEqual(configured);
  });

  it("keeps first-run ports stable if availability is lost before service launch", async () => {
    const loopbackPorts = {
      assertAvailable: vi.fn(async () => {
        throw new PersonalPrivatePortUnavailableError("postgresql");
      }),
    };
    const fixture = supervisorFixture(null, undefined, undefined, loopbackPorts);
    await expect(fixture.supervisor.start()).rejects.toThrow(/already in use/u);
    const committed = fixture.files.manifest;
    expect(committed).not.toBeNull();
    expect(fixture.files.create).toHaveBeenCalledOnce();
    expect(fixture.processes.specs).toHaveLength(0);
    await expect(fixture.supervisor.start()).rejects.toThrow(/already in use/u);
    expect(fixture.files.manifest).toEqual(committed);
    expect(fixture.files.create).toHaveBeenCalledOnce();
  });

  it("detects a real loopback listener before launching a saved component", async () => {
    const listener = createServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      listener.once("error", rejectPromise);
      listener.listen({ host: "127.0.0.1", port: 0 }, resolvePromise);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("test listener has no TCP port");
    try {
      await expect(
        new NativePersonalLoopbackPorts().assertAvailable(address.port, "host"),
      ).rejects.toMatchObject({
        component: "host",
        name: "PersonalPrivatePortUnavailableError",
      });
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        listener.close((error) => (error ? rejectPromise(error) : resolvePromise())),
      );
    }
  });

  it("gives this computer's messaging service the Host it attaches to and the enrollment the Host was configured with", async () => {
    const fixture = supervisorFixture(null);
    await fixture.supervisor.start();
    const host = fixture.processes.specs.findLast(({ component }) => component === "host")!;
    const messaging = fixture.processes.specs.findLast(
      ({ component }) => component === "messaging",
    )!;

    expect(messaging.executable).toBe(fixture.releaseValue.entrypoints.channelRuntime);
    expect(messaging.environment).toMatchObject({
      OPENSTEER_MESSAGING_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_MESSAGING_DATA_DIR: "/data/channel-runtime",
      OPENSTEER_MESSAGING_HOST_URL: host.environment.OPENSTEER_CANONICAL_ORIGIN,
      OPENSTEER_MESSAGING_NAME: "This computer's messaging",
      OPENSTEER_MODE: host.environment.OPENSTEER_MODE,
    });
    expect(Number(messaging.environment.OPENSTEER_MESSAGING_PORT)).toBeGreaterThan(0);
    // One token, two halves: the Host pre-registers the enrollment and the
    // messaging service redeems it, exactly as the compose stack does.
    expect(messaging.secretInput?.OPENSTEER_RUNNER_ENROLLMENT_TOKEN).toBe("m".repeat(64));
    expect(host.secretEnvironment?.OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN).toBe(
      "m".repeat(64),
    );
    expect(messaging.environment).not.toHaveProperty("OPENSTEER_RUNNER_ENROLLMENT_TOKEN");
    expect(messaging.secretEnvironment).toBeUndefined();
    // Messaging attaches to a Host that is already serving.
    expect(fixture.lifecycle.indexOf("host.bootstrap")).toBeLessThan(
      fixture.lifecycle.indexOf("messaging.spawn"),
    );
    expect(fixture.supervisor.status.components.messaging).toEqual({
      state: "ready",
      version: null,
    });
    await fixture.supervisor.stop();
  });

  it("stays ready with a messaging issue when the messaging service cannot start", async () => {
    const fixture = supervisorFixture(null);
    fixture.processes.refuseToSpawn.add("messaging");

    await expect(fixture.supervisor.start()).resolves.toMatchObject({
      components: { messaging: { state: "failed" } },
      issue: { code: "messaging-unavailable", component: "messaging" },
      state: "ready",
    });
    // Everything messaging rides on is still running and still selected.
    expect(fixture.supervisor.status.components).toMatchObject({
      browser: { state: "ready" },
      host: { state: "ready" },
      runner: { state: "ready" },
    });
    expect(fixture.catalog.upsertAndSelect).toHaveBeenCalledOnce();
    expect(fixture.processes.kills).toEqual([]);
    await fixture.supervisor.stop();
  });

  it("restarts only the messaging service when it exits, backing off and keeping the stack ready", async () => {
    const fixture = supervisorFixture(null, undefined, undefined, undefined, {
      restartBackoffMs: 25,
    });
    await fixture.supervisor.start();
    const observed: DesktopPersonalDeploymentStatus[] = [];
    fixture.supervisor.subscribe((status) => observed.push(status));

    const messagingChildren = () =>
      fixture.processes.children.filter(({ component }) => component === "messaging");
    const waited: number[] = [];
    for (const generation of [1, 2]) {
      const messaging = messagingChildren().at(-1);
      if (!messaging) throw new Error("Messaging test process was not created");
      messaging.stderr.write("token=private-value messaging could not enroll\n");
      messaging.stderr.end();
      const crashedAt = Date.now();
      messaging.emit("exit", 1, null);
      await vi.waitFor(() => expect(messagingChildren()).toHaveLength(generation + 1), {
        interval: 5,
      });
      waited.push(Date.now() - crashedAt);
    }

    // Exponential, not immediate: 25ms then 50ms. setTimeout is never early, so
    // the second restart cannot clear this bound without the backoff doubling.
    expect(waited[0]).toBeGreaterThanOrEqual(25);
    expect(waited[1]).toBeGreaterThanOrEqual(50);
    await vi.waitFor(() => {
      expect(fixture.supervisor.status).toMatchObject({
        components: { messaging: { state: "ready" } },
        issue: null,
        state: "ready",
      });
    });
    // Each restart re-proves the new process attached before calling it ready.
    expect(fixture.host.waitForMessaging).toHaveBeenCalledTimes(3);
    const restarting = observed.find(
      (status) =>
        status.components.messaging.state === "degraded" &&
        status.issue?.code === "messaging-unavailable",
    );
    expect(restarting?.state).toBe("ready");
    expect(restarting?.issue?.detail).toContain("credential=[redacted]");
    expect(restarting?.issue?.detail).not.toContain("private-value");
    // A messaging crash never restarts the graph it rides on.
    expect(fixture.processes.kills).toEqual([]);
    await fixture.supervisor.stop();
  });

  it("keeps restarting messaging past the old budget without restarting siblings", async () => {
    const fixture = supervisorFixture(null);
    await fixture.supervisor.start();
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      childrenOf(fixture, "messaging").at(-1)!.emit("exit", 1, null);
      await vi.waitFor(() => expect(childrenOf(fixture, "messaging")).toHaveLength(iteration + 1), {
        interval: 5,
      });
      await vi.waitFor(
        () => expect(fixture.supervisor.status.components.messaging.state).toBe("ready"),
        { interval: 5 },
      );
    }
    expect(fixture.processes.kills).toEqual([]);
    await fixture.supervisor.stop();
  });

  it("holds messaging at starting until its readiness route reports the Host attached", async () => {
    const fixture = supervisorFixture(null);
    const attached = deferred<void>();
    fixture.host.waitForMessaging.mockReturnValueOnce(attached.promise);

    const starting = fixture.supervisor.start();
    await vi.waitFor(() => {
      expect(fixture.processes.specs.some(({ component }) => component === "messaging")).toBe(true);
    });
    expect(fixture.supervisor.status.components.messaging.state).toBe("starting");

    attached.resolve();
    await expect(starting).resolves.toMatchObject({
      components: { messaging: { state: "ready" } },
      issue: null,
      state: "ready",
    });
    const messaging = fixture.processes.specs.findLast(
      ({ component }) => component === "messaging",
    )!;
    // Readiness is proved on the messaging process's own loopback port.
    expect(fixture.host.waitForMessaging).toHaveBeenCalledWith(
      `http://127.0.0.1:${messaging.environment.OPENSTEER_MESSAGING_PORT}`,
      fixture.supervisor.status.deploymentId,
      expect.any(AbortSignal),
    );
    await fixture.supervisor.stop();
  });

  it("reports a messaging issue when readiness never arrives, without killing the process", async () => {
    const fixture = supervisorFixture(null);
    fixture.host.waitForMessaging.mockImplementationOnce(() => new Promise(() => undefined));

    await expect(fixture.supervisor.start()).resolves.toMatchObject({
      components: { messaging: { state: "degraded" } },
      issue: { code: "messaging-unavailable", component: "messaging" },
      state: "ready",
    });
    expect(fixture.supervisor.status.issue?.detail).toContain("did not attach");
    expect(fixture.supervisor.status.components).toMatchObject({
      browser: { state: "ready" },
      host: { state: "ready" },
      runner: { state: "ready" },
    });
    // The service may still attach, so it is left running and still supervised:
    // the shutdown that follows is the first thing to stop it.
    expect(fixture.processes.kills).toEqual([]);
    await fixture.supervisor.stop();
    expect(fixture.processes.kills).toContain("messaging:SIGTERM");
  });

  describe("crash recovery", () => {
    /**
     * The Runner keeps executing while its Host connection is down and
     * re-attaches its Runs to the next Host at the same origin, so a Host crash
     * must cost only the Host process. Each failure mode below names a way the
     * targeted restart could lose Runs, strand the Runner, or outlive the
     * crash-loop guard.
     */
    it("restarts only a crashed Host, on its pinned origin and credentials, while the Runner keeps running", async () => {
      const fixture = supervisorFixture(null);
      await fixture.supervisor.start();
      const observed = observeStatus(fixture.supervisor);
      const firstHostSpec = specsOf(fixture, "host")[0]!;
      const runnerSpec = specsOf(fixture, "runner")[0]!;
      // A rename while running is durable; restarting the Host must not revert it.
      const running = fixture.files.manifest!;
      fixture.files.manifest = {
        ...running,
        name: "Renamed computer",
        revision: running.revision + 1,
      };

      childrenOf(fixture, "host")[0]!.emit("exit", 1, null);
      await waitForRecovery(fixture, observed);

      // Failure mode: the Runner, its browser bridge, computer use, PostgreSQL or
      // messaging are torn down with the Host, losing every Run.
      expect(childrenOf(fixture, "host")).toHaveLength(2);
      expect(childrenOf(fixture, "runner")).toHaveLength(1);
      expect(childrenOf(fixture, "postgresql")).toHaveLength(1);
      expect(childrenOf(fixture, "messaging")).toHaveLength(1);
      expect(fixture.processes.kills).toEqual([]);
      expect(fixture.localRuntimes.startBrowser).toHaveBeenCalledOnce();
      expect(fixture.browsers[0]!.stop).not.toHaveBeenCalled();
      expect(fixture.computerUse.stopForSlot).not.toHaveBeenCalled();
      expect(observed.every(({ components }) => components.runner.state === "ready")).toBe(true);

      // Failure mode: the new Host comes up somewhere the running Runner does not
      // reach, or with credentials that do not match the database and messaging.
      const secondHostSpec = specsOf(fixture, "host")[1]!;
      expect(secondHostSpec.environment).toEqual({
        ...firstHostSpec.environment,
        OPENSTEER_DEPLOYMENT_NAME: "Renamed computer",
      });
      expect(runnerSpec.environment.OPENSTEER_HOST_URL).toBe(
        secondHostSpec.environment.OPENSTEER_CANONICAL_ORIGIN,
      );
      const { OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: firstClaim, ...firstSecrets } =
        firstHostSpec.secretEnvironment!;
      const { OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: secondClaim, ...secondSecrets } =
        secondHostSpec.secretEnvironment!;
      expect(secondSecrets).toEqual(firstSecrets);

      // Failure mode: the supervisor keeps the dead Host's owner claim or runtime
      // record, so owner recovery spends a capability the new Host never held.
      expect(secondClaim).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(secondClaim).not.toBe(firstClaim);
      expect(fixture.host.bootstrap).toHaveBeenLastCalledWith(
        secondHostSpec.environment.OPENSTEER_CANONICAL_ORIGIN,
        expect.objectContaining({ name: "Renamed computer" }),
        secondClaim,
        expect.any(AbortSignal),
      );
      expect(fixture.supervisor.ownsHostSession({ access: "owner" })).toBe(true);
      await expect(fixture.supervisor.recoverOwnerSession({ access: "owner" })).resolves.toBe(true);
      expect(fixture.host.claimOwner).toHaveBeenLastCalledWith(
        secondHostSpec.environment.OPENSTEER_CANONICAL_ORIGIN,
        expect.any(Object),
        secondClaim,
        expect.any(AbortSignal),
      );
      await expect(fixture.supervisor.current()).resolves.toMatchObject({
        localOrigin: secondHostSpec.environment.OPENSTEER_CANONICAL_ORIGIN,
        state: "ready",
      });
      // The authority is unchanged, so the Deployment is not re-selected over
      // whatever the person chose since.
      expect(fixture.catalog.upsertAndSelect).toHaveBeenCalledOnce();

      // Failure mode: ready is published before the running Runner and messaging
      // re-attached to the new Host.
      expect(fixture.host.waitForRunner).toHaveBeenCalledTimes(2);
      expect(fixture.host.waitForMessaging).toHaveBeenCalledTimes(2);

      // Failure mode: the outage is invisible, or the Deployment never returns
      // to ready.
      const crashed = observed.findIndex(
        ({ components, state }) => state === "degraded" && components.host.state === "degraded",
      );
      const restarting = observed.findIndex(
        ({ components, state }) => state === "degraded" && components.host.state === "starting",
      );
      expect(crashed).toBeGreaterThanOrEqual(0);
      expect(observed[crashed]?.issue).toMatchObject({
        code: "host-unavailable",
        component: "host",
      });
      expect(restarting).toBeGreaterThan(crashed);
      expect(fixture.supervisor.status).toMatchObject({
        issue: null,
        state: "ready",
        step: "ready",
      });
      await fixture.supervisor.stop();
    });

    it("keeps recovering Host crashes past the old budget and retains siblings", async () => {
      const fixture = supervisorFixture(null);
      await fixture.supervisor.start();
      const observed = observeStatus(fixture.supervisor);
      for (let iteration = 1; iteration <= 5; iteration += 1) {
        const host = childrenOf(fixture, "host").at(-1)!;
        host.stderr.write("signal: killed\n");
        host.stderr.end();
        host.emit("exit", 1, null);
        await vi.waitFor(
          () => {
            expect(childrenOf(fixture, "host")).toHaveLength(iteration + 1);
            expect(fixture.supervisor.status.state).toBe("ready");
          },
          { interval: 5 },
        );
      }
      expect(
        observed.some(
          ({ issue }) =>
            issue?.detail.includes("exit 1") && issue.detail.includes("signal: killed"),
        ),
      ).toBe(true);
      expect(childrenOf(fixture, "postgresql")).toHaveLength(1);
      expect(childrenOf(fixture, "runner")).toHaveLength(1);
      expect(fixture.processes.kills).toEqual([]);
      await fixture.supervisor.stop();
    });

    it("restarts the whole stack when the Runner crashes", async () => {
      const fixture = supervisorFixture(null);
      await fixture.supervisor.start();
      const observed = observeStatus(fixture.supervisor);

      childrenOf(fixture, "runner")[0]!.emit("exit", 1, null);
      await waitForRecovery(fixture, observed);

      expect(fixture.processes.kills).toEqual([
        "messaging:SIGTERM",
        "host:SIGTERM",
        "postgresql:SIGTERM",
      ]);
      expect(childrenOf(fixture, "host")).toHaveLength(2);
      expect(childrenOf(fixture, "runner")).toHaveLength(2);
      await fixture.supervisor.stop();
    });

    it("restarts the whole stack when PostgreSQL crashes", async () => {
      const fixture = supervisorFixture(null);
      await fixture.supervisor.start();
      const observed = observeStatus(fixture.supervisor);

      childrenOf(fixture, "postgresql")[0]!.emit("exit", 1, null);
      await waitForRecovery(fixture, observed);

      expect(fixture.processes.kills).toEqual([
        "messaging:SIGTERM",
        "runner:SIGTERM",
        "host:SIGTERM",
      ]);
      expect(childrenOf(fixture, "postgresql")).toHaveLength(2);
      expect(childrenOf(fixture, "runner")).toHaveLength(2);
      await fixture.supervisor.stop();
    });

    it("retries only the Host when a restarted Host fails transient readiness", async () => {
      const fixture = supervisorFixture(null);
      await fixture.supervisor.start();
      const observed = observeStatus(fixture.supervisor);
      fixture.host.waitForHost.mockRejectedValueOnce(new Error("host refused readiness"));

      childrenOf(fixture, "host")[0]!.emit("exit", 1, null);
      await waitForRecovery(fixture, observed);

      expect(fixture.processes.kills).toEqual(["host:SIGTERM"]);
      expect(childrenOf(fixture, "host")).toHaveLength(3);
      expect(childrenOf(fixture, "runner")).toHaveLength(1);
      expect(observed.some(({ state }) => state === "repair-required")).toBe(false);
      expect(fixture.supervisor.ownsHostSession({ access: "owner" })).toBe(true);
      await fixture.supervisor.stop();
    });

    it("keeps recovering when a restarted Host prints words that name permanent failures", async () => {
      const fixture = supervisorFixture(null);
      await fixture.supervisor.start();
      const observed = observeStatus(fixture.supervisor);
      fixture.host.waitForHost.mockImplementationOnce(() => new Promise(() => undefined));

      childrenOf(fixture, "host")[0]!.emit("exit", 1, null);
      await vi.waitFor(() => expect(childrenOf(fixture, "host")).toHaveLength(2), { interval: 5 });
      const restarted = childrenOf(fixture, "host")[1]!;
      restarted.stderr.write(
        "Error: ENOENT: no such file; digest incompatible; corrupt protected storage\n",
      );
      restarted.stderr.end();
      restarted.emit("exit", 1, null);

      // Failure mode: recovery reads the child's words as a permanent failure,
      // stops the whole stack and never restarts it.
      await waitForRecovery(fixture, observed);
      expect(childrenOf(fixture, "host")).toHaveLength(3);
      expect(childrenOf(fixture, "runner")).toHaveLength(1);
      expect(
        observed.some(({ state }) => state === "repair-required" || state === "update-required"),
      ).toBe(false);
      await fixture.supervisor.stop();
    });

    it("stops blind restarts when the release or the keychain cannot be used", async () => {
      const tampered = supervisorFixture(null);
      await tampered.supervisor.start();
      tampered.release.mockRejectedValueOnce(
        new PersonalRuntimeReleaseError(
          "tampered",
          "Personal runtime artifact host failed release verification.",
        ),
      );
      childrenOf(tampered, "runner")[0]!.emit("exit", 1, null);
      await vi.waitFor(
        () =>
          expect(tampered.supervisor.status).toMatchObject({
            canStart: true,
            issue: { code: "release-tampered", component: "desktop" },
            state: "repair-required",
          }),
        { interval: 5 },
      );
      const launches = tampered.processes.specs.length;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(tampered.processes.specs).toHaveLength(launches);

      const storage = supervisorFixture(null);
      await storage.supervisor.start();
      storage.credentials.ensure.mockRejectedValueOnce(
        new ProtectedStorageUnavailableError(
          "Personal deployment secret store cannot be decrypted.",
        ),
      );
      childrenOf(storage, "postgresql")[0]!.emit("exit", 1, null);
      await vi.waitFor(
        () =>
          expect(storage.supervisor.status).toMatchObject({
            issue: { code: "protected-storage-unavailable", component: "desktop" },
            state: "repair-required",
          }),
        { interval: 5 },
      );
      const storageLaunches = storage.processes.specs.length;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(storage.processes.specs).toHaveLength(storageLaunches);

      const older = supervisorFixture(null);
      await older.supervisor.start();
      older.release.mockRejectedValueOnce(
        new PersonalRuntimeReleaseError(
          "incompatible",
          "Personal runtime release manifest is incompatible with this Desktop.",
        ),
      );
      childrenOf(older, "runner")[0]!.emit("exit", 1, null);
      await vi.waitFor(
        () =>
          expect(older.supervisor.status).toMatchObject({
            issue: { code: "release-incompatible", repairAction: "install-compatible-release" },
            state: "update-required",
          }),
        { interval: 5 },
      );
    });

    it("stops blind restarts on protected state it cannot read, and names it for what it is", async () => {
      const fixture = supervisorFixture(null);
      await fixture.supervisor.start();
      fixture.credentials.ensure.mockRejectedValueOnce(
        new ProtectedStateUnreadableError("Personal deployment secret store is corrupt."),
      );
      childrenOf(fixture, "postgresql")[0]!.emit("exit", 1, null);

      // Failure mode: recovery retries a corrupt secret store forever, or
      // sends the person to the Keychain or to permissions for it.
      await vi.waitFor(
        () =>
          expect(fixture.supervisor.status).toMatchObject({
            canStart: true,
            issue: {
              code: "protected-state-unreadable",
              component: "desktop",
              detail: "Personal deployment secret store is corrupt.",
              repairAction: "open-diagnostics",
            },
            state: "repair-required",
          }),
        { interval: 5 },
      );
      const launches = fixture.processes.specs.length;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(fixture.processes.specs).toHaveLength(launches);

      const first = supervisorFixture(null);
      first.credentials.ensure.mockRejectedValueOnce(
        new ProtectedStateUnreadableError("Personal deployment secret store is corrupt."),
      );
      await expect(first.supervisor.start()).rejects.toThrow(/corrupt/u);
      expect(first.supervisor.status).toMatchObject({
        issue: { code: "protected-state-unreadable", repairAction: "open-diagnostics" },
        state: "repair-required",
      });
    });

    it("keeps recovering through plain disk errors reading the release or the secrets", async () => {
      for (const [source, code] of [
        ["release", "EMFILE"],
        ["release", "EIO"],
        ["credentials", "ENOSPC"],
        ["credentials", "EIO"],
      ] as const) {
        const fixture = supervisorFixture(null);
        await fixture.supervisor.start();
        const observed = observeStatus(fixture.supervisor);
        if (source === "release") fixture.release.mockRejectedValueOnce(diskError(code));
        else fixture.credentials.ensure.mockRejectedValueOnce(diskError(code));

        childrenOf(fixture, "runner")[0]!.emit("exit", 1, null);
        await waitForRecovery(fixture, observed);

        // Failure mode: a file-system fault that can pass (too many open
        // files, a full or failing disk) is taken for a broken release or an
        // unavailable keychain, so recovery stops for good and the person is
        // told to reinstall or restore permissions.
        expect(childrenOf(fixture, "runner"), `${source} ${code}`).toHaveLength(2);
        expect(
          observed.some(({ state }) => state === "repair-required" || state === "update-required"),
          `${source} ${code}`,
        ).toBe(false);
        // Retried after a backoff, with the error named on the crashed service.
        expect(
          observed.some(
            ({ issue }) =>
              issue?.code === "runner-unavailable" &&
              issue.detail.startsWith("Restarting Runner in") &&
              issue.detail.includes(code),
          ),
          `${source} ${code}`,
        ).toBe(true);
        await fixture.supervisor.stop();
      }
    });

    it("keeps recovering later crashes after Try again outlived a recovery that gave up", async () => {
      const loopbackPorts = {
        assertAvailable: vi.fn<PersonalLoopbackPortPort["assertAvailable"]>(async () => undefined),
      };
      const fixture = supervisorFixture(null, undefined, undefined, loopbackPorts);
      await fixture.supervisor.start();
      const portCheck = deferred<void>();
      loopbackPorts.assertAvailable.mockImplementationOnce(() => portCheck.promise);
      const checks = loopbackPorts.assertAvailable.mock.calls.length;

      childrenOf(fixture, "host")[0]!.emit("exit", 1, null);
      await vi.waitFor(
        () => expect(loopbackPorts.assertAvailable.mock.calls.length).toBe(checks + 1),
        { interval: 5 },
      );
      // Try again queues behind the restart, which then gives up on a taken port.
      const retry = fixture.supervisor.start();
      portCheck.reject(new PersonalPrivatePortUnavailableError("host"));
      await expect(retry).resolves.toMatchObject({ state: "ready" });

      // Failure mode: the abandoned restart cleared "keep running" after Try
      // again set it, so the next crash leaves a dead Host showing ready.
      const hosts = childrenOf(fixture, "host").length;
      const observed = observeStatus(fixture.supervisor);
      childrenOf(fixture, "host").at(-1)!.emit("exit", 1, null);
      await waitForRecovery(fixture, observed);
      expect(childrenOf(fixture, "host")).toHaveLength(hosts + 1);
      await fixture.supervisor.stop();
    });
  });

  it("propagates the resolved login PATH to Runner and fails explicitly when it is unavailable", async () => {
    const fixture = supervisorFixture(null, {
      resolve: vi.fn(async () => ({ HOME: "/Users/test", PATH: "/opt/homebrew/bin:/usr/bin" })),
    });
    await fixture.supervisor.start();
    expect(
      fixture.processes.specs.findLast(({ component }) => component === "runner")?.environment.PATH,
    ).toBe("/opt/homebrew/bin:/usr/bin");
    await fixture.supervisor.stop();

    const unavailable = supervisorFixture(null, {
      resolve: vi.fn(async () => {
        const { PersonalUserEnvironmentError } = await import("./personal-user-environment.js");
        throw new PersonalUserEnvironmentError("The login shell provided no usable PATH.");
      }),
    });
    await expect(unavailable.supervisor.start()).rejects.toThrow(/no usable PATH/u);
    expect(unavailable.supervisor.status).toMatchObject({
      issue: { code: "provider-environment-unavailable", component: "runner" },
      state: "repair-required",
    });
    expect(unavailable.processes.specs.some(({ component }) => component === "runner")).toBe(false);
  });
});

function supervisorFixture(
  existing: PersonalDeploymentManifest | null,
  userEnvironment?: { resolve(): Promise<Readonly<Record<string, string>>> },
  releaseValue: VerifiedPersonalRuntimeRelease = verifiedRelease(),
  loopbackPorts: {
    assertAvailable(port: number, component: "host" | "postgresql"): Promise<void>;
  } = { assertAvailable: async () => undefined },
  restarts: {
    readonly restartBackoffMs?: number;
    readonly passkeys?: boolean;
  } = {},
) {
  const lifecycle: string[] = [];
  const files = new MemoryPersonalFiles(existing);
  const processes = new MemoryProcesses(files, lifecycle);
  const release = vi.fn(async () => releaseValue);
  const verified = {
    bootstrapMethods: [],
    capabilities: [],
    discovery: {
      canonicalOrigin: `http://127.0.0.1:${existing?.hostPort ?? 4310}`,
      deploymentId: existing?.deploymentId ?? createId("deployment"),
      hostInstanceId: existing?.hostInstanceId ?? createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" as const },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory" as const,
        kind: "personal" as const,
      },
    },
    endpoint: {
      kind: "canonical" as const,
      origin: `http://127.0.0.1:${existing?.hostPort ?? 4310}`,
      verifiedAt: "2026-08-12T12:00:00.000Z",
    },
  };
  const host = {
    bootstrap: vi.fn(async () => {
      lifecycle.push("host.bootstrap");
      return { runnerEnrollmentToken: "runner-enrollment-token-12345" };
    }),
    claimOwner: vi.fn(async () => undefined),
    ensureMain: vi.fn(async () => {
      lifecycle.push("host.ensureMain");
    }),
    waitForHost: vi.fn<PersonalHostControlPort["waitForHost"]>(async () => {
      const discovery = {
        ...verified.discovery,
        deploymentId: files.manifest?.deploymentId ?? verified.discovery.deploymentId,
        hostInstanceId: files.manifest?.hostInstanceId ?? verified.discovery.hostInstanceId,
      };
      return { ...verified, discovery, discoveryEnvelope: testDiscoveryEnvelope(discovery) };
    }),
    waitForBrowserPlacement: vi.fn<PersonalHostControlPort["waitForBrowserPlacement"]>(
      async () => undefined,
    ),
    waitForMessaging: vi.fn<PersonalHostControlPort["waitForMessaging"]>(async () => {
      lifecycle.push("messaging.attached");
    }),
    waitForRunner: vi.fn<PersonalHostControlPort["waitForRunner"]>(async () => {
      lifecycle.push("host.waitForRunner");
    }),
  } satisfies PersonalHostControlPort;
  const browsers: TestLocalBrowserHandle[] = [];
  const localRuntimes = {
    startBrowser: vi.fn(async (input: { readonly runtimeId: string }) => {
      const browser = new TestLocalBrowserHandle(lifecycle, input.runtimeId);
      browsers.push(browser);
      return browser;
    }),
  } satisfies PersonalLocalRuntimePort;
  const computerUse = {
    startForSlot: vi.fn(async () => ({
      token: "c".repeat(43),
      url: new URL("ws://127.0.0.1:7788/v1/computer-use"),
    })),
    stopForSlot: vi.fn(async () => undefined),
  };
  const catalog = {
    upsertAndSelect: vi.fn(async (_connection: DeploymentConnection) => ({}) as never),
  };
  const credentials = {
    ensure: vi.fn(async (): Promise<PersonalDeploymentSecrets> => ({
      databasePassword: "d".repeat(64),
      hostAuthSecret: "h".repeat(64),
      hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
      messagingEnrollmentToken: "m".repeat(64),
    })),
  };
  let nextPort = 4310;
  const logs: Record<string, unknown>[] = [];
  const supervisor = new PersonalDeploymentSupervisor({
    passkeys: restarts.passkeys === true,
    allocatePort: async () => nextPort++,
    log: (event, fields) => logs.push({ event, ...fields }),
    baseEnvironment: { HOME: "/Users/test", PATH: "/usr/bin" },
    catalog,
    computerUse,
    credentials,
    files,
    host,
    localRuntimes,
    loopbackPorts,
    processes,
    release,
    releaseDirectory: "/Applications/Opensteer.app/Contents/Resources/personal-runtime",
    restartBackoffMs: restarts.restartBackoffMs ?? 1,
    shutdownTimeoutMs: 500,
    startupTimeoutMs: 500,
    ...(userEnvironment ? { userEnvironment } : {}),
    workspaceRoot: "/Users/test/Opensteer/Workspaces",
  });
  return {
    browsers,
    catalog,
    computerUse,
    credentials,
    files,
    host,
    lifecycle,
    localRuntimes,
    logs,
    processes,
    release,
    releaseValue,
    supervisor,
  };
}

type SupervisorFixture = ReturnType<typeof supervisorFixture>;

function childrenOf(fixture: SupervisorFixture, component: PersonalProcessSpec["component"]) {
  return fixture.processes.children.filter((child) => child.component === component);
}

function specsOf(fixture: SupervisorFixture, component: "host" | "runner") {
  return fixture.processes.specs.filter((spec) => spec.component === component);
}

function observeStatus(
  supervisor: PersonalDeploymentSupervisor,
): DesktopPersonalDeploymentStatus[] {
  const observed: DesktopPersonalDeploymentStatus[] = [];
  supervisor.subscribe((status) => observed.push(status));
  return observed;
}

/** Recovered means degraded first, then every component ready again. */
async function waitForRecovery(
  fixture: SupervisorFixture,
  observed: readonly DesktopPersonalDeploymentStatus[],
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(observed.some(({ state }) => state === "degraded")).toBe(true);
      expect(fixture.supervisor.status).toMatchObject({
        components: {
          browser: { state: "ready" },
          host: { state: "ready" },
          messaging: { state: "ready" },
          postgresql: { state: "ready" },
          runner: { state: "ready" },
        },
        state: "ready",
      });
    },
    { interval: 5 },
  );
}

class MemoryPersonalFiles implements PersonalDeploymentFilesystemPort {
  databasePresent: boolean;
  failNextSave = false;
  manifest: PersonalDeploymentManifest | null;
  readonly create = vi.fn(async (input: Omit<PersonalDeploymentManifest, "revision">) => {
    this.manifest ??= { ...input, revision: 0 };
    return this.manifest;
  });
  readonly paths: PersonalDeploymentPreparedPaths = {
    browserProfileRoot: "/data/browser-profiles",
    browserProfilesDirectory: "/data/browser-profiles",
    credentialKeyPath: "/data/host/credentials.key",
    hostDataDirectory: "/data/host",
    hostPrivateKeyPath: "/data/host/private.pem",
    hostPublicKeyPath: "/data/host/public.pem",
    logsDirectory: "/data/logs",
    manifestPath: "/data/deployment.json",
    messagingDataDirectory: "/data/channel-runtime",
    postgresDataDirectory: "/data/postgres",
    postgresLogPath: "/data/logs/postgres.log",
    rootDirectory: "/data",
    runnerDataDirectory: "/data/runner",
    runtimeDirectory: "/data/runtime",
    temporaryDirectory: "/data/tmp",
    workspaceRegistryPath: "/data/runner/workspace-bindings.v1.json",
    workspaceRoot: "/Users/test/Opensteer/Workspaces",
  };

  constructor(manifest: PersonalDeploymentManifest | null) {
    this.manifest = manifest;
    this.databasePresent = manifest?.databaseInitialized ?? false;
  }

  async commitCompatibleRelease(
    previous: PersonalDeploymentManifest,
    release: PersonalDeploymentManifest["release"],
    updatedAt: string,
  ): Promise<PersonalDeploymentManifest> {
    for (const [before, after] of [
      [previous.release.hostVersion, release.hostVersion],
      [previous.release.postgresVersion, release.postgresVersion],
      [previous.release.runnerVersion, release.runnerVersion],
    ] as const) {
      if (numericVersion(after) < numericVersion(before)) {
        throw new PersonalRuntimeTransitionError("Personal runtime updates cannot move backward.");
      }
    }
    return this.save(previous, {
      ...previous,
      release,
      revision: previous.revision + 1,
      updatedAt,
    });
  }

  async load(): Promise<PersonalDeploymentManifest | null> {
    return this.manifest;
  }

  async inspectDatabase(): Promise<"empty" | "initialized" | "inconsistent"> {
    return this.databasePresent ? "initialized" : "empty";
  }

  readonly snapshotDatabase = vi.fn(async () => "20261028T120000Z-1.2.3");

  readonly stageDatabaseInitPassword = vi.fn(
    async (_: PersonalDeploymentManifest, password: string) => {
      this.stagedDatabasePassword = password;
      return "/data/tmp/initdb-password";
    },
  );

  readonly discardDatabaseInitPassword = vi.fn(async () => {
    this.stagedDatabasePassword = null;
  });

  stagedDatabasePassword: string | null = null;

  async prepare(): Promise<PersonalDeploymentPreparedPaths> {
    return this.paths;
  }

  async save(
    previous: PersonalDeploymentManifest,
    next: PersonalDeploymentManifest,
  ): Promise<PersonalDeploymentManifest> {
    if (this.manifest?.revision !== previous.revision) throw new Error("concurrent manifest");
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("simulated manifest interruption");
    }
    this.manifest = next;
    return next;
  }
}

function numericVersion(value: string): number {
  const [major = 0, minor = 0, patch = 0] = value.split(".").map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

class MemoryProcesses implements PersonalProcessPort {
  readonly children: MemoryChild[] = [];
  readonly kills: string[] = [];
  readonly specs: PersonalProcessSpec[] = [];
  readonly refuseToSpawn = new Set<PersonalProcessSpec["component"]>();
  readonly #files: MemoryPersonalFiles;
  readonly #lifecycle: string[];

  constructor(files: MemoryPersonalFiles, lifecycle: string[]) {
    this.#files = files;
    this.#lifecycle = lifecycle;
  }

  async run(spec: PersonalProcessSpec) {
    this.specs.push(spec);
    if (spec.executable.endsWith("initdb")) {
      this.#files.databasePresent = true;
    }
    return { code: 0, signal: null, stderr: "", stdout: "" };
  }

  spawn(spec: PersonalProcessSpec): PersonalChildProcess {
    this.specs.push(spec);
    if (this.refuseToSpawn.has(spec.component)) {
      throw new Error(`${spec.component} executable is missing from this release`);
    }
    this.#lifecycle.push(`${spec.component}.spawn`);
    const child = new MemoryChild(spec.component, this.kills, this.#lifecycle);
    this.children.push(child);
    return child;
  }
}

class MemoryChild extends EventEmitter implements PersonalChildProcess {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly component: PersonalProcessSpec["component"];
  readonly #kills: string[];
  readonly #lifecycle: string[];

  constructor(component: PersonalProcessSpec["component"], kills: string[], lifecycle: string[]) {
    super();
    this.component = component;
    this.#kills = kills;
    this.#lifecycle = lifecycle;
  }

  async terminate(mode: "force" | "graceful"): Promise<void> {
    const signal = mode === "graceful" ? "SIGTERM" : "SIGKILL";
    this.#kills.push(`${this.component}:${signal}`);
    this.#lifecycle.push(`${this.component}.stop`);
    this.stderr.end();
    this.stdout.end();
    queueMicrotask(() => this.emit("exit", 0, signal));
  }
}

class TestLocalBrowserHandle implements PersonalLocalBrowserHandle {
  readonly bridgeToken = "bridge-token";
  readonly runtimeId: string;
  readonly signIn = true;
  readonly url = new URL("http://127.0.0.1:4399");
  readonly #lifecycle: string[];
  readonly stop = vi.fn(async () => {
    this.#lifecycle.push("browser.stop");
  });

  constructor(lifecycle: string[], runtimeId: string) {
    this.#lifecycle = lifecycle;
    this.#lifecycle.push("browser.start");
    this.runtimeId = runtimeId;
  }
}

function deploymentManifest(
  overrides: Partial<PersonalDeploymentManifest> = {},
): PersonalDeploymentManifest {
  return {
    createdAt: "2026-08-12T12:00:00.000Z",
    databaseInitialized: false,
    deploymentId: createId("deployment"),
    environmentId: createId("environment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
    hostPort: 4310,
    name: "This computer",
    ownerInitialized: false,
    postgresPort: 4311,
    release: verifiedRelease().identity,
    revision: 0,
    runnerId: createId("runner") as RunnerId,
    schemaVersion: 3,
    setupIntentId: "019ff6c2-309a-7380-9093-e126eb2bda4b",
    updatedAt: "2026-08-12T12:00:00.000Z",
    workspaceRoot: "/Users/test/Opensteer/Workspaces",
    ...overrides,
  };
}

function verifiedRelease(
  overrides: Partial<
    Pick<
      VerifiedPersonalRuntimeRelease["identity"],
      "hostVersion" | "postgresMajor" | "postgresVersion" | "runnerVersion"
    >
  > = {},
): VerifiedPersonalRuntimeRelease {
  const entrypoints = {
    browserHarness: "/release/browser-harness",
    channelRuntime: "/release/channel-runtime",
    host: "/release/host",
    initdb: "/release/initdb",
    nativeFsHelper: "/release/native-fs",
    node: "/release/node",
    pgIsReady: "/release/pg-isready",
    postgres: "/release/postgres",
    runner: "/release/runner",
  };
  const identity = {
    architecture: "arm64" as const,
    hostVersion: "1.2.3",
    manifestSha256: "a".repeat(64),
    operatingSystem: "darwin" as const,
    postgresMajor: 17,
    postgresVersion: "17.4.0",
    runnerVersion: "2.3.4",
    ...overrides,
  };
  identity.manifestSha256 = JSON.stringify(overrides) === "{}" ? "a".repeat(64) : "b".repeat(64);
  return {
    assets: {
      agentSkills: "/release/agent-skills",
      webDistribution: {
        directory: "/release/web",
        hostVersion: "1.2.3",
        manifestPath: "/release/web/opensteer-web.json",
      },
    },
    directory: "/release",
    entrypoints,
    harnesses: {
      codex: "/release/codex/bin/codex",
      opencode: "/release/bin/opencode",
      pi: "/release/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    },
    identity,
    manifest: {
      architecture: "arm64",
      assets: {
        agentSkills: "agent-skills",
        webDistribution: {
          directory: "web",
          hostVersion: "1.2.3",
          manifest: "web/opensteer-web.json",
        },
      },
      entrypoints: {
        browserHarness: "browser-harness",
        channelRuntime: "channel-runtime",
        host: "host",
        initdb: "initdb",
        nativeFsHelper: "native-fs",
        node: "node",
        pgIsReady: "pg-isready",
        postgres: "postgres",
        runner: "runner",
      },
      files: [
        ...Object.keys(entrypoints).map((name) => ({
          mode: "executable" as const,
          path:
            name === "browserHarness"
              ? "browser-harness"
              : name === "channelRuntime"
                ? "channel-runtime"
                : name === "pgIsReady"
                  ? "pg-isready"
                  : name === "nativeFsHelper"
                    ? "native-fs"
                    : name,
          sha256: "a".repeat(64),
        })),
        { mode: "executable" as const, path: "codex/bin/codex", sha256: "a".repeat(64) },
        { mode: "executable" as const, path: "bin/opencode", sha256: "a".repeat(64) },
        {
          mode: "code" as const,
          path: "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
          sha256: "a".repeat(64),
        },
        { mode: "data" as const, path: "agent-skills/plugin.json", sha256: "a".repeat(64) },
        {
          mode: "data" as const,
          path: "agent-skills/skills/test/SKILL.md",
          sha256: "a".repeat(64),
        },
        { mode: "data" as const, path: "web/index.html", sha256: "a".repeat(64) },
        {
          mode: "data" as const,
          path: "web/opensteer-web.json",
          sha256: "a".repeat(64),
        },
      ],
      harnesses: {
        codex: "codex/bin/codex",
        opencode: "bin/opencode",
        pi: "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      },
      hostVersion: "1.2.3",
      operatingSystem: "darwin",
      postgresMajor: 17,
      postgresVersion: "17.4.0",
      runnerVersion: "2.3.4",
      schemaVersion: 7,
      ...overrides,
    },
  };
}

/** A file-system error as Node raises it. */
function diskError(code: "EIO" | "EMFILE" | "ENOSPC"): NodeJS.ErrnoException {
  const text = {
    EIO: "i/o error",
    EMFILE: "too many open files",
    ENOSPC: "no space left on device",
  }[code];
  const filePath = "/Users/test/Library/Application Support/Opensteer/personal";
  return Object.assign(new Error(`${code}: ${text}, open '${filePath}'`), {
    code,
    path: filePath,
    syscall: "open",
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

it.each([false, true])(
  "starts the Personal Host with its configured passkey flag (%s)",
  async (passkeys) => {
    const fixture = supervisorFixture(
      null,
      undefined,
      verifiedRelease(),
      { assertAvailable: async () => undefined },
      { passkeys },
    );
    try {
      await fixture.supervisor.start();
      expect(
        fixture.processes.specs.find(({ component }) => component === "host")?.environment
          .OPENSTEER_PASSKEYS,
      ).toBe(passkeys ? "1" : "0");
    } finally {
      await fixture.supervisor.stop();
    }
  },
);
