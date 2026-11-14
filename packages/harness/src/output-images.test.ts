import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createToolImageStore,
  extractToolOutputImages,
  toolOutputWithImages,
  toolImageMaxBytes,
} from "./output-images.js";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(max?: number) {
  const dir = mkdtempSync(join(tmpdir(), "output-images-"));
  dirs.push(dir);
  return { dir, store: createToolImageStore(dir, max) };
}
it.each([
  ["MCP", { type: "image", data: png, mimeType: "image/png" }],
  ["Anthropic", { type: "image", source: { type: "base64", data: png, media_type: "image/png" } }],
  ["ACP", { type: "content", content: { type: "image", data: png, mimeType: "image/png" } }],
  ["OpenCode", { type: "file", mime: "image/png", url: `data:image/png;base64,${png}` }],
  ["Pi", { type: "image", data: png, mimeType: "image/png" }],
  ["Cursor", { success: { content: [{ type: "image", data: png, mimeType: "image/png" }] } }],
])("extracts %s without leaking bytes", (_name, block) => {
  const { store } = setup();
  const result = extractToolOutputImages([block], store);
  expect(result.images).toHaveLength(1);
  expect(readFileSync(result.images[0]!.path).toString("base64")).toBe(png);
  expect(JSON.stringify(result.value)).not.toContain(png);
});
it("keeps text order and removes rejected, oversized and excess blocks", () => {
  const { store } = setup();
  const block = { type: "image", data: png, mimeType: "image/png" };
  const result = toolOutputWithImages(
    [
      { type: "text", text: "before" },
      ...Array.from({ length: 9 }, () => block),
      { ...block, data: Buffer.alloc(toolImageMaxBytes + 1).toString("base64") },
      { ...block, data: "YmFk" },
      { type: "text", text: "after" },
    ],
    store,
  );
  expect(result.images).toHaveLength(8);
  expect(result.text).toMatch(/^before[\s\S]*after$/);
  expect(result.text).not.toContain(png);
  for (const data of ["YmFk", "invalid!", Buffer.alloc(toolImageMaxBytes + 1).toString("base64")]) {
    const rejected = toolOutputWithImages([{ ...block, data }], store);
    expect(rejected.images).toBeUndefined();
    expect(rejected.text).toContain("image omitted");
    expect(rejected.text).not.toContain(data);
  }
});
it("stores idempotently and prunes oldest first", () => {
  const { store, dir } = setup(10);
  const first = store.put(png, "image/png");
  expect(store.put(png, "image/png")).toEqual(first);
  expect(readdirSync(join(dir, "images"))).toHaveLength(1);
  utimesSync(first.path, 1, 1);
  const second = store.put(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString("base64"),
    "image/png",
  );
  store.prune();
  expect(readdirSync(join(dir, "images"))).toEqual([second.path.split("/").at(-1)]);
});
