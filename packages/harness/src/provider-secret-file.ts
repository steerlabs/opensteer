import {
  readPrivateFileText,
  replacePrivateFileAtomically,
} from "@opensteer/shared/atomicPrivateFile";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OpensteerError } from "@opensteer/core";
import type { HarnessProviderState } from "./types.js";

/** One secret a driver keeps inside an isolated profile's own provider home. */
export interface ProviderSecretFile {
  readonly path: string;
  /** The stored secret, or undefined when nothing is stored. */
  read(): Promise<string | undefined>;
  write(secret: string): Promise<void>;
  remove(): Promise<void>;
}

export interface ProviderSecretFileOptions {
  /** How the secret is named in a failure a person reads — "Anthropic API key". */
  readonly description: string;
  readonly maximumBytes: number;
}

/**
 * A provider credential Opensteer stores itself, rather than one the vendor's
 * own CLI keeps. It lives inside the profile's provider home at mode 0600 and
 * is replaced whole, so a reader sees the previous secret or the new one and
 * never half of either.
 *
 * Only an isolated profile can hold one: an ambient profile shares the
 * computer's own provider home, and writing a Deployment's credential into it
 * would hand that credential to everything else on the machine.
 */
export function providerSecretFile(
  providerState: HarnessProviderState,
  fileName: string,
  options: ProviderSecretFileOptions,
): ProviderSecretFile {
  const home = providerState.kind === "isolated" ? providerState.providerHomeDirectory : undefined;
  if (!home) {
    throw new Error(`Storing ${options.description} requires an isolated profile provider home`);
  }
  const path = join(resolve(home), fileName);
  return {
    path,
    read: async () => {
      const stored = await readPrivateFileText(path, options.maximumBytes, {
        exposed: () =>
          new OpensteerError({
            code: "harness_error",
            message: `The stored ${options.description} is readable by other accounts on this computer`,
          }),
        invalid: () =>
          new OpensteerError({
            code: "harness_error",
            message: `The stored ${options.description} could not be read`,
          }),
      });
      // A pasted secret often carries a trailing newline, which the provider
      // would otherwise reject with an opaque authentication error.
      const trimmed = stored?.trim();
      return trimmed ? trimmed : undefined;
    },
    remove: async () => {
      await rm(path, { force: true });
    },
    write: async (secret) => {
      await replacePrivateFileAtomically(path, secret.trim());
    },
  };
}
