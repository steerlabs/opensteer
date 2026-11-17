import { generateKeyPairSync, sign } from "node:crypto";
import * as frozen from "@opensteer/browser-source-wire/frozen";
import { DeploymentIdSchema, HostInstanceIdSchema, UserIdSchema } from "@opensteer/core";
import type { HostApiServerContext } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import type { BrowserSourceService } from "../browser/browser-source-service.js";
import { signHostDiscovery, signPersonalHostAccessRoute } from "../identity/host-keys.js";
import { handleBrowserSourceCommand } from "./browser-source-registration.js";

/**
 * Shipped wire-4 extensions read these with `@opensteer/browser-source-wire/frozen`.
 * The shapes and signing bytes alone are proven in deployment-authority; this
 * proves what this Host actually signs and puts in an invitation.
 */
describe("what the Host signs for a Chrome connection", () => {
  it("parses and verifies under the frozen copies a wire-4 extension uses", async () => {
    const keys = generateKeyPairSync("ed25519");
    const canonicalOrigin = "http://127.0.0.1:4310";
    const authorityDocument = {
      canonicalOrigin,
      deploymentId: DeploymentIdSchema.parse("dep_66666666-6666-4666-8666-666666666666"),
      hostInstanceId: HostInstanceIdSchema.parse("hst_77777777-7777-4777-8777-777777777777"),
      hostKey: { algorithm: "Ed25519" as const },
      deploymentShape: { kind: "personal" as const },
    };
    const authority = signHostDiscovery(keys, authorityDocument);
    const route = signPersonalHostAccessRoute(keys, {
      authority: authorityDocument,
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: { generation: 3, kind: "connect", origin: "https://connect-frozen.opensteer.test" },
    });
    const output = await handleBrowserSourceCommand(
      {
        authority,
        canonicalOrigin,
        currentRoute: async () => route,
        deploymentName: async () => "Tim's Mac",
        passwords: {} as never,
        personal: true,
        revalidateSession: async () => {},
        service: {
          createPairing: async () => ({
            code: "c".repeat(43),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          }),
        } as Pick<BrowserSourceService, "createPairing"> as BrowserSourceService,
        signInvitation: (bytes) => sign(null, bytes, keys.privateKey).toString("base64url"),
      },
      { idempotencyKey: "pair", type: "browser.source.pair" },
      {
        session: { user: { id: UserIdSchema.parse("usr_55555555-5555-4555-8555-555555555555") } },
      } as unknown as HostApiServerContext,
    );
    if (output.type !== "browser.source.pair") throw new Error("Expected a pairing");

    expect(frozen.verifyHostDiscoveryEnvelope(authority)).toEqual(authority.document);
    expect(frozen.verifyPersonalHostAccessRouteEnvelope(route)).toEqual(route);
    expect(frozen.decodeBrowserSourceInvitation(output.pairing.invitation)).toMatchObject({
      authority,
      destinations: [
        { origin: canonicalOrigin, route: null },
        { origin: route.document.route.origin, route },
      ],
      version: 2,
    });
  });
});
