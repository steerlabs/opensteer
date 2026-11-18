/** Read selected Git snapshots for independently owned plugin copies. */
import { Effect, Schema } from "effect";
import type { PluginEngine } from "../contracts/pluginEngine.ts";
import {
  PackageManifest,
  PackageName,
  PublicationIssue,
  RegistryError,
  packageLabel,
  type PublicationReference,
  type Registry,
} from "../contracts/registry.ts";
import { JsonObject } from "../contracts/shared.ts";
import {
  SourceFiles,
  isPublicSourcePath,
  sourceFileBytes,
  sourceText,
} from "../contracts/source.ts";
import type { AppCopySnapshot } from "../contracts/apps.ts";

const invalid = (reason: typeof PublicationIssue.Type.reason, name: string | null = null) =>
  new PublicationIssue({ reason, name });

/** Parse the exact saved source that will be published without evaluating any app code. */
const publicationSource = (files: SourceFiles) =>
  Effect.gen(function* () {
    // Public files under ui/public/ are bounded by the source's own public limits; a listing
    // reads them only when it is installed.
    const code = files.filter((file) => !isPublicSourcePath(file.path));
    if (
      code.length > 512 ||
      code.reduce((size, file) => size + sourceFileBytes(file), 0) > 4 * 1024 * 1024
    )
      return yield* invalid("limit");
    if (
      files.some((file) =>
        /(^|\/)(?:\.git|node_modules|\.env(?:\..*)?|\.npmrc|\.pluginEngine)(?:\/|$)/.test(file.path),
      )
    )
      return yield* invalid("invalid-source");
    const content = sourceText(files, "package.json");
    if (content === undefined) return yield* invalid("missing-manifest");
    const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
      content,
    ).pipe(Effect.mapError(() => invalid("invalid-json")));
    const name = document.name;
    if (name === undefined || name === "") return yield* invalid("missing-name");
    if (typeof name !== "string") return yield* invalid("invalid-name");
    if (!Schema.is(PackageName)(name))
      return yield* invalid(
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? "unscoped-name" : "invalid-name",
        name,
      );
    return yield* Schema.decodeUnknownEffect(PackageManifest)(document).pipe(
      Effect.mapError(() => invalid("invalid-metadata", name)),
    );
  });

/** Keep the established write error contract while previews expose the precise repair. */
const publicationFailure = (issue: PublicationIssue): RegistryError => {
  switch (issue.reason) {
    case "forbidden-scope":
      return new RegistryError({ reason: "forbidden" });
    case "name-taken":
      return new RegistryError({ reason: "conflict" });
    case "limit":
    case "invalid-source":
      return new RegistryError({ reason: issue.reason });
    case "missing-manifest":
    case "invalid-json":
    case "missing-name":
    case "unscoped-name":
    case "invalid-name":
    case "invalid-metadata":
      return new RegistryError({ reason: "invalid-manifest" });
  }
};

/** Resolve reviewed public source for the shared copy operation. No app is created here. */
export const resolvePublication = (
  registry: Registry,
  input: PublicationReference,
): Effect.Effect<AppCopySnapshot, RegistryError> =>
  Effect.gen(function* () {
    const snapshot = yield* registry.snapshot(input.package, input.commit);
    if (snapshot.publication.name !== input.package || snapshot.publication.commit !== input.commit)
      return yield* new RegistryError({ reason: "changed" });
    const manifest = yield* publicationSource(snapshot.files).pipe(
      Effect.mapError(publicationFailure),
    );
    // The source keeps the name it was published under; its owner may have changed scope since.
    if (packageLabel(manifest.name) !== packageLabel(input.package))
      return yield* new RegistryError({ reason: "invalid-source" });
    return {
      files: snapshot.files,
      origin: {
        reference: new URL(
          `/api/registry/source?name=${encodeURIComponent(input.package)}&commit=${encodeURIComponent(input.commit)}`,
          registry.origin,
        ).href,
        name: input.package,
        commit: input.commit,
      },
      activation: "deploy",
    };
  });

export const makeRegistry = (reads: Registry): {
  readonly reads: Registry;
  readonly registry: PluginEngine["registry"];
} => ({
  reads,
  registry: {
    list: (input = {}) => reads.list(input.name),
    snapshot: (input) => reads.snapshot(input.name, input.commit),
    file: (input) => reads.file(input.name, input.commit, input.path),
  },
});
