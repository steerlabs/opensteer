import { DeploymentIdSchema } from "@opensteer/core";
import { createHttpHostApiClient, unwrapRpcResult } from "@opensteer/client/host";
import type {
  DeploymentAccessDeployment,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { createDesktopHostFetch } from "./desktop-host-transport.js";

export interface ComputerFacts {
  /** The Mac this Opensteer lives on, as its Host names it; null where the Host doesn't say. */
  readonly homeName: string | null;
  readonly needsYou: number;
  readonly unread: boolean;
  readonly teams: readonly {
    readonly id: string;
    readonly name: string;
    readonly mentions: number | null;
  }[];
}

export async function readComputerFacts(
  bridge: OpensteerDesktopBridge,
  computer: DeploymentAccessDeployment,
): Promise<ComputerFacts> {
  const rpc = createHttpHostApiClient({
    baseUrl: new URL(computer.canonicalOrigin),
    fetch: createDesktopHostFetch(
      bridge,
      computer.canonicalOrigin,
      DeploymentIdSchema.parse(computer.id),
    ),
    kind: "personal",
    onAuthenticationRequired: () => undefined,
  });
  const [attention, linked, homeName] = await Promise.all([
    rpc["attention.get"]({}).then(unwrapRpcResult),
    rpc["teams.links.list"]({}).then(unwrapRpcResult),
    rpc["devices.overview.get"]({})
      .then(unwrapRpcResult)
      .then(({ devices }) => devices.find((device) => device.kind === "home")?.name ?? null)
      .catch(() => null),
  ]);
  const teams = await Promise.all(
    linked.links
      .filter((link) => link.state !== "revoked" && link.state !== "leaving")
      .map(async (link) => {
        const team = createHttpHostApiClient({
          baseUrl: new URL(link.origin),
          fetch: createDesktopHostFetch(bridge, link.origin, DeploymentIdSchema.parse(link.teamId)),
          kind: "team",
          onAuthenticationRequired: () => undefined,
        });
        try {
          const bootstrap = await team["team.bootstrap.get"]({}).then(unwrapRpcResult);
          return {
            id: link.teamId,
            name: link.teamName,
            mentions:
              bootstrap.member.userId === link.ownerUserId
                ? bootstrap.sidebar.totalMentionCount
                : null,
          };
        } catch {
          return { id: link.teamId, name: link.teamName, mentions: null };
        }
      }),
  );
  return { ...attention, homeName, teams };
}
