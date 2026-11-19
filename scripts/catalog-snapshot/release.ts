/**
 * The publisher's work, apart from its command line (publish.ts), so it can also be run in-process.
 * The deploy itself is a parameter: `firebaseDeploy` by default.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkLive, previousChoice, type Manifest } from "./core.ts";
import { holdLock, separatePlaces, stageRelease } from "./disk.ts";

const firebaseTools = "firebase-tools@15.34.2";

export interface PublishOptions {
  readonly dir: string;
  readonly site: string;
  readonly previous?: string | undefined;
  readonly first?: boolean | undefined;
  readonly project?: string | undefined;
  readonly siteUrl?: string | undefined;
  readonly ignoreInterval?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

/**
 * The lock a publish to `site` holds from its first read of the live release until its deploy ends,
 * in this user's temporary directory: publishing is done by one operator from one machine.
 */
export const publishLockOf = (site: string) =>
  join(tmpdir(), `catalog-publish-${encodeURIComponent(site)}.lock`);

/** Run a deploy command in the staging directory; throws when it fails. */
export function firebaseDeploy(command: readonly string[], cwd: string) {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Deploy failed (${result.status ?? result.signal})`);
}

export async function publishRelease(
  values: PublishOptions,
  log: (line: string) => void = console.log,
  deploy: (command: readonly string[], cwd: string) => void | Promise<void> = firebaseDeploy,
) {
  const previous = previousChoice(values.previous, values.first ?? false);
  const project = values.project ?? "opensteer-staging";
  const siteUrl = new URL(values.siteUrl ?? `https://${values.site}.web.app/`);
  const published = new Date();
  const repository = resolve(import.meta.dirname, "../..");
  const staging = await mkdtemp(join(tmpdir(), "catalog-release-"));
  let unlock = async () => {};
  try {
    // Two publishes to one site could both pass the live check below before either deploys.
    if (!values.dryRun)
      unlock = await holdLock(publishLockOf(values.site), `Publishing to ${values.site}`);
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
    const manifestUrl = new URL("manifest.json", siteUrl).href;
    let live: Uint8Array | undefined;
    if (values.dryRun)
      log(
        `Dry run: ${siteUrl.href} was not read, so --previous or --first is not checked against the live release.`,
      );
    else {
      // Loaded only for a real publish: it brings in the engine's catalog client.
      const { liveManifest } = await import("./served.ts");
      live = await liveManifest(manifestUrl);
      log(
        `${siteUrl.href}: ${checkLive({
          live,
          previous: places.previous
            ? new Uint8Array(await readFile(join(places.previous, "manifest.json")))
            : undefined,
          now: published,
          ignoreInterval: values.ignoreInterval ?? false,
        })}`,
      );
    }
    const manifest = JSON.parse(
      await readFile(join(places.dir!, "manifest.json"), "utf8"),
    ) as Manifest;
    log(
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
      project,
      "--non-interactive",
      "--message",
      `catalog ${manifest.feed.sha256.slice(0, 12)}: ${manifest.entries} entries`,
    ];
    log(JSON.stringify(release.configuration, null, 2));
    log(`(in the staging directory) ${command.join(" ")}`);
    if (values.dryRun) log("Dry run: nothing was uploaded.");
    else {
      // The live release must still be the one checked: a publish from elsewhere may have run since.
      const { liveManifest } = await import("./served.ts");
      const now = await liveManifest(manifestUrl);
      const unchanged =
        now === undefined || live === undefined ? now === live : Buffer.from(now).equals(live);
      if (!unchanged)
        throw new Error(
          `${manifestUrl} changed since it was checked, so another publish ran meanwhile. Nothing was deployed; check the live release and publish again.`,
        );
      await deploy(command, staging);
      log(
        `Published. Check it with: pnpm catalog:verify --feed https://${values.site}.web.app/index.json --manifest ${join(places.dir!, "manifest.json")}`,
      );
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await unlock();
  }
}
