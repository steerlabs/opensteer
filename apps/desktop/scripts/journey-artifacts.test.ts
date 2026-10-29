import { expect, it } from "vitest";
import { collectCrashReports, type CrashReportIO } from "./journey-artifacts.js";
import { summarizeJourneys } from "./journey-isolation.js";

it("copies only current diagnostic reports read-only and preserves originals and the manifest count", async () => {
  const originals = new Map([
    ["old.ips", { mtimeMs: 99, content: "old" }],
    ["boundary.ips", { mtimeMs: 100, content: "boundary" }],
    ["new.crash", { mtimeMs: 101, content: "new" }],
    ["other.log", { mtimeMs: 102, content: "other" }],
  ]);
  const before = structuredClone(originals);
  const copies = new Map<string, string>();
  const modes = new Map<string, number>();
  const io: CrashReportIO = {
    list: () => [...originals.keys()],
    stat: (file) => ({
      isFile: () => true,
      mtimeMs: originals.get(file.split("/").at(-1)!)!.mtimeMs,
    }),
    mkdir: () => {},
    copy: (source, target) => {
      copies.set(target, originals.get(source.split("/").at(-1)!)!.content);
    },
    chmod: (file, mode) => {
      modes.set(file, mode);
    },
  };
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
