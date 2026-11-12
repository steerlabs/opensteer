import type {
  IssueTeamIdentityGrantRequest,
  IssueTeamIdentityGrantResponse,
} from "@opensteer/control-plane-protocol";
import type {
  CreateHostedTeamRequest,
  HostedTeamAvailability,
  HostedTeamId,
  HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import type { DeploymentId } from "@opensteer/core";

/**
 * Account's team calls, made with the person's Account session and parsed with the
 * control-plane-protocol schemas. A refusal throws carrying its `ControlPlaneErrorReason`.
 */
export interface AccountTeamsClient {
  hostedTeamAvailability(slug: string, signal?: AbortSignal): Promise<HostedTeamAvailability>;
  createHostedTeam(request: CreateHostedTeamRequest): Promise<HostedTeamView>;
  listHostedTeams(signal?: AbortSignal): Promise<readonly HostedTeamView[]>;
  /** Null once the team is gone. */
  hostedTeam(id: HostedTeamId, signal?: AbortSignal): Promise<HostedTeamView | null>;
  retryHostedTeam(id: HostedTeamId): Promise<HostedTeamView>;
  /** Cancels a team still being set up, or deletes one (owners only). Null when already gone. */
  deleteHostedTeam(id: HostedTeamId): Promise<HostedTeamView | null>;
  issueTeamIdentityGrant(
    deploymentId: DeploymentId,
    request: IssueTeamIdentityGrantRequest,
  ): Promise<IssueTeamIdentityGrantResponse>;
}
