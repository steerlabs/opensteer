import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  bindPath,
  validatePathBinding,
  PathBindingSchema,
  realPathIO,
  type PathIO,
} from "./journey-paths.js";
import {
  ProcessSchema,
  ProcessIdentitySchema,
  realProcessIO,
  stopRegisteredGroups,
  type ProcessIO,
  type ProcessRow,
} from "./journey-processes.js";
export { ProcessSchema, type ProcessRow } from "./journey-processes.js";

// Journeys bind ephemeral ports. Ownership, including recorded process descendants,
// determines which listeners can fail certification.
export const LISTENER_POLICY = "test-processes-and-recorded-group-descendants";
export const JOURNEY_NAMES = [
  "saved-password",
  "chrome-background",
  "windows",
  "launch",
  "remote-input",
  "native-browser",
  "electron",
  "live-swift",
] as const;
export const JOURNEY_TMP_PREFIX = "/tmp/oj-";
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-([a-f0-9]{8})$/;
export function journeyTemporaryDirectory(runId: string, journey: string): string {
  const match = RUN_ID_PATTERN.exec(runId);
  if (!match || !(journey === "mac-owner" || JOURNEY_NAMES.some((name) => name === journey)))
    throw Error("Invalid journey temporary directory");
  return `${JOURNEY_TMP_PREFIX}${match[1]}-${journey}`;
}
export function journeyApplicationDirectory(home: string, runId: string, journey: string): string {
  journeyTemporaryDirectory(runId, journey);
  return path.join(home, "Applications", `opensteer-window-groups.${runId}-${journey}`);
}
export const NATIVE_RESOURCE_CACHE = ".cache/opensteer/journey-resources";
export const KEYCHAIN_PREFIX = "opensteer-journey-";
export const PROCESS_PREFIXES = [
  "Electron",
  "Google Chrome",
  "ComputerUseHelper",
  "Opensteer Computer Use",
  "Opensteer Passwords",
  "PasswordsBroker",
  "WindowGroupFixture",
  "BackgroundInputFixture",
  "OverlayVisibility",
  "Receiver",
];
export const CANONICAL_PATHS = [
  "Library/Application Support/Opensteer",
  "Library/Application Support/Opensteer (Development)",
  "Library/Application Support/Electron",
  "Library/Application Support/Google/Chrome",
  "Library/Preferences/com.google.Chrome.plist",
  "Applications/Opensteer Journey Fixtures",
  "Library/Preferences/com.opensteer",
  "Library/Preferences/com.opensteer.window-group-fixture.plist",
  "Library/Preferences/com.opensteer.chrome-journey-fixture.plist",
  "Library/Preferences/com.opensteer.overlay-visibility-fixture.plist",
];
export const NETWORK_EGRESS = [
  "registry.npmjs.org (frozen pnpm install)",
  "github.com and release-assets.githubusercontent.com (Electron)",
  "dl.google.com (Chrome DMG)",
  "cdn.playwright.dev and playwright.download.prss.microsoft.com (Playwright Chromium)",
];
export const InventorySchema = z.object({
  processes: z.array(ProcessSchema),
  listeners: z.array(z.string()),
  otherListeners: z.array(z.string()).default([]),
  apps: z.array(z.string()),
  keychain: z.array(z.string()),
  canonical: z.array(z.string()),
  temporary: z.array(z.string()).default([]),
  marker: z.boolean(),
});
export type Inventory = z.infer<typeof InventorySchema>;
export const RegistrationSchema = z.object({
  version: z.literal(2),
  runId: z.string().regex(RUN_ID_PATTERN),
  out: z.string(),
  output: PathBindingSchema,
  groups: z.array(ProcessIdentitySchema),
  canonical: z.array(PathBindingSchema),
  temporary: z.array(PathBindingSchema),
  keychain: z.array(z.string()),
});
export type Registration = z.infer<typeof RegistrationSchema>;
export function validateRegistration(
  value: unknown,
  home: string,
  io: PathIO = realPathIO,
): Registration {
  const reg = RegistrationSchema.parse(value);
  validateRun(reg.runId, reg.out, home, true);
  if (reg.output.path !== reg.out) throw Error("Ownership output mismatch");
  validatePathBinding(reg.output, io);
  for (const binding of reg.canonical) {
    if (!CANONICAL_PATHS.some((relative) => path.join(home, relative) === binding.path))
      throw Error("Unregistered canonical location");
    validatePathBinding(binding, io);
  }
  for (const binding of reg.temporary) {
    if (
      ![...JOURNEY_NAMES, "mac-owner"].some(
        (name) =>
          journeyTemporaryDirectory(reg.runId, name) === binding.path ||
          (name !== "mac-owner" &&
            journeyApplicationDirectory(home, reg.runId, name) === binding.path),
      )
    )
      throw Error("Unregistered temporary location");
    validatePathBinding(binding, io);
  }
  if (reg.keychain.some((service) => !service.startsWith(`${KEYCHAIN_PREFIX}${reg.runId}-`)))
    throw Error("Unregistered keychain service");
  return reg;
}
export interface IsolationPorts {
  collect(): Inventory;
  cleanup(inventory: Inventory): string[] | Promise<string[]>;
}

export function callingSession(processes: ProcessRow[], caller: number): Set<number> {
  const ignored = new Set<number>();
  let row = processes.find((p) => p.pid === caller);
  while (row) {
    ignored.add(row.pid);
    row = processes.find((p) => p.pid === row!.ppid);
  }
  // Ignore only this connection's sshd descendants, never another ssh session.
  const ssh = processes.find((p) => ignored.has(p.pid) && /sshd:/.test(p.command));
  if (ssh) {
    const descendants = new Set([ssh.pid]);
    for (let i = 0; i < processes.length; i++)
      for (const p of processes) if (descendants.has(p.ppid)) descendants.add(p.pid);
    for (const pid of descendants) ignored.add(pid);
  }
  return ignored;
}
export function residue(value: Inventory): boolean {
  return (
    value.marker ||
    [
      value.processes,
      value.listeners,
      value.apps,
      value.keychain,
      value.canonical,
      value.temporary,
    ].some((rows) => rows.length > 0)
  );
}
export async function certify(
  phase: "preflight" | "postflight",
  ports: IsolationPorts,
  baseline?: Inventory,
) {
  const found = ports.collect();
  const removed = await ports.cleanup(found);
  const after = ports.collect();
  const remaining = baseline ? difference(after, baseline) : after;
  const clean = !residue(remaining);
  return {
    found,
    removed,
    after,
    remaining,
    clean,
    exitCode: clean ? 0 : phase === "preflight" ? 3 : 4,
  };
}
export function difference(after: Inventory, before: Inventory): Inventory {
  const extra = (a: string[], b: string[]) => a.filter((row) => !b.includes(row));
  return {
    processes: after.processes.filter(
      (row) => !before.processes.some((p) => p.pid === row.pid && p.command === row.command),
    ),
    listeners: extra(after.listeners, before.listeners),
    otherListeners: after.otherListeners,
    apps: extra(after.apps, before.apps),
    keychain: extra(after.keychain, before.keychain),
    canonical: extra(after.canonical, before.canonical),
    temporary: extra(after.temporary, before.temporary),
    marker: false,
  };
}
export function guestAllowed(home: string): boolean {
  return (
    existsSync(path.join(home, ".opensteer-test-guest")) ||
    (home === "/Users/admin" && existsSync(path.join(home, "opensteer-job")))
  );
}
export function validateRun(runId: string, out: string, home: string, legacy = false): void {
  if (!RUN_ID_PATTERN.test(runId)) throw Error("Invalid run ID");
  if (
    path.resolve(out) !== path.join(home, "opensteer-runs", runId) &&
    !(legacy && path.resolve(out) === path.join(home, "opensteer-job/artifacts/journeys"))
  )
    throw Error("Output must be HOME/opensteer-runs/runId");
}
export interface InventoryIO extends PathIO, ProcessIO {
  exists(file: string): boolean;
  list(directory: string): string[];
  remove(file: string): void;
  command(file: string, args: string[], emptyCode?: number): string;
}
export const realInventoryIO: InventoryIO = {
  ...realPathIO,
  ...realProcessIO,
  exists: existsSync,
  list: (directory) => readdirSync(directory),
  remove: (file) => rmSync(file, { recursive: true, force: true }),
  command(file, args, emptyCode) {
    try {
      return execFileSync(file, args, {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      if (
        emptyCode !== undefined &&
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === emptyCode
      )
        return "";
      throw error;
    }
  },
};
export function validateOutputDirectory(
  runId: string,
  out: string,
  home: string,
  legacy = false,
  io: PathIO = realPathIO,
) {
  validateRun(runId, out, home, legacy);
  return bindPath(out, io);
}
export function legacyJourneyOutput(home: string): string {
  return path.join(home, "opensteer-job/artifacts/journeys");
}
export function systemPorts(
  home: string,
  caller: number,
  registration?: Registration,
  io: InventoryIO = realInventoryIO,
): IsolationPorts {
  if (
    !io.exists(path.join(home, ".opensteer-test-guest")) &&
    !(home === "/Users/admin" && io.exists(path.join(home, "opensteer-job")))
  )
    throw Error("Collectors require a test guest");
  if (registration) validateRegistration(registration, home, io);
  const command = io.command;
  const processTable = () => io.processes();
  return {
    collect() {
      const processes = processTable();
      const ignored = callingSession(processes, caller);
      const residuePids = new Set(
        processes
          .filter(
            (p) =>
              !ignored.has(p.pid) &&
              (PROCESS_PREFIXES.some((prefix) => p.command.includes(prefix)) ||
                p.command.includes("/opensteer-runs/") ||
                p.command.includes(JOURNEY_TMP_PREFIX) ||
                registration?.groups.some((g) => g.pgid === p.pgid || g.pid === p.pid)),
          )
          .map((p) => p.pid),
      );
      for (let i = 0; i < processes.length; i++) {
        let changed = false;
        for (const p of processes)
          if (residuePids.has(p.ppid) && !residuePids.has(p.pid)) {
            residuePids.add(p.pid);
            changed = true;
          }
        if (!changed) break;
      }
      const relevant = processes.filter((p) => residuePids.has(p.pid) && !ignored.has(p.pid));
      const listeners = command("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], 1).split("\n");
      let pid = 0;
      const ports: string[] = [];
      const otherListeners: string[] = [];
      for (const row of listeners) {
        if (row.startsWith("p")) pid = Number(row.slice(1));
        if (row.startsWith("n")) {
          const target = residuePids.has(pid) && !ignored.has(pid) ? ports : otherListeners;
          target.push(`${pid}:${row.slice(1)}`);
        }
      }
      // dump-keychain prints attributes only (never -d); find verifies exact services.
      const services = [
        ...command("security", ["dump-keychain"]).matchAll(/"svce"<blob>="([^"]+)"/g),
      ]
        .map((m) => m[1]!)
        .filter((s) => s.startsWith(KEYCHAIN_PREFIX));
      for (const service of services) command("security", ["find-generic-password", "-s", service]);
      const canonical = new Set(CANONICAL_PATHS.filter((p) => io.exists(path.join(home, p))));
      for (const base of ["Library/Application Support", "Library/Preferences", "Applications"]) {
        if (io.exists(path.join(home, base)))
          for (const entry of io.list(path.join(home, base)))
            if (/^(Opensteer|com\.opensteer)/i.test(entry)) canonical.add(path.join(base, entry));
      }
      const temporary = io.exists("/tmp")
        ? io
            .list("/tmp")
            .filter((entry) => entry.startsWith(path.basename(JOURNEY_TMP_PREFIX)))
            .map((entry) => path.join("/tmp", entry))
            .sort()
        : [];
      if (io.exists(path.join(home, "Applications")))
        for (const entry of io.list(path.join(home, "Applications")))
          if (entry.startsWith("opensteer-window-groups."))
            temporary.push(path.join(home, "Applications", entry));
      const apps = command("osascript", [
        "-e",
        'tell application "System Events"\nset taskInventoryText to ""\nrepeat with p in (every application process whose background only is false)\nset taskInventoryText to taskInventoryText & (name of p) & ":" & (unix id of p) & ":" & (count of windows of p) & linefeed\nend repeat\nreturn taskInventoryText\nend tell',
      ])
        .trim()
        .split("\n")
        .filter((row) => PROCESS_PREFIXES.some((prefix) => row.includes(prefix)));
      return {
        processes: relevant,
        listeners: ports,
        otherListeners,
        apps,
        keychain: services,
        canonical: [...canonical].sort(),
        temporary,
        marker: io.exists(path.join(home, ".opensteer-journeys/active.json")),
      };
    },
    async cleanup(inventory) {
      if (!registration) return [];
      // Validation is repeated immediately before each destructive operation.
      validateRegistration(registration, home, io);
      const removed = await stopRegisteredGroups(registration, io);
      for (const service of registration.keychain)
        if (inventory.keychain.includes(service)) {
          validateRegistration(registration, home, io);
          command("security", ["delete-generic-password", "-s", service]);
          removed.push(`keychain:${service}`);
        }
      for (const binding of [...registration.canonical, ...registration.temporary]) {
        validatePathBinding(binding, io);
        if (!io.lstat(binding.path)) continue;
        io.remove(binding.realPath);
        removed.push(binding.path);
        // Once a bound inode is deleted, its authority is gone. Retaining it would
        // make the next journal write reject the cleanup we just completed.
        if (
          !io.lstat(binding.path) &&
          binding.ancestors.some((anchor) => anchor.path === binding.path)
        ) {
          registration.canonical = registration.canonical.filter(
            (item) => item.path !== binding.path,
          );
          registration.temporary = registration.temporary.filter(
            (item) => item.path !== binding.path,
          );
        }
      }
      return removed;
    },
  };
}
export function readRegistration(file: string): Registration | undefined {
  if (!existsSync(file)) return undefined;
  bindPath(file);
  return RegistrationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export const PreflightSchema = z.object({
  runId: z.string(),
  clean: z.literal(true),
  after: InventorySchema,
});
export function authorizeRun(preflight: unknown, runId: string, sha: string, head: string) {
  const value = PreflightSchema.parse(preflight);
  if (value.runId !== runId || !/^[a-f0-9]{40}$/.test(sha) || head !== sha)
    throw Error("Clean preflight and exact HEAD SHA required");
  return value;
}
export interface JourneyRow {
  name: string;
  exitCode: number;
  seconds: number;
  outcome: string;
  crashReports?: number;
}
export function summarizeJourneys(selected: string[], results: JourneyRow[], prepared: boolean) {
  const journeys = selected.map(
    (name) =>
      results.find((row) => row.name === name) ?? {
        name,
        exitCode: 1,
        seconds: 0,
        outcome: "skipped",
        crashReports: 0,
      },
  );
  const passed =
    prepared && journeys.every((row) => row.exitCode === 0 && row.outcome === "passed");
  return { journeys, passed, exitCode: passed ? 0 : 1 };
}
