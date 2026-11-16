/** Plugin source in bare Git repositories on the local disk, with no `git` program. */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  Branch,
  GitCommit,
  GitObjectId,
  SourceCommit,
  SourceError,
  SourceFilePath,
  SourceFiles,
  inlineBytes,
  isPublicSourcePath,
  isUpload,
  publicFits,
  removedPaths,
  sourceFiles,
  sourceFits,
  sourceLimits,
  type RepositoryBackend,
  type SourceFile,
} from "@opensteer/plugin-engine-sdk/core";
import {
  Refusal,
  commitObject,
  findFile,
  initialize,
  listTree,
  objectHeader,
  objectId,
  readCommit,
  readObject,
  readRef,
  supportedFormat,
  updateRef,
  writeObject,
  writeTrees,
  type TreeFile,
} from "./git-store.js";

type Reason = SourceError["reason"];

/** Run filesystem work; a `Refusal` keeps its reason and any other failure is `fallback`. */
const attempt = <A>(work: () => Promise<A>, fallback: Reason = "git") =>
  Effect.tryPromise({
    try: work,
    catch: (error) =>
      new SourceError({ reason: error instanceof Refusal ? error.reason : fallback }),
  });

/** At most `limit` of `work` at a time, results in input order. */
const eachLimited = async <A, B>(
  items: ReadonlyArray<A>,
  limit: number,
  work: (item: A) => Promise<B>,
) => {
  const results: B[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as A);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const text = (bytes: Uint8Array) => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

/** `%s` of `git log`: the first paragraph of the message, its lines joined by spaces. */
const subject = (message: string) => {
  const lines: string[] = [];
  for (const line of message.replace(/^(?:[ \t]*\n)+/u, "").split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.trim() === "") break;
    lines.push(trimmed);
  }
  return lines.join(" ");
};

/**
 * Git keeps a path only when every segment is one it can check out: `update-index` refuses a
 * `.git` segment in any case, and UTF-8 cannot hold a lone surrogate.
 */
const writablePath = (path: string) =>
  Schema.is(SourceFilePath)(path) &&
  !/\p{Cs}/u.test(path) &&
  path.split("/").every((segment) => segment.toLowerCase() !== ".git");

/**
 * Bare repositories at `<directory>/<code>.git`, laid out as `git init --bare` makes them and
 * written as Git writes them, so repositories this backend and the native one write are
 * interchangeable. Git's HTTP protocol is not served.
 */
export const filesystemRepositories = (directory: string): RepositoryBackend => {
  const root = resolve(directory);
  const verified = new Set<string>();
  // One ref moves at a time within this process; the ref's lock file guards against others.
  const queues = new Map<string, Promise<unknown>>();
  const serially = <A>(key: string, work: () => Promise<A>) => {
    const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return run;
  };

  /** The repository's directory. Code IDs are untrusted here; they never leave `directory`. */
  const location = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(id)) throw new Refusal("invalid-source");
    return join(root, `${id}.git`);
  };
  /** An existing repository in a format this backend writes; `absent` when there is none. */
  const repository = async (id: string, absent: Reason) => {
    const path = location(id);
    if (verified.has(path)) return path;
    try {
      await stat(join(path, "HEAD"));
    } catch {
      throw new Refusal(absent);
    }
    if (!(await supportedFormat(path))) throw new Refusal("git");
    verified.add(path);
    return path;
  };
  const create = (id: string) =>
    attempt(async () => {
      const path = location(id);
      await initialize(path);
      if (!(await supportedFormat(path))) throw new Refusal("git");
      verified.add(path);
    });
  const commitOf = async (path: string, commit: string, cache: object, absent: Reason) => {
    const found = await readCommit(path, commit, cache);
    if (found === undefined) throw new Refusal(absent);
    return found;
  };

  return {
    create,
    history: (id) =>
      Effect.gen(function* () {
        const rows = yield* attempt(async () => {
          const path = await repository(id, "git");
          const head = await readRef(path, "refs/heads/main");
          if (head === null) throw new Refusal("git");
          // `git log -50`: newest committer time first across every parent.
          const cache = {};
          const rows = [];
          const seen = new Set([head]);
          const pending = [{ commit: head, parsed: await commitOf(path, head, cache, "git") }];
          while (pending.length > 0 && rows.length < 50) {
            pending.sort((left, right) => right.parsed.committed - left.parsed.committed);
            const next = pending.shift();
            if (next === undefined) break;
            rows.push({
              commit: next.commit,
              author: next.parsed.author,
              timestamp: next.parsed.authored,
              message: subject(next.parsed.message),
            });
            for (const parent of next.parsed.parents) {
              if (seen.has(parent)) continue;
              seen.add(parent);
              pending.push({ commit: parent, parsed: await commitOf(path, parent, cache, "git") });
            }
          }
          return rows;
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(GitCommit))(rows);
      }).pipe(Effect.mapError(() => new SourceError({ reason: "git" }))),
    head: (id, branch) =>
      Effect.gen(function* () {
        if (!Schema.is(Branch)(branch)) return yield* new SourceError({ reason: "invalid-source" });
        return yield* attempt(async () =>
          readRef(await repository(id, "git"), `refs/heads/${branch}`),
        );
      }),
    read: (id, ref) =>
      Effect.gen(function* () {
        const byCommit = Schema.is(SourceCommit)(ref);
        if (!byCommit && !Schema.is(Branch)(ref))
          return yield* new SourceError({ reason: "invalid-source" });
        const snapshot = yield* attempt(async () => {
          const path = await repository(id, byCommit ? "not-found" : "git");
          const cache = {};
          const commit = byCommit ? ref : await readRef(path, `refs/heads/${ref}`);
          if (commit === null) throw new Refusal("not-found");
          const { tree } = await commitOf(path, commit, cache, "not-found");
          // Sizes come from object headers, so the budgets hold before any content is read.
          const entries = await eachLimited(
            await listTree(path, tree, cache),
            16,
            async (entry) => {
              const header = await objectHeader(path, entry.object, cache);
              if (header?.type !== "blob") throw new Error("missing blob");
              if (!Number.isSafeInteger(header.size)) throw new Refusal("limit");
              return { ...entry, size: header.size };
            },
          );
          const code = entries.filter((entry) => !isPublicSourcePath(entry.path));
          const served = entries.filter((entry) => isPublicSourcePath(entry.path));
          const codeBytes = code.reduce((sum, entry) => sum + entry.size, 0);
          if (
            !sourceFits(code.length, codeBytes) ||
            !publicFits(
              served.length,
              served.reduce((sum, entry) => sum + entry.size, 0),
              Math.max(0, ...served.map((entry) => entry.size)),
            )
          )
            throw new Refusal("limit");
          // Public files are inline while they fit beside the code, in path order.
          let remaining = sourceLimits.bytes - codeBytes;
          const inline = new Set<string>();
          for (const entry of served.toSorted((a, b) => (a.path < b.path ? -1 : 1))) {
            if (entry.size > remaining) continue;
            remaining -= entry.size;
            inline.add(entry.path);
          }
          const files = await eachLimited(entries, 16, async (entry): Promise<SourceFile> => {
            const isCode = !isPublicSourcePath(entry.path);
            if (!isCode && !inline.has(entry.path))
              return { path: entry.path, object: entry.object, size: entry.size };
            const found = await readObject(path, entry.object, cache);
            if (found === undefined) throw new Error("missing blob");
            const content = text(found.bytes);
            if (content !== undefined) return { path: entry.path, content };
            if (isCode) throw new Refusal("invalid-source");
            return { path: entry.path, object: entry.object, size: entry.size };
          });
          return { commit, files };
        });
        const files = yield* Schema.decodeUnknownEffect(SourceFiles)(snapshot.files).pipe(
          Effect.mapError(() => new SourceError({ reason: "invalid-source" })),
        );
        return { commit: snapshot.commit, files: yield* sourceFiles(files) };
      }),
    commit: (input) =>
      Effect.gen(function* () {
        if (input.expected === null) yield* create(input.id);
        const files = yield* sourceFiles(input.files);
        const path = yield* attempt(() => repository(input.id, "git"));
        if (!Schema.is(Branch)(input.branch))
          return yield* new SourceError({ reason: "invalid-source" });
        const paths = new Set(files.map((file) => file.path));
        if (paths.size !== files.length || !files.every((file) => writablePath(file.path)))
          return yield* new SourceError({ reason: "invalid-source" });
        const cache = {};
        // Stored files keep a blob the basis revision already holds; they are not rewritten.
        const basis = input.basis ?? input.expected;
        const known = new Set<string>();
        if (files.some((file) => "object" in file && !isUpload(file))) {
          if (basis === null) return yield* new SourceError({ reason: "invalid-source" });
          for (const entry of yield* attempt(async () => {
            if (!Schema.is(SourceCommit)(basis)) throw new Refusal("git");
            return listTree(path, (await commitOf(path, basis, cache, "git")).tree, cache);
          }))
            known.add(entry.object);
        }
        const entries: TreeFile[] = [];
        const inline: Array<{ readonly path: string; readonly bytes: Uint8Array }> = [];
        for (const file of files) {
          if (isUpload(file)) {
            // One upload's bytes at a time; its object ID proves they are the listed file.
            const bytes = yield* file.read;
            if (objectId("blob", bytes) !== file.object)
              return yield* new SourceError({ reason: "storage" });
            yield* attempt(() => writeObject(path, "blob", bytes));
            entries.push({ path: file.path, object: file.object });
          } else if ("object" in file) {
            if (!known.has(file.object))
              return yield* new SourceError({ reason: "invalid-source" });
            entries.push({ path: file.path, object: file.object });
          } else inline.push({ path: file.path, bytes: inlineBytes(file) });
        }
        const written = yield* attempt(() =>
          eachLimited(inline, 8, async (file) => ({
            path: file.path,
            object: await writeObject(path, "blob", file.bytes),
          })),
        );
        const tree = yield* attempt(() => writeTrees(path, [...entries, ...written]));
        // The ref moves only from `expected`, so its tree holds the files this save replaces.
        const previous =
          input.expected === null
            ? []
            : yield* attempt(async () => {
                const expected = input.expected ?? "";
                if (!Schema.is(SourceCommit)(expected)) throw new Refusal("git");
                const { tree } = await commitOf(path, expected, cache, "git");
                return (await listTree(path, tree, cache)).map((entry) => entry.path);
              });
        const commit = yield* attempt(() =>
          writeObject(
            path,
            "commit",
            commitObject({ tree, parent: input.expected, message: input.message, at: new Date() }),
          ),
        );
        const ref = `refs/heads/${input.branch}`;
        const moved = yield* attempt(() =>
          serially(`${path}\0${ref}`, () => updateRef(path, ref, commit, input.expected)),
        );
        if (!moved) return yield* new SourceError({ reason: "conflict" });
        return {
          commit: yield* Schema.decodeUnknownEffect(SourceCommit)(commit).pipe(
            Effect.mapError(() => new SourceError({ reason: "git" })),
          ),
          removed: removedPaths(previous, files),
        };
      }),
    blob: (id, object) =>
      Effect.gen(function* () {
        if (!Schema.is(GitObjectId)(object))
          return yield* new SourceError({ reason: "invalid-source" });
        return yield* attempt(async () => {
          const found = await readObject(await repository(id, "not-found"), object, {});
          if (found?.type !== "blob") throw new Refusal("not-found");
          return found.bytes;
        }, "not-found");
      }),
    file: (id, commit, path) =>
      Effect.gen(function* () {
        if (!Schema.is(SourceCommit)(commit) || !Schema.is(SourceFilePath)(path))
          return yield* new SourceError({ reason: "invalid-source" });
        return yield* attempt(async () => {
          const location = await repository(id, "not-found");
          const cache = {};
          const { tree } = await commitOf(location, commit, cache, "not-found");
          const object = await findFile(location, tree, path, cache);
          const found =
            object === undefined ? undefined : await readObject(location, object, cache);
          if (found?.type !== "blob") throw new Refusal("not-found");
          return found.bytes;
        }, "not-found");
      }),
    // Opensteer serves no Git clients; cloning and pushing app source is refused.
    request: () => Effect.fail(new SourceError({ reason: "protected" })),
  };
};
