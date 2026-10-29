import { OpensteerError } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { describe, expect, it, vi } from "vitest";
import { LocalBootstrapService } from "./local-bootstrap.js";
import type { RunnerAuthenticator } from "../agents/runner-authenticator.js";

function service(options: {
  readonly hasAdministrator: boolean;
  readonly hasMainRunner: boolean;
  readonly mainRunnerState?: "absent" | "active" | "revoked";
  readonly createInitialMainEnrollment?: RunnerAuthenticator["createInitialMainEnrollment"];
  readonly requireSetupCredential?: boolean;
  readonly setupToken?: string;
}) {
  const createInitialMainEnrollment =
    options.createInitialMainEnrollment ??
    vi.fn(async () => ({
      enrollmentId: "ren_main-runner",
      expiresAt: new Date().toISOString(),
      token: "main-runner-token",
    }));
  // The Main Runner's enrollment is the only one this route may mint. Any
  // other authenticator call is a computer the caller may never start.
  const runners = new Proxy(
    { createInitialMainEnrollment },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        throw new Error(`Local bootstrap must not use RunnerAuthenticator.${String(property)}`);
      },
    },
  ) as unknown as RunnerAuthenticator;
  const upgradeLegacyPersonalMainRunnerBrowserGrant = vi.fn(async () => false);
  const store = {
    deploymentMainRunnerState: async () =>
      options.mainRunnerState ?? (options.hasMainRunner ? "active" : "absent"),
    hasInstanceAdministrator: async () => options.hasAdministrator,
    upgradeLegacyPersonalMainRunnerBrowserGrant,
  } as unknown as OpensteerStore;
  return {
    createInitialMainEnrollment,
    upgradeLegacyPersonalMainRunnerBrowserGrant,
    bootstrap: new LocalBootstrapService({
      publicUrl: new URL("http://localhost:43100"),
      requireSetupCredential: options.requireSetupCredential ?? false,
      runners,
      setupToken: options.setupToken ?? "setup-token-with-enough-entropy",
      store,
    }),
  };
}

describe("local bootstrap", () => {
  it("carries the first-owner code in the fragment so it never reaches a request line", async () => {
    const { bootstrap } = service({ hasAdministrator: false, hasMainRunner: false });
    const { setupUrl } = await bootstrap.describe();
    expect(setupUrl).toBe("http://localhost:43100/setup#token=setup-token-with-enough-entropy");
    const url = new URL(setupUrl!);
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe(
      "setup-token-with-enough-entropy",
    );
  });

  it.each([false, true])(
    "offers setup exactly until an administrator exists with credential requirement %s",
    async (requireSetupCredential) => {
      const setupToken = "owner-claim-token".padEnd(32, "x");
      const authorization = requireSetupCredential ? `Bearer ${setupToken}` : undefined;
      const unclaimed = service({
        hasAdministrator: false,
        hasMainRunner: false,
        requireSetupCredential,
        setupToken,
      }).bootstrap;
      const claimed = service({
        hasAdministrator: true,
        hasMainRunner: false,
        requireSetupCredential,
        setupToken,
      }).bootstrap;

      await expect(unclaimed.describe(authorization)).resolves.toMatchObject({
        setupUrl: expect.any(String),
      });
      await expect(claimed.describe(authorization)).resolves.toMatchObject({ setupUrl: null });
    },
  );

  it("does not expose Personal bootstrap material without the Desktop capability", async () => {
    const token = "owner-claim-token".padEnd(32, "x");
    const { bootstrap } = service({
      hasAdministrator: false,
      hasMainRunner: false,
      requireSetupCredential: true,
      setupToken: token,
    });
    await expect(bootstrap.describe()).rejects.toMatchObject({ code: "not_found" });
    await expect(bootstrap.describe(token)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      bootstrap.describe(`Bearer ${"wrong-token".padEnd(32, "x")}`),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(bootstrap.describe(`Bearer ${token}`)).resolves.toMatchObject({
      setupUrl: expect.any(String),
    });
  });

  it("repairs the legacy Personal Main browser grant after authenticating Desktop", async () => {
    const token = "owner-claim-token".padEnd(32, "x");
    const { bootstrap, upgradeLegacyPersonalMainRunnerBrowserGrant } = service({
      hasAdministrator: true,
      hasMainRunner: true,
      requireSetupCredential: true,
      setupToken: token,
    });

    await bootstrap.describe(`Bearer ${token}`);
    expect(upgradeLegacyPersonalMainRunnerBrowserGrant).toHaveBeenCalledOnce();
  });

  it("reuses one idempotency key so a restarted supervisor cannot stack enrollments", async () => {
    const { bootstrap, createInitialMainEnrollment } = service({
      hasAdministrator: false,
      hasMainRunner: false,
    });
    await bootstrap.describe();
    await bootstrap.describe();
    const calls = (createInitialMainEnrollment as ReturnType<typeof vi.fn>).mock.calls;
    const keys = new Set(
      calls.map((call) => (call[0] as { readonly idempotencyKey: string }).idempotencyKey),
    );
    expect(calls).toHaveLength(2);
    expect(keys.size).toBe(1);
  });

  it("replays the identity-bound token after a Main Runner exists", async () => {
    const { bootstrap, createInitialMainEnrollment } = service({
      hasAdministrator: true,
      hasMainRunner: true,
    });
    await expect(bootstrap.describe()).resolves.toEqual({
      runnerEnrollmentToken: "main-runner-token",
      setupUrl: null,
    });
    expect(createInitialMainEnrollment).toHaveBeenCalledOnce();
  });

  it("does not replay a token for a revoked Main Runner", async () => {
    const { bootstrap, createInitialMainEnrollment } = service({
      hasAdministrator: true,
      hasMainRunner: true,
      mainRunnerState: "revoked",
    });
    await expect(bootstrap.describe()).resolves.toMatchObject({ runnerEnrollmentToken: null });
    expect(createInitialMainEnrollment).not.toHaveBeenCalled();
  });

  it("reports no token rather than failing when replacement needs an operator", async () => {
    // A revoked Main Runner must be replaced deliberately, so the Host declines
    // to mint one for itself without taking the rest of the response down.
    const { bootstrap } = service({
      hasAdministrator: false,
      hasMainRunner: false,
      createInitialMainEnrollment: (async () => {
        throw new OpensteerError({ code: "conflict", message: "Initial Main is unavailable" });
      }) as unknown as RunnerAuthenticator["createInitialMainEnrollment"],
    });
    await expect(bootstrap.describe()).resolves.toMatchObject({ runnerEnrollmentToken: null });
  });

  it("propagates unexpected failures instead of reporting a healthy bootstrap", async () => {
    const { bootstrap } = service({
      hasAdministrator: false,
      hasMainRunner: false,
      createInitialMainEnrollment: (async () => {
        throw new Error("database is unavailable");
      }) as unknown as RunnerAuthenticator["createInitialMainEnrollment"],
    });
    await expect(bootstrap.describe()).rejects.toThrow(/database is unavailable/);
  });
});
