import type { AgentPhoneUpdateRelease } from "./update-release.js";
/**
 * The parts the Agent Phone end-to-end suites drive: a real Android device or
 * emulator over the local `adb` server, the Agent Phone app built for it, the
 * TLS front door the phone reaches the Host through, the Host itself, the
 * owner's session that runs setup, and an agent's MCP gateway.
 *
 * Nothing here operates the phone through `uiautomator`. A UiAutomation
 * client suspends every accessibility service on the device, the Agent
 * Phone's included, so the harness finds the app's own buttons in the view
 * hierarchy `dumpsys activity top` prints, taps them with `input tap`, and
 * reads what the fixture app recorded through its content provider.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, Writable } from "node:stream";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  AgentPhoneEnrollments,
  agentPhoneAdb,
  agentPhoneSetupHost,
  setupAgentPhone,
  type AgentPhoneArtifact,
  type AgentPhoneSetupHostPort,
  type AgentPhoneSetupResult,
  type AgentPhoneSetupStep,
} from "@opensteer/agent-phone-setup";
import { HttpHostClient } from "@opensteer/client/host";
import { DeploymentIdSchema, type RunnerId, type WorkspaceId } from "@opensteer/core";
import {
  HostIntegrationsComputerViewSchema,
  RunnerIntegrationsComputerViewResultSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerAuxiliaryFrameFenceSchema,
  HostIntegrationsDisplayStartSchema,
  type HostIntegrationsDisplayStart,
  type HostIntegrationsComputerView,
  type ComputerViewNativeResult,
  type RunnerAuxiliaryFrameFence,
  AgentPhoneArtifactManifestSchema,
  AgentPhoneHostTargetSchema,
  AgentPhoneSetupStatusSchema,
  agentPhonePackageName,
  agentPhonePairingExtra,
  agentPhoneSetupActions,
  agentPhoneSetupReceiver,
  androidPhoneDefinitionId,
  type AgentPhoneArtifactManifest,
  type AgentPhoneHostTarget,
  type AgentPhoneSetupStatus,
} from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import { AdbServerClient, type Adb } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { z } from "zod";
import { createRequire } from "node:module";

// ws exposes Receiver at runtime but omits it from its public TypeScript declarations.
const { Receiver } = createRequire(import.meta.url)("ws") as {
  Receiver: new (options: { isServer: boolean; maxPayload: number }) => Writable & {
    on(event: "message", listener: (bytes: Buffer) => void): Writable;
  };
};
import { createHostRuntime, type HostRuntime } from "../runtime/runtime.js";
import {
  connectCallerMachine,
  dispatchCallerRun,
  enrollmentToken,
  establishOwner,
  freePort,
  machineAccessHostConfig,
  type CallerMachine,
  type CallerRun,
  type MachineAccessHost,
} from "../runtime/machine-access.test-support.js";
import { startPortableFsManagerFake } from "../runtime/portablefs-manager.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";

export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const androidSdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
const adbBinary = join(androidSdk, "platform-tools", "adb");
const emulatorBinary = join(androidSdk, "emulator", "emulator");

/**
 * Where `pnpm build:agent-phone --e2e-ca` leaves the app built to trust this
 * run's test CA, its manifest and the fixture app — and nowhere else, so the
 * copies the web and desktop apps hand a person's phone are never this one.
 */
const e2eBuildDirectory = join(repositoryRoot, "apps/agent-phone/build/e2e");
const agentPhoneArtifactFiles = {
  apk: join(e2eBuildDirectory, "opensteer-agent-phone.apk"),
  manifest: join(e2eBuildDirectory, "agent-phone.json"),
} as const;
const fixtureApkPath = join(e2eBuildDirectory, "agent-phone-fixture.apk");
export const fixturePackage = "com.opensteer.agentphone.fixture";
export const fixtureActivities = {
  main: `${fixturePackage}/${fixturePackage}.FixtureActivity`,
  display: `${fixturePackage}/${fixturePackage}.DisplayFixtureActivity`,
  rebound: `${fixturePackage}/${fixturePackage}.ReboundFieldActivity`,
  secure: `${fixturePackage}/${fixturePackage}.SecureActivity`,
} as const;
const receiptsUri = "content://com.opensteer.agentphone.fixture.receipts/receipts";

/** The emulator's own name for the computer it runs on; the phone dials the Host there. */
export const emulatorHostAlias = "10.0.2.2";

/* ------------------------------------------------------------------------- *
 * Processes
 * ------------------------------------------------------------------------- */

const deviceTestCommands: {
  command: string;
  args: readonly string[];
  cwd: string;
  startedAt: string;
  exit: string;
}[] = [];

interface CommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/**
 * Runs one program to its end and gives its standard output, as text or, for
 * `output: "buffer"`, as bytes. A failure carries the end of its standard
 * error, which is usually the only place the reason is written.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options?: CommandOptions,
): Promise<string>;
export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions & { readonly output: "buffer" },
): Promise<Buffer>;
export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions & { readonly output?: "buffer" } = {},
): Promise<string | Buffer> {
  const recorded = {
    command,
    args,
    cwd: options.cwd ?? process.cwd(),
    startedAt: new Date().toISOString(),
    exit: "running",
  };
  deviceTestCommands.push(recorded);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        encoding: "buffer",
        maxBuffer: 64 * 1_024 * 1_024,
        timeout: options.timeoutMs ?? 60_000,
      },
      (error, stdout, stderr) => {
        recorded.exit = error ? String(error.code ?? "failed") : "0";
        if (error) {
          const detail = stderr.toString("utf8").trim().slice(-2_000);
          reject(
            new Error(
              `${command} ${args.join(" ")} failed: ${error.message}${detail ? `\n${detail}` : ""}`,
            ),
          );
          return;
        }
        resolve(options.output === "buffer" ? stdout : stdout.toString("utf8"));
      },
    );
  });
}

/** Polls until `produce` gives a value, or fails naming what never happened. */
export async function eventually<Value>(
  label: string,
  produce: () => Promise<Value | undefined>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await produce();
      if (value !== undefined) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${label}${
          lastError
            ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}`
            : "."
        }`,
      );
    }
    await delay(intervalMs);
  }
}

/* ------------------------------------------------------------------------- *
 * The device
 * ------------------------------------------------------------------------- */

export interface AndroidDevice {
  readonly serial: string;
  /** The AVD the harness booted, or null for a device it was handed in `ANDROID_SERIAL`. */
  readonly avd: string | null;
  adb(args: readonly string[], options?: CommandOptions): Promise<string>;
  /** One command line for the phone's `sh`, which `adb shell` hands over as written. */
  shell(command: string, options?: CommandOptions): Promise<string>;
  screencap(): Promise<Buffer>;
  /** Shuts down an emulator the harness booted; a device it was handed is left running. */
  close(): Promise<void>;
}

export interface DeviceFacts {
  readonly fingerprint: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly release: string;
  readonly sdk: number;
  readonly serial: string;
  readonly avd: string | null;
}

/**
 * The phone the suite runs on: `ANDROID_SERIAL` when it names one, otherwise
 * the AVD for `api`, booted headless and cold for this run. Without either the
 * suite fails; a device test that cannot find a device has proven nothing.
 */
export async function acquireAndroidDevice(input: {
  readonly api: number;
  readonly emulatorLog: string;
}): Promise<AndroidDevice> {
  // adb commands start a server implicitly. Claim it explicitly only when none exists.
  const existingServer = await new Promise<boolean>((resolve) => {
    const socket = connectTcp({ host: "127.0.0.1", port: 5037 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (!existingServer) await runCommand(adbBinary, ["start-server"]);
  let serverStopped = false;
  const stopOwnedServer = async () => {
    if (!existingServer && !serverStopped) {
      await runCommand(adbBinary, ["kill-server"]);
      serverStopped = true;
    }
  };
  try {
    const handed = process.env.ANDROID_SERIAL;
    if (handed) {
      const state = (await runCommand(adbBinary, ["-s", handed, "get-state"])).trim();
      if (state !== "device") {
        throw new Error(`ANDROID_SERIAL=${handed} is ${state}, not a device adb can use.`);
      }
      const device = deviceFor(handed, null, stopOwnedServer);
      await prepareDevice(device);
      return device;
    }
    const avd = `opensteer-agent-phone-${input.api}`;
    const avds = (await runCommand(emulatorBinary, ["-list-avds"]))
      .split("\n")
      .map((line) => line.trim());
    if (!avds.includes(avd)) {
      throw new Error(
        `No device: ANDROID_SERIAL is unset and the AVD ${avd} does not exist (found: ${avds.filter(Boolean).join(", ") || "none"}).`,
      );
    }
    const port = await freeEmulatorPort();
    const serial = `emulator-${port}`;
    const log = openSync(input.emulatorLog, "a");
    const emulator: ChildProcess = spawn(
      emulatorBinary,
      [
        "-avd",
        avd,
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-snapshot",
        "-port",
        String(port),
      ],
      { stdio: ["ignore", log, log] },
    );
    closeSync(log);
    const exited = once(emulator, "exit");
    const device = deviceFor(serial, avd, async () => {
      try {
        if (emulator.exitCode !== null || emulator.signalCode !== null) return;
        // `emu kill` stops the virtual machine like pulling its plug. Flushing first
        // keeps the APKs and app data this run wrote, so the next boot does not find
        // packages it cannot parse and data no uninstall can reach.
        await runCommand(adbBinary, ["-s", serial, "shell", "sync"], { timeoutMs: 30_000 }).catch(
          () => undefined,
        );
        await runCommand(adbBinary, ["-s", serial, "emu", "kill"]).catch(() => undefined);
        const stopped = await Promise.race([
          exited.then(() => true),
          delay(60_000).then(() => false),
        ]);
        if (!stopped) {
          emulator.kill("SIGKILL");
          await exited;
        }
      } finally {
        await stopOwnedServer();
      }
    });
    try {
      await waitForBoot(device, 300_000);
      await prepareDevice(device);
    } catch (error) {
      await device.close();
      throw error;
    }
    return device;
  } catch (error) {
    await stopOwnedServer();
    throw error;
  }
}

function deviceFor(
  serial: string,
  avd: string | null,
  shutdown: () => Promise<void>,
): AndroidDevice {
  const adb = (args: readonly string[], options: CommandOptions = {}) =>
    runCommand(adbBinary, ["-s", serial, ...args], options);
  return {
    adb,
    avd,
    close: shutdown,
    screencap: () =>
      runCommand(adbBinary, ["-s", serial, "exec-out", "screencap", "-p"], {
        output: "buffer",
        timeoutMs: 30_000,
      }),
    serial,
    shell: (command, options) => adb(["shell", command], options),
  };
}

/** An even console port the emulator can take with its ADB port beside it. */
async function freeEmulatorPort(): Promise<number> {
  const attached = await runCommand(adbBinary, ["devices"]);
  for (let port = 5_570; port < 5_680; port += 2) {
    if (attached.includes(`emulator-${port}`)) continue;
    if ((await portIsFree(port)) && (await portIsFree(port + 1))) return port;
  }
  throw new Error("No free emulator port between 5570 and 5680.");
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connectTcp(port, "127.0.0.1");
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });
}

/** Waits for Android to say it finished booting, through any number of adb disconnects. */
async function waitForBoot(device: AndroidDevice, timeoutMs: number): Promise<void> {
  await eventually(
    `${device.serial} to finish booting`,
    async () =>
      (await device.shell("getprop sys.boot_completed", { timeoutMs: 10_000 })).trim() === "1"
        ? true
        : undefined,
    timeoutMs,
    1_000,
  );
}

/**
 * What every run starts from: no animations to wait out, and the screen on
 * and past a lock screen that needs nothing. Animations are a device setting
 * and stay off across reboots; nothing here keeps the screen on.
 */
async function prepareDevice(device: AndroidDevice): Promise<void> {
  for (const scale of [
    "window_animation_scale",
    "transition_animation_scale",
    "animator_duration_scale",
  ]) {
    await device.shell(`settings put global ${scale} 0`);
  }
  await device.shell("input keyevent KEYCODE_WAKEUP");
  await device.shell("input keyevent 82");
}

export async function deviceFacts(device: AndroidDevice): Promise<DeviceFacts> {
  const prop = async (key: string) => (await device.shell(`getprop ${key}`)).trim();
  return {
    avd: device.avd,
    fingerprint: await prop("ro.build.fingerprint"),
    manufacturer: await prop("ro.product.manufacturer"),
    model: await prop("ro.product.model"),
    release: await prop("ro.build.version.release"),
    sdk: Number(await prop("ro.build.version.sdk")),
    serial: device.serial,
  };
}

/** This boot's identity, which every reboot changes. */
async function bootId(device: AndroidDevice): Promise<string> {
  return (await device.shell("cat /proc/sys/kernel/random/boot_id", { timeoutMs: 10_000 })).trim();
}

/**
 * Restarts the phone the way pulling the power and plugging it back does as
 * far as the app can tell, and returns how long Android took to boot. Nothing
 * is done to the phone afterwards: no unlock, no tap, no app opened.
 */
export async function rebootDevice(device: AndroidDevice): Promise<{ readonly bootedMs: number }> {
  const before = await bootId(device);
  const started = Date.now();
  await device.adb(["reboot"], { timeoutMs: 60_000 });
  await eventually(
    `${device.serial} to come back from its reboot`,
    async () => ((await bootId(device)) !== before ? true : undefined),
    300_000,
    1_000,
  );
  await waitForBoot(device, 300_000);
  return { bootedMs: Date.now() - started };
}

/**
 * Leaves the phone as if the Agent Phone app had never been on it: neither
 * app installed and the accessibility service off the enabled list, every
 * other service kept. Setup then does every one of its steps for real, and an
 * identity an earlier run left on the phone goes with the app's data.
 */
export async function resetPhone(device: AndroidDevice): Promise<void> {
  for (const packageName of [agentPhonePackageName, fixturePackage]) {
    const listed = await device.shell(`pm list packages ${packageName}`);
    if (listed.split("\n").some((line) => line.trim() === `package:${packageName}`)) {
      const removed = (await device.shell(`pm uninstall ${packageName}`)).trim();
      if (removed !== "Success") throw new Error(`Could not uninstall ${packageName}: ${removed}`);
    }
  }
  const enabled = (await device.shell("settings get secure enabled_accessibility_services")).trim();
  const kept =
    enabled === "null"
      ? []
      : enabled
          .split(":")
          .filter((entry) => entry !== "" && !entry.startsWith(`${agentPhonePackageName}/`));
  if (kept.length === 0)
    await device.shell("settings delete secure enabled_accessibility_services");
  else await device.shell(`settings put secure enabled_accessibility_services ${kept.join(":")}`);
}

export async function installFixture(device: AndroidDevice): Promise<void> {
  const output = await device.adb(["install", "-r", "-g", fixtureApkPath], { timeoutMs: 120_000 });
  if (!output.includes("Success")) throw new Error(`The fixture app did not install: ${output}`);
}

/** The app's running processes, so its log lines can be picked out of the device's. */
export async function agentPhonePids(device: AndroidDevice): Promise<readonly number[]> {
  const output = await device.shell(`pidof ${agentPhonePackageName}`).catch(() => "");
  return output
    .trim()
    .split(/\s+/u)
    .filter((value) => /^[0-9]+$/u.test(value))
    .map(Number);
}

/* ------------------------------------------------------------------------- *
 * The app's own controls, as a person's finger reaches them
 * ------------------------------------------------------------------------- */

interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

interface ViewLine {
  readonly depth: number;
  readonly enabled: boolean;
  readonly id: string | null;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly visible: boolean;
}

const viewLinePattern =
  /^(\s*)\S+\{[0-9a-f]+ (\S{9}) \S{8} (-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?: #[0-9a-f]+ ([^\s}]+))?/u;

/** Where a view is, or why it cannot be pressed now, in words a failed run can be read from. */
type ViewLocation = { readonly point: ScreenPoint } | { readonly missing: string };

/**
 * Where one of an activity's views is on the screen now, or why not: that
 * activity is not resumed, the view is not shown and enabled, or Android
 * still has another window covering its input point.
 *
 * `dumpsys activity top` prints each view's bounds relative to its parent, so
 * the screen position is the sum along its ancestors plus where the window
 * itself sits. None of these screens scrolls before the harness taps them.
 */
export async function findView(
  device: AndroidDevice,
  input: { readonly activity: string; readonly viewId: string; readonly resourceId?: string },
): Promise<ViewLocation> {
  const [packageName, className] = input.activity.split("/") as [string, string];
  const shortName = className.startsWith(`${packageName}.`)
    ? `${packageName}/${className.slice(packageName.length)}`
    : input.activity;
  const top = await device.shell("dumpsys activity top", { timeoutMs: 30_000 });
  const section = activitySection(top, [input.activity, shortName]);
  if (!section) {
    const shown = [...top.matchAll(/^\s*ACTIVITY (\S+) /gmu)].map((match) => match[1]).join(", ");
    return { missing: `${shortName} is not a top activity (top: ${shown})` };
  }
  if (!section.some((line) => /\bmResumed=true\b/u.test(line))) {
    return { missing: `${shortName} is not resumed` };
  }
  const views = viewHierarchy(section);
  const ancestors: { depth: number; left: number; top: number; shown: boolean }[] = [];
  for (const view of views) {
    while (ancestors.length > 0 && ancestors.at(-1)!.depth >= view.depth) ancestors.pop();
    const parent = ancestors.at(-1);
    const left = (parent?.left ?? 0) + view.left;
    const topEdge = (parent?.top ?? 0) + view.top;
    const shown = (parent?.shown ?? true) && view.visible;
    ancestors.push({ depth: view.depth, left, shown, top: topEdge });
    if (view.id !== (input.resourceId ?? `app:id/${input.viewId}`)) continue;
    if (!shown) return { missing: `${input.viewId} is not shown` };
    if (!view.enabled) return { missing: `${input.viewId} is disabled` };
    const window = await windowOrigin(device, `${packageName}/${className}`);
    if (!window) return { missing: `the window manager lists no window for ${input.activity}` };
    const point = {
      x: window.x + left + Math.round((view.right - view.left) / 2),
      y: window.y + topEdge + Math.round((view.bottom - view.top) / 2),
    };
    const missing = await inputTapIssue(device, input.activity, point);
    return missing === null ? { point } : { missing };
  }
  return {
    missing: `${shortName} shows no ${input.viewId}; its views are ${views.map((view) => view.id ?? "-").join(" ")}`,
  };
}

function activitySection(dump: string, names: readonly string[]): string[] | null {
  const lines = dump.split("\n");
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const match = /^\s*ACTIVITY (\S+) /u.exec(line);
    if (!match) continue;
    if (start !== -1) return lines.slice(start, index);
    if (names.includes(match[1]!)) start = index;
  }
  return start === -1 ? null : lines.slice(start);
}

function viewHierarchy(section: readonly string[]): ViewLine[] {
  const header = section.findIndex((line) => line.trim() === "View Hierarchy:");
  if (header === -1) return [];
  const headerIndent = section[header]!.length - section[header]!.trimStart().length;
  const views: ViewLine[] = [];
  for (const line of section.slice(header + 1)) {
    const indent = line.length - line.trimStart().length;
    if (line.trim() === "" || indent <= headerIndent) break;
    const match = viewLinePattern.exec(line);
    if (!match) continue;
    const flags = match[2]!;
    views.push({
      bottom: Number(match[6]),
      depth: match[1]!.length,
      enabled: flags[2] === "E",
      id: match[7] ?? null,
      left: Number(match[3]),
      right: Number(match[5]),
      top: Number(match[4]),
      visible: flags[0] === "V",
    });
  }
  return views;
}

/** Where a window's frame starts on the screen, from the window manager's own dump. */
async function windowOrigin(device: AndroidDevice, component: string): Promise<ScreenPoint | null> {
  const dump = await device.shell("dumpsys window windows", { timeoutMs: 30_000 });
  const lines = dump.split("\n");
  const start = lines.findIndex(
    (line) => /^\s*Window #\d+ Window\{/u.test(line) && line.includes(` ${component}}`),
  );
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*Window #\d+ Window\{/u.test(line)) break;
    const frame = /\b(?:m?[Ff]rame)=\[(-?\d+),(-?\d+)\]\[/u.exec(line);
    if (frame) return { x: Number(frame[1]), y: Number(frame[2]) };
  }
  return null;
}

/**
 * Resumed and focused can precede removal of Android's task-snapshot surface.
 * Its empty touchable region does not prevent it from blocking an untrusted
 * tap, so check the dispatcher's actual stack above the destination window.
 */
async function inputTapIssue(
  device: AndroidDevice,
  component: string,
  point: ScreenPoint,
): Promise<string | null> {
  const dump = await device.shell("dumpsys input", { timeoutMs: 30_000 });
  if (!/\bDispatchEnabled: true\b/u.test(dump) || !/\bDispatchFrozen: false\b/u.test(dump)) {
    return "Android input dispatch is not ready";
  }
  const focus = /^[ \t]*FocusedWindows:\n((?:[ \t]+displayId=[^\n]*\n)+)/mu.exec(dump)?.[1];
  const focusedName = /\bdisplayId=0, name='([^']+)'/u.exec(focus ?? "")?.[1];
  if (
    !focusedName ||
    !(focusedName.endsWith(` ${component}`) || focusedName.endsWith(` ${component}}`))
  ) {
    return `Android input does not focus ${component} (focused: ${focusedName ?? "none"})`;
  }
  const windows = [
    ...dump.matchAll(/^[ \t]*\d+: name=(?:'([^']+)'|([^,\n]+)), ((?:id|displayId)=[^\n]+)/gmu),
  ]
    .map((match) => ({ name: match[1] ?? match[2]!, detail: match[3]! }))
    .filter(({ detail }) => /\bdisplayId=0(?:,|$)/u.test(detail));
  const index = windows.findIndex(({ name }) => name === focusedName);
  const target = windows[index];
  const containsPoint = (region: string | undefined) =>
    [...(region ?? "").matchAll(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/gu)].some(
      (rect) =>
        point.x >= Number(rect[1]) &&
        point.y >= Number(rect[2]) &&
        point.x < Number(rect[3]) &&
        point.y < Number(rect[4]),
    );
  if (
    !target ||
    /\b(?:NOT_VISIBLE|NOT_TOUCHABLE|NO_INPUT_CHANNEL|PAUSE_DISPATCHING|visible=false|paused=true)\b/u.test(
      target.detail,
    ) ||
    !containsPoint(
      /\btouchableRegion=(.*?)(?:, [A-Za-z][A-Za-z0-9.]*=|$)/u.exec(target.detail)?.[1],
    )
  ) {
    return `Android input cannot deliver the point to ${component}`;
  }
  for (const window of windows.slice(0, index)) {
    if (
      /\b(?:NOT_VISIBLE|visible=false|TRUSTED_OVERLAY)\b/u.test(window.detail) ||
      /\balpha=0(?:\.0+)?(?:,|$)/u.test(window.detail)
    )
      continue;
    if (containsPoint(/\bframe=(\[-?\d+,-?\d+\]\[-?\d+,-?\d+\])/u.exec(window.detail)?.[1])) {
      return `Android input is still covered by ${window.name}`;
    }
  }
  return null;
}

/** Waits until the view can be pressed, then presses it as a finger does. */
export async function tapView(
  device: AndroidDevice,
  input: {
    readonly activity: string;
    readonly viewId: string;
    readonly resourceId?: string;
    readonly timeoutMs?: number;
  },
): Promise<ScreenPoint> {
  let missing = "";
  const point = await eventually(
    `${input.viewId} on ${input.activity}`,
    async () => {
      const location = await findView(device, input);
      if ("point" in location) return location.point;
      missing = location.missing;
      return undefined;
    },
    input.timeoutMs ?? 30_000,
  ).catch((error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Last seen: ${missing}.`,
    );
  });
  await device.shell(`input tap ${point.x} ${point.y}`);
  return point;
}

export const agentPhoneActivities = {
  main: `${agentPhonePackageName}/${agentPhonePackageName}.ui.MainActivity`,
} as const;

/**
 * Whether an activity's window holds the input focus, as the window manager
 * reports it. Unlike `dumpsys activity top`, this asks the system alone, not
 * the app's own process, so it is settled the moment the window is shown —
 * including right after Android recreates the activity for a theme change.
 */
export async function activityFocused(device: AndroidDevice, activity: string): Promise<boolean> {
  const focus = (await device.shell("dumpsys window", { timeoutMs: 30_000 }))
    .split("\n")
    .find((line) => line.trimStart().startsWith("mCurrentFocus="));
  return focus?.includes(` ${activity}}`) ?? false;
}

/** Whether an activity is the one in front, resumed, as `dumpsys activity top` reports it. */
export async function activityResumed(device: AndroidDevice, activity: string): Promise<boolean> {
  const [packageName, className] = activity.split("/") as [string, string];
  const shortName = `${packageName}/${className.slice(packageName.length)}`;
  const section = activitySection(
    await device.shell("dumpsys activity top", { timeoutMs: 30_000 }),
    [activity, shortName],
  );
  return section?.some((line) => /\bmResumed=true\b/u.test(line)) ?? false;
}

/* ------------------------------------------------------------------------- *
 * What the phone says over USB, and what the fixture recorded
 * ------------------------------------------------------------------------- */

/**
 * The app's answer to setup's STATUS command, read exactly as setup reads it:
 * the ordered broadcast's result data, which `am` prints unescaped between
 * quotes.
 */
export async function readPhoneStatus(device: AndroidDevice): Promise<AgentPhoneSetupStatus> {
  const output = await device.shell(
    `am broadcast --include-stopped-packages -n ${agentPhoneSetupReceiver} -a ${agentPhoneSetupActions.status}`,
    { timeoutMs: 30_000 },
  );
  return phoneStatusFromBroadcast(output, "STATUS");
}

function phoneStatusFromBroadcast(
  output: string,
  command: "STATUS" | "RETARGET",
): AgentPhoneSetupStatus {
  const completed = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("Broadcast completed: result="));
  const data = completed
    ? /^Broadcast completed: result=-?[0-9]+, data="(.*)"$/u.exec(completed)?.[1]
    : undefined;
  if (data === undefined) throw new Error(`The phone did not answer ${command}: ${output.trim()}`);
  return AgentPhoneSetupStatusSchema.parse(JSON.parse(data));
}

/**
 * Sends the phone RETARGET exactly as setup does — the receiver's component,
 * the base64url JSON of the target in `payload` — and returns the result code
 * the receiver answered and the status it describes, which must already be
 * the new target's before discovery can finish.
 */
export async function retargetPhone(
  device: AndroidDevice,
  target: AgentPhoneHostTarget,
): Promise<{ readonly code: number; readonly status: AgentPhoneSetupStatus }> {
  const payload = Buffer.from(JSON.stringify(AgentPhoneHostTargetSchema.parse(target))).toString(
    "base64url",
  );
  const output = await device.shell(
    `am broadcast --include-stopped-packages -n ${agentPhoneSetupReceiver} -a ${agentPhoneSetupActions.retarget} --es ${agentPhonePairingExtra} ${payload}`,
    { timeoutMs: 30_000 },
  );
  const code = /^Broadcast completed: result=(-?[0-9]+)/mu.exec(output)?.[1];
  if (code === undefined) throw new Error(`The phone did not answer RETARGET: ${output.trim()}`);
  return { code: Number(code), status: phoneStatusFromBroadcast(output, "RETARGET") };
}

export interface Receipt {
  readonly detail: string;
  readonly id: number;
  readonly kind: string;
}

/** Everything the fixture app recorded, in order. */
export async function readReceipts(device: AndroidDevice): Promise<readonly Receipt[]> {
  const output = await device.shell(
    `content query --uri ${receiptsUri} --projection _id:at:kind:detailBase64`,
  );
  if (output.trim() === "No result found.") return [];
  const receipts: Receipt[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const match =
      /^Row: \d+ _id=(\d+), at=\d+, kind=([^,]*), detailBase64=([A-Za-z0-9+/=]*)$/u.exec(line);
    if (!match) throw new Error(`An unreadable receipt row: ${line}`);
    receipts.push({
      detail: Buffer.from(match[3]!, "base64").toString("utf8"),
      id: Number(match[1]),
      kind: match[2]!,
    });
  }
  return receipts;
}

export async function clearReceipts(device: AndroidDevice): Promise<void> {
  await device.shell(`content delete --uri ${receiptsUri}`);
}

/* ------------------------------------------------------------------------- *
 * TLS: a test CA the debug APK trusts, and the front door it vouches for
 * ------------------------------------------------------------------------- */

export interface TestCertificateAuthority {
  /** The CA certificate's PEM file, which the debug APK is built to trust. */
  readonly caPath: string;
  readonly caPem: string;
  readonly caSha256: string;
  readonly certificatePem: string;
  readonly keyPem: string;
}

/**
 * A CA for this run alone and a certificate it issues for `address`, by
 * default the emulator's name for this computer. The CA's key never leaves
 * the run's directory.
 */
export async function createTestCertificateAuthority(
  directory: string,
  address: string = emulatorHostAlias,
): Promise<TestCertificateAuthority> {
  const path = (name: string) => join(directory, name);
  await runCommand("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Opensteer Agent Phone E2E CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    path("ca.key"),
    "-out",
    path("ca.pem"),
  ]);
  await runCommand("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${address}`,
    "-keyout",
    path("host.key"),
    "-out",
    path("host.csr"),
  ]);
  await writeFile(
    path("host.ext"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=IP:${address}`,
      "",
    ].join("\n"),
  );
  await runCommand("openssl", [
    "x509",
    "-req",
    "-in",
    path("host.csr"),
    "-CA",
    path("ca.pem"),
    "-CAkey",
    path("ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    path("host.ext"),
    "-out",
    path("host.pem"),
  ]);
  const caPem = await readFile(path("ca.pem"));
  return {
    caPath: path("ca.pem"),
    caPem: caPem.toString("utf8"),
    caSha256: createHash("sha256").update(caPem).digest("hex"),
    certificatePem: `${await readFile(path("host.pem"), "utf8")}${caPem.toString("utf8")}`,
    keyPem: await readFile(path("host.key"), "utf8"),
  };
}

/**
 * Text the front door slips in as though the Host sent it, on each WebSocket
 * the phone opens through it from then on: right after the Host's `101`,
 * before the Host's own first frame, or right after the Host welcomes the
 * phone's module stream. Each such socket takes the next of `frames`.
 */
export interface FrameInjection {
  readonly at: "upgrade" | "stream-welcome";
  readonly frames: readonly string[];
}

export interface TlsFrontDoor {
  /** Faults are applied only by the saved-login receiver journeys. */
  replayPasswordsFrame(frame: Readonly<Record<string, unknown>>): Record<string, unknown>;
  readonly latestDisplayStart: HostIntegrationsDisplayStart | null;
  readonly latestDisplayMedia: Buffer | null;
  replayDisplayMedia(frame: Buffer): void;
  closeDisplayData(): void;
  holdDisplayStates(): () => number;
  /** Native-producer probe on the real authenticated auxiliary stream; deliberately does not stand in for Host owner authorization. */
  computerView(
    input: Pick<
      HostIntegrationsComputerView,
      "viewId" | "generation" | "leaseDurationMs" | "operation" | "target"
    >,
  ): Promise<ComputerViewNativeResult>;

  readonly port: number;
  /** How many frames the door has slipped in so far. */
  readonly injected: number;
  /** Drops every connection through it and stops answering, as a network gone dead does. */
  cut(): Promise<void>;
  /** Answers again on the same port. */
  restore(): Promise<void>;
  /** Starts slipping frames into new WebSockets, or with null stops. */
  inject(injection: FrameInjection | null): void;
  /**
   * While on, everything the phone sends is dropped and every connection
   * stays open, as a link that loses packets one way does: the phone believes
   * what it sent is on its way, and the Host never hears it.
   */
  dropFromPhone(drop: boolean): void;
  close(): Promise<void>;
}

const switchingProtocols = Buffer.from("HTTP/1.1 101 ", "latin1");
const headEnd = Buffer.from("\r\n\r\n", "latin1");

/**
 * The Host's public HTTPS address as the emulator reaches it — by default
 * `https://10.0.2.2:<port>`, the emulator's name for this computer's
 * loopback: TLS terminated here and every byte piped to the Host on loopback.
 * No ADB channel is anywhere in that path. Bound to another of this
 * computer's addresses, it still answers only this computer itself, through
 * which the emulator's traffic leaves.
 */
export async function startTlsFrontDoor(input: {
  /** One of this computer's own addresses to listen on; loopback by default. */
  readonly address?: string;
  readonly authority: TestCertificateAuthority;
  readonly hostPort: number;
  readonly port: number;
  readonly passwordsWire?: {
    readonly host: Record<string, unknown>[];
    readonly phone: Record<string, unknown>[];
    mapHost?: (frame: Record<string, unknown>) => Record<string, unknown> | null;
    mapPhone?: (frame: Record<string, unknown>) => Record<string, unknown> | null;
  };
}): Promise<TlsFrontDoor> {
  const ownAddresses = new Set(
    Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? []).map(({ address }) => address),
    ),
  );
  const sockets = new Set<Socket>();
  const displaySockets = new Set<Socket>();
  let latestDisplayStart: HostIntegrationsDisplayStart | null = null;
  let latestDisplayMedia: Buffer | null = null;
  let displayUpstream: Socket | null = null;
  let server: TlsServer | null = null;
  let injection: FrameInjection | null = null;
  let injected = 0;
  let dropping = false;
  let heldDisplayStates: Set<() => void> | null = null;
  let turn = 0;
  let viewStream: { client: Socket; fence: RunnerAuxiliaryFrameFence } | null = null;
  const viewReplies = new Map<
    string,
    {
      client: Socket;
      resolve: (value: ComputerViewNativeResult) => void;
      reject: (error: Error) => void;
    }
  >();

  const take = (from: FrameInjection): Buffer => {
    const text = from.frames[turn % from.frames.length]!;
    turn += 1;
    injected += 1;
    return serverTextFrame(text);
  };
  const open = async () => {
    const next = createTlsServer({
      cert: input.authority.certificatePem,
      key: input.authority.keyPem,
    });
    next.on("connection", (socket: Socket) => {
      if (!ownAddresses.has((socket.remoteAddress ?? "").replace(/^::ffff:/u, ""))) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    next.on("secureConnection", (client) => {
      const upstream = connectTcp(input.hostPort, "127.0.0.1");
      // Cloudflare's edge and cloudflared send without delay; Node sockets
      // default to Nagle, which would stall small frames this front door relays.
      client.setNoDelay(true);
      upstream.setNoDelay(true);
      sockets.add(upstream);
      const heldForSocket = new Set<() => void>();
      const end = () => {
        for (const deliver of heldForSocket) heldDisplayStates?.delete(deliver);
        heldForSocket.clear();
        displaySockets.delete(client);
        if (displayUpstream === upstream) displayUpstream = null;
        if (viewStream?.client === client) viewStream = null;
        for (const [id, pending] of viewReplies)
          if (pending.client === client) {
            viewReplies.delete(id);
            pending.reject(new Error("The native probe stream disconnected."));
          }
        client.destroy();
        upstream.destroy();
        sockets.delete(upstream);
      };
      client.once("error", end);
      upstream.once("error", end);
      client.once("close", end);
      upstream.once("close", end);
      // Receivers inspect copies only; the ordinary TLS relay remains byte-for-byte unchanged.
      const fromHost = new Receiver({ isServer: false, maxPayload: 1_048_576 });
      const fromPhone = new Receiver({ isServer: true, maxPayload: 1_048_576 });
      let upgraded = false;
      let headers = Buffer.alloc(0);
      fromHost.on("error", () => undefined);
      fromPhone.on("error", () => undefined);
      fromHost.on("message", (bytes: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          return;
        }
        const display = HostIntegrationsDisplayStartSchema.safeParse(parsed);
        if (display.success) latestDisplayStart = display.data;
        const welcome = RunnerAuxiliaryWelcomeSchema.safeParse(parsed);
        if (welcome.success && welcome.data.module === "integrations") {
          viewStream = {
            client,
            fence: z.object(RunnerAuxiliaryFrameFenceSchema.shape).parse(welcome.data),
          };
        }
      });
      fromPhone.on("message", (bytes: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          return;
        }
        if (input.passwordsWire && typeof parsed === "object" && parsed !== null)
          input.passwordsWire.phone.push(z.record(z.string(), z.unknown()).parse(parsed));
        const result = RunnerIntegrationsComputerViewResultSchema.safeParse(parsed);
        if (!result.success) return;
        const pending = viewReplies.get(result.data.requestId);
        if (!pending || pending.client !== client) return;
        viewReplies.delete(result.data.requestId);
        if (result.data.result.kind === "ok") pending.resolve(result.data.result.value);
        else pending.reject(new Error(`${result.data.result.code}: ${result.data.result.message}`));
      });
      upstream.on("data", (chunk: Buffer) => {
        if (upgraded) {
          fromHost.write(Buffer.from(chunk));
          return;
        }
        headers = Buffer.concat([headers, chunk]);
        const at = headers.indexOf(headEnd);
        if (at < 0) {
          if (headers.length > 65_536) headers = Buffer.alloc(0);
          return;
        }
        if (headers.subarray(0, switchingProtocols.length).equals(switchingProtocols)) {
          upgraded = true;
          const rest = headers.subarray(at + headEnd.length);
          if (rest.length) fromHost.write(Buffer.from(rest));
        }
        headers = Buffer.alloc(0);
      });
      let phoneHeaders = Buffer.alloc(0);
      let requestRead = false;
      let phonePending = Buffer.alloc(0);
      // Preserve masked/fragmented frames across TCP chunks; fault injection
      // must not mistake a partial payload for a new frame or write after close.
      const phoneRelay = new Transform({
        transform(chunk: Buffer, _encoding, next) {
          if (!requestRead) {
            phoneHeaders = Buffer.concat([phoneHeaders, chunk]);
            if (phoneHeaders.indexOf(headEnd) >= 0) {
              requestRead = true;
              if (
                phoneHeaders.toString("latin1").startsWith("GET /internal/v1/computer-use/display ")
              ) {
                displaySockets.add(client);
                displayUpstream = upstream;
              }
              phoneHeaders = Buffer.alloc(0);
            } else if (phoneHeaders.length > 65_536) {
              requestRead = true;
              phoneHeaders = Buffer.alloc(0);
            }
          }
          if (upgraded && !dropping) fromPhone.write(Buffer.from(chunk));
          if (dropping) {
            next();
            return;
          }
          if (!upgraded) {
            next(null, chunk);
            return;
          }
          phonePending = Buffer.concat([phonePending, chunk]);
          if (phonePending.length > 8 * 1_048_576) {
            next(new Error("Phone relay frame exceeds its bound"));
            return;
          }
          for (;;) {
            const size = frameSize(phonePending);
            if (size === null) break;
            const frame = phonePending.subarray(0, size);
            phonePending = phonePending.subarray(size);
            if (displaySockets.has(client) && (frame[0]! & 0x0f) === 2)
              latestDisplayMedia = Buffer.from(frame);
            if (
              heldDisplayStates !== null &&
              frameType(frame) === "runner.integrations.display.state"
            ) {
              const deliver = () => {
                heldForSocket.delete(deliver);
                if (!this.destroyed && !upstream.destroyed) this.push(frame);
              };
              heldForSocket.add(deliver);
              heldDisplayStates.add(deliver);
            } else {
              const mapped = input.passwordsWire?.mapPhone
                ? mapPasswordWireFrame(frame, input.passwordsWire.mapPhone)
                : frame;
              if (mapped) this.push(mapped);
            }
          }
          next();
        },
      });
      phoneRelay.once("error", end);
      client.pipe(phoneRelay).pipe(upstream);
      relayFromHost(
        upstream,
        client,
        () => injection,
        take,
        input.passwordsWire
          ? (frame) => {
              input.passwordsWire!.host.push(frame);
              return (
                input.passwordsWire!.mapHost?.(frame) ??
                (input.passwordsWire!.mapHost ? null : frame)
              );
            }
          : undefined,
      );
    });
    // A client that gives up mid-handshake is the network's business, not the test's.
    next.on("tlsClientError", () => undefined);
    next.listen(input.port, input.address ?? "127.0.0.1");
    await once(next, "listening");
    server = next;
  };
  const shut = async () => {
    const current = server;
    server = null;
    if (!current) return;
    const closed = once(current, "close");
    current.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    heldDisplayStates?.clear();
    heldDisplayStates = null;
    await closed;
  };
  await open();
  return {
    replayPasswordsFrame: (frame) => {
      if (!viewStream) throw new Error("The phone has no authenticated integrations stream");
      // Route the unchanged delayed payload through the live authenticated stream.
      // An old outer fence would end the transport before the receiver sees it.
      const delivered = { ...frame, ...viewStream.fence };
      viewStream.client.write(serverTextFrame(JSON.stringify(delivered)));
      return delivered;
    },
    get latestDisplayMedia() {
      return latestDisplayMedia;
    },
    replayDisplayMedia: (frame) => {
      if (!displayUpstream) throw new Error("No authenticated display data socket");
      displayUpstream.write(frame);
    },
    holdDisplayStates: () => {
      if (heldDisplayStates) throw new Error("Display states are already held");
      const held = new Set<() => void>();
      heldDisplayStates = held;
      return () => {
        if (heldDisplayStates !== held) return 0;
        heldDisplayStates = null;
        const count = held.size;
        for (const deliver of held) deliver();
        held.clear();
        return count;
      };
    },
    get latestDisplayStart() {
      return latestDisplayStart;
    },
    closeDisplayData: () => {
      for (const socket of displaySockets) socket.destroy();
    },
    computerView: async (input) => {
      const stream = viewStream;
      if (!stream) throw new Error("The phone has no authenticated native stream.");
      const requestId = `rar_${randomUUID()}`;
      const request = HostIntegrationsComputerViewSchema.parse({
        ...stream.fence,
        ...input,
        version: 1,
        type: "host.integrations.computer-view",
        requestId,
        timeoutMs: 10_000,
      });
      return await new Promise<ComputerViewNativeResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          viewReplies.delete(requestId);
          reject(new Error("The native owner-view probe timed out."));
        }, 15_000);
        viewReplies.set(requestId, {
          client: stream.client,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        stream.client.write(serverTextFrame(JSON.stringify(request)));
      });
    },
    close: shut,
    cut: shut,
    dropFromPhone: (drop) => {
      dropping = drop;
    },
    get injected() {
      return injected;
    },
    inject: (next) => {
      injection = next;
      turn = 0;
    },
    port: input.port,
    restore: open,
  };
}

/**
 * Copies the Host's bytes to the phone, finding the one place on the
 * connection an injected frame may go. Whether a socket gets one is decided
 * when it upgrades.
 *
 * The phone sends an upgrade only after reading every earlier response on
 * the connection, so the Host's `101` always begins a fresh read here, and
 * everything after its blank line is WebSocket frames. The Host never
 * compresses them, so a frame's header says where it ends.
 */
function relayFromHost(
  upstream: Socket,
  client: Socket,
  current: () => FrameInjection | null,
  take: (injection: FrameInjection) => Buffer,
  map?: (frame: Record<string, unknown>) => Record<string, unknown> | null,
): void {
  let pending = Buffer.alloc(0);
  let plan: FrameInjection | null = null;
  let upgraded = false;
  const handOver = () => {
    upstream.off("data", relay);
    if (pending.length > 0) client.write(pending);
    upstream.pipe(client);
  };
  const relay = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (!upgraded) {
      const known = Math.min(pending.length, switchingProtocols.length);
      if (!pending.subarray(0, known).equals(switchingProtocols.subarray(0, known))) {
        client.write(pending);
        pending = Buffer.alloc(0);
        return;
      }
      const end = pending.indexOf(headEnd);
      if (end === -1) return;
      client.write(pending.subarray(0, end + headEnd.length));
      pending = pending.subarray(end + headEnd.length);
      upgraded = true;
      plan = current();
      if (plan?.at === "upgrade") client.write(take(plan));
      if (plan?.at !== "stream-welcome" && !map) return handOver();
    }
    for (;;) {
      const size = frameSize(pending);
      if (size === null) return;
      const frame = pending.subarray(0, size);
      const mapped = map ? mapPasswordWireFrame(frame, map) : frame;
      if (mapped) client.write(mapped);
      const type = frameType(pending.subarray(0, size));
      pending = pending.subarray(size);
      if (type === "host.auxiliary.welcome" && plan) {
        client.write(take(plan));
        plan = null;
        if (!map) return handOver();
      }
    }
  };
  upstream.on("data", relay);
}

/** Preserve ordinary/binary frames; fault only complete JSON text messages. */
function mapPasswordWireFrame(
  frame: Buffer,
  map: (frame: Record<string, unknown>) => Record<string, unknown> | null,
): Buffer | null {
  if (frame[0] !== 0x81) return frame;
  const length = frame[1]! & 0x7f;
  const header = length === 126 ? 4 : length === 127 ? 10 : 2;
  const masked = (frame[1]! & 0x80) !== 0;
  const payload = Buffer.from(frame.subarray(header + (masked ? 4 : 0)));
  if (masked)
    for (let index = 0; index < payload.length; index++)
      payload[index] = payload[index]! ^ frame[header + (index % 4)]!;
  let parsed: Record<string, unknown>;
  try {
    parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(payload.toString("utf8")));
  } catch {
    return frame;
  }
  const mapped = map(parsed);
  if (mapped === null) return null;
  const result = serverTextFrame(JSON.stringify(mapped));
  if (!masked) return result;
  const newHeader = (result[1]! & 0x7f) === 126 ? 4 : 2;
  const mask = randomBytes(4);
  const bytes = Buffer.from(result.subarray(newHeader));
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = bytes[index]! ^ mask[index % 4]!;
  const prefix = Buffer.from(result.subarray(0, newHeader));
  prefix[1] = prefix[1]! | 0x80;
  return Buffer.concat([prefix, mask, bytes]);
}

/** One unmasked text frame, as a server sends it. */
function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length >= 65_536) throw new Error("An injected frame stays under 64 KiB.");
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** The length of one complete WebSocket frame, including an optional client mask. */
function frameSize(bytes: Buffer): number | null {
  if (bytes.length < 2) return null;
  const length = bytes[1]! & 0x7f;
  const header = length === 126 ? 4 : length === 127 ? 10 : 2;
  if (bytes.length < header) return null;
  const payload =
    length === 126
      ? bytes.readUInt16BE(2)
      : length === 127
        ? Number(bytes.readBigUInt64BE(2))
        : length;
  const size = header + (bytes[1]! & 0x80 ? 4 : 0) + payload;
  return bytes.length < size ? null : size;
}

/** The `type` a whole, unfragmented text frame's JSON names, or null for any other frame. */
function frameType(frame: Buffer): string | null {
  if (frame[0] !== 0x81) return null;
  const length = frame[1]! & 0x7f;
  const header = length === 126 ? 4 : length === 127 ? 10 : 2;
  try {
    const masked = (frame[1]! & 0x80) !== 0;
    const payload = Buffer.from(frame.subarray(header + (masked ? 4 : 0)));
    if (masked)
      for (let index = 0; index < payload.length; index++)
        payload[index] = payload[index]! ^ frame[header + (index % 4)]!;
    const parsed: unknown = JSON.parse(payload.toString("utf8"));
    const type = z.object({ type: z.string() }).safeParse(parsed);
    return type.success ? type.data.type : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- *
 * The build
 * ------------------------------------------------------------------------- */

export interface AgentPhoneE2eBuild {
  /** The app and its manifest as setup receives them, still unverified by setup. */
  readonly artifact: AgentPhoneArtifact & { readonly bytes: Uint8Array };
  readonly manifest: AgentPhoneArtifactManifest;
  readonly fixtureSha256: string;
}

/**
 * `pnpm build:agent-phone --e2e-ca <ca>`: the app built to trust this run's
 * CA alone, and the fixture app. Its output goes to `log`. The app it wrote
 * must be the one its manifest describes.
 */
export async function buildE2eAgentPhone(input: {
  readonly authority: TestCertificateAuthority;
  readonly log: string;
}): Promise<AgentPhoneE2eBuild> {
  await writeFile(
    input.log,
    await runCommand("pnpm", ["build:agent-phone", "--e2e-ca", input.authority.caPath], {
      cwd: repositoryRoot,
      timeoutMs: 900_000,
    }),
  );
  const bytes = new Uint8Array(await readFile(agentPhoneArtifactFiles.apk));
  const manifestJson: unknown = JSON.parse(
    await readFile(agentPhoneArtifactFiles.manifest, "utf8"),
  );
  const manifest = AgentPhoneArtifactManifestSchema.parse(manifestJson);
  if (bytes.byteLength !== manifest.apkSize || sha256Hex(bytes) !== manifest.apkSha256) {
    throw new Error("The end-to-end build wrote an APK other than the one its manifest describes.");
  }
  return {
    artifact: { bytes, manifest: manifestJson },
    fixtureSha256: sha256Hex(await readFile(fixtureApkPath)),
    manifest,
  };
}

/* ------------------------------------------------------------------------- *
 * The Host
 * ------------------------------------------------------------------------- */

export interface AgentPhoneHost extends MachineAccessHost {
  /** `https://10.0.2.2:<publicPort>`: the canonical and runtime origin, which the phone pairs with. */
  readonly publicOrigin: string;
  /** Stops the Host and starts it again on the same database, data directory and port. */
  restart(): Promise<void>;
}

/** A Host as its owner's signed-in browser reaches it: where to dial, and the session's headers. */
export interface AgentPhoneOwner {
  readonly origin: string;
  readonly ownerHeaders: Readonly<Record<string, string>>;
}

/**
 * A networked Host whose public origin is the TLS front door as the emulator
 * names it, listening on loopback. The harness reaches it directly at
 * `origin`, naming the public origin as a browser on that address would.
 */
export async function startAgentPhoneHost(
  databaseUrl: string,
  input: {
    readonly publicPort: number;
    readonly phoneUpdateRelease?: () => AgentPhoneUpdateRelease | null;
    readonly signupPolicy?: "closed" | "invite-only" | "open";
    /** Every line the Host logs, as JSON, across restarts. */
    readonly log: (line: string) => void;
  },
): Promise<AgentPhoneHost> {
  const portableFs = await startPortableFsManagerFake();
  const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-agent-phone-host-"));
  const hostPort = await freePort();
  const publicOrigin = new URL(`https://${emulatorHostAlias}:${input.publicPort}`);
  const config = machineAccessHostConfig(
    hostPort,
    dataDirectory,
    portableFs.url,
    databaseUrl,
    input.signupPolicy ?? "invite-only",
    publicOrigin,
  );
  const start = async () => {
    const started = await createHostRuntime(config, {
      ...(input.phoneUpdateRelease ? { phoneUpdateRelease: input.phoneUpdateRelease } : {}),
      logger: {
        level: "info",
        // As the Host's own entry point does: no credential reaches its log.
        redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
        stream: new Writable({
          write(chunk: Buffer | string, _encoding, done) {
            input.log(chunk.toString().trimEnd());
            done();
          },
        }),
      },
    });
    await started.listen();
    return started;
  };
  let runtime: HostRuntime = await start();
  const origin = `http://127.0.0.1:${hostPort}`;
  const ownerHeaders = await establishOwner(origin, publicOrigin.origin);
  const owner = await runtime.store.firstUser();
  if (!owner) throw new Error("The Agent Phone Host did not establish an owner.");
  return {
    close: async () => {
      await runtime.close();
      await portableFs.close();
      await rm(dataDirectory, { force: true, recursive: true });
    },
    config,
    hostPort,
    origin,
    ownerHeaders,
    ownerId: owner.id,
    publicOrigin: publicOrigin.origin,
    restart: async () => {
      await runtime.close();
      runtime = await start();
    },
    get runtime() {
      return runtime;
    },
    get store() {
      return runtime.store;
    },
  };
}

const DiscoveryDocumentSchema = z.object({
  authority: z.object({ document: z.object({ deploymentId: DeploymentIdSchema }) }),
});

/** The Deployment the owner's session belongs to, as the Host publishes it. */
export async function deploymentIdOf(host: AgentPhoneOwner) {
  const response = await fetch(`${host.origin}/.well-known/opensteer`);
  if (!response.ok) throw new Error(`Discovery answered HTTP ${response.status}.`);
  return DiscoveryDocumentSchema.parse(await response.json()).authority.document.deploymentId;
}

export interface MintedEnrollment {
  readonly enrollmentId: string;
  readonly token: string;
}

/**
 * The owner's own session as the setup engine asks things of the Host: the
 * port the web ships, over the same `HttpHostClient` the web runs, so the
 * suite sends exactly its commands, idempotency keys and reads. `onMinted`
 * sees each enrollment the Host answers with.
 */
function agentPhoneSetupHostPort(
  host: AgentPhoneOwner,
  onMinted: (enrollment: MintedEnrollment) => void,
): AgentPhoneSetupHostPort {
  const client = new HttpHostClient({
    baseUrl: host.origin,
    fetch: (resource, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(host.ownerHeaders)) headers.set(name, value);
      return fetch(resource, { ...init, headers });
    },
  });
  const port = agentPhoneSetupHost(client);
  return {
    ...port,
    mintEnrollment: async (request) => {
      const minted = await port.mintEnrollment(request);
      if (minted.kind === "minted") onMinted(minted.enrollment);
      return minted;
    },
  };
}

/**
 * A phone reached through the local `adb` server: the same Tango `Adb` the
 * product gets from WebUSB, over the one transport a test can drive with no
 * person at a USB chooser.
 */
async function connectAdbServerPhone(serial: string): Promise<Adb> {
  const client = new AdbServerClient(
    new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 }),
  );
  return client.createAdb({ serial });
}

/** Runs the production USB setup engine with the owner's authenticated Host port. */
export async function runAgentPhoneSetup(input: {
  readonly artifact: AgentPhoneArtifact;
  readonly device: AndroidDevice;
  readonly host: AgentPhoneOwner;
  readonly onMinted?: (enrollment: MintedEnrollment) => void;
  readonly onStep?: (step: AgentPhoneSetupStep) => void;
  readonly redaction: Redaction;
  readonly runnerName: string;
  readonly timeoutMs: number;
}): Promise<AgentPhoneSetupResult> {
  const previousStayOn = (
    await input.device.shell("settings get global stay_on_while_plugged_in")
  ).trim();
  if (!/^(?:null|[0-9]+)$/u.test(previousStayOn))
    throw new Error("Invalid original stay-on setting");
  await input.device.shell("svc power stayon true");
  try {
    const result = await setupAgentPhone({
      adb: agentPhoneAdb(await connectAdbServerPhone(input.device.serial)),
      artifact: input.artifact,
      confirmUninstall: async () => false,
      confirmUnpair: async () => false,
      enrollments: new AgentPhoneEnrollments(`setup-${randomUUID()}`),
      host: agentPhoneSetupHostPort(input.host, (enrollment) => {
        input.redaction.add(enrollment.token);
        input.onMinted?.(enrollment);
      }),
      onStep: (step) => input.onStep?.(step),
      runnerName: input.runnerName,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    await assertNoPhoneApprovalActivity(input.device);
    return result;
  } finally {
    await input.device.shell(
      previousStayOn === "null"
        ? "settings delete global stay_on_while_plugged_in"
        : `settings put global stay_on_while_plugged_in ${previousStayOn}`,
    );
  }
}

/** The removed activity must not even be installed, so it cannot appear between polls. */
export async function assertNoPhoneApprovalActivity(device: AndroidDevice): Promise<void> {
  const installed = await device.shell(`dumpsys package ${agentPhonePackageName}`);
  if (installed.includes("ApprovalActivity"))
    throw new Error("The phone still installs ApprovalActivity");
  if (
    (await device.shell("dumpsys activity top")).includes(
      "com.opensteer.agentphone.ui.ApprovalActivity",
    )
  ) {
    throw new Error(
      "An Opensteer approval activity exists in the phone's foreground activity stack",
    );
  }
}

/**
 * The phone back at work with nobody touching it, as the phone itself and as
 * its owner's Computers page see it: connected, its accessibility service
 * bound, and the Host listing it online and ready.
 */
export async function waitForPhoneOnline(
  device: AndroidDevice,
  host: AgentPhoneOwner,
  runnerId: RunnerId,
  timeoutMs: number,
): Promise<void> {
  await eventually(
    "the phone and the Host to say it is online and ready",
    async () => {
      const [status, { machines }] = await Promise.all([
        readPhoneStatus(device),
        testRpcData(host.origin, "machines.list", {}, { headers: host.ownerHeaders }),
      ]);
      const machine = machines.find((candidate) => candidate.id === runnerId);
      if (
        status.connection === "online" &&
        status.accessibility.connected &&
        machine?.status === "online" &&
        machine.computerUse?.state === "ready"
      ) {
        return true;
      }
      throw new Error(
        `the phone is ${status.connection} (issue ${status.issue?.code ?? "none"}, accessibility ${status.accessibility.connected ? "connected" : "not connected"}) and the Host lists it ${machine?.status ?? "nowhere"} (${machine?.computerUse?.state ?? "no computer use"})`,
      );
    },
    timeoutMs,
  );
}

/* ------------------------------------------------------------------------- *
 * The agents
 * ------------------------------------------------------------------------- */

/**
 * A computer that runs agents, enrolled and connected the way the Runner
 * does, once its engine account is ready to take Threads: the Host lists that
 * account only after the environment has reported its models.
 */
export async function connectAgentComputer(
  host: MachineAccessHost,
  input: {
    readonly key: string;
    readonly redaction: Redaction;
    /** Takes a steered message by restarting the Run, as a Runner whose engine cannot steer does. */
    readonly restartsRuns?: boolean;
    readonly computerTool?: 1;
  },
): Promise<CallerMachine> {
  const name = `Agent computer ${input.key}`;
  const token = await enrollmentToken(host, {
    allowedModules: ["agents"],
    idempotencyKey: input.key,
    name,
  });
  input.redaction.add(token);
  const caller = await connectCallerMachine(host, {
    name,
    rendersImages: true,
    ...(input.computerTool ? { computerTool: input.computerTool } : {}),
    ...(input.restartsRuns ? { restartsRuns: true } : {}),
    token,
  });
  try {
    const harnessInstanceId = await eventually(
      `${name}'s engine to be ready`,
      async () => {
        const bootstrap = await testRpcData(
          host.origin,
          "bootstrap.get",
          {},
          { headers: host.ownerHeaders },
        );
        const environment = bootstrap.environments.find(({ id }) => id === caller.environmentId);
        return environment?.connected
          ? environment.harnessCatalogs.find(({ status }) => status === "ready")?.harnessInstanceId
          : undefined;
      },
      30_000,
    );
    return { ...caller, harnessInstanceId };
  } catch (error) {
    await caller.close();
    throw error;
  }
}

/** One agent: a Run dispatched to an agent computer, and the gateway its engine reaches. */
export interface PhoneAgent {
  readonly gateway: AgentGateway;
  readonly run: CallerRun;
}

/** Dispatches a Run on `caller` in `workspaceId` and connects to its gateway as its engine would. */
export async function startPhoneAgent(
  host: AgentPhoneHost,
  caller: CallerMachine,
  input: {
    readonly key: string;
    readonly redaction: Redaction;
    readonly title: string;
    readonly workspaceId: WorkspaceId;
  },
): Promise<PhoneAgent> {
  const run = await dispatchCallerRun(host, caller, {
    key: input.key,
    title: input.title,
    workspaceId: input.workspaceId,
  });
  input.redaction.add(run.integrationTools.token, run.agentControlToken);
  try {
    return { gateway: await connectAgentGateway(host, run.integrationTools), run };
  } catch (error) {
    // A Run whose engine never reached its gateway is over; it must not hold its binding.
    await run.complete().catch((completion: unknown) => {
      throw new AggregateError([error, completion], "The Run's gateway and its completion failed.");
    });
    throw error;
  }
}

export interface AgentGateway {
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/**
 * Longer than any phone call can take: an act's 60 s deadline and the 6 s
 * the Host waits past it. The MCP client's own default, 60 s, is shorter.
 */
const gatewayCallTimeoutMs = 180_000;

/**
 * A Run's integration gateway exactly as its agent reaches it: MCP over
 * streamable HTTP at the URL the Run was dispatched with, which names the
 * Host's public origin, with the Run's bearer. The requests travel to the
 * Host on loopback carrying that public `Host` — the one header `fetch`
 * will not let a caller set — so cutting the phone's network never cuts the
 * agent's.
 */
export async function connectAgentGateway(
  host: Pick<AgentPhoneHost, "hostPort">,
  tools: { readonly token: string; readonly url: string },
): Promise<AgentGateway> {
  const client = new Client({ name: "agent-phone-e2e-agent", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(tools.url), {
    fetch: loopbackFetch(host.hostPort),
    requestInit: { headers: { authorization: `Bearer ${tools.token}` } },
  });
  await client.connect(transport as Transport);
  return {
    call: async (name, args) =>
      CallToolResultSchema.parse(
        await client.callTool({ arguments: args, name }, undefined, {
          timeout: gatewayCallTimeoutMs,
        }),
      ),
    close: () => client.close(),
  };
}

export type ToolResult = z.infer<typeof CallToolResultSchema>;

const CallToolResultSchema = z.object({
  content: z.array(
    z.union([
      z.object({ text: z.string(), type: z.literal("text") }),
      z.object({ data: z.string(), mimeType: z.string(), type: z.literal("image") }).loose(),
    ]),
  ),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

function loopbackFetch(port: number) {
  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(url);
    const headers = new Headers(init?.headers);
    headers.set("host", target.host);
    const method = init?.method ?? "GET";
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      return Promise.reject(new Error("The agent's gateway sends JSON text bodies only."));
    }
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          headers: Object.fromEntries(headers),
          host: "127.0.0.1",
          method,
          path: `${target.pathname}${target.search}`,
          port,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (response: IncomingMessage) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value))
              for (const entry of value) responseHeaders.append(name, entry);
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          const status = response.statusCode ?? 502;
          const bodiless = status === 204 || status === 205 || status === 304 || method === "HEAD";
          if (bodiless) response.resume();
          resolve(
            new Response(
              bodiless
                ? null
                : new ReadableStream<Uint8Array>({
                    start(controller) {
                      response.on("data", (chunk: Buffer) => {
                        controller.enqueue(new Uint8Array(chunk));
                        if ((controller.desiredSize ?? 0) <= 0) response.pause();
                      });
                      response.once("end", () => controller.close());
                      response.once("error", (error: Error) => controller.error(error));
                    },
                    pull() {
                      response.resume();
                    },
                    cancel() {
                      response.destroy();
                    },
                  }),
              {
                headers: responseHeaders,
                status,
                statusText: response.statusMessage ?? "",
              },
            ),
          );
        },
      );
      request.once("error", reject);
      request.end(body ?? undefined);
    });
  };
}

/** The text a model reads from a tool result. */
export function resultText(result: ToolResult): string {
  const block = result.content.find((entry) => entry.type === "text");
  if (block?.type !== "text") throw new Error(`No text in ${JSON.stringify(result)}`);
  return block.text;
}

/** The JSON a model reads from a successful result's text. */
export function resultJson(result: ToolResult): Record<string, unknown> {
  if (result.isError) throw new Error(`Unexpected tool error: ${resultText(result)}`);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(resultText(result)));
}

export function resultImages(
  result: ToolResult,
): readonly { readonly data: string; readonly mimeType: string }[] {
  return result.content.flatMap((entry) =>
    entry.type === "image" ? [{ data: entry.data, mimeType: entry.mimeType }] : [],
  );
}

const PhoneRowSchema = z.object({
  access: z.enum(["read", "read-write"]).optional(),
  approval: z.string(),
  inUse: z.boolean(),
  name: z.string(),
  nextAction: z.string(),
  runnerId: z.string(),
  state: z.string(),
  toolRefs: z
    .object({ act: z.string().optional(), observe: z.string(), release: z.string() })
    .nullable(),
});
export type PhoneRow = z.infer<typeof PhoneRowSchema>;
export type PhoneToolRefs = NonNullable<PhoneRow["toolRefs"]>;

const SearchCatalogSchema = z.object({
  catalog: z.array(
    z.object({ definitionId: z.string(), phones: z.array(PhoneRowSchema).optional() }).loose(),
  ),
});

/** One phone's row in an `integration_search` for "Android phone", as an agent reads it. */
export function phoneRowOf(search: ToolResult, runnerId: RunnerId): PhoneRow {
  const entry = SearchCatalogSchema.parse(resultJson(search)).catalog.find(
    ({ definitionId }) => definitionId === androidPhoneDefinitionId,
  );
  const row = entry?.phones?.find((candidate) => candidate.runnerId === runnerId);
  if (!row)
    throw new Error(`The Android phone entry does not list the phone: ${JSON.stringify(entry)}`);
  return row;
}

export interface PhoneObservationText {
  readonly elementCount: number;
  readonly foreground: string;
  readonly geometry: { readonly height: number; readonly width: number };
  readonly headline: string;
  readonly locked: boolean;
  readonly observationId: string;
  readonly screen: "on" | "off";
  readonly secureLock: boolean;
  readonly tree: readonly TreeLine[];
  readonly treeText: string;
}

interface TreeLine {
  readonly index: number;
  readonly label: string | null;
  readonly role: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * An observation as the Host renders it for a model: the headline, the
 * header with its id and geometry, the phone's state line by line, then the
 * tree. Every field an agent decides from is read here and nowhere else.
 */
export function readObservation(text: string): PhoneObservationText {
  const lines = text.split("\n");
  const header =
    /^Observation (\S+) of .+ — (\d+) elements(?:, truncated)?\. Screenshot (\d+)×(\d+) px; /u.exec(
      lines[1] ?? "",
    );
  if (!header) throw new Error(`Not an observation:\n${text}`);
  const state = (name: string) => {
    const line = lines.find((entry) => entry.startsWith(`${name}: `));
    if (!line) throw new Error(`The observation has no ${name} line:\n${text}`);
    return line.slice(name.length + 2);
  };
  const tree = lines
    .map((line) =>
      /^\s*\[(\d+)\] (\S+)(?: "((?:[^"\\]|\\.)*)")? \((-?\d+),(-?\d+) (\d+)×(\d+)\)/u.exec(line),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      index: Number(match[1]),
      label:
        match[3] === undefined ? null : match[3].replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
      role: match[2]!,
      bounds: {
        x: Number(match[4]),
        y: Number(match[5]),
        width: Number(match[6]),
        height: Number(match[7]),
      },
    }));
  return {
    elementCount: Number(header[2]),
    foreground: state("Foreground app"),
    geometry: { height: Number(header[4]), width: Number(header[3]) },
    headline: lines[0] ?? "",
    locked: state("Locked") === "yes",
    observationId: header[1]!,
    screen: state("Screen") === "off" ? "off" : "on",
    secureLock: state("Secure lock") === "yes",
    tree,
    treeText: lines.filter((line) => /^\s*\[\d+\] /u.test(line)).join("\n"),
  };
}

/** The index an agent would cite for the first element of `role`, with `label` when given. */
export function elementIndex(
  observation: PhoneObservationText,
  role: string,
  label?: string,
): number {
  const found = observation.tree.find(
    (line) => line.role === role && (label === undefined || line.label === label),
  );
  if (!found) throw new Error(`No ${role} "${label ?? ""}" in:\n${observation.treeText}`);
  return found.index;
}

/** The pixel size a JPEG declares in its frame header. */
export function jpegSize(base64: string): { readonly height: number; readonly width: number } {
  const bytes = Buffer.from(base64, "base64");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("The screenshot is not a JPEG.");
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("The screenshot's JPEG markers are malformed.");
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    // Start-of-frame markers, baseline through lossless; not DHT, JPG or DAC.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("The screenshot has no JPEG frame header.");
}

/* ------------------------------------------------------------------------- *
 * The artifact
 * ------------------------------------------------------------------------- */

/**
 * Every credential a run has seen, kept out of what it writes: the owner's
 * session, enrollment tokens, Run bearers and anything printed as a bearer.
 */
export class Redaction {
  readonly #secrets = new Set<string>();

  add(...secrets: readonly string[]): void {
    for (const secret of secrets) this.#secrets.add(secret);
  }

  apply(text: string): string {
    let result = text;
    for (const secret of this.#secrets)
      if (secret.length >= 8) result = result.replaceAll(secret, "[redacted]");
    // A model may repeat a PIN with spaces or punctuation between its digits.
    for (const secret of this.#secrets) {
      if (/^[0-9]{8,}$/u.test(secret)) {
        result = result.replace(
          new RegExp(secret.split("").join("[\\s,;.:_-]*"), "gu"),
          "[redacted]",
        );
      }
    }
    return result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]");
  }

  /** What went wrong, in words safe to keep. */
  error(error: unknown): string {
    return this.apply(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

/**
 * The device's log for the whole run, through reboots: `adb logcat` follows
 * one boot, so it is started again after each.
 */
export class DeviceLog {
  readonly #device: AndroidDevice;
  readonly #lines: string[] = [];
  #process: ChildProcess | null = null;
  #partial = "";

  constructor(device: AndroidDevice) {
    this.#device = device;
  }

  async start(): Promise<void> {
    await this.stop();
    const child = spawn(adbBinary, ["-s", this.#device.serial, "logcat", "-v", "threadtime"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const text = this.#partial + chunk;
      const lines = text.split("\n");
      this.#partial = lines.pop() ?? "";
      this.#lines.push(...lines);
    });
    this.#process = child;
    await once(child, "spawn");
  }

  async stop(): Promise<void> {
    const child = this.#process;
    this.#process = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "close");
      child.kill("SIGTERM");
      await stopped;
    }
    if (this.#partial) this.#lines.push(this.#partial);
    this.#partial = "";
  }

  /** Every line the device logged, every process's, in `threadtime` format. */
  allLines(): readonly string[] {
    return this.#lines;
  }

  /** Every line one of these processes wrote, in `threadtime` format. */
  linesFrom(pids: ReadonlySet<number>): string[] {
    return this.#lines.filter((line) => {
      const pid = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s/u.exec(line)?.[1];
      return pid !== undefined && pids.has(Number(pid));
    });
  }
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Finalize after processes stop, so every artifact including logs is covered. */
export async function writeDeviceTestManifest(
  directory: string,
  redaction: Redaction,
  teardown: unknown,
): Promise<void> {
  await writeFile(
    join(directory, "commands.json"),
    redaction.apply(JSON.stringify(deviceTestCommands, null, 2)) + "\n",
  );
  await writeFile(
    join(directory, "teardown.json"),
    redaction.apply(JSON.stringify(teardown, null, 2)) + "\n",
  );
  await writeFile(
    join(directory, "revision.txt"),
    await runCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
  );
  const names = (await readdir(directory, { recursive: true }))
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  const sums: string[] = [];
  for (const name of names) {
    if ((await stat(join(directory, name))).isFile())
      sums.push(`${sha256Hex(await readFile(join(directory, name)))}  ${name}`);
  }
  await writeFile(join(directory, "SHA256SUMS"), sums.join("\n") + "\n");
}
