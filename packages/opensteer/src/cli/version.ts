import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENSTEER_PACKAGE_NAME = "opensteer";

let opensteerPackageVersionPromise: Promise<string> | undefined;

export function isOpensteerVersionFlag(value: string | undefined): boolean {
  return value === "--version" || value === "-v";
}

export async function readOpensteerCliVersion(): Promise<string> {
  opensteerPackageVersionPromise ??= loadOpensteerCliVersion();
  return await opensteerPackageVersionPromise;
}

async function loadOpensteerCliVersion(): Promise<string> {
  let ancestor = path.dirname(fileURLToPath(import.meta.url));

  for (let index = 0; index < 6; index += 1) {
    const packageJsonPath = path.join(ancestor, "package.json");
    if (existsSync(packageJsonPath)) {
      const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      if (
        manifest.name === OPENSTEER_PACKAGE_NAME &&
        typeof manifest.version === "string" &&
        manifest.version.length > 0
      ) {
        return manifest.version;
      }
    }
    ancestor = path.resolve(ancestor, "..");
  }

  throw new Error("Unable to find the Opensteer package manifest.");
}
