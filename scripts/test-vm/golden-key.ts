import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** `<type> <base64>` of an OpenSSH public key line, without its comment. */
const keyOf = (line: string) => line.trim().split(/\s+/u).slice(0, 2).join(" ");

/**
 * Authorizes the guest key a GUI golden build installs. One key opens every
 * golden (the mobile golden inherits the GUI golden's), so an existing pair is
 * reused, never replaced, after checking its halves match. Half a pair is
 * refused rather than completed, and only a missing pair is generated.
 */
export async function authorizeGoldenKey(options: {
  readonly key: string;
  /** Where the guest's `authorized_keys` is staged. */
  readonly authorizedKeys: string;
  /** Writes a new pair at `key` and `key.pub`. */
  readonly generate: () => Promise<unknown>;
  /** The public key `key` itself derives (`ssh-keygen -y -f key`). */
  readonly derivePublic: () => Promise<string>;
}): Promise<"generated" | "reused"> {
  const publicKey = `${options.key}.pub`;
  const halves = [existsSync(options.key), existsSync(publicKey)];
  if (halves[0] !== halves[1]) {
    const [present, missing] = halves[0] ? [options.key, publicKey] : [publicKey, options.key];
    throw new Error(
      `${present} exists without ${missing}; restore the pair or choose another OPENSTEER_VM_SSH_KEY`,
    );
  }
  let outcome: "generated" | "reused" = "reused";
  if (halves[0]) {
    if (keyOf(await options.derivePublic()) !== keyOf(readFileSync(publicKey, "utf8")))
      throw new Error(`${publicKey} does not match ${options.key}`);
  } else {
    mkdirSync(path.dirname(options.key), { recursive: true });
    await options.generate();
    outcome = "generated";
  }
  copyFileSync(publicKey, options.authorizedKeys);
  return outcome;
}
