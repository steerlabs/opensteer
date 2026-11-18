/**
 * Publish a catalog snapshot to Firebase Hosting, where one release switches the whole site to the
 * new files at once and clears the CDN's cached copies.
 *
 *   pnpm catalog:publish --dir <snapshot> --site <hosting site id> [--project <id>] [--dry-run]
 *
 * It first checks the directory against its manifest, so a partial or edited snapshot is never
 * uploaded. The deploy runs in the snapshot directory with a `firebase.json` that exists only for
 * the deploy and is not uploaded. `--dry-run` stops after the check and prints the configuration
 * and the command.
 * Deploying needs Firebase credentials: `firebase login`, or Application Default Credentials from
 * `gcloud auth application-default login`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { manifestProblems, type Manifest } from "./core.ts";

const firebaseTools = "firebase-tools@15.34.2";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    site: { type: "string" },
    project: { type: "string", default: "opensteer-staging" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.dir || !values.site)
  throw new Error("--dir <snapshot> and --site <site id> are required");
const directory = resolve(values.dir);

const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
const files: Record<string, { sha256: string; bytes: number }> = {};
for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = relative(directory, join(entry.parentPath, entry.name)).split("\\").join("/");
  const bytes = await readFile(join(directory, path));
  files[path] = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}
const problems = manifestProblems(manifest, files);
if (problems.length > 0)
  throw new Error(`${directory} does not match its manifest:\n${problems.join("\n")}`);
console.log(
  `${directory}: ${manifest.entries} entries, ${Object.keys(files).length} files, ${manifest.totalBytes} bytes, feed ${manifest.feed.sha256}`,
);

// Documents change with each snapshot under the same names, so caches revalidate them soon; a
// release clears the CDN, which leaves only the Host's and browsers' own short-lived copies.
const cache = (source: string, value: string) => ({
  source,
  headers: [{ key: "Cache-Control", value }],
});
const configuration = {
  hosting: {
    site: values.site,
    public: ".",
    // The configuration itself and the CLI's own cache folder are not part of the site.
    ignore: ["firebase.json", "**/.*"],
    headers: [
      cache("/index.json", "public, max-age=300"),
      cache("/manifest.json", "public, max-age=300"),
      cache("/apps/**", "public, max-age=300"),
      cache("/icons/**", "public, max-age=86400"),
    ],
  },
};
const command = [
  "pnpm",
  "dlx",
  firebaseTools,
  "deploy",
  "--only",
  "hosting",
  "--project",
  values.project,
  "--non-interactive",
  "--message",
  `catalog ${manifest.feed.sha256.slice(0, 12)}: ${manifest.entries} entries`,
];
console.log(JSON.stringify(configuration, null, 2));
console.log(`(in ${directory}) ${command.join(" ")}`);
if (values["dry-run"]) {
  console.log("Dry run: nothing was uploaded.");
} else {
  try {
    await writeFile(
      join(directory, "firebase.json"),
      JSON.stringify(configuration, null, 2) + "\n",
    );
    const result = spawnSync(command[0]!, command.slice(1), { cwd: directory, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Deploy failed (${result.status ?? result.signal})`);
  } finally {
    await rm(join(directory, "firebase.json"), { force: true });
    await rm(join(directory, ".firebase"), { recursive: true, force: true });
  }
  console.log(
    `Published. Check it with: pnpm catalog:verify --feed https://${values.site}.web.app/index.json --manifest ${join(directory, "manifest.json")}`,
  );
}
