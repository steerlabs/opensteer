import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { BrowserService } from "./browser-service.js";

describe("BrowserService.hasBrowserProfiles lineage admission (Y5)", () => {
  it("denies a connected agent whose selected grant holds no browser profile, and admits one that does", async () => {
    const ownerId = createId("user");
    const profileId = createId("browserProfile");
    const otherProfileId = createId("browserProfile");
    const resolveResourceAccess = vi.fn();
    const service = new BrowserService({
      repository: {
        listBrowserProfiles: vi.fn(async () => [{ id: profileId, archivedAt: null }]),
        resolveResourceAccess,
      },
    } as never);

    // Selected grant with NO browser profiles -> false (even though owner has a profile).
    resolveResourceAccess.mockResolvedValueOnce({
      execution: {
        agentConnection: {
          agentConnectionId: "acn_1",
          grant: {
            resources: [{ access: "read-write", kind: "task", threadId: createId("thread") }],
            scope: "selected",
          },
          grantRevision: 1,
        },
        mode: "full-access",
        subject: { bindingId: "trigger:toc_no_browser", kind: "binding" },
        threadId: createId("thread"),
      },
    });
    await expect(service.hasBrowserProfiles(ownerId, "trigger:toc_no_browser")).resolves.toBe(
      false,
    );

    // Selected grant with a DIFFERENT browser profile -> false.
    resolveResourceAccess.mockResolvedValueOnce({
      execution: {
        agentConnection: {
          agentConnectionId: "acn_2",
          grant: {
            resources: [
              { access: "read-write", kind: "browser-profile", profileId: otherProfileId },
            ],
            scope: "selected",
          },
          grantRevision: 1,
        },
        mode: "full-access",
        subject: { bindingId: "trigger:toc_wrong_profile", kind: "binding" },
        threadId: createId("thread"),
      },
    });
    await expect(service.hasBrowserProfiles(ownerId, "trigger:toc_wrong_profile")).resolves.toBe(
      false,
    );

    // Selected grant holding the owner's browser profile -> true.
    resolveResourceAccess.mockResolvedValueOnce({
      execution: {
        agentConnection: {
          agentConnectionId: "acn_3",
          grant: {
            resources: [{ access: "read-write", kind: "browser-profile", profileId }],
            scope: "selected",
          },
          grantRevision: 1,
        },
        mode: "full-access",
        subject: { bindingId: "trigger:toc_allowed", kind: "binding" },
        threadId: createId("thread"),
      },
    });
    await expect(service.hasBrowserProfiles(ownerId, "trigger:toc_allowed")).resolves.toBe(true);

    // Personal lineage (no agentConnection) with full-access -> true.
    resolveResourceAccess.mockResolvedValueOnce({
      execution: {
        agentConnection: null,
        mode: "full-access",
        subject: { bindingId: "trigger:toc_personal", kind: "binding" },
        threadId: createId("thread"),
      },
    });
    await expect(service.hasBrowserProfiles(ownerId, "trigger:toc_personal")).resolves.toBe(true);
  });
});
