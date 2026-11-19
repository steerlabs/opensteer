/**
 * Publish a catalog snapshot to Firebase Hosting, where one release switches the whole site to the
 * new files at once and clears the CDN's cached copies.
 *
 *   pnpm catalog:publish --dir <snapshot> --site <site id> (--previous <snapshot> | --first)
 *                        [--project <id>] [--site-url <URL>] [--ignore-interval] [--dry-run]
 *
 * The snapshot, and the live release's snapshot, are read as regular files only (a symlink or any
 * other entry is refused) and checked against their manifests and the layout's relationships. The
 * live site's `manifest.json` is read (no redirects; `--site-url` defaults to the site's own
 * address): `--previous` must be exactly the snapshot it serves, published longer ago than the
 * release interval (see core.ts) unless `--ignore-interval`, and `--first` is refused once the
 * site serves a manifest. A private staging directory is then assembled from the checked bytes
 * alone: the snapshot, its manifest recording the publish time, the live release's
 * content-addressed documents and icons (so an index cached from it still resolves), and the
 * Hosting configuration with each path's cache lifetime. The deploy runs from there; nothing is
 * written into a snapshot. `--dry-run` stops before deploying, needs no credentials and does not
 * read the live site.
 *
 * Deploying needs an identity with Firebase Hosting permissions on the project: `firebase login`,
 * or Application Default Credentials (`gcloud auth application-default login`).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkLive, previousChoice, type Manifest } from "./core.ts";
import { separatePlaces, stageRelease } from "./disk.ts";

const firebaseTools = "firebase-tools@15.34.2";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    site: { type: "string" },
    previous: { type: "string" },
    first: { type: "boolean", default: false },
    project: { type: "string", default: "opensteer-staging" },
    "site-url": { type: "string" },
    "ignore-interval": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.dir || !values.site)
  throw new Error("--dir <snapshot> and --site <site id> are required");
const previous = previousChoice(values.previous, values.first);
const siteUrl = new URL(values["site-url"] ?? `https://${values.site}.web.app/`);
const published = new Date();
const repository = resolve(import.meta.dirname, "../..");
const staging = await mkdtemp(join(tmpdir(), "catalog-release-"));
try {
  const places = await separatePlaces(
    {
      dir: values.dir,
      ...(previous === undefined ? {} : { previous }),
      staging,
    } as Record<string, string>,
    repository,
  );
  const release = await stageRelease({
    snapshot: places.dir!,
    previous: places.previous ? [places.previous] : [],
    staging,
    site: values.site,
    published: published.toISOString(),
  });
  if (values["dry-run"])
    console.log(
      `Dry run: ${siteUrl.href} was not read, so --previous or --first is not checked against the live release.`,
    );
  else {
    // Loaded only for a real publish: it brings in the engine's catalog client.
    const { liveManifest } = await import("./served.ts");
    console.log(
      `${siteUrl.href}: ${checkLive({
        live: await liveManifest(new URL("manifest.json", siteUrl).href),
        previous: places.previous
          ? new Uint8Array(await readFile(join(places.previous, "manifest.json")))
          : undefined,
        now: published,
        ignoreInterval: values["ignore-interval"],
      })}`,
    );
  }
  const manifest = JSON.parse(
    await readFile(join(places.dir!, "manifest.json"), "utf8"),
  ) as Manifest;
  console.log(
    `${places.dir}: ${manifest.entries} entries, feed ${manifest.feed.sha256}; release of ${release.files} files, ${release.retained} kept from the previous release`,
  );
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
  console.log(JSON.stringify(release.configuration, null, 2));
  console.log(`(in the staging directory) ${command.join(" ")}`);
  if (values["dry-run"]) console.log("Dry run: nothing was uploaded.");
  else {
    const result = spawnSync(command[0]!, command.slice(1), { cwd: staging, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Deploy failed (${result.status ?? result.signal})`);
    console.log(
      `Published. Check it with: pnpm catalog:verify --feed https://${values.site}.web.app/index.json --manifest ${join(places.dir!, "manifest.json")}`,
    );
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
