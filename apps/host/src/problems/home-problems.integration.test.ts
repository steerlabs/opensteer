import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@opensteer/database";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { HomeHealthReportSchema } from "@opensteer/protocol/problems";
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
  it("sends to one configured address only: the operator's for a Cloud Computer, else the person's choice", () => {
    expect(problemReportDestination(managed)).toMatchObject({
      kind: "operator",
      url: new URL(
        "https://account.example.test/v1/cloud-computers/cc_00000000-0000-4000-8000-000000000001/health",
      ),
    });
    expect(
      problemReportDestination({ personalAccountIssuer: new URL("https://account.example.test") }),
    ).toEqual({
      kind: "opensteer",
      url: new URL("https://account.example.test/v1/problem-reports"),
    });
    expect(
      problemReportDestination({
        personalAccountIssuer: new URL("https://account.example.test"),
        problemReportsOrigin: new URL("https://collector.self.example"),
      }),
    ).toEqual({ kind: "own", url: new URL("https://collector.self.example/v1/problem-reports") });
    expect(problemReportDestination({})).toEqual({ kind: "none" });
  });

  it("builds the report from fixed values, sends nothing until the person turns it on, then exactly what they saw", async () => {
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
            at: new Date(now).toISOString(),
          },
          lastUpdate: {
            result: "rolled-back",
            at: new Date(now).toISOString(),
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
        destination: {
          kind: "opensteer",
          url: new URL("https://account.example.test/v1/problem-reports"),
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
        destination: { kind: "none" },
      });
      expect(await mac.report()).not.toHaveProperty("services");
      expect((await mac.report()).problems).toEqual([]);

      // Off by default: nothing leaves.
      expect((await problems.reporting()).mode).toBe("off");
      await problems.sendOnce();
      expect(fetch).not.toHaveBeenCalled();

      expect((await problems.setSending(true)).mode).toBe("on");
      await problems.sendOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe("https://account.example.test/v1/problem-reports");
      // No credentials for a person's own Home, and exactly the report they can see.
      expect(new Headers(sent[0]!.init.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(sent[0]!.init.body))).toEqual(await problems.report());
      expect(await problems.reporting()).toMatchObject({ mode: "on", lastResult: "sent" });

      // A machine status the maintenance stopped writing says nothing about services now.
      utimesSync(
        join(directory, machineStatusFile),
        new Date(now - 3_600_000),
        new Date(now - 3_600_000),
      );
      expect(await problems.report()).not.toHaveProperty("services");
      // Anything but the fixed values makes the file say nothing at all.
      writeFileSync(join(directory, machineStatusFile), JSON.stringify({ note: "/Users/alex" }));
      expect(await problems.report()).toEqual({
        schema: 1,
        home: "server",
        version: "0.0.0",
        ...((await problems.report()).disk ? { disk: (await problems.report()).disk } : {}),
        problems: [],
      });
      await problems.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await database.destroy();
      await clone.drop();
    }
  });

  it("sends a Cloud Computer's report with its account credentials, whatever the setting says", async () => {
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
        destination: problemReportDestination(managed),
        fetch: fetch as typeof globalThis.fetch,
      });
      expect(await problems.reporting()).toMatchObject({
        mode: "operator",
        destination: "opensteer",
      });
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
