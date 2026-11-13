import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const standardUser = process.env.OPENSTEER_CI_STANDARD_USER;
const administrators = "S-1-5-32-544";
const mediumIntegrity = "S-1-16-8192";

// Hosted runners run steps as an administrator with UAC off, so the lane's evidence
// counts only if its tests really run without administrator rights. A run outside
// that lane skips this, and Check then refuses the lane's inventory.
describe.runIf(standardUser)("the native-windows lane", () => {
  it("runs as its disposable standard user with a medium-integrity token", () => {
    const whoami = join(String(process.env.SystemRoot), "System32", "whoami.exe");
    const groups = execFileSync(whoami, ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.slice(1, -1).split('","'));
    const sids = new Set(groups.map(([, , sid]) => sid));
    expect(userInfo().username).toBe(standardUser);
    expect(sids.has(administrators), "the token names Administrators").toBe(false);
    expect(sids.has(mediumIntegrity), "the token is not medium integrity").toBe(true);
  });
});
