import { engineActiveVersions } from "./engine-storage.js";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  pluginPackageFormat,
  pluginSnapshotDigest,
  readPluginSnapshot,
  readVerifiedPluginSnapshot,
} from "@opensteer/agent-plugins";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import type { PinnedPluginSchema } from "@opensteer/protocol";
import type { PluginOutput } from "./engine-protocol.js";

const entrySchema = z.strictObject({
  format: z.literal(pluginPackageFormat),
  pluginId: z.string().regex(/^app_[0-9a-f-]{36}$/u),
  name: z.string().min(1).max(64),
  version: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  hasSkills: z.boolean(),
  hasPage: z.boolean(),
});

/** Active-version metadata and immutable Runner snapshots; reads never start the engine. */
export class PluginSkillCache {
  readonly #root: string;
  readonly #packages: string;
  readonly #databaseUrl: string;
  constructor(dataDirectory: string, databaseUrl: string) {
    this.#databaseUrl = databaseUrl;
    this.#root = join(dataDirectory, "plugins", "active");
    this.#packages = join(dataDirectory, "plugins", "data", "packages");
  }
  /**
   * Record a version's skills as the plugin's entry, only while it is still the active version
   * (`active`, read again just before the entry is replaced): a refresh that read a version a later
   * change replaced writes nothing. Returns whether it wrote the entry.
   */
  async record(
    bundle: PluginOutput<"skillFiles">,
    active: () => Promise<string | undefined>,
  ): Promise<boolean> {
    const pluginId = entrySchema.shape.pluginId.parse(bundle.plugin);
    const files = bundle.files.map((file) => {
      if (
        !("content" in file) ||
        "encoding" in file ||
        file.path.includes("\\") ||
        file.path.includes("\0") ||
        file.path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Plugin skill resources must be relative UTF-8 text files");
      return { path: `skills/${file.path}`, content: file.content };
    });
    if (new Set(files.map((file) => file.path)).size !== files.length)
      throw new Error("Plugin skill resources must have unique paths");
    await mkdir(this.#packages, { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(this.#packages, ".stage-"));
    try {
      for (const file of files) {
        await mkdir(join(stage, file.path, ".."), { recursive: true, mode: 0o700 });
        await writeFile(join(stage, file.path), file.content, { mode: 0o600, flag: "wx" });
      }
      const digest = pluginSnapshotDigest(await readPluginSnapshot(stage));
      const entry = entrySchema.parse({
        format: pluginPackageFormat,
        pluginId,
        name: bundle.slug,
        version: bundle.version,
        digest,
        hasSkills: files.length > 0,
        hasPage: bundle.hasPage,
      });
      const target = join(this.#packages, digest);
      try {
        await rename(stage, target);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code)))
          throw error;
        await readVerifiedPluginSnapshot(target, digest);
      }
      if ((await active()) !== entry.version) return false;
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await replacePrivateFileAtomically(
        join(this.#root, pluginId + ".json"),
        JSON.stringify(entry),
      );
      return true;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  /** The plugin's entry, only while it names `version`, the plugin's active version. */
  async current(plugin: string, version: string | null) {
    const entry = version === null ? undefined : await this.get(plugin);
    return entry?.version === version ? entry : undefined;
  }
  async get(plugin: string) {
    if (!/^app_[0-9a-f-]{36}$/u.test(plugin)) return undefined;
    try {
      const entry: unknown = JSON.parse(await readFile(join(this.#root, plugin + ".json"), "utf8"));
      // One recorded under another package format names a digest no reader accepts; the plugin's
      // next install or activation records it again.
      if (typeof entry !== "object" || entry === null || !("format" in entry)) return undefined;
      if (entry.format !== pluginPackageFormat) return undefined;
      return entrySchema.parse(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  /** The plugins with an entry. */
  async plugins(): Promise<string[]> {
    const names = await readdir(this.#root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return names
      .filter((name) => /^app_[0-9a-f-]{36}\.json$/u.test(name))
      .map((name) => name.slice(0, -5));
  }
  async remove(plugin: string) {
    if (!/^app_[0-9a-f-]{36}$/u.test(plugin)) throw new Error("Invalid plugin ID");
    await rm(join(this.#root, plugin + ".json"), { force: true });
  }
  async versions(
    settings: readonly { pluginId: string; access: "all" | "read-only" | "off" }[],
  ): Promise<z.infer<typeof PinnedPluginSchema>[]> {
    const names = await readdir(this.#root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const entries = await Promise.all(
      names
        .filter((name) => /^app_[0-9a-f-]{36}\.json$/u.test(name))
        .map((name) => this.get(name.slice(0, -5))),
    );
    if (!entries.some((entry) => entry?.hasSkills)) return [];
    const active = await engineActiveVersions(this.#databaseUrl);
    return entries.flatMap((entry) =>
      entry?.hasSkills &&
      active.get(entry.pluginId) === entry.version &&
      settings.find((row) => row.pluginId === entry.pluginId)?.access !== "off"
        ? [{ pluginId: entry.pluginId, name: entry.name, digest: entry.digest }]
        : [],
    );
  }
}
