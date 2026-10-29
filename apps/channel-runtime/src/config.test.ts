import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseChannelRuntimeConfig } from "./config.js";

describe("messaging Runner configuration", () => {
  it("takes its enrollment token from the descriptor the desktop names", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "opensteer-messaging-"));
    const file = path.join(directory, "secrets");
    writeFileSync(file, JSON.stringify({ OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "m".repeat(64) }));
    const descriptor = openSync(file, "r");
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_MESSAGING_HOST_URL: "http://127.0.0.1:4310",
      OPENSTEER_SECRETS_FD: String(descriptor),
    };
    try {
      expect(parseChannelRuntimeConfig(environment).enrollmentToken).toBe("m".repeat(64));
      expect(environment).toEqual({ OPENSTEER_MESSAGING_HOST_URL: "http://127.0.0.1:4310" });
    } finally {
      closeSync(descriptor);
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a placeholder enrollment credential", () => {
    expect(() =>
      parseChannelRuntimeConfig({
        OPENSTEER_MESSAGING_HOST_URL: "http://127.0.0.1:4310",
        OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "replace-with-a-one-use-runner-enrollment-token",
      }),
    ).toThrow(/one-use deployment credential/);
  });
});
