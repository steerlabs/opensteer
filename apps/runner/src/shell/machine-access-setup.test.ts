import { createId, harnessKinds, type ThreadAccessMode } from "@opensteer/core";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
import {
  ShellRelayResponseSchema,
  type MachineAccessRunContext,
  type MachineAccessRunMachine,
} from "@opensteer/protocol";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  harnessLaunchValidationHook,
  isMachineAccessEligible,
  isMachineAccessRoutes,
  isMachineAccessSetup,
  fitMachineAccessNotice,
  machineAccessNoticeMaxBytes,
  machineAccessUnavailableReason,
  machineAccessUnavailableSentence,
  noReachableComputersNotice,
  planMachineAccess,
  renderMachineAccessNotice,
  renderSshConfig,
  setupMachineAccess,
  type MachineAccessOutcome,
  type MachineAccessSetup,
  type MachineAccessUnavailableReason,
  type MachineAccessValidationCommand,
  type MachineAccessValidationHook,
} from "./machine-access-setup.js";

const executeFile = promisify(execFile);
const canonicalHostKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
const nativeFsHelper = resolve("apps/runner/native-fs-helper/opensteer-native-fs-test");
// Built by the root `pretest`, like the native-fs test helper above, into a directory
// named with Go's architecture names (amd64, not Node's x64).
const processSupervisor = resolve(
  "apps/desktop/generated-native",
  `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
  "opensteer-process-supervisor",
);
/** What a Runner-owned launch wrapper leaves behind on every command it wraps. */
const wrapMarker = "--opensteer-wrapped";
const modelMarker = "--opensteer-model-sandbox";
const temporaryDirectories: string[] = [];
const httpServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("machine access eligibility", () => {
  it("refuses Windows and unknown drivers with the reason each carries", () => {
    expect(isMachineAccessEligible("win32", "claude", "full-access")).toBe(false);
    expect(machineAccessUnavailableReason("win32", "claude", "full-access")).toBe("platform");
    expect(machineAccessUnavailableReason("win32", "codex", "auto")).toBe("platform");
    expect(isMachineAccessEligible("linux", "other", "full-access")).toBe(false);
    expect(machineAccessUnavailableReason("linux", "other", "full-access")).toBe(
      "driver-unsupported",
    );
    expect(machineAccessUnavailableReason("darwin", "other", "auto")).toBe("driver-unsupported");
  });

  it("agrees with the measured machine-access support matrix", () => {
    // The matrix as measured: platform, engine, access mode, reachable. This
    // table is its written record; the catalog is what the Runner reads, so an
    // engine cannot arrive, or a cell change, without the measurement moving too.
    const matrix: readonly [NodeJS.Platform, string, ThreadAccessMode, boolean][] = [
      ["darwin", "claude", "approval-required", true],
      ["darwin", "claude", "auto-accept-edits", true],
      ["darwin", "claude", "auto", true],
      ["darwin", "claude", "full-access", true],
      ["linux", "claude", "approval-required", true],
      ["linux", "claude", "auto-accept-edits", true],
      ["linux", "claude", "auto", true],
      ["linux", "claude", "full-access", true],
      ["darwin", "codex", "approval-required", false],
      ["darwin", "codex", "auto-accept-edits", false],
      ["darwin", "codex", "auto", false],
      ["darwin", "codex", "full-access", true],
      ["linux", "codex", "approval-required", false],
      ["linux", "codex", "auto-accept-edits", false],
      ["linux", "codex", "auto", false],
      ["linux", "codex", "full-access", true],
      ["win32", "claude", "full-access", false],
      ["win32", "codex", "full-access", false],
      // Grok's command sandbox has not been qualified against the relay, so
      // every cell remains denied until a real measurement proves otherwise.
      ["darwin", "grok", "approval-required", false],
      ["darwin", "grok", "auto", false],
      ["darwin", "grok", "full-access", false],
      ["linux", "grok", "approval-required", false],
      ["linux", "grok", "auto", false],
      ["linux", "grok", "full-access", false],
      ["win32", "grok", "full-access", false],
      // OpenCode, Pi and Cursor have no command sandbox of their own and run
      // only on native-user Runners, so a model-run command reaches the relay
      // in every mode. The darwin rows were measured 2026-09-17; the linux rows
      // are inferred from the absence of a command sandbox, which holds because
      // for these engines the access mode decides only whether a command is
      // asked about, never what a running command may reach.
      ["darwin", "opencode", "approval-required", true],
      ["darwin", "opencode", "full-access", true],
      ["linux", "opencode", "full-access", true],
      ["win32", "opencode", "full-access", false],
      ["darwin", "pi", "approval-required", true],
      ["darwin", "pi", "full-access", true],
      ["linux", "pi", "full-access", true],
      ["win32", "pi", "full-access", false],
      ["darwin", "cursor", "approval-required", true],
      ["darwin", "cursor", "full-access", true],
      ["linux", "cursor", "full-access", true],
      ["win32", "cursor", "full-access", false],
    ];
    for (const [platform, driverKind, accessMode, reachable] of matrix) {
      expect({
        accessMode,
        driverKind,
        eligible: isMachineAccessEligible(platform, driverKind, accessMode),
        platform,
      }).toEqual({ accessMode, driverKind, eligible: reachable, platform });
    }
    // Every engine the product ships a driver for is in the matrix above, so a
    // new catalog entry cannot arrive with its machine access unmeasured.
    expect([...new Set(matrix.map(([, driverKind]) => driverKind))].sort()).toEqual(
      [...harnessKinds].sort(),
    );
  });
});

describe("machine access launch setup", () => {
  it.skipIf(!hasSsh())("creates validated shims and removes the launch directory", async () => {
    const privateRoot = await temporaryDirectory("private-");
    const execute = vi.fn(executeValidationCommand);
    const setup = ready(
      await setupInWorkspace({
        accessMode: "full-access",
        driverKind: "codex",
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        helperBinary: nativeFsHelper,
        machineAccess: machineContext(),
        platform: process.platform === "linux" ? "linux" : "darwin",
        privateStateRoot: privateRoot,
        runtimeBoundary: { kind: "native-user" },
        transport: {
          controlCaPath: undefined,
          hostUrl: new URL("http://127.0.0.1:1"),
          mode: "development",
        },
        validationHook: { execute },
      }),
    );
    expect(setup.environment.PATH?.startsWith(join(setup.launchDirectory, "bin"))).toBe(true);
    for (const name of ["ssh", "scp", "sftp"]) {
      await access(join(setup.launchDirectory, "bin", name), constants.X_OK);
      expect((await stat(join(setup.launchDirectory, "bin", name))).mode & 0o777).toBe(0o700);
    }
    expect(await readFile(join(setup.launchDirectory, "bin", "ssh"), "utf8")).toContain(
      await executableOnPath("ssh"),
    );
    expect((await stat(join(setup.launchDirectory, "ssh_config"))).mode & 0o777).toBe(0o600);
    expect(execute.mock.calls.map(([command]) => command.arguments[0])).toEqual([
      "-G",
      "ssh-proxy",
    ]);
    const launch = setup.launchDirectory;
    await setup.close();
    await expect(stat(launch)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(!hasSsh())(
    "validates an isolated-service Runner's launch surface with the production hook",
    async () => {
      const root = await shortTemporaryDirectory("opensteer-default-hook-");
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const setup = ready(
        await setupInWorkspace({
          accessMode: "auto",
          driverKind: "claude",
          environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          helperBinary: nativeFsHelper,
          machineAccess: machineContext(),
          platform: process.platform === "linux" ? "linux" : "darwin",
          privateStateRoot: join(root, "private"),
          // The cloud path: nothing injects a hook, and setup must still prove
          // its own launch surface rather than omit access.
          runtimeBoundary: { kind: "isolated-service" },
          temporaryDirectory: root,
          transport: {
            controlCaPath: undefined,
            hostUrl: new URL("http://127.0.0.1:1"),
            mode: "development",
          },
          workspacePath: workspace,
        }),
      );

      expect(setup.machineAccessNotice).toContain("alpha");
      expect(setup.environment.PATH?.startsWith(join(setup.launchDirectory, "bin"))).toBe(true);
      await setup.close();
    },
  );

  it.skipIf(!hasSsh())("sets up Codex on an isolated-service Runner at full access", async () => {
    // The combination eligibility used to refuse outright: Codex's sandbox
    // allows the relay socket once Full access turns its network on, and the
    // Runner boundary no longer changes that.
    const root = await shortTemporaryDirectory("opensteer-codex-isolated-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const setup = ready(
      await setupInWorkspace({
        accessMode: "full-access",
        driverKind: "codex",
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        helperBinary: nativeFsHelper,
        machineAccess: machineContext(),
        platform: process.platform === "linux" ? "linux" : "darwin",
        privateStateRoot: join(root, "private"),
        runtimeBoundary: { kind: "isolated-service" },
        temporaryDirectory: root,
        transport: {
          controlCaPath: undefined,
          hostUrl: new URL("http://127.0.0.1:1"),
          mode: "development",
        },
        validationHook: { execute: executeValidationCommand },
        workspacePath: workspace,
      }),
    );

    expect(setup.machineAccessNotice).toContain("alpha");
    await setup.close();
  });

  it.skipIf(!hasSsh())(
    "runs the setup probe through the Runner's process-launch wrapper",
    async () => {
      // The probe proves the launch surface only if it goes through the same
      // seam the harness process tree will: an isolated-service Runner wraps
      // every launch, and a probe that skipped the wrapper would prove nothing.
      const root = await shortTemporaryDirectory("opensteer-wrapped-probe-");
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const wrapperDirectories: string[] = [];
      const wrapped: string[] = [];
      const execute = vi.fn(async (command: MachineAccessValidationCommand) => {
        // The wrapper's marker must survive all the way to the launch.
        expect(command.arguments[0]).toBe(wrapMarker);
        return executeValidationCommand({ ...command, arguments: command.arguments.slice(2) });
      });
      const setup = ready(
        await setupInWorkspace({
          accessMode: "auto",
          driverKind: "claude",
          environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          helperBinary: nativeFsHelper,
          machineAccess: machineContext(),
          platform: process.platform === "linux" ? "linux" : "darwin",
          privateStateRoot: join(root, "private"),
          runtimeBoundary: { kind: "isolated-service" },
          temporaryDirectory: root,
          transport: {
            controlCaPath: undefined,
            hostUrl: new URL("http://127.0.0.1:1"),
            mode: "development",
          },
          validationHook: { execute },
          // The harness's own command sandbox wraps first, the Runner's
          // sandbox around it, exactly as a model command would be launched.
          wrapModelCommand: (launch) => ({ ...launch, args: [modelMarker, ...launch.args] }),
          wrapProcessLaunch: async (launchDirectory) => {
            wrapperDirectories.push(launchDirectory);
            return (launch) => {
              wrapped.push(launch.executable);
              return { ...launch, args: [wrapMarker, ...launch.args] };
            };
          },
          workspacePath: workspace,
        }),
      );

      // One wrapper per Run, built for the launch directory the Run got.
      expect(wrapperDirectories).toEqual([setup.launchDirectory]);
      expect(wrapped).toEqual(["ssh", resolve(nativeFsHelper)]);
      expect(execute.mock.calls.map(([command]) => command.arguments)).toEqual([
        [wrapMarker, modelMarker, "-G", "alpha"],
        [
          wrapMarker,
          modelMarker,
          "ssh-proxy",
          "--relay",
          setup.machineAccessRelaySocket,
          expect.stringMatching(/^rnr_/u),
        ],
      ]);
      await setup.close();
    },
  );

  it.skipIf(!hasSsh())(
    "omits access when the production hook cannot execute the managed ssh shim",
    async () => {
      const root = await shortTemporaryDirectory("opensteer-unexecutable-shim-");
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const logger = { error: vi.fn(), info: vi.fn() };
      const setup = await setupInWorkspace({
        accessMode: "auto",
        driverKind: "claude",
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        helperBinary: nativeFsHelper,
        logger,
        machineAccess: machineContext(),
        platform: process.platform === "linux" ? "linux" : "darwin",
        privateStateRoot: join(root, "private"),
        runtimeBoundary: { kind: "isolated-service" },
        temporaryDirectory: root,
        transport: {
          controlCaPath: undefined,
          hostUrl: new URL("http://127.0.0.1:1"),
          mode: "development",
        },
        // The real probe, against a launch directory whose shim this Runner
        // cannot execute — what a hostile mount or a lost bit looks like.
        validationHook: {
          execute: async (command) => {
            const binDirectory = command.environment.PATH?.split(delimiter)[0] ?? "";
            await chmod(join(binDirectory, "ssh"), 0o600);
            return harnessLaunchValidationHook.execute(command);
          },
        },
        workspacePath: workspace,
      });

      expect(setup).toEqual({ reason: "probe-failed" });
      expect(await readdir(root)).toEqual(["workspace"]);
      // The unexecutable shim is skipped, PATH falls through to the ambient
      // ssh, and that ssh knows nothing of the managed alias: the probe fails
      // rather than validating a configuration the harness would never get.
      expect(logger.error).toHaveBeenCalledWith("Machine access was not set up for this Run", {
        error: "OpenSSH did not resolve the managed machine configuration as expected",
      });
    },
  );

  it.skipIf(!hasSsh())(
    "sets up through the native process supervisor, as packaged Runners launch the probe",
    async () => {
      // The packaged desktop app names its supervisor in this variable, and
      // the supervisor runs only absolute targets.
      await access(processSupervisor, constants.X_OK);
      vi.stubEnv(processSupervisorExecutableVariable, processSupervisor);
      const root = await shortTemporaryDirectory("opensteer-supervised-probe-");
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const logger = { error: vi.fn(), info: vi.fn() };
      try {
        const setup = ready(
          await setupInWorkspace({
            accessMode: "auto",
            driverKind: "claude",
            environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
            helperBinary: nativeFsHelper,
            logger,
            machineAccess: machineContext(),
            platform: process.platform === "linux" ? "linux" : "darwin",
            privateStateRoot: join(root, "private"),
            runtimeBoundary: { kind: "isolated-service" },
            temporaryDirectory: root,
            transport: {
              controlCaPath: undefined,
              hostUrl: new URL("http://127.0.0.1:1"),
              mode: "development",
            },
            workspacePath: workspace,
          }),
        );
        expect(logger.error).not.toHaveBeenCalled();
        await setup.close();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.skipIf(!hasSsh())("runs the probe in the Run's Workspace, shims first on PATH", async () => {
    const root = await shortTemporaryDirectory("opensteer-probe-launch-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const execute = vi.fn(executeValidationCommand);
    const setup = ready(
      await setupInWorkspace({
        accessMode: "auto",
        driverKind: "claude",
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        helperBinary: nativeFsHelper,
        machineAccess: machineContext(),
        platform: process.platform === "linux" ? "linux" : "darwin",
        privateStateRoot: join(root, "private"),
        runtimeBoundary: { kind: "isolated-service" },
        temporaryDirectory: root,
        transport: {
          controlCaPath: undefined,
          hostUrl: new URL("http://127.0.0.1:1"),
          mode: "development",
        },
        validationHook: { execute },
        workspacePath: workspace,
      }),
    );

    for (const [command] of execute.mock.calls) {
      expect(command.workingDirectory).toBe(workspace);
      expect(command.environment.PATH?.split(delimiter)[0]).toBe(
        join(setup.launchDirectory, "bin"),
      );
    }
    await setup.close();
  });

  it.skipIf(!hasSsh())("sets up with ssh alone and still renders the notice", async () => {
    const root = await shortTemporaryDirectory("opensteer-ssh-only-");
    const clientBin = join(root, "client-bin");
    await mkdir(clientBin);
    await symlink(await executableOnPath("ssh"), join(clientBin, "ssh"));
    const setup = ready(
      await setupInWorkspace({
        accessMode: "full-access",
        driverKind: "claude",
        // scp and sftp are absent: ssh alone is the prerequisite.
        environment: { PATH: clientBin },
        helperBinary: nativeFsHelper,
        machineAccess: machineContext(),
        platform: process.platform === "linux" ? "linux" : "darwin",
        privateStateRoot: join(root, "private"),
        runtimeBoundary: { kind: "native-user" },
        temporaryDirectory: root,
        transport: {
          controlCaPath: undefined,
          hostUrl: new URL("http://127.0.0.1:1"),
          mode: "development",
        },
        validationHook: { execute: executeValidationCommand },
      }),
    );

    expect(await readdir(join(setup.launchDirectory, "bin"))).toEqual(["ssh"]);
    expect(setup.machineAccessNotice).toContain(
      "alpha (macOS, online): shares /Users/test/Projects (read-write); commands allowed; port forwarding allowed.",
    );
    await setup.close();
  });

  it.skipIf(!hasSsh())("reports probe failure as a reason and cleans up", async () => {
    const root = await mkdtemp("/tmp/opensteer-failed-probe-");
    temporaryDirectories.push(root);
    const logger = { error: vi.fn(), info: vi.fn() };
    const setup = await setupInWorkspace({
      accessMode: "full-access",
      driverKind: "claude",
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      helperBinary: nativeFsHelper,
      logger,
      machineAccess: machineContext(),
      platform: process.platform === "linux" ? "linux" : "darwin",
      privateStateRoot: join(root, "private"),
      runtimeBoundary: { kind: "isolated-service" },
      temporaryDirectory: root,
      transport: {
        controlCaPath: undefined,
        hostUrl: new URL("http://127.0.0.1:1"),
        mode: "development",
      },
      validationHook: {
        execute: async () => {
          throw new Error("sandbox refused the relay socket");
        },
      },
    });

    expect(setup).toEqual({ reason: "probe-failed" });
    expect(await readdir(root)).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "Machine access was not set up for this Run",
      expect.objectContaining({ error: "sandbox refused the relay socket" }),
    );
  });

  it.skipIf(!hasSsh())(
    "fails the Run, not the probe, when the sandbox cannot be planned",
    async () => {
      const root = await mkdtemp("/tmp/opensteer-unplanned-");
      temporaryDirectories.push(root);
      const logger = { error: vi.fn(), info: vi.fn() };
      const execute = vi.fn(executeValidationCommand);
      await expect(
        setupInWorkspace({
          accessMode: "full-access",
          driverKind: "claude",
          environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          helperBinary: nativeFsHelper,
          logger,
          machineAccess: machineContext(),
          platform: process.platform === "linux" ? "linux" : "darwin",
          privateStateRoot: join(root, "private"),
          runtimeBoundary: { kind: "isolated-service" },
          temporaryDirectory: root,
          transport: {
            controlCaPath: undefined,
            hostUrl: new URL("http://127.0.0.1:1"),
            mode: "development",
          },
          validationHook: { execute },
          wrapProcessLaunch: async () => {
            throw new Error("Workspace overlaps the Runner data directory");
          },
        }),
      ).rejects.toThrow("Workspace overlaps the Runner data directory");
      // Nothing was probed, nothing was left behind, and nothing was logged as
      // a probe failure: the caller reports this as the Run's own failure.
      expect(execute).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it("leaves no launch resources when the socket path is too long", async () => {
    const root = await temporaryDirectory("long-");
    const longBase = join(root, "x".repeat(90));
    await mkdir(longBase);
    const setup = await setupInWorkspace({
      accessMode: "full-access",
      driverKind: "claude",
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      helperBinary: process.execPath,
      machineAccess: machineContext(),
      platform: "darwin",
      privateStateRoot: join(root, "private"),
      runtimeBoundary: { kind: "native-user" },
      temporaryDirectory: longBase,
      transport: {
        controlCaPath: undefined,
        hostUrl: new URL("http://127.0.0.1:1"),
        mode: "development",
      },
    });
    expect(setup).toEqual({ reason: "probe-failed" });
    expect(await stat(longBase).then(() => true)).toBe(true);
  });

  it("reports a Runner with no ssh client", async () => {
    const root = await temporaryDirectory("no-ssh-");
    expect(
      await setupInWorkspace({
        accessMode: "full-access",
        driverKind: "claude",
        environment: { PATH: root },
        helperBinary: process.execPath,
        machineAccess: machineContext(),
        platform: "linux",
        privateStateRoot: join(root, "private"),
        runtimeBoundary: { kind: "native-user" },
        transport: {
          controlCaPath: undefined,
          hostUrl: new URL("http://127.0.0.1:1"),
          mode: "development",
        },
      }),
    ).toEqual({ reason: "no-ssh" });
  });

  it("reports why a Codex Run outside Full access has no computers", async () => {
    const root = await temporaryDirectory("codex-sandboxed-");
    const execute = vi.fn<MachineAccessValidationHook["execute"]>();
    // Both boundaries: the sandbox denies connect() on either one outside Full
    // access, so nothing is built and the Run is told which of the two it is.
    for (const runtimeBoundary of [
      { kind: "isolated-service" },
      { kind: "native-user" },
    ] as const) {
      const setup = await setupInWorkspace({
        accessMode: "auto",
        driverKind: "codex",
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        helperBinary: process.execPath,
        machineAccess: machineContext(),
        platform: "linux",
        privateStateRoot: join(root, "private"),
        runtimeBoundary,
        transport: {
          controlCaPath: undefined,
          hostUrl: new URL("http://127.0.0.1:1"),
          mode: "development",
        },
        validationHook: { execute },
      });

      expect(setup).toEqual({ reason: "driver-access-mode" });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.skipIf(!hasSsh())(
    "relays bytes after the request newline through a Host WebSocket",
    async () => {
      const host = createServer();
      httpServers.push(host);
      const webSockets = new WebSocketServer({
        maxPayload: 256 * 1024,
        perMessageDeflate: false,
        server: host,
        path: "/internal/v1/shell/connect",
      });
      webSockets.on("connection", (socket) => {
        socket.on("message", (raw) => socket.send(raw, { binary: true }));
      });
      await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
      const address = host.address() as AddressInfo;
      const context = machineContext();
      const setup = await createSetup(context, new URL(`http://127.0.0.1:${address.port}`));
      const response = await relayExchange(
        setup.machineAccessRelaySocket,
        `${JSON.stringify({ target: context.machines[0]?.runnerId })}\nssh-preface`,
        "ssh-preface",
      );
      expect(response).toBe('{"ok":true}\nssh-preface');
      await setup.close();
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    },
  );

  it.skipIf(!hasSsh())(
    "buffers an immediate Host banner and caller bytes sent during admission",
    async () => {
      const host = createServer();
      httpServers.push(host);
      const webSockets = new WebSocketServer({
        maxPayload: 256 * 1024,
        perMessageDeflate: false,
        server: host,
        path: "/internal/v1/shell/connect",
      });
      webSockets.on("connection", (socket) => {
        socket.send(Buffer.from("host-banner"), { binary: true });
        socket.on("message", (raw) => socket.send(raw, { binary: true }));
      });
      await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
      const address = host.address() as AddressInfo;
      const context = machineContext();
      const setup = await createSetup(context, new URL(`http://127.0.0.1:${address.port}`));

      const response = await relayExchangeWrites(
        setup.machineAccessRelaySocket,
        `${JSON.stringify({ target: context.machines[0]?.runnerId })}\n`,
        "caller-early",
        "caller-early",
      );
      expect(response).toBe('{"ok":true}\nhost-bannercaller-early');

      await setup.close();
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    },
  );

  it.skipIf(!hasSsh())("delivers bytes the Host sends before the caller writes any", async () => {
    // The target speaks first: its SSH banner is sent the moment the session
    // activates, which can be before the relay has written its own
    // acknowledgement line. A pump attached one tick later would lose it.
    const host = createServer();
    httpServers.push(host);
    const webSockets = new WebSocketServer({
      maxPayload: 256 * 1024,
      path: "/internal/v1/shell/connect",
      perMessageDeflate: false,
      server: host,
    });
    webSockets.on("connection", (socket) => {
      socket.send(Buffer.from("SSH-2.0-Opensteer\r\n"), { binary: true });
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = host.address() as AddressInfo;
    const context = machineContext();
    const setup = await createSetup(context, new URL(`http://127.0.0.1:${address.port}`));
    const response = await relayExchange(
      setup.machineAccessRelaySocket,
      `${JSON.stringify({ target: context.machines[0]?.runnerId })}\n`,
      "SSH-2.0-Opensteer\r\n",
    );
    expect(response).toBe('{"ok":true}\nSSH-2.0-Opensteer\r\n');
    await setup.close();
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
  });

  it.skipIf(!hasSsh())("returns the Host rejection sentence over the relay protocol", async () => {
    const host = createServer();
    httpServers.push(host);
    host.on("upgrade", (_request, socket) => {
      const body = JSON.stringify({
        error: { code: "reach_denied", message: "build-box does not allow access." },
      });
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = host.address() as AddressInfo;
    const context = machineContext();
    const setup = await createSetup(context, new URL(`http://127.0.0.1:${address.port}`));
    const response = await relayExchange(
      setup.machineAccessRelaySocket,
      `${JSON.stringify({ target: context.machines[0]?.runnerId })}\n`,
      "\n",
    );
    expect(JSON.parse(response)).toEqual({
      message: "build-box does not allow access.",
      ok: false,
    });
    await setup.close();
  });

  it.skipIf(!hasSsh())("parses requests and emits responses with the relay schemas", async () => {
    const setup = await createSetup(machineContext(), new URL("http://127.0.0.1:1"));
    const line = await relayExchange(setup.machineAccessRelaySocket, "{}\n", "\n");
    expect(ShellRelayResponseSchema.parse(JSON.parse(line))).toEqual({
      message: "Shell relay request is invalid.",
      ok: false,
    });
    await setup.close();
  });
});

describe("OpenSSH configuration", () => {
  it.skipIf(!hasSsh())(
    "isolates managed aliases, preserves unmanaged user config and explicit forwarding",
    async () => {
      const root = await temporaryDirectory("ssh-config-");
      const userConfig = join(root, "user config");
      const configPath = join(root, "generated config");
      const knownHostsPath = join(root, `known hosts ' 100%`);
      const helper = join(root, `helper ' 100%`);
      await writeFile(userConfig, "Host *\n  ProxyCommand false\n  User user-config\n");
      const machines = [machine("alpha", "Alpha"), machine("build-box", "Build box")];
      const rendered = renderSshConfig({
        helperBinary: helper,
        knownHostsPath,
        machines,
        nativeUser: true,
        relaySocket: join(root, `relay ' 100%.sock`),
      }).replace("Include ~/.ssh/config", `Include "${userConfig}"`);
      await writeFile(configPath, rendered);

      const managed = await sshG(configPath, "alpha", [
        "-N",
        "-L",
        "127.0.0.1:8123:example.com:80",
      ]);
      expect(managed.hostname).toBe(machines[0]?.runnerId);
      expect(managed.proxycommand).toContain("ssh-proxy");
      expect(managed.proxycommand).toContain("100%");
      expect(managed.user).toBe("opensteer");
      expect(managed.clearallforwardings).toBe("no");
      expect(managed.localforward).toContain("8123");
      expect(managed.localforward).toContain("example.com");
      expect(managed.hostkeyalgorithms).toBe("ssh-ed25519");
      expect(managed.globalknownhostsfile).toBe("/dev/null");

      const unmanaged = await sshG(configPath, "example.test");
      expect(unmanaged.proxycommand).toBe("false");
      expect(unmanaged.user).toBe("user-config");
    },
  );
});

describe("machine access notice", () => {
  it("renders online, offline, shares and omitted machines", () => {
    const context = machineContext();
    const notice = renderMachineAccessNotice(
      {
        callerMachineName: "cloud-1",
        machines: [
          context.machines[0]!,
          {
            ...machine("build-box", "Build box"),
            commands: false,
            forwarding: false,
            lastSeenAt: "2026-09-13T10:00:00.000Z",
            shares: [{ mode: "read", path: "/srv/data" }],
            status: "offline",
          },
        ],
        omittedMachines: 3,
      },
      Date.parse("2026-09-13T12:00:00.000Z"),
    );
    expect(notice).toContain("alpha (macOS, online)");
    expect(notice).toContain("build-box (macOS, offline 2h)");
    expect(notice).toContain("/srv/data (read-only); commands off; port forwarding off.");
    expect(notice).toContain("commands allowed; port forwarding allowed.");
    expect(notice).toContain(
      "…and 3 more computers are not listed and cannot be addressed this Run.",
    );
    expect(notice).toContain("Details: the opensteer-computers skill");
    expect(
      renderMachineAccessNotice({ callerMachineName: "cloud-1", machines: [], omittedMachines: 0 }),
    ).toBe(noReachableComputersNotice("cloud-1"));
  });

  it("states the macOS grant per Mac and says nothing about it elsewhere", () => {
    const notice = renderMachineAccessNotice({
      callerMachineName: "cloud-1",
      machines: [
        { ...machine("granted-mac", "Granted Mac"), fullDiskAccess: true },
        { ...machine("denied-mac", "Denied Mac"), fullDiskAccess: false },
        { ...machine("unknown-mac", "Unknown Mac"), fullDiskAccess: null },
        { ...machine("build-box", "Build box"), fullDiskAccess: null, platform: "linux" },
      ],
      omittedMachines: 0,
    });
    expect(notice).toContain(
      "commands allowed; port forwarding allowed; macOS Full Disk Access on.",
    );
    expect(notice).toContain(
      "port forwarding allowed; macOS Full Disk Access off (some protected data may be unavailable).",
    );
    const lines = notice.split("\n");
    expect(lines.find((line) => line.startsWith("- unknown-mac"))).toMatch(
      /port forwarding allowed\.$/u,
    );
    expect(lines.find((line) => line.startsWith("- build-box"))).toMatch(
      /port forwarding allowed\.$/u,
    );
    // A Linux computer has no such gate, so a clause there would describe a
    // setting the person cannot find.
    expect(lines.filter((line) => line.includes("macOS Full Disk Access"))).toHaveLength(2);
  });

  it("fits the note within the smallest per-turn context budget by dropping whole machines", () => {
    const machines = Array.from({ length: 32 }, (_, index) => ({
      ...machine(`computer-${index}`, `Computer ${index}`),
      shares: Array.from({ length: 8 }, (_, share) => ({
        mode: share % 2 === 0 ? ("read" as const) : ("read-write" as const),
        path: `/Users/person/Projects/customer-${index}/service-${share}/deployments`,
      })),
    }));
    const context: MachineAccessRunContext = {
      callerMachineName: "界".repeat(160),
      machines,
      omittedMachines: 3,
    };
    expect(Buffer.byteLength(renderMachineAccessNotice(context), "utf8")).toBeGreaterThan(
      machineAccessNoticeMaxBytes,
    );

    const fitted = fitMachineAccessNotice(context);
    const notice = renderMachineAccessNotice(fitted);
    expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(machineAccessNoticeMaxBytes);
    expect(fitted.callerMachineName).toBe(context.callerMachineName);
    expect(notice).toContain(`This Run is on ${context.callerMachineName}.`);
    expect(fitted.machines.length).toBeGreaterThan(0);
    expect(fitted.machines).toEqual(machines.slice(0, fitted.machines.length));
    expect(fitted.omittedMachines).toBe(3 + machines.length - fitted.machines.length);
    expect(notice).toContain(
      `…and ${fitted.omittedMachines} more computers are not listed and cannot be addressed this Run.`,
    );
    expect(notice).toContain("Details: the opensteer-computers skill");
    const small = machineContext();
    expect(fitMachineAccessNotice(small)).toEqual(small);
  });

  it("preserves smaller computers after a machine with oversized share paths", () => {
    const oversized = {
      ...machine("large", "Large"),
      shares: Array.from({ length: 32 }, () => ({
        mode: "read" as const,
        path: `/${"界".repeat(340)}`,
      })),
    };
    const small = machine("small", "Small");
    const context = {
      callerMachineName: "cloud-1",
      machines: [oversized, small],
      omittedMachines: 0,
    };
    const fitted = fitMachineAccessNotice(context);
    expect(fitted).toEqual(context);
    const notice = renderMachineAccessNotice(fitted);
    expect(notice).toContain("32 shared folders not listed");
    expect(notice).toContain("- small (");
    expect(notice).not.toContain("界");
    expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(machineAccessNoticeMaxBytes);
  });

  it("lists complete short paths after an oversized path without changing the access snapshot", () => {
    const computer = {
      ...machine("alpha", "Alpha"),
      shares: [
        { mode: "read" as const, path: `/${"x".repeat(1020)}` },
        { mode: "read-write" as const, path: "/shared" },
      ],
    };
    const context = { callerMachineName: "cloud-1", machines: [computer], omittedMachines: 0 };
    const notice = renderMachineAccessNotice(fitMachineAccessNotice(context));
    expect(notice).toContain("shares /shared (read-write); 1 shared folder not listed");
    expect(fitMachineAccessNotice(context).machines[0]?.shares).toEqual(computer.shares);
  });

  it("renders the reason when nothing is listed", () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const notice = renderMachineAccessNotice(
      { callerMachineName: "cloud-1", machines: [], omittedMachines: 2 },
      now,
      "driver-access-mode",
    );
    expect(notice).toContain(
      `No computers are listed for access from this Run. ${machineAccessUnavailableSentence(
        "driver-access-mode",
      )}`,
    );
    expect(notice).toContain(
      "…and 2 more computers are not listed and cannot be addressed this Run.",
    );
    // With nothing omitted either, the standing sentence is the whole notice:
    // a resumed conversation needs one line that retires an earlier Run's list.
    expect(
      renderMachineAccessNotice(
        { callerMachineName: "cloud-1", machines: [], omittedMachines: 0 },
        now,
        "none-reachable",
      ),
    ).toBe(noReachableComputersNotice("cloud-1"));
  });

  it.skipIf(!hasSsh())("addresses exactly the computers the note lists", async () => {
    const listed = machine("alpha", "Alpha");
    const oversized = {
      ...machine("beta", "Beta"),
      shares: Array.from({ length: 32 }, (_, share) => ({
        mode: "read" as const,
        path: `/Users/person/Projects/${"x".repeat(90)}/${share}`,
      })),
    };
    const context = {
      callerMachineName: "cloud-1",
      machines: [
        listed,
        oversized,
        ...Array.from({ length: 30 }, (_, index) => machine(`extra-${index}`, `Extra ${index}`)),
      ],
      omittedMachines: 0,
    };
    const fitted = fitMachineAccessNotice(context);
    const setup = await createSetup(context, new URL("http://127.0.0.1:1"));
    try {
      expect(setup.machineAccessNotice).toContain("- alpha (");
      expect(setup.machineAccessNotice).toContain("- beta (");
      expect(fitted.omittedMachines).toBeGreaterThan(0);
      expect(setup.machineAccessNotice).toContain(
        `…and ${fitted.omittedMachines} more computers are not listed`,
      );
      const sshConfig = await readFile(join(setup.launchDirectory, "ssh_config"), "utf8");
      expect(sshConfig).toContain("Host alpha");
      expect(sshConfig).toContain("Host beta");
      for (const computer of context.machines) {
        expect(sshConfig.includes(`Host ${computer.alias}\n`)).toBe(
          fitted.machines.includes(computer),
        );
      }
    } finally {
      await setup.close();
    }
  });
});

function machine(alias: string, name: string): MachineAccessRunMachine {
  return {
    alias,
    commands: true,
    forwarding: true,
    fullDiskAccess: null,
    hostPublicKey: canonicalHostKey,
    lastSeenAt: null,
    name,
    platform: "darwin",
    runnerId: createId("runner"),
    shares: [{ mode: "read-write", path: "/Users/test/Projects" }],
    status: "online",
  };
}

function machineContext(): MachineAccessRunContext {
  return {
    callerMachineName: "cloud-1",
    machines: [machine("alpha", "Alpha")],
    omittedMachines: 0,
  };
}

/**
 * A launch directory whose relay socket path stays inside the 100-byte limit,
 * which the default macOS temporary directory alone does not leave room for.
 */
async function shortTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join("/tmp", prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Setup always belongs to a Run, and the Run's Workspace is where the setup
 * probe runs. A test that does not care which directory that is gets one.
 */
type SetupOptions = Omit<
  Parameters<typeof setupMachineAccess>[0],
  "plan" | "workspacePath" | "wrapModelCommand" | "wrapProcessLaunch"
> &
  Omit<Parameters<typeof planMachineAccess>[0], "now"> & {
    readonly workspacePath?: string;
    readonly wrapModelCommand?: Parameters<typeof setupMachineAccess>[0]["wrapModelCommand"];
    readonly wrapProcessLaunch?: Parameters<typeof setupMachineAccess>[0]["wrapProcessLaunch"];
  };

/** A launch as a Run gets one: its plan's notice beside the engine's directory. */
type NoticedOutcome =
  | (MachineAccessSetup & { readonly machineAccessNotice: string })
  | {
      readonly reason: MachineAccessUnavailableReason;
    };

async function setupInWorkspace(options: SetupOptions): Promise<NoticedOutcome> {
  const plan = await planMachineAccess(options);
  if (!isMachineAccessRoutes(plan)) return plan;
  const outcome: MachineAccessOutcome = await setupMachineAccess({
    workspacePath: tmpdir(),
    // Most tests do not care how the Runner starts a process, only that the
    // probe goes through whatever seams there are: the identity wrappers.
    wrapModelCommand: (launch) => launch,
    wrapProcessLaunch: async () => (launch) => launch,
    ...options,
    plan,
  });
  return isMachineAccessSetup(outcome) ? { ...outcome, machineAccessNotice: plan.notice } : outcome;
}

/**
 * The setup a test expects to have, named so a regression reports the reason
 * the Run got instead of failing later on a missing property.
 */
function ready(
  outcome: NoticedOutcome,
): MachineAccessSetup & { readonly machineAccessNotice: string } {
  if (!("machineAccessNotice" in outcome)) {
    throw new Error(`Machine access was unavailable: ${outcome.reason}`);
  }
  return outcome;
}

/** A launch whose relay a Run holds, with every listed computer as a target. */
async function createSetup(context: MachineAccessRunContext, hostUrl: URL) {
  const setup = ready(
    await setupInWorkspace({
      accessMode: "full-access",
      driverKind: "claude",
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      helperBinary: nativeFsHelper,
      machineAccess: context,
      platform: process.platform === "linux" ? "linux" : "darwin",
      privateStateRoot: join(tmpdir(), "opensteer-private-test"),
      runtimeBoundary: { kind: "native-user" },
      transport: { controlCaPath: undefined, hostUrl, mode: "development" },
    }),
  );
  setup.relay.bind({
    credentials: { agentControl: "agent-token" },
    runId: createId("run"),
    targets: context.machines.map((machine) => machine.runnerId),
  });
  return setup;
}

async function executeValidationCommand(
  command: MachineAccessValidationCommand,
): Promise<{ readonly stdout: string }> {
  const result = await executeFile(command.executable, [...command.arguments], {
    encoding: "utf8",
    env: { ...command.environment },
  });
  return { stdout: result.stdout };
}

async function relayExchange(socketPath: string, input: string, terminal: string): Promise<string> {
  return new Promise((resolveExchange, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    const timer = setTimeout(() => reject(new Error("Relay exchange timed out")), 2_000);
    timer.unref();
    socket.once("connect", () => socket.write(input));
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.endsWith(terminal)) {
        clearTimeout(timer);
        socket.destroy();
        resolveExchange(output);
      }
    });
    socket.once("error", reject);
  });
}

async function relayExchangeWrites(
  socketPath: string,
  requestLine: string,
  earlyBytes: string,
  terminal: string,
): Promise<string> {
  return new Promise((resolveExchange, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    const timer = setTimeout(() => reject(new Error("Relay exchange timed out")), 2_000);
    timer.unref();
    socket.once("connect", () => {
      socket.write(requestLine);
      socket.write(earlyBytes);
    });
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.endsWith(terminal)) {
        clearTimeout(timer);
        socket.destroy();
        resolveExchange(output);
      }
    });
    socket.once("error", reject);
  });
}

function hasSsh(): boolean {
  return process.platform !== "win32";
}

async function executableOnPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue in PATH order.
    }
  }
  throw new Error(`${name} is not on PATH`);
}

async function sshG(
  configPath: string,
  alias: string,
  options: readonly string[] = [],
): Promise<Readonly<Record<string, string>>> {
  const result = await executeFile("ssh", ["-G", ...options, alias, "-F", configPath], {
    encoding: "utf8",
  });
  const parsed: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) parsed[line.slice(0, space)] ??= line.slice(space + 1);
  }
  return parsed;
}
