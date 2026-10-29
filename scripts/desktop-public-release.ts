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
import { runBounded } from "./command-runner.js";

export const publicFeedURL =
  "https://github.com/steerlabs/opensteer/releases/latest/download/opensteer-mac-arm64.json";
const publicDownloadBase = "https://github.com/steerlabs/opensteer/releases/download";
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);
const tagSchema = z.string().regex(/^desktop-v\d+\.\d+\.\d+$/u);
const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const absolutePath = z
  .string()
  .refine(
    (value) => path.isAbsolute(value) && path.resolve(value) === value && value !== "/",
    "Use a normalized absolute non-root path",
  );
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const assetNames = [
  "Opensteer-mac-arm64.zip",
  "opensteer-mac-arm64.json",
  "install.sh",
  "SHA256SUMS",
] as const;
export const manifestSchema = z
  .strictObject({
    tag: tagSchema,
    title: z.string(),
    notes: z.string(),
    version: versionSchema,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
    assets: z.strictObject({
      "Opensteer-mac-arm64.zip": hashSchema,
      "opensteer-mac-arm64.json": hashSchema,
      "install.sh": hashSchema,
      SHA256SUMS: hashSchema,
    }),
    feedURL: z.string().url(),
    privateFeed: z.boolean(),
  })
  .superRefine((manifest, ctx) => {
    if (
      manifest.tag !== `desktop-v${manifest.version}` ||
      manifest.title !== `Opensteer ${manifest.version} (Alpha)`
    )
      ctx.addIssue({ code: "custom", message: "Manifest tag/title/version disagree" });
    if (manifest.feedURL !== publicFeedURL && !manifest.privateFeed)
      ctx.addIssue({ code: "custom", message: "Private feed must be marked private" });
  });
type Manifest = z.infer<typeof manifestSchema>;
type Run = typeof runBounded;
const releaseSchema = z.object({
  id: z.number().int(),
  draft: z.boolean(),
  tag_name: z.string(),
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
    if (apps.length !== 1 || apps[0] !== "Opensteer.app")
      throw new Error("Archive must contain exactly one top-level Opensteer.app");
    const app = path.join(extracted, "Opensteer.app");
    if (!(await lstat(app)).isDirectory())
      throw new Error("App must be a directory, not a symlink");
    const plist = async (key: string) =>
      (
        await command("/usr/libexec/PlistBuddy", [
          "-c",
          `Print :${key}`,
          path.join(app, "Contents/Info.plist"),
        ])
      ).trim();
    if ((await plist("CFBundleIdentifier")) !== "com.opensteer.opensteer")
      throw new Error("Wrong bundle id");
    if (
      (await plist("CFBundleShortVersionString")) !== version ||
      (await plist("CFBundleVersion")) !== version
    )
      throw new Error("Bundle versions disagree");
    if ((await plist("OpensteerSourceRevision")) !== sourceSha)
      throw new Error("Source revision disagrees");
    const feedURL = await plist("OpensteerUpdateFeedURL");
    z.string().url().parse(feedURL);
    const privateFeed = feedURL !== publicFeedURL || base !== publicDownloadBase;
    if (privateFeed && !input.allowPrivateFeed)
      throw new Error("Private feed/download base requires --allow-private-feed");
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
    const tag = `desktop-v${version}`;
    const extraNotes = input.notesFile
      ? await readFile(absolutePath.parse(input.notesFile), "utf8")
      : "";
    const notes =
      "This is an alpha release of Opensteer for Apple silicon Macs.\n\n```sh\ncurl -fsSL https://github.com/steerlabs/opensteer/releases/latest/download/install.sh | sh\n```" +
      (extraNotes ? `\n\n${extraNotes.trim()}` : "");
    // mkdir without recursive deliberately refuses to overwrite prior release evidence.
    await mkdir(out);
    await copyFile(frozen, path.join(out, assetNames[0]));
    await copyFile(
      fileURLToPath(new URL("./install.sh", import.meta.url)),
      path.join(out, "install.sh"),
    );
    await writeFile(
      path.join(out, assetNames[1]),
      `${JSON.stringify({ currentRelease: version, releases: [{ version, updateTo: { version, name: `Opensteer ${version} (Alpha)`, pub_date: new Date().toISOString(), notes: "", url: `${base}/${tag}/${assetNames[0]}` } }] }, null, 2)}\n`,
    );
    const hashes = await Promise.all(
      assetNames
        .slice(0, 3)
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
      tag,
      title: `Opensteer ${version} (Alpha)`,
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

async function verifyAssets(dir: string, manifest: Manifest) {
  for (const name of assetNames) {
    if ((await sha256File(path.join(dir, name))) !== manifest.assets[name])
      throw new Error(`Asset differs: ${name}`);
  }
}
function releaseBody(manifest: Manifest): string {
  return `${manifest.notes}\n\n<!-- opensteer-release-manifest\n${JSON.stringify(manifest)}\n-->\n`;
}
function releaseManifest(release: z.infer<typeof releaseSchema>): Manifest {
  const marker = "\n<!-- opensteer-release-manifest\n";
  const start = release.body.lastIndexOf(marker);
  if (start < 0 || !release.body.endsWith("\n-->\n")) throw new Error("Release has no manifest");
  const manifest = manifestSchema.parse(
    JSON.parse(release.body.slice(start + marker.length, -"\n-->\n".length)),
  );
  if (
    release.body !== releaseBody(manifest) ||
    release.tag_name !== manifest.tag ||
    release.name !== manifest.title ||
    release.assets
      .map((asset) => asset.name)
      .sort()
      .join("\n") !== [...assetNames].sort().join("\n")
  )
    throw new Error("Release metadata/assets disagree with manifest");
  return manifest;
}

function publicGuard(repo: string, manifest: Manifest) {
  if (
    repo.toLowerCase() === "steerlabs/opensteer" &&
    (manifest.privateFeed || manifest.feedURL !== publicFeedURL)
  )
    throw new Error("Refusing a private feed in the public repository");
}
async function verifyDraftAssets(repo: string, manifest: Manifest, run: Run) {
  const temp = await mkdtemp(path.join(tmpdir(), "opensteer-draft-check-"));
  try {
    await run("gh", ["release", "download", manifest.tag, "--repo", repo, "--dir", temp]);
    await verifyAssets(temp, manifest);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function draft(dirInput: string, repoInput: string, run: Run = runBounded) {
  const dir = absolutePath.parse(dirInput);
  const repo = repoSchema.parse(repoInput);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(dir, "release.json"), "utf8")),
  );
  publicGuard(repo, manifest);
  await verifyAssets(dir, manifest);
  // A listing distinguishes absence from authentication/network failures; never create on an ambiguous error.
  const releases = z.array(releaseSchema).parse(
    z
      .array(z.array(releaseSchema))
      .parse(
        JSON.parse(
          await run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]),
        ),
      )
      .flat(),
  );
  const existing = releases.find((release) => release.tag_name === manifest.tag);
  if (existing) {
    const remote = releaseManifest(existing);
    if (!existing.draft || JSON.stringify(remote) !== JSON.stringify(manifest))
      throw new Error("Existing release differs or is already published");
    await verifyDraftAssets(repo, manifest, run);
    return;
  }
  const notesDir = await mkdtemp(path.join(tmpdir(), "opensteer-release-notes-"));
  try {
    const notesPath = path.join(notesDir, "notes.md");
    await writeFile(notesPath, releaseBody(manifest));
    await run("gh", [
      "release",
      "create",
      manifest.tag,
      "--repo",
      repo,
      "--draft",
      "--title",
      manifest.title,
      "--notes-file",
      notesPath,
      ...assetNames.map((name) => path.join(dir, name)),
    ]);
  } finally {
    await rm(notesDir, { recursive: true, force: true });
  }
}

export async function publish(repoInput: string, tagInput: string, run: Run = runBounded) {
  const repo = repoSchema.parse(repoInput);
  const tag = tagSchema.parse(tagInput);
  const release = releaseSchema.parse(
    JSON.parse(await run("gh", ["api", `repos/${repo}/releases/tags/${tag}`])),
  );
  const manifest = releaseManifest(release);
  publicGuard(repo, manifest);
  // Installers and updaters follow Latest immediately, so nothing becomes public
  // until the draft's stored bytes match its manifest. A rerun after publication
  // only repeats the anonymous check below.
  if (release.draft) {
    await verifyDraftAssets(repo, manifest, run);
    await run("gh", [
      "api",
      "--method",
      "PATCH",
      `repos/${repo}/releases/${release.id}`,
      "-F",
      "draft=false",
      "-F",
      "prerelease=false",
      "-f",
      "make_latest=true",
    ]);
  }
  const temp = await mkdtemp(path.join(tmpdir(), "opensteer-published-check-"));
  try {
    for (const name of assetNames) {
      await run("curl", [
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
      ]);
    }
    await verifyAssets(temp, manifest);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  const [subcommand, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
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
    },
  });
  const required = (key: keyof typeof values) => z.string().min(1).parse(values[key]);
  if (subcommand === "prepare")
    await prepare({
      appZip: required("app-zip"),
      version: required("version"),
      sourceSha: required("source-sha"),
      out: required("out"),
      ...(values["download-base"] ? { downloadBase: values["download-base"] } : {}),
      allowPrivateFeed: values["allow-private-feed"] ?? false,
      ...(values["notes-file"] ? { notesFile: values["notes-file"] } : {}),
    });
  else if (subcommand === "draft") await draft(required("dir"), required("repo"));
  else if (subcommand === "publish") await publish(required("repo"), required("tag"));
  else throw new Error("Usage: desktop:public-release prepare|draft|publish [options]");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
