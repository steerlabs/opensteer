import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OpensteerError, type BrowserProfileId, type UserId } from "@opensteer/core";
import {
  BrowserSurfaceIdSchema,
  type BrowserAttachTicketIdentity,
  type BrowserClientMessage,
  type BrowserServerMessage,
  type BrowserSessionId,
} from "@opensteer/protocol";
import {
  BrowserProfileSnapshotSchema,
  type BrowserProfileSnapshot,
} from "@opensteer/browser-profile/snapshot";
import { z } from "zod";
import type { BrowserProfileVault } from "./profile-vault.js";
import type { BrowserSessionRepository } from "./browser-service.js";

type LegacyProfileLease = {
  leaseToken: string;
  profileId: BrowserProfileId;
  sessionId: BrowserSessionId;
};
type CdpRequest = Extract<BrowserClientMessage, { type: "cdp.command" }>;
type CdpResponse = Extract<BrowserServerMessage, { type: "cdp.result" }>;

/** Previous runtimes retain the exact snapshot endpoint, lease and initial-navigation protocol. */
export class LegacyBrowserProfileAdapter {
  readonly #repository: Pick<BrowserSessionRepository, "authorizeBrowserProfileLease">;
  readonly #vault: Pick<BrowserProfileVault, "load" | "commit">;
  readonly #baseUrl: URL;
  constructor(options: {
    repository: Pick<BrowserSessionRepository, "authorizeBrowserProfileLease">;
    vault: Pick<BrowserProfileVault, "load" | "commit">;
    baseUrl: URL;
  }) {
    this.#repository = options.repository;
    this.#vault = options.vault;
    this.#baseUrl = new URL(options.baseUrl.origin);
  }

  identity(
    profileId: BrowserProfileId,
    sessionId: BrowserSessionId,
  ): { identity: BrowserAttachTicketIdentity; tokenHash: string } {
    const bytes = randomBytes(32);
    const token = bytes.toString("base64url");
    bytes.fill(0);
    return {
      tokenHash: hash(token),
      identity: {
        kind: "profile",
        profileId,
        profileLeaseToken: token,
        profileStateUrl: new URL(
          `/v1/browser-profile-state/${profileId}/${sessionId}`,
          this.#baseUrl,
        ).toString(),
      },
    };
  }
  async load(input: LegacyProfileLease) {
    await this.#authorize(input);
    const { revision, snapshot } = await this.#vault.load(input.profileId);
    return { revision, snapshot };
  }
  async commit(
    input: LegacyProfileLease & {
      expectedRevision: number;
      periodic?: boolean;
      snapshot: BrowserProfileSnapshot;
    },
  ) {
    await this.#authorize(input);
    return this.#vault.commit({
      expectedRevision: input.expectedRevision,
      periodic: input.periodic ?? false,
      profileId: input.profileId,
      snapshot: BrowserProfileSnapshotSchema.parse(input.snapshot),
    });
  }
  async #authorize(input: LegacyProfileLease) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.leaseToken) ||
      !(await this.#repository.authorizeBrowserProfileLease({
        leaseTokenHash: hash(input.leaseToken),
        profileId: input.profileId,
        sessionId: input.sessionId,
      }))
    )
      throw new OpensteerError({ code: "forbidden", message: "Browser profile lease is invalid." });
  }
}

/** A website error still opens its existing page; only a CDP failure fails start. */
export async function navigateInitiallyLegacy(
  broker: {
    requestCdp(message: CdpRequest): Promise<CdpResponse>;
    beginHistoryNavigation(
      ownerId: UserId,
      typed: boolean,
      surfaceId?: import("@opensteer/protocol").BrowserSurfaceId,
    ): string | undefined;
    cancelHistoryNavigation(navigationId: string | undefined): void;
  },
  url: string,
  person?: { ownerId: UserId; typed: boolean },
) {
  const request = async (command: CdpRequest["command"], navigationId?: string) =>
    (
      await broker.requestCdp({
        type: "cdp.command",
        requestId: randomUUID(),
        command,
        ...(navigationId ? { navigationId } : {}),
      })
    ).result;
  const targets = z
    .object({
      targetInfos: z.array(
        z.object({
          targetId: z.string(),
          type: z.string(),
          surfaceId: BrowserSurfaceIdSchema.optional(),
        }),
      ),
    })
    .parse(await request({ method: "Target.getTargets" }));
  const target = targets.targetInfos.find((entry) => entry.type === "page");
  if (!target) throw new Error("The Browser Runtime has no page for the first navigation.");
  const attached = z.object({ sessionId: z.string() }).parse(
    await request({
      method: "Target.attachToTarget",
      parameters: { targetId: target.targetId, flatten: true },
    }),
  );
  const navigationId = person
    ? broker.beginHistoryNavigation(person.ownerId, person.typed, target.surfaceId)
    : undefined;
  try {
    const result = z
      .object({ errorText: z.string().optional() })
      .parse(
        await request(
          { method: "Page.navigate", parameters: { url }, sessionId: attached.sessionId },
          navigationId,
        ),
      );
    if (result.errorText) broker.cancelHistoryNavigation(navigationId);
  } finally {
    await request({
      method: "Target.detachFromTarget",
      parameters: { sessionId: attached.sessionId },
    });
  }
  return target.surfaceId;
}
function hash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
