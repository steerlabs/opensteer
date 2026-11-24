import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@opensteer/database";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { HomeHealthReportSchema, reportTime } from "@opensteer/protocol/problems";
import { describe, expect, it, vi } from "vitest";
import { HomeProblems, machineStatusFile, problemReportDestination } from "./home-problems.js";

const managed = {
  managedHome: {
    accountOrigin: new URL("https://account.example.test"),
    cloudComputerId: "cc_00000000-0000-4000-8000-000000000001",
    generation: 1,
    oidc: { clientId: "occ_1", clientSecret: "ocs_secret" },
  },
} as const;

describe("a Home's problems and its one report", () => {
  it("sends to one address its operator configured, and from a person's own Home nowhere", () => {
    expect(problemReportDestination(managed)).toMatchObject({
      kind: "operator",
      url: new URL(
        "https://account.example.test/v1/cloud-computers/cc_00000000-0000-4000-8000-000000000001/health",
      ),
    });
    // A Mac names its Opensteer account, and still sends it nothing.
    expect(
      problemReportDestination({
        personalAccountIssuer: new URL("https://account.example.test"),
      } as never),
    ).toEqual({ kind: "none" });
    expect(
      problemReportDestination({ problemReportsOrigin: new URL("https://collector.self.example") }),
    ).toEqual({ kind: "own", url: new URL("https://collector.self.example/v1/problem-reports") });
    expect(problemReportDestination({})).toEqual({ kind: "none" });
  });

  it("builds the report from fixed values and sends a self-hoster's collector exactly what Settings shows", async () => {
    const clone = await cloneTestDatabase("host");
    const database = createDatabase({ connectionString: clone.url });
    const directory = mkdtempSync(join(tmpdir(), "home-problems-"));
    try {
      await seedPersonalFixture(database, "/tmp/problems-home");
      const now = Date.now();
      writeFileSync(
        join(directory, machineStatusFile),
        JSON.stringify({
          services: { host: "healthy", runner: "unhealthy" },
          lastBackup: {
            result: "failed",
            failure: "repository-unreachable",
            at: reportTime(now),
          },
          lastUpdate: {
            result: "rolled-back",
            at: reportTime(now),
            toVersion: "1.4.0",
          },
        }),
      );
      const sent: { url: string; init: RequestInit }[] = [];
      const fetch = vi.fn(async (url: URL | string, init: RequestInit = {}) => {
        sent.push({ url: String(url), init });
        return new Response(null, { status: 204 });
      });
      const problems = new HomeProblems({
        database,
        dataDirectory: directory,
        home: "server",
        readsMachineStatus: true,
        version: "1.4.0 /home/alex",
        // A stand-in for the disk: what is on this machine's own disk is not the test's (U7).
        readDisk: async () => "under-70",
        // A self-hoster's own collector receives the full report.
        destination: {
          kind: "own",
          url: new URL("https://collector.self.example/v1/problem-reports"),
        },
        fetch: fetch as typeof globalThis.fetch,
      });
      const report = await problems.report();
      expect(HomeHealthReportSchema.parse(report)).toEqual(report);
      expect(report).toMatchObject({
        home: "server",
        // A version that is not a release version is never sent as it is.
        version: "0.0.0",
        services: { host: "healthy", runner: "unhealthy" },
      });
      expect(report.problems.map(({ code }) => code).toSorted()).toEqual([
        "backup.failed",
        "home.service_unhealthy",
        "update.failed",
      ]);

      // On a Mac nothing of root's writes this file, and the person's own agents could: it is
      // never read there.
      const mac = new HomeProblems({
        database,
        dataDirectory: directory,
        home: "mac",
        readsMachineStatus: false,
        version: "1.4.0",
        // A stand-in for the disk: what is on this machine's own disk is not the test's (U7).
        readDisk: async () => "under-70",
        destination: { kind: "none" },
      });
      expect(await mac.report()).not.toHaveProperty("services");
      expect((await mac.report()).problems).toEqual([]);

      // Its operator set the address: that is the consent, and it sends on its timer.
      expect(problems.reporting()).toEqual({ destination: "own" });
      problems.start();
      expect(problems.scheduled()).toBe(true);
      await problems.sendOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe("https://collector.self.example/v1/problem-reports");
      // No credentials for a person's own Home, and the exact bytes the person sees (S6).
      expect(new Headers(sent[0]!.init.headers).has("authorization")).toBe(false);
      expect(sent[0]!.init.body).toBe((await problems.view()).body);
      expect(JSON.parse(String(sent[0]!.init.body))).toEqual(await problems.report());
      expect(problems.reporting()).toMatchObject({ destination: "own", lastResult: "sent" });

      // A machine status the maintenance stopped writing says nothing about services now.
      utimesSync(
        join(directory, machineStatusFile),
        new Date(now - 3_600_000),
        new Date(now - 3_600_000),
      );
      expect(await problems.report()).not.toHaveProperty("services");
      // A link in its place is not the file root wrote: it says nothing (S1).
      const elsewhere = join(directory, "elsewhere.json");
      writeFileSync(elsewhere, JSON.stringify({ services: { host: "healthy" } }));
      rmSync(join(directory, machineStatusFile));
      symlinkSync(elsewhere, join(directory, machineStatusFile));
      expect(await problems.report()).not.toHaveProperty("services");
      rmSync(join(directory, machineStatusFile));
      // Anything but the fixed values makes the file say nothing at all.
      writeFileSync(join(directory, machineStatusFile), JSON.stringify({ note: "/Users/alex" }));
      expect(await problems.report()).toEqual({
        schema: 1,
        home: "server",
        version: "0.0.0",
        disk: "under-70",
        problems: [],
      });
      await problems.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await database.destroy();
      await clone.drop();
    }
  });

  it("on a person's own Home has no timer, sends nothing and has no body to show (S10)", async () => {
    const clone = await cloneTestDatabase("host");
    const database = createDatabase({ connectionString: clone.url });
    try {
      await seedPersonalFixture(database, "/tmp/problems-home");
      const fetch = vi.fn<typeof globalThis.fetch>();
      const problems = new HomeProblems({
        database,
        dataDirectory: "/nonexistent",
        home: "mac",
        readsMachineStatus: false,
        version: "1.4.0",
        // A stand-in for the disk: what is on this machine's own disk is not the test's (U7).
        readDisk: async () => "under-70",
        destination: { kind: "none" },
        fetch,
      });
      problems.start();
      expect(problems.scheduled()).toBe(false);
      await problems.sendOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect(await problems.view()).toEqual({
        problems: [],
        reporting: { destination: "none" },
        body: null,
      });
      await problems.close();
    } finally {
      await database.destroy();
      await clone.drop();
    }
  });

  it("sends a Cloud Computer's report with its account credentials", async () => {
    const clone = await cloneTestDatabase("host");
    const database = createDatabase({ connectionString: clone.url });
    const directory = mkdtempSync(join(tmpdir(), "home-problems-"));
    try {
      await seedPersonalFixture(database, "/tmp/problems-home");
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      const problems = new HomeProblems({
        database,
        dataDirectory: directory,
        home: "cloud-computer",
        readsMachineStatus: true,
        version: "1.4.0",
        // A stand-in for the disk: what is on this machine's own disk is not the test's (U7).
        readDisk: async () => "under-70",
        destination: problemReportDestination(managed),
        fetch: fetch as typeof globalThis.fetch,
      });
      expect(problems.reporting()).toEqual({ destination: "operator" });
      await problems.sendOnce();
      const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toBe(
        "https://account.example.test/v1/cloud-computers/cc_00000000-0000-4000-8000-000000000001/health",
      );
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("occ_1:ocs_secret").toString("base64")}`,
      );
      await problems.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await database.destroy();
      await clone.drop();
    }
  });
});
