import { createId, OpensteerError } from "@opensteer/core";
import { authorizeTarget, executionAccess } from "@opensteer/database";
import { describe, expect, it, vi } from "vitest";
import { BrowserService } from "./browser-service.js";

describe("BrowserService.hasBrowserProfiles lineage admission (Y5 / Z9)", () => {
  it("decides browser availability via resolveResourceAccess/authorizeTarget and matches Run parity across task modes", async () => {
    const ownerId = createId("user");
    const profileA = createId("browserProfile");
    const profileB = createId("browserProfile");
    const otherProfile = createId("browserProfile");

    const makeService = (
      execution: Parameters<typeof authorizeTarget>[0] & {
        readonly mode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
        readonly subject: { readonly kind: "binding"; readonly bindingId: string };
      },
    ) => {
      const resolveResourceAccess = vi.fn(async (input: { readonly grantTarget?: unknown }) => {
        // Z9: BrowserService must pass grantTarget into resolveResourceAccess (Rule 1).
        expect(input.grantTarget).toEqual({
          kind: "browser-profile",
          profileId: expect.any(String),
        });
        const grantAccess = authorizeTarget(
          execution,
          input.grantTarget as Parameters<typeof authorizeTarget>[1],
        );
        if (grantAccess === null) {
          throw new OpensteerError({ code: "not_found", message: "That item is unavailable." });
        }
        const runAccess = executionAccess(execution, "read");
        return {
          access: runAccess ? grantAccess : null,
          execution,
          grantAccess,
          runAccess,
        };
      });
      const service = new BrowserService({
        repository: {
          listBrowserProfiles: vi.fn(async () => [
            { archivedAt: null, id: profileA },
            { archivedAt: null, id: profileB },
          ]),
          resolveResourceAccess,
        },
      } as never);
      return { resolveResourceAccess, service };
    };

    // Selected grant with NO browser profiles -> false.
    const noBrowser = makeService({
      actor: "agent",
      agentConnection: {
        accessMode: "full-access",
        agentConnectionId: "acn_1",
        consentVersion: 2,
        grant: { resources: [], scope: "selected", tasks: true },
        grantRevision: 1,
      },
      mode: "full-access",
      subject: { bindingId: "trigger:toc_no_browser", kind: "binding" },
    });
    await expect(
      noBrowser.service.hasBrowserProfiles(ownerId, "trigger:toc_no_browser"),
    ).resolves.toBe(false);

    // Selected grant with a DIFFERENT browser profile -> false.
    const wrongProfile = makeService({
      actor: "agent",
      agentConnection: {
        accessMode: "full-access",
        agentConnectionId: "acn_2",
        consentVersion: 2,
        grant: {
          resources: [{ kind: "browser-profile", profileId: otherProfile }],
          scope: "selected",
          tasks: true,
        },
        grantRevision: 1,
      },
      mode: "full-access",
      subject: { bindingId: "trigger:toc_wrong_profile", kind: "binding" },
    });
    await expect(
      wrongProfile.service.hasBrowserProfiles(ownerId, "trigger:toc_wrong_profile"),
    ).resolves.toBe(false);

    // Selected grant holding the SECOND browser profile -> true (skips not_found on profileA).
    const allowedSecond = makeService({
      actor: "agent",
      agentConnection: {
        accessMode: "full-access",
        agentConnectionId: "acn_3",
        consentVersion: 2,
        grant: {
          resources: [{ kind: "browser-profile", profileId: profileB }],
          scope: "selected",
          tasks: true,
        },
        grantRevision: 1,
      },
      mode: "full-access",
      subject: { bindingId: "trigger:toc_allowed", kind: "binding" },
    });
    await expect(
      allowedSecond.service.hasBrowserProfiles(ownerId, "trigger:toc_allowed"),
    ).resolves.toBe(true);

    // Personal lineage in ALL task modes (including approval-required and auto-accept-edits)
    // gets browser address parity with a Run of the same task (Z9 / T5).
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"] as const) {
      const personal = makeService({
        actor: "native",
        agentConnection: null,
        mode,
        subject: { bindingId: `trigger:toc_personal_${mode}`, kind: "binding" },
      });
      await expect(
        personal.service.hasBrowserProfiles(ownerId, `trigger:toc_personal_${mode}`),
        `personal mode=${mode}`,
      ).resolves.toBe(true);
    }

    // Connected agent with everything grant in approval-required -> true (Run parity).
    const everythingLowerMode = makeService({
      actor: "agent",
      agentConnection: {
        accessMode: "approval-required",
        agentConnectionId: "acn_4",
        consentVersion: 2,
        grant: { scope: "everything" },
        grantRevision: 1,
      },
      mode: "approval-required",
      subject: { bindingId: "trigger:toc_everything_approval", kind: "binding" },
    });
    await expect(
      everythingLowerMode.service.hasBrowserProfiles(ownerId, "trigger:toc_everything_approval"),
    ).resolves.toBe(true);
  });

  it("fails closed when agentBindingId is given without a resolveResourceAccess authority check (AA14.1)", async () => {
    const ownerId = createId("user");
    const service = new BrowserService({
      repository: {
        listBrowserProfiles: vi.fn(async () => [
          { archivedAt: null, id: createId("browserProfile") },
        ]),
      },
    } as never);
    await expect(service.hasBrowserProfiles(ownerId, "trigger:toc_no_resolver")).resolves.toBe(
      false,
    );
  });
});
