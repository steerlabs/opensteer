import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  opensteerRuntimeCtor: vi.fn(function MockOpensteerRuntime(this: object) {
    return this;
  }),
}));

vi.mock("../../packages/opensteer/src/sdk/runtime.js", () => ({
  OpensteerRuntime: state.opensteerRuntimeCtor,
}));

import { createOpensteerSemanticRuntime } from "../../packages/opensteer/src/sdk/runtime-resolution.js";

describe("runtime resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  test("passes explicit environment into the local runtime", () => {
    createOpensteerSemanticRuntime({
      runtimeOptions: {
        rootDir: "/tmp/opensteer",
        workspace: "docs",
        launch: {
          headless: false,
        },
      },
      environment: {
        OPENSTEER_EXECUTABLE_PATH: "/env/chromium",
      },
    });

    expect(state.opensteerRuntimeCtor).toHaveBeenCalledWith({
      rootDir: "/tmp/opensteer",
      workspace: "docs",
      launch: {
        headless: false,
      },
      engineName: "playwright",
      environment: {
        OPENSTEER_EXECUTABLE_PATH: "/env/chromium",
      },
    });
  });

  test("falls back to process env when no explicit environment is provided", () => {
    vi.stubEnv("OPENSTEER_EXECUTABLE_PATH", "/process/chromium");

    createOpensteerSemanticRuntime({
      runtimeOptions: {
        rootDir: "/tmp/opensteer",
      },
    });

    expect(state.opensteerRuntimeCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/tmp/opensteer",
        engineName: "playwright",
        environment: expect.objectContaining({
          OPENSTEER_EXECUTABLE_PATH: "/process/chromium",
        }),
      }),
    );
  });
});
