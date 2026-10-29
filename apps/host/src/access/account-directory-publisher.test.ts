import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { AccountDirectoryStore } from "@opensteer/database";
import { AccountDirectoryPublisher } from "./account-directory-publisher.js";

describe("AccountDirectoryPublisher", () => {
  it("keeps a failed generation pending with bounded redacted diagnostics", async () => {
    const projection = {
      accountId: "account-subject",
      attempts: 4,
      generation: 2,
      leaseToken: "b".repeat(43),
      observedAt: "2026-08-11T19:00:00.000Z",
      present: false,
      providerId: "oidc:opensteer-account",
      userId: createId("user"),
    } as const;
    const fail = vi.fn(async (_input: Parameters<AccountDirectoryStore["fail"]>[0]) => true);
    const onError = vi.fn();
    const publisher = new AccountDirectoryPublisher({
      onError,
      publish: async () => {
        throw new Error("upstream rejected Bearer secret-token");
      },
      store: {
        claimPending: async () => [projection],
        complete: vi.fn(async () => true),
        fail,
      },
    });

    await expect(publisher.publishOnce()).resolves.toBe(1);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ error: "upstream rejected Bearer [redacted]" }),
    );
    const failed = fail.mock.calls[0]?.[0];
    if (!failed) throw new Error("Publisher did not record the failed attempt");
    expect(failed.nextAttemptAt.getTime() - Date.now()).toBeGreaterThanOrEqual(7_500);
    expect(failed.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(8_500);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "upstream rejected Bearer [redacted]" }),
    );
    expect(JSON.stringify(onError.mock.calls)).not.toContain("secret-token");
  });
});
