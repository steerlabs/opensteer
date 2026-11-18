/** Immutable version inputs are retained independently of editable Git history. */
import { Effect, Option, Schema } from "effect";
import { BlobKey, type BlobStorage } from "../contracts/blobs.ts";
import { VersionId, StorageError } from "../contracts/shared.ts";
import { SourceFiles } from "../contracts/source.ts";

const key = (version: VersionId) => BlobKey.make(`deployments/${version}/source.json`);

/** Persist the complete input before publishing a version record. */
export const writeVersionSource = (blobs: BlobStorage, version: VersionId, files: SourceFiles) =>
  blobs
    .put(key(version), new TextEncoder().encode(JSON.stringify(files)))
    .pipe(Effect.mapError(() => new StorageError()));

/** Read and parse retained inputs; absent or damaged objects are storage failures. */
export const readVersionSource = (blobs: BlobStorage, version: VersionId) =>
  Effect.gen(function* () {
    const bytes = yield* blobs.get(key(version)).pipe(Effect.mapError(() => new StorageError()));
    if (Option.isNone(bytes)) return yield* new StorageError();
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceFiles))(
      new TextDecoder().decode(bytes.value),
    ).pipe(Effect.mapError(() => new StorageError()));
  });
