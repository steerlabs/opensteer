import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { journeyWorkDirectory } from "./work-directory.js";
import path from "node:path";
import { z } from "zod";
const inputs = z.string().refine(path.isAbsolute).parse(process.argv[2]);
const release = z.object({ version: z.string(), revision: z.string().regex(/^[a-f0-9]{40}$/u) });
const input = z
  .object({ n: release, next: release })
  .parse(JSON.parse(readFileSync(path.join(inputs, "input.json"), "utf8")));
const names = [
  "stable:menu",
  "beta:menu",
  "stable:tray",
  "stable:quit",
  "beta:quit",
  "stable:negative",
  "beta:negative",
] as const;
const selected = process.argv[3]
  ? z.array(z.enum(names)).parse(process.argv[3].split(","))
  : [...names];
const work = journeyWorkDirectory();
const out = path.join(work, "e2e", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(out, { recursive: true });
console.log(out);
const buildRoot = path.join(work, "builds");
const builds: {
  channel: string;
  version: string;
  revision: string;
  sha256: string;
  directory: string;
}[] = [];
for (const item of [input.n, input.next])
  for (const channel of ["stable", "beta"]) {
    const directory = path.join(buildRoot, item.revision, channel),
      build = z
        .object({ zip: z.string() })
        .parse(JSON.parse(readFileSync(path.join(directory, "build.json"), "utf8")));
    const sha256 = createHash("sha256").update(readFileSync(build.zip)).digest("hex");
    builds.push({ channel, ...item, sha256, directory });
    cpSync(
      path.join(directory, "build.json"),
      path.join(out, `${channel}-${item.version}-build.json`),
    );
    for (const file of ["notary.json", "archive-check.json"])
      if (existsSync(path.join(directory, file)))
        cpSync(path.join(directory, file), path.join(out, `${channel}-${item.version}-${file}`));
  }
const stop = new AbortController();
const interrupt = () => stop.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const results: { name: string; passed: boolean; error?: string; runDir?: string }[] = [];
const save = () =>
  writeFileSync(
    path.join(out, "journey.json"),
    JSON.stringify(
      {
        scope: "electron-updater-github-two-channels",
        input,
        builds,
        selected,
        results,
        passed: results.length === selected.length && results.every((x) => x.passed),
      },
      null,
      2,
    ),
  );
save();
const one = async (name: (typeof names)[number]) => {
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
  const result = { name, passed: false, runDir, error: failure?.message };
  try {
    assert(runDir, "Missing VM run directory");
    const receipt = JSON.parse(
      readFileSync(path.join(runDir, "guest/public-download/journey.json"), "utf8"),
    );
    for (const item of [input.n, input.next])
      cpSync(
        path.join(buildRoot, item.revision, channel!, "build.json"),
        path.join(runDir, `build-${item.version}.json`),
      );
    cpSync(runDir, path.join(out, name.replace(":", "-")), { recursive: true });
    result.passed = code === 0 && receipt.passed === true;
    result.error ??= receipt.error ?? (result.passed ? undefined : `exit ${code}`);
  } catch (e) {
    result.error = String(e);
  }
  results.push(result);
  save();
};
try {
  const pending = [...selected];
  const workers = await Promise.allSettled(
    Array.from({ length: 2 }, async () => {
      while (pending.length && !stop.signal.aborted) {
        const name = pending.shift();
        if (name) await one(name);
      }
    }),
  );
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
} finally {
  save();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
if (results.length !== selected.length || results.some((x) => !x.passed)) process.exitCode = 1;
console.log(out);
