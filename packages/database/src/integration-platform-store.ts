import { ComputerOperationStore } from "./computer-operation-store.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import {
  IntegrationConnectionAuthStore,
  IntegrationGrantStore,
  IntegrationInstallStore,
} from "./integration-platform-stores.js";
import { LocalMcpServerStore } from "./local-mcp-server-store.js";
import { RequestStore } from "./request-store.js";

export * from "./integration-platform-stores.js";
export * from "./local-mcp-server-store.js";

/** Stable facade over aggregate-specific integration persistence stores. */
export class IntegrationPlatformStore {
  readonly computerOperations: ComputerOperationStore;
  readonly connections: IntegrationConnectionAuthStore;
  readonly grants: IntegrationGrantStore;
  readonly installations: IntegrationInstallStore;
  /** The MCP servers computers run, and the approvals they wait on. */
  readonly localMcp: LocalMcpServerStore;
  readonly requests: RequestStore;
  readonly install: IntegrationInstallStore["install"];
  readonly uninstall: IntegrationInstallStore["uninstall"];
  readonly listInstallations: IntegrationInstallStore["listInstallations"];
  readonly listComputerRunnerIdsForInstallation: IntegrationInstallStore["listComputerRunnerIdsForInstallation"];
  readonly listDiscoveryInventory: IntegrationInstallStore["listDiscoveryInventory"];
  readonly listServers: IntegrationInstallStore["listServers"];
  readonly listSkills: IntegrationInstallStore["listSkills"];
  readonly listTools: IntegrationInstallStore["listTools"];
  readonly reconcileProviderConnectionTools: IntegrationInstallStore["reconcileProviderConnectionTools"];
  readonly getConnectionKind: IntegrationConnectionAuthStore["getConnectionKind"];
  readonly listComputerAppSetupRequests: IntegrationConnectionAuthStore["listComputerAppSetupRequests"];
  readonly listComputerAppApprovalsForRunner: IntegrationConnectionAuthStore["listComputerAppApprovalsForRunner"];
  readonly getComputerAppSetupRequest: IntegrationConnectionAuthStore["getComputerAppSetupRequest"];
  readonly registerComputerUseApprovalKey: IntegrationConnectionAuthStore["registerComputerUseApprovalKey"];
  readonly isAdministrator: IntegrationConnectionAuthStore["isAdministrator"];
  readonly requestComputerAppSetup: IntegrationConnectionAuthStore["requestComputerAppSetup"];
  readonly cancelComputerAppSetup: IntegrationConnectionAuthStore["cancelComputerAppSetup"];
  readonly declineComputerAppSetupFromMac: IntegrationConnectionAuthStore["declineComputerAppSetupFromMac"];
  readonly expireComputerAppSetupRequests: IntegrationConnectionAuthStore["expireComputerAppSetupRequests"];
  /** A task's ask for one app on one Mac: the Request and its approval, together. */
  readonly requestComputerAppAccess: RequestStore["requestComputerAppAccess"];
  readonly declineComputerAppAccessRequest: RequestStore["declineComputerAppAccessRequest"];
  readonly computerAppRunner: IntegrationConnectionAuthStore["computerAppRunner"];
  readonly getComputerUsePolicy: IntegrationConnectionAuthStore["getComputerUsePolicy"];
  readonly setComputerUsePolicy: IntegrationConnectionAuthStore["setComputerUsePolicy"];
  readonly approveComputerAppAutomatically: IntegrationConnectionAuthStore["approveComputerAppAutomatically"];
  readonly blockComputerApp: IntegrationConnectionAuthStore["blockComputerApp"];
  readonly setComputerConnection: IntegrationConnectionAuthStore["setComputerConnection"];
  readonly revokeComputerConnection: IntegrationConnectionAuthStore["revokeComputerConnection"];
  readonly getComputerConnectionForCall: IntegrationConnectionAuthStore["getComputerConnectionForCall"];
  readonly getMcpOAuthServer: IntegrationConnectionAuthStore["getMcpOAuthServer"];
  readonly completeMcpOAuthAttempt: IntegrationConnectionAuthStore["completeMcpOAuthAttempt"];
  readonly getMcpOAuthConnection: IntegrationConnectionAuthStore["getMcpOAuthConnection"];
  readonly replaceMcpOAuthCredential: IntegrationConnectionAuthStore["replaceMcpOAuthCredential"];
  readonly listMcpOAuthConnections: IntegrationConnectionAuthStore["listMcpOAuthConnections"];
  readonly revokeMcpOAuthConnection: IntegrationConnectionAuthStore["revokeMcpOAuthConnection"];
  readonly markMcpOAuthConnectionNeedsAttention: IntegrationConnectionAuthStore["markMcpOAuthConnectionNeedsAttention"];
  readonly createGrant: IntegrationGrantStore["createGrant"];
  readonly listGrants: IntegrationGrantStore["listGrants"];
  readonly mainAccess: IntegrationGrantStore["mainAccess"];
  readonly isConnectionUsableForAccessRequest: IntegrationGrantStore["isConnectionUsableForAccessRequest"];
  readonly revokeGrant: IntegrationGrantStore["revokeGrant"];
  readonly getToolInvocation: IntegrationGrantStore["getToolInvocation"];
  readonly getToolSchemas: IntegrationGrantStore["getToolSchemas"];
  readonly listCallableTools: IntegrationGrantStore["listCallableTools"];
  readonly listGrantedSkills: IntegrationGrantStore["listGrantedSkills"];

  constructor(database: Kysely<DatabaseSchema>) {
    this.computerOperations = new ComputerOperationStore(database);
    this.connections = new IntegrationConnectionAuthStore(database);
    this.grants = new IntegrationGrantStore(database);
    this.installations = new IntegrationInstallStore(database);
    this.localMcp = new LocalMcpServerStore(database);
    this.requests = new RequestStore(database);
    this.install = this.installations.install.bind(this.installations);
    this.uninstall = this.installations.uninstall.bind(this.installations);
    this.listInstallations = this.installations.listInstallations.bind(this.installations);
    this.listComputerRunnerIdsForInstallation =
      this.installations.listComputerRunnerIdsForInstallation.bind(this.installations);
    this.listDiscoveryInventory = this.installations.listDiscoveryInventory.bind(
      this.installations,
    );
    this.listServers = this.installations.listServers.bind(this.installations);
    this.listSkills = this.installations.listSkills.bind(this.installations);
    this.listTools = this.installations.listTools.bind(this.installations);
    this.reconcileProviderConnectionTools =
      this.installations.reconcileProviderConnectionTools.bind(this.installations);
    this.getConnectionKind = this.connections.getConnectionKind.bind(this.connections);
    this.listComputerAppSetupRequests = this.connections.listComputerAppSetupRequests.bind(
      this.connections,
    );
    this.listComputerAppApprovalsForRunner =
      this.connections.listComputerAppApprovalsForRunner.bind(this.connections);
    this.getComputerAppSetupRequest = this.connections.getComputerAppSetupRequest.bind(
      this.connections,
    );
    this.registerComputerUseApprovalKey = this.connections.registerComputerUseApprovalKey.bind(
      this.connections,
    );
    this.isAdministrator = this.connections.isAdministrator.bind(this.connections);
    this.requestComputerAppSetup = this.connections.requestComputerAppSetup.bind(this.connections);
    this.cancelComputerAppSetup = this.connections.cancelComputerAppSetup.bind(this.connections);
    this.declineComputerAppSetupFromMac = this.connections.declineComputerAppSetupFromMac.bind(
      this.connections,
    );
    this.expireComputerAppSetupRequests = this.connections.expireComputerAppSetupRequests.bind(
      this.connections,
    );
    this.requestComputerAppAccess = this.requests.requestComputerAppAccess.bind(this.requests);
    this.declineComputerAppAccessRequest = this.requests.declineComputerAppAccessRequest.bind(
      this.requests,
    );
    this.computerAppRunner = this.connections.computerAppRunner.bind(this.connections);
    this.getComputerUsePolicy = this.connections.getComputerUsePolicy.bind(this.connections);
    this.setComputerUsePolicy = this.connections.setComputerUsePolicy.bind(this.connections);
    this.approveComputerAppAutomatically = this.connections.approveComputerAppAutomatically.bind(
      this.connections,
    );
    this.blockComputerApp = this.connections.blockComputerApp.bind(this.connections);
    this.setComputerConnection = this.connections.setComputerConnection.bind(this.connections);
    this.revokeComputerConnection = this.connections.revokeComputerConnection.bind(
      this.connections,
    );
    this.getComputerConnectionForCall = this.connections.getComputerConnectionForCall.bind(
      this.connections,
    );
    this.getMcpOAuthServer = this.connections.getMcpOAuthServer.bind(this.connections);
    this.completeMcpOAuthAttempt = this.connections.completeMcpOAuthAttempt.bind(this.connections);
    this.getMcpOAuthConnection = this.connections.getMcpOAuthConnection.bind(this.connections);
    this.replaceMcpOAuthCredential = this.connections.replaceMcpOAuthCredential.bind(
      this.connections,
    );
    this.listMcpOAuthConnections = this.connections.listMcpOAuthConnections.bind(this.connections);
    this.revokeMcpOAuthConnection = this.connections.revokeMcpOAuthConnection.bind(
      this.connections,
    );
    this.markMcpOAuthConnectionNeedsAttention =
      this.connections.markMcpOAuthConnectionNeedsAttention.bind(this.connections);
    this.createGrant = this.grants.createGrant.bind(this.grants);
    this.listGrants = this.grants.listGrants.bind(this.grants);
    this.mainAccess = this.grants.mainAccess.bind(this.grants);
    this.isConnectionUsableForAccessRequest = this.grants.isConnectionUsableForAccessRequest.bind(
      this.grants,
    );
    this.revokeGrant = this.grants.revokeGrant.bind(this.grants);
    this.getToolInvocation = this.grants.getToolInvocation.bind(this.grants);
    this.getToolSchemas = this.grants.getToolSchemas.bind(this.grants);
    this.listCallableTools = this.grants.listCallableTools.bind(this.grants);
    this.listGrantedSkills = this.grants.listGrantedSkills.bind(this.grants);
  }
}
