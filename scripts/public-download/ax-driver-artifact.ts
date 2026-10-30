import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { journeyWorkDirectory } from "./work-directory.js";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const manifestSchema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  architecture: z.literal("arm64"),
  minimumMacOS: z.literal("14.0"),
  producer: z.literal("host-compile-only"),
});
export function verifyAXDriver(source: Uint8Array, binary: Uint8Array, input: unknown) {
  const manifest = manifestSchema.parse(input);
  assert.equal(
    manifest.sourceSha256,
    digest(source),
    "AX driver source differs from staged binary manifest",
  );
  assert.equal(manifest.binarySha256, digest(binary), "AX driver binary checksum changed");
  return manifest;
}
export function prepareAXDriver(inputs: string) {
  assert(
    process.platform === "darwin" && process.arch === "arm64",
    "AX driver preparation requires an arm64 Mac",
  );
  const source = path.join(import.meta.dirname, "ax-driver.swift"),
    binary = path.join(inputs, "ax-driver"),
    metadata = path.join(inputs, "ax-driver.json");
  if (existsSync(binary) && existsSync(metadata)) {
    try {
      return verifyAXDriver(
        readFileSync(source),
        readFileSync(binary),
        JSON.parse(readFileSync(metadata, "utf8")),
      );
    } catch {
      /* Recompile a stale or incomplete cache. */
    }
  }
  const cache = path.join(journeyWorkDirectory(), "builds/ax-module-cache");
  mkdirSync(cache, { recursive: true });
  execFileSync(
    "swiftc",
    [source, "-target", "arm64-apple-macosx14.0", "-module-cache-path", cache, "-o", binary],
    { timeout: 120_000, stdio: "pipe" },
  );
  const manifest = manifestSchema.parse({
    sourceSha256: digest(readFileSync(source)),
    binarySha256: digest(readFileSync(binary)),
    architecture: "arm64",
    minimumMacOS: "14.0",
    producer: "host-compile-only",
  });
  writeFileSync(metadata, JSON.stringify(manifest, null, 2));
  return manifest;
}
