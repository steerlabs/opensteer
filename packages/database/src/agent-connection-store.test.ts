import { createId } from "@opensteer/core";
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import type { DatabaseSchema } from "./schema.js";

function fixture(owned: boolean) {
  const id = "mcn_test";
  const query = {
    set: () => query,
    where: () => query,
    returning: () => query,
    execute: async () => [],
    executeTakeFirst: async () => (owned ? { id } : undefined),
  };
  const store = new AgentConnectionStore({
    updateTable: () => query,
  } as unknown as Kysely<DatabaseSchema>);
  const listener = vi.fn();
  store.onRevoked(listener);
  return { store, listener, id };
}

describe("connection revocation notices", () => {
  it("leaves another owner's in-flight waits alone when no record was revoked", async () => {
    const f = fixture(false);
    await f.store.revoke(createId("user"), f.id);
    expect(f.listener).not.toHaveBeenCalled();
  });
  it("announces a committed revocation to pending waits", async () => {
    const f = fixture(true);
    await f.store.revoke(createId("user"), f.id);
    expect(f.listener).toHaveBeenCalledExactlyOnceWith(f.id);
  });
});
