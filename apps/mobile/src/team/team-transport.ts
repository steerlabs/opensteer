import { HostSession, type NativeOAuthManager } from "@opensteer/client/auth";
import type {
  DeploymentCatalogStore,
  DeploymentConnection,
  HostCredentialProvider,
  HostNetwork,
} from "@opensteer/client/connections";
import {
  MockTeamHost,
  seedBusyTeam,
  busyTeamIds,
  pinnedTeamTransport,
  type TeamCacheScope,
} from "@opensteer/client/team";
import { DeploymentIdSchema, UserIdSchema } from "@opensteer/core";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import { TeamFileSchema, teamPreviewMaxBytes, teamUploadMaxBytes } from "@opensteer/protocol";
import type { TeamTransport } from "./mobile-teams.js";

/**
 * A team Host, pinned to its own origin and credential beside whichever
 * personal Opensteer is selected. Calls carry only the team's API version.
 */
export function networkTeamTransport(options: {
  readonly catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
  readonly credentials: HostCredentialProvider;
  readonly network: HostNetwork;
  readonly oauth: NativeOAuthManager;
}): (connection: DeploymentConnection, scope: TeamCacheScope) => TeamTransport {
  let owner = options.oauth.teamRuntime();
  let transports = owner.cache<string, ReturnType<typeof pinnedTeamTransport>>();
  const observeSignOut = () =>
    owner.own(
      options.oauth.subscribeHostCredentials((state) => {
        if (!options.oauth.isTeamSignInSuppressed(state.connection)) return;
        const id = state.connection.authority.document.deploymentId;
        transports.get(id)?.transport.invalidateSession();
        transports.delete(id);
      }),
    );
  observeSignOut();
  return (connection, scope) => {
    if (owner !== options.oauth.teamRuntime()) {
      owner = options.oauth.teamRuntime();
      transports = owner.cache();
      observeSignOut();
    }
    owner.assertCurrent();
    const deploymentId = DeploymentIdSchema.parse(connection.authority.document.deploymentId);
    let pinned = transports.get(deploymentId);
    if (!pinned) {
      pinned = pinnedTeamTransport(
        {
          catalog: options.catalog,
          credentials: options.credentials,
          deploymentId,
          localRuntime: { current: async () => null },
          network: options.network,
          sessions: (attachment) =>
            new HostSession({
              attachment,
              clearDeploymentSession: async () => undefined,
              exchange: {
                supports: () => false,
                probe: async () => "unauthenticated",
                establish: async () => {
                  throw new Error("Teams use native credentials.");
                },
              },
              localOwner: { ownsHostSession: () => false, recoverOwnerSession: async () => false },
              oauth: options.oauth,
            }),
        },
        new URL(connection.authority.document.canonicalOrigin),
      );
      transports.set(deploymentId, pinned);
      const transport = pinned.transport;
      owner.own(() => transport.invalidateSession());
    }
    const held = pinned;
    return {
      rpc: pinned.rpc,
      connect: pinned.connect,
      uploadFile: pinned.files(scope).uploadFile,
      // React Native's Blob holds native bytes only, so a file is read back as
      // the platform's own Blob rather than rebuilt from a JavaScript buffer.
      readFile: (file, part, signal) => {
        const metadata = TeamFileSchema.parse(file);
        const preview = part === "preview";
        if (preview && metadata.preview === null) throw new Error("This file has no preview.");
        const expected = preview ? metadata.preview!.sizeBytes : metadata.sizeBytes;
        return held.transport.exchange(
          {
            expectedDeploymentId: deploymentId,
            path: `/v1/team/files/${metadata.id}/${part}`,
            method: "GET",
            headers: { additional: { [teamApiVersionHeader]: String(teamApiVersion) } },
            ...(signal === undefined ? {} : { signal }),
          },
          async (response) => {
            if (!response.ok) throw new Error("The team file is no longer available.");
            const declared = Number(response.headers.get("content-length") ?? expected);
            if (declared > (preview ? teamPreviewMaxBytes : teamUploadMaxBytes))
              throw new Error("Team file exceeds its byte bound.");
            const mediaType = response.headers.get("content-type")?.split(";", 1)[0];
            if (mediaType !== (preview ? metadata.preview!.mediaType : "application/octet-stream"))
              throw new Error("Unexpected team file type.");
            const blob = await response.blob();
            if (blob.size !== expected) throw new Error("Team file size changed.");
            return blob;
          },
        );
      },
    };
  };
}

/** Mock mode's teams: one in-memory team Host per team, kept across sessions. */
export function mockTeamTransport(
  hosts: Map<string, MockTeamHost>,
): (connection: DeploymentConnection, scope: TeamCacheScope) => TeamTransport {
  return (connection) => {
    const teamId = DeploymentIdSchema.parse(connection.authority.document.deploymentId);
    let host = hosts.get(teamId);
    if (host === undefined) {
      host = new MockTeamHost({
        teamId,
        userId: mockTeamReaderId,
        origin: connection.authority.document.canonicalOrigin,
      });
      seedBusyTeam(host, {
        name: teamId === busyTeamIds[1] ? "Family" : "Acme",
        index: teamId === busyTeamIds[1] ? 2 : 1,
      });
      hosts.set(teamId, host);
    }
    return {
      rpc: host.rpc,
      connect: host.connect,
      readFile: host.readFile,
      uploadFile: host.uploadFile,
    };
  };
}

export const mockTeamReaderId = UserIdSchema.parse("usr_00000000-0000-4000-8000-0000000000aa");
