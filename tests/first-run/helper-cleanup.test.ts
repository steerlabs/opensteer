import { describe, expect, it } from "vitest";
import { helperProcessIds } from "./helper-cleanup.js";

describe("the helpers the first-run journey ends", () => {
  const executable =
    "/Users/admin/Library/Application Support/Opensteer/Computer Use/Opensteer Computer Use.app/Contents/MacOS/Opensteer Computer Use";

  it("are the processes running exactly the canonical helper, by id", () => {
    const ps = [
      `  3246 ${executable}`,
      `  3300 ${executable} --some-flag`,
      "  3301 /Applications/Opensteer.app/Contents/MacOS/Opensteer",
      // Another copy of the helper elsewhere, and a process that only names it, are not it.
      "  3302 /tmp/profile/Opensteer Computer Use.app/Contents/MacOS/Opensteer Computer Use",
      `  3303 /usr/bin/grep ${executable}`,
    ].join("\n");
    expect(helperProcessIds(ps, executable)).toEqual([3246, 3300]);
  });
});
