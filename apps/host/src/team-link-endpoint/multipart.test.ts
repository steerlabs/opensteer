import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { teamUploadParts } from "./multipart.js";

const metadata = {
  clientUploadId: "00000000-0000-4000-8000-000000000001",
  filename: "public.txt",
  mediaType: "text/plain",
  sizeBytes: 5,
  sha256: createHash("sha256").update("hello").digest("hex"),
  previewSizeBytes: 0,
};
const original =
  '--b\r\nContent-Disposition: form-data; name="original"; filename="public.txt"\r\n\r\nhello\r\n--b--\r\n';
async function decode(body: string, previewSizeBytes = 0) {
  const upload = teamUploadParts(
    Readable.from([...Buffer.from(body)].map((byte) => Buffer.from([byte]))),
    "multipart/form-data; boundary=b",
    { ...metadata, previewSizeBytes },
    new AbortController().signal,
  );
  const values: Record<string, string> = {};
  for await (const part of upload.parts) {
    const chunks = [];
    for await (const chunk of part.bytes) chunks.push(Buffer.from(chunk));
    values[part.name] = Buffer.concat(chunks).toString();
  }
  expect(upload.complete).toBe(true);
  return values;
}
it("streams the original through arbitrary frame cuts and verifies its digest", async () => {
  expect(await decode(original)).toEqual({ original: "hello" });
});
it("streams a separately bounded preview", async () => {
  const body = original.replace(
    "--b--\r\n",
    '--b\r\nContent-Disposition: form-data; name="preview"\r\n\r\nimg\r\n--b--\r\n',
  );
  expect(await decode(body, 3)).toEqual({ original: "hello", preview: "img" });
});
it.each([
  original.replace("hello", "HELLO"),
  original.replace("hello", "helloo"),
  original.replace("hello", "hell"),
  original.replace('name="original"', 'name="other"'),
  original + "extra",
  original.replace(
    "--b--\r\n",
    '--b\r\nContent-Disposition: form-data; name="original"\r\n\r\nhello\r\n--b--\r\n',
  ),
])("rejects changed bytes, lengths, names, duplicate parts and trailing bytes", async (body) => {
  await expect(decode(body)).rejects.toBeDefined();
});
it("requires the declared preview", async () => {
  await expect(decode(original, 1)).rejects.toBeDefined();
});
