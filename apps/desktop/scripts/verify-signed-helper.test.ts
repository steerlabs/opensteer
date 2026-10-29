import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const directory = mkdtempSync(path.join(tmpdir(), "opensteer-proof-input-"));
writeFileSync(path.join(directory, "relative.keychain-db"), "fixture");
afterAll(() => rmSync(directory, { recursive: true, force: true }));
it.each(["", "relative.keychain-db", path.join(directory, "missing.keychain-db")])(
  "rejects invalid proof keychain %j before invoking a command",
  (keychain) => {
    const input = path.join(directory, "signing.json");
    writeFileSync(input, JSON.stringify({ teamId: "ABCDE12345", identity: "Example", keychain }));
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import runpy,subprocess,sys
sys.argv=[sys.argv[1],sys.argv[2],"/unused/helper",sys.argv[2]+".evidence"]
def forbidden(*args,**kwargs):
    raise AssertionError("EXTERNAL_COMMAND_BEFORE_VALIDATION")
subprocess.run=forbidden
runpy.run_path(sys.argv[0],run_name="__main__")
`,
        path.join(import.meta.dirname, "verify-signed-helper.py"),
        input,
      ],
      { encoding: "utf8", cwd: directory },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "keychain must be an absolute path to an existing .keychain-db file",
    );
    expect(result.stderr).not.toContain("EXTERNAL_COMMAND_BEFORE_VALIDATION");
  },
);
