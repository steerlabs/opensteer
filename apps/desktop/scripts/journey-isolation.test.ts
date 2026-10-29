import path from "node:path";
import { expect, it, vi } from "vitest";
import { bindPath, validatePathBinding, type PathMetadata } from "./journey-paths.js";
import { stopRegisteredGroups, type ProcessRow } from "./journey-processes.js";
import { passwordsBrokerSocketPath } from "../src/passwords/paths.js";
import {
  authorizeRun,
  certify,
  callingSession,
  JOURNEY_NAMES,
  journeyTemporaryDirectory,
  journeyApplicationDirectory,
  legacyJourneyOutput,
  validateOutputDirectory,
  validateRegistration,
  summarizeJourneys,
  type Inventory,
  type InventoryIO,
  type Registration,
} from "./journey-isolation.js";
const id = "20261028T222834Z-2fe09fb7";
const empty = (): Inventory => ({
  processes: [],
  listeners: [],
  otherListeners: [],
  apps: [],
  keychain: [],
  canonical: [],
  temporary: [],
  marker: false,
});
function fixture() {
  const nodes = new Map<string, PathMetadata & { target?: string }>();
  let serial = 0;
  const processes = new Map<number, ProcessRow>();
  const services = new Set<string>();
  const listeners: string[] = [];
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const removed: string[] = [];
  const realpath = (file: string): string => {
    for (let i = 0; i < 10; i++) {
      const link = [...nodes].find(
        ([name, node]) => node.kind === "symlink" && (file === name || file.startsWith(name + "/")),
      );
      if (!link) return file;
      file = link[1].target! + file.slice(link[0].length);
    }
    throw Error("Symlink loop");
  };
  const add = (file: string, kind: PathMetadata["kind"] = "directory", target?: string) => {
    if (file !== "/" && !nodes.has(path.dirname(file))) add(path.dirname(file));
    nodes.set(file, { kind, dev: "disk", ino: String(++serial), ...(target ? { target } : {}) });
  };
  add("/");
  add("/tmp");
  add("/guest/.opensteer-test-guest", "file");
  const out = `/guest/opensteer-runs/${id}`;
  add(out);
  const io: InventoryIO = {
    lstat(file) {
      const parent = path.dirname(file);
      return nodes.get(file === "/" ? "/" : path.join(realpath(parent), path.basename(file)));
    },
    realpath,
    exists: (file) => Boolean(io.lstat(file)),
    list: (directory) =>
      [...nodes.keys()]
        .filter((file) => file !== "/" && path.dirname(file) === realpath(directory))
        .map((file) => path.basename(file)),
    remove(file) {
      removed.push(file);
      for (const name of nodes.keys())
        if (name === file || name.startsWith(file + "/")) nodes.delete(name);
    },
    processes: () => [...processes.values()],
    signal(pid, signal) {
      signals.push({ pid, signal });
      for (const [key, row] of processes)
        if (pid < 0 ? row.pgid === -pid : key === pid) processes.delete(key);
      return true;
    },
    pause: async () => {},
    command(file, args) {
      if (file === "lsof") return listeners.join("\n");
      if (file === "osascript") return "";
      if (file === "security") {
        if (args[0] === "dump-keychain")
          return [...services].map((s) => `"svce"<blob>="${s}"`).join("\n");
        if (args[0] === "delete-generic-password") services.delete(args[2]!);
        return "";
      }
      throw Error(`Unexpected command ${file}`);
    },
  };
  const registration = (): Registration => ({
    version: 2,
    runId: id,
    out,
    output: bindPath(out, io),
    groups: [],
    canonical: [],
    temporary: [],
    keychain: [],
  });
  const processRow = (
    pid: number,
    command: string,
    pgid = pid,
    ppid = 1,
    startedAt = "old-start",
  ) => {
    const row = { pid, command, pgid, ppid, startedAt };
    processes.set(pid, row);
    return row;
  };
  return {
    nodes,
    add,
    io,
    out,
    registration,
    processRow,
    processes,
    services,
    listeners,
    signals,
    removed,
  };
}
it("certifies a clean fixture baseline", async () => {
  const f = fixture();
  expect((await certify("preflight", system(f))).exitCode).toBe(0);
});
function system(f: ReturnType<typeof fixture>, reg?: Registration) {
  return systemPorts("/guest", 999, reg, f.io);
}
import { systemPorts } from "./journey-isolation.js";
it.each(["Chrome", "Electron"])("removes registered stale %s data only", async (name) => {
  const f = fixture(),
    reg = f.registration();
  const root =
    name === "Chrome"
      ? "/guest/Library/Application Support/Google/Chrome"
      : "/guest/Library/Application Support/Electron";
  reg.canonical.push(bindPath(root, f.io));
  f.add(root);
  expect((await certify("preflight", system(f, reg))).exitCode).toBe(0);
  expect(f.removed).toEqual([root]);
});
it("removes only exact registered keychain items and reports unknown prefixed items", async () => {
  const f = fixture(),
    reg = f.registration();
  const owned = `opensteer-journey-${id}-launch-item`,
    unknown = "opensteer-journey-unregistered";
  reg.keychain.push(owned);
  f.services.add(owned);
  f.services.add(unknown);
  f.services.add("personal");
  expect((await certify("preflight", system(f, reg))).exitCode).toBe(3);
  expect(f.services).toEqual(new Set([unknown, "personal"]));
});
it("reports unregistered temp roots without deleting them or killing path mentions", async () => {
  const f = fixture();
  const root = journeyTemporaryDirectory(id, "launch");
  f.add(root);
  f.processRow(80, `grep ${root}/ipc.sock`);
  expect((await certify("preflight", system(f))).exitCode).toBe(3);
  expect((await certify("postflight", system(f), empty())).exitCode).toBe(4);
  expect(f.io.exists(root)).toBe(true);
  expect(f.removed).toEqual([]);
  expect(f.signals).toEqual([]);
});
it("postflight deletes exactly the validated registered temp root", async () => {
  const f = fixture(),
    reg = f.registration(),
    root = journeyTemporaryDirectory(id, "launch");
  reg.temporary.push(bindPath(root, f.io));
  f.add(root);
  f.add("/tmp/oj-unregistered");
  expect((await certify("postflight", system(f, reg), empty())).exitCode).toBe(4);
  expect(f.removed).toEqual([root]);
  expect(f.io.exists("/tmp/oj-unregistered")).toBe(true);
});
it("rejects symlinked canonical ancestors and changed real-location bindings before deletion", async () => {
  const f = fixture(),
    reg = f.registration();
  const base = "/guest/Library/Application Support/Google";
  f.add(base);
  reg.canonical.push(bindPath(base + "/Chrome", f.io));
  f.add(base + "/Chrome");
  f.add("/outside/Chrome");
  f.add(base, "symlink", "/outside");
  expect(() => system(f, reg)).toThrow(/symlink/);
  expect(f.removed).toEqual([]);
  expect(f.io.exists("/outside/Chrome")).toBe(true);
  expect(() => bindPath(base + "/Chrome", f.io)).toThrow(/symlink/);
});
it("rejects symlinked output ancestors and replaced directory identities", async () => {
  const f = fixture();
  const bound = validateOutputDirectory(id, f.out, "/guest", false, f.io);
  f.add("/guest/opensteer-runs", "symlink", "/outside");
  expect(() => validateOutputDirectory(id, f.out, "/guest", false, f.io)).toThrow(/symlink/);
  f.add("/guest/opensteer-runs");
  expect(() => validatePathBinding(bound, f.io)).toThrow(/ancestor changed/);
});
it("binds the explicit system tmp alias and rejects its later redirection", async () => {
  const f = fixture();
  f.add("/private/tmp");
  f.add("/tmp", "symlink", "/private/tmp");
  const reg = f.registration(),
    root = journeyTemporaryDirectory(id, "launch");
  reg.temporary.push(bindPath(root, f.io));
  f.add("/private" + root);
  expect(reg.temporary[0]?.realPath).toBe("/private" + root);
  expect((await certify("postflight", system(f, reg), empty())).exitCode).toBe(0);
  expect(f.removed).toEqual(["/private" + root]);
  f.add("/tmp", "symlink", "/outside");
  expect(() => validateRegistration(reg, "/guest", f.io)).toThrow(/symlink/);
});
it("does not signal grep or any command that merely mentions registered paths", async () => {
  const f = fixture(),
    reg = f.registration();
  f.processRow(81, `grep ${reg.out}/result.json`);
  expect((await certify("preflight", system(f, reg))).exitCode).toBe(3);
  expect(f.signals).toEqual([]);
  expect(f.processes.has(81)).toBe(true);
});
it("does not signal a reused PID and retires only confirmed terminated groups", async () => {
  const f = fixture(),
    reg = f.registration();
  reg.groups.push({ pid: 50, pgid: 50, startedAt: "old-start" });
  f.processRow(50, "node unrelated", 50, 1, "new-start");
  await stopRegisteredGroups(reg, f.io);
  expect(f.signals).toEqual([]);
  f.processes.clear();
  await stopRegisteredGroups(reg, f.io);
  expect(reg.groups).toEqual([]);
  f.processRow(50, "node later", 50);
  await stopRegisteredGroups(reg, f.io);
  expect(f.signals).toEqual([]);
});
it("revalidates leader start time before escalation instead of signaling a recycled PGID", async () => {
  const f = fixture(),
    reg = f.registration();
  reg.groups.push({ pid: 50, pgid: 50, startedAt: "old-start" });
  f.processRow(50, "wrapper");
  f.io.signal = (pid, signal) => {
    f.signals.push({ pid, signal });
    f.processRow(50, "replacement", 50, 1, "new-start");
    return true;
  };
  await stopRegisteredGroups(reg, f.io);
  expect(f.signals).toEqual([{ pid: -50, signal: "SIGTERM" }]);
});
it("stops verified registered groups and removes their historical authority", async () => {
  const f = fixture(),
    reg = f.registration();
  const row = f.processRow(50, "wrapper");
  reg.groups.push({ pid: row.pid, pgid: row.pgid, startedAt: row.startedAt });
  f.processRow(51, "child", 50, 50);
  expect((await certify("postflight", system(f, reg), empty())).exitCode).toBe(0);
  expect(reg.groups).toEqual([]);
  expect(f.processes.size).toBe(0);
});
it("refuses an interrupted marker without granting cleanup authority", async () => {
  const f = fixture();
  f.add("/guest/.opensteer-journeys/active.json", "file");
  const report = await certify("preflight", system(f));
  expect(report.found.marker).toBe(true);
  expect(report.exitCode).toBe(3);
  expect(f.removed).toEqual([]);
});
it("refuses unknown canonical residue without removing it", async () => {
  const f = fixture();
  f.add("/guest/Library/Application Support/Opensteer unknown");
  expect((await certify("preflight", system(f))).exitCode).toBe(3);
  expect((await certify("postflight", system(f), empty())).exitCode).toBe(4);
  expect(f.removed).toEqual([]);
});
it("fails an orphan test listener without signaling an unregistered process", async () => {
  const f = fixture();
  f.processRow(60, "Electron orphan");
  f.listeners.push("p60", "n127.0.0.1:18900");
  const report = await certify("preflight", system(f));
  expect(report.after.listeners).toEqual(["60:127.0.0.1:18900"]);
  expect(report.exitCode).toBe(3);
  expect((await certify("postflight", system(f), empty())).exitCode).toBe(4);
  expect(f.signals).toEqual([]);
});
it("records non-test daemon listeners without failing certification", async () => {
  const f = fixture();
  f.processRow(70, "ControlCenter");
  f.processRow(71, "rapportd");
  f.listeners.push("p70", "n*:5000", "n*:7000", "p71", "n*:52101");
  const result = await certify("preflight", system(f));
  expect(result.exitCode).toBe(0);
  expect(result.after.otherListeners).toHaveLength(3);
  expect((await certify("postflight", system(f), empty())).exitCode).toBe(0);
});
it("retains separate ssh sessions while ignoring the calling session", async () => {
  const f = fixture();
  const rows = [
    f.processRow(10, "sshd: admin"),
    f.processRow(11, "bash", 10, 10),
    f.processRow(12, "collector", 10, 11),
    f.processRow(20, "sshd: other"),
  ];
  expect(callingSession(rows, 12).has(20)).toBe(false);
});
it.each(["/Users/admin", "/Users/opensteer-test"])(
  "keeps journey sockets below 100 bytes with HOME=%s",
  (home) => {
    vi.stubEnv("HOME", home);
    try {
      for (const name of JOURNEY_NAMES) {
        const root = journeyTemporaryDirectory(id, name);
        expect(root).toBe(`/tmp/oj-2fe09fb7-${name}`);
        expect(
          Buffer.byteLength(
            path.join("/private", root, "opensteer-overlay-launch-XXXXXX/ipc.sock"),
          ),
        ).toBeLessThanOrEqual(100);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
it("preserves the legacy selector manifest and saved-password evidence layout", async () => {
  const f = fixture();
  const out = legacyJourneyOutput("/guest");
  expect(path.join(out, "manifest.json")).toBe(
    "/guest/opensteer-job/artifacts/journeys/manifest.json",
  );
  expect(path.join(out, "saved-password/mac")).toBe(
    "/guest/opensteer-job/artifacts/journeys/saved-password/mac",
  );
  expect(() => validateOutputDirectory(id, out, "/guest", true, f.io)).not.toThrow();
});
it("fits the folded password fixture's broker socket beneath its registered temp root", () => {
  const home = path.join(journeyTemporaryDirectory(id, "electron"), "XXXXXX");
  expect(Buffer.byteLength(passwordsBrokerSocketPath(true, home))).toBeLessThan(104);
});
it("reserves authorization refusal for missing, dirty, wrong-run and wrong-SHA preflights", async () => {
  const pre = { runId: id, clean: true, after: empty() },
    sha = "a".repeat(40);
  expect(() => authorizeRun(undefined, id, sha, sha)).toThrow();
  expect(() => authorizeRun({ ...pre, clean: false }, id, sha, sha)).toThrow();
  expect(() => authorizeRun(pre, "other", sha, sha)).toThrow();
  expect(() => authorizeRun(pre, id, sha, "b".repeat(40))).toThrow();
  expect(authorizeRun(pre, id, sha, sha).clean).toBe(true);
});
it("never treats a skipped or never-started journey as a pass", async () => {
  expect(summarizeJourneys(["launch"], [], true)).toMatchObject({
    exitCode: 1,
    passed: false,
    journeys: [{ outcome: "skipped" }],
  });
});

it("cleans the exact registered Applications root without adopting prefix matches", async () => {
  const f = fixture();
  const work = journeyApplicationDirectory("/guest", id, "windows");
  const unrelated = "/guest/Applications/opensteer-window-groups.unregistered";
  f.add(work);
  f.add(work + "/Fixture.app");
  f.add(unrelated);
  const reg = f.registration();
  reg.temporary = [bindPath(work, f.io)];
  validateRegistration(reg, "/guest", f.io);
  const ports = systemPorts("/guest", 9999, reg, f.io);
  const report = await certify("postflight", ports, empty());
  expect(f.io.exists(work)).toBe(false);
  expect(() => validateRegistration(reg, "/guest", f.io)).not.toThrow();
  expect(f.io.exists(unrelated)).toBe(true);
  expect(report.remaining.temporary).toEqual([unrelated]);
  expect(report.exitCode).toBe(4);
});
