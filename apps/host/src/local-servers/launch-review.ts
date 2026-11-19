import {
  localServerRegistrationFile as registrationFile,
  pluginPackageFormat,
  type SnapshotFile,
} from "@opensteer/agent-plugins";
import type { LocalMcpLaunch } from "@opensteer/integration-core/local-mcp";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";
import { OpensteerError } from "@opensteer/core";

const shownChanges = 8;
const nameChars = 80;

/**
 * What a person allows by allowing a local server's launch, and what changed since they last
 * allowed it, in terms they can judge: which files were added, removed or changed, and their
 * sizes. Never anything a file says: a changed line can hold a credential, and this text reaches
 * the owner's review and approval card. An approval names one launch by digest, and the launch
 * names its package by the digest of its files (see pluginPackageManifest), so only a change to
 * those reaches here.
 */
export async function launchReview(input: {
  readonly launch: LocalMcpLaunch;
  /** The launch the person last allowed for this server, or null if they never have. */
  readonly approvedLaunchDigest: string | null;
  /**
   * The packages this server's plugin has kept, oldest first, by digest and the definition it
   * follows (null for one stored before that was recorded).
   */
  readonly versions: readonly { readonly digest: string; readonly format: string | null }[];
  /** A kept package's files, or null when it is no longer on this Host as its digest names it. */
  readonly files: (digest: string) => Promise<readonly SnapshotFile[] | null>;
}): Promise<string> {
  const { launch } = input;
  const current = launch.packageDigest ? await input.files(launch.packageDigest) : null;
  // What would be allowed is the package its digest names; one that is not is never allowed.
  if (launch.packageDigest && !current)
    throw new OpensteerError({
      code: "conflict",
      message:
        "Its files on this Host no longer match what was registered, so it can't be allowed.",
      next: "Ask for it to be registered again from its folder.",
    });
  const folder = current?.filter(({ path }) => path !== registrationFile) ?? [];
  const covers =
    launch.type !== "stdio"
      ? "Allowing it covers this address only, not the program that serves it."
      : `${
          current
            ? `Allowing it covers this command and the ${folder.length} ${folder.length === 1 ? "file" : "files"} in its folder (${size(folder.reduce((sum, file) => sum + file.bytes.byteLength, 0))}); a program it starts from elsewhere on this computer is covered by its command only.`
            : "Allowing it covers this command only, not the programs it starts."
        } Once allowed, it runs as you on this computer, with your permissions, not in a sandbox.`;
  const approved = input.approvedLaunchDigest;
  if (approved === null || approved === localMcpLaunchDigest(launch)) return covers;
  // The same launch with an earlier package of this plugin is what the person allowed.
  const previous = input.versions.find(
    ({ digest }) =>
      digest !== launch.packageDigest &&
      localMcpLaunchDigest({ ...launch, packageDigest: digest }) === approved,
  );
  if (previous === undefined) return `How it runs changed since you allowed it. ${covers}`;
  // Allowed before Opensteer named packages as it does now: its package was stored again under
  // today's digest, and the one allowed can't be compared with it.
  if (previous.format !== pluginPackageFormat)
    return `Opensteer was updated since you allowed it, so it needs allowing again. ${covers}`;
  const before = await input.files(previous.digest);
  if (!before || !current) return `Its files changed since you allowed it. ${covers}`;
  const changes = fileChanges(before, current);
  const listed = changes.slice(0, shownChanges);
  const more = changes.length - listed.length;
  return `Changed since you allowed it: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}. ${covers}`.slice(
    0,
    3_000,
  );
}

/** Each file added, removed or changed between two packages, in path order, by name and size. */
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
    const name = path === registrationFile ? "its registration" : fileName(path);
    if (!was) return [`added ${name} (${size(now!.bytes.byteLength)})`];
    if (!now) return [`removed ${name} (${size(was.bytes.byteLength)})`];
    const changed = !was.bytes.equals(now.bytes);
    const mode = was.mode !== now.mode;
    if (!changed && !mode) return [];
    return [
      `${changed ? "changed" : "mode changed"} ${name} (${
        changed
          ? `${size(was.bytes.byteLength)} → ${size(now.bytes.byteLength)}`
          : size(now.bytes.byteLength)
      }${changed && mode ? ", mode changed" : ""})`,
    ];
  });
}

/** A file's path as a person reads it: no control or direction characters, and bounded. */
function fileName(path: string): string {
  const shown = path.replace(/[\p{Cc}\p{Cf}]/gu, "?");
  return shown.length > nameChars ? `…${shown.slice(-(nameChars - 1))}` : shown;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
