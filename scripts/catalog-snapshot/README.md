# Plugin catalog snapshot

Opensteer serves its own copy of the plugin catalog at `https://catalog.opensteer.com/index.json`,
the Host's default feed (`apps/host/src/plugins/engine-runtime.ts`). These scripts take the copy,
check it, publish it, and check what is served.

Snapshots hold third-party plugin source and run to about 150 MB. Keep them outside this
repository; `catalog:snapshot` refuses a path inside it.

## Take a snapshot

```sh
pnpm catalog:snapshot --out ~/catalog/2026-11-18 [--rewrites <module>] [--feed <index.json URL>]
```

- Downloads go to `<out>.download` (`--cache` to choose), exactly as served, eight at a time
  (`--concurrency`), with the User-Agent `catalog-snapshot`. An interrupted run resumes from the
  cache. The cache belongs to one version of the feed; when the feed changes, start a new one.
- `--offline` rebuilds from the cache alone, for example to apply a new mapping.
- The output is rebuilt in `<out>.partial` and replaces `<out>` only when every document validates
  and no old string remains. Two builds from the same cache are byte-identical.
- `--feed` defaults to the engine's `officialCatalogUrl`, where the copy is taken from.

Layout, valid at any base URL because the client resolves everything against the index's URL:

| Path             | Content                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `index.json`     | The feed. Each entry gains `sha256`, the hash of its source document.      |
| `apps/<id>.json` | One entry's source, `{ package, files }`; the only place the client reads. |
| `icons/…`        | The icons the feed refers to by relative path.                             |
| `manifest.json`  | Hash and size of every other file, counts, and the rewrite report.         |

Every document is validated with the engine's `CatalogFeed` and `CatalogFeedSource` contracts and
the check the client makes when it prepares an install (`package.json` names the document's
package). JSON is written with sorted keys and two-space indentation.

### Rewriting

`--rewrites <module>` takes a module whose `renames` (or default) export is an ordered list of exact
`[old, new]` string pairs. Each pair is applied in order to every string in the feed and in every
source document: file paths and text contents, but not base64 contents. The report lists how many
replacements each pair made, and the build fails if any old string remains anywhere it rewrote.

## Check a served feed

```sh
pnpm catalog:verify --feed https://catalog.opensteer.com/index.json \
  --manifest ~/catalog/2026-11-18/manifest.json [--entry gmail --entry resend]
```

It lists the feed with the engine's catalog client, prepares the named entries (by default the first
OAuth and the first key-based one), checks each prepared source is the document the index hashes,
and fails if a request or a listed icon leaves the feed's host.

## Publish

Firebase Hosting serves the catalog. See [Hosting](#hosting) for why and for the one-time setup.

```sh
pnpm catalog:publish --dir ~/catalog/2026-11-18 --site opensteer-catalog --dry-run
pnpm catalog:publish --dir ~/catalog/2026-11-18 --site opensteer-catalog
```

The script refuses a directory that differs from its manifest. It then deploys with a pinned
`firebase-tools`. The deploy uploads a new version and switches the whole site to it in one
release, clearing the CDN. `firebase hosting:rollback` returns to the previous release.

## Hosting

Measured snapshot (2026-11-18): 1,840 entries, 1,837 source documents, 2,399 icons, 4,239 files,
149 MB in total. The largest document is 9.4 MB and the index is 0.83 MB. A full listing downloads
the index. Installing an entry downloads one document; browsers load its icons.

|                    | Firebase Hosting (chosen)                                                                       | Cloud Storage + HTTPS load balancer                                                                                                       | Vercel                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| HTTPS on our name  | Managed certificate after a TXT and an A record                                                 | Google-managed certificate on a reserved global IP                                                                                        | Automatic certificate after a CNAME                                                           |
| Limits vs snapshot | 2 GB per file; 10 GB storage free, then $0.026/GB. No file-count limit in its quota docs. Fits. | No relevant limits                                                                                                                        | CLI upload 100 MB on Hobby (too small), 1 GB on Pro; 15,000 files per deployment. Fits on Pro |
| Caching            | Global CDN; `Cache-Control` from the deploy's config; every deploy clears the CDN               | Objects default to `max-age=3600` unless set; Cloud CDN is optional and must be invalidated by hand                                       | Per-deployment CDN cache; headers from `vercel.json`                                          |
| Cost               | Transfer free to 10 GB a month, then $0.15/GB; storage free here                                | About $18 a month for the forwarding rule before any traffic, plus processing and egress                                                  | Included in a Pro seat's allowance                                                            |
| Atomic refresh     | Yes: one release switches every file; rollback built in                                         | No multi-object swap: needs a prefix per snapshot and a URL-map rewrite switch, which reaches edges over minutes, plus a CDN invalidation | Yes: immutable deployments, atomic promotion and rollback                                     |
| DNS at Porkbun     | `TXT catalog hosting-site=<site>`, `A catalog 199.36.158.100`                                   | `A catalog <reserved IP>`                                                                                                                 | `CNAME catalog cname.vercel-dns.com`                                                          |
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
3. Sign in for deploys: `pnpm dlx firebase-tools@15.34.2 login`, or Application Default
   Credentials (`gcloud auth application-default login`).
4. Publish a snapshot (above) and check it on the site's own address:
   `pnpm catalog:verify --feed https://opensteer-catalog.web.app/index.json --manifest <snapshot>/manifest.json`.
5. In the Firebase console, Hosting, site `opensteer-catalog`, add the custom domain
   `catalog.opensteer.com`. Add the records it shows at Porkbun (DNS for `opensteer.com`). They
   have this form:

   | Type | Host                      | Answer                                                      |
   | ---- | ------------------------- | ----------------------------------------------------------- |
   | TXT  | `catalog`                 | `hosting-site=opensteer-catalog` (keep it)                  |
   | TXT  | `_acme-challenge.catalog` | the value the console shows (optional, earlier certificate) |
   | A    | `catalog`                 | `199.36.158.100`, or the address the console shows          |

   Add no AAAA or CNAME record for `catalog`. `opensteer.com` has no CAA records today, so none are
   needed.

6. When the console shows the certificate as active, run `catalog:verify` against
   `https://catalog.opensteer.com/index.json`. Then set the number of releases to keep in Hosting's
   release settings; ten is enough for rollback.

## Integrity

Each index entry carries `sha256`, the hash of its source document's exact bytes. Clients that do not
know the field ignore it. `manifest.json` records every file's hash, and `catalog:publish`
refuses a directory that does not match it.

The install side is one change to the engine's catalog client, made once the engine move has
landed:

- `catalog/src/contracts/catalog.ts`: in `CatalogFeed`, each app gains an optional
  `sha256` (64 lowercase hex characters).
- `catalog/src/implementation/source.ts`, `catalogSource`: one shared, ETag-revalidated read of the
  index keeps each entry's hash beside the listing. `prepare` reads the index this way, reads the
  document as bytes, and fails with `CatalogUnavailable` ("try again shortly; nothing was added")
  when the bytes do not match the recorded hash. An entry without a hash installs as before.
- Test: serve an index with one matching entry, one whose document differs from its hash, and one
  without a hash. Preparing them succeeds, fails with `CatalogUnavailable`, and succeeds.
