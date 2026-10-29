import { access } from "node:fs/promises";
import {
  harnessExecutableEnvironmentVariable,
  harnessKindRecord,
  harnessKinds,
  shippedHarnessKinds,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { consumeRunnerApplicationConfig, parseAgentExecutionConfig } from "./app-config.js";

describe("Runner application configuration", () => {
  it("defaults to existing packaged harness executables", async () => {
    const { harnessExecutables } = parseAgentExecutionConfig({});
    for (const kind of shippedHarnessKinds) {
      await expect(access(harnessExecutables[kind])).resolves.toBeUndefined();
    }
  });

  it("accepts absolute harness executable paths from the environment", () => {
    const named = Object.fromEntries(
      harnessKinds.map((kind) => [
        harnessExecutableEnvironmentVariable(kind),
        `/opt/opensteer/bin/${kind}`,
      ]),
    );

    expect(parseAgentExecutionConfig(named).harnessExecutables).toEqual(
      harnessKindRecord((kind) => `/opt/opensteer/bin/${kind}`),
    );
    for (const kind of harnessKinds) {
      const variable = harnessExecutableEnvironmentVariable(kind);
      expect(() => parseAgentExecutionConfig({ [variable]: kind })).toThrow(
        new RegExp(`${variable} must be an absolute path`, "u"),
      );
    }
  });

  it("scrubs legacy provider variables before any child can inherit them", () => {
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_NATIVE_MODEL: "provider-model",
      OPENSTEER_NATIVE_MODEL_API_KEY: "provider-secret-key",
      OPENSTEER_NATIVE_MODEL_API_KEY_FILE: "/run/secrets/provider-key",
      OPENSTEER_NATIVE_MODEL_BASE_URL: "https://models.example/v1",
      SAFE_CHILD_VALUE: "retained",
    };

    consumeRunnerApplicationConfig(environment);

    expect(environment).not.toHaveProperty("OPENSTEER_NATIVE_MODEL");
    expect(environment).not.toHaveProperty("OPENSTEER_NATIVE_MODEL_BASE_URL");
    expect(environment).not.toHaveProperty("OPENSTEER_NATIVE_MODEL_API_KEY");
    expect(environment).not.toHaveProperty("OPENSTEER_NATIVE_MODEL_API_KEY_FILE");
    expect(environment.SAFE_CHILD_VALUE).toBe("retained");
  });

  it("scrubs legacy provider variables even when configuration parsing fails", () => {
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_NATIVE_MODEL_API_KEY: "provider-secret-key",
      OPENSTEER_NATIVE_MODEL_API_KEY_FILE: "/run/secrets/provider-key",
    };

    environment.OPENSTEER_NATIVE_FS_HELPER = "relative-path";
    expect(() => consumeRunnerApplicationConfig(environment)).toThrow();
    expect(environment).not.toHaveProperty("OPENSTEER_NATIVE_MODEL_API_KEY");
    expect(environment).not.toHaveProperty("OPENSTEER_NATIVE_MODEL_API_KEY_FILE");
  });
});
