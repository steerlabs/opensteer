# Plugin catalog snapshot

Opensteer will serve its own copy of the plugin catalog at
`https://catalog.opensteer.com/index.json`. Until that address is live, the Host's default feed stays
upstream's (`officialCatalogUrl` in `apps/host/src/plugins/engine-runtime.ts`); switching it is a
separate change made after the copy is published and verified there. These scripts take the copy,
check it, publish it, and check what is served.

Snapshots hold third-party plugin source and run to about 290 MB. Keep them outside this
repository: every tool resolves its paths through symlinks and refuses one inside it.

## Take a snapshot

```sh
pnpm catalog:snapshot --out ~/catalog/2026-11-18 [--rules <rules.json>] [--feed <index.json URL>]
```

- Downloads go to `<out>.download` (`--cache` to choose), exactly as served, eight at a time
  (`--concurrency`), with the User-Agent `catalog-snapshot` and no redirects followed. An
  interrupted run resumes from the cache. The cache belongs to one version of the feed; when the
  feed changes, start a new one.
- `--offline` rebuilds from the cache alone, for example to apply new rules.
- `--out`, the cache and the staging directory are resolved through symlinks and must lie outside
  the repository and apart from each other. A cache that holds a symlink is refused. Every file the
  tool writes outside the staging directory (cache files, the rewrite report) goes first to a new,
  uniquely named file created exclusively, never through an existing entry, in a directory that is
  its own real path, and is then renamed into place. No input (the cache, the rule file, a report)
  may be, or lie inside, a name the tool reserves beside `<out>`: `.<out>.staging-*`,
  `.<out>.previous`, `.<out>.lock` or `<out>.rewrites.next.json`, since recovery removes or moves
  those.
- `<out>`'s parent is created if missing; a mount root is refused, since it cannot be renamed.
- The build is written to a new, uniquely named directory beside `<out>`, read back and checked as
  `catalog:publish` checks it, and only then swapped in with two renames: an earlier snapshot to
  `.<out>.previous`, then the build to `<out>`. The earlier one is removed once the new one is in
  place; a build with any problem writes nothing to `<out>`. A run stopped between the renames is
  put right by the next run: with `<out>` missing and `.<out>.previous` present, the earlier
  snapshot is put back, and the run says so. Staging directories left by a stopped run are
  removed. Two builds from the same cache are byte-identical.
- One run at a time writes a given `<out>`: a run holds the lock file `.<out>.lock` (created
  exclusively, holding its PID and start time) from before that recovery until after its swap, so
  recovery never takes a running build or its set-aside snapshot for leftovers. A second run
  refuses, naming the holder. A lock whose process is no longer running is taken over, and the run
  says so.
- `--feed` defaults to the engine's `officialCatalogUrl`, where the copy is taken from.

### Layout

Valid at any base URL, because the client resolves every path against the index's URL. Documents
and icons are addressed by the SHA-256 of their bytes, so a path never changes meaning.

| Path                      | Content                                                     | `Cache-Control`                        |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| `index.json`              | The feed. Each entry's `source` is its document's path and  | `public, max-age=300, must-revalidate` |
|                           | `sha256` that document's hash.                              |                                        |
| `apps/<id>/<sha256>.json` | One entry's source document, `{ package, files }`.          | `public, max-age=31536000, immutable`  |
| `apps/<id>.json`          | The same bytes, at the path today's catalog client reads.   | `public, max-age=300, must-revalidate` |
| `icons/<sha256>.<ext>`    | The icons the feed refers to; entries name these paths.     | `public, max-age=31536000, immutable`  |
| `manifest.json`           | Hash and size of every other file, counts, the rules' hash. | `public, max-age=300, must-revalidate` |

`catalog:publish` writes these lifetimes into the Hosting configuration it deploys with, and
`catalog:verify` expects them; both read them from `cacheHeaders` in `core.ts`. The manifest a
release serves also records `published`, the time its publish started; a snapshot's own manifest
never has it.

Every document is validated with the engine's `CatalogFeed` and `CatalogFeedSource` contracts, the
check the client makes when it prepares an install (`package.json` names the document's package),
the index entry's `package` matching the document's, and the engine's `PackageName` contract. An
id the source feed lists twice with identical entries is listed once (`duplicateIds` in the
manifest); an id listed twice with different entries fails the build. An icon outside the feed
fails it too, and so does one that is not SVG, PNG or WebP, or whose bytes are not that type (the
PNG or WebP signature, or an `<svg>` root after any XML declaration, comments and doctype). JSON is
written with sorted keys and two-space indentation.

### Rewriting

`--rules <rules.json>` takes a JSON rule file: data, never a module (its format is described at the
top of `rewrite.ts`). Each rule names where it applies, and everything else is left as it is. The
`package` and `manifest-key` rules, the names the engine itself reads, live in their own `engine`
section and nowhere else, so that section can later come from the engine's own rule file; they
apply first, to every document.

| `scope`        | Where `from` becomes `to`                                                           |
| -------------- | ----------------------------------------------------------------------------------- |
| `package`      | The index entry's `package`, the document's `package` and `package.json`'s `name`.  |
| `manifest-key` | A top-level key of `package.json`, renamed in place.                                |
| `markdown`     | Prose in `.md` files: outside fenced code blocks and inline code spans.             |
| `comments`     | Comments in JavaScript and TypeScript (as the TypeScript compiler parses the file), |
|                | and full-line `#` comments in Python files.                                         |
| `text`         | The whole text of the `files` named, in the `documents` named, for one-off edits.   |

Any rule may be limited to `documents` (entry ids). `preserve` lists literals that are never
rewritten wherever they appear, each with its reason (a third-party literal, an identifier a
provider receives, an ordinary English word); data URIs and long base64 runs are never rewritten
either. `names` lists words to account for: after rewriting, every remaining case-insensitive
occurrence must lie inside a preserved literal or base64 data, or the build fails. `variables`
sets values a rule's `to` names as `{{name}}`, so one value (such as a contact address) is set in
one place. A `comments` or `markdown` rule whose `to` does not have exactly the line breaks of its
`from` is refused when the file is read: a line break added to a comment can change the code after
it (`return`, a comment, then `42` returns nothing once the comment spans two lines). SQL under any `migrations/` path is never rewritten by any rule: the engine records
each migration's hash.

After rewriting, the build also fails if a `comments` or `markdown` rule changed anything outside
its scope (for JavaScript and TypeScript, the file's token stream apart from comments must be
identical, including whether a line break precedes each token, on which automatic semicolon
insertion depends) or changed how many line breaks a comment holds; if the file list, a non-text file, a data URI or base64 run, a migration, or a relative
import changed; if an import that named a file in its document no longer does; if a
JSON file that parsed no longer does; or if any package name breaks the contract.

The detailed report (counts per rule, and every remaining occurrence with its location and
reason) goes to `<out>.rewrites.json`, beside the snapshot and never in it. It names the SHA-256
of the manifest it describes and is committed with its snapshot: written to
`<out>.rewrites.next.json` before the swap and renamed into place after it. A run stopped between
the two is put right by the next one, which moves a waiting report into place when it describes the
snapshot at `<out>` and removes it otherwise; a report not describing that snapshot is removed too,
and the run says so. A report path that is a symlink is refused. A build that fails writes its
report to `<out>.rewrites.failed.json` instead and leaves `<out>` and its report as they were.
The published manifest records only the rule file's SHA-256, never its strings. The proposed rule
set is kept outside this repository, with the rest of the catalog working files.

## Check a served feed

```sh
pnpm catalog:verify --feed https://catalog.opensteer.com/index.json \
  --manifest ~/catalog/2026-11-25/manifest.json [--previous ~/catalog/2026-11-18/manifest.json] \
  [--entry gmail --entry resend]
```

No request it makes follows a redirect; a redirect is a failure. Every path the manifest lists
must be one the layout allows before any is requested. Every index response during the run, its
own and those the catalog client makes, must have the manifest's exact size and hash, and the
served `manifest.json` must be the snapshot's manifest as published (the same bytes plus
`published`). Every file the manifest lists, every document at both paths and every icon, is
fetched (eight at a time, `--concurrency`) and must match its hash and size, and the served set
must pass the checks `catalog:publish` applies. Every response must carry the `Cache-Control` its
kind of path is deployed with. With `--previous`, the previous snapshot's documents and icons must
still be served with their hashes. Responses are hashed as they arrive; only the index and one
document or icon per request in flight are held. Then the engine's catalog client lists the feed
(the count must be the manifest's) and prepares the named entries (by default the first OAuth and
the first key-based one), each of which must be the document the index names. Any request or
listed icon that leaves the feed's host fails the check.

## Publish

Firebase Hosting serves the catalog. See [Hosting](#hosting) for why and for the one-time setup.

```sh
pnpm catalog:publish --dir ~/catalog/2026-11-25 --previous ~/catalog/2026-11-18 \
  --site opensteer-catalog --dry-run
pnpm catalog:publish --dir ~/catalog/2026-11-25 --previous ~/catalog/2026-11-18 \
  --site opensteer-catalog
```

`--previous` is the snapshot the site serves now; `--first` replaces it for the first release. The
publisher reads the live `manifest.json` (from `https://<site>.web.app/`, or `--site-url`; no
redirect is followed) and refuses to deploy unless the snapshot given as `--previous` is exactly
the live one: the live manifest must be that snapshot's manifest, byte for byte, plus its
`published` time. A blank `--previous` is refused, and so is `--first` once the site serves a
manifest. The snapshot and the previous one are read as regular files only (a symlink or any other entry is
refused) and must each pass every check: each file listed in its manifest with its hash and size
and nothing else present; every path one the layout allows; each content-addressed file named by
its own hash; every index entry's document present, hashed as the entry says, valid, and the same
bytes at its legacy path; every icon an entry names present.

The release is then assembled in a private temporary directory from those checked bytes alone: the
snapshot, plus the previous snapshot's content-addressed documents and icons, with the Hosting
configuration (site, the cache lifetimes above, no ignore patterns) written beside them. The
deploy runs there; nothing is written into a snapshot, and the directory is removed afterwards.

Retention: a release keeps its own content-addressed files and the live release's, so an install
that read the live index finds its document after the switch. Older ones are pruned by the deploy
itself, because a Hosting release is its complete file set. An index stays usable for its cache
lifetime (`max-age=300`, five minutes) plus the time an install that read it is still running, so
two publishes must be further apart than both: the publisher refuses a publish less than
65 minutes (`releaseIntervalSeconds`: the index lifetime plus an hour for an install in flight and
the upload itself) after the live release's `published` time, unless `--ignore-interval` is given.
`published` is taken when the publish starts, before the upload, which the hour also covers.

One operator publishes, from one machine, one publish at a time. Two publishes that overlapped
could both pass the live check against the same old release; the second to deploy would then
replace a release whose index installs may already have read, without keeping its documents. On one
machine the publisher prevents that: it holds a lock per site in the user's temporary directory
(`catalog-publish-<site>.lock`, as the snapshot tool's lock) for the whole publish, and it reads the
live `manifest.json` again immediately before the deploy and refuses if it changed since the check.
Across machines that second read only narrows the window to the deploy itself, which nothing here
can lock; hence the rule.

`--dry-run` stops before the deploy, needs no credentials and does not read the live site, so it
does not check `--previous` or `--first` against it; it says so. Deploying needs a dedicated identity
with Firebase Hosting permissions on the project (for example the Firebase Hosting Admin role),
signed in as Application Default Credentials or with `firebase login`. The deploy, with a pinned `firebase-tools`,
uploads a new version and switches the whole site to it in one release, clearing the CDN.

Rollback: the pinned CLI has no rollback command. In the Firebase console, open Hosting, the site,
then its release history, and choose Roll back on the release to return to. That release becomes
current again with its complete file set: its own documents and those of the release before it,
not those of the release rolled back from, so an install in flight from the rolled-back index can
fail. The live manifest is then the older release's, with its older `published` time, so the next
publish passes that release's snapshot as `--previous`. The publisher cannot tell when a rollback
happened: wait 65 minutes after rolling back before publishing again, as the interval would
require.

## Hosting

Measured snapshot (2026-11-18): 1,840 entries in the source feed (three ids listed twice), 1,837
source documents and 2,399 icons. In the source feed's layout that was 4,238 files including the
manifest and 149 MB. In this layout it is 6,075 files and 287 MB, because each document is served
at both paths; a release that keeps the previous snapshot's documents is about 7,900 files and
430 MB. The largest document is 9.4 MB and the index is 1.6 MB. A full listing downloads the
index. Installing an entry downloads one document; browsers load its icons.

|                    | Firebase Hosting (chosen)                                                                       | Cloud Storage + HTTPS load balancer                                                                                                       | Vercel                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| HTTPS on our name  | Managed certificate once the records the console gives are in place                             | Google-managed certificate on a reserved global IP                                                                                        | Automatic certificate after a CNAME                                                           |
| Limits vs snapshot | 2 GB per file; 10 GB storage free, then $0.026/GB. No file-count limit in its quota docs. Fits. | No relevant limits                                                                                                                        | CLI upload 100 MB on Hobby (too small), 1 GB on Pro; 15,000 files per deployment. Fits on Pro |
| Caching            | Global CDN; `Cache-Control` from the deploy's config; every deploy clears the CDN               | Objects default to `max-age=3600` unless set; Cloud CDN is optional and must be invalidated by hand                                       | Per-deployment CDN cache; headers from `vercel.json`                                          |
| Cost               | Transfer free to 10 GB a month, then $0.15/GB; storage free here                                | About $18 a month for the forwarding rule before any traffic, plus processing and egress                                                  | Included in a Pro seat's allowance                                                            |
| Atomic refresh     | Yes: one release switches every file; rollback from the console's release history               | No multi-object swap: needs a prefix per snapshot and a URL-map rewrite switch, which reaches edges over minutes, plus a CDN invalidation | Yes: immutable deployments, atomic promotion and rollback                                     |
| DNS at Porkbun     | The ownership TXT record and the records the custom-domain wizard shows                         | `A catalog <reserved IP>`                                                                                                                 | `CNAME catalog cname.vercel-dns.com`                                                          |
| Setup              | Enable Firebase on the project, create a site                                                   | Bucket, backend bucket, URL map, HTTPS proxy, certificate, IP, forwarding rule, HTTP redirect                                             | A project on the team; a second vendor for a Google Cloud asset                               |

Firebase Hosting is the simplest choice that publishes atomically and lives in the company's Google
Cloud project. The load balancer costs more and cannot switch a snapshot atomically. Vercel would
also work, but only on Pro, and it adds a second place to manage the catalog.

### One-time setup (the lead)

The project is `opensteer-staging`, as decided; `--project` chooses another (an `opensteer-prod`
project also exists). Firebase is not yet enabled on `opensteer-staging`; billing is.

1. Enable Firebase and Hosting on the project:
   `pnpm dlx firebase-tools@15.34.2 projects:addfirebase opensteer-staging`.
2. Create the site (the id is global, 30 characters at most):
   `pnpm dlx firebase-tools@15.34.2 hosting:sites:create opensteer-catalog --project opensteer-staging`.
3. Create a dedicated service account for publishing with the Firebase Hosting Admin role on the
   project, and sign in as it for deploys (Application Default Credentials). Do not deploy as a
   person's own account.
4. Publish the first snapshot (`--first`) and check it on the site's own address:
   `pnpm catalog:verify --feed https://opensteer-catalog.web.app/index.json --manifest <snapshot>/manifest.json`.
5. In the Firebase console, Hosting, site `opensteer-catalog`, add the custom domain
   `catalog.opensteer.com`. Copy the records the wizard shows into Porkbun (DNS for
   `opensteer.com`) exactly; do not hard-code an address from this page or elsewhere, since the
   wizard gives the current ones.
   - Keep the ownership TXT record in place after the domain connects, as the wizard says; it is
     how Hosting knows the name is still the project's.
   - Quick setup gives the records that point `catalog` at Hosting; the certificate is issued once
     they resolve, so the name serves errors for a while. That is acceptable here, since nothing
     uses `catalog.opensteer.com` yet.
   - Advanced setup is for a name already serving traffic: it verifies ownership and issues the
     certificate (through an `_acme-challenge` record) before any traffic moves, then gives the
     records to switch. Use it if the name is ever moved from another host.
   - Add no other A, AAAA or CNAME record for `catalog`. `opensteer.com` has no CAA records today,
     so none are needed.
6. When the console shows the certificate as active, run `catalog:verify` against
   `https://catalog.opensteer.com/index.json`. Then switch the Host's default feed in a separate
   change.

## What remains (the engine workstream, after its move)

These changes belong to the catalog client and the worker build in the engine; none is made here.

1. **The client honors and validates `source`.** Today `catalogSource().prepare` in
   `catalog/src/implementation/source.ts` ignores `source` and reads `apps/<id>.json`, so an index
   and a document from different releases can meet. Change: `CatalogFeed` in
   `catalog/src/contracts/catalog.ts` gains an optional `sha256` (64 lowercase hex characters) per
   app; `catalogSource().list` keeps each entry's `source` and `sha256` from the index it read,
   beside the listing, and `prepare` reads that `source` resolved against the feed URL. A `source`
   that resolves outside the feed's origin, or not below the index's directory, fails with
   `CatalogImportFailed` code `invalid_source` before any request. Without a kept index (an entry
   never listed) `prepare` reads the index once, as `list` does. Test in
   `catalog/src/implementation/source.test.ts`: serve an index whose entry names
   `apps/x/<hash>.json` while `apps/x.json` holds other bytes; `prepare` returns the named
   document. A `source` of `https://elsewhere.example/x.json` or `../x.json` is refused with
   `invalid_source` and no request leaves.
2. **The install checks the document's hash, failing closed for Opensteer's own feed.** In
   `prepare`, read the document as bytes and compare their SHA-256 with the kept `sha256`. A
   mismatch fails with `CatalogUnavailable` ("try again shortly; nothing was added"). An entry
   without `sha256` installs as before, except from a feed the Host marks as requiring hashes:
   `createCatalog` takes `requireHashes: true`, which the Host passes for Opensteer's own feed, and
   there an entry without one is refused with `invalid_source`. Test: an index with one matching
   entry, one whose document differs from its hash, and one without a hash; preparing them
   succeeds, fails with `CatalogUnavailable`, and succeeds, and with `requireHashes` the third is
   refused.
3. **The plugin framework comes from the Host's own engine, not the public npm registry.**
   Catalog documents declare `dependencies.apps` (for example `0.0.1-beta.140`), and the worker
   build (`compileWorkerApp` in `sdk/src/implementation/worker-build.ts`, reached through
   `workerdApps` and `workerd-entry.ts`) installs that release from the npm registry unless
   `WorkerHost.apps` supplies it. Change: the Host passes `WorkerHost.apps` with the version and
   package files of the engine's own `apps` package through `workerdApps`; a source declaring
   another release is built against the Host's when its protocol is supported and refused with a
   build failure otherwise, and the registry is never asked for `apps`. Test: compile a catalog
   source declaring another `apps` release with the registry set to an unreachable address; it
   builds against the Host's framework and no request is made.
