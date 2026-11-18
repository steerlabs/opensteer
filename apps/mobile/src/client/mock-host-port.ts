import type { DeploymentConnection } from "@opensteer/client/connections";
import type { HostClient } from "@opensteer/client/host";
import {
  MockDesktopUpdates,
  MockHostClient,
  type MockPluginScenario,
  type MockSubagentScene,
} from "@opensteer/client/mock";
import type { MobileHostPort, MobileHostPortFactory } from "./host-port.js";
import { mockSignedOutDeploymentId } from "./mock-mode.js";

/**
 * Development entry: the Host is in memory, so there is nothing to present, to
 * dial, or to negotiate a version with. Everything a real Host is asked, this
 * answers locally.
 */
export function createMockHostPort(
  options: {
    /**
     * One in-memory Host per Deployment, kept across attachments, so what a
     * session did there — such as adding this iPhone — is still there after
     * switching away and back. Absent, every attachment starts afresh.
     */
    readonly hosts?: Map<string, MockHostClient>;
    /** One subagent scene of the design, so each of its states can be looked at. */
    readonly subagents?: MockSubagentScene | null;
    /** The plugin side's state, as the web's `?mock-plugins=` picks it. */
    readonly plugins?: MockPluginScenario | null;
    /** Each command a kept Host accepted, as a real Host would push its effects. */
    readonly onCommand?: (command: Parameters<HostClient["dispatch"]>[0]) => void;
  } = {},
): MobileHostPortFactory {
  const loginIds = new Map<string, string>();
  const signedIn = (connection: DeploymentConnection): boolean =>
    connection.authority.document.deploymentId !== mockSignedOutDeploymentId;
  const attach: MobileHostPort["attach"] = ({ connection, connectionController, clientScope }) => {
    const hostOptions = {
      ...(connectionController ? { connectionController } : {}),
      ...(clientScope ? { clientScope } : {}),
      ...(options.subagents ? { subagents: options.subagents } : {}),
      ...(options.plugins ? { plugins: options.plugins } : {}),
    };
    const hosts = options.hosts;
    if (hosts === undefined) return new MockHostClient(hostOptions);
    const deploymentId = connection.authority.document.deploymentId;
    let host = hosts.get(deploymentId);
    if (host === undefined) {
      const created = new MockHostClient({
        devices: "seeded",
        ...hostOptions,
      });
      const dispatch = created.dispatch.bind(created);
      created.dispatch = async (command) => {
        const result = await dispatch(command);
        options.onCommand?.(command);
        return result;
      };
      hosts.set(deploymentId, created);
      host = created;
    } else if (connectionController) host.adoptConnection(connectionController, clientScope);
    // A kept Host outlives the attachment: releasing it must not stop it.
    return new Proxy(host, {
      get(target, property) {
        if (property === "dispose") return () => undefined;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return () => ({
    credentials: {
      // One seeded row is deliberately without a credential, so the row that
      // needs one — and the action that leads out of it — is on screen in mock
      // mode rather than only reachable with a real Host.
      viewLoginId: async (connection) => {
        if (!signedIn(connection)) return undefined;
        const id = connection.authority.document.deploymentId;
        let loginId = loginIds.get(id);
        if (!loginId) {
          loginId = globalThis.crypto.randomUUID();
          loginIds.set(id, loginId);
        }
        return loginId;
      },
      authorization: async (connection) => (signedIn(connection) ? "Bearer mock" : null),
      held: async (connection) => signedIn(connection),
    },
    attach,
    desktopUpdates: ({ deploymentId }) =>
      options.hosts?.get(deploymentId)?.desktopUpdates ?? new MockDesktopUpdates(),
    verifyEpoch: async () => ({ status: "compatible", capabilities: [] }),
  });
}
