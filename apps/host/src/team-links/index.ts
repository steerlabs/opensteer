import type { AesGcmCredentialVault } from "@opensteer/access/host";
import type { DeploymentId, RunId, ThreadId, UserId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import type { Kysely } from "kysely";
import type { TaskAdmissionPort } from "../threads/task-admission.js";
import { PersonalTeamLinks } from "./service.js";
import { PersonalTeamRequests, type PersonalTeamRunPort } from "./requests.js";
import { PersonalTeamVault } from "./vault.js";
import { TeamLinkNetwork } from "./network.js";
import { TeamRunFileTransfers, type PersonalTeamAttachmentPort } from "./files.js";
import { TeamRunTools } from "./tools.js";
import { PersonalTeamToolAdapter } from "./team-tool-adapter.js";
import { PersonalTeamKnowledge } from "./knowledge.js";

export function createPersonalTeamLinkServices(options: {
  readonly database: Kysely<DatabaseSchema>;
  readonly ownerId: UserId;
  readonly deploymentId: DeploymentId;
  readonly installationLabel: string;
  readonly credentialVault: AesGcmCredentialVault;
  readonly admission: TaskAdmissionPort;
  readonly runs: PersonalTeamRunPort;
  readonly attachments: PersonalTeamAttachmentPort;
  readonly onPublished: (taskId: ThreadId) => Promise<void>;
}) {
  const linksStore = new PersonalTeamLinksStore(options.database);
  const requestsStore = new PersonalTeamRequestsStore(options.database, options.onPublished);
  const vault = new PersonalTeamVault(options.credentialVault, options.database, options.ownerId);
  const network = new TeamLinkNetwork();
  const requests = new PersonalTeamRequests({
    links: linksStore,
    requests: requestsStore,
    admission: options.admission,
    runs: options.runs,
    rpc: (teamId) => links.rpc(teamId),
  });
  const links = new PersonalTeamLinks({
    deploymentId: options.deploymentId,
    installationLabel: options.installationLabel,
    links: linksStore,
    vault,
    network,
    requests,
  });
  const files = new TeamRunFileTransfers({
    links: linksStore,
    requests: requestsStore,
    vault,
    network,
    attachments: options.attachments,
  });
  const tools = new TeamRunTools(requestsStore, requests, (teamId) => links.rpc(teamId), files);
  const teamTools = new PersonalTeamToolAdapter(tools, files);
  const knowledge = new PersonalTeamKnowledge(
    () => links.list(),
    (teamId) => links.rpc(teamId),
  );
  const teamContext = async (runId: RunId) => {
    const context = await tools.context(runId);
    const owner = await options.database
      .selectFrom("users")
      .select("displayName")
      .where("id", "=", options.ownerId)
      .where("disabledAt", "is", null)
      .executeTakeFirstOrThrow();
    return { ...context, ownerDisplayName: owner.displayName };
  };
  return { links, requests, files, tools, teamTools, knowledge, teamContext };
}

export type { PersonalTeamRunPort } from "./requests.js";
export type { PersonalTeamAttachmentPort } from "./files.js";
