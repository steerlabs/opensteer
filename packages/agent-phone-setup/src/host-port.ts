import {
  HostClientRequestError,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import { AgentPhoneHostTargetSchema, androidPhoneDefinitionId } from "@opensteer/protocol";
import type { AgentPhoneSetupHostPort } from "./setup-agent-phone.js";

/** What setup needs of a Host client: its commands and its reads. */
type AgentPhoneSetupHostClient = Pick<HostClient, "dispatch" | "rpc">;

/** The Host's refusal for a Personal Deployment that nobody can reach from outside. */
function remoteAccessOff(error: unknown): boolean {
  return error instanceof HostClientRequestError && error.reason === "personal-remote-access-off";
}

/**
 * The person's own session, as the setup engine asks things of the Host. It
 * keeps nothing between calls: which enrollment a setup dialog is on lives in
 * that dialog's `AgentPhoneEnrollments`.
 */
export function agentPhoneSetupHost(client: AgentPhoneSetupHostClient): AgentPhoneSetupHostPort {
  return {
    mintEnrollment: async ({ idempotencyKey, name }) => {
      try {
        const result = await client.dispatch({
          idempotencyKey,
          name,
          type: "runner.enrollment.createPhone",
        });
        if (result.type !== "runner.enrollment.createPhone") {
          throw new Error("The phone's enrollment was not created.");
        }
        return {
          enrollment: {
            enrollmentId: result.enrollmentId,
            expiresAt: result.expiresAt,
            pairing: AgentPhoneHostTargetSchema.parse(result.pairing),
            token: result.token,
          },
          kind: "minted",
        };
      } catch (error) {
        if (remoteAccessOff(error)) return { kind: "remote-access-off" };
        throw error;
      }
    },
    pairingTarget: async () => {
      try {
        return {
          kind: "target",
          target: AgentPhoneHostTargetSchema.parse(
            unwrapRpcResult(await client.rpc["agentPhone.target.get"]({})),
          ),
        };
      } catch (error) {
        if (remoteAccessOff(error)) return { kind: "remote-access-off" };
        throw error;
      }
    },
    phoneConnected: async ({ runnerId }) =>
      unwrapRpcResult(await client.rpc["integrations.get"]({})).connections.some(
        (connection) =>
          connection.definitionId === androidPhoneDefinitionId &&
          connection.computer?.runnerId === runnerId &&
          connection.status !== "revoked",
      ),
    setInitialAccess: async ({ runnerId }) => {
      const result = await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`agent-phone-access:${runnerId}`),
        input: {
          access: "read-write",
          app: null,
          definitionId: androidPhoneDefinitionId,
          kind: "app",
          runnerId,
        },
        type: "integration.computer.setup.set",
      });
      if (result.type !== "integration.computer.setup.set") {
        throw new Error("Access to the phone was not set.");
      }
    },
    retireEnrollment: async ({ enrollmentId }) => {
      // Retiring is idempotent in effect, so a retried request needs no shared key.
      const result = await client.dispatch({
        enrollmentId,
        idempotencyKey: mutationIdempotencyKey(`agent-phone-retire:${enrollmentId}`),
        type: "runner.enrollment.retire",
      });
      if (result.type !== "runner.enrollment.retire") {
        throw new Error("The phone's earlier enrollment was not retired.");
      }
      return result.state;
    },
  };
}
