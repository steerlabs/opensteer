import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { linkProfiles, type ProfileName } from "./mobile-network/proxy.test-support.js";
import {
  runMobileNetworkSample,
  scenarios,
  type ScenarioResult,
} from "./mobile-network/runner.test-support.js";
import type { SeedName } from "./mobile-network/fixture.test-support.js";

const options = process.env.OPENSTEER_MOBILE_BENCH_OPTIONS
  ? z
      .object({
        profile: z.enum(["all", "lan", "4g", "weak-cell", "edge"]),
        seed: z.enum(["all", "light", "heavy"]),
        scenario: z.enum(["all", ...scenarios]),
        runs: z.coerce.number().int().positive(),
        out: z.string(),
        "stall-every": z.coerce.number().int().positive().optional(),
        "stall-ms": z.coerce.number().int().positive(),
      })
      .parse(JSON.parse(process.env.OPENSTEER_MOBILE_BENCH_OPTIONS))
  : null;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function summary(samples: readonly ScenarioResult[]) {
  const groups = new Map<string, ScenarioResult[]>();
  for (const sample of samples) {
    const key = `${sample.seed}/${sample.profile}/${sample.scenario}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({
    key,
    runs: group.length,
    milliseconds: median(group.map((sample) => sample.elapsedMs)),
    milestonesMs: Object.fromEntries(
      [...new Set(group.flatMap((sample) => Object.keys(sample.milestonesMs)))].map((name) => [
        name,
        median(
          group.flatMap((sample) =>
            sample.milestonesMs[name] === undefined ? [] : [sample.milestonesMs[name]!],
          ),
        ),
      ]),
    ),
    bytesDown: median(group.map((sample) => sample.bytesDown)),
    bytesUp: median(group.map((sample) => sample.bytesUp)),
    tcpConnections: median(group.map((sample) => sample.tcpConnections)),
    modeledTls13AdditionalMs: median(group.map((sample) => sample.modeledTls13AdditionalMs)),
    rpcCount: median(
      group.map((sample) => Object.values(sample.rpc).reduce((total, rpc) => total + rpc.count, 0)),
    ),
    requestWaves: median(group.map((sample) => sample.requestChain.length)),
    requestFailures: median(
      group.map(
        (sample) =>
          sample.requests.filter((request) => request.status === null || request.status >= 400)
            .length,
      ),
    ),
  }));
}

const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("phone network performance using the real shared client", () => {
  it(
    options
      ? "records the requested measurement matrix"
      : "attaches paged models and resumes the retained realtime cursor",
    async ({ signal }) => {
      const samples: ScenarioResult[] = [];
      const manifests: Awaited<ReturnType<typeof runMobileNetworkSample>>["manifest"][] = [];
      const report = async (status: string) => {
        if (!options) return;
        await mkdir(dirname(options.out), { recursive: true });
        await writeFile(
          options.out,
          JSON.stringify(
            {
              version: 1,
              status,
              sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
              node: process.version,
              measuredAt: new Date().toISOString(),
              options,
              profiles: linkProfiles,
              methodology: {
                client:
                  "Production HttpHostClient; stored fixture session; mobile capabilities callback and lifecycle; no local runtime. React rendering and credential storage excluded.",
                transport:
                  "Plain HTTP/1.1, Node fetch/ws, shared per-direction serialization and propagation. TCP handshake and extra TLS 1.3 RTT are modeled sums, excluded from timings; concurrent handshakes need not add on the critical path. No radio scheduling, TCP congestion/slow start, retransmission or TLS record overhead.",
                stall: "Optional deterministic extra delay per N 16KiB chunks; not packet loss.",
                boundaries:
                  "Cold starts at client creation (constructor has no I/O); warm runs follow attach in the same client. open-task changes active conversation; later recoveries keep the resulting selection. Completed bytes include follow-up refreshes until traffic quiesces. Foreground excludes the preceding real 30s wait.",
                criticalPath:
                  "requestChain groups overlapping HTTP requests into waves, an observed sequential timeline rather than inferred causal dependencies; websocket gives frame ordering and sizes.",
                determinism:
                  "Fixed data volume and content, fixed reconnect jitter 0.5. Real transport/DB clocks; medians are measurements, not timing assertions. Runs execute serially.",
              },
              manifests,
              summary: summary(samples),
              samples,
            },
            null,
            2,
          ) + "\n",
        );
      };
      try {
        for (const seed of (options?.seed === "all"
          ? ["light", "heavy"]
          : [options?.seed ?? "light"]) as SeedName[]) {
          for (const profile of (options?.profile === "all"
            ? Object.keys(linkProfiles)
            : [options?.profile ?? "lan"]) as ProfileName[]) {
            for (let run = 1; run <= (options?.runs ?? 1); run++) {
              const result = await runMobileNetworkSample({
                databaseUrl: process.env.OPENSTEER_TEST_DATABASE_URL!,
                seed,
                profile,
                run,
                signal,
                scenarios: options
                  ? options.scenario === "all"
                    ? scenarios
                    : [options.scenario]
                  : ["cold-attach", "reconnect"],
                link: {
                  ...linkProfiles[profile],
                  ...(options?.["stall-every"]
                    ? {
                        stall: {
                          everyChunks: options["stall-every"],
                          delayMs: options["stall-ms"],
                        },
                      }
                    : {}),
                },
              });
              manifests.push(result.manifest);
              samples.push(...result.results);
              for (const sample of result.results) {
                if (sample.scenario === "cold-attach") {
                  expect(sample.resume.snapshots).toBe(1);
                  expect(sample.milestonesMs.homeFirstPage).toBeDefined();
                  expect(sample.milestonesMs.tabsLoaded).toBeDefined();
                  expect(
                    sample.rpc["thread.messages.list"]?.count ??
                      sample.rpc["thread.events.list"]?.count,
                  ).toBeGreaterThan(0);
                }
                if (sample.scenario === "reconnect") {
                  expect(BigInt(sample.resume.cursor ?? "0")).toBeGreaterThan(0n);
                  expect(sample.resume.snapshots).toBe(0);
                  expect(sample.resume.events).toBeGreaterThan(0);
                  expect(sample.websocket.some((frame) => frame.type === "host.synchronized")).toBe(
                    true,
                  );
                }
              }
              await report("running");
              console.info(`Measured ${seed}/${profile} run ${run}/${options?.runs ?? 1}`);
            }
          }
        }
        await report("complete");
      } catch (error) {
        await report("failed");
        throw error;
      }
      if (options) {
        console.table(
          summary(samples).map((row) => ({
            case: row.key,
            ms: Math.round(row.milliseconds),
            downKiB: +(row.bytesDown / 1024).toFixed(1),
            upKiB: +(row.bytesUp / 1024).toFixed(1),
            TCP: row.tcpConnections,
            RPC: row.rpcCount,
            waves: row.requestWaves,
            failed: row.requestFailures,
          })),
        );
        console.info(`JSON report: ${options.out}`);
      }
    },
    options ? 3_600_000 : 60_000,
  );
});
