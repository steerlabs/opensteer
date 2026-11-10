import { DesktopBrowserProfileErasure } from "./browser-profile-erasure.js";
import { desktopDeploymentPaths } from "../app/application-paths.js";
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
  DeploymentIdSchema,
  harnessCatalog,
  harnessExecutableEnvironmentVariable,
  shipsHarnessRuntimeBytes,
  shippedHarnessKindRecord,
  shippedHarnessKinds,
  type DeploymentId,
  type EnvironmentId,
  type RunnerId,
} from "@opensteer/core";
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
    expect(preference).toEqual({
      runners: {
        [first.deploymentId]: { enrolled: true, runAgents: true, runnerName: "Office Mac" },
        [second.deploymentId]: { enrolled: true, runAgents: true, runnerName: "Office Mac" },
      },
      version: 4,
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
        [first.deploymentId]: { enrolled: true },
        [second.deploymentId]: { enrolled: true },
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
    const removing = running.service.remove(first.deploymentId);
    await eventually(() => hasStopMessage(firstChild));
    expect(hasStopMessage(secondChild)).toBe(false);
    firstChild.emit("exit", 0);
    await expect(removing).resolves.toMatchObject({ runner: { state: "disabled" } });

    await expect(
      readFile(path.join(directory, "runner", "desktop-runner.json"), "utf8").then(JSON.parse),
    ).resolves.toEqual({
      runners: {
        [second.deploymentId]: { enrolled: true, runAgents: true, runnerName: "Studio Mac" },
      },
      version: 4,
    });
    await expect(running.service.status(second.deploymentId)).resolves.toMatchObject({
      runner: { state: "running" },
    });
  });

  it("stops and forgets a Runner when its Deployment leaves the catalog", async () => {
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
      return status.runner.detail === "The Deployment was removed from this computer.";
    });

    await expect(running.service.hasEnrolledRunners()).resolves.toBe(false);
    await expect(running.service.status(target.deploymentId)).resolves.toMatchObject({
      runner: { detail: "The Deployment was removed from this computer.", state: "disabled" },
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
    const personal = targets.add("https://studio.connect.opensteer.test", "personal");
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
    expect(preference).toEqual({
      runners: {
        [personal.deploymentId]: { enrolled: true, runAgents: false, runnerName: "Studio Mac" },
      },
      version: 4,
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
    const personal = targets.add("https://studio.connect.opensteer.test", "personal");
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
      path.join(directory, "runner", "deployments", target.deploymentId, "runner-identity.json"),
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
        path.join(directory, "runner", "deployments", target.deploymentId, "runner-identity.json"),
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
    await expect(readFile(preferencePath, "utf8").then(JSON.parse)).resolves.toEqual({
      runners: {
        [target.deploymentId]: { enrolled: true, runAgents: true, runnerName: "Office Mac" },
      },
      version: 4,
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
        detail: "This Mac never finished joining; remove it and add it again.",
        state: "failed",
      },
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(relaunched.fork).not.toHaveBeenCalled();

    await expect(relaunched.service.remove(target.deploymentId)).resolves.toMatchObject({
      runner: { detail: "This Mac is not in this Deployment.", state: "disabled" },
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

    const removing = running.service.remove(target.deploymentId);
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

    const removing = running.service.remove(target.deploymentId);
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

    const removing = running.service.remove(target.deploymentId);
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
    const removing = running.service.remove(target.deploymentId);
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

    await expect(running.service.remove(target.deploymentId)).rejects.toThrow(
      "The Runner on this Mac is still running, so nothing was deleted.",
    );

    // Nothing was deleted, and the computer is still a member until it is.
    await expect(lstat(dataDirectory)).resolves.toBeDefined();
    await expect(running.service.hasEnrolledRunners()).resolves.toBe(true);
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
    const removing = running.service.remove(target.deploymentId);
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
    await expect(lstat(path.join(dataDirectory, "runner-identity.json"))).resolves.toBeDefined();

    const removing = running.service.remove(target.deploymentId);
    await eventually(() => hasStopMessage(child));
    child.emit("exit", 0);

    await expect(removing).resolves.toMatchObject({
      runAgents: false,
      runner: {
        detail: "This Mac is not in this Deployment.",
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

  it("runs agents with local-directory Workspace storage", async () => {
    const directory = await temporaryDirectory();
    const targets = mutableTargetAuthority();
    const target = targets.add(
      "https://local-workspaces.opensteer.test",
      "server",
      "local-directory",
    );
    const running = fixture(await configuration(directory), targets);

    const start = running.service.start(startInput(target.deploymentId));
    await eventually(() => running.children.length === 1);
    const child = childAt(running.children, 0);
    expect(child.environment.OPENSTEER_DEFAULT_WORKSPACE_BACKING).toBe("local-directory");
    expect(child.environment.OPENSTEER_RUNNER_WORKSPACE_BACKINGS).toBe("local-directory");
    connect(child);

    await expect(start).resolves.toMatchObject({ runner: { state: "running" } });
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
    const removing = running.service.remove(target.deploymentId);
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
    await running.service.remove(target.deploymentId);
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
    const removing = running.service.remove(personal.deploymentId);
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

function fixture(
  config: DesktopConfiguration,
  targets: DesktopLocalRunnerTargetAuthority,
  restartDelayMs?: (attempt: number) => number,
  browser?: LocalRunnerServiceDependencies["browser"],
  options: {
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
    if (!existsSync(identityPath(forkOptions.cwd))) writeTestIdentity(forkOptions.cwd, false);
    const child = new FakeUtilityProcess(
      forkOptions.env,
      forkOptions.cwd,
      options.stubborn ?? false,
    );
    children.push(child);
    return child;
  });
  return {
    children,
    fork,
    service: new LocalRunnerService(config, {
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
    kind?: "personal" | "server",
    defaultWorkspaceBacking?: "local-directory",
  ): DesktopLocalRunnerTarget;
  changeRoute(deploymentId: DeploymentId, hostUrl: string): void;
  notify(): void;
  remove(deploymentId: DeploymentId): void;
} {
  const targets = new Map<DeploymentId, DesktopLocalRunnerTarget>();
  const listeners = new Set<() => void>();
  return {
    add: (hostUrl, kind = "server", defaultWorkspaceBacking = "local-directory") => {
      const deploymentId = createId("deployment");
      const target: DesktopLocalRunnerTarget = {
        deploymentId,
        deploymentShape: { defaultWorkspaceBacking, kind },
        hostUrl,
        key: `${deploymentId}:1`,
        // Only server Deployments may run agents on a connecting computer.
        mayRunAgents: kind === "server",
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
  return path.join(dataDirectory, "runner-identity.json");
}

function writeTestIdentity(
  dataDirectory: string,
  enrolled: boolean,
  identity?: { readonly environmentId: string; readonly runnerId: string },
): void {
  writeFileSync(
    identityPath(dataDirectory),
    JSON.stringify({
      enrolled,
      environmentId: identity?.environmentId ?? createId("environment"),
      runnerId: identity?.runnerId ?? createId("runner"),
    }),
    { mode: 0o600 },
  );
}

function readTestIdentity(dataDirectory: string) {
  if (!existsSync(identityPath(dataDirectory))) return null;
  return JSON.parse(readFileSync(identityPath(dataDirectory), "utf8")) as {
    readonly enrolled: boolean;
    readonly environmentId: EnvironmentId;
    readonly runnerId: RunnerId;
  };
}

/** The credentials the service posted to the worker, which it posts first. */
function postedSecrets(child: FakeUtilityProcess): Readonly<Record<string, string>> {
  const posted = RunnerWorkerSecretsMessageSchema.safeParse(child.messages[0]);
  if (!posted.success) throw new Error("The worker was not sent its secrets first.");
  return posted.data.secrets;
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
      workspaceRoot: path.join(directory, "workspaces"),
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
