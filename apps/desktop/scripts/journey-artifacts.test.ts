import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  collectCrashReports,
  collectJourneyEvidence,
  copyJourneyEvidence,
  type EvidenceIO,
} from "./journey-artifacts.js";
import { summarizeJourneys } from "./journey-isolation.js";

function fakeIO(originals: Map<string, { mtimeMs: number; content: string }>) {
  const copies = new Map<string, string>();
  const modes = new Map<string, number>();
  const io: EvidenceIO = {
    list: () => [...originals.keys()],
    stat: (file) => ({
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs: originals.get(path.basename(file))!.mtimeMs,
    }),
    mkdir: () => {},
    copy: (source, target) => {
      copies.set(target, originals.get(path.basename(source))!.content);
    },
    setMode: (file, mode) => {
      modes.set(file, mode);
    },
  };
  return { io, copies, modes };
}

it("copies only current diagnostic reports read-only and preserves originals and the manifest count", async () => {
  const originals = new Map([
    ["old.ips", { mtimeMs: 99, content: "old" }],
    ["boundary.ips", { mtimeMs: 100, content: "boundary" }],
    ["new.crash", { mtimeMs: 101, content: "new" }],
    ["other.log", { mtimeMs: 102, content: "other" }],
  ]);
  const before = structuredClone(originals);
  const { io, copies, modes } = fakeIO(originals);
  const crashReports = await collectCrashReports("/home/guest", 100, "/out/windows", io);
  expect(crashReports).toBe(2);
  expect([...copies]).toEqual([
    ["/out/windows/crash-reports/boundary.ips", "boundary"],
    ["/out/windows/crash-reports/new.crash", "new"],
  ]);
  expect([...modes.values()]).toEqual([0o444, 0o444]);
  expect(originals).toEqual(before);
  expect(
    summarizeJourneys(
      ["windows"],
      [{ name: "windows", exitCode: 0, seconds: 1, outcome: "passed", crashReports }],
      true,
    ).journeys[0]?.crashReports,
  ).toBe(2);
});

it("records zero when the diagnostics directory is absent", async () => {
  expect(await collectCrashReports("/missing", 100, "/out/windows")).toBe(0);
});

it("skips reports macOS removes after listing and reports other failures beside the result", async () => {
  const vanished = Object.assign(Error("gone"), { code: "ENOENT" });
  const { io, copies } = fakeIO(
    new Map([
      ["retired.ips", { mtimeMs: 101, content: "retired" }],
      ["moved.ips", { mtimeMs: 101, content: "moved" }],
      ["kept.ips", { mtimeMs: 101, content: "kept" }],
    ]),
  );
  const stat = io.stat;
  const copy = io.copy;
  io.stat = (file) => {
    if (file.endsWith("retired.ips")) throw vanished;
    return stat(file);
  };
  io.copy = (source, target) => {
    if (source.endsWith("moved.ips")) throw vanished;
    copy(source, target);
  };
  expect(await collectCrashReports("/home/guest", 100, "/out/windows", io)).toBe(1);
  expect([...copies.keys()]).toEqual(["/out/windows/crash-reports/kept.ips"]);

  io.list = () => {
    throw Object.assign(Error("EACCES: permission denied"), { code: "EACCES" });
  };
  expect(await collectJourneyEvidence("/home/guest", 100, "/out/windows", undefined, io)).toEqual({
    crashReports: 0,
    evidenceError: "Error: EACCES: permission denied",
  });
});

it("copies only the legacy evidence this run wrote and replaces earlier read-only copies", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "journey-evidence-"));
  try {
    const source = path.join(root, "mac-owner");
    const target = path.join(root, "run", "mac-owner");
    const write = (relative: string, content: string, seconds: number) => {
      const file = path.join(source, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      utimesSync(file, seconds, seconds);
    };
    write("remaining-processes.txt", "first", 1_000);
    write("appkit/exit-code.txt", "0", 1_000);
    write("electron/exit-code.txt", "1", 1_000);
    await copyJourneyEvidence(source, target, 1_000_000);

    write("remaining-processes.txt", "second", 3_000);
    write("appkit/exit-code.txt", "2", 3_000);
    await copyJourneyEvidence(source, target, 2_000_000);
    expect(readFileSync(path.join(target, "remaining-processes.txt"), "utf8")).toBe("second");
    expect(readFileSync(path.join(target, "appkit/exit-code.txt"), "utf8")).toBe("2");
    expect(statSync(path.join(target, "remaining-processes.txt")).mode & 0o777).toBe(0o444);
    expect(readFileSync(path.join(source, "remaining-processes.txt"), "utf8")).toBe("second");
    expect(statSync(path.join(source, "remaining-processes.txt")).mode & 0o222).not.toBe(0);

    const fresh = path.join(root, "fresh", "mac-owner");
    await copyJourneyEvidence(source, fresh, 2_000_000);
    expect(readdirSync(fresh, { recursive: true }).map(String).sort()).toEqual([
      "appkit",
      "appkit/exit-code.txt",
      "remaining-processes.txt",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
