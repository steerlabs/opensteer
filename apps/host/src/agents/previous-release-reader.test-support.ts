import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { HostApiClient } from "@opensteer/protocol";
import type { HostCapability } from "@opensteer/deployment-authority";
import type { HostClient } from "@opensteer/client/host";

const execFile = promisify(execFileCallback);

/**
 * The client people already have installed: the public launch commit (0.1.219).
 * Move it to each public release tag as releases ship. CI checkouts are shallow,
 * so the workflow fetches this one commit before integration tests run.
 */
export const previousPublicRelease = "e4dd721c5f9b2bdac124c59d2c0c11bb676ccaac";

/** The shelves a released client draws a task list on. */
interface ReleasedTaskList {
  readonly working: readonly { threadId: string }[];
  readonly ready: readonly { threadId: string }[];
  readonly done: readonly { threadId: string }[];
}

/** Build actual released source, never current schemas disguised as a baseline. */
export async function releasedClientReader(revision: string) {
  const root = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), `opensteer-reader-${revision}-`));
  try {
    const sourceRevision = (
      await execFile("git", ["rev-parse", "--verify", `${revision}^{commit}`]).catch(() => {
        throw new Error(
          `Released client ${revision} is not in this clone; run git fetch --depth=1 origin ${revision}`,
        );
      })
    ).stdout.trim();
    const hostRevision = (await execFile("git", ["rev-parse", "HEAD"])).stdout.trim();
    const archive = join(directory, "source.tar");
    await execFile("git", [
      "archive",
      "--format=tar",
      "-o",
      archive,
      revision,
      "packages",
      "tsconfig.base.json",
      "tsconfig.package.json",
    ]);
    await execFile("tar", ["-xf", archive, "-C", directory]);
    await symlink(join(root, "node_modules"), join(directory, "node_modules"));
    const packages = new Map<string, { directory: string; exports: Record<string, string> }>();
    for (const name of await readdir(join(directory, "packages"))) {
      const packageDirectory = join(directory, "packages", name);
      // Swift packages such as macos-signing have no npm manifest to resolve.
      if (!existsSync(join(packageDirectory, "package.json"))) continue;
      const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
      packages.set(manifest.name, { directory: packageDirectory, exports: manifest.exports });
      await symlink(
        join(root, "packages", name, "node_modules"),
        join(packageDirectory, "node_modules"),
      );
    }
    const output = join(directory, "reader.mjs");
    await build({
      stdin: {
        contents: `export { HttpHostClient } from '@opensteer/client/host';
          export { hostApi, HostToClientMessageSchema, AgentControlResponseSchema } from '@opensteer/protocol';
          export { ThreadViewSchema, ThreadReadStateSchema, RequestViewSchema } from '@opensteer/core';
          export { HostDescriptorSchema, hostApiCompatibility, knownHostCapabilities } from '@opensteer/deployment-authority';
          export { heldThread, taskList, workspaceTaskList } from '@opensteer/client/host';
          export { mergeThreadReadState } from './packages/client/src/host/thread-read-state.ts';`,
        resolveDir: directory,
      },
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "released-workspace",
          setup(builder) {
            builder.onResolve({ filter: /^@opensteer\// }, ({ path }) => {
              const [scope, name, ...rest] = path.split("/");
              const pkg = packages.get(`${scope}/${name}`);
              if (!pkg) throw new Error(`Missing released package ${path}`);
              const key = rest.length ? `./${rest.join("/")}` : ".";
              let target = pkg.exports[key];
              if (!target) {
                const wildcard = Object.keys(pkg.exports).find(
                  (candidate) => candidate.endsWith("*") && key.startsWith(candidate.slice(0, -1)),
                );
                if (wildcard)
                  target = pkg.exports[wildcard]!.replace("*", key.slice(wildcard.length - 1));
              }
              if (!target) throw new Error(`Missing released export ${path}`);
              return { path: resolve(pkg.directory, target) };
            });
          },
        },
      ],
    });
    const reader = (await import(pathToFileURL(output).href)) as {
      HttpHostClient: new (options: {
        baseUrl: URL;
        capabilities?: readonly HostCapability[];
        fetch: typeof globalThis.fetch;
        webSocketFactory: (url: string) => unknown;
        refreshIntervalMs: number;
      }) => HostClient;
      hostApi: Record<keyof HostApiClient, { success: { parse(value: unknown): unknown } }>;
      heldThread(snapshot: unknown, threadId: string): { doneAt: string | null } | null;
      taskList(snapshot: unknown): ReleasedTaskList;
      workspaceTaskList(snapshot: unknown, workspaceId: string): ReleasedTaskList;
      mergeThreadReadState(previous: unknown, incoming: unknown): unknown;
      hostApiCompatibility(descriptor: unknown): string;
      knownHostCapabilities(advertised: readonly string[]): readonly HostCapability[];
      RequestViewSchema: { parse(value: unknown): unknown };
      AgentControlResponseSchema: { parse(value: unknown): unknown };
      HostDescriptorSchema: {
        parse(value: unknown): { apiVersion: number; capabilities: readonly string[] };
      };
      ThreadViewSchema: { parse(value: unknown): unknown };
      ThreadReadStateSchema: { parse(value: unknown): unknown };
      HostToClientMessageSchema: { parse(value: unknown): unknown };
    };
    return {
      sourceRevision,
      hostRevision,
      reader,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
