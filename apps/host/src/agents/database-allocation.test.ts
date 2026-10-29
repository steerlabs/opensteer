import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessRegistry, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { createHostRuntime } from "../runtime/runtime.js";
import { startVerticalStack } from "./vertical-stack.test-support.js";

// Failure cases: failed CREATE runs service cleanup before a service exists;
// cleanup waits for startup which is waiting for that cleanup; the original
// PostgreSQL error is replaced by a deadline/retirement error; an admin pool leaks.
const fake = vi.hoisted(() => ({
  error: Object.assign(new Error("injected CREATE DATABASE permission error"), { code: "42501" }),
  query: vi.fn(),
  end: vi.fn(),
  drop: vi.fn(),
}));
vi.mock(
  "../../../../packages/database/src/test-database-admin.test-support.js",
  async (original) => ({
    ...(await original<Record<string, unknown>>()),
    databaseAdministrator: () => ({ query: fake.query, end: fake.end }),
    dropOwnedDatabase: fake.drop,
    recordOwnedDatabase: () => undefined,
  }),
);
vi.mock("../runtime/runtime.js", () => ({
  createHostRuntime: vi.fn(() => {
    throw new Error("Service startup ran before allocation");
  }),
}));

describe("database allocation failure", () => {
  beforeEach(() => {
    fake.query.mockReset().mockRejectedValue(fake.error);
    fake.end.mockReset().mockResolvedValue(undefined);
    fake.drop.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.stubEnv(
      "OPENSTEER_TEST_DATABASE_TEMPLATES",
      JSON.stringify({
        run: "0123456789abcdef",
        directory: tmpdir(),
        host: "postgres://fixture@127.0.0.1:1/opensteer_it_0123456789abcdef_host_template",
        controlPlane:
          "postgres://fixture@127.0.0.1:1/opensteer_it_0123456789abcdef_control_template",
      }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("never calls a service stopper when CREATE failed", async () => {
    const stopProducers = vi.fn(async () => undefined);
    await expect(cloneTestDatabase("host", { stopProducers })).rejects.toBe(fake.error);
    expect(stopProducers).not.toHaveBeenCalled();
    expect(fake.drop).toHaveBeenCalledOnce();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it("propagates the original error without waiting for service startup", async () => {
    await expect(
      startVerticalStack({
        databaseUrl: "postgres://fixture@127.0.0.1:1/worker",
        cleanupTimeoutMs: 10,
        catalogTimeoutMs: 100,
        runTimeoutMs: 100,
        harnesses: new HarnessRegistry(),
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
      }),
    ).rejects.toBe(fake.error);
    expect(createHostRuntime).not.toHaveBeenCalled();
    expect(fake.end).toHaveBeenCalledOnce();
  });
});
