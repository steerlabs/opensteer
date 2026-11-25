import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { RuntimeWorker } from "@alchemy.run/cloudflare-runtime/core";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";

const AssetName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]+$/u)).check(
  Schema.makeFilter((name: string) => name !== "." && name !== ".."),
);
export const ModuleFile = Schema.Struct({
  name: AssetName,
  type: Schema.Literals(["ESModule", "Text", "Wasm"]),
});
export type ModuleFile = typeof ModuleFile.Type;
export const HostArtifact = Schema.Struct({
  runtime: Schema.Array(ModuleFile),
  compiler: Schema.Array(ModuleFile),
});

export const workerdHostArtifact = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const setting = yield* Config.String("PLUGIN_ENGINE_WORKER_BUNDLE").pipe(Config.option);
  const file = yield* Option.match(setting, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped();
        const manifest = path.join(directory, "bridge.json");
        const { writeWorkerdHostBundle } = yield* Effect.promise(
          () => import("./workerd-bundle.ts"),
        );
        yield* writeWorkerdHostBundle(manifest);
        return manifest;
      }),
  });
  const modules = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HostArtifact))));
  return { directory: path.resolve(file + ".modules"), ...modules };
}).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));

class Embedded {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
}

const capnp = (value: unknown): string => {
  if (value instanceof Embedded) return `embed ${JSON.stringify(value.path)}`;
  if (value instanceof Uint8Array) return `0x"${Buffer.from(value).toString("hex")}"`;
  if (Array.isArray(value)) return `[${value.map(capnp).join(", ")}]`;
  if (value !== null && typeof value === "object")
    return `(${Object.entries(value)
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .map(([key, entry]) => `${key} = ${capnp(entry)}`)
      .join(", ")})`;
  if (typeof value === "symbol") return "void";
  if (typeof value === "string")
    return JSON.stringify(value).replace(
      /\\\\|\\u00([0-9a-f]{2})/gu,
      (escape, hex: string | undefined) =>
        hex === undefined ? escape : `\\${Number.parseInt(hex, 16).toString(8).padStart(3, "0")}`,
    );
  return JSON.stringify(value);
};

const moduleField = { ESModule: "esModule", Wasm: "wasm", Text: "text" } as const;
export const fileConfig =
  (importPath: string, modules: readonly ModuleFile[]): NonNullable<RuntimeWorker["textConfig"]> =>
  (config) => ({
    importPath,
    source: `using Workerd = import "/workerd/workerd.capnp";\nconst config :Workerd.Config = ${capnp(
      {
        ...config,
        services: config.services?.map((service) =>
          service.name === "user-worker" && "worker" in service && service.worker
            ? {
                ...service,
                worker: {
                  ...service.worker,
                  modules: modules.map(({ name, type }) => ({
                    name,
                    [moduleField[type]]: new Embedded(`/runtime/${name}`),
                  })),
                },
              }
            : service,
        ),
      },
    )};\n`,
  });
