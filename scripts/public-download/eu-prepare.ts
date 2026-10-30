import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { journeyWorkDirectory } from "./work-directory.js";
import { journeyInput, releaseAsset } from "./evidence.js";
import { journeySigning } from "./signing.js";
import path from "node:path";
import { z } from "zod";
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const revisions = [
  sha.parse(process.argv[2]),
  sha.parse(process.argv[3]),
  sha.parse(process.argv[4]),
];
const builds = path.join(journeyWorkDirectory(), "builds");
const out = path.join(builds, `github-inputs-${Date.now()}`);
mkdirSync(out, { mode: 0o700 });
const input = [];
for (const revision of revisions) {
  let version = "";
  for (const channel of ["stable", "beta"] as const) {
    const directory = path.join(builds, revision, channel);
    const build = z
      .object({ version: z.string(), zip: z.string() })
      .parse(JSON.parse(readFileSync(path.join(directory, "build.json"), "utf8")));
    version = build.version;
    const extracted = mkdtempSync(path.join(directory, "archive-verification-"));
    try {
      execFileSync("ditto", ["-x", "-k", build.zip, extracted]);
      const app = path.join(
        extracted,
        channel === "stable" ? "Opensteer.app" : "Opensteer Beta.app",
      );
      const missing = execFileSync("find", [app, "!", "-perm", "-u+w"], { encoding: "utf8" });
      if (missing) throw Error(`Archive contains non-owner-writable entries: ${missing}`);
      writeFileSync(
        path.join(directory, "archive-check.json"),
        JSON.stringify(
          {
            sha256: createHash("sha256").update(readFileSync(build.zip)).digest("hex"),
            ownerWriteCheck: { stdout: missing, passed: true },
          },
          null,
          2,
        ),
      );
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }
    // The real prepare owns signature, identity, staple and Gatekeeper verification.
    const prepared = spawnSync(
      "pnpm",
      [
        "desktop:public-release",
        "prepare",
        "--channel",
        channel,
        "--app-zip",
        build.zip,
        "--version",
        version,
        "--source-sha",
        revision,
        "--out",
        path.join(out, releaseAsset(channel, version).tag),
        "--download-base",
        "https://github.opensteer.test/steerlabs/opensteer/releases/download",
        "--allow-private-feed",
      ],
      { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
    );
    writeFileSync(
      path.join(directory, "prepare-verification.json"),
      JSON.stringify(
        { status: prepared.status, stdout: prepared.stdout, stderr: prepared.stderr },
        null,
        2,
      ),
    );
    if (prepared.status !== 0) throw Error(prepared.stderr || "Release prepare failed");
  }
  input.push({ version, revision });
}
writeFileSync(
  path.join(out, "input.json"),
  JSON.stringify(
    {
      ...journeyInput.parse({ n: input[0], next: input[1], older: input[2] }),
      metadata: journeySigning().metadata,
    },
    null,
    2,
  ),
);
console.log(out);
