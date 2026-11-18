/** Static source assets shared by ordinary local and hosted PluginEngine apps. */
import { SourceTextFile as SourceFile } from "@opensteer/plugin-engine-sdk/core";
import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { TemplateError } from "../contracts/templates.ts";

/** Skill files and the framework reference the management API serves. */
export const pluginEngineSkillFiles = (
  assets: Readonly<Record<string, string>>,
): readonly SourceFile[] =>
  Object.entries(assets).map(([path, content]) => SourceFile.make({ path, content }));

/** Bounds on the skill files this package publishes; a tree past them is a packaging mistake. */
const skillAssetLimits = { files: 100, fileBytes: 256 * 1024 } as const;

const skillAssetInvalid = (reason: string) =>
  new TemplateError({ code: "authoring_reference", reason });

/**
 * Every skill directory under `skillsRoot`, as `skills/<name>/<file>.md` paths, including files in
 * nested directories such as `app-authoring/upgrades`. Dotfiles are editor and tool state, and a
 * symbolic link could publish a file from anywhere on the machine, so the walk skips the first and
 * refuses the second.
 */
export const readSkillDocuments = Effect.fnUntraced(function* (skillsRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(skillsRoot);
  const walk = (
    relative: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, TemplateError | PlatformError> =>
    Effect.gen(function* () {
      const directory = path.join(root, ...relative);
      const entries = (yield* fs.readDirectory(directory))
        .filter((entry) => !entry.startsWith("."))
        .sort();
      const nested = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const segments = [...relative, entry];
          const file = path.join(directory, entry);
          // The directory above is already real, so only a link resolves somewhere else.
          if ((yield* fs.realPath(file)) !== file)
            return yield* skillAssetInvalid(
              `PluginEngine skill path ${segments.join("/")} is a symbolic link. Publish the file itself.`,
            );
          const info = yield* fs.stat(file);
          if (info.type === "Directory") return yield* walk(segments);
          // Files beside the skill directories are not part of any skill.
          if (info.type !== "File" || segments.length < 2 || !entry.endsWith(".md")) return [];
          if (Number(info.size) > skillAssetLimits.fileBytes)
            return yield* skillAssetInvalid(
              `PluginEngine skill file ${segments.join("/")} is ${Number(info.size)} bytes; each file may be at most ${skillAssetLimits.fileBytes}.`,
            );
          return [segments];
        }),
      );
      return nested.flat();
    });
  const files = yield* walk([]);
  if (files.length > skillAssetLimits.files)
    return yield* skillAssetInvalid(
      `The PluginEngine skills have ${files.length} files; they may have at most ${skillAssetLimits.files}.`,
    );
  return yield* Effect.forEach(files, (segments) =>
    fs
      .readFileString(path.join(root, ...segments))
      .pipe(Effect.map((content) => [`skills/${segments.join("/")}`, content] as const)),
  );
});

/**
 * The skills this package publishes. The `pluginEngine` skill is the entry point every agent reads, so
 * it locates the directory; each sibling is a skill.
 */
export const readPluginEngineSkillDocuments = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* readSkillDocuments(
    path.dirname(
      path.dirname(
        yield* path.fromFileUrl(
          new URL(
            import.meta
              .resolve("@opensteer/plugin-engine-app-templates/pluginEngine/skills/pluginEngine/SKILL.md"),
          ),
        ),
      ),
    ),
  );
});

/** Node hosts read the same package assets that Workers embed at build time. */
export const readPluginEngineSkills = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const documents = yield* readPluginEngineSkillDocuments;
  const reference = yield* fs.readFileString(
    yield* path.fromFileUrl(new URL(import.meta.resolve("apps/framework-reference.json"))),
  );
  return pluginEngineSkillFiles({
    ...Object.fromEntries(documents),
    "framework-reference.json": reference,
  });
}).pipe(
  // An invalid skill tree keeps its own reason; any other read failure means a missing build.
  Effect.catchTag("PlatformError", () =>
    Effect.fail(
      new TemplateError({
        code: "authoring_reference",
        reason: "Build apps before loading the PluginEngine authoring reference.",
      }),
    ),
  ),
);
