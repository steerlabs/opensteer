import type { SnapshotFile } from "@opensteer/agent-plugins";
import type { LocalMcpLaunch } from "@opensteer/integration-core/local-mcp";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";

/** The validated registration the Host writes into every package; it is not one of the files. */
const registrationFile = "local-server-registration.json";
const shownChanges = 8;
const lineChars = 60;
const textBytes = 1024 * 1024;

/**
 * What a person allows by allowing a local server's launch, and what changed since they last
 * allowed it, in terms they can judge: which files changed, by how much, and the first line that
 * did. An approval names one launch by digest, and the launch names its package by the digest
 * of its files (path, mode and bytes, sorted by path), so only a change to those reaches here.
 */
export async function launchReview(input: {
  readonly launch: LocalMcpLaunch;
  /** The launch the person last allowed for this server, or null if they never have. */
  readonly approvedLaunchDigest: string | null;
  /** The package digests this server's plugin has kept, oldest first. */
  readonly versions: readonly string[];
  /** A kept package's files, or null when it is no longer on this Host. */
  readonly files: (digest: string) => Promise<readonly SnapshotFile[] | null>;
}): Promise<string> {
  const { launch } = input;
  const current = launch.packageDigest ? await input.files(launch.packageDigest) : null;
  const folder = current?.filter(({ path }) => path !== registrationFile) ?? [];
  const covers =
    launch.type !== "stdio"
      ? "Allowing it covers this address only, not the program that serves it."
      : current
        ? `Allowing it covers this command and the ${folder.length} ${folder.length === 1 ? "file" : "files"} in its folder (${size(folder.reduce((sum, file) => sum + file.bytes.byteLength, 0))}); a program it starts from elsewhere on this computer is covered by its command only.`
        : "Allowing it covers this command only, not the programs it starts.";
  const approved = input.approvedLaunchDigest;
  if (approved === null || approved === localMcpLaunchDigest(launch)) return covers;
  // The same launch with an earlier package of this plugin is what the person allowed.
  const previous = input.versions.find(
    (digest) =>
      digest !== launch.packageDigest &&
      localMcpLaunchDigest({ ...launch, packageDigest: digest }) === approved,
  );
  if (previous === undefined) return `How it runs changed since you allowed it. ${covers}`;
  const before = await input.files(previous);
  if (!before || !current) return `Its files changed since you allowed it. ${covers}`;
  const changes = fileChanges(before, current);
  const listed = changes.slice(0, shownChanges);
  const more = changes.length - listed.length;
  return `Changed since you allowed it: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}. ${covers}`.slice(
    0,
    3_000,
  );
}

/** Each file added, removed or changed between two packages, in path order. */
export function fileChanges(
  before: readonly SnapshotFile[],
  after: readonly SnapshotFile[],
): string[] {
  const old = new Map(before.map((file) => [file.path, file]));
  const next = new Map(after.map((file) => [file.path, file]));
  const paths = [...new Set([...old.keys(), ...next.keys()])].sort();
  return paths.flatMap((path) => {
    const was = old.get(path);
    const now = next.get(path);
    const name = path === registrationFile ? "its registration" : path;
    if (!was) return [`added ${name} (${size(now!.bytes.byteLength)})`];
    if (!now) return [`removed ${name}`];
    if (was.bytes.equals(now.bytes))
      return was.mode === now.mode
        ? []
        : [`${name} is now ${now.mode & 0o111 ? "executable" : "not executable"}`];
    const line = firstChangedLine(was.bytes, now.bytes);
    return [
      `${name} ${size(was.bytes.byteLength)} → ${size(now.bytes.byteLength)}${line ? `, ${line}` : ""}`,
    ];
  });
}

function firstChangedLine(before: Buffer, after: Buffer): string | undefined {
  const old = text(before);
  const next = text(after);
  if (old === undefined || next === undefined) return undefined;
  const lines = (content: string) => content.replace(/\n$/u, "").split("\n");
  const oldLines = lines(old);
  const newLines = lines(next);
  const index = newLines.findIndex((line, at) => line !== oldLines[at]);
  if (index === -1) return `lines removed after line ${newLines.length}`;
  return `line ${index + 1} now “${clip(newLines[index]!)}”${
    index < oldLines.length ? ` (was “${clip(oldLines[index]!)}”)` : ""
  }`;
}

function text(bytes: Buffer): string | undefined {
  if (bytes.byteLength > textBytes || bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function clip(line: string): string {
  const flat = line.replace(/\s+/gu, " ").trim();
  return flat.length > lineChars ? `${flat.slice(0, lineChars - 1)}…` : flat;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
