import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  AppCodeId,
  type CommitFile,
  type RepositoryBackend,
  type SourceError,
  type SourceFile,
} from "@opensteer/plugin-engine-sdk/core";
import { nativeRepositories, systemGit } from "@opensteer/plugin-engine-app-source/node";
import { filesystemRepositories } from "./repositories.js";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (repository: string, ...args: string[]) =>
  execFileSync("git", ["--git-dir", repository, ...args], { env: gitEnvironment }).toString();

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const scratch = async () => {
  const path = await mkdtemp(join(tmpdir(), "opensteer-plugin-source-"));
  directories.push(path);
  return path;
};

const run = <A>(effect: Effect.Effect<A, SourceError>) => Effect.runPromise(effect);
const failure = async (effect: Effect.Effect<unknown, SourceError>) =>
  (await Effect.runPromise(Effect.flip(effect))).reason;
let codes = 0;
const code = () => AppCodeId.make(`code_${process.pid}_${(codes += 1)}`);
const save = (
  backend: RepositoryBackend,
  id: AppCodeId,
  expected: string | null,
  files: ReadonlyArray<CommitFile>,
  message = "Save",
  branch = "main",
) => backend.commit({ id, branch, expected, files, message });
const sorted = (files: ReadonlyArray<SourceFile>) =>
  files.toSorted((left, right) => (left.path < right.path ? -1 : 1));

// Bytes that are not UTF-8, so reads list the file by its blob instead of inline.
const binary = Uint8Array.from({ length: 300 }, (_, index) => (index * 37 + 128) % 256);
const base = [
  { path: "index.ts", content: "export default 1;\n" },
  { path: "src/tools/deep/nested.ts", content: "export const nested = 'é ✓';\n" },
  {
    path: "ui/public/logo.bin",
    content: Buffer.from(binary).toString("base64"),
    encoding: "base64" as const,
  },
  { path: "ui/public/readme.txt", content: "public text" },
];

const backends: ReadonlyArray<{
  readonly name: string;
  readonly make: (directory: string) => RepositoryBackend;
  readonly skip: string | undefined;
}> = [
  { name: "filesystem", make: filesystemRepositories, skip: undefined },
  {
    name: "native git",
    make: (directory) => nativeRepositories(directory, systemGit),
    skip: gitAvailable ? undefined : "no git program on PATH",
  },
];

for (const backend of backends) {
  describe.skipIf(backend.skip !== undefined)(
    backend.skip === undefined ? backend.name : `${backend.name} (skipped: ${backend.skip})`,
    () => {
      test("creates, commits against the expected revision, and reads every revision back", async () => {
        const repositories = backend.make(await scratch());
        const id = code();
        await run(repositories.create(id));
        expect(await run(repositories.head(id, "main"))).toBeNull();
        expect(await failure(repositories.read(id, "main"))).toBe("not-found");

        const first = await run(save(repositories, id, null, base, "Create app"));
        expect(first.removed).toEqual({ count: 0, paths: [] });
        expect(await run(repositories.head(id, "main"))).toBe(first.commit);
        const read = await run(repositories.read(id, "main"));
        expect(read.commit).toBe(first.commit);
        const logo = read.files.find((file) => file.path === "ui/public/logo.bin");
        expect(logo).toEqual({
          path: "ui/public/logo.bin",
          object: expect.stringMatching(/^[0-9a-f]{40}$/u),
          size: 300,
        });
        expect(sorted(read.files)).toEqual(
          sorted([
            ...base.filter((file) => file.path !== "ui/public/logo.bin"),
            logo as SourceFile,
          ]),
        );
        if (logo === undefined || !("object" in logo))
          throw new Error("binary file was not stored");
        expect(await run(repositories.blob(id, logo.object))).toEqual(binary);
        expect(
          Buffer.from(
            await run(repositories.file(id, first.commit, "src/tools/deep/nested.ts")),
          ).toString(),
        ).toBe("export const nested = 'é ✓';\n");
        expect(await failure(repositories.file(id, first.commit, "src/tools"))).toBe("not-found");
        expect(await failure(repositories.file(id, first.commit, "missing.ts"))).toBe("not-found");
        expect(await failure(repositories.blob(id, "0".repeat(40)))).toBe("not-found");

        // The stored binary is kept by naming its blob; the nested file is dropped.
        const second = await run(
          save(
            repositories,
            id,
            first.commit,
            [
              { path: "index.ts", content: "export default 2;\n" },
              logo,
              { path: "ui/public/readme.txt", content: "public text" },
            ],
            "Second\n\nBody text",
          ),
        );
        expect(second.removed).toEqual({ count: 1, paths: ["src/tools/deep/nested.ts"] });
        expect((await run(repositories.read(id, "main"))).files).toContainEqual({
          path: "index.ts",
          content: "export default 2;\n",
        });
        const earlier = await run(repositories.read(id, first.commit));
        expect(earlier.commit).toBe(first.commit);
        expect(earlier.files).toContainEqual({ path: "index.ts", content: "export default 1;\n" });
        expect(await failure(repositories.read(id, "f".repeat(40)))).toBe("not-found");

        expect(await run(repositories.history(id))).toEqual([
          {
            commit: second.commit,
            author: "PluginEngine",
            message: "Second",
            timestamp: expect.any(Number),
          },
          {
            commit: first.commit,
            author: "PluginEngine",
            message: "Create app",
            timestamp: expect.any(Number),
          },
        ]);
        // A stored file must name a blob of the basis revision.
        expect(
          await failure(
            save(repositories, id, second.commit, [
              { path: "index.ts", content: "" },
              { path: "ui/public/other.bin", object: "1".repeat(40), size: 3 },
            ]),
          ),
        ).toBe("invalid-source");
      });

      test("refuses a commit whose expected revision is stale and keeps the winner", async () => {
        const repositories = backend.make(await scratch());
        const id = code();
        const first = await run(save(repositories, id, null, base));
        const second = await run(
          save(repositories, id, first.commit, [{ path: "index.ts", content: "2" }]),
        );
        expect(
          await failure(save(repositories, id, first.commit, [{ path: "index.ts", content: "3" }])),
        ).toBe("conflict");
        expect(
          await failure(save(repositories, id, null, [{ path: "index.ts", content: "4" }])),
        ).toBe("conflict");
        expect(await run(repositories.head(id, "main"))).toBe(second.commit);
        // Only one of several saves from the same revision lands.
        const racing = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            Effect.runPromise(
              Effect.result(
                save(repositories, id, second.commit, [
                  { path: "index.ts", content: `race ${index}` },
                ]),
              ),
            ),
          ),
        );
        const landed = racing.filter((result) => result._tag === "Success");
        expect(landed).toHaveLength(1);
        expect(
          racing.filter(
            (result) => result._tag === "Failure" && result.failure.reason === "conflict",
          ),
        ).toHaveLength(5);
        expect(await run(repositories.head(id, "main"))).toBe(
          landed[0]?._tag === "Success" ? landed[0].success.commit : "",
        );
      });

      test("keeps files near the source limits and refuses what exceeds them", async () => {
        const repositories = backend.make(await scratch());
        const id = code();
        // Four code files totalling just under 16 MiB, and a 31.9 MB public file, which a save
        // receives as an upload read from outside the repository.
        const chunk = "x".repeat(4 * 1024 * 1024 - 1024);
        const large = new Uint8Array(31_900_000).map((_, index) => (index * 7) % 251);
        const files = [
          { path: "index.ts", content: chunk },
          ...[1, 2, 3].map((index) => ({ path: `data/part${index}.ts`, content: chunk })),
          {
            path: "ui/public/video.bin",
            object: createHash("sha1").update(`blob ${large.length}\0`).update(large).digest("hex"),
            size: large.length,
            read: Effect.succeed(large),
          },
        ];
        const saved = await run(save(repositories, id, null, files));
        const read = await run(repositories.read(id, saved.commit));
        expect(
          read.files
            .filter((file) => "content" in file)
            .map((file) => file.path)
            .sort(),
        ).toEqual(["data/part1.ts", "data/part2.ts", "data/part3.ts", "index.ts"]);
        const video = read.files.find((file) => file.path === "ui/public/video.bin");
        if (video === undefined || !("object" in video))
          throw new Error("large public file was inlined");
        expect(video.size).toBe(large.length);
        expect(Buffer.compare(await run(repositories.blob(id, video.object)), large)).toBe(0);
        expect(
          await failure(
            save(repositories, id, saved.commit, [
              ...files.slice(0, 4),
              { path: "more.ts", content: "x".repeat(5000) },
            ]),
          ),
        ).toBe("limit");
      });

      test("finishes a creation a killed process interrupted", async () => {
        const directory = await scratch();
        const repositories = backend.make(directory);
        // The process died after making the folder and some of its layout.
        const id = code();
        await mkdir(join(directory, `${id}.git`, "objects", "ab"), { recursive: true });
        await writeFile(join(directory, `${id}.git`, "objects", "ab", "tmp_obj_left"), "partial");
        await run(repositories.create(id));
        const first = await run(save(repositories, id, null, base));
        expect((await run(repositories.read(id, "main"))).commit).toBe(first.commit);
        // The process died after writing objects but before moving main.
        const orphaned = code();
        await run(repositories.create(orphaned));
        await run(save(repositories, orphaned, null, base, "Lost", "__pluginEngine/uploads/lost"));
        const saved = await run(save(repositories, orphaned, null, base));
        expect(await run(repositories.head(orphaned, "main"))).toBe(saved.commit);
      });

      test("commits to different repositories at once", async () => {
        const repositories = backend.make(await scratch());
        const ids = Array.from({ length: 8 }, code);
        const heads = await Promise.all(
          ids.map(async (id, index) => {
            let head: string | null = null;
            for (let round = 0; round < 3; round += 1)
              head = (
                await run(
                  save(repositories, id, head, [
                    { path: "index.ts", content: `${index}:${round}` },
                    ...base.slice(1),
                  ]),
                )
              ).commit;
            return head;
          }),
        );
        for (const [index, id] of ids.entries()) {
          const read = await run(repositories.read(id, "main"));
          expect(read.commit).toBe(heads[index]);
          expect(read.files).toContainEqual({ path: "index.ts", content: `${index}:2` });
          expect(await run(repositories.history(id))).toHaveLength(3);
        }
      });
    },
  );
}

describe("filesystem", () => {
  test("never reaches outside its directory and refuses paths Git cannot keep", async () => {
    const parent = await scratch();
    const directory = join(parent, "repositories");
    const repositories = filesystemRepositories(directory);
    const escape = AppCodeId.make("code_/../../escape");
    expect(await failure(repositories.create(escape))).toBe("invalid-source");
    expect(await failure(save(repositories, escape, null, base))).toBe("invalid-source");
    expect(await failure(repositories.read(escape, "main"))).toBe("invalid-source");
    expect(await readdir(parent)).toEqual([]);
    const id = code();
    await run(repositories.create(id));
    expect(await failure(repositories.head(id, "../../HEAD"))).toBe("invalid-source");
    expect(await failure(save(repositories, id, null, base, "x", "../escape"))).toBe(
      "invalid-source",
    );
    for (const path of [".git/config", "src/.GIT/hooks", "a/../b", "\ud800.ts"])
      expect(await failure(save(repositories, id, null, [...base, { path, content: "" }]))).toBe(
        "invalid-source",
      );
    expect(await failure(repositories.request(id, new Request("http://host/info/refs")))).toBe(
      "protected",
    );
    expect(await readdir(parent)).toEqual(["repositories"]);
  });

  test("clears a ref lock left by a killed process but not a live one", async () => {
    const directory = await scratch();
    const repositories = filesystemRepositories(directory);
    const id = code();
    const first = await run(save(repositories, id, null, base));
    const lock = join(directory, `${id}.git`, "refs", "heads", "main.lock");
    await writeFile(lock, "");
    expect(
      await failure(save(repositories, id, first.commit, [{ path: "index.ts", content: "2" }])),
    ).toBe("conflict");
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);
    const second = await run(
      save(repositories, id, first.commit, [{ path: "index.ts", content: "2" }]),
    );
    expect(await run(repositories.head(id, "main"))).toBe(second.commit);
  });
});

describe.skipIf(!gitAvailable)(
  gitAvailable ? "shared repositories" : "shared repositories (skipped: no git program on PATH)",
  () => {
    test("repositories either backend writes are valid Git that the other reads and extends", async () => {
      const directory = await scratch();
      const files = filesystemRepositories(directory);
      const native = nativeRepositories(directory, systemGit);
      const id = code();
      const first = await run(save(files, id, null, base, "Create app"));
      git(join(directory, `${id}.git`), "fsck", "--full", "--strict", "--no-dangling");
      expect(await run(native.read(id, "main"))).toEqual(await run(files.read(id, "main")));
      const second = await run(
        save(native, id, first.commit, [{ path: "index.ts", content: "native" }, ...base.slice(1)]),
      );
      const third = await run(
        save(
          files,
          id,
          second.commit,
          [{ path: "index.ts", content: "files" }, ...base.slice(1)],
          "Third",
        ),
      );
      git(join(directory, `${id}.git`), "fsck", "--full", "--strict", "--no-dangling");
      expect(await run(native.history(id))).toEqual(await run(files.history(id)));
      expect((await run(native.history(id))).map((entry) => entry.commit)).toEqual([
        third.commit,
        second.commit,
        first.commit,
      ]);
      // Objects Git packed are read as well as loose ones.
      git(join(directory, `${id}.git`), "repack", "-a", "-d", "-q");
      git(join(directory, `${id}.git`), "pack-refs", "--all");
      expect(await run(files.read(id, first.commit))).toEqual(
        await run(native.read(id, first.commit)),
      );
      expect(await run(files.read(id, "main"))).toEqual(await run(native.read(id, "main")));
      const fourth = await run(save(files, id, third.commit, base, "Fourth"));
      expect(await run(native.head(id, "main"))).toBe(fourth.commit);
      git(join(directory, `${id}.git`), "fsck", "--full", "--strict", "--no-dangling");
    });
  },
);
