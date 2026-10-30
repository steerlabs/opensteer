import type { DeploymentConnection } from "@opensteer/client/connections";
import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type { HostApiCommandInput } from "@opensteer/protocol";
import type { MobileHostPortFactory } from "./host-port.js";
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
    readonly initialHome?: "seeded" | "absent";
    /** Each command a kept Host accepted, as a real Host would push its effects. */
    readonly onCommand?: (command: HostApiCommandInput) => void;
  } = {},
): MobileHostPortFactory {
  const loginIds = new Map<string, string>();
  const signedIn = (connection: DeploymentConnection): boolean =>
    connection.authority.document.deploymentId !== mockSignedOutDeploymentId;
  const attach = (connection: DeploymentConnection): HostClient => {
    const hosts = options.hosts;
    if (hosts === undefined)
      return new MockHostClient({ initialHome: options.initialHome ?? "seeded" });
    const deploymentId = connection.authority.document.deploymentId;
    let host = hosts.get(deploymentId);
    if (host === undefined) {
      const created = new MockHostClient({ initialHome: options.initialHome ?? "seeded" });
      const dispatch = created.dispatch.bind(created);
      created.dispatch = async (command) => {
        const result = await dispatch(command);
        options.onCommand?.(command);
        return result;
      };
      hosts.set(deploymentId, created);
      host = created;
    }
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
    attach: ({ connection }) => attach(connection),
    verifyEpoch: async () => ({ status: "compatible", capabilities: [] }),
  });
}
