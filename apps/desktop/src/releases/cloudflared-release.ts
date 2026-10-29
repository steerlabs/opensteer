import { assertRegularFileSync } from "@opensteer/shared/privateFiles";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync } from "node:fs";
import { arch as hostArchitecture, platform as hostPlatform } from "node:os";
import path from "node:path";
import { z } from "zod";

const CloudflaredReleaseManifestSchema = z.strictObject({
  architecture: z.enum(["amd64", "arm64"]),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  operatingSystem: z.enum(["darwin", "linux", "win32"]),
  schemaVersion: z.literal(1),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u),
});

interface PackagedCloudflaredRelease {
  readonly binaryPath: string;
  readonly version: string;
}

/**
 * Resolve only the cloudflared artifact shipped inside the signed Desktop
 * release. There is deliberately no PATH or system-install fallback: the app
 * owns updates and must know the exact connector build it executes.
 */
export function readPackagedCloudflaredRelease(
  resourcesDirectory: string,
): PackagedCloudflaredRelease {
  const directory = path.join(path.resolve(resourcesDirectory), "cloudflared");
  const manifestPath = path.join(directory, "release.json");
  const binaryPath = path.join(
    directory,
    hostPlatform() === "win32" ? "cloudflared.exe" : "cloudflared",
  );
  assertRegularFileSync(manifestPath, "Packaged cloudflared release manifest");
  assertRegularFileSync(binaryPath, "Packaged cloudflared binary");
  const manifest = CloudflaredReleaseManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const operatingSystem = hostPlatform();
  const architecture = normalizeArchitecture(hostArchitecture());
  if (manifest.operatingSystem !== operatingSystem || manifest.architecture !== architecture) {
    throw new Error("Packaged cloudflared release does not match this computer.");
  }
  if (!supportsTokenFile(manifest.version)) {
    throw new Error("Packaged cloudflared must support tunnel token files (2025.4.0 or newer).");
  }
  const actualDigest = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (actualDigest !== manifest.binarySha256) {
    throw new Error("Packaged cloudflared binary does not match its signed release manifest.");
  }
  if (process.platform !== "win32") {
    const mode = lstatSync(binaryPath).mode;
    if ((mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) === 0) {
      throw new Error("Packaged cloudflared binary is not executable.");
    }
  }
  return { binaryPath, version: manifest.version };
}

function normalizeArchitecture(value: string): "amd64" | "arm64" {
  if (value === "x64") return "amd64";
  if (value === "arm64") return "arm64";
  throw new Error(`Packaged cloudflared is unsupported on ${value}.`);
}

function supportsTokenFile(version: string): boolean {
  const [year = 0, month = 0, patch = 0] = version.split(".").map(Number);
  if (year !== 2025) return year > 2025;
  if (month !== 4) return month > 4;
  return patch >= 0;
}
