import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertBaselineShrinks, fingerprint } from "./index.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "tooling/oxlint-plugin-opensteer/baseline.json";
const current = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));

if (process.argv.includes("--prune")) {
  // Run without allowances. This command only removes debt; it cannot accept new violations.
  writeFileSync(new URL("./baseline.json", import.meta.url), "{}\n");
  try {
    const result = spawnSync("pnpm", ["exec", "oxlint", ".", "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
    const measured = {};
    for (const diagnostic of JSON.parse(result.stdout).diagnostics) {
      const match = /^opensteer\((.+)\)$/.exec(diagnostic.code);
      if (!match) continue;
      const span = diagnostic.labels[0].span;
      const text = readFileSync(new URL(diagnostic.filename, new URL("../../", import.meta.url)))
        .subarray(span.offset, span.offset + span.length)
        .toString();
      const key = fingerprint(match[1], text);
      const entries = (measured[diagnostic.filename] ??= {});
      entries[key] = (entries[key] ?? 0) + 1;
      if (entries[key] > (current[diagnostic.filename]?.[key] ?? 0))
        throw new Error(`New violation: ${diagnostic.filename} ${match[1]}`);
    }
    writeFileSync(
      new URL("./baseline.json", import.meta.url),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(measured)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, entries]) => [
              path,
              Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
            ]),
        ),
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    writeFileSync(
      new URL("./baseline.json", import.meta.url),
      JSON.stringify(current, null, 2) + "\n",
    );
    throw error;
  }
} else {
  const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const previous = spawnSync("git", ["show", `${base}:${file}`], { cwd: root, encoding: "utf8" });
  // The introducing PR has no baseline at its merge base.
  if (previous.status !== 0) {
    if (
      spawnSync("git", ["cat-file", "-e", `${base}:tooling/oxlint-plugin-opensteer/index.mjs`], {
        cwd: root,
      }).status === 0
    )
      throw new Error("Baseline missing at merge base");
  } else {
    const ceiling = JSON.parse(previous.stdout);
    assertBaselineShrinks(current, ceiling);
  }
}
