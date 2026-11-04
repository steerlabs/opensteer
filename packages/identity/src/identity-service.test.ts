import { expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "@opensteer/database";
import { IdentityService } from "./identity-service.js";

const { checkSchema } = vi.hoisted(() => ({ checkSchema: vi.fn<() => Promise<void>>() }));
vi.mock("better-auth", async (original) => ({
  ...(await original<typeof import("better-auth")>()),
  betterAuth: () => ({ $context: Promise.resolve({ checkSchema }) }),
}));

it("joins the auth schema check before initialization can destroy its database", async () => {
  const check = Promise.withResolvers<void>();
  checkSchema.mockReturnValue(check.promise);
  const identity = new IdentityService({} as unknown as Kysely<DatabaseSchema>, {
    deployment: { kind: "self-hosted", name: null },
    exposure: "networked",
    localPasswordEnabled: false,
    oidcProviders: [],
    publicOrigin: new URL("https://host.example.test"),
    secret: "s".repeat(40),
    signupPolicy: "closed",
  });
  let settled = false;
  const result = identity
    .initialize()
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
    });
  try {
    await vi.waitFor(
      () => expect(checkSchema, "Auth schema validation was never joined").toHaveBeenCalledOnce(),
      { timeout: 1000 },
    );
    expect(settled).toBe(false);
  } finally {
    check.reject(new Error("Schema validation failed"));
  }
  expect(await result).toMatchObject({ message: "Schema validation failed" });
});
