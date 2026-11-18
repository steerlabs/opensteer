import {
  administrationCommand,
  replayAdministrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { lockDeploymentEvents, withPersonalTransaction } from "./personal-transaction.js";
import { PluginSettingsStore } from "./plugin-settings-store.js";
import { PluginStore } from "./plugin-store.js";
import { ComputerOperationStore } from "./computer-operation-store.js";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import {
  IntegrationConnectionAuthStore,
  IntegrationGrantStore,
  IntegrationInstallStore,
} from "./integration-platform-stores.js";
import { LocalMcpServerStore } from "./local-mcp-server-store.js";
import { RequestStore } from "./request-store.js";
import { IntegrationRequestStore } from "./integration-request-store.js";

export * from "./integration-platform-stores.js";
export * from "./local-mcp-server-store.js";
export * from "./computer-connection-store.js";
export {
  ComputerAppNotOfferedError,
  approveComputerAppAutomaticallyInTransaction,
  type AutomaticComputerAppApprovalInput,
  type SetComputerConnectionInput,
  type SetComputerConnectionResult,
} from "./computer-connection-writes.js";
import { ComputerConnectionStore } from "./computer-connection-store.js";

/** Stable facade over aggregate-specific integration persistence stores. */
export class IntegrationPlatformStore {
  readonly getDeviceSelfRunnerId: IntegrationConnectionAuthStore["getDeviceSelfRunnerId"];
  readonly requireSelfDeviceId: IntegrationConnectionAuthStore["requireSelfDeviceId"];
  readonly requireDeviceSelfRunnerId: IntegrationConnectionAuthStore["requireDeviceSelfRunnerId"];
  readonly getDeviceComputerUsePolicy: ComputerConnectionStore["getDeviceComputerUsePolicy"];
  readonly setDeviceComputerUsePolicy: ComputerConnectionStore["setDeviceComputerUsePolicy"];
  readonly listDeviceComputerAppSetupRequests: ComputerConnectionStore["listDeviceComputerAppSetupRequests"];
  readonly getDeviceComputerAppSetupRequest: ComputerConnectionStore["getDeviceComputerAppSetupRequest"];
  readonly requestDeviceComputerAppSetup: ComputerConnectionStore["requestDeviceComputerAppSetup"];
  readonly cancelDeviceComputerAppSetup: ComputerConnectionStore["cancelDeviceComputerAppSetup"];
  readonly expireDeviceComputerAppSetupRequests: ComputerConnectionStore["expireDeviceComputerAppSetupRequests"];
  readonly setDeviceComputerConnection: ComputerConnectionStore["setDeviceComputerConnection"];
  readonly approveDeviceComputerAppAutomatically: ComputerConnectionStore["approveDeviceComputerAppAutomatically"];
  readonly getDeviceComputerConnectionForCall: ComputerConnectionStore["getDeviceComputerConnectionForCall"];
  readonly computerOperations: ComputerOperationStore;
  readonly connections: IntegrationConnectionAuthStore;
  readonly computerConnections: ComputerConnectionStore;
  readonly grants: IntegrationGrantStore;
  readonly installations: IntegrationInstallStore;
  /** The MCP servers computers run, and the approvals they wait on. */
  readonly localMcp: LocalMcpServerStore;
  readonly requests: RequestStore;
  /** Access Requests for device data apps and local servers, which `requests` creates and settles. */
  readonly integrationRequests: IntegrationRequestStore;
  readonly install: IntegrationInstallStore["install"];
  readonly uninstall: IntegrationInstallStore["uninstall"];
  readonly listInstallations: IntegrationInstallStore["listInstallations"];
  readonly listComputerDeviceIdsForInstallation: IntegrationInstallStore["listComputerDeviceIdsForInstallation"];
  readonly listComputerRunnerIdsForInstallation: IntegrationInstallStore["listComputerRunnerIdsForInstallation"];
  readonly listDiscoveryInventory: IntegrationInstallStore["listDiscoveryInventory"];
  readonly listServers: IntegrationInstallStore["listServers"];
  readonly listTools: IntegrationInstallStore["listTools"];
  readonly getConnectionAccount: IntegrationConnectionAuthStore["getConnectionAccount"];
  readonly getConnectionKind: IntegrationConnectionAuthStore["getConnectionKind"];
  readonly listComputerAppSetupRequests: ComputerConnectionStore["listComputerAppSetupRequests"];
  readonly getComputerAppSetupRequest: ComputerConnectionStore["getComputerAppSetupRequest"];
  readonly isPersonalOwner: ComputerConnectionStore["isPersonalOwner"];
  readonly requestComputerAppSetup: ComputerConnectionStore["requestComputerAppSetup"];
  readonly cancelComputerAppSetup: ComputerConnectionStore["cancelComputerAppSetup"];
  readonly expireComputerAppSetupRequests: ComputerConnectionStore["expireComputerAppSetupRequests"];
  /** A task's ask for one app on one Mac: the Request and its approval, together. */
  readonly requestDeviceComputerAppAccess: RequestStore["requestDeviceComputerAppAccess"];
  readonly requestComputerAppAccess: RequestStore["requestComputerAppAccess"];
  readonly declineComputerAppAccessRequest: RequestStore["declineComputerAppAccessRequest"];
  readonly computerAppRunner: ComputerConnectionStore["computerAppRunner"];
  readonly getComputerUsePolicy: ComputerConnectionStore["getComputerUsePolicy"];
  readonly setComputerUsePolicy: ComputerConnectionStore["setComputerUsePolicy"];
  readonly approveComputerAppAutomatically: ComputerConnectionStore["approveComputerAppAutomatically"];
  readonly blockComputerApp: ComputerConnectionStore["blockComputerApp"];
  readonly setComputerConnection: ComputerConnectionStore["setComputerConnection"];
  readonly revokeComputerConnection: ComputerConnectionStore["revokeComputerConnection"];
  readonly getComputerConnectionForCall: ComputerConnectionStore["getComputerConnectionForCall"];
  readonly createGrant: IntegrationGrantStore["createGrant"];
  readonly listGrants: IntegrationGrantStore["listGrants"];
  readonly connectionDiscoveryScope: IntegrationGrantStore["connectionDiscoveryScope"];
  readonly revokeGrant: IntegrationGrantStore["revokeGrant"];
  readonly getToolSchemas: IntegrationGrantStore["getToolSchemas"];
  readonly listCallableTools: IntegrationGrantStore["listCallableTools"];
  readonly settings: PluginSettingsStore;
  readonly plugins: PluginStore;

  readonly #database: Kysely<DatabaseSchema>;

  replayAdministration(identity: AdministrationCommandIdentity) {
    return replayAdministrationCommand(this.#database, identity);
  }

  /** Serializes a local tool's dispatch with changes to its committed authority. */
  withToolDispatch<T>(
    dispatch: (
      transaction: Transaction<DatabaseSchema>,
      grants: IntegrationGrantStore,
    ) => Promise<T>,
  ): Promise<T> {
    // Dispatch may have happened even if the transaction fails to finish.
    return this.#database.transaction().execute(async (transaction) => {
      await lockDeploymentEvents(transaction);
      return dispatch(transaction, new IntegrationGrantStore(transaction));
    });
  }

  administer<Result>(
    identity: AdministrationCommandIdentity | undefined,
    mutate: (store: IntegrationPlatformStore) => Promise<Result>,
  ) {
    return withPersonalTransaction(this.#database, async (transaction) => {
      let applied = false;
      const result = await administrationCommand(transaction, identity, async () => {
        const value = await mutate(new IntegrationPlatformStore(transaction));
        applied = true;
        return value;
      });
      return { result, applied };
    });
  }

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
    this.settings = new PluginSettingsStore(database);
    this.plugins = new PluginStore(database);
    this.computerOperations = new ComputerOperationStore(database);
    this.connections = new IntegrationConnectionAuthStore(database);
    this.computerConnections = new ComputerConnectionStore(database);
    this.getDeviceSelfRunnerId = this.connections.getDeviceSelfRunnerId.bind(this.connections);
    this.requireSelfDeviceId = this.connections.requireSelfDeviceId.bind(this.connections);
    this.requireDeviceSelfRunnerId = this.connections.requireDeviceSelfRunnerId.bind(
      this.connections,
    );
    this.getDeviceComputerUsePolicy = this.computerConnections.getDeviceComputerUsePolicy.bind(
      this.computerConnections,
    );
    this.setDeviceComputerUsePolicy = this.computerConnections.setDeviceComputerUsePolicy.bind(
      this.computerConnections,
    );
    this.listDeviceComputerAppSetupRequests =
      this.computerConnections.listDeviceComputerAppSetupRequests.bind(this.computerConnections);
    this.getDeviceComputerAppSetupRequest =
      this.computerConnections.getDeviceComputerAppSetupRequest.bind(this.computerConnections);
    this.requestDeviceComputerAppSetup =
      this.computerConnections.requestDeviceComputerAppSetup.bind(this.computerConnections);
    this.cancelDeviceComputerAppSetup = this.computerConnections.cancelDeviceComputerAppSetup.bind(
      this.computerConnections,
    );
    this.expireDeviceComputerAppSetupRequests =
      this.computerConnections.expireDeviceComputerAppSetupRequests.bind(this.computerConnections);
    this.setDeviceComputerConnection = this.computerConnections.setDeviceComputerConnection.bind(
      this.computerConnections,
    );
    this.approveDeviceComputerAppAutomatically =
      this.computerConnections.approveDeviceComputerAppAutomatically.bind(this.computerConnections);
    this.getDeviceComputerConnectionForCall =
      this.computerConnections.getDeviceComputerConnectionForCall.bind(this.computerConnections);

    this.grants = new IntegrationGrantStore(database);
    this.installations = new IntegrationInstallStore(database);
    this.localMcp = new LocalMcpServerStore(database);
    this.requests = new RequestStore(database);
    this.integrationRequests = new IntegrationRequestStore(database, this.requests);
    this.requestDeviceComputerAppAccess = this.requests.requestDeviceComputerAppAccess.bind(
      this.requests,
    );
    this.install = this.installations.install.bind(this.installations);
    this.uninstall = this.installations.uninstall.bind(this.installations);
    this.listInstallations = this.installations.listInstallations.bind(this.installations);
    this.listComputerDeviceIdsForInstallation =
      this.installations.listComputerDeviceIdsForInstallation.bind(this.installations);
    this.listComputerRunnerIdsForInstallation =
      this.installations.listComputerRunnerIdsForInstallation.bind(this.installations);
    this.listDiscoveryInventory = this.installations.listDiscoveryInventory.bind(
      this.installations,
    );
    this.listServers = this.installations.listServers.bind(this.installations);
    this.listTools = this.installations.listTools.bind(this.installations);
    this.getConnectionAccount = this.connections.getConnectionAccount.bind(this.connections);
    this.getConnectionKind = this.connections.getConnectionKind.bind(this.connections);
    this.listComputerAppSetupRequests = this.computerConnections.listComputerAppSetupRequests.bind(
      this.computerConnections,
    );
    this.getComputerAppSetupRequest = this.computerConnections.getComputerAppSetupRequest.bind(
      this.computerConnections,
    );
    this.isPersonalOwner = this.computerConnections.isPersonalOwner.bind(this.computerConnections);
    this.requestComputerAppSetup = this.computerConnections.requestComputerAppSetup.bind(
      this.computerConnections,
    );
    this.cancelComputerAppSetup = this.computerConnections.cancelComputerAppSetup.bind(
      this.computerConnections,
    );
    this.expireComputerAppSetupRequests =
      this.computerConnections.expireComputerAppSetupRequests.bind(this.computerConnections);
    this.requestComputerAppAccess = this.requests.requestComputerAppAccess.bind(this.requests);
    this.declineComputerAppAccessRequest = this.requests.declineComputerAppAccessRequest.bind(
      this.requests,
    );
    this.computerAppRunner = this.computerConnections.computerAppRunner.bind(
      this.computerConnections,
    );
    this.getComputerUsePolicy = this.computerConnections.getComputerUsePolicy.bind(
      this.computerConnections,
    );
    this.setComputerUsePolicy = this.computerConnections.setComputerUsePolicy.bind(
      this.computerConnections,
    );
    this.approveComputerAppAutomatically =
      this.computerConnections.approveComputerAppAutomatically.bind(this.computerConnections);
    this.blockComputerApp = this.computerConnections.blockComputerApp.bind(
      this.computerConnections,
    );
    this.setComputerConnection = this.computerConnections.setComputerConnection.bind(
      this.computerConnections,
    );
    this.revokeComputerConnection = this.computerConnections.revokeComputerConnection.bind(
      this.computerConnections,
    );
    this.getComputerConnectionForCall = this.computerConnections.getComputerConnectionForCall.bind(
      this.computerConnections,
    );
    this.createGrant = this.grants.createGrant.bind(this.grants);
    this.listGrants = this.grants.listGrants.bind(this.grants);
    this.connectionDiscoveryScope = this.grants.connectionDiscoveryScope.bind(this.grants);
    this.revokeGrant = this.grants.revokeGrant.bind(this.grants);
    this.getToolSchemas = this.grants.getToolSchemas.bind(this.grants);
    this.listCallableTools = this.grants.listCallableTools.bind(this.grants);
  }
}
