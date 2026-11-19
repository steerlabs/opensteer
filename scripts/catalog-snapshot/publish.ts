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
 * read the live site. A publish holds a lock per site on this machine and reads the live
 * `manifest.json` again just before deploying, refusing if it changed; publish from one machine
 * only (see the README).
 *
 * Deploying needs an identity with Firebase Hosting permissions on the project: `firebase login`,
 * or Application Default Credentials (`gcloud auth application-default login`).
 */
import { parseArgs } from "node:util";
import { publishRelease } from "./release.ts";

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
await publishRelease({
  dir: values.dir,
  site: values.site,
  previous: values.previous,
  first: values.first,
  project: values.project,
  siteUrl: values["site-url"],
  ignoreInterval: values["ignore-interval"],
  dryRun: values["dry-run"],
});
