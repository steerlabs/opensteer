import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prepareAXDriver } from "./ax-driver-artifact.js";
import { certificationCases, releaseAsset } from "./evidence.js";
import {
  caseReceipt,
  draftCertificationPassed,
  draftExpectation,
  intakeDraft,
  publicationLines,
} from "./draft.js";
import { prepareFixtures } from "./eu-prepare.js";
import { journeyWorkDirectory } from "./work-directory.js";
import { runBounded } from "../command-runner.js";
const { values } = parseArgs({
  options: {
    draft: { type: "string" },
    "expect-version": { type: "string" },
    "expect-sha": { type: "string" },
  },
});
const expected = draftExpectation.parse({
  tag: values.draft,
  version: values["expect-version"],
  sourceSha: values["expect-sha"],
});
const stop = new AbortController(),
  interrupt = () => stop.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const work = journeyWorkDirectory(),
  out = path.join(work, "e2e", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(out, { recursive: true });
console.log(out);
try {
  const { inputs, draft, downloadedZipSha256 } = await intakeDraft(
    work,
    expected,
    (exe, args, options) => runBounded(exe, args, { ...options, signal: stop.signal }),
  );
  writeFileSync(path.join(out, "draft.json"), JSON.stringify(draft, null, 2));
  const { input, metadata } = await prepareFixtures(inputs, draft, stop.signal);
  const axDriver = prepareAXDriver(inputs),
    selected = [...certificationCases[draft.channel]];
  const workers = Number(
    z.enum(["1", "2"]).default("2").parse(process.env.OPENSTEER_UPDATE_JOURNEY_WORKERS),
  );
  const startedAt = new Date().toISOString();
  let finishedAt: string | undefined;
  const results: {
    name: string;
    passed: boolean;
    installedSha256?: string | undefined;
    error?: string | undefined;
    runDir?: string | undefined;
  }[] = [];
  const save = () =>
    writeFileSync(
      path.join(out, "journey.json"),
      JSON.stringify(
        {
          scope: "desktop-draft-update",
          evidenceKind: "certification",
          certifiedZipSha256: draftCertificationPassed(draft, results)
            ? downloadedZipSha256
            : undefined,
          draft,
          input,
          metadata,
          axDriver,
          workers,
          selected,
          startedAt,
          finishedAt,
          results,
          passed: draftCertificationPassed(draft, results),
        },
        null,
        2,
      ),
    );
  save();
  const one = async (name: string) => {
    const [channel, scenario] = name.split(":");
    let output = "";
    const child = spawn(
      "pnpm",
      [
        "test:vm",
        "--",
        "--inputs",
        inputs,
        "pnpm",
        "exec",
        "tsx",
        "../../scripts/public-download/eu-guest.ts",
        `eu-${scenario}`,
        channel!,
        JSON.stringify(metadata),
      ],
      { signal: stop.signal, stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data: Buffer) => {
        output += data.toString();
        process.stdout.write(data);
      });
    let failure: Error | undefined;
    child.once("error", (e) => (failure = e));
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    writeFileSync(path.join(out, name.replace(":", "-") + ".log"), output);
    const runDir = output
      .split("\n")
      .find((line) => path.isAbsolute(line) && existsSync(path.join(line, "job.json")));
    const result: {
      name: string;
      passed: boolean;
      installedSha256?: string;
      runDir?: string | undefined;
      error?: string | undefined;
    } = { name, passed: false, runDir, error: failure?.message };
    try {
      assert(runDir, "Missing VM receipt");
      cpSync(runDir, path.join(out, name.replace(":", "-")), { recursive: true });
      const receipt = caseReceipt
        .extend({ channel: z.literal(draft.channel), scenario: z.literal(`eu-${scenario}`) })
        .parse({
          ...JSON.parse(
            readFileSync(path.join(runDir, "guest/public-download/journey.json"), "utf8"),
          ),
          name,
        });
      result.installedSha256 = receipt.installedSha256;
      result.passed = code === 0 && receipt.passed;
      assert.equal(
        receipt.installedSha256,
        draft.assets[releaseAsset(draft.channel, draft.version).zip],
        "Guest installed bytes differ from the draft ZIP",
      );
    } catch (e) {
      result.passed = false;
      result.error = String(e);
    }
    results.push(result);
    save();
  };
  try {
    const pending: string[] = [...selected];
    const workersResult = await Promise.allSettled(
      Array.from({ length: workers }, async () => {
        while (pending.length && !stop.signal.aborted) {
          const name = pending.shift();
          if (name) await one(name);
        }
      }),
    );
    for (const worker of workersResult) if (worker.status === "rejected") throw worker.reason;
  } finally {
    finishedAt = new Date().toISOString();
    save();
  }
  if (!draftCertificationPassed(draft, results)) process.exitCode = 1;
  console.log(out);
  for (const line of publicationLines(
    draft,
    downloadedZipSha256,
    draftCertificationPassed(draft, results),
  ))
    console.log(line);
} catch (error) {
  writeFileSync(
    path.join(out, "failure.json"),
    JSON.stringify({ expected, error: String(error) }, null, 2),
  );
  process.exitCode = 1;
  throw error;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
