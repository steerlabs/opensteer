import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import {
  AvailableReferenceSchema,
  ReferenceResolveInputSchema,
  ReferenceResolveResultSchema,
} from "./references.js";
import { FileResourceSchema } from "./file-sources.js";
import { TranscriptFileOpenInputSchema, TranscriptFileContentInputSchema } from "./transcript-files.js";
import { AssetUrlsInputSchema } from "./assets.js";

it("bounds resolution inputs and refuses undeclared private payloads in metadata", () => {
  const id = createId("thread");
  expect(ReferenceResolveInputSchema.parse({ ids: Array(64).fill(id.toUpperCase()) }).ids).toEqual(
    Array(64).fill(id),
  );
  expect(ReferenceResolveInputSchema.safeParse({ ids: Array(65).fill(id) }).success).toBe(false);
  expect(ReferenceResolveInputSchema.safeParse({ ids: [] }).success).toBe(false);
  const available = { status: "available", kind: "task", id, title: "Task" };
  expect(AvailableReferenceSchema.parse(available)).toEqual(available);
  expect(AvailableReferenceSchema.safeParse({ ...available, body: "private" }).success).toBe(false);
  expect(
    ReferenceResolveResultSchema.safeParse({
      results: [{ status: "unavailable", id, reason: "forbidden" }],
    }).success,
  ).toBe(false);
});

it("keeps nullable file context and all three opaque resources without changing asset.urls", () => {
  const source = { kind: "path", path: "/tmp/a%20literal" };
  expect(TranscriptFileOpenInputSchema.parse({ threadId: null, source }).source).toEqual(source);
  for (const resource of [
    { kind: "home", key: "opaque", revision: "revision" },
    { kind: "attachment", attachmentId: createId("attachment"), revision: "revision" },
    { kind: "output-image", sequence: "12", index: 0, revision: "revision" },
  ]) {
    expect(FileResourceSchema.parse(resource)).toEqual(resource);
    expect(TranscriptFileContentInputSchema.parse({ threadId: null, resource }).resource).toEqual(
      resource,
    );
  }
  expect(
    AssetUrlsInputSchema.parse({
      threadId: null,
      assets: [{ source, variant: "preview" }],
    }).assets,
  ).toHaveLength(1);
});
