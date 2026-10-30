import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { journeyWorkDirectory } from "./work-directory.js";
import path from "node:path";
import { z } from "zod";
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const revisions = [sha.parse(process.argv[2]), sha.parse(process.argv[3])];
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
    execFileSync("ditto", ["-x", "-k", build.zip, extracted]);
    const app = path.join(extracted, channel === "stable" ? "Opensteer.app" : "Opensteer Beta.app");
    const missing = execFileSync("find", [app, "!", "-perm", "-u+w"], { encoding: "utf8" });
    if (missing) throw new Error(`Archive contains non-owner-writable entries: ${missing}`);
    const codesign = execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
      encoding: "utf8",
    });
    const staple = execFileSync("xcrun", ["stapler", "validate", app], { encoding: "utf8" });
    writeFileSync(
      path.join(directory, "archive-check.json"),
      JSON.stringify(
        {
          sha256: createHash("sha256").update(readFileSync(build.zip)).digest("hex"),
          ownerWriteCheck: {
            command: "find Opensteer.app ! -perm -u+w",
            stdout: missing,
            passed: true,
          },
          codesign,
          staple,
          extracted,
        },
        null,
        2,
      ),
    );
    execFileSync(
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
        path.join(out, channel === "stable" ? `desktop-v${version}` : `v${version}-insider`),
        "--download-base",
        "https://github.opensteer.test/steerlabs/opensteer/releases/download",
        "--allow-private-feed",
      ],
      { cwd: path.join(directory, "source"), stdio: "inherit" },
    );
  }
  input.push({ version, revision });
}
writeFileSync(
  path.join(out, "input.json"),
  JSON.stringify({ n: input[0], next: input[1] }, null, 2),
);
console.log(out);
