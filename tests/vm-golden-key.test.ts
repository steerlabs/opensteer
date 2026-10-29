import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeGoldenKey } from "../scripts/test-vm/golden-key.js";

/*
 * Ways a golden build could split or lose the guest key every golden shares:
 * - it generates a new key over an existing pair, so goldens built earlier
 *   (the mobile golden copied from another Mac) no longer open with it;
 * - it refuses an existing pair, so a second machine needs a key per golden;
 * - it reuses half a pair, or a pair whose halves do not match, and the build
 *   finishes with a guest no job can reach;
 * - with no key, it builds without generating one.
 */

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-golden-key-"));
  directories.push(directory);
  const key = path.join(directory, "vm-golden/id_ed25519");
  const authorizedKeys = path.join(directory, "authorized_keys");
  let generated = 0;
  const keygen = (file: string) =>
    exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
  const options = {
    key,
    authorizedKeys,
    generate: async () => {
      generated++;
      await mkdir(path.dirname(key), { recursive: true });
      await keygen(key);
    },
    derivePublic: async () => (await exec("ssh-keygen", ["-y", "-f", key])).stdout,
  };
  return { directory, key, authorizedKeys, keygen, options, generated: () => generated };
}

describe("the GUI golden's guest key", () => {
  it("generates a pair when there is none, and authorizes it", async () => {
    const s = await setup();
    expect(await authorizeGoldenKey(s.options)).toBe("generated");
    expect(s.generated()).toBe(1);
    expect(await readFile(s.authorizedKeys, "utf8")).toBe(await readFile(`${s.key}.pub`, "utf8"));
  });

  it("reuses an existing pair unchanged and authorizes it", async () => {
    const s = await setup();
    await s.options.generate();
    const before = await readFile(s.key, "utf8");
    expect(await authorizeGoldenKey(s.options)).toBe("reused");
    expect(s.generated()).toBe(1);
    expect(await readFile(s.key, "utf8")).toBe(before);
    expect(await readFile(s.authorizedKeys, "utf8")).toBe(await readFile(`${s.key}.pub`, "utf8"));
  });

  it("refuses a lone private key, a lone public key and a mismatched pair", async () => {
    for (const keep of ["private", "public"] as const) {
      const s = await setup();
      await s.options.generate();
      const lone = keep === "private" ? s.key : `${s.key}.pub`;
      await rm(keep === "private" ? `${s.key}.pub` : s.key);
      const before = await readFile(lone, "utf8");
      await expect(authorizeGoldenKey(s.options)).rejects.toThrow(/exists without/u);
      expect(s.generated(), keep).toBe(1);
      expect(await readFile(lone, "utf8")).toBe(before);
      expect(existsSync(s.authorizedKeys)).toBe(false);
    }
    const s = await setup();
    await s.options.generate();
    const other = path.join(s.directory, "other");
    await s.keygen(other);
    await writeFile(`${s.key}.pub`, await readFile(`${other}.pub`, "utf8"));
    await expect(authorizeGoldenKey(s.options)).rejects.toThrow(/does not match/u);
    expect(existsSync(s.authorizedKeys)).toBe(false);
  });
});
