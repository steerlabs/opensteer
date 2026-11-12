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
}): (connection: DeploymentConnection, scope: TeamCacheScope) => TeamTransport {
  return (connection, scope) => {
    const deploymentId = DeploymentIdSchema.parse(connection.authority.document.deploymentId);
    const pinned = pinnedTeamTransport(
      {
        catalog: options.catalog,
        credentials: options.credentials,
        deploymentId,
        localRuntime: { current: async () => null },
        network: options.network,
      },
      new URL(connection.authority.document.canonicalOrigin),
    );
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
        return pinned.transport.exchange(
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
      host = new MockTeamHost({ teamId, userId: mockTeamReaderId });
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
