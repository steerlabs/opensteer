import { expect, it } from "vitest";
import { splitTeamUpload } from "./binary-routes.js";

it("splits a streamed original and preview at exact byte boundaries and rejects extra bytes", async () => {
  const metadata = {
    clientUploadId: crypto.randomUUID(),
    filename: "photo.png",
    mediaType: "image/png",
    sizeBytes: 3,
    previewSizeBytes: 2,
    sha256: "0".repeat(64),
  };
  const parts = splitTeamUpload(
    (async function* () {
      yield Buffer.from([1]);
      yield Buffer.from([2, 3, 4, 5]);
    })(),
    metadata,
  );
  const original: number[] = [],
    preview: number[] = [];
  for await (const bytes of parts.original) original.push(...bytes);
  for await (const bytes of parts.preview!) preview.push(...bytes);
  expect(original).toEqual([1, 2, 3]);
  expect(preview).toEqual([4, 5]);
  const extra = splitTeamUpload(
    (async function* () {
      yield Buffer.from([1, 2, 3, 4, 5, 6]);
    })(),
    metadata,
  );
  for await (const chunk of extra.original) void chunk;
  await expect(async () => {
    for await (const chunk of extra.preview!) void chunk;
  }).rejects.toThrow("trailing");
  const early = splitTeamUpload(
    (async function* () {
      yield Buffer.from([1, 2]);
    })(),
    metadata,
  );
  await expect(async () => {
    for await (const chunk of early.original) void chunk;
  }).rejects.toThrow("early");
});
