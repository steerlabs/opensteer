import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDesktopLog } from "./desktop-log.js";

afterEach(() => vi.restoreAllMocks());

describe("the desktop log", () => {
  it("holds what the app ignored from its environment, from the moment it opens", () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const data = mkdtempSync(path.join(tmpdir(), "desktop-log-"));
    const log = openDesktopLog(data, [
      {
        name: "NODE_EXTRA_CA_CERTS",
        reason: "a released app takes no certificate authority from its environment",
      },
    ]);
    log.close();
    const written = readFileSync(path.join(data, "logs", "desktop.log"), "utf8");
    expect(written).toContain('"event":"desktop.environment.ignored"');
    expect(written).toContain('"name":"NODE_EXTRA_CA_CERTS"');
    expect(written).toContain("a released app takes no certificate authority");
  });
});
