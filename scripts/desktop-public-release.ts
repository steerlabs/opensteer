import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sha256File } from "@opensteer/shared/fileDigest";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
// Match electron-builder exactly: its blockmap format is consumed by electron-updater.
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";
import { runBounded } from "./command-runner.js";

export const publicFeedURL = "https://github.com/steerlabs/opensteer#latest";
const publicDownloadBase = "https://github.com/steerlabs/opensteer/releases/download";
const channelSchema = z.enum(["stable", "beta"]);
type Channel = z.infer<typeof channelSchema>;
function channelConfig(channel: Channel) {
  const beta = channel === "beta";
  return {
    app: beta ? "Opensteer Beta.app" : "Opensteer.app",
    bundleId: beta ? "com.steerlabs.opensteer.beta" : "com.opensteer.opensteer",
    zip: beta ? "Opensteer-Beta-mac-arm64.zip" : "Opensteer-mac-arm64.zip",
    metadata: beta ? "insider-mac.yml" : "latest-mac.yml",
    feed: beta ? "https://github.com/steerlabs/opensteer#insider" : publicFeedURL,
    cache: beta ? "opensteer-beta-updater" : "opensteer-updater",
    tag: (version: string) => (beta ? `v${version}-insider` : `desktop-v${version}`),
    title: (version: string) =>
      beta ? `Opensteer Beta ${version}` : `Opensteer ${version} (Alpha)`,
  };
}
const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
const tagSchema = z.string().regex(/^(?:desktop-v\d+\.\d+\.\d+|v\d+\.\d+\.\d+-insider)$/u);
const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const absolutePath = z
  .string()
  .refine(
    (value) => path.isAbsolute(value) && path.resolve(value) === value && value !== "/",
    "Use a normalized absolute non-root path",
  );
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export function assetsFor(channel: Channel): string[] {
  const config = channelConfig(channel);
  return [
    config.zip,
    `${config.zip}.blockmap`,
    config.metadata,
    ...(channel === "stable" ? ["install.sh"] : []),
    "SHA256SUMS",
  ];
}
export const assetNames = [
  "Opensteer-mac-arm64.zip",
  "Opensteer-mac-arm64.zip.blockmap",
  "latest-mac.yml",
  "install.sh",
  "SHA256SUMS",
] as const;
export const manifestSchema = z
  .strictObject({
    launchCheck: z.literal("passed").optional(),
    channel: channelSchema,
    prerelease: z.boolean(),
    tag: tagSchema,
    title: z.string(),
    notes: z.string(),
    version: versionSchema,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
    assets: z.record(z.string(), hashSchema),
    feedURL: z.string().url(),
    privateFeed: z.boolean(),
  })
  .superRefine((manifest, ctx) => {
    const config = channelConfig(manifest.channel);
    if (
      manifest.tag !== config.tag(manifest.version) ||
      manifest.title !== config.title(manifest.version) ||
      manifest.prerelease !== (manifest.channel === "beta")
    )
      ctx.addIssue({
        code: "custom",
        message: "Manifest channel/tag/title/version/prerelease disagree",
      });
    if (
      Object.keys(manifest.assets).sort().join("\n") !==
      assetsFor(manifest.channel).sort().join("\n")
    )
      ctx.addIssue({ code: "custom", message: "Manifest assets disagree with channel" });
    if (manifest.feedURL !== config.feed && !manifest.privateFeed)
      ctx.addIssue({ code: "custom", message: "Private feed must be marked private" });
  });
type Manifest = z.infer<typeof manifestSchema>;
type Run = typeof runBounded;
export const releaseSchema = z.object({
  id: z.number().int(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  tag_name: z.string(),
  target_commitish: z.string(),
  name: z
    .string()
    .nullable()
    .transform((value) => value ?? ""),
  body: z
    .string()
    .nullable()
    .transform((value) => value ?? ""),
  assets: z.array(z.object({ name: z.string() })),
});

export function downloadBase(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  )
    throw new Error("Download base requires HTTPS, or loopback HTTP for tests");
  return url.href.replace(/\/$/u, "");
}

export async function prepare(
  input: {
    launchCheckPassed?: boolean;
    channel: Channel;
    appZip: string;
    version: string;
    sourceSha: string;
    out: string;
    downloadBase?: string;
    allowPrivateFeed?: boolean;
    notesFile?: string;
  },
  run: Run = runBounded,
): Promise<Manifest> {
  const channel = channelSchema.parse(input.channel);
  const config = channelConfig(channel);
  const names = assetsFor(channel);
  const appZip = absolutePath.parse(input.appZip);
  const out = absolutePath.parse(input.out);
  const version = versionSchema.parse(input.version);
  const sourceSha = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(input.sourceSha);
  const base = downloadBase(input.downloadBase ?? publicDownloadBase);
  if (process.platform !== "darwin") throw new Error("Preparing a Mac release requires macOS");
  const temp = await mkdtemp(path.join(tmpdir(), "opensteer-public-release-"));
  const command: Run = (exe, args, options) => run(exe, args, { timeoutMs: 180_000, ...options });
  try {
    // Freeze the input so validation and the output asset always cover identical bytes.
    const frozen = path.join(temp, "application.zip");
    await copyFile(appZip, frozen);
    const entries = await command("unzip", ["-Z1", frozen]);
    if (
      entries.split("\n").some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))
    )
      throw new Error("Unsafe archive paths");
    const extracted = path.join(temp, "extracted");
    await mkdir(extracted);
    await command("ditto", ["-x", "-k", frozen, extracted]);
    const apps = (await readdir(extracted)).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1 || apps[0] !== config.app)
      throw new Error(`Archive must contain exactly one top-level ${config.app}`);
    const app = path.join(extracted, config.app);
    if (!(await lstat(app)).isDirectory())
      throw new Error("App must be a directory, not a symlink");
    const plist = async (key: string) =>
      (
        await command("/usr/libexec/PlistBuddy", [
          "-c",
          `Print :${key}`,
          path.join(app, "Contents/Info.plist"),
        ])
      ).replace(/\r?\n$/u, "");
    if ((await plist("CFBundleIdentifier")) !== config.bundleId) throw new Error("Wrong bundle id");
    if (
      (await plist("CFBundleShortVersionString")) !== version ||
      (await plist("CFBundleVersion")) !== version
    )
      throw new Error("Bundle versions disagree");
    if ((await plist("OpensteerSourceRevision")) !== sourceSha)
      throw new Error("Source revision disagrees");
    const feedURL = await plist("OpensteerUpdateFeed");
    z.string().url().parse(feedURL);
    let privateFeed = feedURL !== config.feed || base !== publicDownloadBase;
    if (privateFeed && !input.allowPrivateFeed)
      throw new Error("Private feed/download base requires --allow-private-feed");
    const updater = z
      .strictObject({
        provider: z.literal("github"),
        owner: z.literal("steerlabs"),
        repo: z.literal("opensteer"),
        host: z.string().min(1).optional(),
        updaterCacheDirName: z.literal(config.cache),
      })
      .parse(
        parseYaml(await readFile(path.join(app, "Contents/Resources/app-update.yml"), "utf8")),
      );
    if (updater.host !== undefined && !input.allowPrivateFeed)
      throw new Error("Private updater host requires --allow-private-feed");
    privateFeed ||= updater.host !== undefined;
    const executable = await plist("CFBundleExecutable");
    if (!executable || path.basename(executable) !== executable || [".", ".."].includes(executable))
      throw new Error("Invalid bundle executable");
    if (
      (await command("lipo", ["-archs", path.join(app, "Contents/MacOS", executable)])).trim() !==
      "arm64"
    )
      throw new Error("App must be arm64 only");
    await command("codesign", ["--verify", "--deep", "--strict", app]);
    // codesign writes its identity to stderr; PlistBuddy cannot inspect signing metadata.
    const identityPath = path.join(temp, "identity");
    await command("codesign", ["-dv", "--verbose=4", app], { outputFile: identityPath });
    if (
      !(await readFile(identityPath, "utf8")).split(/\r?\n/u).includes("TeamIdentifier=B47U2LLKHW")
    )
      throw new Error("Wrong signing team");
    await command("xcrun", ["stapler", "validate", app]);
    await command("spctl", ["--assess", "--type", "execute", app]);
    const tag = config.tag(version);
    const extraNotes = input.notesFile
      ? await readFile(absolutePath.parse(input.notesFile), "utf8")
      : "";
    const notes =
      (channel === "beta"
        ? "This is a beta release of Opensteer for Apple silicon Macs."
        : "This is an alpha release of Opensteer for Apple silicon Macs.\n\n```sh\ncurl -fsSL https://github.com/steerlabs/opensteer/releases/latest/download/install.sh | sh\n```") +
      (extraNotes ? `\n\n${extraNotes.trim()}` : "");
    // mkdir without recursive deliberately refuses to overwrite prior release evidence.
    await mkdir(out);
    const zip = path.join(out, config.zip);
    await copyFile(frozen, zip);
    if (channel === "stable")
      await copyFile(
        fileURLToPath(new URL("./install.sh", import.meta.url)),
        path.join(out, "install.sh"),
      );
    const { sha512, size } = await buildBlockMap(
      zip,
      "gzip",
      path.join(out, `${config.zip}.blockmap`),
    );
    // GitHubProvider prepends its release-download path, including on private hosts.
    const url = config.zip;
    await writeFile(
      path.join(out, config.metadata),
      stringifyYaml({
        version,
        files: [{ url, sha512, size }],
        path: url,
        sha512,
        releaseDate: new Date().toISOString(),
        releaseName: config.title(version),
      }),
    );
    const hashes = await Promise.all(
      names
        .filter((name) => name !== "SHA256SUMS")
        .map(async (name) => [name, await sha256File(path.join(out, name))] as const),
    );
    await writeFile(
      path.join(out, "SHA256SUMS"),
      hashes.map(([name, hash]) => `${hash}  ${name}\n`).join(""),
    );
    const assets = Object.fromEntries([
      ...hashes,
      ["SHA256SUMS", await sha256File(path.join(out, "SHA256SUMS"))],
    ]);
    const manifest = manifestSchema.parse({
      ...(input.launchCheckPassed ? { launchCheck: "passed" } : {}),
      tag,
      title: config.title(version),
      channel,
      prerelease: channel === "beta",
      notes,
      version,
      sourceSha,
      assets,
      feedURL,
      privateFeed,
    });
    await writeFile(path.join(out, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function verifyAssets(dir: string, manifest: Manifest) {
  for (const name of Object.keys(manifest.assets)) {
    if ((await sha256File(path.join(dir, name))) !== manifest.assets[name])
      throw new Error(`Asset differs: ${name}`);
  }
}
export function releaseManifest(
  release: z.infer<typeof releaseSchema>,
  manifest: Manifest,
): Manifest {
  if (
    release.body !== manifest.notes ||
    release.tag_name !== manifest.tag ||
    // Publication creates a missing tag at this target, so it must be the built source.
    release.target_commitish !== manifest.sourceSha ||
    release.name !== manifest.title ||
    release.prerelease !== manifest.prerelease ||
    release.assets
      .map((asset) => asset.name)
      .sort()
      .join("\n") !== [...assetsFor(manifest.channel), "release.json"].sort().join("\n")
  )
    throw new Error("Release metadata/assets disagree with manifest");
  return manifest;
}
function checkChannel(manifest: Manifest, channel?: string) {
  if (channel !== undefined && channelSchema.parse(channel) !== manifest.channel)
    throw new Error("Requested channel disagrees with release.json channel");
}

export function publicGuard(repo: string, manifest: Manifest) {
  if (
    repo.toLowerCase() === "steerlabs/opensteer" &&
    (manifest.privateFeed || manifest.feedURL !== channelConfig(manifest.channel).feed)
  )
    throw new Error("Refusing a private feed in the public repository");
}
async function verifyDraftAssets(repo: string, tag: string, run: Run, expectedBytes?: Buffer) {
  const temp = await mkdtemp(path.join(tmpdir(), "opensteer-draft-check-"));
  try {
    await run("gh", ["release", "download", tag, "--repo", repo, "--dir", temp], {
      timeoutMs: 610_000,
    });
    const bytes = await readFile(path.join(temp, "release.json"));
    if (expectedBytes && !bytes.equals(expectedBytes))
      throw new Error("Existing release.json differs");
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (manifest.tag !== tag) throw new Error("Manifest tag disagrees");
    await verifyAssets(temp, manifest);
    return { manifest, bytes };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// GitHub's by-tag endpoint returns only published releases, so drafts are found by
// listing. A listing also distinguishes absence from authentication or network
// failures; never create on an ambiguous error.
async function findRelease(repo: string, tag: string, run: Run) {
  const releases = z
    .array(z.array(releaseSchema))
    .parse(
      JSON.parse(
        await run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]),
      ),
    )
    .flat();
  return releases.find((release) => release.tag_name === tag);
}

export async function draft(
  dirInput: string,
  repoInput: string,
  run: Run = runBounded,
  channel?: string,
) {
  const dir = absolutePath.parse(dirInput);
  const repo = repoSchema.parse(repoInput);
  const bytes = await readFile(path.join(dir, "release.json"));
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  checkChannel(manifest, channel);
  publicGuard(repo, manifest);
  await verifyAssets(dir, manifest);
  const existing = await findRelease(repo, manifest.tag, run);
  if (existing) {
    releaseManifest(existing, manifest);
    if (!existing.draft) throw new Error("Existing release differs or is already published");
    await verifyDraftAssets(repo, manifest.tag, run, bytes);
    return;
  }
  const notesDir = await mkdtemp(path.join(tmpdir(), "opensteer-release-notes-"));
  try {
    const notesPath = path.join(notesDir, "notes.md");
    await writeFile(notesPath, manifest.notes);
    await run(
      "gh",
      [
        "release",
        "create",
        manifest.tag,
        "--repo",
        repo,
        "--draft",
        "--target",
        manifest.sourceSha,
        "--title",
        manifest.title,
        "--notes-file",
        notesPath,
        ...(manifest.prerelease ? ["--prerelease", "--latest=false"] : []),
        ...[...assetsFor(manifest.channel), "release.json"].map((name) => path.join(dir, name)),
      ],
      { timeoutMs: 610_000 },
    );
  } finally {
    await rm(notesDir, { recursive: true, force: true });
  }
}

export async function publish(
  repoInput: string,
  tagInput: string,
  run: Run = runBounded,
  {
    channel,
    sourceSha,
    certifiedZipSha256,
  }: {
    channel?: string | undefined;
    sourceSha?: string | undefined;
    certifiedZipSha256?: string | undefined;
  } = {},
) {
  const repo = repoSchema.parse(repoInput);
  const tag = tagSchema.parse(tagInput);
  const release = await findRelease(repo, tag, run);
  if (!release) throw new Error(`No release is tagged ${tag}`);
  const { manifest, bytes } = await verifyDraftAssets(repo, tag, run);
  if (manifest.launchCheck !== "passed") throw Error("Draft lacks passed launch-check evidence");
  releaseManifest(release, manifest);
  checkChannel(manifest, channel);
  publicGuard(repo, manifest);
  // The workflow runs this publisher from its own commit, not the release source,
  // so it names the source it resolved instead of trusting the draft's claim.
  if (sourceSha !== undefined && manifest.sourceSha !== sourceSha)
    throw new Error("Draft was built from another source");
  // The update journey certifies one exact zip. verifyDraftAssets has just checked
  // the freshly downloaded zip against the manifest, so comparing the manifest's
  // hash refuses a later swap even when release.json and SHA256SUMS were rewritten.
  if (
    certifiedZipSha256 !== undefined &&
    manifest.assets[channelConfig(manifest.channel).zip] !== hashSchema.parse(certifiedZipSha256)
  )
    throw new Error("Draft zip is not the certified build");
  // Installers and updaters follow Latest immediately, so nothing becomes public
  // until the draft's stored bytes match its manifest. A rerun after publication
  // only repeats the anonymous check below.
  if (release.draft) {
    await run("gh", [
      "api",
      "--method",
      "PATCH",
      `repos/${repo}/releases/${release.id}`,
      "-F",
      "draft=false",
      "-F",
      `prerelease=${manifest.prerelease}`,
      "-f",
      `make_latest=${!manifest.prerelease}`,
    ]);
  }
  const temp = await mkdtemp(path.join(tmpdir(), "opensteer-published-check-"));
  try {
    for (const name of [...Object.keys(manifest.assets), "release.json"]) {
      await run(
        "curl",
        [
          "-q",
          "-fsSL",
          "--proto",
          "=https",
          "--proto-redir",
          "=https",
          "--tlsv1.2",
          "--connect-timeout",
          "30",
          "--max-time",
          "600",
          "-o",
          path.join(temp, name),
          `https://github.com/${repo}/releases/download/${tag}/${name}`,
        ],
        { timeoutMs: 610_000 },
      );
    }
    await verifyAssets(temp, manifest);
    if (!(await readFile(path.join(temp, "release.json"))).equals(bytes))
      throw new Error("Published release.json differs");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  const [subcommand, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      "launch-check-passed": { type: "boolean" },
      channel: { type: "string" },
      "app-zip": { type: "string" },
      version: { type: "string" },
      "source-sha": { type: "string" },
      out: { type: "string" },
      "download-base": { type: "string" },
      "notes-file": { type: "string" },
      "allow-private-feed": { type: "boolean" },
      dir: { type: "string" },
      repo: { type: "string" },
      tag: { type: "string" },
      "certified-zip-sha256": { type: "string" },
    },
  });
  const required = (key: keyof typeof values) => z.string().min(1).parse(values[key]);
  if (subcommand === "prepare")
    await prepare({
      channel: channelSchema.parse(required("channel")),
      launchCheckPassed: values["launch-check-passed"] ?? false,
      appZip: required("app-zip"),
      version: required("version"),
      sourceSha: required("source-sha"),
      out: required("out"),
      ...(values["download-base"] ? { downloadBase: values["download-base"] } : {}),
      allowPrivateFeed: values["allow-private-feed"] ?? false,
      ...(values["notes-file"] ? { notesFile: values["notes-file"] } : {}),
    });
  else if (subcommand === "draft")
    await draft(required("dir"), required("repo"), runBounded, values.channel);
  else if (subcommand === "publish")
    await publish(required("repo"), required("tag"), runBounded, {
      channel: values.channel,
      sourceSha: values["source-sha"] || undefined,
      certifiedZipSha256: values["certified-zip-sha256"] || undefined,
    });
  else throw new Error("Usage: desktop:public-release prepare|draft|publish [options]");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
