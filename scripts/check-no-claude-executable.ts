import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface AsarReader {
  uncache(path: string): void;
  listPackage(path: string): string[];
  statFile(path: string, entry: string): { files?: object; link?: string };
  extractFile(path: string, entry: string): Buffer;
}
export interface ClaudeDistributionInventory {
  readonly root: string;
  readonly files: { path: string; sha256: string; bytes: number }[];
  readonly sdkJavaScript: string[];
  readonly violations: string[];
}

const forbiddenPath = (path: string) =>
  /(?:^|[/!])claude(?:\.(?:exe|cmd|bat|ps1))?$/iu.test(path) ||
  /claude-agent-sdk-(?:darwin|linux|win32)-/u.test(path) ||
  path.endsWith("claude-agent-sdk/cli.js") ||
  /(?:@anthropic-ai[/+])claude-code(?:[/@]|$)/u.test(path);
const archivePath = /\.(?:zip|tar|tgz|gz|dmg|pkg|deb|AppImage|7z)$/iu;

/** Inspect extracted installers/image filesystems, including packed and unpacked ASAR trees. */
export async function inventoryClaudeDistribution(
  directory: string,
): Promise<ClaudeDistributionInventory> {
  const root = resolve(directory);
  const result: ClaudeDistributionInventory = {
    root,
    files: [],
    sdkJavaScript: [],
    violations: [],
  };
  const inspect = async (path: string, chunks: AsyncIterable<Buffer> | Iterable<Buffer>) => {
    const hash = createHash("sha256");
    let bytes = 0;
    let tail = "";
    let native = false;
    let claudeMetadata = false;
    let opaqueInstaller = false;
    let sdkName = false;
    let sdkOption = false;
    for await (const chunk of chunks) {
      if (bytes === 0) {
        const magic = chunk.subarray(0, 4).toString("hex");
        native =
          [
            "7f454c46",
            "feedface",
            "feedfacf",
            "cefaedfe",
            "cffaedfe",
            "cafebabe",
            "bebafeca",
            "cafebabf",
          ].includes(magic) || chunk.subarray(0, 2).toString() === "MZ";
      }
      hash.update(chunk);
      bytes += chunk.length;
      const source = tail + chunk.toString("latin1");
      claudeMetadata ||= source.includes('PACKAGE_URL:"@anthropic-ai/claude-code"');
      opaqueInstaller ||= source.includes("NullsoftInst");
      sdkName ||= source.includes("@anthropic-ai/claude-agent-sdk");
      sdkOption ||= source.includes("pathToClaudeCodeExecutable");
      tail = source.slice(-256);
    }
    result.files.push({ path, sha256: hash.digest("hex"), bytes });
    if ((native && opaqueInstaller) || (archivePath.test(path) && !forbiddenPath(path))) {
      result.violations.push(`Unpack archive before inventory: ${path}`);
    }
    if (forbiddenPath(path) || (native && claudeMetadata))
      result.violations.push(`Claude executable or platform package: ${path}`);
    if (/\.(?:mjs|cjs|js)$/u.test(path) && bytes > 0 && sdkName && sdkOption)
      result.sdkJavaScript.push(path);
  };
  const walk = async (absolute: string, relative: string): Promise<void> => {
    const stat = await lstat(absolute);
    if (forbiddenPath(relative))
      result.violations.push(`Claude executable or platform package: ${relative}`);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      // Do not follow filesystem-image absolute links onto the checking host.
      if (forbiddenPath(target)) result.violations.push(`Claude symlink: ${relative} -> ${target}`);
      result.files.push({
        path: relative,
        bytes: Buffer.byteLength(target),
        sha256: createHash("sha256").update(target).digest("hex"),
      });
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort())
        await walk(join(absolute, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile() && relative.toLowerCase().endsWith(".asar")) {
      // Reuse the desktop's declared ASAR dependency; no extraction or executable launch.
      const asar = createRequire(new URL("../apps/desktop/package.json", import.meta.url))(
        "@electron/asar",
      ) as AsarReader;
      asar.uncache(absolute);
      for (const entry of asar.listPackage(absolute).sort()) {
        const name = entry.replace(/^[/\\]/u, "").replaceAll("\\", "/");
        const info = asar.statFile(absolute, name);
        const path = `${relative}!/${name}`;
        if (forbiddenPath(path))
          result.violations.push(`Claude executable or platform package: ${path}`);
        if (info.files) continue;
        if (info.link) {
          if (forbiddenPath(path) || forbiddenPath(info.link))
            result.violations.push(`Claude ASAR link: ${path}`);
          continue;
        }
        if (name.toLowerCase().endsWith(".asar")) {
          // ASAR's reader needs a filesystem path; retain the original nested
          // path in evidence and remove the temporary copy even on failure.
          const temporary = await mkdtemp(join(tmpdir(), "opensteer-inventory-asar-"));
          try {
            const nested = join(temporary, "payload.asar");
            await writeFile(nested, asar.extractFile(absolute, name));
            await walk(nested, path);
          } finally {
            await rm(temporary, { recursive: true, force: true });
          }
        } else await inspect(path, [asar.extractFile(absolute, name)]);
      }
    } else if (stat.isFile()) {
      // Never claim to have inspected an opaque installer or compressed payload.
      // Extract these into the supplied directory first; app.asar is handled above.
      if (archivePath.test(relative) && !forbiddenPath(relative))
        result.violations.push(`Unpack archive before inventory: ${relative}`);
      await inspect(relative, createReadStream(absolute));
    } else result.violations.push(`Unsupported filesystem entry: ${relative}`);
  };
  await walk(root, (await lstat(root)).isDirectory() ? "" : basename(root));
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  result.sdkJavaScript.sort();
  if (result.sdkJavaScript.length === 0)
    result.violations.push("Claude Agent SDK JavaScript is missing");
  result.violations.splice(0, result.violations.length, ...new Set(result.violations.sort()));
  return result;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const directory = process.argv[2];
  if (!directory)
    throw new Error(
      "Usage: pnpm exec tsx scripts/check-no-claude-executable.ts <extracted-artifact-or-image-filesystem>",
    );
  inventoryClaudeDistribution(directory)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.violations.length > 0) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
