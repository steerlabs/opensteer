import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { releasePasskeyInputs } from "./passkeys-signing.cjs";
const desktop = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const toolchainSchema = z.object({
  xcode: z.string(),
  sdk: z.string(),
  clang: z.string(),
  nodeHeaders: z.string(),
  napi: z.literal(8),
  headers: z.record(
    z.enum(["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"]),
    z.string().regex(/^[a-f0-9]{64}$/u),
  ),
});
const run = (program: string, args: readonly string[]) =>
  execFileSync(program, [...args], {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** N-API has no Electron/V8 ABI dependency; both slices use the same pinned headers. */
export async function buildPasskeysAddon(
  stageDirectory = path.join(desktop, "dist/passkeys"),
): Promise<void> {
  if ((process.env.OPENSTEER_DESKTOP_TARGET_OS ?? process.platform) !== "darwin") return;
  const source = path.join(desktop, "native/passkeys");
  const build = path.join(desktop, "generated-native/passkeys");
  const headers = path.join(build, "headers");
  const pin = toolchainSchema.parse(
    JSON.parse(await readFile(path.join(source, "toolchain.json"), "utf8")),
  );
  if (
    run("/usr/bin/xcodebuild", ["-version"]) !== pin.xcode ||
    run("/usr/bin/xcrun", ["--show-sdk-version"]) !== pin.sdk ||
    !run("/usr/bin/xcrun", ["clang++", "--version"]).includes(`(${pin.clang})`)
  )
    throw new Error("Passkey addon requires its pinned Xcode, SDK and clang toolchain");
  await mkdir(headers, { recursive: true });
  for (const [name, digest] of Object.entries(pin.headers)) {
    const filename = path.join(headers, name);
    let bytes: Buffer;
    try {
      bytes = await readFile(filename);
    } catch {
      const response = await fetch(
        `https://raw.githubusercontent.com/nodejs/node/v${pin.nodeHeaders}/src/${name}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) throw new Error("Could not fetch pinned N-API headers");
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("Pinned N-API header digest differs");
    await writeFile(filename, bytes);
  }
  const sdk = run("/usr/bin/xcrun", ["--show-sdk-path"]);
  const slices = ["arm64", "x86_64"].map((architecture) => {
    const output = path.join(build, `${architecture}.node`);
    run("/usr/bin/xcrun", [
      "clang++",
      "-std=c++17",
      "-fobjc-arc",
      "-fblocks",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Wno-unused-parameter",
      "-Werror=unguarded-availability",
      "-fvisibility=hidden",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-mmacosx-version-min=13.0",
      "-isysroot",
      sdk,
      "-arch",
      architecture,
      `-DNAPI_VERSION=${pin.napi}`,
      "-I",
      headers,
      path.join(source, "addon.mm"),
      "-framework",
      "AppKit",
      "-framework",
      "AuthenticationServices",
      "-framework",
      "Security",
      "-o",
      output,
    ]);
    return output;
  });
  const universal = path.join(build, "opensteer-passkeys.node");
  run("/usr/bin/lipo", ["-create", ...slices, "-output", universal]);
  const architectures = run("/usr/bin/lipo", ["-archs", universal]).split(/\s+/u).sort();
  if (architectures.join(" ") !== "arm64 x86_64")
    throw new Error("Passkey addon must include both architectures");
  // Packaging supplies the Developer ID signature; the development artifact has no entitlement.
  run("/usr/bin/codesign", ["--force", "--sign", "-", universal]);
  await mkdir(stageDirectory, { recursive: true });
  await copyFile(universal, path.join(stageDirectory, "opensteer-passkeys.node"));
}
/** Development bundling can run without Xcode; an explicit build supplies its optional addon. */
export async function stagePasskeysAddon(): Promise<void> {
  if ((process.env.OPENSTEER_DESKTOP_TARGET_OS ?? process.platform) !== "darwin") return;
  if (process.env.OPENSTEER_DESKTOP_RELEASE === "1") {
    if (releasePasskeyInputs(process.env)) await buildPasskeysAddon();
    else await rm(path.join(desktop, "dist/passkeys/opensteer-passkeys.node"), { force: true });
    return;
  }
  const source = path.join(desktop, "generated-native/passkeys/opensteer-passkeys.node");
  try {
    await lstat(source);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (run("/usr/bin/lipo", ["-archs", source]).split(/\s+/u).sort().join(" ") !== "arm64 x86_64")
    throw new Error("Passkey addon must include both architectures");
  const directory = path.join(desktop, "dist/passkeys");
  await mkdir(directory, { recursive: true });
  await copyFile(source, path.join(directory, "opensteer-passkeys.node"));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildPasskeysAddon();
