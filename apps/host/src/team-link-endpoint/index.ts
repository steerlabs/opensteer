import type { DatabaseSchema } from "@opensteer/database";
import type { TeamRequestStorePort } from "@opensteer/database/team-requests-port";
import type { Kysely } from "kysely";
import type { TeamAccessLockPort, TeamAccessResolver } from "../team/access-port.js";
import { TeamEndpointLinks } from "./links.js";
import { TeamLinkEndpoint } from "./endpoint.js";
import { TeamLinkBinary } from "./binary.js";
import type { TeamMachineDataPort, TeamMachineFilesPort } from "./contracts.js";
import type { TeamLinkLifetimes } from "./lifetimes.js";

export function createTeamLinkEndpoint(options: {
  readonly database: Kysely<DatabaseSchema>;
  readonly requests: TeamRequestStorePort;
  readonly access: TeamAccessLockPort;
  readonly resolver: TeamAccessResolver;
  readonly lifetimes: TeamLinkLifetimes;
  readonly data: TeamMachineDataPort;
  readonly files: TeamMachineFilesPort;
}) {
  const links = new TeamEndpointLinks(options.database, options.access);
  const endpoint = new TeamLinkEndpoint({ ...options, links });
  const binary = new TeamLinkBinary(endpoint, options.files, options.resolver);
  return { links, endpoint, binary };
}
export { TeamLinkLifetimes } from "./lifetimes.js";
export { registerTeamLinkRoutes } from "./routes.js";
export type { TeamMachineDataPort, TeamMachineFilesPort } from "./contracts.js";
