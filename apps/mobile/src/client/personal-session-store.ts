import {
  DeploymentIdSchema,
  IsoDateTimeSchema,
  PersonalRemoteSessionCredentialSchema,
  personalRemoteAuthorizationScheme,
  type DeploymentId,
} from "@opensteer/core";
import type { SessionExchangeResponse } from "@opensteer/protocol";
import { z } from "zod";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import type { SecureRecordStore } from "../platform/secure-record-store.js";

/**
 * Where a phone keeps a Personal deployment's remote session.
 *
 * A browser and an Electron partition own a cookie jar the Host writes into; a
 * native client owns none, so the Host hands the credential back in the
 * exchange body and it becomes this application's to keep. That makes it a
 * secret of exactly the same weight as an OAuth refresh token, so it lives in
 * the same protected store, in its own namespace — never in the deployment
 * catalog, which is a rebuildable routing cache written in the clear.
 */
export const PersonalRemoteSessionSchema = z.strictObject({
  viewLoginId: z.uuid().optional(),
  absoluteExpiresAt: IsoDateTimeSchema,
  deploymentId: DeploymentIdSchema,
  expiresAt: IsoDateTimeSchema,
  token: PersonalRemoteSessionCredentialSchema,
});
export type PersonalRemoteSession = z.infer<typeof PersonalRemoteSessionSchema>;

export interface PersonalSessionStore {
  /**
   * The `Authorization` value this deployment presents, or null when there is
   * no session or the one held has expired. Deliberately not `Bearer`: that
   * scheme belongs to a Host's own OAuth server, and the two credential
   * families must never be readable by one parser.
   */
  authorization(deploymentId: DeploymentId, now: Date): Promise<string | null>;
  clear(deploymentId: DeploymentId): Promise<void>;
  load(deploymentId: DeploymentId): Promise<PersonalRemoteSession | null>;
  save(session: PersonalRemoteSession): Promise<void>;
  initializeViewLoginId?(deploymentId: DeploymentId, isCurrent: () => boolean): Promise<void>;
}

export function createPersonalSessionStore(
  records: SecureRecordStore,
  options: {
    readonly beforeChange?: (deploymentId: DeploymentId) => Promise<void>;
    readonly changed?: (session: PersonalRemoteSession) => void;
  } = {},
): PersonalSessionStore {
  const mutations = new MutationQueue();
  const recordName = (deploymentId: DeploymentId): string => `personal.${deploymentId}`;

  const load = async (deploymentId: DeploymentId): Promise<PersonalRemoteSession | null> => {
    const stored = await records.read(recordName(deploymentId));
    if (stored === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(stored);
    } catch {
      return null;
    }
    const parsed = PersonalRemoteSessionSchema.safeParse(decoded);
    // A record this release cannot read is a session to establish again, not a
    // fault: the pairing code that made it is one use and long gone anyway.
    if (!parsed.success || parsed.data.deploymentId !== deploymentId) return null;
    return parsed.data;
  };

  return {
    async authorization(deploymentId, now): Promise<string | null> {
      const session = await load(deploymentId);
      if (session === null) return null;
      if (Date.parse(session.expiresAt) <= now.getTime()) return null;
      return `${personalRemoteAuthorizationScheme} ${session.token}`;
    },

    clear: async (deploymentId) => {
      await options.beforeChange?.(deploymentId);
      await mutations.run(() => records.remove(recordName(deploymentId)));
    },

    load: (deploymentId) => mutations.run(() => load(deploymentId)),

    initializeViewLoginId: (deploymentId, isCurrent) =>
      mutations.run(async () => {
        const current = await load(deploymentId);
        if (!isCurrent() || current === null || current.viewLoginId) return;
        await records.write(
          recordName(deploymentId),
          JSON.stringify({ ...current, viewLoginId: globalThis.crypto.randomUUID() }),
        );
      }),

    async save(session): Promise<void> {
      const parsed = PersonalRemoteSessionSchema.parse({
        ...session,
        viewLoginId: session.viewLoginId ?? globalThis.crypto.randomUUID(),
      });
      await options.beforeChange?.(parsed.deploymentId);
      await mutations.run(() =>
        records.write(recordName(parsed.deploymentId), JSON.stringify(parsed)),
      );
      options.changed?.(parsed);
    },
  };
}

/**
 * The session a header-delivered exchange established. Total over the response
 * union: a cookie-delivered answer to a phone's request is a Host that ignored
 * the delivery it was asked for, and there is nothing for this app to keep.
 */
export function personalSessionFrom(
  deploymentId: DeploymentId,
  response: SessionExchangeResponse,
): PersonalRemoteSession {
  if (response.credentialDelivery !== "header") {
    throw new Error("This deployment returned a session this app cannot hold.");
  }
  return PersonalRemoteSessionSchema.parse({
    viewLoginId: globalThis.crypto.randomUUID(),
    absoluteExpiresAt: response.credential.absoluteExpiresAt,
    deploymentId,
    expiresAt: response.credential.expiresAt,
    token: response.credential.token,
  });
}
