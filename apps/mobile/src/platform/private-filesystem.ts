import type { PrivateFilesystem } from "@opensteer/client/connections";

/**
 * `expo-file-system`'s `File`, as this adapter needs it. Named locally so the
 * module stays pure TypeScript: the concrete class arrives from the app root,
 * and the tests pass an in-memory one.
 */
export interface DocumentFile {
  readonly exists: boolean;
  readonly uri: string;
  bytes(): Promise<Uint8Array>;
  create(options?: { readonly intermediates?: boolean; readonly overwrite?: boolean }): void;
  delete(): void;
  writeSync(content: string | Uint8Array): void;
}

export interface DocumentDirectory {
  readonly exists: boolean;
  readonly uri: string;
  create(options?: { readonly idempotent?: boolean; readonly intermediates?: boolean }): void;
  list(): readonly unknown[];
}

export interface DocumentFilesystem {
  /** The application's own document directory, as a `file://` URI. */
  readonly root: string;
  directory(uri: string): DocumentDirectory;
  file(uri: string): DocumentFile;
  /**
   * Moves `sourceUri` onto `targetUri`. It sits here rather than on the file
   * because the platform's own move takes its own file type, and this adapter
   * never hands the platform an object it did not make.
   *
   * `targetUri` must not exist. Expo's move deletes an existing destination
   * before it renames — on iOS `removeItem` then `moveItem`, on Android
   * `deleteRecursively` then `renameTo` — so only a move onto free ground is
   * the single atomic rename this adapter's journal depends on.
   */
  replace(sourceUri: string, targetUri: string): void;
}

/**
 * How many times a path is percent-decoded before it is judged. The platform
 * decodes a `file://` URI once; decoding until the string stops changing is
 * strictly stricter, and the only names this application writes are fixed
 * literals, so nothing legitimate is refused by the extra passes.
 */
const maximumDecodePasses = 4;

const stagedUri = (uri: string): string => `${uri}.new`;
const supersededUri = (uri: string): string => `${uri}.old`;

/**
 * `PrivateFilesystem` over the application's document directory.
 *
 * The phone's guarantee is the sandbox: nothing outside this application can
 * read the directory, and nothing inside this adapter opens a path outside it —
 * every path is decoded and judged against the root before any Expo object is
 * constructed from it, so a caller cannot reach the bundle or another app's
 * container through a stored value.
 *
 * `expo-file-system` (SDK 57) has no primitive that renames over an existing
 * file: `move` with `overwrite` deletes the destination first, and `rename`
 * fails outright when the destination is there. So a replacement is journalled.
 * A write stages `name.new`, moves `name` aside to `name.old`, moves
 * `name.new` onto the now-free `name`, and deletes `name.old`; each move lands
 * on a path that does not exist, which is exactly the case where the platform's
 * move is one rename. A reader that finds `name` missing recovers from the
 * journal: `name.old` is the commit marker, so with it present `name.new` wins
 * and without it `name.old` is restored; a staged file with no marker is the
 * interrupted first write of a file that never existed and is discarded.
 */
export function createDocumentPrivateFilesystem(filesystem: DocumentFilesystem): PrivateFilesystem {
  const root = filesystem.root.endsWith("/") ? filesystem.root : `${filesystem.root}/`;
  const decodedRoot = fullyDecoded(root);

  const outside = (): Error =>
    new Error("This path is outside the application's private directory.");

  const within = (path: string): string => {
    if (!path.startsWith(root) || path.length === root.length) throw outside();
    const decoded = fullyDecoded(path);
    if (!decoded.startsWith(decodedRoot)) throw outside();
    const relative = decoded.slice(decodedRoot.length);
    // An empty segment is a leading slash or a doubled one, which is how an
    // absolute path is spelled inside a relative remainder; `.` and `..` are
    // the traversal itself. None of them is a name this application writes.
    for (const segment of relative.split("/")) {
      if (segment === "" || segment === "." || segment === "..") throw outside();
    }
    return path;
  };

  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

  const remove = (uri: string): void => {
    const file = filesystem.file(uri);
    if (file.exists) file.delete();
  };

  /**
   * Brings `uri` back to a settled state after an interrupted write, and says
   * whether anything is there. Total: a path with no file and no journal is an
   * ordinary missing file.
   *
   * `name.old` is the commit marker. It exists only once `name.new` was written
   * whole and `name` was moved out of the way, so a staged file without it is
   * the interrupted first write of a file that never existed — discarded,
   * because publishing half a document is worse than not creating it.
   */
  const settle = (uri: string): boolean => {
    if (filesystem.file(uri).exists) {
      remove(stagedUri(uri));
      remove(supersededUri(uri));
      return true;
    }
    if (!filesystem.file(supersededUri(uri)).exists) {
      remove(stagedUri(uri));
      return false;
    }
    if (filesystem.file(stagedUri(uri)).exists) {
      filesystem.replace(stagedUri(uri), uri);
      remove(supersededUri(uri));
      return true;
    }
    filesystem.replace(supersededUri(uri), uri);
    return true;
  };

  return {
    root,

    async directoryEmpty(path): Promise<boolean> {
      const directory = filesystem.directory(within(path));
      return !directory.exists || directory.list().length === 0;
    },

    async ensureDirectory(path): Promise<void> {
      filesystem.directory(within(path)).create({ idempotent: true, intermediates: true });
    },

    async fileExists(path): Promise<boolean> {
      return settle(within(path));
    },

    async readFile(path, maxBytes): Promise<Uint8Array | null> {
      const uri = within(path);
      if (!settle(uri)) return null;
      const bytes = await filesystem.file(uri).bytes();
      if (bytes.byteLength > maxBytes) {
        throw new Error("This private file exceeds its size limit.");
      }
      return bytes;
    },

    async removeFile(path): Promise<boolean> {
      const uri = within(path);
      // The journal goes too: a `.new` left by an interrupted write would
      // otherwise be recovered into the file this call just removed.
      const existed = settle(uri);
      remove(uri);
      return existed;
    },

    async writeFileAtomic(path, content): Promise<void> {
      const uri = within(path);
      filesystem.directory(parentOf(uri)).create({ idempotent: true, intermediates: true });
      // An earlier write that was interrupted is finished before this one
      // starts, so its committed content cannot be destroyed by staging over it.
      settle(uri);
      const staged = filesystem.file(stagedUri(uri));
      staged.create({ overwrite: true });
      staged.writeSync(content);
      if (filesystem.file(uri).exists) filesystem.replace(uri, supersededUri(uri));
      filesystem.replace(stagedUri(uri), uri);
      remove(supersededUri(uri));
    },

    async writeFileExclusive(path, content): Promise<void> {
      const uri = within(path);
      filesystem.directory(parentOf(uri)).create({ idempotent: true, intermediates: true });
      // A half-written claim is still a claim: recovering first means an
      // interrupted write cannot be mistaken for free ground.
      settle(uri);
      const file = filesystem.file(uri);
      // `create` without `overwrite` is the exclusion: it fails when something
      // is already there, which is what makes this a claim rather than a write.
      file.create();
      file.writeSync(content);
    },
  };
}

/**
 * Percent-decodes until the string stops changing. A path the platform would
 * refuse to decode is not a path this application wrote, so it is refused here
 * rather than handed on.
 */
function fullyDecoded(path: string): string {
  let current = path;
  for (let pass = 0; pass < maximumDecodePasses; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw new Error("This path is outside the application's private directory.");
    }
    if (next === current) return current;
    current = next;
  }
  throw new Error("This path is outside the application's private directory.");
}
