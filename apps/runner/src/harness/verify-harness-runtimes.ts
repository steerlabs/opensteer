import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  harnessRuntimeExpectedVersion,
  shippedHarnessCatalogEntry,
  shippedHarnessKinds,
  type ShippedHarnessKind,
} from "@opensteer/core";
import { engineArtifactPackageVersion } from "@opensteer/harness";
import { defaultHarnessExecutable } from "./harness-drivers.js";

export interface HarnessRuntimeVersionMismatch {
  readonly kind: ShippedHarnessKind;
  readonly executable: string;
  readonly expected: string;
  readonly actual: string;
}

const artifactVersions: Record<ShippedHarnessKind, (executable: string) => Promise<string>> = {
  codex: async (executable) => {
    const version = await engineArtifactPackageVersion(executable, /^@openai\/codex$/u);
    // The native package is an alias with a platform suffix, not the JS launcher package.
    const suffix = `-${process.platform}-${process.arch}`;
    if (!version.endsWith(suffix)) {
      throw new Error(`Codex native package version ${version} lacks platform suffix ${suffix}`);
    }
    return `codex-cli ${version.slice(0, -suffix.length)}`;
  },
  opencode: (executable) =>
    engineArtifactPackageVersion(
      executable,
      /^opencode-(?:darwin|linux|windows)-(?:arm64|x64)(?:-musl)?$/u,
    ),
  pi: (executable) =>
    engineArtifactPackageVersion(executable, /^@earendil-works\/pi-coding-agent$/u),
};

/** Check installed artifacts through the Runner's resolution without executing engine code. */
export async function harnessRuntimeArtifactVersionMismatches(): Promise<
  readonly HarnessRuntimeVersionMismatch[]
> {
  const mismatches: HarnessRuntimeVersionMismatch[] = [];
  for (const kind of shippedHarnessKinds) {
    let executable: string | undefined;
    try {
      executable = defaultHarnessExecutable(kind);
      const actual = await artifactVersions[kind](executable);
      const expected = harnessRuntimeExpectedVersion(kind);
      if (actual !== expected) mismatches.push({ actual, executable, expected, kind });
    } catch (cause) {
      throw new Error(
        `${kind}: cannot verify ${executable ?? "resolved engine"}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  return mismatches;
}

/**
 * Runs `--version` on every engine this Runner ships, resolved exactly as the
 * Runner resolves it when no distribution names an executable, and returns the
 * ones that do not print what the harness catalog pins. A distribution calls
 * this so it asserts the bytes the Runner will actually launch rather than a
 * restated path and version.
 */
export async function harnessRuntimeVersionMismatches(
  nodeExecutable: string,
): Promise<readonly HarnessRuntimeVersionMismatch[]> {
  const results = await Promise.all(
    shippedHarnessKinds.map(async (kind) => {
      const executable = defaultHarnessExecutable(kind);
      const script = shippedHarnessCatalogEntry(kind).runtime.shape === "script";
      const { stdout } = await promisify(execFile)(
        script ? nodeExecutable : executable,
        script ? [executable, "--version"] : ["--version"],
        { timeout: 60_000 },
      );
      const expected = harnessRuntimeExpectedVersion(kind);
      const actual = stdout.trim();
      return actual === expected ? [] : [{ actual, executable, expected, kind }];
    }),
  );
  return results.flat();
}
