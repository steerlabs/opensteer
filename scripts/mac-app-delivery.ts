import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { z } from "zod";
import type { MacContext } from "./release-beta-mac.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const metadata = z.object({
  path: z.string(),
  mode: z.number().int().min(0).max(0o7777),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  flags: z.number().int().nonnegative(),
  acl: z.string(),
  xattrs: z.record(z.string(), digest),
});
const entriesSchema = z.array(
  z.discriminatedUnion("kind", [
    metadata.extend({ kind: z.literal("directory") }).strict(),
    metadata.extend({ kind: z.literal("file"), sha256: digest }).strict(),
    metadata.extend({ kind: z.literal("symlink"), target: z.string() }).strict(),
  ]),
);
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.string(),
  application: z.literal("Opensteer Beta.app"),
  entries: entriesSchema,
});
export type MacAppManifest = z.infer<typeof manifestSchema>;

async function inventory(app: string, context: MacContext) {
  let output: string;
  try {
    output = await context.run(
      "python3",
      [fileURLToPath(new URL("./mac-app-tree.py", import.meta.url)), app],
      {
        cwd: context.sourceDirectory,
        timeoutMs: 300_000,
        ...(context.signal ? { signal: context.signal } : {}),
      },
    );
  } catch (error) {
    throw new Error(`App tree manifest could not inventory ${app}`, { cause: error });
  }
  return entriesSchema.parse(JSON.parse(output));
}
export async function writeMacAppManifest(app: string, filename: string, context: MacContext) {
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    ...context.identity,
    application: "Opensteer Beta.app",
    entries: await inventory(app, context),
  });
  const bytes = JSON.stringify(manifest) + "\n";
  await replacePrivateFileAtomically(filename, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}
export async function readMacAppManifest(
  filename: string,
  expectedDigest: string,
  context: MacContext,
) {
  const bytes = await readFile(filename);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedDigest)
    throw Error("App tree manifest digest changed");
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    manifest.sourceRevision !== context.identity.sourceRevision ||
    manifest.version !== context.identity.version
  )
    throw Error("App tree manifest belongs to another release");
  return manifest;
}
export async function verifyMacAppTree(app: string, manifest: MacAppManifest, context: MacContext) {
  const actual = await inventory(app, context);
  // Comparing the complete ordered inventory also rejects extras, absent paths,
  // type changes, symlink targets and metadata drift outside signed resources.
  // Destination filesystems can assign a different owner/group during cloning.
  // Ownership is not signed content; retain every other inventory field.
  const comparable = (entries: MacAppManifest["entries"]) =>
    entries.map((entry) => ({ ...entry, uid: 0, gid: 0 }));
  if (JSON.stringify(comparable(actual)) !== JSON.stringify(comparable(manifest.entries)))
    throw Error(`App tree manifest differs: ${app}`);
}
export async function copyMacApp(source: string, destination: string, context: MacContext) {
  // Never merge into a retained partial copy. Its caller must verify it on resume.
  try {
    await lstat(destination);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const options = {
    cwd: context.sourceDirectory,
    timeoutMs: 300_000,
    ...(context.signal ? { signal: context.signal } : {}),
  };
  let cloned = true;
  try {
    await context.run("/bin/cp", ["-cRpP", source, destination], options);
  } catch (error) {
    context.signal?.throwIfAborted();
    if (
      !(error instanceof Error) ||
      !/Operation not supported|Cross-device link|clonefile.*not supported/iu.test(error.message)
    )
      throw error;
    // A clone unsupported on a child may leave a partial tree. Only this known
    // capability failure permits removing it and starting an uncompressed copy.
    cloned = false;
    await rm(destination, { recursive: true, force: true });
    await context.run(
      "/usr/bin/ditto",
      ["--rsrc", "--extattr", "--acl", source, destination],
      options,
    );
  }
  if (cloned)
    await context.run(
      "python3",
      [
        fileURLToPath(new URL("./mac-app-tree.py", import.meta.url)),
        "--copy-acls",
        source,
        destination,
      ],
      options,
    );
}
