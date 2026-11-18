/** Read-only registry source for imports. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Publication, PublicationSnapshot, RegistryError, RegistryInputs } from "./registry.ts";

/** Public registry reads expose selected release source, never private app Git history. */
export const RegistryGroup = HttpApiGroup.make("registry")
  .add(
    HttpApiEndpoint.get("list", "/v1/registry/apps", {
      query: { name: RegistryInputs.list.fields.name },
      success: Schema.Array(Publication),
      error: [RegistryError],
    }),
  )
  .add(
    HttpApiEndpoint.get("snapshot", "/v1/registry/source", {
      query: RegistryInputs.snapshot,
      success: PublicationSnapshot,
      error: [RegistryError],
    }),
  )
  .add(
    HttpApiEndpoint.get("file", "/v1/registry/file", {
      query: RegistryInputs.file,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [RegistryError],
    }).annotate(
      OpenApi.Description,
      "One file of a listing's selected commit, as its exact bytes. Snapshots list public files that are not inline text by their blob; installation reads each one here.",
    ),
  );
