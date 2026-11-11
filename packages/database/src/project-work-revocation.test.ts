import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { ProjectWorkStopStore } from "./run-finalization.js";
import {
  ProjectWorkRevocationStore,
  projectRevocationRootPredicate,
} from "./project-work-revocation.js";

describe("unsupported whole-Project revocation", () => {
  it("refuses a Project root before any person selector or database access", async () => {
    let queries = 0;
    const transaction = new Proxy({} as Transaction<DatabaseSchema>, {
      get() {
        queries++;
        throw new Error("A Project root reached a person selector");
      },
    });
    const roots = [{ kind: "project" as const, workspaceId: createId("workspace") }];
    const store = new ProjectWorkRevocationStore({
      requests: {
        discover: async () => {
          throw new Error("Request person selectors are not Project selectors");
        },
        cancel: async () => {
          throw new Error("Request person selectors are not Project selectors");
        },
      },
      work: new ProjectWorkStopStore(() => undefined),
    });
    await expect(store.discover(transaction, roots)).rejects.toMatchObject({
      code: "workspace_unavailable",
      reason: "team-not-implemented",
    });
    expect(() => projectRevocationRootPredicate(roots, "runs")).toThrow(
      "Whole-Project work cancellation is not implemented",
    );
    expect(queries).toBe(0);
  });
});
