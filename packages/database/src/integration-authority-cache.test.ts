import { UserIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { IntegrationAuthorityCache } from "./integration-authority-cache.js";

describe("IntegrationAuthorityCache", () => {
  it("makes the previous result unreachable as soon as authority generation advances", () => {
    const cache = new IntegrationAuthorityCache<readonly string[]>();
    const scope = {
      ownerUserId: UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001"),
    };
    cache.set({ ...scope, generation: 7 }, ["callable-before-revocation"]);

    expect(cache.get({ ...scope, generation: 7 })).toEqual(["callable-before-revocation"]);
    expect(cache.get({ ...scope, generation: 8 })).toBeNull();

    cache.set({ ...scope, generation: 8 }, []);
    expect(cache.get({ ...scope, generation: 7 })).toBeNull();
    expect(cache.get({ ...scope, generation: 8 })).toEqual([]);
  });
});
