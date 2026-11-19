/** Install declared npm packages only when the authored import graph reaches them. */
import { installDependencies, type InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { captureTelemetry } from "@opensteer/plugin-engine-telemetry";
import { Effect, Schema, Semaphore } from "effect";
import type { WorkerHost } from "./worker-build.ts";
import type { Plugin } from "esbuild";
import { boundBuildMessage, describeBuildCause, RuntimeBuildFailed } from "../contracts/runtime.ts";
import tailwind from "tailwindcss/package.json" with { type: "json" };
import { withoutUrlSecrets } from "@opensteer/plugin-engine-utils/url-policy";
import type { DependencyGraph } from "../contracts/worker-build.ts";

const Package = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** A registry version, range or tag, or a tarball URL that carries its integrity. */
const registryOrPinned = (version: string) =>
  /^https?:\/\//u.test(version)
    ? /#(?:sha512|sha384|sha256)-[A-Za-z0-9+/]+={0,2}$/u.test(version)
    : !/^(?:git\+|git:|github:|gitlab:|bitbucket:|file:|link:|npm:|workspace:)|^[./~]|^[^\s@/]+\/[^\s/]+$/u.test(
        version,
      );

/** Each installed package's directory under `node_modules/`, by name, scoped names included. */
const installedPackages = (filesystem: InMemoryFileSystem) => {
  const names = new Set<string>();
  for (const path of filesystem.list("node_modules/")) {
    const parts = path.slice("node_modules/".length).split("/");
    const name = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (name !== undefined && filesystem.read(`node_modules/${name}/package.json`) !== null)
      names.add(name);
  }
  return [...names].sort();
};

/** The SHA-256 of a package's installed files, by path, as the build keeps them. */
const dependencyDigest = async (filesystem: InMemoryFileSystem, name: string) => {
  const prefix = `node_modules/${name}/`;
  const paths = filesystem
    .list(prefix)
    .filter((path) => !path.slice(prefix.length).startsWith("node_modules/"))
    .sort();
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const path of paths) {
    const body = filesystem.readBinary(path) ?? encoder.encode(filesystem.read(path) ?? "");
    parts.push(encoder.encode(`${path.slice(prefix.length)}\0${body.byteLength}\0`), body);
  }
  const all = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", all);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Packages the Host supplies itself, which are never part of a build's recorded graph. */
const hostPackages = new Set(["apps", "tailwindcss"]);

/**
 * The framework is the Host's own (see `WorkerHost`); direct npm imports retain their authored
 * declarations and dependency graphs. A rebuild passes the graph its version installed
 * (`pinned`): every package of it is installed at its version, with nothing resolved again, and
 * must have the digest it had. `registry` replaces the public npm registry when the host
 * configures one.
 * The installer's errors quote the URLs it fetched, which start with that registry. An operator's
 * registry URL can carry credentials or a token, and the deployer reading a failed build is not
 * always the operator, so a failure loses each URL's userinfo, query and fragment. A token the
 * registry takes as a path segment is kept and reaches the deployer: it cannot be told from a path.
 */
export const workerDependencies = (
  filesystem: InMemoryFileSystem,
  host: WorkerHost,
  pinned?: DependencyGraph,
) =>
  Effect.gen(function* () {
    const { registry, publicFetch } = host;
    const manifest = filesystem.read("package.json");
    const dependencies =
      manifest === null
        ? {}
        : ((yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Package))(manifest))
            .dependencies ?? {});
    // A dependency installs from the registry, whose digests are checked, or from a tarball URL
    // whose fragment gives its integrity. Git, file and aliased dependencies have no digest to
    // check. The framework's declaration is only a presence check: it is never fetched.
    for (const [name, version] of Object.entries(dependencies))
      if (name !== "apps" && !registryOrPinned(version))
        return yield* new RuntimeBuildFailed({
          stage: "source",
          location: { file: "package.json" },
          message: boundBuildMessage(
            `The dependency ${name} is ${JSON.stringify(version)}. A plugin build installs packages from the npm registry by version or range, or from an https tarball URL whose fragment is its integrity, such as #sha512-…`,
          ),
        });
    const installLock = yield* Semaphore.make(1);
    // An install fails inside the compiler's resolver, which reports it as its own diagnostic; the
    // first one is kept so the build fails with it, typed, rather than as a compile error.
    let failed: RuntimeBuildFailed | undefined;
    const { context } = yield* captureTelemetry;
    const install = (name: string, version: string, transitive = true) =>
      installLock.withPermits(1)(
        Effect.gen(function* () {
          if (filesystem.read(`node_modules/${name}/package.json`) !== null) return;
          const result = yield* Effect.tryPromise({
            try: () =>
              installDependencies(
                {
                  // The installer sees one declaration; bundling still sees the unmodified manifest.
                  read: (path) =>
                    path === "package.json"
                      ? JSON.stringify({ dependencies: { [name]: version } })
                      : filesystem.read(path),
                  write: (path, value) => filesystem.write(path, value),
                  delete: (path) => filesystem.delete(path),
                  list: (prefix) => filesystem.list(prefix),
                  flush: () => filesystem.flush(),
                },
                {
                  transitive,
                  ...(registry === undefined ? {} : { registry }),
                  ...(publicFetch === undefined ? {} : { publicFetch }),
                },
              ),
            catch: (cause) =>
              new RuntimeBuildFailed({
                stage: "dependencies",
                dependency: name,
                message: boundBuildMessage(
                  withoutUrlSecrets(
                    `Installing ${name}@${version} failed: ${describeBuildCause(cause)}`,
                  ),
                ),
              }),
          });
          if (
            result.warnings.length > 0 ||
            filesystem.read(`node_modules/${name}/package.json`) === null
          )
            return yield* new RuntimeBuildFailed({
              stage: "dependencies",
              dependency: name,
              message: boundBuildMessage(
                withoutUrlSecrets(
                  result.warnings.length > 0
                    ? `Installing ${name}@${version} failed: ${result.warnings.join("; ")}`
                    : `Installing ${name}@${version} did not produce node_modules/${name}/package.json.`,
                ),
              ),
            });
          yield* Effect.annotateCurrentSpan({
            "pluginEngine.build.installed_packages": result.installed.length,
          });
        }).pipe(Effect.withSpan("runtime.cloud.dependencies")),
      );
    /**
     * Install the pinned graph, once: each package at its recorded version alone, so nothing is
     * resolved again, then check each against its recorded digest.
     */
    let graph: Promise<void> | undefined;
    const installPinned = (packages: DependencyGraph) =>
      Effect.gen(function* () {
        for (const entry of packages) yield* install(entry.name, entry.version, false);
        for (const entry of packages) {
          const digest = yield* Effect.promise(() => dependencyDigest(filesystem, entry.name));
          if (digest !== entry.digest)
            return yield* new RuntimeBuildFailed({
              stage: "dependencies",
              message: boundBuildMessage(
                `The registry now serves ${entry.name}@${entry.version} with other contents than this version was built with, so it is not rebuilt with other code.`,
              ),
            });
        }
      });
    const kept = <A, R>(effect: Effect.Effect<A, RuntimeBuildFailed, R>) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            failed ??= error;
          }),
        ),
      );
    const plugin: Plugin = {
      name: "pluginEngine-imported-dependencies",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (args.path === "apps" || args.path.startsWith("apps/")) return undefined;
          if (
            args.kind === "import-rule" &&
            (args.path === "tailwindcss" || args.path.startsWith("tailwindcss/"))
          ) {
            await Effect.runPromiseWith(context)(
              kept(install("tailwindcss", tailwind.version, false)),
            );
            return undefined;
          }
          const parts = args.path.split("/");
          const name = args.path.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
          if (name === undefined || !Object.hasOwn(dependencies, name)) return undefined;
          const version = dependencies[name];
          if (version === undefined) return undefined;
          if (pinned !== undefined) {
            graph ??= Effect.runPromiseWith(context)(kept(installPinned(pinned)));
            await graph;
            if (filesystem.read(`node_modules/${name}/package.json`) === null)
              await Effect.runPromiseWith(context)(
                kept(
                  Effect.fail(
                    new RuntimeBuildFailed({
                      stage: "dependencies",
                      message: boundBuildMessage(
                        `${name} was not installed when this version was built, so its rebuild does not install it.`,
                      ),
                    }),
                  ),
                ),
              );
            return undefined;
          }
          await Effect.runPromiseWith(context)(kept(install(name, version)));
          // Let the existing resolver apply package exports, conditions, and asset handling.
          return undefined;
        });
      },
    };
    return {
      plugin,
      /** The first install that failed while the compiler resolved imports, if one did. */
      failure: () => failed,
      /** Every package the build installed, with its version and digest. */
      installed: Effect.promise(async (): Promise<DependencyGraph> => {
        const graph: Array<DependencyGraph[number]> = [];
        for (const name of installedPackages(filesystem)) {
          if (hostPackages.has(name)) continue;
          const manifest = JSON.parse(filesystem.read(`node_modules/${name}/package.json`)!) as {
            version?: unknown;
          };
          if (typeof manifest.version !== "string" || manifest.version === "") continue;
          graph.push({
            name,
            version: manifest.version,
            digest: await dependencyDigest(filesystem, name),
          });
        }
        return graph;
      }),
      framework: Effect.sync(() => {
        if (dependencies.apps === undefined) return false;
        for (const [path, content] of Object.entries(host.apps.files))
          filesystem.write(`node_modules/apps/${path}`, content);
        return true;
      }),
    };
  }).pipe(
    Effect.catchTag("SchemaError", (cause) =>
      Effect.fail(
        new RuntimeBuildFailed({
          stage: "dependencies",
          location: { file: "package.json" },
          message: boundBuildMessage(`package.json is invalid: ${cause.message}`),
        }),
      ),
    ),
  );
